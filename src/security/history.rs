use crate::config::{array, text};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;

pub(super) const MAX_INDEX_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn units(db: &Connection, audit: &str) -> Result<Vec<Value>> {
    let mut statement =
        db.prepare("SELECT data FROM request_units WHERE audit_id=? ORDER BY idx")?;
    let rows = statement.query_map([audit], |r| r.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}

fn matches(current: &[Value], previous: &[Value]) -> Vec<(usize, usize)> {
    let equal = |a: usize, b: usize| current[a]["fingerprint"] == previous[b]["fingerprint"];
    let prefix = current
        .iter()
        .zip(previous)
        .take_while(|(a, b)| a["fingerprint"] == b["fingerprint"])
        .count();
    let mut result: Vec<_> = (0..prefix).map(|i| (i, i)).collect();
    let mut positions: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for (i, item) in previous.iter().enumerate() {
        positions
            .entry(text(&item["fingerprint"]))
            .or_default()
            .push(i);
    }
    for item in current {
        *counts.entry(text(&item["fingerprint"])).or_default() += 1;
    }
    let mut next = prefix;
    for i in prefix..current.len() {
        let key = text(&current[i]["fingerprint"]);
        let Some(candidates) = positions.get(key) else {
            continue;
        };
        if candidates.len() != 1 || counts[key] != 1 || candidates[0] < next {
            continue;
        }
        let j = candidates[0];
        let anchored = (i + 1 < current.len() && j + 1 < previous.len() && equal(i + 1, j + 1))
            || result
                .last()
                .is_some_and(|&(a, b)| a + 1 == i && b + 1 == j)
            || current[i]["callId"].is_string()
            || matches!(
                text(&current[i]["kind"]),
                "system" | "developer" | "tool_definition"
            );
        if anchored {
            result.push((i, j));
            next = j + 1;
        }
    }
    // An identical last user input may be a new input or a retry. Only a later
    // conversation item establishes that it is being carried as history.
    let last_user = current.iter().rposition(|item| {
        !matches!(
            text(&item["kind"]),
            "system" | "developer" | "tool_definition" | "reference"
        )
    });
    result.retain(|&(i, _)| {
        if current[i]["kind"] != "user" {
            return true;
        }
        let Some(last) = last_user else {
            return true;
        };
        i != last
            && !(current[last]["kind"] == "user"
                && current[i]["messageIndex"].is_string()
                && current[i]["messageIndex"] == current[last]["messageIndex"])
    });
    result
}

pub(super) fn prepare(
    db: &Connection,
    record: &Value,
    mut items: Vec<Value>,
    dependency: &str,
) -> Result<Value> {
    let id = text(&record["id"]);
    let scope = record["sessionKey"].as_str();
    let context = record["contextKey"].as_str();
    let fork = record["forkedFromContextKey"].as_str();
    let seq: i64 = db.query_row("SELECT seq FROM audit WHERE id=?", [id], |r| r.get(0))?;
    let mut best = Vec::new();
    let mut source = Value::Null;
    let mut prior_units = Vec::new();
    if let Some(scope) = scope {
        let mut statement = db.prepare("SELECT a.id,a.data FROM audit a WHERE coalesce(json_extract(a.data,'$.sessionKey'),a.id)=? AND a.seq<? AND (? IS NULL OR json_extract(a.data,'$.contextKey')=? OR json_extract(a.data,'$.contextKey')=?) AND EXISTS(SELECT 1 FROM request_units u WHERE u.audit_id=a.id) ORDER BY (json_extract(a.data,'$.contextKey')=?) DESC,a.seq DESC LIMIT 16")?;
        let candidates = statement
            .query_map(params![scope, seq, context, context, fork, context], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
        for candidate in candidates {
            let (audit, data) = candidate?;
            let previous = units(db, &audit)?;
            let matched = matches(&items, &previous);
            if matched.len() > best.len() {
                best = matched;
                source = serde_json::from_str(&data)?;
                prior_units = previous;
            }
            if context.is_some() && source["contextKey"].as_str() == context {
                break;
            }
        }
    }
    for item in &mut items {
        item["occurrenceId"] = json!(uuid::Uuid::new_v4().to_string());
    }
    let same_context = context.is_some()
        && (source["contextKey"].as_str() == context || source["contextKey"].as_str() == fork);
    let mut conclusions: HashMap<u64, Vec<Value>> = HashMap::new();
    if same_context {
        let mut statement = db.prepare("SELECT json_extract(data,'$.contentIndex'),json_extract(data,'$.findingSignature') FROM findings WHERE audit_id=? AND json_extract(data,'$.inspectionDependency')=? AND json_extract(data,'$.findingSignature') IS NOT NULL")?;
        let rows = statement.query_map(params![source["id"].as_str(), dependency], |r| {
            Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (index, signature) = row?;
            conclusions.entry(index).or_default().push(json!(signature));
        }
    }
    for (i, j) in best {
        items[i]["historyOf"] = json!({"requestId":source["id"],"index":j});
        items[i]["sameOccurrence"] = json!(same_context);
        if same_context {
            items[i]["occurrenceId"] = prior_units[j]["occurrenceId"].clone();
            items[i]["previousFindings"] =
                json!(conclusions.get(&(j as u64)).cloned().unwrap_or_default());
        }
    }
    let bytes: usize = items.iter().map(|item| item.to_string().len()).sum();
    anyhow::ensure!(bytes <= MAX_INDEX_BYTES, "request_index_budget");
    anyhow::ensure!(
        super::store::reclaim_body_pages(db, Some(id), bytes as u64 + 16384)?,
        "request_index_budget"
    );
    let tx = db.unchecked_transaction()?;
    for item in &items {
        let mut stored = item.clone();
        stored.as_object_mut().unwrap().remove("previousFindings");
        tx.execute(
            "INSERT OR REPLACE INTO request_units(audit_id,idx,data) VALUES(?,?,?)",
            params![id, item["index"].as_u64(), stored.to_string()],
        )?;
    }
    tx.commit()?;
    let mut cache = serde_json::Map::new();
    if let Some(scope) = scope {
        let mut statement = db.prepare("SELECT key,data,audit_id FROM inspection_cache WHERE scope=? AND dependency=? ORDER BY rowid DESC LIMIT 4096")?;
        let rows = statement.query_map(params![scope, dependency], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut bytes = 0;
        for row in rows {
            let (key, data, audit) = row?;
            bytes += key.len() + data.len();
            if bytes > MAX_INDEX_BYTES {
                break;
            }
            let mut value: Value = serde_json::from_str(&data)?;
            value["requestId"] = json!(audit);
            cache.insert(key, value);
        }
    }
    Ok(json!({"items":items,"cache":cache}))
}

pub(super) fn save_cache(
    db: &Connection,
    record: &Value,
    dependency: &str,
    entries: &Value,
) -> Result<()> {
    let id = text(&record["id"]);
    let Some(scope) = record["sessionKey"].as_str() else {
        return Ok(());
    };
    let stored: Option<String> = db
        .query_row("SELECT data FROM audit WHERE id=?", [id], |r| r.get(0))
        .optional()?;
    let Some(stored) = stored else { return Ok(()) };
    let stored: Value = serde_json::from_str(&stored)?;
    if stored["requestBodyState"] != "complete"
        || stored["inspectionStatus"] == "failed"
        || stored["findingCount"] != record["findingCount"]
    {
        return Ok(());
    }
    let bytes = entries.to_string().len();
    if !super::store::reclaim_body_pages(db, Some(id), bytes as u64 + 16384)? {
        return Ok(());
    }
    let tx = db.unchecked_transaction()?;
    for entry in array(entries) {
        tx.execute("INSERT OR IGNORE INTO inspection_cache(scope,dependency,key,audit_id,data) VALUES(?,?,?,?,?)",params![scope,dependency,entry["key"].as_str(),id,entry["result"].to_string()])?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_handles_insertions_and_keeps_ambiguous_repeats_visible() {
        let item = |hash: &str, kind: &str| json!({"fingerprint":hash,"kind":kind});
        let previous = vec![
            item("system", "system"),
            item("a", "user"),
            item("b", "assistant"),
            item("c", "assistant"),
        ];
        let current = vec![
            item("system", "system"),
            item("a", "user"),
            item("inserted", "assistant"),
            item("b", "assistant"),
            item("c", "assistant"),
            item("a", "user"),
        ];
        assert_eq!(
            matches(&current, &previous),
            vec![(0, 0), (1, 1), (3, 2), (4, 3)]
        );
        assert_eq!(
            matches(
                &[item("a", "user"), item("system", "system")],
                &[item("a", "user"), item("system", "system")]
            ),
            vec![(1, 1)]
        );
        let blocks = vec![
            json!({"fingerprint":"a","kind":"user","messageIndex":"0"}),
            json!({"fingerprint":"b","kind":"user","messageIndex":"0"}),
        ];
        assert!(matches(&blocks, &blocks).is_empty());
        let repeated = vec![
            item("a", "assistant"),
            item("x", "assistant"),
            item("a", "assistant"),
            item("x", "assistant"),
        ];
        assert!(matches(
            &[
                item("new", "assistant"),
                item("a", "assistant"),
                item("x", "assistant")
            ],
            &repeated
        )
        .is_empty());
    }
}
