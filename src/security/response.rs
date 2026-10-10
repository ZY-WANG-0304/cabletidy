//! Read-only response projection. Index source ranges, then materialize one page.
use super::content::BodyReader;
use crate::streaming::{JsonStream, Node, Visitor};
use anyhow::{anyhow, bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    io::{self, BufRead, Read},
};

const PAGE_ITEMS: usize = 40;

struct Checked<'a, R> {
    reader: R,
    cancelled: &'a dyn Fn() -> bool,
}
impl<R: Read> Read for Checked<'_, R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if (self.cancelled)() {
            return Err(io::Error::other("overview_cancelled"));
        }
        self.reader.read(bytes)
    }
}
fn reader<'a>(
    db: &'a Connection,
    audit: &'a str,
    snapshot: &'a str,
    legacy: Option<&'a [u8]>,
    start: u64,
    end: u64,
    cancelled: &'a dyn Fn() -> bool,
) -> Box<dyn Read + 'a> {
    let body: Box<dyn Read + 'a> = if let Some(bytes) = legacy {
        Box::new(
            &bytes[start.min(bytes.len() as u64) as usize..end.min(bytes.len() as u64) as usize],
        )
    } else {
        Box::new(BodyReader {
            db,
            audit,
            snapshot,
            next: start,
            limit: end,
            chunk: Vec::new(),
            position: 0,
        })
    };
    Box::new(Checked {
        reader: body,
        cancelled,
    })
}

// Strip SSE fields without buffering an arbitrarily large data line/event.
struct Payload<R> {
    reader: io::BufReader<R>,
    line_start: bool,
    data: bool,
    join: bool,
}
impl<R: Read> Payload<R> {
    fn new(reader: R) -> Self {
        Self {
            reader: io::BufReader::new(reader),
            line_start: true,
            data: false,
            join: false,
        }
    }
    fn byte(&mut self) -> io::Result<Option<u8>> {
        loop {
            if self.line_start {
                let mut prefix = Vec::with_capacity(5);
                while prefix.len() < 5 {
                    let mut b = [0];
                    if self.reader.read(&mut b)? == 0 {
                        return Ok(None);
                    }
                    prefix.push(b[0]);
                    if b[0] == b'\n' {
                        break;
                    }
                }
                self.data = prefix == b"data:";
                self.line_start = prefix.last() == Some(&b'\n');
                if self.data {
                    if self.reader.fill_buf()?.first() == Some(&b' ') {
                        self.reader.consume(1);
                    }
                    self.line_start = false;
                    if self.join {
                        return Ok(Some(b'\n'));
                    }
                    self.join = true;
                }
                if self.line_start {
                    continue;
                }
            }
            let mut b = [0];
            if self.reader.read(&mut b)? == 0 {
                return Ok(None);
            }
            if b[0] == b'\n' {
                self.line_start = true;
                continue;
            }
            if self.data && b[0] != b'\r' {
                return Ok(Some(b[0]));
            }
        }
    }
}
impl<R: Read> Read for Payload<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let mut n = 0;
        while n < bytes.len() {
            match self.byte()? {
                Some(b) => {
                    bytes[n] = b;
                    n += 1;
                }
                None => break,
            }
        }
        Ok(n)
    }
}

#[derive(Default)]
struct Frame {
    field: String,
    path: String,
    value: String,
    meta: Value,
    nodes: Value,
}
#[derive(Default)]
struct Scan {
    frames: Vec<Frame>,
    root: Value,
    items: Vec<Value>,
}
impl Visitor for Scan {
    fn start(&mut self, path: &str, field: &str, _: u8, _: u64) -> Result<()> {
        self.frames.push(Frame {
            field: field.into(),
            path: path.into(),
            meta: json!({}),
            nodes: json!({}),
            ..Frame::default()
        });
        Ok(())
    }
    fn text(&mut self, text: &str) -> Result<()> {
        let f = self
            .frames
            .last_mut()
            .ok_or_else(|| anyhow!("invalid_overview_frame"))?;
        if matches!(
            f.field.as_str(),
            "type"
                | "name"
                | "id"
                | "call_id"
                | "tool_use_id"
                | "role"
                | "status"
                | "contentSnapshotId"
                | "fragmentUnit"
                | "stop_reason"
        ) {
            f.value.push_str(text);
        }
        Ok(())
    }
    fn scalar(&mut self, value: &str) -> Result<()> {
        let f = self
            .frames
            .last_mut()
            .ok_or_else(|| anyhow!("invalid_overview_frame"))?;
        if matches!(
            f.field.as_str(),
            "index"
                | "output_index"
                | "content_index"
                | "summary_index"
                | "observedFragmentStart"
                | "observedFragmentEnd"
        ) {
            f.value = value.into();
        }
        Ok(())
    }
    fn end(&mut self, node: &Node) -> Result<()> {
        let f = self
            .frames
            .pop()
            .ok_or_else(|| anyhow!("invalid_overview_frame"))?;
        if node.kind == b'k' {
            return Ok(());
        }
        let mut meta = f.meta;
        meta["start"] = json!(node.start);
        meta["end"] = json!(node.end);
        meta["location"] = json!(f.path);
        meta["nodes"] = f.nodes;
        let depth = self.frames.len();
        let references = if meta["fragmentUnit"] == "decoded_utf8_bytes" {
            meta["contentSnapshotId"]
                .as_str()
                .map(|id| vec![json!(id)])
                .unwrap_or_default()
        } else {
            meta["contentSnapshotIds"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        };
        let parent = self.frames.last().map(|p| p.field.as_str()).unwrap_or("");
        if (depth == 2 && matches!(parent, "output" | "content"))
            || (depth == 3 && parent == "output" && self.frames[1].field == "response")
        {
            self.items.push(meta.clone());
        }
        if let Some(parent) = self.frames.last_mut() {
            if !references.is_empty() {
                if !parent.meta["contentSnapshotIds"].is_array() {
                    parent.meta["contentSnapshotIds"] = json!([]);
                }
                let ids = parent.meta["contentSnapshotIds"].as_array_mut().unwrap();
                for id in references {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
            }
            if !f.field.is_empty() {
                if matches!(
                    f.field.as_str(),
                    "output"
                        | "content"
                        | "delta"
                        | "text"
                        | "thinking"
                        | "signature"
                        | "partial_json"
                        | "arguments"
                        | "input"
                        | "refusal"
                ) {
                    parent.nodes[&f.field] =
                        json!({"start":node.start,"end":node.end,"kind":node.kind});
                }
                if !f.value.is_empty() {
                    parent.meta[&f.field] = if matches!(node.kind, b'0'..=b'9' | b'-') {
                        serde_json::from_str(&f.value)?
                    } else {
                        json!(f.value)
                    };
                }
                if node.kind == b'{'
                    && matches!(
                        f.field.as_str(),
                        "item"
                            | "part"
                            | "response"
                            | "content_block"
                            | "delta"
                            | "error"
                            | "message"
                    )
                    && depth <= 2
                {
                    parent.meta[&f.field] = meta;
                }
            }
        } else {
            self.root = meta;
        }
        Ok(())
    }
}
fn scan(
    db: &Connection,
    audit: &str,
    legacy: Option<&[u8]>,
    start: u64,
    end: u64,
    sse: bool,
    cancelled: &dyn Fn() -> bool,
) -> (Scan, bool) {
    let mut scan = Scan::default();
    let body = reader(db, audit, "response", legacy, start, end, cancelled);
    let body: Box<dyn Read> = if sse {
        Box::new(Payload::new(body))
    } else {
        body
    };
    let mut parser = JsonStream::new(body);
    if !sse {
        parser.at = start;
    }
    let parsed = parser.parse(&mut scan, "response").is_ok();
    (scan, parsed)
}
fn kind(meta: &Value) -> &'static str {
    let t = meta["type"].as_str().unwrap_or("");
    match t {
        "message" | "output_text" | "text" => "assistant",
        "reasoning" | "thinking" | "redacted_thinking" => "reasoning",
        "refusal" => "refusal",
        "function_call" | "custom_tool_call" | "tool_use" | "server_tool_use" => "tool_call",
        "error" => "error",
        _ if t.ends_with("_call") => "tool_call",
        _ if t.ends_with("_call_output") || t.ends_with("_tool_result") => "tool_result",
        _ => "other",
    }
}
fn source(mut meta: Value, event: Option<(u64, u64)>) -> Value {
    meta["kind"] = json!(kind(&meta));
    if let Some((start, end)) = event {
        meta["eventStart"] = json!(start);
        meta["eventEnd"] = json!(end);
    }
    meta
}
struct Index {
    items: Vec<Value>,
    parsed: bool,
    status: Value,
}
struct Entry {
    audit: String,
    fingerprint: [u8; 32],
    index: Index,
    bytes: usize,
}
#[derive(Default)]
pub(super) struct Cache {
    entries: VecDeque<Entry>,
}

fn range(metadata: &Value, start_key: &str, end_key: &str) -> Result<(u64, u64)> {
    let start = metadata[start_key]
        .as_u64()
        .ok_or_else(|| anyhow!("invalid_overview_range"))?;
    let end = metadata[end_key]
        .as_u64()
        .ok_or_else(|| anyhow!("invalid_overview_range"))?;
    if start >= end || end > i64::MAX as u64 {
        bail!("invalid_overview_range");
    }
    Ok((start, end))
}

fn fragment_node(node: &Value) -> bool {
    range(node, "start", "end").is_ok()
        && matches!(node["kind"].as_u64(), Some(k) if k == u64::from(b'"') || k == u64::from(b'{'))
}

fn build(
    db: &Connection,
    audit: &str,
    legacy: Option<&[u8]>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Index> {
    let mut probe = reader(db, audit, "response", legacy, 0, i64::MAX as u64, cancelled);
    let mut b = [0];
    loop {
        match probe.read(&mut b) {
            Ok(0) => break,
            Ok(_) if b[0].is_ascii_whitespace() => {}
            Ok(_) => break,
            Err(_) => {
                if cancelled() {
                    bail!("overview_cancelled");
                }
                return Ok(Index {
                    items: Vec::new(),
                    parsed: false,
                    status: Value::Null,
                });
            }
        }
    }
    if matches!(b[0], b'{' | b'[') {
        let (scan, parsed) = scan(db, audit, legacy, 0, i64::MAX as u64, false, cancelled);
        if cancelled() {
            bail!("overview_cancelled");
        }
        let mut items = scan
            .items
            .into_iter()
            .map(|m| source(m, None))
            .collect::<Vec<_>>();
        if let Some(error) = scan.root.get("error") {
            items.push(source(json!({"type":"error", "start":error["start"], "end":error["end"], "location":error["location"]}), None));
        }
        if items.is_empty()
            && scan.root["type"] != "response"
            && scan
                .root
                .get("nodes")
                .is_some_and(|n| n.get("output").is_none() && n.get("content").is_none())
        {
            items.push(source(scan.root.clone(), None));
        }
        return Ok(Index {
            items,
            parsed,
            status: scan
                .root
                .get("status")
                .or_else(|| scan.root.get("stop_reason"))
                .cloned()
                .unwrap_or(Value::Null),
        });
    }
    let mut ranges = Vec::new();
    let mut body = reader(db, audit, "response", legacy, 0, i64::MAX as u64, cancelled);
    let mut bytes = [0; 8192];
    let mut at = 0;
    let mut start = 0;
    let mut tail = [0; 4];
    let mut parsed = true;
    loop {
        let n = match body.read(&mut bytes) {
            Ok(n) => n,
            Err(_) => {
                parsed = false;
                break;
            }
        };
        if n == 0 {
            break;
        }
        for &b in &bytes[..n] {
            at += 1;
            tail.rotate_left(1);
            tail[3] = b;
            if tail[2..] == *b"\n\n" || tail[1..] == *b"\n\r\n" {
                ranges.push((start, at));
                start = at;
                tail = [0; 4];
            }
        }
    }
    if at > start {
        parsed = false;
    }
    let mut outputs = BTreeMap::<u64, Value>::new();
    let mut output_snapshots = BTreeMap::<u64, Vec<Value>>::new();
    let mut extras = Vec::new();
    let mut terminal = false;
    let mut status = Value::Null;
    for (start, end) in ranges {
        if cancelled() {
            bail!("overview_cancelled");
        }
        let (scan, valid) = scan(db, audit, legacy, start, end, true, cancelled);
        if !valid {
            let mut payload =
                Payload::new(reader(db, audit, "response", legacy, start, end, cancelled));
            let mut prefix = [0; 6];
            let n = payload.read(&mut prefix)?;
            if n != 0 && &prefix[..n] != b"[DONE]" {
                parsed = false;
            }
            continue;
        }
        let e = &scan.root;
        let t = e["type"].as_str().unwrap_or("");
        let i = e["output_index"].as_u64().unwrap_or(0);
        if let Some(ids) = e["contentSnapshotIds"].as_array() {
            if t.starts_with("content_block_") && e["index"].is_u64()
                || t.starts_with("response.") && e["output_index"].is_u64()
            {
                let index = e["index"].as_u64().unwrap_or(i);
                let all = output_snapshots.entry(index).or_default();
                for id in ids {
                    if !all.contains(id) {
                        all.push(id.clone());
                    }
                }
            }
        }
        match t {
            "content_block_start" => {
                let i = e["index"].as_u64().unwrap_or(0);
                if e["content_block"].is_object() {
                    outputs.insert(i, source(e["content_block"].clone(), Some((start, end))));
                }
            }
            "content_block_delta" => {
                let i = e["index"].as_u64().unwrap_or(0);
                let d = &e["delta"];
                let field = match d["type"].as_str().unwrap_or("") {
                    "text_delta" => "text",
                    "thinking_delta" => "thinking",
                    "signature_delta" => "signature",
                    "input_json_delta" => "partial_json",
                    _ => "",
                };
                if field.is_empty() || !fragment_node(&d["nodes"][field]) || !e["index"].is_u64() {
                    parsed = false;
                    extras.push(source(e.clone(), Some((start, end))));
                    continue;
                }
                let item = outputs.entry(i).or_insert_with(|| {
                    source(
                        json!({"type":"unknown","missingStart":true}),
                        Some((start, end)),
                    )
                });
                let key = format!("{field}/0");
                if !item["fragments"].is_object() {
                    item["fragments"] = json!({});
                }
                if !item["fragments"][&key].is_array() {
                    item["fragments"][&key] = json!([]);
                }
                item["fragments"][&key]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"eventStart":start,"eventEnd":end,"node":d["nodes"][field]}));
            }
            "content_block_stop" => {
                if let Some(item) = outputs.get_mut(&e["index"].as_u64().unwrap_or(0)) {
                    item["blockComplete"] = json!(true);
                } else {
                    parsed = false;
                }
            }
            "message_start" => {}
            "message_delta" => {
                status = e["delta"]["stop_reason"].clone();
            }
            "message_stop" => {
                terminal = true;
            }
            "ping" => {}
            "response.output_item.added" | "response.output_item.done" => {
                if e["item"].is_object() {
                    outputs.insert(i, source(e["item"].clone(), Some((start, end))));
                }
            }
            "response.completed" | "response.failed" | "response.incomplete" => {
                terminal = true;
                status = e["response"]["status"].clone();
                if status.is_null() {
                    status = json!(t.trim_start_matches("response."));
                }
                if e["response"]["nodes"].get("output").is_some() {
                    outputs = scan
                        .items
                        .into_iter()
                        .enumerate()
                        .map(|(i, m)| (i as u64, source(m, Some((start, end)))))
                        .collect();
                }
                if e["response"]["error"].is_object() {
                    extras.push(source(json!({"type":"error","eventStart":start,"eventEnd":end,"start":e["response"]["error"]["start"],"end":e["response"]["error"]["end"]}),Some((start,end))));
                }
            }
            "response.content_part.added"
            | "response.content_part.done"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done" => {
                let part = &e["part"];
                let field = if part["type"] == "refusal" {
                    "refusal"
                } else {
                    "text"
                };
                if fragment_node(&part["nodes"][field]) {
                    let summary = t.starts_with("response.reasoning_summary");
                    let item = outputs.entry(i).or_insert_with(||source(json!({"type":if summary {"reasoning"} else {"message"},"missingStart":true}),Some((start,end))));
                    let block = e[if summary {
                        "summary_index"
                    } else {
                        "content_index"
                    }]
                    .as_u64()
                    .unwrap_or(0);
                    let key = format!("{}/{block}", if summary { "summary" } else { field });
                    if !item["fragments"].is_object() {
                        item["fragments"] = json!({});
                    }
                    item["fragments"][key] = json!([{"eventStart":start,"eventEnd":end,"node":part["nodes"][field],"replace":true}]);
                } else {
                    parsed = false;
                    extras.push(source(e.clone(), Some((start, end))));
                }
            }
            "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.custom_tool_call_input.delta"
            | "response.custom_tool_call_input.done"
            | "response.output_text.delta"
            | "response.output_text.done"
            | "response.refusal.delta"
            | "response.refusal.done"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done"
            | "response.reasoning_text.delta"
            | "response.reasoning_text.done" => {
                let channel = if t.contains("function_call") {
                    "arguments"
                } else if t.contains("custom_tool") {
                    "input"
                } else if t.contains("refusal") {
                    "refusal"
                } else if t.contains("reasoning_summary") {
                    "summary"
                } else if t.contains("reasoning_text") {
                    "reasoning"
                } else {
                    "text"
                };
                let block = e[if channel == "summary" {
                    "summary_index"
                } else {
                    "content_index"
                }]
                .as_u64()
                .unwrap_or(0);
                let key = format!("{channel}/{block}");
                let field = if t.ends_with(".delta") {
                    "delta"
                } else if channel == "arguments" || channel == "input" || channel == "refusal" {
                    channel
                } else {
                    "text"
                };
                if !fragment_node(&e["nodes"][field]) || !e["output_index"].is_u64() {
                    parsed = false;
                    extras.push(source(e.clone(), Some((start, end))));
                    continue;
                }
                let item = outputs.entry(i).or_insert_with(|| source(json!({"type":if t.contains("reasoning") {"reasoning"} else if t.contains("function_call") {"function_call"} else if t.contains("custom_tool") {"custom_tool_call"} else {"message"},"missingStart":true}),Some((start,end))));
                let fragment = json!({"eventStart":start,"eventEnd":end,"node":e["nodes"][field],"replace":t.ends_with(".done")});
                if !item["fragments"].is_object() {
                    item["fragments"] = json!({});
                }
                if t.ends_with(".done") || !item["fragments"][&key].is_array() {
                    item["fragments"][&key] = json!([]);
                }
                item["fragments"][&key]
                    .as_array_mut()
                    .unwrap()
                    .push(fragment);
            }
            "error" => {
                terminal = true;
                status = json!("failed");
                extras.push(source(
                    json!({"type":"error","start":0,"end":e["end"]}),
                    Some((start, end)),
                ));
            }
            "response.created" | "response.in_progress" => {
                for (i, m) in scan.items.into_iter().enumerate() {
                    // These events carry output arrays, not a top-level
                    // output_index. Keep each output's earlier evidence links
                    // when the final event replaces its display content.
                    if let Some(ids) = m["contentSnapshotIds"].as_array() {
                        let all = output_snapshots.entry(i as u64).or_default();
                        for id in ids {
                            if !all.contains(id) {
                                all.push(id.clone());
                            }
                        }
                    }
                    outputs
                        .entry(i as u64)
                        .or_insert_with(|| source(m, Some((start, end))));
                }
            }
            "response.output_text.annotation.added"
            | "response.file_search_call.in_progress"
            | "response.file_search_call.searching"
            | "response.file_search_call.completed"
            | "response.web_search_call.in_progress"
            | "response.web_search_call.searching"
            | "response.web_search_call.completed"
            | "response.code_interpreter_call.in_progress"
            | "response.code_interpreter_call.interpreting"
            | "response.code_interpreter_call.completed" => {}
            _ => {
                parsed = false;
                extras.push(source(e.clone(), Some((start, end))));
            }
        }
    }
    let mut items = outputs
        .into_iter()
        .map(|(index, mut item)| {
            item["contentSnapshotIds"] = json!(output_snapshots.remove(&index).unwrap_or_default());
            item
        })
        .collect::<Vec<_>>();
    items.extend(extras);
    Ok(Index {
        items,
        parsed: parsed && terminal,
        status,
    })
}

fn value_at(
    db: &Connection,
    audit: &str,
    snapshot: &str,
    legacy: Option<&[u8]>,
    metadata: &Value,
    cancelled: &dyn Fn() -> bool,
) -> Result<Value> {
    let (start, end) = range(metadata, "start", "end")?;
    if metadata.get("eventStart").is_some() {
        let (event_start, event_end) = range(metadata, "eventStart", "eventEnd")?;
        if end > event_end - event_start {
            bail!("invalid_overview_range");
        }
        let mut payload = Payload::new(reader(
            db,
            audit,
            snapshot,
            legacy,
            event_start,
            event_end,
            cancelled,
        ));
        io::copy(&mut payload.by_ref().take(start), &mut io::sink())?;
        Ok(serde_json::from_reader(payload.take(end - start))?)
    } else {
        Ok(serde_json::from_reader(reader(
            db, audit, snapshot, legacy, start, end, cancelled,
        ))?)
    }
}

// Retained stream values refer to original decoded content in independent snapshots.
fn reference_id(value: &Value) -> Option<&str> {
    let map = value.as_object()?;
    let id = value["contentSnapshotId"].as_str()?;
    if map.len() != 4
        || uuid::Uuid::parse_str(id.strip_prefix("stream/")?).is_err()
        || value["fragmentUnit"] != "decoded_utf8_bytes"
        || range(value, "observedFragmentStart", "observedFragmentEnd").is_err()
    {
        return None;
    }
    Some(id)
}

fn resolve_reference(
    db: &Connection,
    audit: &str,
    value: &mut Value,
    field: &str,
    cancelled: &dyn Fn() -> bool,
    snapshots: &mut BTreeMap<String, (Value, bool)>,
) -> Result<bool> {
    if cancelled() {
        bail!("overview_cancelled");
    }
    if let Some(id) = reference_id(value) {
        if !snapshots.contains_key(id) {
            let raw: Option<String> = db
                .query_row(
                    "SELECT data FROM audit_snapshots WHERE audit_id=? AND id=?",
                    params![audit, id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(raw) = raw else {
                *value = json!({"unavailableContentSnapshotId":id});
                return Ok(false);
            };
            let manifest: Value = serde_json::from_str(&raw)?;
            if manifest["source"] != "stream_inspection" || manifest["root"] != id {
                return Ok(true);
            }
            let content = if let Some(body) = manifest.get("body") {
                body.clone()
            } else {
                serde_json::from_reader(reader(db, audit, id, None, 0, i64::MAX as u64, cancelled))?
            };
            snapshots.insert(id.into(), (content, manifest["state"] == "complete"));
        }
        let (content, retained_complete) = &snapshots[id];
        let text_field = if content.get("text").is_some() {
            "text"
        } else if content["type"] == "function_call" {
            "arguments"
        } else {
            "input"
        };
        if let Some(text) = content[text_field].as_str() {
            let (start, end) = range(value, "observedFragmentStart", "observedFragmentEnd")?;
            let start = usize::try_from(start)?;
            let end = usize::try_from(end)?;
            let Some(part) = text.get(start..end) else {
                return Ok(false);
            };
            *value = json!(part);
        } else {
            *value = content[text_field].clone();
        }
        // Claude tool_use has structured input; Codex custom_tool_call keeps
        // free-form text even when that text is valid JSON.
        if field == "input" && content["type"] == "tool_use" {
            if let Some(s) = value.as_str() {
                if let Ok(json) = serde_json::from_str::<Value>(s) {
                    *value = json;
                }
            }
        }
        return Ok(*retained_complete);
    }
    Ok(true)
}

// Only fields rewritten by the SSE retention pipeline can contain references.
// Tool input is an application object: never recurse into its parameters.
fn resolve_fields(
    db: &Connection,
    audit: &str,
    value: &mut Value,
    cancelled: &dyn Fn() -> bool,
    snapshots: &mut BTreeMap<String, (Value, bool)>,
) -> Result<bool> {
    let fields: &[&str] = match value["type"].as_str() {
        Some("function_call") => &["arguments"],
        Some("custom_tool_call" | "tool_use") => &["input"],
        Some("thinking") => &["thinking"],
        Some("text" | "output_text" | "summary_text" | "reasoning_text") => &["text"],
        Some("message" | "reasoning") => {
            let mut complete = true;
            for field in ["content", "summary"] {
                if let Some(parts) = value[field].as_array_mut() {
                    for part in parts {
                        complete &= resolve_fields(db, audit, part, cancelled, snapshots)?;
                    }
                }
            }
            return Ok(complete);
        }
        _ => &[],
    };
    let mut complete = true;
    for field in fields {
        if let Some(part) = value.get_mut(*field) {
            complete &= resolve_reference(db, audit, part, field, cancelled, snapshots)?;
        }
    }
    Ok(complete)
}
fn readable(value: &Value, out: &mut Vec<String>, parts: &mut Vec<String>, opaque: &mut bool) {
    match value {
        Value::Object(map) => {
            if value["type"] == "redacted_thinking"
                || map.get("encrypted_content").is_some_and(|v| !v.is_null())
            {
                *opaque = true;
            }
            if value["type"] == "refusal" {
                parts.push("refusal".into());
            }
            for (k, v) in map {
                if matches!(k.as_str(), "encrypted_content" | "signature" | "data") {
                    continue;
                }
                if matches!(
                    k.as_str(),
                    "text"
                        | "content"
                        | "thinking"
                        | "refusal"
                        | "arguments"
                        | "input"
                        | "output"
                        | "message"
                        | "code"
                ) {
                    if let Some(s) = v.as_str() {
                        if !s.is_empty() {
                            out.push(s.into());
                        }
                    } else if matches!(k.as_str(), "arguments" | "input" | "output") {
                        out.push(v.to_string());
                    } else {
                        readable(v, out, parts, opaque);
                    }
                } else {
                    readable(v, out, parts, opaque);
                }
            }
        }
        Value::Array(values) => {
            for v in values {
                readable(v, out, parts, opaque);
            }
        }
        _ => {}
    }
}
fn materialize(
    db: &Connection,
    audit: &str,
    legacy: Option<&[u8]>,
    meta: &Value,
    cancelled: &dyn Fn() -> bool,
) -> Result<Value> {
    let mut body = if meta.get("start").is_some() {
        value_at(db, audit, "response", legacy, meta, cancelled)?
    } else {
        json!({"type":meta["type"]})
    };
    if !body.is_object() {
        bail!("invalid_overview_item");
    }
    let mut snapshots = BTreeMap::new();
    let mut complete = if meta.get("eventStart").is_some() {
        resolve_fields(db, audit, &mut body, cancelled, &mut snapshots)?
    } else {
        true
    };
    if let Some(channels) = meta["fragments"].as_object() {
        let mut channels = channels.iter().collect::<Vec<_>>();
        channels.sort_by_key(|(key, _)| {
            let (field, block) = key.split_once('/').unwrap_or((key, ""));
            (field, block.parse::<usize>().unwrap_or(usize::MAX))
        });
        let initial_lengths =
            ["content", "summary"].map(|field| (field, body[field].as_array().map_or(0, Vec::len)));
        let mut appended = BTreeMap::new();
        for (key, fragments) in channels {
            let mut joined = String::new();
            let mut structured_input = None;
            let fragments = fragments
                .as_array()
                .ok_or_else(|| anyhow!("invalid_overview_fragments"))?;
            for fragment in fragments {
                let mut node = fragment["node"].clone();
                if !fragment_node(&node) {
                    bail!("invalid_overview_fragment");
                }
                node["eventStart"] = fragment["eventStart"].clone();
                node["eventEnd"] = fragment["eventEnd"].clone();
                let mut value = value_at(db, audit, "response", legacy, &node, cancelled)?;
                if value.is_object() && reference_id(&value).is_none() {
                    complete = false;
                    continue;
                }
                complete &=
                    resolve_reference(db, audit, &mut value, "", cancelled, &mut snapshots)?;
                if let Some(s) = value.as_str() {
                    joined.push_str(s);
                } else if key.starts_with("partial_json/") && value.is_object() {
                    structured_input = Some(value);
                } else {
                    complete = false;
                }
            }
            let (field, block) = key
                .split_once('/')
                .ok_or_else(|| anyhow!("invalid_overview_channel"))?;
            let block = block.parse::<usize>()?;
            let replace = fragments.first().is_some_and(|f| f["replace"] == true);
            if matches!(field, "text" | "thinking" | "signature" | "partial_json")
                && (meta.get("blockComplete").is_some()
                    || matches!(
                        body["type"].as_str(),
                        Some("text" | "thinking" | "tool_use" | "server_tool_use")
                    ))
            {
                if field == "partial_json" {
                    match structured_input
                        .map(Ok)
                        .unwrap_or_else(|| serde_json::from_str::<Value>(&joined))
                    {
                        Ok(input) => body["input"] = input,
                        Err(_) => {
                            body["input"] = json!(joined);
                            complete = false;
                        }
                    }
                } else {
                    let prefix = body[field].as_str().unwrap_or("");
                    body[field] = json!(format!("{prefix}{joined}"));
                }
            } else if matches!(field, "arguments" | "input") {
                let prefix = if replace {
                    ""
                } else {
                    body[field].as_str().unwrap_or("")
                };
                body[field] = json!(format!("{prefix}{joined}"));
            } else {
                let array = if field == "summary" {
                    "summary"
                } else {
                    "content"
                };
                let part_type = match field {
                    "summary" => "summary_text",
                    "reasoning" => "reasoning_text",
                    "refusal" => "refusal",
                    _ => "output_text",
                };
                let text_field = if field == "refusal" {
                    "refusal"
                } else {
                    "text"
                };
                if !body[array].is_array() {
                    body[array] = json!([]);
                }
                let parts = body[array]
                    .as_array_mut()
                    .ok_or_else(|| anyhow!("invalid_overview_parts"))?;
                let initial_length = initial_lengths
                    .iter()
                    .find(|(field, _)| *field == array)
                    .map_or(0, |(_, len)| *len);
                // Preserve indexes without allocating gaps for untrusted indexes.
                let part = if block < initial_length {
                    &mut parts[block]
                } else {
                    let index = *appended.entry((array, block)).or_insert_with(|| {
                        let index = parts.len();
                        parts.push(json!({"type":part_type}));
                        index
                    });
                    parts
                        .get_mut(index)
                        .ok_or_else(|| anyhow!("invalid_overview_parts"))?
                };
                if !part.is_object() {
                    *part = json!({"type":part_type});
                }
                let prefix = if replace {
                    ""
                } else {
                    part[text_field].as_str().unwrap_or("")
                };
                part[text_field] = json!(format!("{prefix}{joined}"));
            }
        }
        complete &= meta["blockComplete"] == true; // Claude completes blocks independently; Codex needs its final item.
    }
    let mut text = Vec::new();
    let mut parts = Vec::new();
    let mut opaque = false;
    readable(&body, &mut text, &mut parts, &mut opaque);
    let preview = if text.is_empty() && !opaque {
        body.to_string()
    } else {
        text.join("\n")
    };
    complete &= meta.get("missingStart").is_none();
    if meta["eventStart"].is_number()
        && matches!(
            body["type"].as_str(),
            Some("text" | "thinking" | "redacted_thinking" | "tool_use" | "server_tool_use")
        )
    {
        complete &= meta["blockComplete"] == true;
    }
    let mut item = json!({"kind":meta["kind"],"type":meta["type"],"preview":preview,"structure":serde_json::to_string_pretty(&body)?,"parts":parts,"opaque":opaque,"start":meta["eventStart"].as_u64().or_else(||meta["start"].as_u64()).unwrap_or(0),"end":meta["eventEnd"].as_u64().or_else(||meta["end"].as_u64()).unwrap_or(0),"location":meta["location"],"snapshotId":"response","state":if complete {"complete"} else {"partial"}});
    let mut ids = meta["contentSnapshotIds"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for id in snapshots.keys() {
        if !ids.contains(&json!(id)) {
            ids.push(json!(id));
        }
    }
    item["contentSnapshotIds"] = json!(ids);
    for (to, from) in [
        ("name", "name"),
        ("callId", "call_id"),
        ("id", "id"),
        ("status", "status"),
        ("role", "role"),
    ] {
        if let Some(v) = body.get(from) {
            item[to] = v.clone();
        }
    }
    if matches!(body["type"].as_str(), Some("tool_use" | "server_tool_use")) {
        item["callId"] = body["id"].clone();
    }
    if let Some(id) = body.get("tool_use_id") {
        item["callId"] = id.clone();
    }
    if body["type"] == "server_tool_use"
        || body["type"]
            .as_str()
            .is_some_and(|t| t.ends_with("_tool_result"))
    {
        item["serverTool"] = json!(true);
    }
    Ok(item)
}
impl Cache {
    pub(super) fn read(
        &mut self,
        db: &Connection,
        audit: &str,
        offset: usize,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Value> {
        if cancelled() {
            bail!("overview_cancelled");
        }
        let raw: Option<String> = db
            .query_row(
                "SELECT data FROM audit_snapshots WHERE audit_id=? AND id='response'",
                [audit],
                |r| r.get(0),
            )
            .optional()?;
        let Some(raw) = raw else {
            self.entries.retain(|e| e.audit != audit);
            return Ok(
                json!({"items":[],"total":0,"counts":{},"offset":offset,"nextOffset":null,"state":"unavailable"}),
            );
        };
        let manifest: Value = serde_json::from_str(&raw)?;
        let fingerprint: [u8; 32] = Sha256::digest(raw.as_bytes()).into();
        let legacy = manifest.get("body").map(serde_json::to_vec).transpose()?;
        let entry = if let Some(p) = self
            .entries
            .iter()
            .position(|e| e.audit == audit && e.fingerprint == fingerprint)
        {
            self.entries.remove(p).unwrap()
        } else {
            self.entries.retain(|e| e.audit != audit);
            let index = build(db, audit, legacy.as_deref(), cancelled)?;
            let bytes = index
                .items
                .iter()
                .map(|i| i.to_string().len())
                .sum::<usize>();
            Entry {
                audit: audit.into(),
                fingerprint,
                index,
                bytes,
            }
        };
        let mut counts = json!({});
        for item in &entry.index.items {
            let kind = item["kind"].as_str().unwrap_or("other");
            counts[kind] = json!(counts[kind].as_u64().unwrap_or(0) + 1);
        }
        let mut items = Vec::new();
        for (i, meta) in entry
            .index
            .items
            .iter()
            .enumerate()
            .skip(offset)
            .take(PAGE_ITEMS)
        {
            match materialize(db,audit,legacy.as_deref(),meta,cancelled) {
                Ok(mut item) => { item["index"] = json!(i); items.push(item); },
                Err(error) if cancelled() => return Err(error),
                Err(_) => items.push(json!({"index":i,"kind":meta["kind"],"type":meta["type"],"state":"partial","preview":"此项留存内容存在缺口。","snapshotId":"response","start":meta["eventStart"].as_u64().or_else(||meta["start"].as_u64()).unwrap_or(0),"location":meta["location"]})),
            }
        }
        let total = entry.index.items.len();
        let state = if entry.index.parsed
            && manifest["state"] == "complete"
            && items.iter().all(|i| i["state"] == "complete")
        {
            "complete"
        } else {
            "partial"
        };
        let result = json!({"items":items,"total":total,"counts":counts,"offset":offset,"nextOffset":if offset.saturating_add(PAGE_ITEMS)<total {Some(offset.saturating_add(PAGE_ITEMS))} else {None},"state":state,"bodyState":manifest["state"],"status":entry.index.status});
        if entry.bytes <= 8 * 1024 * 1024 {
            while self.entries.len() >= 8
                || self.entries.iter().map(|e| e.bytes).sum::<usize>() + entry.bytes
                    > 8 * 1024 * 1024
            {
                self.entries.pop_front();
            }
            self.entries.push_back(entry);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE audit_snapshots(audit_id TEXT,id TEXT,data TEXT); CREATE TABLE audit_body_chunks(audit_id TEXT,snapshot_id TEXT,start INTEGER,end INTEGER,content TEXT);").unwrap();
        db
    }
    fn legacy(db: &Connection, body: Value, state: Option<&str>) {
        let mut manifest = json!({"body":body});
        if let Some(state) = state {
            manifest["state"] = json!(state);
        }
        db.execute("DELETE FROM audit_snapshots", []).unwrap();
        db.execute(
            "INSERT INTO audit_snapshots VALUES('audit','response',?)",
            [manifest.to_string()],
        )
        .unwrap();
    }
    #[test]
    fn legacy_retention_state_unknown_blocks_empty_output_and_cache_invalidation() {
        let db = db();
        let mut cache = Cache::default();
        for state in [
            Some("complete"),
            Some("truncated"),
            Some("interrupted"),
            None,
        ] {
            legacy(
                &db,
                json!({"type":"message","content":[{"type":"text","text":"complete text"},{"type":"new_block","extra":{"nested":"all fields"}}],"stop_reason":"max_tokens"}),
                state,
            );
            let page = cache.read(&db, "audit", 0, &|| false).unwrap();
            assert_eq!(page["total"], 2);
            assert_eq!(
                page["state"],
                if state == Some("complete") {
                    "complete"
                } else {
                    "partial"
                }
            );
            assert_eq!(page["status"], "max_tokens");
            assert_eq!(
                serde_json::from_str::<Value>(page["items"][1]["structure"].as_str().unwrap())
                    .unwrap()["extra"]["nested"],
                "all fields"
            );
        }
        legacy(&db, json!({"output":[]}), Some("complete"));
        assert_eq!(cache.read(&db, "audit", 0, &|| false).unwrap()["total"], 0);
        db.execute("DELETE FROM audit_snapshots", []).unwrap();
        assert_eq!(
            cache.read(&db, "audit", 0, &|| false).unwrap()["state"],
            "unavailable"
        );
    }
    #[test]
    fn source_gaps_cancellation_and_page_ranges_remain_explicit() {
        let db = db();
        let mut cache = Cache::default();
        db.execute(
            "INSERT INTO audit_snapshots VALUES('audit','response',?)",
            [json!({"state":"gap","byteLength":2}).to_string()],
        )
        .unwrap();
        assert_eq!(
            cache.read(&db, "audit", 0, &|| false).unwrap()["state"],
            "partial"
        );
        assert!(cache.read(&db, "audit", 0, &|| true).is_err());
        let output=(0..44).map(|i|json!({"type":"message","content":[{"type":"output_text","text":format!("text {i}")}]})).collect::<Vec<_>>();
        legacy(&db, json!({"output":output}), Some("complete"));
        let page = cache.read(&db, "audit", 40, &|| false).unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 4);
        assert_eq!(page["counts"]["assistant"], 44);
        assert_eq!(page["items"][3]["preview"], "text 43");
    }
    #[test]
    fn sse_payload_handles_multiline_comments_crlf_and_unknown_events() {
        let data=b": comment\r\nevent: test\r\ndata: {\"type\":\"new_event\",\r\ndata: \"text\":\"retained\"}\r\n\r\n";
        let value: Value = serde_json::from_reader(Payload::new(&data[..])).unwrap();
        assert_eq!(value["text"], "retained");
        let db = db();
        db.execute(
            "INSERT INTO audit_snapshots VALUES('audit','response',?)",
            [json!({"state":"complete"}).to_string()],
        )
        .unwrap();
        let text =
            String::from_utf8(data.to_vec()).unwrap() + "data: {\"type\":\"message_stop\"}\n\n";
        db.execute(
            "INSERT INTO audit_body_chunks VALUES('audit','response',0,?,?)",
            params![text.len(), text],
        )
        .unwrap();
        let page = Cache::default().read(&db, "audit", 0, &|| false).unwrap();
        assert_eq!(page["state"], "partial");
        assert_eq!(page["items"][0]["preview"], "retained");
    }
    #[test]
    fn scan_does_not_keep_unbounded_nested_metadata_or_output_text() {
        let db = db();
        let bytes=json!({"output":[{"type":"message","content":[{"type":"output_text","text":"large".repeat(100000)}],"extra":(0..1000).map(|i|(format!("k{i}"),json!({"id":"unneeded"}))).collect::<serde_json::Map<String,Value>>()}]}).to_string();
        let index = build(&db, "audit", Some(bytes.as_bytes()), &|| false).unwrap();
        assert_eq!(index.items.len(), 1);
        assert!(index.items[0].to_string().len() < 1000);
    }
    #[test]
    fn initial_parts_survive_interruption_and_future_response_events_stay_visible() {
        let db = db();
        let text = "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"content\":[]}}\n\ndata: {\"type\":\"response.content_part.added\",\"output_index\":0,\"content_index\":0,\"part\":{\"type\":\"output_text\",\"text\":\"Initial text\"}}\n\ndata: {\"type\":\"response.future.done\",\"text\":\"Future output\"}\n\n";
        db.execute(
            "INSERT INTO audit_snapshots VALUES('audit','response',?)",
            [json!({"state":"interrupted"}).to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO audit_body_chunks VALUES('audit','response',0,?,?)",
            params![text.len(), text],
        )
        .unwrap();
        let page = Cache::default().read(&db, "audit", 0, &|| false).unwrap();
        assert_eq!(page["state"], "partial");
        assert_eq!(page["items"][0]["preview"], "Initial text");
        assert_eq!(page["items"][1]["preview"], "Future output");
    }

    #[test]
    fn final_outputs_keep_earlier_snapshot_links_per_output() {
        let db = db();
        let ids = [
            "stream/00000000-0000-0000-0000-000000000001",
            "stream/00000000-0000-0000-0000-000000000002",
        ];
        let mut events = Vec::new();
        for (i, id) in ids.iter().enumerate() {
            events.push(json!({"type":"response.output_text.delta","output_index":i,"content_index":0,"delta":{"contentSnapshotId":id,"observedFragmentStart":0,"observedFragmentEnd":10,"fragmentUnit":"decoded_utf8_bytes"}}));
        }
        events.push(json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"first final"}]},{"type":"message","content":[{"type":"output_text","text":"second final"}]}]}}));
        let text = events
            .iter()
            .map(|e| format!("data: {e}\n\n"))
            .collect::<String>();
        db.execute(
            "INSERT INTO audit_snapshots VALUES('audit','response',?)",
            [json!({"state":"complete"}).to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO audit_body_chunks VALUES('audit','response',0,?,?)",
            params![text.len(), text],
        )
        .unwrap();
        let page = Cache::default().read(&db, "audit", 0, &|| false).unwrap();
        assert_eq!(page["items"][0]["preview"], "first final");
        assert_eq!(page["items"][1]["preview"], "second final");
        for (i, id) in ids.iter().enumerate() {
            assert_eq!(page["items"][i]["contentSnapshotIds"], json!([id]));
        }
    }
    #[test]
    fn initial_response_arrays_keep_snapshot_links_after_final_replacement() {
        for initial in ["response.created", "response.in_progress"] {
            let db = db();
            let ids = [
                "stream/00000000-0000-0000-0000-000000000011",
                "stream/00000000-0000-0000-0000-000000000012",
            ];
            let output = ids.iter().map(|id| json!({"type":"message","content":[{"type":"output_text","text":{"contentSnapshotId":id,"observedFragmentStart":0,"observedFragmentEnd":10,"fragmentUnit":"decoded_utf8_bytes"}}]})).collect::<Vec<_>>();
            let events = [
                json!({"type":initial,"response":{"output":output}}),
                json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"safe first"}]},{"type":"message","content":[{"type":"output_text","text":"safe second"}]}]}}),
            ];
            let text = events
                .iter()
                .map(|e| format!("data: {e}\n\n"))
                .collect::<String>();
            db.execute(
                "INSERT INTO audit_snapshots VALUES('audit','response',?)",
                [json!({"state":"complete"}).to_string()],
            )
            .unwrap();
            db.execute(
                "INSERT INTO audit_body_chunks VALUES('audit','response',0,?,?)",
                params![text.len(), text],
            )
            .unwrap();
            let page = Cache::default().read(&db, "audit", 0, &|| false).unwrap();
            assert_eq!(page["state"], "complete");
            for (i, id) in ids.iter().enumerate() {
                assert_eq!(
                    page["items"][i]["contentSnapshotIds"],
                    json!([id]),
                    "{initial}: output {i}"
                );
            }
        }
    }
    #[test]
    fn invalid_source_ranges_return_errors() {
        let db = db();
        for metadata in [
            json!({}),
            json!({"start":0}),
            json!({"start":4,"end":3}),
            json!({"start":0,"end":0}),
            json!({"start":-1,"end":3}),
            json!({"start":0,"end":"3"}),
            json!({"start":0,"end":u64::MAX}),
            json!({"start":0,"end":3,"eventStart":0}),
            json!({"start":0,"end":3,"eventStart":4,"eventEnd":3}),
            json!({"start":0,"end":30,"eventStart":0,"eventEnd":10}),
        ] {
            assert!(
                value_at(&db, "audit", "response", Some(b"{}"), &metadata, &|| false).is_err(),
                "{metadata}"
            );
        }
    }
}
