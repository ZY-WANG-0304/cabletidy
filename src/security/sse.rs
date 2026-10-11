use super::pipeline::{learn_credentials, BodyWriter, Pipeline, Utf8Reader};
use crate::{
    config::text,
    streaming::{self, Edits, EventFramer, Index, Node, Reservation, Spool, PAGE},
};
use anyhow::Result;
use serde_json::json;
use std::{
    collections::BTreeMap,
    io::{Read, Seek, SeekFrom, Write},
    sync::Arc,
};

struct Group {
    id: String,
    kind: String,
    name: String,
    spool: Spool,
}
struct Streams {
    groups: BTreeMap<String, Group>,
    names: BTreeMap<String, (String, String)>,
    memory: Reservation,
    terminal: bool,
    error: bool,
    terminal_event: Option<&'static str>,
}
fn node<'a>(index: &'a Index, field: &str) -> Option<&'a Node> {
    index
        .nodes
        .iter()
        .rev()
        .find(|(_, f, _)| f == field)
        .map(|(_, _, n)| n)
}
fn copy_node(source: &Arc<Spool>, node: &Node, out: &mut impl Write) -> Result<()> {
    if node.kind == b'"' {
        std::io::copy(&mut streaming::decoded(source, node)?.reader(), out)?;
    } else {
        let mut r = source.reader();
        r.seek(SeekFrom::Start(node.start))?;
        std::io::copy(&mut r.take(node.end - node.start), out)?;
    }
    Ok(())
}
fn json_string(source: &Arc<Spool>, out: &mut impl Write) -> Result<()> {
    out.write_all(b"\"")?;
    let mut r = Utf8Reader::new(source.reader());
    while let Some(s) = r.next()? {
        let escaped = serde_json::to_string(&s)?;
        out.write_all(&escaped.as_bytes()[1..escaped.len() - 1])?;
    }
    out.write_all(b"\"")?;
    Ok(())
}
impl Streams {
    fn start(&mut self, key: &str, kind: &str, name: &str) -> Result<()> {
        self.memory
            .grow(key.len() + kind.len() + name.len() + 256)?;
        self.names.insert(key.into(), (kind.into(), name.into()));
        self.groups.insert(
            key.into(),
            Group {
                id: format!("stream/{}", uuid::Uuid::new_v4()),
                kind: kind.into(),
                name: name.into(),
                spool: Spool::new()?,
            },
        );
        Ok(())
    }
    fn append(
        &mut self,
        key: &str,
        source: &Arc<Spool>,
        part: &Node,
        edits: &mut Edits,
    ) -> Result<()> {
        if let Some(group) = self.groups.get_mut(key) {
            let start = group.spool.len;
            copy_node(source, part, &mut group.spool)?;
            let end = group.spool.len;
            if end > start {
                edits.add(part.start,part.end,serde_json::to_vec(&json!({"contentSnapshotId":group.id,"observedFragmentStart":start,"observedFragmentEnd":end,"fragmentUnit":"decoded_utf8_bytes"}))?)?;
            }
        }
        Ok(())
    }
    fn finish(&mut self, p: &mut Pipeline, key: &str, complete: bool) -> Result<()> {
        let Some(group) = self.groups.remove(key) else {
            return Ok(());
        };
        if group.spool.len == 0 {
            return Ok(());
        }
        let raw = group.spool.seal()?;
        let mut wrapper = std::io::BufWriter::with_capacity(PAGE, Spool::new()?);
        if matches!(
            group.kind.as_str(),
            "function_call" | "custom_tool_call" | "tool_use"
        ) {
            write!(
                wrapper,
                "{{\"type\":{},\"name\":{},\"{}\":",
                serde_json::to_string(&group.kind)?,
                serde_json::to_string(&group.name)?,
                if group.kind == "function_call" {
                    "arguments"
                } else {
                    "input"
                }
            )?;
            if group.kind == "tool_use" && complete {
                std::io::copy(&mut raw.reader(), &mut wrapper)?;
            } else {
                json_string(&raw, &mut wrapper)?;
            }
        } else {
            wrapper.write_all(b"{\"text\":")?;
            json_string(&raw, &mut wrapper)?;
        }
        wrapper.write_all(b"}")?;
        let wrapper = wrapper.into_inner().map_err(|e| e.into_error())?.seal()?;
        p.tool_location = Some(format!("sse/{key}"));
        p.inspect_tools = complete;
        let result = p.body(&group.id, "stream_inspection", wrapper, complete, true);
        p.tool_location = None;
        p.inspect_tools = false;
        if !complete {
            p.rules.reasons.insert("incomplete_stream_fragment");
        }
        result
    }
    fn item(
        &mut self,
        p: &mut Pipeline,
        key: &str,
        source: &Arc<Spool>,
        item: &Node,
        edits: &mut Edits,
        finalized: bool,
    ) -> Result<bool> {
        let info = streaming::index(source, Some(item))?;
        let kind = text(&info.values["type"]);
        if matches!(kind, "function_call" | "custom_tool_call" | "tool_use") {
            if self.groups.contains_key(key) {
                self.finish(p, key, finalized)?;
            }
            self.start(key, kind, text(&info.values["name"]))?;
            let field = if kind == "function_call" {
                "arguments"
            } else {
                "input"
            };
            if let Some(part) = node(&info, field) {
                // Messages starts tool input with {} before emitting partial_json deltas.
                if !(kind == "tool_use" && !finalized && part.end - part.start == 2) {
                    self.append(key, source, part, edits)?;
                }
            }
            if finalized {
                self.finish(p, key, true)?;
            }
        } else if matches!(kind, "text" | "output_text" | "thinking") {
            if kind == "thinking" {
                p.rules.reasons.insert("reasoning_content_not_inspected");
            }
            if let Some(part) = node(
                &info,
                if kind == "thinking" {
                    "thinking"
                } else {
                    "text"
                },
            ) {
                self.text_item(p, key, source, part, edits, finalized)?;
            }
        } else if matches!(kind, "message" | "reasoning") {
            if kind == "reasoning" {
                p.rules.reasons.insert("reasoning_content_not_inspected");
            }
            for field in ["content", "summary"] {
                if let Some(parts) = node(&info, field) {
                    let parts = streaming::index(source, Some(parts))?;
                    for (i, (_, _, part)) in parts.nodes.iter().enumerate() {
                        if !self.response_part(p, key, i as u64, source, part, edits, finalized)? {
                            return Ok(false);
                        }
                    }
                }
            }
        } else {
            return Ok(false);
        }
        Ok(true)
    }
    fn text_item(
        &mut self,
        p: &mut Pipeline,
        key: &str,
        source: &Arc<Spool>,
        part: &Node,
        edits: &mut Edits,
        finalized: bool,
    ) -> Result<()> {
        // A new initial value must not flush an unfinished credential as complete.
        // Final values are separate snapshots of the same logical text channel.
        self.finish(p, key, finalized)?;
        self.start(key, "text", "")?;
        self.append(key, source, part, edits)?;
        if finalized {
            self.finish(p, key, true)?;
        }
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    fn response_part(
        &mut self,
        p: &mut Pipeline,
        output: &str,
        index: u64,
        source: &Arc<Spool>,
        part: &Node,
        edits: &mut Edits,
        finalized: bool,
    ) -> Result<bool> {
        let info = streaming::index(source, Some(part))?;
        let channel = match text(&info.values["type"]) {
            "text" | "output_text" => "text",
            "summary_text" => "summary",
            "reasoning_text" => "reasoning",
            _ => return Ok(false),
        };
        if channel != "text" {
            p.rules.reasons.insert("reasoning_content_not_inspected");
        }
        let Some(text) = node(&info, "text").filter(|n| n.kind == b'"') else {
            return Ok(false);
        };
        self.text_item(
            p,
            &format!("{output}/{channel}/{index}"),
            source,
            text,
            edits,
            finalized,
        )?;
        Ok(true)
    }
    fn event(
        &mut self,
        p: &mut Pipeline,
        writer: &mut BodyWriter,
        event: Arc<Spool>,
    ) -> Result<()> {
        let data = streaming::event_data(&event)?;
        let mut edits = Edits::new();
        if let Ok(info) = streaming::index(&data.payload, None) {
            let kind = text(&info.values["type"]);
            if let Some(outcome) =
                super::status::terminal_outcome(text(&p.record["protocol"]), kind)
            {
                let error = outcome == "stream_error";
                if error || !self.error {
                    self.terminal_event = Some(match kind {
                        "response.completed" => "response.completed",
                        "response.failed" => "response.failed",
                        "response.incomplete" => "response.incomplete",
                        "message_stop" => "message_stop",
                        _ => "error",
                    });
                }
                self.terminal = true;
                self.error |= error;
            } else if matches!(
                kind,
                "response.completed"
                    | "response.failed"
                    | "response.incomplete"
                    | "message_stop"
                    | "error"
            ) {
                p.rules.reasons.insert("unsupported_response_event");
            }
            let key = format!(
                "output/{}",
                info.values["output_index"].as_u64().unwrap_or(0)
            );
            let content = format!("content/{}", info.values["index"].as_u64().unwrap_or(0));
            match kind {
                "response.output_item.added" | "response.output_item.done" => {
                    if let Some(item) = node(&info, "item") {
                        if !self.item(
                            p,
                            &key,
                            &data.payload,
                            item,
                            &mut edits,
                            kind.ends_with("done"),
                        )? {
                            p.rules.reasons.insert("unsupported_response_item");
                        }
                    }
                }
                "response.content_part.added"
                | "response.content_part.done"
                | "response.reasoning_summary_part.added"
                | "response.reasoning_summary_part.done" => {
                    let index = if kind.starts_with("response.reasoning_summary_part") {
                        "summary_index"
                    } else {
                        "content_index"
                    };
                    let supported = if let Some(part) = node(&info, "part") {
                        self.response_part(
                            p,
                            &key,
                            info.values[index].as_u64().unwrap_or(0),
                            &data.payload,
                            part,
                            &mut edits,
                            kind.ends_with("done"),
                        )?
                    } else {
                        false
                    };
                    if !supported {
                        p.rules.reasons.insert("unsupported_response_item");
                    }
                }
                "response.function_call_arguments.delta"
                | "response.custom_tool_call_input.delta" => {
                    if let Some(part) = node(&info, "delta").filter(|n| n.kind == b'"') {
                        if !self.groups.contains_key(&key) {
                            p.rules.reasons.insert("stream_item_metadata_missing");
                            self.start(&key, "text", "")?;
                        }
                        self.append(&key, &data.payload, part, &mut edits)?;
                    }
                }
                "response.function_call_arguments.done"
                | "response.custom_tool_call_input.done" => {
                    self.finish(p, &key, true)?;
                    if let Some((kind, name)) = self.names.get(&key).cloned() {
                        self.start(&key, &kind, &name)?;
                        if let Some(part) = node(
                            &info,
                            if kind == "function_call" {
                                "arguments"
                            } else {
                                "input"
                            },
                        )
                        .filter(|n| n.kind == b'"')
                        {
                            self.append(&key, &data.payload, part, &mut edits)?;
                        }
                        self.finish(p, &key, true)?;
                    }
                }
                "response.output_text.delta"
                | "response.output_text.done"
                | "response.reasoning_summary_text.delta"
                | "response.reasoning_summary_text.done"
                | "response.reasoning_text.delta"
                | "response.reasoning_text.done" => {
                    let reasoning = kind.starts_with("response.reasoning");
                    let summary = kind.starts_with("response.reasoning_summary_text");
                    if reasoning {
                        p.rules.reasons.insert("reasoning_content_not_inspected");
                    }
                    let channel = if summary {
                        "summary"
                    } else if reasoning {
                        "reasoning"
                    } else {
                        "text"
                    };
                    let key = format!(
                        "{key}/{channel}/{}",
                        info.values[if summary {
                            "summary_index"
                        } else {
                            "content_index"
                        }]
                        .as_u64()
                        .unwrap_or(0)
                    );
                    if kind.ends_with("done") {
                        self.finish(p, &key, true)?;
                    }
                    if !self.groups.contains_key(&key) {
                        self.start(&key, "text", "")?;
                    }
                    if let Some(part) = node(
                        &info,
                        if kind.ends_with("done") {
                            "text"
                        } else {
                            "delta"
                        },
                    )
                    .filter(|n| n.kind == b'"')
                    {
                        self.append(&key, &data.payload, part, &mut edits)?;
                    }
                    if kind.ends_with("done") {
                        self.finish(p, &key, true)?;
                    }
                }
                "content_block_start" => {
                    if let Some(item) = node(&info, "content_block") {
                        if !self.item(p, &content, &data.payload, item, &mut edits, false)? {
                            p.rules.reasons.insert("unsupported_response_item");
                        }
                    }
                }
                "content_block_delta" => {
                    if let Some(delta) = node(&info, "delta") {
                        let d = streaming::index(&data.payload, Some(delta))?;
                        let field = match text(&d.values["type"]) {
                            "input_json_delta" => "partial_json",
                            "text_delta" => "text",
                            "thinking_delta" => {
                                p.rules.reasons.insert("reasoning_content_not_inspected");
                                "thinking"
                            }
                            "signature_delta" => "signature",
                            _ => {
                                p.rules.reasons.insert("unsupported_response_event");
                                ""
                            }
                        };
                        if !self.groups.contains_key(&content) {
                            self.start(&content, "text", "")?;
                        }
                        if let Some(part) = node(&d, field).filter(|n| n.kind == b'"') {
                            self.append(&content, &data.payload, part, &mut edits)?;
                        }
                    }
                }
                "content_block_stop" => self.finish(p, &content, true)?,
                "response.created"
                | "response.in_progress"
                | "response.completed"
                | "response.failed"
                | "response.incomplete" => {
                    if let Some(response) = node(&info, "response") {
                        let response = streaming::index(&data.payload, Some(response))?;
                        if let Some(output) = node(&response, "output") {
                            let output = streaming::index(&data.payload, Some(output))?;
                            for (i, (_, _, item)) in output.nodes.iter().enumerate() {
                                if !self.item(
                                    p,
                                    &format!("output/{i}"),
                                    &data.payload,
                                    item,
                                    &mut edits,
                                    kind == "response.completed",
                                )? {
                                    p.rules.reasons.insert("unsupported_response_item");
                                }
                            }
                        }
                    }
                }
                "message_stop" | "error" | "message_start" | "message_delta" | "ping" => {}
                _ => {
                    p.rules.reasons.insert("unsupported_response_event");
                }
            }
        } else if data.payload.len > 0 {
            p.rules.reasons.insert("invalid_sse_event");
        }
        edits.ranges.sort_by_key(|r| r.0);
        let mut retained_source = Spool::new()?;
        std::io::copy(&mut edits.reader(&data.payload), &mut retained_source)?;
        let retained_source = retained_source.seal()?;
        learn_credentials(&retained_source, &mut p.redactor);
        // Fragment references link to reconstructed original content, where credentials
        // split across events can be detected and highlighted together.
        if data.fields.len > 0 {
            p.render_text(writer, data.fields, "response", true, true)?;
        }
        writer.push("data: ")?;
        if learn_credentials(&retained_source, &mut p.redactor) {
            p.render_json(writer, retained_source, "response", true)?;
        } else {
            p.render_text(writer, retained_source, "response", true, true)?;
        }
        writer.push("\n\n")?;
        Ok(())
    }
}

pub(super) fn inspect(p: &mut Pipeline, source: Arc<Spool>, gap: bool) -> Result<()> {
    let mut streams = Streams {
        groups: BTreeMap::new(),
        names: BTreeMap::new(),
        memory: Reservation::memory(),
        terminal: false,
        error: false,
        terminal_event: None,
    };
    let mut writer = BodyWriter::new(
        p.store.clone(),
        text(&p.record["id"]),
        "response",
        "upstream_response",
    )?;
    let base = p.inspected;
    let mut processed = 0;
    let mut reader = source.reader();
    let mut buffer = [0; PAGE];
    let mut framer = EventFramer::new();
    p.inspect_tools = false;
    p.count_progress = false;
    let mut unfinished_event = false;
    let result = (|| -> Result<()> {
        loop {
            let n = reader.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            for &b in &buffer[..n] {
                if let Some(event) = framer.byte(b)? {
                    let len = event.len;
                    streams.event(p, &mut writer, event)?;
                    processed += len;
                    p.inspected = base + processed;
                    writer.flush()?;
                    p.publish("running");
                }
            }
        }
        if let Some(event) = framer.finish()? {
            unfinished_event = true;
            let terminal = (streams.terminal, streams.error, streams.terminal_event);
            let result = streams.event(p, &mut writer, event);
            (streams.terminal, streams.error, streams.terminal_event) = terminal;
            result?;
            p.rules.reasons.insert("incomplete_stream_fragment");
        }
        for key in streams.groups.keys().cloned().collect::<Vec<_>>() {
            streams.finish(
                p,
                &key,
                !gap && !unfinished_event && streams.terminal && !streams.error,
            )?;
        }
        Ok(())
    })();
    if !streams.terminal {
        p.rules.reasons.insert("missing_terminal_event");
    }
    let protocol_complete = result.is_ok() && !gap && !unfinished_event && streams.terminal;
    // Completion needs intact content; a confirmed error remains known even if
    // a later event is cut off or cannot be stored/processed.
    if streams.error || protocol_complete {
        super::status::apply_terminal(&mut p.record, streams.terminal_event.unwrap());
    } else if p.record["outcome"] == "completed" {
        p.record["outcome"] = json!("unknown");
    }
    let state = if result.is_err() {
        "gap"
    } else if protocol_complete {
        "complete"
    } else {
        "interrupted"
    };
    let finalization = writer.finish(state, source.len);
    p.record["responseBodyState"] = json!(state);
    if result.is_ok() {
        p.inspected = base + source.len;
    }
    p.inspect_tools = true;
    p.count_progress = true;
    result.and(finalization)
}
