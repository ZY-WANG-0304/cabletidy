use super::{
    capture::{credential_field, Redactor, StreamText, TextPiece},
    rules::Rules,
    store::Store,
};
use crate::{
    config::text,
    streaming::{Index, JsonStream, Node, Reservation, Spool, Visitor, PAGE},
};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    sync::Arc,
};

pub struct Pipeline {
    pub store: Arc<Store>,
    pub record: Value,
    pub rules: Rules,
    pub redactor: Redactor,
    pub highest: String,
    pub count: usize,
    pub inspected: u64,
    pub failed: bool,
    pub tool_location: Option<String>,
    pub inspect_tools: bool,
    pub incomplete: bool,
    pub count_progress: bool,
}
impl Pipeline {
    pub fn new(store: Arc<Store>, record: Value, secrets: &Value, redactor: Redactor) -> Self {
        Self {
            store,
            record,
            rules: Rules::new(secrets),
            redactor,
            highest: "informational".into(),
            count: 0,
            inspected: 0,
            failed: false,
            tool_location: None,
            inspect_tools: true,
            incomplete: false,
            count_progress: true,
        }
    }
    pub fn publish(&mut self, state: &str) {
        let findings = std::mem::take(&mut self.rules.findings);
        self.count += findings.len();
        for f in &findings {
            if super::rules::rank(text(&f["severity"])) > super::rules::rank(&self.highest) {
                self.highest = text(&f["severity"]).into();
            }
        }
        self.record["severity"] = json!(self.highest);
        self.record["findingCount"] = json!(self.count);
        self.record["coverageReasons"] = json!(self.rules.reasons);
        self.record["inspectionStatus"] = json!(if self.failed { "failed" } else { state });
        super::status::classify(&mut self.record);
        self.record["inspectionProgress"] = json!({"state":self.record["inspectionStatus"],"active":true,"processedBytes":self.inspected.min(self.record["observedBytes"].as_u64().unwrap_or(self.inspected)),"observedBytes":self.record["observedBytes"],"phase":"detecting","updatedAt":crate::config::now()});
        for batch in findings.chunks(16) {
            let mut record = self.record.clone();
            record["findings"] = json!(batch);
            if record.to_string().len() <= super::store::MAX_RECORD {
                if !self.store.write_analysis(record) {
                    self.failed = true;
                    self.rules.reasons.insert("audit_metadata_budget");
                }
            } else {
                for finding in batch {
                    let mut record = self.record.clone();
                    record["findings"] = json!([finding]);
                    if !self.store.write_analysis(record) {
                        self.failed = true;
                        self.rules.reasons.insert("audit_metadata_budget");
                    }
                }
            }
        }
        self.record["findings"] = json!([]);
        if self.failed {
            self.record["inspectionStatus"] = json!("failed");
            self.record["inspectionProgress"]["state"] = json!("failed");
        }
        self.record["coverageReasons"] = json!(self.rules.reasons);
        super::status::classify(&mut self.record);
        self.record["inspectionProgress"]["state"] = self.record["inspectionStatus"].clone();
        // Failed stages can be followed by more body work. Release retention
        // protection only after all final finding batches have been queued.
        if matches!(state, "complete" | "skipped") {
            self.record["statusVersion"] = json!(1);
            self.record["inspectionProgress"]["active"] = json!(false);
            self.record["inspectionProgress"]["phase"] = json!("finished");
        }
        self.store.write_analysis(self.record.clone());
    }
    pub(super) fn findings(
        &mut self,
        before: usize,
        snapshot: &str,
        range: (u64, u64),
        stage: &str,
        hits: Hits,
    ) {
        let (start, end) = range;
        if before == self.rules.findings.len() {
            return;
        }
        let evidence = if stage.starts_with("request")
            || stage == "tool_call_replayed"
            || stage == "tool_result_reported"
        {
            snapshot.to_owned()
        } else {
            let id = format!("evidence/{}", uuid::Uuid::new_v4());
            if !self.store.body(text(&self.record["id"]),json!({"id":id,"root":"evidence","source":if snapshot.starts_with("stream/"){ "stream_inspection" }else{"inspection_range"},"sourceSnapshotId":snapshot,
                "rangeStart":start.saturating_sub(512),"rangeEnd":end,"byteLength":end-start.saturating_sub(512),"format":"text","contentMode":"original","state":"complete","capturedAt":crate::config::now()})){self.failed=true;self.rules.reasons.insert("evidence_storage_unavailable");}
            id
        };
        for finding in &mut self.rules.findings[before..] {
            // Point each finding at its own match. Without this an endpoint finding
            // would reference the whole processing window and highlight far too much.
            let (hit, kind) = match text(&finding["ruleId"]) {
                "SEC-SECRET-001" => (hits.credential, "sensitive"),
                // Each endpoint rule points at the address class that triggered it, so
                // clicking a public risk never highlights an internal address.
                "SEC-ENDPOINT-001" => (hits.public, "endpoint"),
                "SEC-INTERNAL-001" => (hits.internal, "endpoint"),
                _ => (None, ""),
            };
            let (start, end) = hit.unwrap_or((start, end));
            finding["requestId"] = self.record["id"].clone();
            finding["evidence"]["bodyRef"] = json!({"snapshotId":evidence,"sourceSnapshotId":snapshot,"start":start,"end":end,"unit":"utf8_bytes"});
            // `sensitive` marks a credential hit; an endpoint is a separate match kind.
            if hit.is_some() {
                finding["evidence"]["bodyRef"]["matchKind"] = json!(kind);
            }
        }
    }
    pub fn body(
        &mut self,
        id: &str,
        source: &str,
        spool: Arc<Spool>,
        complete: bool,
        inspect: bool,
    ) -> Result<()> {
        self.incomplete = !complete;
        let prior_progress = self.count_progress;
        self.count_progress = matches!(id, "request" | "response");
        let valid = learn_credentials(&spool, &mut self.redactor);
        if !self.redactor.available() {
            self.rules.reasons.insert("credential_redaction_budget");
        }
        let mut writer = BodyWriter::new(self.store.clone(), text(&self.record["id"]), id, source)?;
        let base = self.inspected;
        let mut probe = spool.reader();
        let mut first = [0];
        while probe.read(&mut first)? != 0 && first[0].is_ascii_whitespace() {}
        let structured = matches!(first[0], b'{' | b'[');
        let parsed = if valid || structured {
            if !valid {
                self.rules
                    .reasons
                    .insert("invalid_json_or_structure_budget");
            }
            self.render_json(&mut writer, spool.clone(), id, inspect)
        } else {
            if inspect {
                self.rules.reasons.insert("unstructured_content");
            }
            self.render_text(&mut writer, spool.clone(), id, inspect, complete)
        };
        let state = if parsed.is_err() {
            "gap"
        } else if complete {
            "complete"
        } else {
            "interrupted"
        };
        if parsed.is_ok() {
            self.inspected = if self.count_progress {
                base + spool.len
            } else {
                base
            };
        } else {
            self.rules
                .reasons
                .insert("body_storage_or_processing_failure");
            self.failed = true;
        }
        let finalized = writer.finish(state, spool.len);
        let state = if finalized.is_err() {
            self.failed = true;
            self.rules
                .reasons
                .insert("body_storage_or_processing_failure");
            "gap"
        } else {
            state
        };
        if matches!(id, "request" | "response") {
            self.record[format!("{id}BodyState")] = json!(state);
        }
        if state == "gap" {
            if !self.record["coverageGaps"].is_array() {
                self.record["coverageGaps"] = json!([]);
            }
            self.record["coverageGaps"].as_array_mut().unwrap().push(json!({"snapshotId":id,"reason":"body_storage_or_processing_failure","observedBytes":spool.len,"retainedBytes":writer.offset}));
        }
        self.count_progress = prior_progress;
        self.publish("running");
        parsed.and(finalized)
    }
    pub(super) fn render_json(
        &mut self,
        writer: &mut BodyWriter,
        spool: Arc<Spool>,
        root: &str,
        inspect: bool,
    ) -> Result<()> {
        let mut visitor = BodyVisitor {
            pipeline: self,
            writer,
            spool: spool.clone(),
            frames: Vec::new(),
            inspect,
            root: root.into(),
            last_progress: 0,
            navigation: super::session::Capture::default(),
        };
        JsonStream::new(spool.reader()).parse(&mut visitor, root)
    }
    pub(super) fn render_text(
        &mut self,
        writer: &mut BodyWriter,
        spool: Arc<Spool>,
        root: &str,
        inspect: bool,
        complete: bool,
    ) -> Result<()> {
        let mut masker = StreamText::new(false)?;
        let mut reader = Utf8Reader::new(spool.reader());
        let mut previous = String::new();
        while let Some(part) = reader.next()? {
            if self.count_progress {
                self.inspected += part.len() as u64;
            }
            for piece in masker.feed(&part, &self.redactor, false) {
                self.text_piece(writer, piece, root, inspect, &mut previous)?;
            }
            if writer.position() / 1048576 > writer.offset / 1048576 {
                writer.flush()?;
                self.publish("running");
            }
        }
        if !complete {
            masker.mark_incomplete();
            self.rules.reasons.insert("incomplete_body_fragment");
        }
        for piece in masker.feed("", &self.redactor, true) {
            self.text_piece(writer, piece, root, inspect, &mut previous)?;
        }
        Ok(())
    }
    fn text_piece(
        &mut self,
        writer: &mut BodyWriter,
        piece: TextPiece,
        root: &str,
        inspect: bool,
        previous: &mut String,
    ) -> Result<()> {
        let before = self.rules.findings.len();
        let start = writer.position();
        let stage = if root == "request" {
            "request_content"
        } else {
            "response_content"
        };
        if inspect {
            let window = format!("{previous}{}", piece.text);
            self.rules.content(&window, stage, root);
            self.rules.annotations(&piece.marks, stage, root);
            *previous = tail(&window, 1024).into();
        }
        for mark in &piece.marks {
            writer.mark(
                text(&mark["reason"]),
                start + mark["start"].as_u64().unwrap_or(0),
                start + mark["end"].as_u64().unwrap_or(piece.text.len() as u64),
            );
        }
        writer.push(&piece.text)?;
        let hit = piece
            .marks
            .iter()
            .find(|mark| credential_mark(mark))
            .map(|mark| {
                (
                    start + mark["start"].as_u64().unwrap_or(0),
                    start + mark["end"].as_u64().unwrap_or(0),
                )
            });
        self.findings(
            before,
            root,
            (start, writer.position()),
            stage,
            Hits {
                credential: hit,
                ..Hits::default()
            },
        );
        Ok(())
    }
}

// Where each kind of match was found, so every finding can reference its own range
// instead of the whole processing window.
#[derive(Clone, Copy, Default)]
pub(super) struct Hits {
    pub credential: Option<(u64, u64)>,
    pub internal: Option<(u64, u64)>,
    pub public: Option<(u64, u64)>,
}

fn credential_mark(mark: &Value) -> bool {
    let reason = text(&mark["reason"]);
    !crate::security::capture::annotation_only(reason)
        && !matches!(
            reason,
            "redaction_buffer_budget"
                | "url_authority_uncertain"
                | "credential_prefix_uncertain"
                | "incomplete_body_fragment"
        )
}

pub struct BodyWriter {
    store: Arc<Store>,
    audit: String,
    id: String,
    source: String,
    buffer: String,
    marks: Vec<Value>,
    pub offset: u64,
    failed: bool,
}
impl BodyWriter {
    pub fn new(store: Arc<Store>, audit: &str, id: &str, source: &str) -> Result<Self> {
        if !store.body(audit,json!({"id":id,"source":source,"root":id,"format":"text","contentMode":"original","state":"receiving","byteLength":0,"capturedAt":crate::config::now()})){bail!("body_storage_unavailable");}
        Ok(Self {
            store,
            audit: audit.into(),
            id: id.into(),
            source: source.into(),
            buffer: String::with_capacity(PAGE),
            marks: Vec::new(),
            offset: 0,
            failed: false,
        })
    }
    pub fn position(&self) -> u64 {
        self.offset + self.buffer.len() as u64
    }
    pub fn push(&mut self, text: &str) -> Result<()> {
        let mut rest = text;
        while !rest.is_empty() {
            let mut n = rest.len().min(PAGE - self.buffer.len());
            while !rest.is_char_boundary(n) {
                n -= 1;
            }
            if n == 0 {
                self.flush()?;
                continue;
            }
            self.buffer.push_str(&rest[..n]);
            rest = &rest[n..];
            if self.buffer.len() >= PAGE - 4 {
                self.flush()?;
            }
        }
        Ok(())
    }
    pub(super) fn mark(&mut self, reason: &str, start: u64, end: u64) {
        if start < end {
            let kind = if credential_mark(&json!({"reason":reason})) {
                "sensitive"
            } else {
                "coverage"
            };
            self.marks.push(
                json!({"kind":kind,"reason":reason,"start":start,"end":end,"unit":"utf8_bytes"}),
            );
        }
    }
    pub fn flush(&mut self) -> Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let to = self.position();
        let content = std::mem::take(&mut self.buffer);
        let marks: Vec<_> = self
            .marks
            .iter()
            .filter(|m| {
                m["start"].as_u64().unwrap_or(0) < to
                    && m["end"].as_u64().unwrap_or(0) > self.offset
            })
            .cloned()
            .collect();
        self.marks.retain(|m| m["end"].as_u64().unwrap_or(0) > to);
        if !self.store.body(
            &self.audit,
            json!({"id":self.id,"start":self.offset,"end":to,"content":content,"annotations":marks}),
        ) {
            self.failed = true;
            bail!("body_storage_budget_or_failure");
        }
        self.offset = to;
        Ok(())
    }
    pub fn finish(&mut self, state: &str, observed: u64) -> Result<()> {
        let result = self.flush();
        let state = if self.failed { "gap" } else { state };
        if !self.store.body(&self.audit,json!({"id":self.id,"source":self.source,"root":self.id,"format":"text","contentMode":"original","state":state,"byteLength":self.offset,"observedBytes":observed,"capturedAt":crate::config::now()})){bail!("body_manifest_storage_failure");}
        result
    }
}

struct Frame {
    path: String,
    field: String,
    kind: u8,
    start: u64,
    credential: bool,
    stage: String,
    tools: bool,
    meta: Value,
    input: Option<Node>,
    input_start: u64,
    input_end: u64,
    text: Option<StreamText>,
    previous: String,
    instruction_bits: u8,
    _meta_memory: Reservation,
}
struct BodyVisitor<'a> {
    pipeline: &'a mut Pipeline,
    writer: &'a mut BodyWriter,
    spool: Arc<Spool>,
    frames: Vec<Frame>,
    inspect: bool,
    root: String,
    last_progress: u64,
    navigation: super::session::Capture,
}
fn index_at(spool: &Arc<Spool>, at: u64) -> Result<Index> {
    let mut reader = spool.reader();
    reader.seek(SeekFrom::Start(at))?;
    let mut stream = JsonStream::new(reader);
    stream.at = at;
    let mut index = Index::new();
    stream.one(&mut index, "node")?;
    Ok(index)
}
impl BodyVisitor<'_> {
    fn pieces(&mut self, pieces: Vec<TextPiece>) -> Result<()> {
        for piece in pieces {
            let frame = self.frames.last_mut().unwrap();
            let before = self.pipeline.rules.findings.len();
            if self.inspect {
                let window = format!("{}{}", frame.previous, piece.text);
                self.pipeline
                    .rules
                    .content(&window, &frame.stage, &frame.path);
                frame.instruction_bits |= super::rules::instruction_bits(&window);
                self.pipeline
                    .rules
                    .instruction(frame.instruction_bits, &frame.stage, &frame.path);
                frame.previous = tail(&window, 1024).into();
                self.pipeline
                    .rules
                    .annotations(&piece.marks, &frame.stage, &frame.path);
            }
            let start = self.writer.position();
            let mut credential_hit = None;
            let mut internal_hit = None;
            let mut public_hit = None;
            let escaped = serde_json::to_string(&piece.text)?;
            for mark in &piece.marks {
                let byte = |at: u64| {
                    let mut at = (at as usize).min(piece.text.len());
                    while !piece.text.is_char_boundary(at) {
                        at -= 1;
                    }
                    serde_json::to_string(&piece.text[..at]).unwrap().len() - 2
                };
                let from = start + byte(mark["start"].as_u64().unwrap_or(0)) as u64;
                let to =
                    start + byte(mark["end"].as_u64().unwrap_or(piece.text.len() as u64)) as u64;
                self.writer.mark(text(&mark["reason"]), from, to);
                if credential_hit.is_none() && credential_mark(mark) && from < to {
                    credential_hit = Some((from, to));
                }
                if from < to {
                    let slot = match text(&mark["reason"]) {
                        "public_host" => &mut public_hit,
                        "internal_host" | "internal_identity" => &mut internal_hit,
                        _ => continue,
                    };
                    if slot.is_none() {
                        *slot = Some((from, to));
                    }
                }
            }
            self.writer.push(&escaped[1..escaped.len() - 1])?;
            let end = self.writer.position();
            if self.inspect {
                self.pipeline.findings(
                    before,
                    &self.root,
                    (start, end),
                    &frame.stage,
                    Hits {
                        credential: credential_hit,
                        internal: internal_hit,
                        public: public_hit,
                    },
                );
            }
            if self.writer.position() - self.last_progress >= 1024 * 1024 {
                self.writer.flush()?;
                self.pipeline.publish("running");
                self.last_progress = self.writer.position();
            }
        }
        Ok(())
    }
}
impl Visitor for BodyVisitor<'_> {
    fn start(&mut self, path: &str, field: &str, kind: u8, at: u64) -> Result<()> {
        self.navigation.start(field, kind);
        let parent = self.frames.last();
        let credential =
            kind != b'k' && (credential_field(field) || parent.is_some_and(|p| p.credential));
        let tools = parent.map(|p| p.tools).unwrap_or(self.root != "request")
            || self.root == "request"
                && self.frames.len() == 1
                && matches!(field, "input" | "messages");
        let (meta, meta_memory) = if kind == b'{' && tools {
            let index = index_at(&self.spool, at)?;
            (index.values, index.memory)
        } else {
            (json!({}), Reservation::memory())
        };
        let inherited = parent.map(|p| p.stage.clone()).unwrap_or_else(|| {
            if self.root == "request" {
                "request_content".into()
            } else {
                "response_content".into()
            }
        });
        let stage = if tools {
            match text(&meta["type"]) {
                "function_call" | "custom_tool_call" | "tool_use" => {
                    if self.root == "request" {
                        "tool_call_replayed"
                    } else {
                        "tool_call_proposed"
                    }
                }
                "function_call_output" | "custom_tool_call_output" | "tool_result" => {
                    "tool_result_reported"
                }
                _ => &inherited,
            }
        } else {
            &inherited
        }
        .to_owned();
        let start = self.writer.position();
        if kind == b'"' || kind == b'k' {
            self.writer.push("\"")?;
        }
        let tools = tools
            && !matches!(
                stage.as_str(),
                "tool_call_replayed" | "tool_call_proposed" | "tool_result_reported"
            );
        self.frames.push(Frame {
            path: path.into(),
            field: field.into(),
            kind,
            start,
            credential,
            stage,
            tools,
            meta,
            input: None,
            input_start: 0,
            input_end: 0,
            text: if kind == b'"' || kind == b'k' {
                Some(StreamText::new(credential)?)
            } else {
                None
            },
            previous: String::new(),
            instruction_bits: 0,
            _meta_memory: meta_memory,
        });
        Ok(())
    }
    fn text(&mut self, s: &str) -> Result<()> {
        self.navigation.text(s);
        if self.pipeline.count_progress {
            self.pipeline.inspected += s.len() as u64;
        }
        let frame = self.frames.last_mut().unwrap();
        let pieces = frame
            .text
            .as_mut()
            .unwrap()
            .feed(s, &self.pipeline.redactor, false);
        self.pieces(pieces)
    }
    fn scalar(&mut self, s: &str) -> Result<()> {
        let frame = self.frames.last().unwrap();
        let before = self.pipeline.rules.findings.len();
        let start = self.writer.position();
        let end = start + s.len() as u64;
        // JSON null means the credential is absent, but must still be retained.
        let credential = frame.credential && s != "null";
        let hit = credential.then_some((start, end));
        if credential {
            self.writer.mark("credential_field", start, end);
            if self.inspect {
                self.pipeline
                    .rules
                    .credential(&frame.stage, &frame.path, true);
            }
        }
        self.writer.push(s)?;
        if self.inspect {
            self.pipeline.findings(
                before,
                &self.root,
                (start, end),
                &frame.stage,
                Hits {
                    credential: hit,
                    ..Hits::default()
                },
            );
        }
        Ok(())
    }
    fn punctuation(&mut self, s: &str) -> Result<()> {
        self.writer.push(s)
    }
    fn end(&mut self, node: &Node) -> Result<()> {
        let incomplete_payload = self.pipeline.incomplete
            && matches!(
                self.frames.last().unwrap().field.as_str(),
                "arguments" | "input" | "text" | "thinking"
            );
        if let Some(text) = self.frames.last_mut().unwrap().text.as_mut() {
            if incomplete_payload {
                text.mark_incomplete();
            }
            let pieces = text.feed("", &self.pipeline.redactor, true);
            self.pieces(pieces)?;
        }
        self.navigation.end(&mut self.pipeline.record, &self.root);
        let frame = self.frames.pop().unwrap();
        if (self.root == "response" || self.root.starts_with("stream/"))
            && matches!(
                text(&frame.meta["type"]),
                "function_call" | "custom_tool_call" | "tool_use"
            )
        {
            let name: String = text(&frame.meta["name"]).chars().take(80).collect();
            if !name.is_empty() {
                if !self.pipeline.record["toolNames"].is_array() {
                    self.pipeline.record["toolNames"] = json!([]);
                }
                let names = self.pipeline.record["toolNames"].as_array_mut().unwrap();
                if names.len() < 12 && !names.contains(&json!(name)) {
                    names.push(json!(name));
                }
            }
        }
        if frame.kind == b'"' || frame.kind == b'k' {
            self.writer.push("\"")?;
        }
        let end = self.writer.position();
        if let Some(parent) = self.frames.last_mut() {
            if matches!(frame.field.as_str(), "arguments" | "input") && frame.kind != b'k' {
                parent.input = Some(node.clone());
                parent.input_start = frame.start;
                parent.input_end = end;
            }
        }
        if self.inspect
            && self.pipeline.inspect_tools
            && matches!(
                text(&frame.meta["type"]),
                "function_call" | "custom_tool_call" | "tool_use"
            )
        {
            if let Some(input) = &frame.input {
                let mut memory = Reservation::memory();
                let parsed = tool_input(
                    &self.spool,
                    input,
                    frame.meta["type"] == "function_call",
                    &mut memory,
                );
                match parsed {
                    Ok((parsed, version)) => {
                        let before = self.pipeline.rules.findings.len();
                        self.pipeline.rules.tool(
                            text(&frame.meta["name"]),
                            &parsed,
                            &frame.stage,
                            self.pipeline
                                .tool_location
                                .as_deref()
                                .unwrap_or(&frame.path),
                            version,
                        );
                        if before < self.pipeline.rules.findings.len() {
                            let id = format!("evidence/{}", uuid::Uuid::new_v4());
                            let mut content = Spool::new()?;
                            serde_json::to_writer(&mut content, &parsed)?;
                            let content = content.seal()?;
                            let mut evidence = BodyWriter::new(
                                self.pipeline.store.clone(),
                                text(&self.pipeline.record["id"]),
                                &id,
                                if self.root.starts_with("stream/") {
                                    "stream_inspection"
                                } else {
                                    "tool_inspection"
                                },
                            )?;
                            // Keep the semantic arguments and their sensitive ranges in the
                            // immutable evidence snapshot, with a link to the full parameters.
                            self.pipeline
                                .render_json(&mut evidence, content, &id, false)?;
                            let length = evidence.position();
                            evidence.finish("complete", input.end - input.start)?;
                            for finding in &mut self.pipeline.rules.findings[before..] {
                                finding["requestId"] = self.pipeline.record["id"].clone();
                                finding["evidence"]["bodyRef"] = json!({"snapshotId":id,"start":0,"end":length,"unit":"utf8_bytes","sourceSnapshotId":self.root,"sourceStart":frame.input_start,"sourceEnd":frame.input_end});
                            }
                        }
                    }
                    Err(error) => {
                        self.pipeline.rules.reasons.insert(
                            if error.to_string().contains("shared_resource_budget") {
                                "shared_working_memory_budget"
                            } else {
                                "invalid_tool_arguments"
                            },
                        );
                    }
                }
            }
        }
        if frame.field == "usage" && frame.kind == b'{' {
            let mut memory = Reservation::memory();
            if let Ok(value) = node.read(&self.spool, &mut memory) {
                for key in [
                    "input_tokens",
                    "output_tokens",
                    "total_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                ] {
                    if let Some(n) = value[key].as_u64() {
                        self.pipeline.record["usage"][key] = json!(n);
                    }
                }
            }
        }
        if frame.field == "previous_response_id" && frame.kind != b'k' && frame.kind != b'n' {
            self.pipeline
                .rules
                .reasons
                .insert("historical_context_not_visible");
        }
        if self.inspect
            && matches!(
                text(&frame.meta["type"]),
                "image"
                    | "input_image"
                    | "input_file"
                    | "document"
                    | "input_audio"
                    | "reasoning"
                    | "thinking"
                    | "redacted_thinking"
            )
        {
            self.pipeline
                .rules
                .reasons
                .insert("non_text_or_reasoning_semantics");
        }
        Ok(())
    }
}

fn tool_input(
    source: &Arc<Spool>,
    node: &Node,
    encoded: bool,
    memory: &mut Reservation,
) -> Result<(Value, [u8; 32])> {
    let decoded = if encoded {
        Some(crate::streaming::decoded(source, node)?)
    } else {
        None
    };
    let source = decoded.as_ref().unwrap_or(source);
    let root = if encoded {
        let mut reader = source.reader();
        let mut first = [0];
        loop {
            if reader.read(&mut first)? == 0 {
                bail!("invalid_tool_arguments");
            }
            if !first[0].is_ascii_whitespace() {
                break;
            }
        }
        Node {
            start: 0,
            end: source.len,
            kind: first[0],
        }
    } else {
        node.clone()
    };
    // Fingerprint the full observed arguments, including fields that semantic
    // rules do not read. Repeated final events share a version; edits do not.
    let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
    let mut reader = source.reader();
    reader.seek(SeekFrom::Start(root.start))?;
    let mut reader = reader.take(root.end - root.start);
    let mut buffer = [0; PAGE];
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    let mut version = [0; 32];
    version.copy_from_slice(digest.finish().as_ref());
    if root.kind != b'{' {
        return Ok((root.read(source, memory)?, version));
    }
    let index = crate::streaming::index(source, if encoded { None } else { Some(&root) })?;
    let mut result = json!({});
    for (_, field, node) in &index.nodes {
        if matches!(
            field.as_str(),
            "cmd" | "command" | "file_path" | "path" | "filePath" | "patch" | "input"
        ) {
            result[field] = node.read(source, memory)?;
        }
    }
    Ok((result, version))
}

struct Credentials<'a> {
    redactor: &'a mut Redactor,
    stack: Vec<CredentialFrame>,
    depth: usize,
}
impl Drop for Credentials<'_> {
    fn drop(&mut self) {
        // A credential string cut off at EOF still must be learned before replaying
        // earlier fields that may echo it. The incomplete tail is never stored raw.
        for frame in &self.stack {
            if frame.forced && !frame.value.is_empty() {
                self.redactor.credential(&frame.value);
            }
        }
    }
}
struct CredentialFrame {
    forced: bool,
    value: String,
    memory: Reservation,
    nested: Option<Spool>,
    decided: bool,
}
impl Visitor for Credentials<'_> {
    fn start(&mut self, _path: &str, field: &str, kind: u8, _at: u64) -> Result<()> {
        let forced = kind != b'k'
            && (credential_field(field) || self.stack.last().is_some_and(|v| v.forced));
        self.stack.push(CredentialFrame {
            forced,
            value: String::new(),
            memory: Reservation::memory(),
            nested: None,
            decided: false,
        });
        Ok(())
    }
    fn text(&mut self, s: &str) -> Result<()> {
        let frame = self.stack.last_mut().unwrap();
        if frame.forced {
            if frame.memory.grow(s.len() * 2).is_err() {
                self.redactor.unavailable();
            } else {
                frame.value.push_str(s);
            }
        } else {
            if !frame.decided && !s.trim().is_empty() {
                frame.decided = true;
                if s.trim_start().starts_with(['{', '[']) {
                    frame.nested = Spool::new().ok();
                    if frame.nested.is_none() {
                        self.redactor.unavailable();
                    }
                }
            }
            if let Some(n) = &mut frame.nested {
                if n.write_all(s.as_bytes()).is_err() {
                    self.redactor.unavailable();
                    frame.nested = None;
                }
            }
        }
        Ok(())
    }
    fn end(&mut self, _node: &Node) -> Result<()> {
        let frame = self.stack.pop().unwrap();
        if frame.forced && !frame.value.is_empty() {
            self.redactor.credential(&frame.value);
        }
        if let Some(nested) = frame.nested {
            if let Ok(nested) = nested.seal() {
                if self.depth < 32 {
                    let _ = JsonStream::new(nested.reader()).parse(
                        &mut Credentials {
                            redactor: self.redactor,
                            stack: Vec::new(),
                            depth: self.depth + 1,
                        },
                        "nested",
                    );
                } else {
                    self.redactor.unavailable();
                }
            } else {
                self.redactor.unavailable();
            }
        }
        Ok(())
    }
}
pub(super) fn learn_credentials(spool: &Arc<Spool>, redactor: &mut Redactor) -> bool {
    JsonStream::new(spool.reader())
        .parse(
            &mut Credentials {
                redactor,
                stack: Vec::new(),
                depth: 0,
            },
            "body",
        )
        .is_ok()
}
fn tail(value: &str, count: usize) -> &str {
    let mut at = value.len().saturating_sub(count);
    while !value.is_char_boundary(at) {
        at += 1;
    }
    &value[at..]
}

pub(super) struct Utf8Reader<R: Read> {
    reader: R,
    pending: Vec<u8>,
}
impl<R: Read> Utf8Reader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            pending: Vec::new(),
        }
    }
    pub fn next(&mut self) -> Result<Option<String>> {
        let mut buffer = [0; PAGE];
        let n = self.reader.read(&mut buffer)?;
        self.pending.extend_from_slice(&buffer[..n]);
        if self.pending.is_empty() {
            return Ok(None);
        }
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(e) if e.error_len().is_none() && n > 0 => e.valid_up_to(),
            Err(_) => bail!("unsupported_content_encoding"),
        };
        let text = std::str::from_utf8(&self.pending[..valid])?.to_owned();
        self.pending.drain(..valid);
        Ok(Some(text))
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run(
    store: Arc<Store>,
    record: Value,
    secrets: Value,
    redactor: Redactor,
    mut request: super::BodyCapture,
    mut response: super::BodyCapture,
    sse: bool,
    upstream: bool,
) {
    let mut p = Pipeline::new(store, record, &secrets, redactor);
    p.record["usage"] = json!({});
    p.redactor.observe(&request.headers);
    p.redactor.observe(&response.headers);
    if let Some(spool) = &request.sealed {
        learn_credentials(spool, &mut p.redactor);
    }
    if !sse {
        if let Some(spool) = &response.sealed {
            learn_credentials(spool, &mut p.redactor);
        }
    }
    super::limit_labels(&mut p.record);
    if !p.record["captureGap"].is_null() {
        p.rules.reasons.insert("shared_encrypted_spool_budget");
    }
    p.publish("running");
    for (id, body, source) in [
        ("request", &mut request, "client_request"),
        (
            "response",
            &mut response,
            if upstream {
                "upstream_response"
            } else {
                "gateway_response"
            },
        ),
    ] {
        // Headers are a separate lazy snapshot; routine authentication is not a content leak.
        let header_id = format!("{id}/headers");
        let header = (|| -> Result<Arc<Spool>> {
            let mut spool = Spool::new()?;
            serde_json::to_writer(&mut spool, &body.headers)?;
            Ok(spool.seal()?)
        })();
        let result =
            header.and_then(|spool| p.body(&header_id, "observed_headers", spool, true, false));
        if result.is_err() {
            p.failed = true;
            p.rules
                .reasons
                .insert("header_storage_or_processing_failure");
        }
        if body.gap {
            p.rules.reasons.insert("shared_encrypted_spool_budget");
            if !p.record["coverageGaps"].is_array() {
                p.record["coverageGaps"] = json!([]);
            }
            p.record["coverageGaps"].as_array_mut().unwrap().push(json!({"snapshotId":id,"reason":"shared_encrypted_spool_budget","observedBytes":body.observed,"retainedForProcessingBytes":body.sealed.as_ref().map_or(0,|s|s.len)}));
        }
        if let Some(spool) = body.sealed.take() {
            let result = if id == "response" && sse {
                super::sse::inspect(&mut p, spool, body.gap)
            } else {
                p.body(id, source, spool, body.complete && !body.gap, true)
            };
            if let Err(error) = result {
                p.failed = true;
                p.rules.reasons.insert("body_storage_or_processing_failure");
                if error.to_string().contains("shared_resource_budget") {
                    p.rules.reasons.insert("shared_working_memory_budget");
                }
            }
        } else {
            p.record[format!("{id}BodyState")] =
                json!(if body.gap { "gap" } else { "not_observed" });
            if body.gap {
                p.failed = true;
            }
        }
        if !body.complete && body.started && p.record[format!("{id}BodyState")] != "complete" {
            p.rules.reasons.insert("body_not_complete");
        }
    }
    p.publish("complete");
}
