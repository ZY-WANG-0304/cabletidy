//! Reversible credential substitution on the transport path. Audit keeps A.
use crate::{
    config,
    security::{
        capture::{credential_field, Credential, Redactor},
        credentials::{self, Detection},
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
pub(crate) fn is_placeholder(value: &str) -> bool {
    value.strip_prefix(PREFIX).is_some_and(|id| {
        id.len() == 32
            && id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
type ProtectionSpan = (usize, usize, String);
type DisplayHit = (String, Vec<ProtectionSpan>);
fn now() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

struct Mapping {
    original: String,
    replacement: String,
    created: u64,
    rule_version: &'static str,
    credential: Credential,

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

pub(crate) struct Request {
    mappings: Vec<Arc<Mapping>>,
    pub report: Value,
    memory: Reservation,
    redactor: Redactor,
    pub detection: Arc<Detection>,
    source: Arc<Spool>,
    outbound: Option<Arc<Spool>>,
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
        let mut record = record;
        credentials::identify(source, &mut record)?;
        let scope = config::text(&record["sessionKey"]);
        let scope = if scope.is_empty() {
            config::text(&record["id"]).to_owned()
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
        let trusted = session
            .mappings
            .iter()
            .filter(|m| m.rule_version == credentials::VERSION)
            .map(|m| m.credential.clone())
            .collect::<Vec<_>>();
        let detection = credentials::detect(source, secrets, &trusted);
        let mut redactor = Redactor::new(secrets);
        detection.learn(&mut redactor);
        let entries = &mut session.mappings;
        let mut mappings = Vec::new();
        let mut rows = Vec::new();
        let originals = detection
            .candidates
            .iter()
            .filter(|c| c.strong && c.blocked.is_none() && detection.complete)
            .map(|c| c.original.clone())
            .collect::<BTreeSet<_>>();
        for original in originals {
            let existing = entries
                .iter()
                .find(|m| m.original == original && m.rule_version == credentials::VERSION)
                .cloned();
            let reused = existing.is_some();
            let m = if let Some(m) = existing {
                m
            } else {
                let mut memory = Reservation::memory();
                memory.grow(
                    original
                        .len()
                        .saturating_mul(8)
                        .saturating_add(scope.len() + 512),
                )?;
                let m = Arc::new(Mapping {
                    replacement: format!("{PREFIX}{}", uuid::Uuid::new_v4().simple()),
                    created: at,
                    rule_version: credentials::VERSION,
                    credential: detection
                        .candidates
                        .iter()
                        .filter(|c| c.original == original && c.strong)
                        .max_by_key(|c| c.match_policy)
                        .unwrap()
                        .credential(),
                    original,
                    _memory: memory,
                });
                entries.push(m.clone());
                m
            };
            rows.push(json!({"id":m.replacement,"original":m.original,"replacement":m.replacement,"evidenceClass":m.credential.evidence,"credentialType":m.credential.credential_type,"matchPolicy":m.credential.match_policy.name(),"ruleVersion":m.rule_version,"createdAtMs":m.created,"expiresAtMs":at+ttl*1000,"reused":reused,"requestCount":0,"responseCount":0}));
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
            detection,
            source: source.clone(),
            outbound: None,
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
                request.report["mappings"].as_array_mut().unwrap().push(json!({"id":m.replacement,"original":m.original,"replacement":m.replacement,"evidenceClass":m.credential.evidence,"credentialType":m.credential.credential_type,"matchPolicy":m.credential.match_policy.name(),"ruleVersion":m.rule_version,"createdAtMs":m.created,"expiresAtMs":at+ttl*1000,"reused":true,"requestCount":0,"responseCount":0}));
                request.mappings.push(m);
            }
        }
        request.report["detection"] = request.detection.summary();
        request.report["policyVersion"] = json!("protection-2");
        request.report["forwarded"] = json!(false);
        request.report["decisions"] = json!(request
            .detection
            .candidates
            .iter()
            .map(|c| {
                let mut fact = c.fact(&request.detection.snapshot_id);
                fact["replacementStatus"] = json!("not_replaced");
                fact["reason"] = json!(if !c.strong {
                    "policy_not_selected"
                } else {
                    c.blocked.unwrap_or("pending_execution")
                });
                fact
            })
            .collect::<Vec<_>>());
        let size = request.report.to_string().len().saturating_mul(12) as u64;
        if size > request.memory.bytes {
            request
                .memory
                .grow((size - request.memory.bytes) as usize)?;
        }
        Ok(request)
    }
}
// Map decoded UTF-8 boundaries back to the actual JSON spelling, including
// Unicode escapes and surrogate pairs. Audit positions stay in the original A.
use crate::security::credentials::string_offsets;
#[derive(Clone, Copy)]
struct Candidate {
    start: usize,
    end: usize,
    mapping: usize,
    depth: usize,
}
fn candidates(
    text: &str,
    mappings: &[Arc<Mapping>],
    restore: bool,
    depth: usize,
) -> Result<Vec<Candidate>> {
    let mut memory = Reservation::memory();
    memory.grow(text.len().saturating_mul(24))?;
    struct Strings {
        stack: Vec<String>,
        values: Vec<(Node, String)>,
    }
    impl Visitor for Strings {
        fn start(&mut self, _: &str, _: &str, _: u8, _: u64) -> Result<()> {
            self.stack.push(String::new());
            Ok(())
        }
        fn text(&mut self, s: &str) -> Result<()> {
            self.stack.last_mut().unwrap().push_str(s);
            Ok(())
        }
        fn end(&mut self, node: &Node) -> Result<()> {
            let value = self.stack.pop().unwrap();
            if matches!(node.kind, b'"' | b'k') {
                self.values.push((node.clone(), value));
            }
            Ok(())
        }
    }
    let mut strings = Strings {
        stack: Vec::new(),
        values: Vec::new(),
    };
    let json = text.trim_start().starts_with(['{', '['])
        && JsonStream::new(text.as_bytes())
            .parse(&mut strings, "nested")
            .is_ok();
    if json {
        if depth >= 4 {
            bail!("protection_nested_json_limit");
        }
        let mut result = Vec::new();
        for (node, value) in strings.values {
            let offsets = string_offsets(&text[node.start as usize..node.end as usize])?;
            for mut hit in candidates(&value, mappings, restore, depth + 1)? {
                hit.start = node.start as usize + offsets[hit.start];
                hit.end = node.start as usize + offsets[hit.end];
                result.push(hit);
            }
        }
        return Ok(result);
    }
    Ok(literal_candidates(text, mappings, restore, depth))
}
fn literal_candidates(
    text: &str,
    mappings: &[Arc<Mapping>],
    restore: bool,
    depth: usize,
) -> Vec<Candidate> {
    let mut result = Vec::new();
    for (mapping, m) in mappings.iter().enumerate() {
        debug_assert!(restore, "request replacements require frozen positions");
        let needle = &m.replacement;
        for needle in variants(needle) {
            for (start, _) in text.match_indices(&needle) {
                result.push(Candidate {
                    start,
                    end: start + needle.len(),
                    mapping,
                    depth,
                });
            }
        }
    }
    result
}

impl Request {
    fn replace(&mut self, text: &str, restore: bool, field: &str, path: &str) -> Result<String> {
        self.replace_at(text, restore, field, path, 0)
    }
    fn replace_at(
        &mut self,
        text: &str,
        restore: bool,
        _field: &str,
        path: &str,
        base: u64,
    ) -> Result<String> {
        self.replace_at_mode(text, restore, path, base, true)
    }
    fn replace_at_mode(
        &mut self,
        text: &str,
        restore: bool,
        path: &str,
        base: u64,
        structured: bool,
    ) -> Result<String> {
        if !restore {
            bail!("protection_requires_detection_plan");
        }
        let mut scratch = Reservation::memory();
        scratch.grow(text.len().saturating_mul(24))?;
        let mut candidates = if structured {
            candidates(text, &self.mappings, restore, 0)?
        } else {
            literal_candidates(text, &self.mappings, restore, 0)
        };
        scratch.grow(
            candidates
                .len()
                .saturating_mul(std::mem::size_of::<Candidate>() * 2),
        )?;
        candidates.sort_by_key(|c| (c.start, std::cmp::Reverse(c.end - c.start)));
        let mut out = String::new();
        let mut at = 0;
        for candidate in candidates {
            let Candidate {
                start: a,
                end: b,
                mapping: i,
                depth,
            } = candidate;
            if a < at {
                continue;
            }
            let m = &self.mappings[i];
            out.push_str(&text[at..a]);
            let value = if restore { &m.original } else { &m.replacement };
            let depth = if restore { depth } else { 0 };
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
        if restore {
            return self.transform_except(source, true, &[]);
        }
        if !Arc::ptr_eq(source, &self.source) {
            bail!("protection_snapshot_mismatch");
        }
        if !self.detection.complete {
            bail!("protection_incomplete_detection");
        }
        if let Some(reason) = self
            .detection
            .candidates
            .iter()
            .filter(|c| c.strong)
            .find_map(|c| c.blocked)
        {
            bail!(reason);
        }
        let mut edits = Edits::new();
        for c in self.detection.candidates.iter().filter(|c| c.strong) {
            let i = self
                .mappings
                .iter()
                .position(|m| m.original == c.original)
                .unwrap();
            edits.add(
                c.raw_start,
                c.raw_end,
                self.mappings[i].replacement.as_bytes().to_vec(),
            )?;
        }
        let mut out = Spool::new()?;
        std::io::copy(&mut edits.reader(source), &mut out)?;
        let out = out.seal()?;
        // Retain the exact plan output. Verification checks these bytes, rather
        // than rerunning candidate detection on the modified snapshot.
        JsonStream::new(out.reader()).parse(&mut ValidateJson, "verify")?;
        self.outbound = Some(out.clone());
        for (index, c) in self
            .detection
            .candidates
            .iter()
            .enumerate()
            .filter(|(_, c)| c.strong)
        {
            let i = self
                .mappings
                .iter()
                .position(|m| m.original == c.original)
                .unwrap();
            self.report["requestCount"] =
                json!(self.report["requestCount"].as_u64().unwrap_or(0) + 1);
            let row = &mut self.report["mappings"][i];
            row["requestCount"] = json!(row["requestCount"].as_u64().unwrap_or(0) + 1);
            if !row["locations"].is_array() {
                row["locations"] = json!([]);
            }
            let mut location = c.fact(&self.detection.snapshot_id);
            location["side"] = json!("request");
            row["locations"].as_array_mut().unwrap().push(location);
            self.report["decisions"][index]["replacementStatus"] = json!("replaced");
            self.report["decisions"][index]["reason"] = Value::Null;
        }
        Ok(out)
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
        let expected = self
            .outbound
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("protection_not_executed"))?;
        if source.len != expected.len {
            bail!("protection_verification_failed");
        }
        let mut left = source.reader();
        let mut right = expected.reader();
        let mut a = [0; streaming::PAGE];
        let mut b = [0; streaming::PAGE];
        loop {
            let n = left.read(&mut a)?;
            if n == 0 {
                break;
            }
            right.read_exact(&mut b[..n])?;
            if a[..n] != b[..n] {
                bail!("protection_verification_failed");
            }
        }
        Ok(())
    }
    pub fn safe_parameter(&self, value: &str) -> bool {
        self.safe_value(value, false)
    }
    fn safe_value(&self, value: &str, forced: bool) -> bool {
        let mut decoded = value.to_owned();
        for depth in 0..=4 {
            if !self.redactor.protection_ranges(&decoded, forced).is_empty()
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
                return true;
            }
            if depth == 4 {
                // Further encoding cannot bypass the final credential check.
                return false;
            }
            decoded = next;
        }
        false
    }
    pub fn safe_query(&self, value: &str) -> bool {
        self.safe_parameter(value)
            && url::form_urlencoded::parse(value.as_bytes()).all(|(key, value)| {
                self.safe_parameter(&key) && self.safe_value(&value, credential_field(&key))
            })
    }
}

// Prose keeps a possible placeholder suffix. JSON-looking text and tool
// arguments retain a complete channel so JSON escaping is independent of deltas.
struct ValidateJson;
impl Visitor for ValidateJson {}
struct Channel {
    pending: String,
    emitted: u64,
    json: bool,
    structured_text: Option<bool>,
    template: Arc<Spool>,
    field: String,
    memory: Reservation,
}
#[derive(Default)]
pub(crate) struct Restorer {
    channels: BTreeMap<String, Channel>,
    opaque: BTreeMap<String, (String, Reservation)>,
}
impl Restorer {
    fn delta(
        &mut self,
        request: &mut Request,
        key: &str,
        text: &str,
        field: &str,
        event: &Arc<Spool>,
    ) -> Result<String> {
        if !self.channels.contains_key(key) {
            let mut memory = Reservation::memory();
            memory.grow(key.len().saturating_mul(2).saturating_add(512))?;
            self.channels.insert(
                key.into(),
                Channel {
                    pending: String::new(),
                    emitted: 0,
                    json: field == "partial_json",
                    structured_text: None,
                    template: event.clone(),
                    field: field.into(),
                    memory,
                },
            );
        }
        let channel = self.channels.get_mut(key).unwrap();
        channel.template = event.clone();
        let mut scratch = Reservation::memory();
        scratch.grow(text.len().saturating_mul(8))?;
        channel.pending.push_str(text);
        if !channel.json && channel.structured_text.is_none() {
            channel.structured_text = channel
                .pending
                .chars()
                .find(|c| !c.is_whitespace())
                .map(|c| matches!(c, '{' | '['));
        }
        if channel.json || channel.structured_text != Some(false) {
            channel.memory.grow(text.len().saturating_mul(24))?;
            return Ok(String::new());
        }
        let keep = Self::placeholder_tail(request, &channel.pending);
        let split = channel.pending.len() - keep;
        let ready = channel.pending[..split].to_owned();
        channel.pending = channel.pending[split..].to_owned();
        let output = request.replace_at_mode(&ready, true, key, channel.emitted, false)?;
        channel.emitted += output.len() as u64;
        Ok(output)
    }
    fn placeholder_tail(request: &Request, text: &str) -> usize {
        (1..=text.len().min(PREFIX.len() + 32))
            .rev()
            .find(|&n| {
                text.is_char_boundary(text.len() - n)
                    && request.mappings.iter().any(|m| {
                        m.replacement.starts_with(&text[text.len() - n..])
                            && n < m.replacement.len()
                    })
            })
            .unwrap_or(0)
    }
    fn finish(
        &mut self,
        request: &mut Request,
        key: &str,
    ) -> Result<Option<(Arc<Spool>, String, String)>> {
        let Some(channel) = self.channels.remove(key) else {
            return Ok(None);
        };
        let text = if channel.json {
            // Reject malformed tool JSON even when substitution itself could run.
            let mut parser = JsonStream::new(channel.pending.as_bytes());
            parser.parse(&mut ValidateJson, "arguments")?;
            let restored = request.replace_at(&channel.pending, true, "arguments", key, 0)?;
            JsonStream::new(restored.as_bytes()).parse(&mut ValidateJson, "arguments")?;
            restored
        } else if channel.structured_text == Some(true) {
            if Self::placeholder_tail(request, &channel.pending) >= PREFIX.len() {
                bail!("protection_incomplete_placeholder");
            }
            request.replace_at(&channel.pending, true, &channel.field, key, 0)?
        } else {
            if channel.pending.len() >= PREFIX.len() && channel.structured_text == Some(false) {
                bail!("protection_incomplete_placeholder");
            }
            channel.pending
        };
        if text.is_empty() {
            Ok(None)
        } else {
            Ok(Some((channel.template, channel.field, text)))
        }
    }
    fn opaque_delta(&mut self, request: &Request, key: &str, text: &str) -> Result<()> {
        if !self.opaque.contains_key(key) {
            let mut memory = Reservation::memory();
            memory.grow(key.len().saturating_mul(2).saturating_add(512))?;
            self.opaque.insert(key.into(), (String::new(), memory));
        }
        let mut scratch = Reservation::memory();
        scratch.grow(text.len().saturating_mul(4))?;
        let (tail, _) = self.opaque.get_mut(key).unwrap();
        tail.push_str(text);
        if request
            .mappings
            .iter()
            .any(|m| tail.contains(&m.replacement))
        {
            bail!("protection_signed_or_opaque_response");
        }
        let mut start = tail.len().saturating_sub(PREFIX.len() + 31);
        while !tail.is_char_boundary(start) {
            start += 1;
        }
        tail.drain(..start);
        Ok(())
    }
}

#[cfg(test)]
fn spool_json(value: &Value) -> Result<Arc<Spool>> {
    let mut s = Spool::new()?;
    serde_json::to_writer(&mut s, value)?;
    Ok(s.seal()?)
}

fn compose_event(fields: &Arc<Spool>, payload: &Arc<Spool>, edits: Edits) -> Result<Arc<Spool>> {
    use std::io::{Seek, SeekFrom};
    let mut reader = fields.reader();
    let mut end = fields.len;
    let mut byte = [0];
    while end > 0 {
        reader.seek(SeekFrom::Start(end - 1))?;
        reader.read_exact(&mut byte)?;
        if !matches!(byte[0], b'\r' | b'\n') {
            break;
        }
        end -= 1;
    }
    reader.seek(SeekFrom::Start(0))?;
    let mut output = std::io::BufWriter::with_capacity(streaming::PAGE, Spool::new()?);
    std::io::copy(&mut reader.take(end), &mut output)?;
    if end > 0 {
        output.write_all(b"\n")?;
    }
    output.write_all(b"data: ")?;
    let mut reader = edits.reader(payload);
    let mut buffer = vec![0; streaming::PAGE];
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        for part in buffer[..n].split_inclusive(|b| *b == b'\n') {
            output.write_all(part)?;
            if part.last() == Some(&b'\n') {
                output.write_all(b"data: ")?;
            }
        }
    }
    output.write_all(b"\n\n")?;
    Ok(output.into_inner().map_err(|e| e.into_error())?.seal()?)
}
fn flush_event(
    request: &mut Request,
    template: &Arc<Spool>,
    field: &str,
    text: &str,
    client: &str,
    mapped: &str,
    claude: bool,
) -> Result<Arc<Spool>> {
    let data = streaming::event_data(template)?;
    let mut memory = Reservation::memory();
    memory.grow((data.payload.len as usize).saturating_mul(12))?;
    let mut value: Value = serde_json::from_reader(data.payload.reader())?;
    if claude {
        value["delta"][field] = json!(text);
    } else {
        value["delta"] = json!(text);
    }
    let mut payload = Spool::new()?;
    serde_json::to_writer(&mut payload, &value)?;
    let payload = payload.seal()?;
    // A buffered delta reuses its upstream template. Restore any sibling
    // fields repeated by that template, while leaving the restored body alone.
    let top = streaming::index(&payload, None)?;
    let mut skip = Vec::new();
    if let Some((path, _, node)) = top.nodes.iter().find(|(_, f, _)| f == "delta") {
        if claude {
            let delta = streaming::index(&payload, Some(node))?;
            if let Some((child_path, _, _)) = delta.nodes.iter().find(|(_, f, _)| f == field) {
                skip.push(response_child_path(path, child_path));
            }
        } else {
            skip.push(path.replacen("node", "response", 1));
        }
    }
    let payload = request.transform_except(&payload, true, &skip)?;
    let edits = streaming::response_edits(&payload, client, mapped, claude)?;
    compose_event(&data.fields, &payload, edits)
}
fn initial_delta_template(event: &Arc<Spool>, field: &str, claude: bool) -> Result<Arc<Spool>> {
    let data = streaming::event_data(event)?;
    let mut memory = Reservation::memory();
    memory.grow((data.payload.len.saturating_add(data.fields.len) as usize).saturating_mul(12))?;
    let mut value: Value = serde_json::from_reader(data.payload.reader())?;
    if claude {
        value.as_object_mut().unwrap().remove("content_block");
        value["type"] = json!("content_block_delta");
        value["delta"] = json!({"type":"text_delta","text":""});
    } else {
        value.as_object_mut().unwrap().remove("part");
        value["type"] = json!(match field {
            "refusal" => "response.refusal.delta",
            "summary" => "response.reasoning_summary_text.delta",
            _ => "response.output_text.delta",
        });
        value["delta"] = json!("");
    }
    let mut payload = Spool::new()?;
    serde_json::to_writer(&mut payload, &value)?;
    // A named initial event must also use the new delta event name when a
    // buffered tail is emitted at EOF without a subsequent upstream delta.
    let mut fields = Spool::new()?;
    use std::io::BufRead;
    for line in std::io::BufReader::new(data.fields.reader()).lines() {
        let line = line?;
        if line.starts_with("event:") {
            writeln!(fields, "event: {}", config::text(&value["type"]))?;
        } else {
            writeln!(fields, "{line}")?;
        }
    }
    compose_event(&fields.seal()?, &payload.seal()?, Edits::new())
}

fn response_child_path(parent: &str, child: &str) -> String {
    // Subtree indexes start at "node". Rebase the leaf onto its parent so
    // generic restoration still visits siblings such as citations/annotations.
    child.replacen("node", &parent.replacen("node", "response", 1), 1)
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
    ) -> Result<Vec<Arc<Spool>>> {
        let data = streaming::event_data(event)?;
        if data.payload.len == 0 {
            return Ok(vec![event.clone()]);
        }
        if data.payload.len == 6 {
            let mut marker = [0; 6];
            data.payload.reader().read_exact(&mut marker)?;
            if &marker == b"[DONE]" {
                let mut events = self.finish(request, client, mapped, claude)?;
                events.push(event.clone());
                return Ok(events);
            }
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
        if kind == "content_block_start" {
            if let Some((path, _, node)) = top.nodes.iter().find(|(_, f, _)| f == "content_block") {
                let block = streaming::index(&data.payload, Some(node))?;
                for (child_path, field, node) in &block.nodes {
                    if field == "text" && block.values["type"] == "text" {
                        let value = node.read(&data.payload, &mut memory)?;
                        let template = initial_delta_template(event, "text", true)?;
                        let output = self.restorer.delta(
                            request,
                            &key,
                            config::text(&value),
                            "text",
                            &template,
                        )?;
                        delta_edits.add(node.start, node.end, serde_json::to_vec(&output)?)?;
                        skip.push(response_child_path(path, child_path));
                    } else if matches!(field.as_str(), "thinking" | "signature") {
                        let value = node.read(&data.payload, &mut memory)?;
                        self.restorer.opaque_delta(
                            request,
                            &format!("{key}/{field}"),
                            config::text(&value),
                        )?;
                    }
                }
            }
        } else if matches!(
            kind,
            "response.content_part.added" | "response.reasoning_summary_part.added"
        ) {
            if let Some((path, _, node)) = top.nodes.iter().find(|(_, f, _)| f == "part") {
                let part = streaming::index(&data.payload, Some(node))?;
                let (field, channel) = match config::text(&part.values["type"]) {
                    "text" | "output_text" => ("text", "text"),
                    "refusal" => ("refusal", "refusal"),
                    "summary_text" => ("text", "summary"),
                    _ => ("", ""),
                };
                if let Some((child_path, _, node)) = part.nodes.iter().find(|(_, f, _)| f == field)
                {
                    let output = top.values["output_index"].as_u64().unwrap_or(0);
                    let index = top.values[if channel == "summary" {
                        "summary_index"
                    } else {
                        "content_index"
                    }]
                    .as_u64()
                    .unwrap_or(0);
                    let key = format!("sse/output/{output}/{channel}/{index}");
                    let value = node.read(&data.payload, &mut memory)?;
                    let template = initial_delta_template(event, channel, false)?;
                    let output = self.restorer.delta(
                        request,
                        &key,
                        config::text(&value),
                        "text",
                        &template,
                    )?;
                    delta_edits.add(node.start, node.end, serde_json::to_vec(&output)?)?;
                    skip.push(response_child_path(path, child_path));
                }
            }
        }
        if kind == "content_block_delta" {
            if let Some((path, _, n)) = top.nodes.iter().find(|(_, f, _)| f == "delta") {
                let delta = streaming::index(&data.payload, Some(n))?;
                for (child_path, field, node) in &delta.nodes {
                    if matches!(field.as_str(), "text" | "partial_json") {
                        skip.push(response_child_path(path, child_path));
                        let value = node.read(&data.payload, &mut memory)?;
                        let text = config::text(&value);
                        let output = self.restorer.delta(request, &key, text, field, event)?;
                        delta_edits.add(node.start, node.end, serde_json::to_vec(&output)?)?;
                    } else if matches!(field.as_str(), "thinking" | "signature") {
                        let value = node.read(&data.payload, &mut memory)?;
                        self.restorer.opaque_delta(
                            request,
                            &format!("{key}/{field}"),
                            config::text(&value),
                        )?;
                    }
                }
            }
        } else if kind == "response.reasoning_text.delta" {
            if let Some((_, _, node)) = top.nodes.iter().find(|(_, f, _)| f == "delta") {
                let value = node.read(&data.payload, &mut memory)?;
                self.restorer.opaque_delta(
                    request,
                    &format!("{key}/thinking"),
                    config::text(&value),
                )?;
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
                let output =
                    self.restorer
                        .delta(request, &key, config::text(&value), field, event)?;
                delta_edits.add(node.start, node.end, serde_json::to_vec(&output)?)?;
            }
        }
        let mut events = Vec::new();
        if matches!(
            kind,
            "content_block_stop"
                | "response.output_text.done"
                | "response.function_call_arguments.done"
                | "response.custom_tool_call_input.done"
                | "response.refusal.done"
                | "response.reasoning_summary_text.done"
        ) {
            if let Some((template, field, text)) = self.restorer.finish(request, &key)? {
                events.push(flush_event(
                    request, &template, &field, &text, client, mapped, claude,
                )?);
            }
            self.restorer
                .opaque
                .retain(|name, _| !name.starts_with(&format!("{key}/")));
        }
        if matches!(
            kind,
            "message_stop"
                | "response.completed"
                | "response.failed"
                | "response.incomplete"
                | "error"
        ) {
            events.extend(self.finish(request, client, mapped, claude)?);
        }
        delta_edits.ranges.sort_by_key(|r| r.0);
        let mut payload = Spool::new()?;
        std::io::copy(&mut delta_edits.reader(&data.payload), &mut payload)?;
        let payload = request.transform_except(&payload.seal()?, true, &skip)?;
        let model_edits = streaming::response_edits(&payload, client, mapped, claude)?;
        events.push(compose_event(&data.fields, &payload, model_edits)?);
        Ok(events)
    }

    pub fn finish(
        &mut self,
        request: &mut Request,
        client: &str,
        mapped: &str,
        claude: bool,
    ) -> Result<Vec<Arc<Spool>>> {
        let mut events = Vec::new();
        let keys = self.restorer.channels.keys().cloned().collect::<Vec<_>>();
        for key in keys {
            if let Some((template, field, text)) = self.restorer.finish(request, &key)? {
                events.push(flush_event(
                    request, &template, &field, &text, client, mapped, claude,
                )?);
            }
        }
        self.restorer.opaque.clear();
        Ok(events)
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
    fn only_complete_placeholders_are_exempt_and_saved_credentials_take_priority() {
        let b = format!("{PREFIX}0123456789abcdef0123456789abcdef");
        assert!(is_placeholder(&b));
        for value in [
            PREFIX.to_owned(),
            format!("{b}!"),
            b[..b.len() - 1].to_owned(),
            format!("{PREFIX}0123456789ABCDEF0123456789ABCDEF"),
            format!("{PREFIX}MyActualPassword_2026!"),
        ] {
            assert!(!is_placeholder(&value));
            assert_eq!(
                Redactor::new(&json!({})).protection_ranges(&value, true),
                vec![(0, value.len())]
            );
        }
        assert!(Redactor::new(&json!({}))
            .protection_ranges(&b, true)
            .is_empty());
        for forced in [false, true] {
            assert_eq!(
                Redactor::new(&json!({"upstream":b})).protection_ranges(&b, forced),
                vec![(0, b.len())]
            );
        }
        for value in [
            format!("api_key={b}"),
            format!("api_key=\"{b}\""),
            format!("Bearer {b}"),
            format!("https://example.invalid/?api_key={b}"),
        ] {
            assert!(Redactor::new(&json!({}))
                .protection_ranges(&value, false)
                .is_empty());
            let start = value.find(&b).unwrap();
            assert_eq!(
                Redactor::new(&json!({"upstream":b})).protection_ranges(&value, false),
                vec![(start, start + b.len())]
            );
        }
        let value = format!("Bearer {b}");
        assert!(Redactor::new(&json!({}))
            .protection_ranges(&value, true)
            .is_empty());
        assert_eq!(
            Redactor::new(&json!({"upstream":b})).protection_ranges(&value, true),
            vec![(7, value.len())]
        );
        assert_eq!(
            Redactor::new(&json!({"upstream":value})).protection_ranges(&value, true),
            vec![(7, value.len())]
        );
    }
    #[test]
    fn earlier_detector_mappings_restore_but_do_not_classify_or_reuse_a() {
        let registry = Registry::default();
        let original = "legacyWeakValue87";
        let mut active = prepare(&registry, json!({"password":original}), "s", 1000);
        let old_b = active.mappings[0].replacement.clone();
        let mut memory = Reservation::memory();
        memory.grow(1024).unwrap();
        let old = Arc::new(Mapping {
            original: original.into(),
            replacement: old_b.clone(),
            created: 1000,
            rule_version: "credentials-2",
            credential: active.mappings[0].credential.clone(),
            _memory: memory,
        });
        registry
            .sessions
            .lock()
            .unwrap()
            .get_mut("s")
            .unwrap()
            .mappings[0] = old;
        let mut later = prepare(&registry, json!({"input":original}), "s", 1001);
        assert!(later.detection.candidates.is_empty());
        let source = later.source.clone();
        let out: Value =
            serde_json::from_reader(later.transform(&source, false).unwrap().reader()).unwrap();
        assert_eq!(out["input"], original);
        assert_eq!(
            later.replace(&old_b, true, "text", "response").unwrap(),
            original
        );
        let current = prepare(&registry, json!({"password":original}), "s", 1002);
        let new = current
            .mappings
            .iter()
            .find(|m| m.rule_version == credentials::VERSION)
            .unwrap();
        assert_ne!(new.replacement, old_b);
        assert_eq!(current.report["mappings"][0]["reused"], false);
        assert_eq!(
            active.replace(&old_b, true, "text", "response").unwrap(),
            original
        );
    }
    #[test]
    fn parameter_decoding_checks_the_final_layer_and_rejects_excessive_encoding() {
        let registry = Registry::default();
        let request = prepare(&registry, json!({"api_key":"actual secret"}), "s", 1000);
        let mut encoded = "actual secret".to_owned();
        for _ in 0..6 {
            assert!(!request.safe_parameter(&encoded));
            encoded = encoded.bytes().map(|b| format!("%{b:02X}")).collect();
        }
        assert!(!request.safe_query("extra=actual+secret"));
        assert!(!request.safe_query("actual+secret=safe"));
        assert!(request.safe_query("extra=actual%2Bsecret"));
        assert!(request.safe_parameter("actual+secret"));
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
        let source = spool_json(&json!({"realToken":"value"})).unwrap();
        let mut blocked = registry
            .prepare_at(
                &source,
                &json!({}),
                json!({"id":"r","sessionKey":"s"}),
                3600,
                1001,
            )
            .unwrap();
        assert_eq!(
            blocked.detection.candidates[0].blocked,
            Some("protection_credential_in_key")
        );
        assert!(blocked.transform(&source, false).is_err());
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
