//! Read-only evidence matching and display coordinates. Never change stored evidence.
use crate::config::{array, text};
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_EVIDENCE_BYTES: usize = 8 * 1024 * 1024;

mod ranges;
pub use ranges::content_ranges;
use ranges::{Allocation, Limit, Request, Workspace};

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
fn bounded_readable(
    raw: &Value,
    workspace: &Workspace<'_>,
    output: &mut Allocation,
) -> Result<String> {
    workspace.check()?;
    let size = if raw.is_array() {
        array(raw).iter().map(|v| text(v).len() + 1).sum()
    } else {
        text(raw).len()
    };
    let mut memory = workspace.allocation();
    memory.grow(size.saturating_mul(16).saturating_add(256))?;
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
        if let Some(s) = v.as_str() {
            output.grow(s.len())?;
            return Ok(s.into());
        }
        return ranges::render(&v, true, workspace, output);
    }
    output.grow(joined.len().saturating_mul(2).saturating_add(2))?;
    Ok(serde_json::from_str::<String>(&format!("\"{joined}\"")).unwrap_or(joined))
}
fn missing_evidence(raw: &Value) -> bool {
    raw.is_null() || raw == "" || raw.as_array().is_some_and(Vec::is_empty)
}
fn annotate_item(
    item: &mut Value,
    findings: &[Value],
    evidence: &BTreeMap<String, Value>,
    response: bool,
    workspace: &Workspace<'_>,
    output: &mut Allocation,
) -> Result<()> {
    let count = findings
        .iter()
        .filter(|f| associated(f, item, response))
        .count();
    let mut memory = workspace.allocation();
    // The baseline IDs remain available even when the optional projection
    // cannot acquire its metadata workspace.
    if memory
        .grow(count.saturating_mul(std::mem::size_of::<Request<'_>>() + 256))
        .is_err()
    {
        item["findingIds"] = json!(findings
            .iter()
            .filter(|f| associated(f, item, response))
            .map(|f| &f["id"])
            .collect::<Vec<_>>());
        item["riskGaps"] = item["findingIds"].clone();
        item["riskRanges"] = json!({"preview":[],"structure":[]});
        item["riskVersions"] = json!([]);
        return Ok(());
    }
    let matched: Vec<_> = findings
        .iter()
        .filter(|f| associated(f, item, response))
        .collect();
    item["findingIds"] = json!(matched.iter().map(|f| &f["id"]).collect::<Vec<_>>());
    let requests: Vec<_> = matched
        .iter()
        .map(|f| Request {
            raw: evidence.get(text(&f["id"])).unwrap_or(&Value::Null),
            id: text(&f["id"]),
            structured: item["kind"] == "tool_call" && f["ruleId"] != "SEC-SECRET-001",
            locator: &f["evidence"]["argumentLocator"],
        })
        .collect();
    let mut gaps: BTreeSet<usize> = requests
        .iter()
        .enumerate()
        .filter(|(_, r)| missing_evidence(r.raw))
        .map(|(i, _)| i)
        .collect();
    let mut fields = Map::new();
    for field in ["preview", "structure"] {
        match ranges::locate(text(&item[field]), &requests, workspace, output) {
            Ok(located) => {
                gaps.extend(located.gaps);
                fields.insert(field.into(), Value::Array(located.ranges));
            }
            Err(e) if e.is::<Limit>() => {
                gaps.extend(0..matched.len());
                fields.insert(field.into(), json!([]));
            }
            Err(e) => return Err(e),
        }
    }
    let mut versions = Vec::new();
    for (index, request) in requests.iter().enumerate() {
        let hit = fields
            .values()
            .any(|rs| array(rs).iter().any(|r| r["findingId"] == request.id));
        if !hit && !gaps.contains(&index) {
            match bounded_readable(request.raw, workspace, output) {
                Ok(text) => versions.push(
                    json!({"findingId":request.id,"text":text,"toolArguments":request.structured}),
                ),
                Err(e) if e.is::<Limit>() => {
                    gaps.insert(index);
                }
                Err(e) => return Err(e),
            }
        }
    }
    item["riskRanges"] = Value::Object(fields);
    item["riskVersions"] = Value::Array(versions);
    item["riskGaps"] = json!(gaps
        .into_iter()
        .map(|i| &matched[i]["id"])
        .collect::<Vec<_>>());
    Ok(())
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
    retained: &mut Allocation,
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
    if finding["ruleId"] != "SEC-SECRET-001" || r["matchKind"] == "sensitive" {
        let size = end.saturating_sub(start) as usize;
        retained.grow(size)?;
        raw.try_reserve_exact(size).map_err(|_| Limit)?;
    }
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
            if let Some(r) = &range {
                retained.grow(
                    r["end"]
                        .as_u64()
                        .unwrap_or(0)
                        .saturating_sub(r["start"].as_u64().unwrap_or(0))
                        as usize,
                )?;
            }
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
                        let hit = evidence_text(db, audit, &exact, cancelled, retained)?;
                        if !hit.is_null() {
                            retained.grow(128)?;
                            hits.push(hit);
                        }
                    }
                }
            }
            if !hits.is_empty() {
                return Ok(Value::Array(hits));
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
                return Ok(Value::String(raw));
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
    let workspace = Workspace::new(cancelled);
    let mut retained = Vec::new();
    let mut output = workspace.allocation();
    let findings = findings(db, audit)?;
    let mut evidence = BTreeMap::new();
    let mut bytes = 0;
    for item in array(&page["items"]) {
        for finding in findings.iter().filter(|f| associated(f, item, response)) {
            let id = text(&finding["id"]);
            if evidence.contains_key(id) {
                continue;
            }
            let mut memory = workspace.allocation();
            let value = match evidence_text(db, audit, finding, cancelled, &mut memory) {
                Ok(value) => value,
                Err(e) if e.is::<Limit>() => Value::Null,
                Err(e) => return Err(e),
            };
            let size = if value.is_array() {
                array(&value).iter().map(|v| text(v).len()).sum()
            } else {
                text(&value).len()
            };
            let value = if bytes + size > MAX_EVIDENCE_BYTES {
                Value::Null
            } else {
                bytes += size;
                if !value.is_null() {
                    retained.push(memory);
                }
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
            annotate_item(
                item,
                &findings,
                &evidence,
                response,
                &workspace,
                &mut output,
            )?;
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
        let projected =
            fixture_projection(&page, std::slice::from_ref(&f), &bodies, false, None).unwrap();
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
        let workspace = Workspace::new(&|| true);
        assert!(
            evidence_text(&db, "audit", &f, &|| true, &mut workspace.allocation())
                .unwrap_err()
                .to_string()
                .contains("overview_cancelled")
        );
        let mut malformed = f;
        malformed["evidence"]["bodyRef"]
            .as_object_mut()
            .unwrap()
            .remove("start");
        assert!(!associated(&malformed, &json!({"start":0,"end":10}), false));
    }

    #[test]
    fn exhausted_projection_budget_preserves_content_and_reports_a_gap() {
        let preview = format!(
            "{{\"cmd\":\"danger\",\"extra\":[{}]}}",
            "0,".repeat(1000).trim_end_matches(',')
        );
        let mut item = json!({"kind":"tool_call","start":0,"end":preview.len(),"preview":preview,"structure":preview});
        let original = item.clone();
        let f = json!({"id":"risk","ruleId":"SEC-DELETE-001","evidence":{"bodyRef":{"snapshotId":"request","start":0,"end":preview.len()}}});
        let evidence = BTreeMap::from([("risk".into(), json!(r#"{"cmd":"danger"}"#))]);
        let workspace = Workspace::with_limit(&|| false, 4096);
        annotate_item(
            &mut item,
            &[f],
            &evidence,
            false,
            &workspace,
            &mut workspace.allocation(),
        )
        .unwrap();
        assert_eq!(item["preview"], original["preview"]);
        assert_eq!(item["structure"], original["structure"]);
        assert_eq!(item["riskGaps"], json!(["risk"]));
        assert_eq!(item["riskVersions"], json!([]));
        assert_eq!(item["riskRanges"], json!({"preview":[],"structure":[]}));
    }
}
