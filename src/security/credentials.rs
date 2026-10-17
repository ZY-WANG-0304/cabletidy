//! Immutable credential facts for one original wire snapshot. Audit and transport
//! consume this object; neither consumer searches the request for new candidates.
use super::{
    capture::{
        credential_field, credential_type, strong_evidence, Credential, MatchPolicy, Redactor,
    },
    session,
};
use crate::streaming::{JsonStream, Node, Reservation, Spool, Visitor};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{Read, Seek, SeekFrom},
    sync::Arc,
};

pub(crate) const VERSION: &str = "credentials-4";
#[derive(Clone, Copy, Default)]
struct Scope {
    credential: bool,
    schema: bool,
    property: bool,
    tools: bool,
    immutable: bool,
    opaque: bool,
}
impl Scope {
    fn child(self, parent: &str, field: &str, kind: u8) -> Self {
        let tools = self.tools || field == "tools";
        let schema_value =
            self.schema && matches!(field, "default" | "example" | "examples" | "const" | "enum");
        let schema = !schema_value
            && (self.schema
                || kind == b'{'
                    && (matches!(field, "schema" | "json_schema")
                        || tools && matches!(field, "parameters" | "input_schema")));
        // A nested property starts its own value semantics. A parent named password
        // must not make boolean/encoding defaults in its child schema credentials.
        let property = if self.schema && parent == "properties" {
            credential_field(field)
        } else {
            self.property
        };
        let credential = kind != b'k'
            && (self.credential || !schema && credential_field(field) || property && schema_value);
        let opaque = self.opaque
            || matches!(
                field,
                "thinking" | "signature" | "encrypted_content" | "redacted_thinking"
            );
        let immutable = self.immutable
            || kind == b'k'
            || opaque
            || tools && field == "format"
            || schema && matches!(field, "pattern" | "required" | "type")
            || self.schema && matches!(field, "const" | "enum")
            || matches!(
                field,
                "type"
                    | "name"
                    | "id"
                    | "call_id"
                    | "tool_use_id"
                    | "model"
                    | "previous_response_id"
                    | "conversation"
            );
        Self {
            credential,
            schema,
            property,
            tools,
            immutable,
            opaque,
        }
    }
}

pub(crate) struct Candidate {
    pub id: String,
    pub location: String,
    pub node_start: u64,
    pub start: usize,
    pub end: usize,
    pub raw_start: u64,
    pub raw_end: u64,
    pub depth: usize,
    pub original: String,
    catalog_value: Option<String>,
    pub evidence: &'static str,
    pub source: &'static str,
    pub credential_type: &'static str,
    pub value_type: &'static str,
    pub match_policy: MatchPolicy,
    pub strong: bool,
    pub role: &'static str,
    pub blocked: Option<&'static str>,
}
impl Candidate {
    pub fn credential(&self) -> Credential {
        Credential {
            value: self
                .catalog_value
                .clone()
                .unwrap_or_else(|| self.original.clone()),
            evidence: self.evidence,
            credential_type: self.credential_type,
            match_policy: self.match_policy,
        }
    }
    pub fn fact(&self, snapshot: &str) -> Value {
        json!({"candidateId":self.id,"snapshotId":snapshot,"ruleVersion":VERSION,
            "evidenceClass":self.evidence,"confidence":if self.strong {"strong"} else {"low"},
            "valueType":self.value_type,"source":self.source,"credentialType":self.credential_type,"matchPolicy":self.match_policy.name(),"payloadRole":self.role,"location":self.location,
            "start":self.start,"end":self.end,"unit":"decoded_utf8_bytes",
            "rawStart":self.raw_start,"rawEnd":self.raw_end,"rawUnit":"utf8_bytes","encodingDepth":self.depth})
    }
}
pub(crate) struct Detection {
    pub snapshot_id: String,
    pub candidates: Vec<Candidate>,
    pub complete: bool,
    pub reason: Option<String>,
    pub catalog_version: String,
    marks: BTreeMap<u64, Vec<Value>>,
    _memory: Reservation,
}
impl Detection {
    pub fn summary(&self) -> Value {
        json!({"snapshotId":self.snapshot_id,"ruleVersion":VERSION,"catalogVersion":self.catalog_version,
            "candidateCount":self.candidates.len(),"strongCount":self.candidates.iter().filter(|c|c.strong).count(),
            "lowConfidenceCount":self.candidates.iter().filter(|c|!c.strong).count(),
            "detectionRuns":1,"coverage":if self.complete {"complete"} else {"partial"},"coverageReason":self.reason})
    }
    pub fn marks(&self, at: u64) -> &[Value] {
        self.marks.get(&at).map(Vec::as_slice).unwrap_or(&[])
    }
    pub fn learn(&self, redactor: &mut Redactor) {
        for c in self.candidates.iter().filter(|c| c.strong) {
            redactor.trust(&c.credential());
            if c.catalog_value.as_ref().is_some_and(|v| *v != c.original) {
                let mut spelling = c.credential();
                spelling.value = c.original.clone();
                spelling.match_policy = MatchPolicy::CompleteValue;
                redactor.trust(&spelling);
            }
        }
    }
}
pub(crate) const AUDIT_POLICY_VERSION: &str = "audit-4";
/// Classification consumes frozen facts; it does not extract or learn candidates.
pub(crate) fn audit_finding(finding: &mut Value, facts: Vec<Value>) {
    if facts.is_empty() {
        return;
    }
    let strong = facts.iter().any(|f| f["confidence"] == "strong");
    let known = facts
        .iter()
        .any(|f| f["evidenceClass"] == "known_credential");
    let explicit = facts.iter().any(|f| {
        matches!(
            f["source"].as_str(),
            Some(
                "json_field"
                    | "authorization_field"
                    | "authorization_header"
                    | "cookie_pair"
                    | "url_query"
                    | "url_userinfo"
                    | "source_assignment"
                    | "environment_assignment"
            )
        ) && f["confidence"] == "strong"
    });
    finding["confidence"] = json!(if strong { "high" } else { "low" });
    finding["confidenceReason"] = json!(if known {
        "known_credential_match"
    } else if explicit {
        "credential_value_context"
    } else if strong {
        "credential_format_evidence"
    } else {
        "credential_candidate_unverified"
    });
    finding["auditPolicyVersion"] = json!(AUDIT_POLICY_VERSION);
    finding["auditDecision"] = json!(if strong {
        "credential_warning"
    } else {
        "candidate_notice"
    });
    finding["evidence"]["credentialCandidates"] = json!(facts);
}
struct Frame {
    value: String,
    scalar: bool,
    field: String,
    path: String,
    scope: Scope,
    memory: Reservation,
}
struct Scan<'a> {
    source: &'a Arc<Spool>,
    redactor: &'a Redactor,
    stack: Vec<Frame>,
    candidates: Vec<Candidate>,
    memory: Reservation,
}
struct Hit {
    start: usize,
    end: usize,
    original: String,
    catalog_value: Option<String>,
    scope: Scope,
    depth: usize,
    evidence: &'static str,
    source: &'static str,
    credential_type: &'static str,
    value_type: &'static str,
    match_policy: MatchPolicy,
    scalar: bool,
}
fn extract(
    value: &str,
    scope: Scope,
    field: &str,
    depth: usize,
    redactor: &Redactor,
) -> Result<Vec<Hit>> {
    if depth > 4 {
        bail!("protection_nested_json_limit");
    }
    if value.trim_start().starts_with(['{', '[']) {
        struct Nested<'a> {
            stack: Vec<Frame>,
            hits: Vec<Hit>,
            scope: Scope,
            value: &'a str,
            redactor: &'a Redactor,
            depth: usize,
            memory: Reservation,
        }
        impl Visitor for Nested<'_> {
            fn start(&mut self, path: &str, field: &str, kind: u8, _: u64) -> Result<()> {
                let scope = self
                    .stack
                    .last()
                    .map_or(self.scope, |p| p.scope.child(&p.field, field, kind));
                self.stack.push(Frame {
                    value: String::new(),
                    field: field.into(),
                    path: path.into(),
                    scope,
                    scalar: false,
                    memory: Reservation::memory(),
                });
                Ok(())
            }
            fn text(&mut self, text: &str) -> Result<()> {
                let f = self.stack.last_mut().unwrap();
                f.memory.grow(text.len() * 4)?;
                f.value.push_str(text);
                Ok(())
            }
            fn scalar(&mut self, text: &str) -> Result<()> {
                self.text(text)?;
                self.stack.last_mut().unwrap().scalar = true;
                Ok(())
            }
            fn end(&mut self, node: &Node) -> Result<()> {
                let f = self.stack.pop().unwrap();
                if matches!(node.kind, b'"' | b'k')
                    || f.scalar && f.scope.credential && f.value != "null"
                {
                    let mut hits = if f.scalar {
                        vec![Hit {
                            start: 0,
                            end: f.value.len(),
                            original: f.value.clone(),
                            catalog_value: None,
                            scope: f.scope,
                            depth: self.depth + 1,
                            evidence: "credential_field",
                            source: "json_field",
                            credential_type: credential_type(&f.field),
                            value_type: "non_string",
                            match_policy: MatchPolicy::CompleteValue,
                            scalar: true,
                        }]
                    } else {
                        extract(&f.value, f.scope, &f.field, self.depth + 1, self.redactor)?
                    };
                    for hit in &mut hits {
                        if !f.scalar {
                            (hit.start, hit.end) = range_offsets(
                                &self.value[node.start as usize..node.end as usize],
                                hit.start,
                                hit.end,
                            )?;
                        }
                        hit.start += node.start as usize;
                        hit.end += node.start as usize;
                        self.memory.grow(hit.original.len() * 4 + 512)?;
                    }
                    self.hits.extend(hits);
                }
                Ok(())
            }
        }
        let mut nested = Nested {
            stack: Vec::new(),
            hits: Vec::new(),
            scope,
            value,
            redactor,
            depth,
            memory: Reservation::memory(),
        };
        let parsed = JsonStream::new(value.as_bytes()).one_item(&mut nested, "nested", field);
        if parsed.is_ok() {
            return Ok(nested.hits);
        }
        if parsed.as_ref().is_err_and(|e| {
            e.to_string().contains("shared_resource_budget")
                || e.to_string().contains("nested_json_limit")
        }) {
            parsed?;
        }
    }
    let field = scope.credential.then_some(if credential_field(field) {
        field
    } else {
        "password"
    });
    Ok(redactor
        .credential_hits(value, field)
        .into_iter()
        .map(|s| Hit {
            start: s.start,
            end: s.end,
            original: value[s.start..s.end].into(),
            catalog_value: s.decoded,
            scope,
            depth,
            evidence: s.reason,
            source: s.source,
            credential_type: s.credential_type,
            value_type: s.value_type,
            match_policy: s.match_policy,
            scalar: false,
        })
        .collect())
}
// Sparse translation: ordinary long text never needs a byte-per-byte offset table.
fn range_offsets(raw: &str, start: usize, end: usize) -> Result<(usize, usize)> {
    let mut at = 1;
    let mut decoded = 0;
    let mut from = None;
    while decoded < end {
        if decoded == start {
            from = Some(at);
        }
        let next = if raw.as_bytes()[at] == b'\\' {
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
        decoded += if raw.as_bytes()[at] == b'\\' {
            let value: String = serde_json::from_str(&format!("\"{}\"", &raw[at..next]))?;
            value.len()
        } else {
            next - at
        };
        at = next;
    }
    Ok((
        from.ok_or_else(|| anyhow::anyhow!("invalid_credential_boundary"))?,
        at,
    ))
}
impl Visitor for Scan<'_> {
    fn start(&mut self, path: &str, field: &str, kind: u8, _: u64) -> Result<()> {
        let scope = self.stack.last().map_or_else(
            || Scope::default().child("", field, kind),
            |p| p.scope.child(&p.field, field, kind),
        );
        self.stack.push(Frame {
            value: String::new(),
            field: field.into(),
            path: path.into(),
            scope,
            scalar: false,
            memory: Reservation::memory(),
        });
        Ok(())
    }
    fn text(&mut self, text: &str) -> Result<()> {
        let f = self.stack.last_mut().unwrap();
        f.memory.grow(text.len().saturating_mul(4))?;
        f.value.push_str(text);
        Ok(())
    }
    fn scalar(&mut self, text: &str) -> Result<()> {
        self.text(text)?;
        self.stack.last_mut().unwrap().scalar = true;
        Ok(())
    }
    fn end(&mut self, node: &Node) -> Result<()> {
        let f = self.stack.pop().unwrap();
        if f.field == "type" && matches!(f.value.as_str(), "thinking" | "redacted_thinking") {
            if let Some(parent) = self.stack.last_mut() {
                parent.scope.opaque = true;
                parent.scope.immutable = true;
            }
        }
        if f.scope.opaque && matches!(node.kind, b'{' | b'[') {
            for c in self
                .candidates
                .iter_mut()
                .filter(|c| c.raw_start >= node.start && c.raw_end <= node.end)
            {
                c.blocked = Some("protection_signed_or_opaque_content");
                c.role = "opaque";
            }
        }
        if !matches!(node.kind, b'"' | b'k')
            && !(f.scalar && f.scope.credential && f.value != "null")
        {
            return Ok(());
        }
        let mut raw = String::new();
        let mut reader = self.source.reader();
        reader.seek(SeekFrom::Start(node.start))?;
        reader
            .take(node.end - node.start)
            .read_to_string(&mut raw)?;
        let hits = if f.scalar {
            vec![Hit {
                start: 0,
                end: f.value.len(),
                original: f.value.clone(),
                catalog_value: None,
                scope: f.scope,
                depth: 0,
                evidence: "credential_field",
                source: "json_field",
                credential_type: credential_type(&f.field),
                value_type: "non_string",
                match_policy: MatchPolicy::CompleteValue,
                scalar: true,
            }]
        } else {
            extract(&f.value, f.scope, &f.field, 0, self.redactor)?
        };
        for hit in hits {
            let strong = strong_evidence(hit.evidence);
            let blocked = if hit.scalar {
                Some("protection_non_string_credential")
            } else if hit.scope.opaque {
                Some("protection_signed_or_opaque_content")
            } else if node.kind == b'k' {
                Some("protection_credential_in_key")
            } else if hit.scope.immutable {
                Some("protection_credential_in_protocol_structure")
            } else {
                None
            };
            let (raw_start, raw_end) = if f.scalar {
                (hit.start, hit.end)
            } else {
                range_offsets(&raw, hit.start, hit.end)?
            };
            self.memory.grow(
                hit.original
                    .len()
                    .saturating_add(hit.catalog_value.as_ref().map_or(0, String::len))
                    .saturating_mul(12)
                    .saturating_add(f.path.len() * 8 + 1024),
            )?;
            self.candidates.push(Candidate {
                id: String::new(),
                location: f.path.clone(),
                node_start: node.start,
                start: hit.start,
                end: hit.end,
                raw_start: node.start + raw_start as u64,
                raw_end: node.start + raw_end as u64,
                depth: hit.depth,
                original: hit.original,
                catalog_value: hit.catalog_value,
                evidence: hit.evidence,
                source: hit.source,
                credential_type: hit.credential_type,
                value_type: hit.value_type,
                match_policy: hit.match_policy,
                strong,
                role: if hit.scope.opaque {
                    "opaque"
                } else if hit.scope.immutable {
                    "protocol_structure"
                } else {
                    "content"
                },
                blocked,
            });
        }
        Ok(())
    }
}
/// Metadata pass only; it does not detect or learn credentials.
pub(crate) fn identify(source: &Arc<Spool>, record: &mut Value) -> Result<()> {
    struct Identity<'a> {
        capture: session::Capture,
        record: &'a mut Value,
    }
    impl Visitor for Identity<'_> {
        fn start(&mut self, _: &str, field: &str, kind: u8, _: u64) -> Result<()> {
            self.capture.start(field, kind);
            Ok(())
        }
        fn text(&mut self, text: &str) -> Result<()> {
            self.capture.text(text);
            Ok(())
        }
        fn end(&mut self, _: &Node) -> Result<()> {
            self.capture.end(self.record, "request");
            Ok(())
        }
    }
    JsonStream::new(source.reader()).parse(
        &mut Identity {
            capture: session::Capture::default(),
            record,
        },
        "request",
    )
}
pub(crate) fn detect(
    source: &Arc<Spool>,
    secrets: &Value,
    trusted: &[Credential],
) -> Arc<Detection> {
    detect_snapshot(source, secrets, trusted, "request")
}
pub(crate) fn detect_snapshot(
    source: &Arc<Spool>,
    secrets: &Value,
    trusted: &[Credential],
    root: &str,
) -> Arc<Detection> {
    let mut redactor = Redactor::new(secrets);
    for value in trusted {
        redactor.trust(value);
    }
    let catalog_version = redactor.catalog_digest();
    let mut complete = redactor.available();
    let mut reason = (!complete).then(|| "credential_catalog_budget".into());
    let mut candidates = Vec::new();
    #[derive(Clone, Copy)]
    struct Discovery {
        evidence: &'static str,
        source: &'static str,
        kind: &'static str,
        value_type: &'static str,
        policy: MatchPolicy,
    }
    let mut discovery: BTreeMap<(u64, u64), Discovery> = BTreeMap::new();
    let mut memory = Reservation::memory();
    // Bounded discovery, followed by a pass using a frozen strong-value directory.
    // Nothing learned from a weak candidate can affect this or a later request.
    for pass in 0..2 {
        let mut scan = Scan {
            source,
            redactor: &redactor,
            stack: Vec::new(),
            candidates: Vec::new(),
            memory: Reservation::memory(),
        };
        if let Err(e) = JsonStream::new(source.reader()).parse(&mut scan, root) {
            complete = false;
            reason = Some(e.to_string());
        }
        candidates = scan.candidates;
        memory = scan.memory;
        if pass == 1 {
            for c in &mut candidates {
                if let Some(fact) = discovery.get(&(c.raw_start, c.raw_end)) {
                    if !strong_evidence(fact.evidence) && c.strong {
                        continue; // Independently established catalog evidence may upgrade a shape.
                    }
                    c.evidence = fact.evidence;
                    c.source = fact.source;
                    c.credential_type = fact.kind;
                    c.value_type = fact.value_type;
                    c.match_policy = fact.policy;
                }
            }
        }
        if pass == 0 && complete {
            for c in &candidates {
                discovery.insert(
                    (c.raw_start, c.raw_end),
                    Discovery {
                        evidence: c.evidence,
                        source: c.source,
                        kind: c.credential_type,
                        value_type: c.value_type,
                        policy: c.match_policy,
                    },
                );
            }
            for candidate in candidates.iter().filter(|c| c.strong) {
                redactor.trust(&candidate.credential());
            }
            if !redactor.available() {
                complete = false;
                reason = Some("credential_catalog_budget".into());
            }
        }
        if !complete {
            break;
        }
    }
    candidates.sort_by_key(|c| (c.raw_start, c.raw_end));
    let snapshot_id = uuid::Uuid::new_v4().to_string();
    let mut marks: BTreeMap<u64, Vec<Value>> = BTreeMap::new();
    for (i, c) in candidates.iter_mut().enumerate() {
        c.id = format!("{snapshot_id}:{i}");
        marks
            .entry(c.node_start)
            .or_default()
            .push(json!({"reason":c.evidence,"start":c.start,"end":c.end,"candidateId":c.id}));
    }
    Arc::new(Detection {
        snapshot_id,
        candidates,
        complete,
        reason,
        catalog_version,
        marks,
        _memory: memory,
    })
}
// Decoded UTF-8 boundaries -> original JSON spelling, including surrogate pairs.
pub(crate) fn string_offsets(raw: &str) -> Result<Vec<usize>> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeSet, io::Write};
    fn source(raw: &str) -> Arc<Spool> {
        let mut s = Spool::new().unwrap();
        s.write_all(raw.as_bytes()).unwrap();
        s.seal().unwrap()
    }
    #[test]
    fn duplicates_and_nested_unicode_keep_distinct_original_ranges() {
        let raw = r#"{"input":"{\"password\":\"密🙂\",\"password\":\"hunter2\"}","password":"密🙂","password":"hunter2"}"#;
        let detection = detect(&source(raw), &json!({}), &[]);
        assert!(detection.complete);
        assert_eq!(detection.candidates.len(), 4);
        assert_eq!(
            detection
                .candidates
                .iter()
                .map(|c| c.id.as_str())
                .collect::<BTreeSet<_>>()
                .len(),
            4
        );
        for c in &detection.candidates {
            let spelling = &raw[c.raw_start as usize..c.raw_end as usize];
            assert_eq!(spelling, c.original);
            assert!(c.start < c.end);
        }
        assert_eq!(detection.candidates[0].depth, 1);
        assert_ne!(
            detection.candidates[2].location,
            detection.candidates[3].location
        );
    }
    #[test]
    fn configured_values_win_over_masks_but_weak_shapes_never_enter_directory() {
        let raw = r#"{"input":"[REDACTED] eyJnotJson.x.y","password":"[REDACTED]"}"#;
        let detection = detect(&source(raw), &json!({"saved":"[REDACTED]"}), &[]);
        assert_eq!(detection.candidates.iter().filter(|c| c.strong).count(), 2);
        let mut catalog = Redactor::new(&json!({}));
        detection.learn(&mut catalog);
        assert!(catalog
            .credential_spans("eyJnotJson.x.y", None)
            .iter()
            .all(|s| s.reason != "known_credential"));
    }
    #[test]
    fn order_does_not_promote_weak_source_values_or_change_literal_evidence() {
        for raw in [
            r#"{"input":"{api_key:plain}; plain_source","password":"plain"}"#,
            r#"{"password":"plain","input":"{api_key:plain}; plain_source"}"#,
        ] {
            let d = detect(&source(raw), &json!({}), &[]);
            assert!(d.complete);
            assert_eq!(d.candidates.len(), 1);
            assert_eq!(d.candidates[0].evidence, "credential_field");
        }
    }
    #[test]
    fn segmented_fields_and_lexical_context_do_not_match_non_value_names() {
        let fields = [
            "dbPassword",
            "database_password",
            "DB-PASSWORD",
            "stripeApiKey",
            "MY_ACCESS_TOKEN",
        ];
        for field in fields {
            assert!(credential_field(field), "{field}");
        }
        let fields = [
            "compassword",
            "notapassword",
            "monkey",
            "password_policy",
            "token_count",
            "secretRef",
            "accessTokenCount",
        ];
        for field in fields {
            assert!(!credential_field(field), "{field}");
        }
        let input = "const notapassword = \"visible\";\nconst pattern = /password=12345/;\ninterface Settings {\n password: \"visible\";\n token: string;\n}\nconst password: \"visible\" = value;\nif (password === \"visible\") {}\nconst token = \"part\" + variable;";
        let d = detect(&source(&json!({"input":input,"metadata":{"notapassword":"visible","password_policy":"visible"}}).to_string()), &json!({}), &[]);
        assert!(d.complete);
        assert!(
            d.candidates.is_empty(),
            "{:?}",
            d.candidates
                .iter()
                .map(|c| (&c.original, c.source))
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn source_spelling_and_decoded_catalog_values_are_distinct() {
        let input = r#"const password = "密\u7801\"abc"; const token = `fixedValue42`;"#;
        let d = detect(
            &source(&json!({"input":input}).to_string()),
            &json!({}),
            &[],
        );
        assert!(d.complete);
        assert_eq!(d.candidates.len(), 2);
        let c = &d.candidates[0];
        assert_eq!(c.original, r#"密\u7801\"abc"#);
        assert_eq!(c.credential().value, "密码\"abc");
        assert_eq!(c.fact(&d.snapshot_id)["source"], "source_assignment");
        let trusted = vec![c.credential()];
        let next = detect(
            &source(&json!({"input":"密码\"abc"}).to_string()),
            &json!({}),
            &trusted,
        );
        assert_eq!(next.candidates.len(), 1);
        assert_eq!(next.candidates[0].source, "trusted_catalog");
    }
    #[test]
    fn provenance_controls_matching_even_for_identical_values() {
        let value = "a1-b2-c3-d4";
        let raw =
            json!({"input":format!("prefix{value}suffix / {value}"),"other":value}).to_string();
        let trusted = vec![Credential {
            value: value.into(),
            evidence: "credential_field",
            credential_type: "password",
            match_policy: MatchPolicy::CredentialUnit,
        }];
        let d = detect(&source(&raw), &json!({}), &trusted);
        assert_eq!(
            d.candidates.len(),
            2,
            "learned values cannot cut through identifiers"
        );
        let registered = detect(&source(&raw), &json!({"saved":value}), &[]);
        assert_eq!(
            registered.candidates.len(),
            3,
            "registered spelling is authoritative"
        );
        let strict = vec![Credential {
            match_policy: MatchPolicy::CompleteValue,
            ..trusted[0].clone()
        }];
        let d = detect(&source(&raw), &json!({}), &strict);
        assert_eq!(d.candidates.len(), 1);
        assert_ne!(d.catalog_version, registered.catalog_version);
    }
    #[test]
    fn undecodable_literals_are_low_confidence_and_never_learned() {
        for input in [
            r#"const password = "prefix\x21";"#,
            r#"const password = "unfinished"#,
        ] {
            let d = detect(
                &source(&json!({"input":input}).to_string()),
                &json!({}),
                &[],
            );
            assert!(d.complete);
            assert_eq!(d.candidates.len(), 1);
            assert!(!d.candidates[0].strong);
            assert_eq!(d.candidates[0].value_type, "unknown");
            let mut catalog = Redactor::new(&json!({}));
            d.learn(&mut catalog);
            assert!(catalog.catalog().is_empty());
        }
    }
    #[test]
    fn long_ordinary_text_has_no_credential_candidates() {
        let raw = json!({"input":format!("temporary-storage-plaintext-sentinel{}", "a".repeat(192*1024))}).to_string();
        assert!(detect(&source(&raw), &json!({}), &[]).candidates.is_empty());
    }
    #[test]
    fn jwt_shape_requires_independent_authentication_evidence_to_become_strong() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.q7M2rX9hK5zT8pB4";
        let d = detect(&source(&json!({"input":format!("Review {jwt}"),"metadata":{"authorization":format!("Bearer {jwt}")}}).to_string()), &json!({}), &[]);
        assert!(d.candidates.iter().all(|c| c.strong));
        assert_eq!(d.candidates.len(), 2);
        assert_eq!(d.candidates[0].source, "trusted_catalog");
        assert_eq!(d.candidates[1].source, "authorization_field");
    }
}
