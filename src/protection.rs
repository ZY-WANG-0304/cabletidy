//! Reversible credential substitution on the transport path. Audit keeps A.
use crate::{
    config,
    security::{
        capture::{credential_field, Redactor},
        session,
    },
    streaming::{self, Edits, JsonStream, Node, Reservation, Spool, Visitor},
};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    io::{Read, Write},
    sync::{Arc, Mutex},
};

pub(crate) const PREFIX: &str = "CTSEC_v1_";
type ProtectionSpan = (usize, usize, String);
type DisplayHit = (String, Vec<ProtectionSpan>);
fn now() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

struct Mapping {
    original: String,
    replacement: String,
    created: u64,

    _memory: Reservation,
}
struct Session {
    mappings: Vec<Arc<Mapping>>,
    last_request: u64,
    ttl: u64,
    _memory: Reservation,
}
#[derive(Default)]
pub(crate) struct Registry {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Default)]
struct Frame {
    value: String,
    forced: bool,
    kind: u8,
    opaque: bool,
    field: String,
    contains_credential: bool,
    memory: Option<Reservation>,
}
struct Scan<'a> {
    stack: Vec<Frame>,
    redactor: &'a mut Redactor,
    found: BTreeSet<String>,
    identity: session::Capture,
    record: Value,
    memory: Reservation,
}
fn nested_credentials(
    value: &Value,
    redactor: &Redactor,
    found: &mut BTreeSet<String>,
    forced: bool,
    depth: usize,
) -> Result<()> {
    if depth > 32 {
        bail!("protection_nested_json_limit");
    }
    match value {
        Value::String(s) => {
            for (a, b) in redactor.protection_ranges(s, forced) {
                found.insert(s[a..b].to_owned());
            }
            if s.trim_start().starts_with(['{', '[']) {
                if let Ok(v) = serde_json::from_str::<Value>(s) {
                    nested_credentials(&v, redactor, found, false, depth + 1)?;
                }
            }
        }
        Value::Object(m) => {
            for (key, v) in m {
                if !redactor.protection_ranges(key, false).is_empty() {
                    bail!("protection_credential_in_key");
                }
                nested_credentials(
                    v,
                    redactor,
                    found,
                    forced || credential_field(key),
                    depth + 1,
                )?;
            }
        }
        Value::Array(a) => {
            for v in a {
                nested_credentials(v, redactor, found, forced, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
impl Visitor for Scan<'_> {
    fn start(&mut self, _: &str, field: &str, kind: u8, _: u64) -> Result<()> {
        self.identity.start(field, kind);
        self.stack.push(Frame {
            forced: kind != b'k'
                && (credential_field(field) || self.stack.last().is_some_and(|f| f.forced)),
            opaque: self.stack.last().is_some_and(|f| f.opaque)
                || matches!(
                    field,
                    "thinking" | "signature" | "encrypted_content" | "redacted_thinking"
                ),
            kind,
            field: field.to_owned(),
            memory: Some(Reservation::memory()),
            ..Frame::default()
        });
        Ok(())
    }
    fn text(&mut self, s: &str) -> Result<()> {
        self.identity.text(s);
        let f = self.stack.last_mut().unwrap();
        f.memory
            .as_mut()
            .unwrap()
            .grow(s.len().saturating_mul(12))?;
        f.value.push_str(s);
        Ok(())
    }
    fn scalar(&mut self, value: &str) -> Result<()> {
        if value != "null" && self.stack.last().is_some_and(|f| f.forced) {
            bail!("protection_non_string_credential");
        }
        Ok(())
    }
    fn end(&mut self, _: &Node) -> Result<()> {
        self.identity.end(&mut self.record, "request");
        let f = self.stack.pop().unwrap();
        if f.field == "type" && matches!(f.value.as_str(), "thinking" | "redacted_thinking") {
            if let Some(parent) = self.stack.last_mut() {
                parent.opaque = true;
            }
        }
        if f.kind != b'"' && f.kind != b'k' {
            if f.opaque && f.contains_credential {
                bail!("protection_signed_or_opaque_content");
            }
            if f.contains_credential {
                if let Some(parent) = self.stack.last_mut() {
                    parent.contains_credential = true;
                }
            }
            return Ok(());
        }
        let mut found = BTreeSet::new();
        nested_credentials(&json!(f.value), self.redactor, &mut found, f.forced, 0)?;
        if f.kind == b'k' && !found.is_empty() {
            bail!("protection_credential_in_key");
        }
        if f.opaque && !found.is_empty() {
            bail!("protection_signed_or_opaque_content");
        }
        if !found.is_empty() {
            if let Some(parent) = self.stack.last_mut() {
                parent.contains_credential = true;
            }
        }
        // Learn every complete recognized value before the replacement pass.
        for s in found {
            self.redactor.credential(&s);
            if !self.found.contains(&s) {
                self.memory
                    .grow(s.len().saturating_mul(4).saturating_add(128))?;
            }
            self.found.insert(s);
        }
        if !self.redactor.available() {
            bail!("protection_credential_budget");
        }
        Ok(())
    }
}

pub(crate) struct Request {
    mappings: Vec<Arc<Mapping>>,
    pub report: Value,
    memory: Reservation,
    redactor: Redactor,
}
impl Registry {
    pub fn touch(&self, record: &Value, ttl: u64) {
        let at = now();
        if let Some(session) = self
            .sessions
            .lock()
            .unwrap()
            .get_mut(config::text(&record["sessionKey"]))
        {
            if session
                .last_request
                .saturating_add(session.ttl.saturating_mul(1000))
                > at
            {
                session.last_request = at;
                session.ttl = ttl;
            }
        }
    }
    pub fn expire(&self) {
        let at = now();
        self.sessions.lock().unwrap().retain(|_, session| {
            session
                .last_request
                .saturating_add(session.ttl.saturating_mul(1000))
                > at
        });
    }
    pub fn prepare(
        &self,
        source: &Arc<Spool>,
        secrets: &Value,
        record: Value,
        ttl: u64,
    ) -> Result<Request> {
        self.prepare_at(source, secrets, record, ttl, now())
    }
    fn prepare_at(
        &self,
        source: &Arc<Spool>,
        secrets: &Value,
        record: Value,
        ttl: u64,
        at: u64,
    ) -> Result<Request> {
        let mut redactor = Redactor::new(secrets);
        let mut scan = Scan {
            stack: Vec::new(),
            redactor: &mut redactor,
            found: BTreeSet::new(),
            identity: session::Capture::default(),
            record,
            memory: Reservation::memory(),
        };
        JsonStream::new(source.reader()).parse(&mut scan, "request")?;
        let scope = config::text(&scan.record["sessionKey"]);
        let scope = if scope.is_empty() {
            config::text(&scan.record["id"]).to_owned()
        } else {
            scope.to_owned()
        };
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, session| {
            session
                .last_request
                .saturating_add(session.ttl.saturating_mul(1000))
                > at
        });
        if !sessions.contains_key(&scope) {
            let mut memory = Reservation::memory();
            memory.grow(scope.len().saturating_mul(2).saturating_add(512))?;
            sessions.insert(
                scope.clone(),
                Session {
                    mappings: Vec::new(),
                    last_request: at,
                    ttl,
                    _memory: memory,
                },
            );
        }
        let session = sessions.get_mut(&scope).unwrap();
        session.last_request = session.last_request.max(at);
        session.ttl = ttl;
        let Scan {
            record,
            found,
            memory,
            ..
        } = scan;
        // Seed values learned in earlier rounds, including tokens without a
        // recognizable prefix. Serializing this pass also prevents concurrent
        // same-session requests from creating conflicting mappings.
        for m in &session.mappings {
            redactor.credential(&m.original);
        }
        if !redactor.available() {
            bail!("protection_credential_budget");
        }
        // Scan again after learning credentials declared later in this request.
        let mut scan = Scan {
            stack: Vec::new(),
            redactor: &mut redactor,
            found,
            identity: session::Capture::default(),
            record,
            memory,
        };
        JsonStream::new(source.reader()).parse(&mut scan, "request")?;
        let entries = &mut session.mappings;
        let mut mappings = Vec::new();
        let mut rows = Vec::new();
        for original in scan.found {
            if original.starts_with(PREFIX) {
                continue;
            }
            let existing = entries.iter().find(|m| m.original == original).cloned();
            let reused = existing.is_some();
            let m = if let Some(m) = existing {
                m
            } else {
                let mut memory = Reservation::memory();
                memory.grow(
                    original
                        .len()
                        .saturating_mul(4)
                        .saturating_add(scope.len() + 512),
                )?;
                let m = Arc::new(Mapping {
                    original,
                    replacement: format!("{PREFIX}{}", uuid::Uuid::new_v4().simple()),
                    created: at,
                    _memory: memory,
                });
                entries.push(m.clone());
                m
            };
            rows.push(json!({"id":m.replacement,"original":m.original,"replacement":m.replacement,"createdAtMs":m.created,"expiresAtMs":at+ttl*1000,"reused":reused,"requestCount":0,"responseCount":0}));
            mappings.push(m);
        }
        // Responses may reference earlier server-side context. Keep all live
        // mappings from this session for restoration; never use a global lookup.
        let historical = entries.clone();
        drop(sessions);
        let mut request = Request {
            mappings,
            report: json!({"enabled":true,"status":"prepared","mappingTtlSeconds":ttl,"expiryMode":"session_idle","expiresAtMs":at+ttl*1000,"sessionId":scope,"requestCount":0,"responseCount":0,"mappings":rows}),
            memory: Reservation::memory(),
            redactor,
        };
        request
            .memory
            .grow(request.report.to_string().len().saturating_mul(12))?;
        for m in historical {
            if !request
                .mappings
                .iter()
                .any(|v| v.replacement == m.replacement)
            {
                request
                    .memory
                    .grow(m.original.len().saturating_mul(12).saturating_add(2048))?;
                request.report["mappings"].as_array_mut().unwrap().push(json!({"id":m.replacement,"original":m.original,"replacement":m.replacement,"createdAtMs":m.created,"expiresAtMs":at+ttl*1000,"reused":true,"requestCount":0,"responseCount":0}));
                request.mappings.push(m);
            }
        }
        Ok(request)
    }
}
fn contains(source: &Arc<Spool>, needle: &str) -> Result<bool> {
    if needle.is_empty() {
        return Ok(false);
    }
    let mut memory = Reservation::memory();
    memory.grow(streaming::PAGE + needle.len().saturating_mul(2))?;
    let mut reader = source.reader();
    let mut buffer = vec![0; streaming::PAGE];
    let mut tail = Vec::new();
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            return Ok(false);
        }
        tail.extend_from_slice(&buffer[..n]);
        if tail.windows(needle.len()).any(|s| s == needle.as_bytes()) {
            return Ok(true);
        }
        let keep = tail.len().saturating_sub(needle.len());
        tail.drain(..keep);
    }
}
fn restoration_depth(text: &str, at: usize, depth: usize) -> usize {
    if depth >= 4 || !text.trim_start().starts_with(['{', '[']) {
        return 0;
    }
    struct Locate {
        at: usize,
        found: Option<Node>,
    }
    impl Visitor for Locate {
        fn end(&mut self, n: &Node) -> Result<()> {
            if n.kind == b'"' && n.start < self.at as u64 && n.end > self.at as u64 {
                self.found = Some(n.clone());
            }
            Ok(())
        }
    }
    let mut visitor = Locate { at, found: None };
    if JsonStream::new(text.as_bytes())
        .parse(&mut visitor, "inner")
        .is_err()
    {
        return 0;
    }
    let Some(node) = visitor.found else {
        return 0;
    };
    let Ok(decoded) = serde_json::from_str::<String>(&text[node.start as usize..node.end as usize])
    else {
        return 0;
    };
    let prefix = format!("\"{}\"", &text[node.start as usize + 1..at]);
    let Ok(prefix) = serde_json::from_str::<String>(&prefix) else {
        return 1;
    };
    1 + restoration_depth(&decoded, prefix.len(), depth + 1)
}

impl Request {
    fn replace(&mut self, text: &str, restore: bool, field: &str, path: &str) -> Result<String> {
        self.replace_at(text, restore, field, path, 0)
    }
    fn replace_at(
        &mut self,
        text: &str,
        restore: bool,
        field: &str,
        path: &str,
        base: u64,
    ) -> Result<String> {
        let mut scratch = Reservation::memory();
        scratch.grow(text.len().saturating_mul(4))?;
        let mut candidates = Vec::new();
        for (i, m) in self.mappings.iter().enumerate() {
            let needle = if restore { &m.replacement } else { &m.original };
            for (start, _) in text.match_indices(needle) {
                scratch.grow(std::mem::size_of::<(usize, usize, usize)>() * 2)?;
                candidates.push((start, start + needle.len(), i));
            }
            // Inner JSON retains its escaping until decoded by the client/tool.
            for escaped in variants(needle).into_iter().skip(1) {
                for (start, _) in text.match_indices(&escaped) {
                    scratch.grow(std::mem::size_of::<(usize, usize, usize)>() * 2)?;
                    candidates.push((start, start + escaped.len(), i));
                }
            }
        }
        candidates.sort_by_key(|&(a, b, _)| (a, std::cmp::Reverse(b - a)));
        let mut out = String::new();
        let mut at = 0;
        for (a, b, i) in candidates {
            if a < at {
                continue;
            }
            let m = &self.mappings[i];
            out.push_str(&text[at..a]);
            let value = if restore { &m.original } else { &m.replacement };
            let depth = if restore && field == "partial_json" {
                1
            } else if restore {
                restoration_depth(text, a, 0)
            } else {
                0
            };
            let mut encoded = value.to_owned();
            for _ in 0..depth {
                let quoted = serde_json::to_string(&encoded)?;
                encoded = quoted[1..quoted.len() - 1].to_owned();
            }
            scratch.grow(encoded.len().saturating_mul(4))?;
            let output_start = out.len();
            out.push_str(&encoded);
            at = b;
            let counter = if restore {
                "responseCount"
            } else {
                "requestCount"
            };
            self.report[counter] = json!(self.report[counter].as_u64().unwrap_or(0) + 1);
            let row = &mut self.report["mappings"][i];
            row[counter] = json!(row[counter].as_u64().unwrap_or(0) + 1);
            let locations = row["locations"].as_array_mut();
            if locations.is_none() {
                row["locations"] = json!([]);
            }
            let locations = row["locations"].as_array_mut().unwrap();
            let location = json!({"side":if restore {"response"} else {"request"},"location":path,
                "start":base + if restore {output_start} else {a} as u64,
                "end":base + if restore {out.len()} else {b} as u64,"unit":"decoded_utf8_bytes"});
            if !locations.contains(&location) {
                self.memory
                    .grow(path.len().saturating_mul(8).saturating_add(512))?;
                locations.push(location);
            }
        }
        out.push_str(&text[at..]);
        Ok(out)
    }
    pub fn transform(&mut self, source: &Arc<Spool>, restore: bool) -> Result<Arc<Spool>> {
        self.transform_except(source, restore, &[])
    }
    fn transform_except(
        &mut self,
        source: &Arc<Spool>,
        restore: bool,
        skip: &[String],
    ) -> Result<Arc<Spool>> {
        struct Rewrite<'a> {
            request: &'a mut Request,
            restore: bool,
            stack: Vec<(String, String, String, Reservation, bool, bool)>,
            edits: Edits,
            skip: &'a [String],
        }
        impl Visitor for Rewrite<'_> {
            fn start(&mut self, path: &str, field: &str, _: u8, _: u64) -> Result<()> {
                self.stack.push((
                    path.into(),
                    field.into(),
                    String::new(),
                    Reservation::memory(),
                    self.stack.last().is_some_and(|f| f.4)
                        || matches!(
                            field,
                            "thinking" | "signature" | "encrypted_content" | "redacted_thinking"
                        ),
                    false,
                ));
                Ok(())
            }
            fn text(&mut self, s: &str) -> Result<()> {
                let f = self.stack.last_mut().unwrap();
                f.3.grow(s.len().saturating_mul(8))?;
                f.2.push_str(s);
                Ok(())
            }
            fn end(&mut self, node: &Node) -> Result<()> {
                let (path, field, text, _memory, opaque, matched) = self.stack.pop().unwrap();
                if field == "type" && matches!(text.as_str(), "thinking" | "redacted_thinking") {
                    if let Some(parent) = self.stack.last_mut() {
                        parent.4 = true;
                    }
                }
                let matched = matched
                    || self.restore
                        && self
                            .request
                            .mappings
                            .iter()
                            .any(|m| text.contains(&m.replacement));
                if matched {
                    if let Some(parent) = self.stack.last_mut() {
                        parent.5 = true;
                    }
                }
                if self.restore && opaque && matched {
                    bail!("protection_signed_or_opaque_response");
                }
                if matches!(node.kind, b'"' | b'k')
                    && !(self.restore && opaque)
                    && !self
                        .skip
                        .iter()
                        .any(|p| path == *p || path.starts_with(&format!("{p}/")))
                {
                    let transformed = self.request.replace(&text, self.restore, &field, &path)?;
                    if text != transformed {
                        if node.kind == b'k' {
                            bail!("protection_credential_in_key");
                        }
                        self.edits
                            .add(node.start, node.end, serde_json::to_vec(&transformed)?)?;
                    }
                }
                Ok(())
            }
        }
        let mut v = Rewrite {
            request: self,
            restore,
            stack: Vec::new(),
            edits: Edits::new(),
            skip,
        };
        JsonStream::new(source.reader())
            .parse(&mut v, if restore { "response" } else { "request" })?;
        v.edits.ranges.sort_by_key(|r| r.0);
        let mut out = Spool::new()?;
        std::io::copy(&mut v.edits.reader(source), &mut out)?;
        out.seal().map_err(Into::into)
    }
    pub fn restore_text(&mut self, source: &Arc<Spool>) -> Result<Arc<Spool>> {
        let mut memory = Reservation::memory();
        memory.grow((source.len as usize).saturating_mul(12))?;
        let mut text = String::new();
        source.reader().read_to_string(&mut text)?;
        let restored = self.replace(&text, true, "text", "response")?;
        let mut output = Spool::new()?;
        output.write_all(restored.as_bytes())?;
        Ok(output.seal()?)
    }
    pub fn check_outbound(&self, source: &Arc<Spool>) -> Result<()> {
        for m in &self.mappings {
            for original in variants(&m.original) {
                if contains(source, &original)? {
                    bail!("protection_verification_failed");
                }
            }
        }
        Ok(())
    }
    pub fn safe_parameter(&self, value: &str) -> bool {
        let mut decoded = value.to_owned();
        for _ in 0..4 {
            if !self.redactor.protection_ranges(&decoded, false).is_empty()
                || self.mappings.iter().any(|m| decoded.contains(&m.original))
                || decoded.contains(PREFIX)
            {
                return false;
            }
            let mut out = Vec::new();
            let bytes = decoded.as_bytes();
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'%' && i + 2 < bytes.len() {
                    let hex = |b: u8| (b as char).to_digit(16);
                    if let (Some(a), Some(b)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                        out.push((a * 16 + b) as u8);
                        i += 3;
                        continue;
                    }
                }
                out.push(bytes[i]);
                i += 1;
            }
            let next = String::from_utf8_lossy(&out).into_owned();
            if next == decoded {
                break;
            }
            decoded = next;
        }
        true
    }
}

/// Buffer only a potential placeholder suffix, independently for each SSE item.
#[derive(Default)]
pub(crate) struct Restorer {
    pending: BTreeMap<String, String>,
    memory: Option<Reservation>,
    emitted: BTreeMap<String, u64>,
}
impl Restorer {
    pub fn delta(
        &mut self,
        request: &mut Request,
        key: &str,
        text: &str,
        field: &str,
    ) -> Result<String> {
        if !self.pending.contains_key(key) {
            self.memory
                .get_or_insert_with(Reservation::memory)
                .grow(key.len().saturating_mul(2).saturating_add(512))?;
        }
        let pending = self.pending.entry(key.into()).or_default();
        pending.push_str(text);
        let keep = (1..=pending.len().min(PREFIX.len() + 32))
            .rev()
            .find(|&n| {
                pending.is_char_boundary(pending.len() - n)
                    && request.mappings.iter().any(|m| {
                        m.replacement.starts_with(&pending[pending.len() - n..])
                            && n < m.replacement.len()
                    })
            })
            .unwrap_or(0);
        let split = pending.len() - keep;
        let ready = pending[..split].to_owned();
        *pending = pending[split..].to_owned();
        let base = self.emitted.entry(key.into()).or_default();
        let output = request.replace_at(&ready, true, field, key, *base)?;
        *base += output.len() as u64;
        Ok(output)
    }
    pub fn finish(&mut self, key: &str) -> String {
        self.emitted.remove(key);
        self.pending.remove(key).unwrap_or_default()
    }
    pub fn is_pending(&self) -> bool {
        self.pending.values().any(|s| !s.is_empty())
    }
}

#[cfg(test)]
fn spool_json(value: &Value) -> Result<Arc<Spool>> {
    let mut s = Spool::new()?;
    serde_json::to_writer(&mut s, value)?;
    Ok(s.seal()?)
}

pub(crate) struct Sse {
    restorer: Restorer,
}
impl Sse {
    pub fn new() -> Self {
        Self {
            restorer: Restorer::default(),
        }
    }
    pub fn event(
        &mut self,
        request: &mut Request,
        event: &Arc<Spool>,
        client: &str,
        mapped: &str,
        claude: bool,
    ) -> Result<Arc<Spool>> {
        let data = streaming::event_data(event)?;
        if data.payload.len == 0 {
            return Ok(event.clone());
        }
        let top = streaming::index(&data.payload, None)?;
        let kind = config::text(&top.values["type"]);
        let mut delta_edits = Edits::new();
        let mut skip = Vec::new();
        let mut memory = Reservation::memory();
        let key = if claude {
            format!("sse/content/{}", top.values["index"].as_u64().unwrap_or(0))
        } else {
            let output = top.values["output_index"].as_u64().unwrap_or(0);
            let channel = if kind.contains("reasoning_summary") {
                "summary"
            } else if kind.contains("refusal") {
                "refusal"
            } else {
                "text"
            };
            if kind.contains("function_call_arguments") || kind.contains("custom_tool_call_input") {
                format!("sse/output/{output}")
            } else {
                format!(
                    "sse/output/{output}/{channel}/{}",
                    top.values[if channel == "summary" {
                        "summary_index"
                    } else {
                        "content_index"
                    }]
                    .as_u64()
                    .unwrap_or(0)
                )
            }
        };
        if kind == "content_block_delta" {
            if let Some((_, _, n)) = top.nodes.iter().find(|(_, f, _)| f == "delta") {
                let delta = streaming::index(&data.payload, Some(n))?;
                for (_, field, node) in &delta.nodes {
                    if matches!(field.as_str(), "text" | "partial_json") {
                        if let Some((delta_path, _, _)) =
                            top.nodes.iter().find(|(_, f, _)| f == "delta")
                        {
                            skip.push(delta_path.replacen("node", "response", 1));
                        }
                        let value = node.read(&data.payload, &mut memory)?;
                        let text = config::text(&value);
                        let output = self.restorer.delta(request, &key, text, field)?;
                        delta_edits.add(node.start, node.end, serde_json::to_vec(&output)?)?;
                    }
                }
            }
        } else if matches!(
            kind,
            "response.output_text.delta"
                | "response.refusal.delta"
                | "response.function_call_arguments.delta"
                | "response.custom_tool_call_input.delta"
                | "response.reasoning_summary_text.delta"
        ) {
            if let Some((path, _, node)) = top.nodes.iter().find(|(_, f, _)| f == "delta") {
                skip.push(path.replacen("node", "response", 1));
                let value = node.read(&data.payload, &mut memory)?;
                let field = if kind == "response.function_call_arguments.delta" {
                    "partial_json"
                } else {
                    "text"
                };
                let output = self
                    .restorer
                    .delta(request, &key, config::text(&value), field)?;
                delta_edits.add(node.start, node.end, serde_json::to_vec(&output)?)?;
            }
        }
        if matches!(
            kind,
            "content_block_stop"
                | "response.output_text.done"
                | "response.function_call_arguments.done"
                | "response.custom_tool_call_input.done"
        ) && !self.restorer.finish(&key).is_empty()
        {
            bail!("protection_incomplete_placeholder");
        }
        if matches!(
            kind,
            "message_stop"
                | "response.completed"
                | "response.failed"
                | "response.incomplete"
                | "error"
        ) && self.restorer.is_pending()
        {
            bail!("protection_incomplete_placeholder");
        }
        delta_edits.ranges.sort_by_key(|r| r.0);
        let mut payload = Spool::new()?;
        std::io::copy(&mut delta_edits.reader(&data.payload), &mut payload)?;
        let payload = request.transform_except(&payload.seal()?, true, &skip)?;
        let model_edits = streaming::response_edits(&payload, client, mapped, claude)?;
        let mut output = Spool::new()?;
        std::io::copy(&mut data.fields.reader(), &mut output)?;
        output.write_all(b"data: ")?;
        std::io::copy(&mut model_edits.reader(&payload), &mut output)?;
        output.write_all(b"\n\n")?;
        Ok(output.seal()?)
    }
    pub fn finish(&self) -> Result<()> {
        if self.restorer.is_pending() {
            bail!("protection_incomplete_placeholder");
        }
        Ok(())
    }
}

pub(crate) fn report(db: &rusqlite::Connection, audit: &str) -> Result<Option<Value>> {
    use rusqlite::OptionalExtension;
    let len:Option<u64>=db.query_row("SELECT json_extract(data,'$.byteLength') FROM audit_snapshots WHERE audit_id=? AND id='protection'",rusqlite::params![audit],|r|r.get(0)).optional()?;
    let Some(len) = len else {
        return Ok(None);
    };
    let mut memory = Reservation::memory();
    memory.grow((len as usize).saturating_mul(12))?;
    let reader = crate::security::content::BodyReader {
        db,
        audit,
        snapshot: "protection",
        next: 0,
        limit: len,
        chunk: Vec::new(),
        position: 0,
    };
    Ok(Some(serde_json::from_reader(reader)?))
}
fn variants(original: &str) -> Vec<String> {
    let mut result = vec![original.to_owned()];
    for _ in 0..4 {
        let last = result.last().unwrap();
        let escaped = serde_json::to_string(last).unwrap();
        let escaped = escaped[1..escaped.len() - 1].to_owned();
        if result.contains(&escaped) {
            break;
        }
        result.push(escaped);
    }
    result
}
pub(crate) fn spans(
    rows: &Value,
    side: &str,
    path: &str,
    text: &str,
    base: u64,
) -> Vec<(usize, usize, String)> {
    let mut result = Vec::new();
    for row in config::array(&rows["mappings"]) {
        for loc in config::array(&row["locations"]) {
            if loc["side"] != side || loc["location"] != path {
                continue;
            }
            let (Some(start), Some(end)) = (loc["start"].as_u64(), loc["end"].as_u64()) else {
                continue;
            };
            let left = start.max(base).saturating_sub(base) as usize;
            let right = end.min(base + text.len() as u64).saturating_sub(base) as usize;
            if left < right && text.is_char_boundary(left) && text.is_char_boundary(right) {
                result.push((left, right, config::text(&row["id"]).to_owned()));
            }
        }
    }
    result
}
fn display_ranges(
    text: &str,
    original: &str,
    spans: &[(usize, usize, String)],
    encoded: bool,
) -> Vec<Value> {
    let value = if encoded {
        serde_json::to_string(original).unwrap()
    } else {
        original.to_owned()
    };
    let value = if encoded {
        &value[1..value.len() - 1]
    } else {
        &value
    };
    if value.is_empty() {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    for (at, _) in text.match_indices(value) {
        for (left, right, id) in spans {
            let offset = |n| {
                if encoded {
                    serde_json::to_string(&original[..n]).unwrap().len() - 2
                } else {
                    n
                }
            };
            let start = at + offset(*left);
            let end = at + offset(*right);
            ranges.push(json!({"start":text[..start].encode_utf16().count(),"end":text[..end].encode_utf16().count(),"mappingId":id,"unit":"utf16"}));
        }
    }
    ranges
}
pub(crate) fn annotate_page(
    db: &rusqlite::Connection,
    audit: &str,
    page: &mut Value,
    response: bool,
    cancelled: &dyn Fn() -> bool,
) -> Result<()> {
    if let Err(error) = annotate_page_inner(db, audit, page, response, cancelled) {
        if cancelled() {
            return Err(error);
        }
        // Optional highlight projection must not hide retained original content.
        page["protectionState"] = json!("unavailable");
        for item in page["items"].as_array_mut().into_iter().flatten() {
            item["protectionRanges"] = json!({"preview":[],"structure":[]});
        }
    }
    Ok(())
}
fn annotate_page_inner(
    db: &rusqlite::Connection,
    audit: &str,
    page: &mut Value,
    response: bool,
    cancelled: &dyn Fn() -> bool,
) -> Result<()> {
    let Some(rows) = report(db, audit)? else {
        return Ok(());
    };
    let side = if response { "response" } else { "request" };
    for item in page["items"].as_array_mut().into_iter().flatten() {
        if cancelled() {
            bail!("overview_cancelled");
        }
        let mut preview = Vec::new();
        let mut structure = Vec::new();
        // Resolve paths in retained original JSON. This avoids highlighting a
        // literal A returned by upstream merely because B was restored elsewhere.
        let raw = config::text(&item["structure"]);
        let mut memory = Reservation::memory();
        let mut source = String::new();
        if !response || config::array(&item["contentSnapshotIds"]).is_empty() {
            let start = item["start"].as_u64().unwrap_or(0);
            let end = item["end"].as_u64().unwrap_or(start);
            memory.grow((end.saturating_sub(start) as usize).saturating_mul(8))?;
            let reader = crate::security::content::BodyReader {
                db,
                audit,
                snapshot: if response { "response" } else { "request" },
                next: start,
                limit: end,
                chunk: Vec::new(),
                position: 0,
            };
            source = std::io::read_to_string(reader)?;
        }
        struct Display<'a> {
            rows: &'a Value,
            side: &'a str,
            stack: Vec<(String, String)>,
            hits: Vec<DisplayHit>,
        }
        impl Visitor for Display<'_> {
            fn start(&mut self, path: &str, _: &str, _: u8, _: u64) -> Result<()> {
                self.stack.push((path.to_owned(), String::new()));
                Ok(())
            }
            fn text(&mut self, s: &str) -> Result<()> {
                self.stack.last_mut().unwrap().1.push_str(s);
                Ok(())
            }
            fn end(&mut self, node: &Node) -> Result<()> {
                let (path, text) = self.stack.pop().unwrap();
                if node.kind == b'"' {
                    let found = spans(self.rows, self.side, &path, &text, 0);
                    if !found.is_empty() {
                        self.hits.push((text, found));
                    }
                }
                Ok(())
            }
        }
        memory.grow(source.len().saturating_mul(12))?;
        let mut visitor = Display {
            rows: &rows,
            side,
            stack: Vec::new(),
            hits: Vec::new(),
        };
        let path = config::text(&item["location"]);
        if !source.is_empty()
            && !path.is_empty()
            && source.trim_start().starts_with(['{', '[', '"'])
        {
            JsonStream::new(source.as_bytes()).one_item(&mut visitor, path, "")?;
        }
        for (text, hits) in visitor.hits {
            preview.extend(display_ranges(
                config::text(&item["preview"]),
                &text,
                &hits,
                false,
            ));
            preview.extend(display_ranges(
                config::text(&item["preview"]),
                &text,
                &hits,
                true,
            ));
            structure.extend(display_ranges(raw, &text, &hits, true));
        }
        // SSE projections reference the reconstructed stream snapshot; its marks
        // preserve exact restored positions across fragmented events.
        for snapshot in config::array(&item["contentSnapshotIds"]) {
            let snapshot = config::text(snapshot);
            let len:u64=db.query_row("SELECT json_extract(data,'$.byteLength') FROM audit_snapshots WHERE audit_id=? AND id=?",rusqlite::params![audit,snapshot],|r|r.get(0))?;
            let mut memory = Reservation::memory();
            memory.grow((len as usize).saturating_mul(20))?;
            let source = std::io::read_to_string(crate::security::content::BodyReader {
                db,
                audit,
                snapshot,
                next: 0,
                limit: len,
                chunk: Vec::new(),
                position: 0,
            })?;
            let mut stmt=db.prepare("SELECT m.value FROM audit_body_chunks c,json_each(c.redactions) m WHERE c.audit_id=? AND c.snapshot_id=? AND json_extract(m.value,'$.kind')='protected' ORDER BY json_extract(m.value,'$.start')")?;
            let mut marks = Vec::new();
            for mark in stmt.query_map(rusqlite::params![audit, snapshot], |r| {
                r.get::<_, String>(0)
            })? {
                let value: Value = serde_json::from_str(&mark?)?;
                if !marks.contains(&value) {
                    marks.push(value);
                }
            }
            struct StreamDisplay<'a> {
                source: &'a str,
                marks: &'a [Value],
                hits: Vec<DisplayHit>,
            }
            impl Visitor for StreamDisplay<'_> {
                fn end(&mut self, node: &Node) -> Result<()> {
                    if node.kind != b'"' {
                        return Ok(());
                    }
                    let mut spans = Vec::new();
                    for mark in self.marks {
                        let left = mark["start"].as_u64().unwrap_or(0).max(node.start + 1);
                        let right = mark["end"].as_u64().unwrap_or(0).min(node.end - 1);
                        if left >= right {
                            continue;
                        }
                        let prefix = |at: u64| -> Result<String> {
                            Ok(serde_json::from_str(&format!(
                                "\"{}\"",
                                &self.source[node.start as usize + 1..at as usize]
                            ))?)
                        };
                        let (Ok(start), Ok(end)) = (prefix(left), prefix(right)) else {
                            continue;
                        };
                        spans.push((
                            start.len(),
                            end.len(),
                            config::text(&mark["mappingId"]).to_owned(),
                        ));
                    }
                    if !spans.is_empty() {
                        let value = serde_json::from_str::<String>(
                            &self.source[node.start as usize..node.end as usize],
                        )?;
                        self.hits.push((value, spans));
                    }
                    Ok(())
                }
            }
            let mut display = StreamDisplay {
                source: &source,
                marks: &marks,
                hits: Vec::new(),
            };
            JsonStream::new(source.as_bytes()).parse(&mut display, "stream")?;
            for (text, hits) in display.hits {
                preview.extend(display_ranges(
                    config::text(&item["preview"]),
                    &text,
                    &hits,
                    false,
                ));
                preview.extend(display_ranges(
                    config::text(&item["preview"]),
                    &text,
                    &hits,
                    true,
                ));
                structure.extend(display_ranges(raw, &text, &hits, true));
            }
        }
        preview.sort_by_key(|r| (r["start"].as_u64(), r["end"].as_u64()));
        preview.dedup();
        structure.sort_by_key(|r| (r["start"].as_u64(), r["end"].as_u64()));
        structure.dedup();
        item["protectionRanges"] = json!({"preview":preview,"structure":structure});
    }
    Ok(())
}
pub(crate) fn annotate_body(
    _db: &rusqlite::Connection,
    _audit: &str,
    _snapshot: &str,
    page: &mut Value,
) -> Result<()> {
    page["protectionRanges"] = json!(config::array(&page["chunks"])
        .iter()
        .flat_map(|c| config::array(&c["protectionRanges"]))
        .collect::<Vec<_>>());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prepare(registry: &Registry, body: Value, scope: &str, at: u64) -> Request {
        registry
            .prepare_at(
                &spool_json(&body).unwrap(),
                &json!({}),
                json!({"id":"request","sessionKey":scope}),
                3600,
                at,
            )
            .unwrap()
    }
    #[test]
    fn idle_countdown_resets_and_old_active_requests_keep_their_mapping() {
        let registry = Registry::default();
        let body = json!({"api_key":"plainCredential"});
        let mut first = prepare(&registry, body.clone(), "s", 1000);
        let original_b = first.mappings[0].replacement.clone();
        let second = prepare(
            &registry,
            json!({"input":"prefix plainCredential suffix"}),
            "s",
            3_500_000,
        );
        assert_eq!(second.mappings[0].replacement, original_b);
        let third = prepare(&registry, body.clone(), "s", 6_999_999);
        assert_eq!(third.mappings[0].replacement, original_b);
        let fourth = prepare(&registry, body, "s", 10_599_999);
        assert_ne!(fourth.mappings[0].replacement, original_b);
        assert_eq!(
            first
                .replace(&original_b, true, "text", "response")
                .unwrap(),
            "plainCredential"
        );
        assert_eq!(third.report["expiresAtMs"], 10_599_999u64);
    }
    #[test]
    fn concurrent_requests_share_mapping_and_unknown_placeholders_are_never_resolved() {
        let registry = Arc::new(Registry::default());
        let mut workers = Vec::new();
        for _ in 0..8 {
            let registry = registry.clone();
            workers.push(std::thread::spawn(move || {
                prepare(&registry, json!({"token":"parallelToken"}), "s", 1000).mappings[0]
                    .replacement
                    .clone()
            }));
        }
        let values = workers
            .into_iter()
            .map(|w| w.join().unwrap())
            .collect::<Vec<_>>();
        assert!(values.iter().all(|b| b == &values[0]));
        let mut unrelated = prepare(&registry, json!({"input":values[0]}), "other", 1001);
        assert!(unrelated.mappings.is_empty());
        assert_eq!(
            unrelated
                .replace(&values[0], true, "text", "response")
                .unwrap(),
            values[0]
        );
        let mut same = prepare(&registry, json!({"input":values[0]}), "s", 1001);
        assert_eq!(
            same.replace(&values[0], true, "text", "response").unwrap(),
            "parallelToken"
        );
        let unknown = format!("{PREFIX}{}", uuid::Uuid::new_v4().simple());
        assert_eq!(
            same.replace(&unknown, true, "text", "response").unwrap(),
            unknown
        );
    }
    #[test]
    fn signed_response_fields_keep_their_signature_and_known_keys_fail_closed() {
        let registry = Registry::default();
        let mut request = prepare(&registry, json!({"api_key":"realToken"}), "s", 1000);
        let b = request.mappings[0].replacement.clone();
        let response = spool_json(&json!({"thinking":"immutable","signature":"signed","encrypted_content":"opaque","text":b})).unwrap();
        let restored: Value =
            serde_json::from_reader(request.transform(&response, true).unwrap().reader()).unwrap();
        assert_eq!(restored["thinking"], "immutable");
        assert_eq!(restored["signature"], "signed");
        assert_eq!(restored["text"], "realToken");
        assert!(request
            .transform(
                &spool_json(&json!({"thinking":b,"signature":"signature"})).unwrap(),
                true
            )
            .is_err());
        assert!(registry
            .prepare_at(
                &spool_json(&json!({"realToken":"value"})).unwrap(),
                &json!({}),
                json!({"id":"r","sessionKey":"s"}),
                3600,
                1001
            )
            .is_err());
    }
    #[test]
    fn display_ranges_preserve_unicode_offsets_and_partial_overlaps() {
        let text = "中文🙂 plainToken / plainToken";
        let hits = vec![(0, 10, "id".to_owned())];
        let ranges = display_ranges(text, "plainToken", &hits, false);
        assert_eq!(ranges[0]["start"], 5);
        assert_eq!(ranges[0]["end"], 15);
    }
}
