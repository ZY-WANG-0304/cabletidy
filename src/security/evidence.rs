//! Read-only evidence matching and display coordinates. Never change stored evidence.
use crate::config::{array, text};
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_EVIDENCE_BYTES: usize = 8 * 1024 * 1024;

struct Span {
    start: usize,
    end: usize,
    value: Value,
    children: BTreeMap<String, Span>,
}
fn parse_span(input: &str) -> Result<Span> {
    let _: Value = serde_json::from_str(input)?;
    fn skip(bytes: &[u8], at: &mut usize) {
        while bytes.get(*at).is_some_and(u8::is_ascii_whitespace) {
            *at += 1;
        }
    }
    fn string_end(bytes: &[u8], at: &mut usize) {
        *at += 1;
        while *at < bytes.len() {
            match bytes[*at] {
                b'\\' => *at += 2,
                b'"' => {
                    *at += 1;
                    break;
                }
                _ => *at += 1,
            }
        }
    }
    fn read(input: &str, at: &mut usize, depth: usize) -> Result<Span> {
        if depth > 128 {
            bail!("evidence_depth_limit");
        }
        let bytes = input.as_bytes();
        skip(bytes, at);
        let start = *at;
        let mut children = BTreeMap::new();
        match bytes[*at] {
            b'{' | b'[' => {
                let object = bytes[*at] == b'{';
                let close = if object { b'}' } else { b']' };
                *at += 1;
                skip(bytes, at);
                let mut index = 0;
                while bytes[*at] != close {
                    let key = if object {
                        let begin = *at;
                        string_end(bytes, at);
                        let key: String = serde_json::from_str(&input[begin..*at])?;
                        skip(bytes, at);
                        *at += 1;
                        key
                    } else {
                        index.to_string()
                    };
                    let child = read(input, at, depth + 1)?;
                    children.insert(key, child);
                    index += 1;
                    skip(bytes, at);
                    if bytes[*at] == b',' {
                        *at += 1;
                        skip(bytes, at);
                    } else {
                        break;
                    }
                }
                *at += 1;
            }
            b'"' => string_end(bytes, at),
            _ => {
                while bytes
                    .get(*at)
                    .is_some_and(|b| !b.is_ascii_whitespace() && !b",]}".contains(b))
                {
                    *at += 1;
                }
            }
        }
        let value = serde_json::from_str(&input[start..*at])?;
        let string = matches!(value, Value::String(_));
        Ok(Span {
            start: start + usize::from(string),
            end: *at - usize::from(string),
            value,
            children,
        })
    }
    read(input, &mut 0, 0)
}
fn matches(node: &Span, value: &Value, projection: bool) -> bool {
    match value {
        Value::Object(fields) => {
            node.value.is_object()
                && (projection || node.children.len() == fields.len())
                && fields
                    .iter()
                    .all(|(k, v)| node.children.get(k).is_some_and(|n| matches(n, v, false)))
        }
        Value::Array(values) => {
            node.value.is_array()
                && node.children.len() == values.len()
                && values.iter().enumerate().all(|(i, v)| {
                    node.children
                        .get(&i.to_string())
                        .is_some_and(|n| matches(n, v, false))
                })
        }
        _ => node.value == *value,
    }
}
fn escaped_offsets(input: &str, start: usize, end: usize) -> Vec<usize> {
    let mut offsets = vec![start];
    let mut at = start;
    while at < end {
        if input.as_bytes()[at] == b'\\' {
            let len = if input.as_bytes().get(at + 1) == Some(&b'u') {
                6
            } else {
                2
            };
            let decoded: String =
                serde_json::from_str(&format!("\"{}\"", &input[at..(at + len).min(end)]))
                    .unwrap_or_default();
            if decoded.is_empty() && len == 6 {
                // A surrogate pair is one scalar and four UTF-8 bytes.
                if at + 12 <= end {
                    at += 12;
                    for _ in 0..4 {
                        offsets.push(at);
                    }
                    continue;
                }
            }
            at += len;
            for _ in 0..decoded.len() {
                offsets.push(at);
            }
        } else {
            let len = input[at..].chars().next().unwrap().len_utf8();
            at += len;
            for _ in 0..len {
                offsets.push(at);
            }
        }
    }
    offsets
}
fn utf16(input: &str, byte: usize) -> usize {
    let mut byte = byte.min(input.len());
    while !input.is_char_boundary(byte) {
        byte -= 1;
    }
    input[..byte].encode_utf16().count()
}
fn range(input: &str, start: usize, end: usize, id: &str) -> Value {
    json!({"start":utf16(input,start),"end":utf16(input,end),"findingId":id})
}

pub fn content_ranges(input: &str, evidence: &Value, id: &str, structured: bool) -> Value {
    let raws: Vec<_> = if evidence.is_array() {
        array(evidence).iter().filter_map(Value::as_str).collect()
    } else {
        evidence.as_str().into_iter().collect()
    };
    let mut ranges = Vec::new();
    if structured {
        for raw in raws {
            let expected = serde_json::from_str(raw).unwrap_or_else(|_| json!(raw));
            if expected.as_str() == Some(input) {
                ranges.push(range(input, 0, input.len(), id));
                continue;
            }
            let Ok(root) = parse_span(input) else {
                continue;
            };
            let kind = text(&root.value["type"]);
            let node = if [
                "function_call",
                "custom_tool_call",
                "tool_use",
                "server_tool_use",
            ]
            .contains(&kind)
            {
                root.children.get(if kind == "function_call" {
                    "arguments"
                } else {
                    "input"
                })
            } else {
                Some(&root)
            };
            let Some(node) = node else {
                continue;
            };
            let inner = node
                .value
                .as_str()
                .filter(|_| !expected.is_string() || kind == "function_call")
                .and_then(|v| parse_span(v).ok());
            let offsets = inner
                .as_ref()
                .map(|_| escaped_offsets(input, node.start, node.end));
            let current = inner.as_ref().unwrap_or(node);
            if !matches(current, &expected, true) {
                continue;
            }
            let hits: Vec<_> = if let Value::Object(fields) = &expected {
                fields
                    .keys()
                    .filter_map(|k| current.children.get(k))
                    .collect()
            } else {
                vec![current]
            };
            for hit in hits {
                let position = |at| {
                    offsets
                        .as_ref()
                        .and_then(|o| o.get(at))
                        .copied()
                        .unwrap_or(at)
                };
                let start = position(hit.start);
                let end = position(hit.end);
                if end > start {
                    ranges.push(range(input, start, end, id));
                }
            }
        }
    } else {
        fn collect(value: &Value, out: &mut BTreeSet<String>) {
            match value {
                Value::String(s) if !s.is_empty() => {
                    out.insert(s.clone());
                }
                Value::Array(_) | Value::Object(_) => {
                    out.insert(value.to_string());
                    out.insert(serde_json::to_string_pretty(value).unwrap());
                    for v in value.as_array().map(Vec::as_slice).unwrap_or(&[]) {
                        collect(v, out);
                    }
                    if let Some(m) = value.as_object() {
                        for v in m.values() {
                            collect(v, out);
                        }
                    }
                }
                _ => {}
            }
        }
        let mut candidates = BTreeSet::new();
        for raw in raws {
            if raw.is_empty() {
                continue;
            }
            candidates.insert(raw.into());
            if let Ok(v) = serde_json::from_str(raw) {
                collect(&v, &mut candidates);
            }
            if let Ok(v) = serde_json::from_str(&format!("\"{raw}\"")) {
                collect(&v, &mut candidates);
            }
        }
        let mut candidates: Vec<_> = candidates.into_iter().collect();
        candidates.sort_by_key(|s| std::cmp::Reverse(s.len()));
        for candidate in candidates {
            for (start, _) in input.match_indices(&candidate) {
                let end = start + candidate.len();
                let r = range(input, start, end, id);
                if !ranges.iter().any(|p: &Value| {
                    p["start"].as_u64() <= r["start"].as_u64()
                        && p["end"].as_u64() >= r["end"].as_u64()
                }) {
                    ranges.push(r);
                }
            }
        }
    }
    json!(ranges)
}

pub fn associated(finding: &Value, item: &Value, response: bool) -> bool {
    let r = &finding["evidence"]["bodyRef"];
    if !r.is_object() {
        return false;
    }
    let source = r.get("sourceSnapshotId").unwrap_or(&r["snapshotId"]);
    if response && array(&item["contentSnapshotIds"]).contains(source) {
        return true;
    }
    let start = r.get("sourceStart").unwrap_or(&r["start"]).as_u64();
    let end = r.get("sourceEnd").unwrap_or(&r["end"]).as_u64();
    source == if response { "response" } else { "request" }
        && start
            .zip(end)
            .zip(item["start"].as_u64().zip(item["end"].as_u64()))
            .is_some_and(|((start, end), (left, right))| start < end && start < right && end > left)
}
fn readable(raw: &Value) -> String {
    let joined = if raw.is_array() {
        array(raw)
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        text(raw).into()
    };
    if let Ok(v) = serde_json::from_str::<Value>(&joined) {
        v.as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| serde_json::to_string_pretty(&v).unwrap())
    } else {
        serde_json::from_str::<String>(&format!("\"{joined}\"")).unwrap_or(joined)
    }
}
pub fn annotate_item(
    item: &mut Value,
    findings: &[Value],
    evidence: &BTreeMap<String, Value>,
    response: bool,
) {
    let matched: Vec<_> = findings
        .iter()
        .filter(|f| associated(f, item, response))
        .collect();
    item["findingIds"] = json!(matched.iter().map(|f| &f["id"]).collect::<Vec<_>>());
    let mut versions = Vec::new();
    let mut fields = Map::new();
    for field in ["preview", "structure"] {
        fields.insert(
            field.into(),
            json!(matched
                .iter()
                .flat_map(|f| {
                    let raw = evidence.get(text(&f["id"])).unwrap_or(&Value::Null);
                    array(&content_ranges(
                        text(&item[field]),
                        raw,
                        text(&f["id"]),
                        item["kind"] == "tool_call" && f["ruleId"] != "SEC-SECRET-001",
                    ))
                    .to_vec()
                })
                .collect::<Vec<_>>()),
        );
    }
    for finding in matched {
        let id = text(&finding["id"]);
        let hit = fields
            .values()
            .any(|rs| array(rs).iter().any(|r| r["findingId"] == id));
        if !hit {
            if let Some(raw) = evidence
                .get(id)
                .filter(|v| !v.is_null() && *v != "" && !v.as_array().is_some_and(Vec::is_empty))
            {
                versions.push(json!({"findingId":id,"text":readable(raw),"toolArguments":item["kind"]=="tool_call"&&finding["ruleId"]!="SEC-SECRET-001"}));
            }
        }
    }
    item["riskRanges"] = Value::Object(fields);
    item["riskVersions"] = json!(versions);
    item["riskGaps"] = json!(matched_missing_ids(item, evidence));
}

fn matched_missing_ids(item: &Value, evidence: &BTreeMap<String, Value>) -> Vec<Value> {
    array(&item["findingIds"])
        .iter()
        .filter(|id| {
            evidence
                .get(text(id))
                .is_none_or(|v| v.is_null() || v == "" || v.as_array().is_some_and(Vec::is_empty))
        })
        .cloned()
        .collect()
}

pub fn canonical_snapshot(id: &str) -> &str {
    if ["request", "request/headers", "response", "response/headers"].contains(&id) {
        id
    } else if id.starts_with("request") {
        "request"
    } else if id.starts_with("response") || id.starts_with("stream/") {
        "response"
    } else {
        id
    }
}
pub fn body_location(finding: &Value) -> Value {
    let r = &finding["evidence"]["bodyRef"];
    if !r.is_object() {
        return json!({"snapshotId":"unavailable"});
    }
    let source = r.get("sourceSnapshotId").unwrap_or(&r["snapshotId"]);
    let source = text(source);
    let snapshot = canonical_snapshot(source);
    let mapped = snapshot != text(&r["snapshotId"]);
    let unrelated = snapshot != source;
    let mut result = r.clone();
    if result["location"].is_null() {
        result["location"] = finding["evidence"]["location"].clone();
    }
    result["snapshotId"] = json!(snapshot);
    result["findingId"] = finding["id"].clone();
    if mapped {
        result["detectionSnapshotId"] = r["snapshotId"].clone();
        result["detectionStart"] = r["start"].clone();
        result["detectionEnd"] = r["end"].clone();
    }
    if mapped && !r["sourceStart"].is_null() {
        result["start"] = r["sourceStart"].clone();
        result["end"] = r["sourceEnd"].clone();
    } else if mapped && unrelated {
        result.as_object_mut().unwrap().remove("start");
        result.as_object_mut().unwrap().remove("end");
        result["hitUnavailable"] = json!(true);
    }
    result
}
pub fn risk_selections(findings: &[Value], snapshot: &str) -> Value {
    json!(findings
        .iter()
        .filter_map(|f| {
            let r = &f["evidence"]["bodyRef"];
            if !r.is_object() || f["ruleId"] == "SEC-SECRET-001" && r["matchKind"] != "sensitive" {
                return None;
            }
            let mut range = if r["snapshotId"] == snapshot
                || r["sourceSnapshotId"] == snapshot && r["sourceStart"].is_null()
            {
                r.clone()
            } else if r["sourceSnapshotId"] == snapshot {
                json!({"start":r["sourceStart"],"end":r["sourceEnd"]})
            } else {
                return None;
            };
            range["location"] = r
                .get("location")
                .unwrap_or(&f["evidence"]["location"])
                .clone();
            Some(range)
        })
        .collect::<Vec<_>>())
}

/// Preserve legacy field order while returning bytes and a structural path index.
pub fn legacy_text(body: &Value, root: &str, field_order: &Value) -> Value {
    fn walk(
        value: &Value,
        path: &str,
        depth: usize,
        order: &Value,
        out: &mut String,
        locations: &mut Vec<Value>,
    ) {
        let start = out.len();
        if value.is_object() || value.is_array() {
            let list = value.is_array();
            out.push(if list { '[' } else { '{' });
            let keys: Vec<String> = if list {
                (0..array(value).len()).map(|i| i.to_string()).collect()
            } else if order[path].is_array() {
                array(&order[path])
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            } else {
                value.as_object().unwrap().keys().cloned().collect()
            };
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('\n');
                out.push_str(&"  ".repeat(depth + 1));
                let child = if list {
                    format!("{path}/{i}")
                } else {
                    format!("{path}/field/{i}")
                };
                if !list {
                    let start = out.len();
                    out.push_str(&json!(key).to_string());
                    locations
                        .push(json!({"path":format!("{child}/key"),"start":start,"end":out.len()}));
                    out.push_str(": ");
                }
                walk(
                    if list { &value[i] } else { &value[key] },
                    &child,
                    depth + 1,
                    order,
                    out,
                    locations,
                );
            }
            if !keys.is_empty() {
                out.push('\n');
                out.push_str(&"  ".repeat(depth));
            }
            out.push(if list { ']' } else { '}' });
        } else {
            out.push_str(&value.to_string());
        }
        locations.push(json!({"path":path,"start":start,"end":out.len()}));
    }
    let mut out = String::new();
    let mut locations = Vec::new();
    walk(body, root, 0, field_order, &mut out, &mut locations);
    json!({"text":out,"locations":locations})
}
pub fn structural_range(locations: &Value, location: &str) -> Option<Value> {
    array(locations)
        .iter()
        .filter(|r| {
            location == text(&r["path"]) || location.starts_with(&format!("{}/", text(&r["path"])))
        })
        .max_by_key(|r| text(&r["path"]).len())
        .cloned()
}
pub fn normalize_body(page: &mut Value, findings: &[Value], snapshot: &str) {
    let risks = risk_selections(findings, snapshot);
    if page["legacySnapshot"].is_object() {
        let manifest = &page["legacySnapshot"];
        let projection = legacy_text(
            &manifest["body"],
            manifest["root"].as_str().unwrap_or(snapshot),
            &manifest["fieldOrder"],
        );
        let locations = &projection["locations"];
        let marks = array(
            manifest
                .get("sensitiveRanges")
                .unwrap_or(&manifest["redactions"]),
        )
        .iter()
        .filter_map(|m| {
            structural_range(locations, text(&m["location"])).map(|mut range| {
                range["reason"] = m["reason"].clone();
                range["location"] = m["location"].clone();
                range
            })
        })
        .collect::<Vec<_>>();
        page["chunks"] = json!([{"start":0,"end":text(&projection["text"]).len(),"content":projection["text"],"sensitiveRanges":marks}]);
        page["locations"] = locations.clone();
        page["riskRanges"] = json!(array(&risks)
            .iter()
            .filter_map(|r| structural_range(locations, text(&r["location"])))
            .collect::<Vec<_>>());
    } else {
        page["riskRanges"] = risks;
    }
}

pub(super) fn findings(db: &Connection, audit: &str) -> Result<Vec<Value>> {
    let mut stmt = db.prepare("SELECT data FROM findings WHERE audit_id=? ORDER BY seq")?;
    let rows = stmt
        .query_map([audit], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|r| Ok(serde_json::from_str(&r)?))
        .collect()
}
fn evidence_text(
    db: &Connection,
    audit: &str,
    finding: &Value,
    cancelled: &dyn Fn() -> bool,
) -> Result<Value> {
    let r = &finding["evidence"]["bodyRef"];
    let start = r["start"].as_u64().unwrap_or(0);
    let end = r["end"].as_u64().unwrap_or(0);
    let snapshot = text(&r["snapshotId"]);
    if end.saturating_sub(start) > MAX_EVIDENCE_BYTES as u64 {
        return Ok(Value::Null);
    }
    let mut offset = start.saturating_sub(512);
    let mut raw = String::new();
    let mut next = start;
    loop {
        if cancelled() {
            bail!("overview_cancelled");
        }
        let mut page = super::store::read_body_page(db, audit, snapshot, offset)?;
        if page.is_null() {
            return Ok(Value::Null);
        }
        if page["legacySnapshot"].is_object() {
            normalize_body(&mut page, &[], snapshot);
            let location = r
                .get("location")
                .unwrap_or(&finding["evidence"]["location"]);
            let range = structural_range(&page["locations"], text(location));
            return Ok(range
                .map(|r| {
                    json!(
                        &text(&page["chunks"][0]["content"])[r["start"].as_u64().unwrap() as usize
                            ..r["end"].as_u64().unwrap() as usize]
                    )
                })
                .unwrap_or(Value::Null));
        }
        if finding["ruleId"] == "SEC-SECRET-001" && r["matchKind"] != "sensitive" {
            let mut hits = Vec::new();
            let mut seen = BTreeSet::new();
            for chunk in array(&page["chunks"]) {
                for mark in array(&chunk["sensitiveRanges"])
                    .iter()
                    .chain(array(&chunk["redactions"]))
                {
                    if endpoint_or_gap(text(&mark["reason"])) {
                        continue;
                    }
                    if mark["start"].as_u64().unwrap_or(0) < end
                        && mark["end"].as_u64().unwrap_or(0) > start
                        && seen.insert((mark["start"].as_u64(), mark["end"].as_u64()))
                    {
                        let mut exact = finding.clone();
                        exact["evidence"]["bodyRef"]["start"] = mark["start"].clone();
                        exact["evidence"]["bodyRef"]["end"] = mark["end"].clone();
                        exact["evidence"]["bodyRef"]["matchKind"] = json!("sensitive");
                        let hit = evidence_text(db, audit, &exact, cancelled)?;
                        if !hit.is_null() {
                            hits.push(hit);
                        }
                    }
                }
            }
            if !hits.is_empty() {
                return Ok(json!(hits));
            }
        } else {
            for chunk in array(&page["chunks"]) {
                let at = chunk["start"].as_u64().unwrap_or(0);
                let from = next.max(at);
                let to = end.min(chunk["end"].as_u64().unwrap_or(at));
                if to > from {
                    if from > next {
                        return Ok(Value::Null);
                    }
                    if let Some(s) =
                        text(&chunk["content"]).get((from - at) as usize..(to - at) as usize)
                    {
                        raw.push_str(s);
                        next = to;
                    }
                }
            }
            if next >= end {
                return Ok(json!(raw));
            }
        }
        let Some(next_offset) = page["nextOffset"]
            .as_u64()
            .filter(|n| *n > offset && *n < end)
        else {
            return Ok(Value::Null);
        };
        offset = next_offset;
    }
}
pub fn endpoint_or_gap(reason: &str) -> bool {
    matches!(
        reason,
        "redaction_buffer_budget"
            | "url_authority_uncertain"
            | "credential_prefix_uncertain"
            | "incomplete_body_fragment"
            | "unsupported_stream_fragment"
            | "internal_host"
            | "public_host"
            | "internal_identity"
    )
}
pub(super) fn annotate_page(
    db: &Connection,
    audit: &str,
    page: &mut Value,
    response: bool,
    cancelled: &dyn Fn() -> bool,
) -> Result<()> {
    let findings = findings(db, audit)?;
    let mut evidence = BTreeMap::new();
    let mut bytes = 0;
    for item in array(&page["items"]) {
        for finding in findings.iter().filter(|f| associated(f, item, response)) {
            let id = text(&finding["id"]);
            if evidence.contains_key(id) {
                continue;
            }
            let value = evidence_text(db, audit, finding, cancelled)?;
            let size = value.to_string().len();
            let value = if bytes + size > MAX_EVIDENCE_BYTES {
                Value::Null
            } else {
                bytes += size;
                value
            };
            evidence.insert(id.into(), value);
        }
    }
    if let Some(items) = page["items"].as_array_mut() {
        for item in items {
            if cancelled() {
                bail!("overview_cancelled");
            }
            annotate_item(item, &findings, &evidence, response);
        }
    }
    Ok(())
}

pub fn normalize_record(record: &mut Value) {
    if let Some(findings) = record["findings"].as_array_mut() {
        for finding in findings {
            finding["bodyLocation"] = body_location(finding);
            let source = finding["evidence"]["bodyRef"]
                .get("sourceSnapshotId")
                .unwrap_or(&finding["evidence"]["bodyRef"]["snapshotId"]);
            finding["contentSide"] = json!(if canonical_snapshot(text(source))
                .starts_with("response")
                || text(&finding["evidenceStage"]).starts_with("response")
                || finding["evidenceStage"] == "tool_call_proposed"
            {
                "response"
            } else {
                "request"
            });
        }
    }
    if let Some(snapshots) = record["bodySnapshots"].as_array_mut() {
        for snapshot in snapshots {
            let original = canonical_snapshot(text(&snapshot["id"]));
            if original != text(&snapshot["id"]) {
                snapshot["originalSnapshotId"] = json!(original);
            }
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
pub fn fixture_projection(
    page: &Value,
    findings: &[Value],
    bodies: &Value,
    response: bool,
    finding: Option<&str>,
) -> Result<Value> {
    let db = Connection::open_in_memory()?;
    db.execute_batch("CREATE TABLE audit_snapshots(audit_id TEXT,id TEXT,data TEXT); CREATE TABLE audit_body_chunks(audit_id TEXT,snapshot_id TEXT,start INTEGER,end INTEGER,content TEXT,redactions TEXT); CREATE TABLE findings(seq INTEGER PRIMARY KEY,data TEXT,audit_id TEXT);")?;
    for (id, pages) in crate::config::entries(bodies) {
        for page in array(pages) {
            if page["legacySnapshot"].is_object() {
                db.execute(
                    "INSERT INTO audit_snapshots VALUES('test',?,?)",
                    params![id, page["legacySnapshot"].to_string()],
                )?;
                continue;
            }
            let end = array(&page["chunks"])
                .iter()
                .filter_map(|c| c["end"].as_u64())
                .max()
                .unwrap_or(0);
            db.execute(
                "INSERT INTO audit_snapshots VALUES('test',?,?)",
                params![
                    id,
                    json!({"id":id,"byteLength":end,"state":"complete"}).to_string()
                ],
            )?;
            for chunk in array(&page["chunks"]) {
                let start = chunk["start"].as_u64().unwrap_or(0);
                let content = text(&chunk["content"]);
                let mut marks = array(&chunk["redactions"]).to_vec();
                marks.extend(array(&chunk["sensitiveRanges"]).iter().map(|m| {
                    let mut m = m.clone();
                    m["kind"] = json!("sensitive");
                    m
                }));
                db.execute(
                    "INSERT INTO audit_body_chunks VALUES('test',?,?,?,?,?)",
                    params![
                        id,
                        start,
                        start + content.len() as u64,
                        content,
                        json!(marks).to_string()
                    ],
                )?;
            }
        }
    }
    for f in findings {
        db.execute(
            "INSERT INTO findings(data,audit_id) VALUES(?,'test')",
            [f.to_string()],
        )?;
    }
    let mut out = page.clone();
    if out["items"].is_array() {
        annotate_page(&db, "test", &mut out, response, &|| false)?;
    } else if let Some(id) = finding {
        if let Some(f) = findings.iter().find(|f| f["id"] == id) {
            out["findingSelection"] = credential_location(&db, "test", f)?;
        }
    }
    Ok(out)
}

pub(super) fn credential_location(db: &Connection, audit: &str, finding: &Value) -> Result<Value> {
    let mut selection = body_location(finding);
    let snapshot = text(&selection["snapshotId"]);
    let start = selection["start"].as_u64().unwrap_or(0);
    let end = selection["end"].as_u64().unwrap_or(0);
    if finding["ruleId"] != "SEC-SECRET-001" || selection["hitUnavailable"] == true {
        return Ok(selection);
    }
    if finding["evidence"]["bodyRef"]["matchKind"] == "sensitive" {
        selection["hitUnavailable"] = json!(false);
        return Ok(selection);
    }
    if !text(&selection["location"]).is_empty() {
        let mut page = super::store::read_body_page(db, audit, snapshot, start)?;
        if page["legacySnapshot"].is_object() {
            normalize_body(&mut page, &[], snapshot);
            if let Some(target) = structural_range(&page["locations"], text(&selection["location"]))
            {
                if let Some(mark) = array(&page["chunks"][0]["sensitiveRanges"])
                    .iter()
                    .find(|m| {
                        !endpoint_or_gap(text(&m["reason"]))
                            && m["start"].as_u64() < target["end"].as_u64()
                            && m["end"].as_u64() > target["start"].as_u64()
                    })
                {
                    selection["start"] = mark["start"].clone();
                    selection["end"] = mark["end"].clone();
                    selection["hitUnavailable"] = json!(false);
                    return Ok(selection);
                }
            }
            selection["hitUnavailable"] = json!(true);
            return Ok(selection);
        }
    }
    let mut stmt=db.prepare("SELECT redactions FROM audit_body_chunks WHERE audit_id=? AND snapshot_id=? AND end>? AND start<? ORDER BY start")?;
    let rows = stmt.query_map(params![audit, snapshot, start, end], |r| {
        r.get::<_, String>(0)
    })?;
    for row in rows {
        let marks: Value = serde_json::from_str(&row?)?;
        for mark in array(&marks) {
            if !endpoint_or_gap(text(&mark["reason"]))
                && mark["start"].as_u64().unwrap_or(0) < end
                && mark["end"].as_u64().unwrap_or(0) > start
            {
                selection["start"] = mark["start"].clone();
                selection["end"] = mark["end"].clone();
                selection["hitUnavailable"] = json!(false);
                return Ok(selection);
            }
        }
    }
    selection["hitUnavailable"] = json!(true);
    Ok(selection)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(start: usize, end: usize) -> Value {
        json!({"id":"risk","ruleId":"SEC-INJECT-001","evidence":{"bodyRef":{"snapshotId":"request","start":start,"end":end}}})
    }

    #[test]
    fn escaped_surrogate_pairs_keep_exact_utf16_field_ranges() {
        let input = r#"{"type":"function_call","arguments":"{\"cmd\":\"echo \\ud83d\\ude42; rm -rf /important\",\"note\":\"🙂\"}"}"#;
        let ranges = content_ranges(
            input,
            &json!(r#"{"cmd":"echo 🙂; rm -rf /important"}"#),
            "risk",
            true,
        );
        assert_eq!(array(&ranges).len(), 1);
        let hit = &ranges[0];
        let units: Vec<_> = input.encode_utf16().collect();
        let selected = String::from_utf16(
            &units[hit["start"].as_u64().unwrap() as usize..hit["end"].as_u64().unwrap() as usize],
        )
        .unwrap();
        assert_eq!(selected, r#"echo \\ud83d\\ude42; rm -rf /important"#);
        assert_eq!(utf16("🙂", 1), 0);
    }

    #[test]
    fn missing_gapped_and_oversized_evidence_preserves_content_without_false_hits() {
        let page = json!({"items":[{"start":0,"end":MAX_EVIDENCE_BYTES+10,"kind":"user","preview":"safe content"}]});
        for (f, bodies) in [
            (finding(0, 10), json!({})),
            (
                finding(0, 10),
                json!({"request":[{"chunks":[{"start":5,"end":10,"content":"safe "}]}]}),
            ),
            (finding(0, MAX_EVIDENCE_BYTES + 1), json!({})),
        ] {
            let projected = fixture_projection(&page, &[f], &bodies, false, None).unwrap();
            assert_eq!(projected["items"][0]["preview"], "safe content");
            assert_eq!(projected["items"][0]["findingIds"], json!(["risk"]));
            assert_eq!(projected["items"][0]["riskGaps"], json!(["risk"]));
            assert_eq!(projected["items"][0]["riskRanges"]["preview"], json!([]));
        }
    }

    #[test]
    fn historical_credential_marks_join_utf8_chunks_without_highlighting_context() {
        let secret = "秘密<&🙂";
        let prefix = "普通上下文 ";
        let content = format!("{prefix}{secret} tail");
        let split = prefix.len() + "秘密".len();
        let mark = json!({"start":prefix.len(),"end":prefix.len()+secret.len(),"reason":"known_credential","kind":"sensitive"});
        let f = json!({"id":"risk","ruleId":"SEC-SECRET-001","evidence":{"bodyRef":{"snapshotId":"request","start":0,"end":content.len()}}});
        let bodies = json!({"request":[{"chunks":[
            {"start":0,"end":split,"content":&content[..split],"redactions":[mark]},
            {"start":split,"end":content.len(),"content":&content[split..],"redactions":[mark]}
        ]}]});
        let page =
            json!({"items":[{"kind":"user","start":0,"end":content.len(),"preview":content}]});
        let projected = fixture_projection(&page, &[f.clone()], &bodies, false, None).unwrap();
        assert_eq!(
            array(&projected["items"][0]["riskRanges"]["preview"]).len(),
            1
        );
        assert_eq!(projected["items"][0]["riskGaps"], json!([]));
        let located = fixture_projection(&json!({}), &[f], &bodies, false, Some("risk")).unwrap();
        assert_eq!(located["findingSelection"]["start"], json!(prefix.len()));
        assert_eq!(
            located["findingSelection"]["end"],
            json!(prefix.len() + secret.len())
        );
        assert_eq!(located["findingSelection"]["hitUnavailable"], false);
    }

    #[test]
    fn legacy_order_and_locations_are_read_only_byte_projections() {
        let original = json!({"legacySnapshot":{"body":{"12":"🙂","z":"秘密"},"root":"request","fieldOrder":{"request":["z","12"]},"redactions":[{"location":"request/field/0","reason":"known_credential"}]}});
        let mut page = original.clone();
        normalize_body(&mut page, &[], "request");
        let text = text(&page["chunks"][0]["content"]);
        assert!(text.find("z").unwrap() < text.find("12").unwrap());
        let range = &page["chunks"][0]["sensitiveRanges"][0];
        assert_eq!(
            &text[range["start"].as_u64().unwrap() as usize
                ..range["end"].as_u64().unwrap() as usize],
            "\"秘密\""
        );
        assert_eq!(range["reason"], "known_credential");
        assert_eq!(page["legacySnapshot"], original["legacySnapshot"]);
        let f = json!({"id":"risk","ruleId":"SEC-SECRET-001","evidence":{"location":"request/field/0","bodyRef":{"snapshotId":"request"}}});
        let bodies = json!({"request":[original]});
        let located = fixture_projection(&page, &[f], &bodies, false, Some("risk")).unwrap();
        assert_eq!(located["findingSelection"]["hitUnavailable"], false);
        assert_eq!(located["findingSelection"]["start"], range["start"]);
        assert_eq!(located["findingSelection"]["end"], range["end"]);
    }

    #[test]
    fn cancellation_and_missing_coordinates_cannot_create_hits() {
        let db = Connection::open_in_memory().unwrap();
        let f = finding(0, 10);
        assert!(evidence_text(&db, "audit", &f, &|| true)
            .unwrap_err()
            .to_string()
            .contains("overview_cancelled"));
        let mut malformed = f;
        malformed["evidence"]["bodyRef"]
            .as_object_mut()
            .unwrap()
            .remove("start");
        assert!(!associated(&malformed, &json!({"start":0,"end":10}), false));
    }
}
