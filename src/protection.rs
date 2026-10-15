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

#[derive(Clone, Copy, Default)]
struct ScanScope {
    forced: bool,
    schema: bool,
    credential_definition: bool,
    tool_definition: bool,
}
impl ScanScope {
    fn child(self, parent_field: &str, field: &str, kind: u8) -> Self {
        let tool_definition = self.tool_definition || field == "tools";
        let schema_value =
            self.schema && matches!(field, "default" | "const" | "enum" | "examples");
        let schema = !schema_value
            && (self.schema
                || kind == b'{'
                    && (matches!(field, "schema" | "json_schema")
                        || tool_definition && matches!(field, "parameters" | "input_schema")));
        let credential_definition = self.credential_definition
            || self.schema && parent_field == "properties" && credential_field(field);
        let forced = kind != b'k'
            && (self.forced
                || !schema && credential_field(field)
                || credential_definition
                    && matches!(field, "default" | "const" | "enum" | "examples"));
        Self {
            forced,
            schema,
            credential_definition,
            tool_definition,
        }
    }
}
#[derive(Default)]
struct Frame {
    value: String,
    scope: ScanScope,
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
    value: &str,
    redactor: &Redactor,
    found: &mut BTreeSet<String>,
    scope: ScanScope,
    field: &str,
    depth: usize,
) -> Result<()> {
    if depth > 32 {
        bail!("protection_nested_json_limit");
    }
    // Visit the original members instead of constructing a Value: duplicate
    // keys must never erase an earlier credential still present on the wire.
    if value.trim_start().starts_with(['{', '['])
        && JsonStream::new(value.as_bytes())
            .parse(&mut ValidateJson, "nested")
            .is_ok()
    {
        struct Nested {
            scope: ScanScope,
            stack: Vec<Frame>,
            strings: Vec<Frame>,
            memory: Reservation,
        }
        impl Visitor for Nested {
            fn start(&mut self, _: &str, field: &str, kind: u8, _: u64) -> Result<()> {
                self.memory
                    .grow(field.len().saturating_mul(4).saturating_add(256))?;
                self.stack.push(Frame {
                    scope: self.stack.last().map_or(self.scope, |parent| {
                        parent.scope.child(&parent.field, field, kind)
                    }),
                    field: field.into(),
                    kind,
                    memory: Some(Reservation::memory()),
                    ..Frame::default()
                });
                Ok(())
            }
            fn text(&mut self, text: &str) -> Result<()> {
                let frame = self.stack.last_mut().unwrap();
                frame
                    .memory
                    .as_mut()
                    .unwrap()
                    .grow(text.len().saturating_mul(12))?;
                frame.value.push_str(text);
                Ok(())
            }
            fn scalar(&mut self, value: &str) -> Result<()> {
                if value != "null" && self.stack.last().is_some_and(|frame| frame.scope.forced) {
                    bail!("protection_non_string_credential");
                }
                Ok(())
            }
            fn end(&mut self, _: &Node) -> Result<()> {
                let frame = self.stack.pop().unwrap();
                if matches!(frame.kind, b'"' | b'k') {
                    self.strings.push(frame);
                }
                Ok(())
            }
        }
        let mut memory = Reservation::memory();
        memory.grow(value.len().saturating_mul(24))?;
        let mut nested = Nested {
            scope,
            stack: Vec::new(),
            strings: Vec::new(),
            memory: Reservation::memory(),
        };
        // Root strings retain the outer field's forced/schema semantics.
        JsonStream::new(value.as_bytes()).one_item(&mut nested, "nested", field)?;
        for frame in nested.strings {
            if frame.kind == b'k' {
                let mut keys = BTreeSet::new();
                nested_credentials(
                    &frame.value,
                    redactor,
                    &mut keys,
                    frame.scope,
                    &frame.field,
                    depth + 1,
                )?;
                if !keys.is_empty() {
                    bail!("protection_credential_in_key");
                }
            } else {
                nested_credentials(
                    &frame.value,
                    redactor,
                    found,
                    frame.scope,
                    &frame.field,
                    depth + 1,
                )?;
            }
        }
        return Ok(());
    }
    for (start, end) in redactor.protection_ranges(value, scope.forced) {
        found.insert(value[start..end].to_owned());
    }
    Ok(())
}
impl Visitor for Scan<'_> {
    fn start(&mut self, _: &str, field: &str, kind: u8, _: u64) -> Result<()> {
        self.identity.start(field, kind);
        self.stack.push(Frame {
            scope: self.stack.last().map_or_else(
                || ScanScope::default().child("", field, kind),
                |f| f.scope.child(&f.field, field, kind),
            ),
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
        if value != "null" && self.stack.last().is_some_and(|f| f.scope.forced) {
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
        nested_credentials(&f.value, self.redactor, &mut found, f.scope, &f.field, 0)?;
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
// Map decoded UTF-8 boundaries back to the actual JSON spelling, including
// Unicode escapes and surrogate pairs. Audit positions stay in the original A.
fn string_offsets(raw: &str) -> Result<Vec<usize>> {
    let mut offsets = vec![1];
    let mut at = 1;
    while at + 1 < raw.len() {
        let start = at;
        let end = if raw.as_bytes()[at] == b'\\' {
            if raw.as_bytes().get(at + 1) == Some(&b'u') {
                let first = u16::from_str_radix(&raw[at + 2..at + 6], 16)?;
                at + if (0xd800..=0xdbff).contains(&first) {
                    12
                } else {
                    6
                }
            } else {
                at + 2
            }
        } else {
            at + raw[at..].chars().next().unwrap().len_utf8()
        };
        let decoded: String = serde_json::from_str(&format!("\"{}\"", &raw[start..end]))?;
        for _ in 1..decoded.len() {
            offsets.push(start);
        }
        offsets.push(end);
        at = end;
    }
    Ok(offsets)
}
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
        let needle = if restore { &m.replacement } else { &m.original };
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
        struct Verify<'a> {
            request: &'a Request,
            stack: Vec<String>,
            memory: Reservation,
        }
        impl Visitor for Verify<'_> {
            fn start(&mut self, _: &str, _: &str, _: u8, _: u64) -> Result<()> {
                self.stack.push(String::new());
                Ok(())
            }
            fn text(&mut self, s: &str) -> Result<()> {
                self.memory.grow(s.len().saturating_mul(12))?;
                self.stack.last_mut().unwrap().push_str(s);
                Ok(())
            }
            fn end(&mut self, _: &Node) -> Result<()> {
                let value = self.stack.pop().unwrap();
                if !candidates(&value, &self.request.mappings, false, 0)?.is_empty() {
                    bail!("protection_verification_failed");
                }
                Ok(())
            }
        }
        JsonStream::new(source.reader()).parse(
            &mut Verify {
                request: self,
                stack: Vec::new(),
                memory: Reservation::memory(),
            },
            "verify",
        )?;
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
    let edits = streaming::response_edits(&payload, client, mapped, claude)?;
    compose_event(&data.fields, &payload, edits)
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
            if let Some((_, _, node)) = top.nodes.iter().find(|(_, f, _)| f == "content_block") {
                let block = streaming::index(&data.payload, Some(node))?;
                for (_, field, node) in &block.nodes {
                    if matches!(field.as_str(), "thinking" | "signature") {
                        let value = node.read(&data.payload, &mut memory)?;
                        self.restorer.opaque_delta(
                            request,
                            &format!("{key}/{field}"),
                            config::text(&value),
                        )?;
                    }
                }
            }
        }
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
                    &template, &field, &text, client, mapped, claude,
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
            let keys = self.restorer.channels.keys().cloned().collect::<Vec<_>>();
            for key in keys {
                if let Some((template, field, text)) = self.restorer.finish(request, &key)? {
                    events.push(flush_event(
                        &template, &field, &text, client, mapped, claude,
                    )?);
                }
            }
            self.restorer.opaque.clear();
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
                    &template, &field, &text, client, mapped, claude,
                )?);
            }
        }
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
