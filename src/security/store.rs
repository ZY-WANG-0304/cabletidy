use crate::config;
use anyhow::{bail, Result};
use rusqlite::{params, params_from_iter, Connection};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

const RETENTION_DAYS: i64 = 30;
const BUDGET: u64 = 128 * 1024 * 1024;
pub(super) const MAX_RECORD: usize = 64 * 1024;

enum Job {
    Write(Value),
    Body(String, Value, mpsc::Sender<bool>),
    Query(Query, oneshot::Sender<Result<Value>>),
    Flush(oneshot::Sender<()>),
}

struct ContentJob {
    audit: String,
    offset: usize,
    response: bool,
    detail: bool,
    deadline: Instant,
    done: oneshot::Sender<Result<Value>>,
}

pub struct Store {
    sender: mpsc::SyncSender<Job>,
    content_sender: mpsc::SyncSender<ContentJob>,
    health: Arc<Mutex<Value>>,
}

#[derive(Default)]
pub struct Query {
    pub detail: Option<String>,
    pub sessions: bool,
    pub session: Option<String>,
    pub body: Option<(String, u64)>,
    pub content_offset: Option<usize>,
    pub response_content: bool,
    filters: BTreeMap<String, String>,
    hours: i64,
    cursor: i64,
    limit: usize,
}

impl Query {
    pub fn parse(raw: &str) -> Result<Self> {
        let mut q = Self {
            hours: 24,
            limit: 50,
            ..Self::default()
        };
        for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
            if v.is_empty() {
                continue;
            }
            match k.as_ref() {
                "session" => {
                    if v.len() > 128 || !v.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
                        bail!("invalid session");
                    }
                    q.session = Some(v.into_owned());
                }
                "hours" => {
                    q.hours = v.parse()?;
                    if !(1..=720).contains(&q.hours) {
                        bail!("invalid hours");
                    }
                }
                "limit" => {
                    q.limit = v.parse()?;
                    if !(1..=100).contains(&q.limit) {
                        bail!("invalid limit");
                    }
                }
                "cursor" => {
                    q.cursor = v.parse()?;
                    if q.cursor < 1 {
                        bail!("invalid cursor");
                    }
                }
                "provider" | "category" | "severity" | "confidence" | "stage" | "outcome"
                | "inspection" | "kind" | "hasRisk" => {
                    if v.len() > 128
                        || !v
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
                    {
                        bail!("invalid filter");
                    }
                    q.filters.insert(k.into_owned(), v.into_owned());
                }
                _ => bail!("unknown filter"),
            }
        }
        for (key, allowed) in [
            ("hasRisk", &["true", "false"][..]),
            (
                "severity",
                &["informational", "low", "medium", "high", "critical"][..],
            ),
            ("confidence", &["low", "medium", "high"][..]),
            (
                "stage",
                &[
                    "request_content",
                    "tool_call_proposed",
                    "tool_call_replayed",
                    "tool_result_reported",
                    "response_content",
                ][..],
            ),
            (
                "outcome",
                &[
                    "started",
                    "streaming",
                    "completed",
                    "local_error",
                    "upstream_error",
                    "connection_error",
                    "stream_error",
                    "interrupted",
                    "unknown",
                ][..],
            ),
            (
                "inspection",
                &[
                    "pending", "running", "complete", "limited", "partial", "failed", "skipped",
                ][..],
            ),
            ("kind", &["request", "management", "system"][..]),
            (
                "category",
                &[
                    "sensitive_data",
                    "destructive_action",
                    "permission_change",
                    "external_execution",
                    "instruction_manipulation",
                ][..],
            ),
        ] {
            if q.filters
                .get(key)
                .is_some_and(|s| !allowed.contains(&s.as_str()))
            {
                bail!("invalid filter");
            }
        }
        Ok(q)
    }
}

impl Store {
    pub fn start(home: &Path) -> Arc<Self> {
        let path = home.join("audit.sqlite3");
        let health = Arc::new(Mutex::new(json!({
            "state":"starting", "droppedWrites":0, "failedWrites":0,
            "lastWrittenAt":null, "lastError":null, "bytes":0,
            "retentionDays":RETENTION_DAYS, "budgetBytes":BUDGET
        })));
        let (sender, receiver) = mpsc::sync_channel(256);
        let (content_sender, content_receiver) = mpsc::sync_channel(4);
        let store = Arc::new(Self {
            sender,
            content_sender,
            health: health.clone(),
        });
        let worker_health = health.clone();
        let content_path = path.clone();
        if std::thread::Builder::new()
            .name("security-audit".into())
            .spawn(move || worker(path, receiver, worker_health))
            .is_err()
        {
            health.lock().unwrap()["state"] = json!("unavailable");
        }
        let _ = std::thread::Builder::new()
            .name("security-overview".into())
            .spawn(move || content_worker(content_path, content_receiver));
        store
    }

    pub fn status(&self) -> Value {
        self.health.lock().unwrap().clone()
    }

    pub fn write(&self, record: Value) {
        if record.to_string().len() > MAX_RECORD
            || self.sender.try_send(Job::Write(record)).is_err()
        {
            self.dropped();
        }
    }

    pub fn write_analysis(&self, record: Value) -> bool {
        if record.to_string().len() > MAX_RECORD || self.sender.send(Job::Write(record)).is_err() {
            self.dropped();
            return false;
        }
        true
    }

    pub fn body(&self, audit_id: &str, data: Value) -> bool {
        let (tx, rx) = mpsc::channel();
        if self
            .sender
            .send(Job::Body(audit_id.into(), data, tx))
            .is_err()
        {
            self.dropped();
            return false;
        }
        rx.recv().unwrap_or(false)
    }

    fn dropped(&self) {
        let mut h = self.health.lock().unwrap();
        h["droppedWrites"] = json!(h["droppedWrites"].as_u64().unwrap_or(0) + 1);
        h["lastError"] = json!("audit_queue_limit");
        if h["state"] != "unavailable" {
            h["state"] = json!("degraded");
        }
    }

    pub async fn query(&self, query: Query) -> Result<Value> {
        let content = query
            .detail
            .as_ref()
            .filter(|_| query.body.is_none())
            .map(|id| (id.clone(), query.content_offset, query.response_content));
        let (tx, rx) = oneshot::channel();
        self.sender
            .try_send(Job::Query(query, tx))
            .map_err(|_| anyhow::anyhow!("audit_busy"))?;
        let mut value = tokio::time::timeout(Duration::from_secs(5), rx).await???;
        if let Some((audit, offset, response)) = content.filter(|_| !value.is_null()) {
            let protocol = value["record"]["protocol"].as_str().unwrap_or("");
            if offset.is_some() || matches!(protocol, "openai.responses" | "anthropic.messages") {
                let (done, result) = oneshot::channel();
                self.content_sender
                    .try_send(ContentJob {
                        audit,
                        offset: offset.unwrap_or(0),
                        response,
                        detail: offset.is_none(),
                        deadline: Instant::now() + Duration::from_secs(30),
                        done,
                    })
                    .map_err(|_| anyhow::anyhow!("overview_busy"))?;
                // This queue is independent of audit writes. Dropping the receiver
                // on timeout or disconnect also cancels queued/active parsing.
                let page = tokio::time::timeout(Duration::from_secs(30), result).await???;
                if offset.is_some() || page.is_null() {
                    value = page;
                } else {
                    value["record"]["requestContent"] = page["requestContent"].clone();
                    value["record"]["responseContent"] = page["responseContent"].clone();
                }
            }
        }
        if value.is_object() {
            value["storage"] = self.status();
        }
        Ok(value)
    }

    pub async fn flush(&self) {
        let (tx, rx) = oneshot::channel();
        let sender = self.sender.clone();
        if tokio::task::spawn_blocking(move || sender.send(Job::Flush(tx)).is_ok())
            .await
            .unwrap_or(false)
        {
            let _ = rx.await;
        }
    }
}

fn open(path: &Path, recover: bool) -> Result<Connection> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    let db = Connection::open(path)?;
    db.busy_timeout(Duration::from_millis(250))?;
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version > 3 {
        bail!("unsupported audit schema");
    }
    db.execute_batch(
        "PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=256;
        PRAGMA journal_size_limit=1048576; PRAGMA max_page_count=24576;
        BEGIN;
        CREATE TABLE IF NOT EXISTS audit (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL,
          kind TEXT NOT NULL, provider TEXT NOT NULL, outcome TEXT NOT NULL,
          inspection TEXT NOT NULL, severity TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS audit_time ON audit(at);
        CREATE INDEX IF NOT EXISTS audit_provider ON audit(provider, at);
        CREATE INDEX IF NOT EXISTS audit_session ON audit(coalesce(json_extract(data,'$.sessionKey'),id),seq);
        CREATE TABLE IF NOT EXISTS findings (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          audit_id TEXT NOT NULL REFERENCES audit(id) ON DELETE CASCADE,
          at INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL,
          confidence TEXT NOT NULL, stage TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS findings_request ON findings(audit_id);
        CREATE INDEX IF NOT EXISTS findings_time ON findings(at);
        CREATE TABLE IF NOT EXISTS audit_snapshots (
          audit_id TEXT NOT NULL REFERENCES audit(id) ON DELETE CASCADE,
          id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(audit_id,id));
        CREATE TABLE IF NOT EXISTS audit_body_chunks (
          audit_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, start INTEGER NOT NULL,
          end INTEGER NOT NULL, content TEXT NOT NULL, redactions TEXT NOT NULL,
          PRIMARY KEY(audit_id,snapshot_id,start),
          FOREIGN KEY(audit_id,snapshot_id) REFERENCES audit_snapshots(audit_id,id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS body_ranges ON audit_body_chunks(audit_id,snapshot_id,end);
        PRAGMA user_version=3; COMMIT;",
    )?;
    if recover {
        // Only records left by a previous process are recovered as unknown.
        let mut stmt =
            db.prepare("SELECT id, data FROM audit WHERE outcome IN ('started','streaming') OR inspection IN ('pending','running') OR json_extract(data,'$.inspectionProgress.active')=1")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for (id, data) in rows {
            let mut record: Value = serde_json::from_str(&data)?;
            if matches!(config::text(&record["outcome"]), "started" | "streaming") {
                record["outcome"] = json!("unknown");
            }
            record["inspectionProgress"]["state"] = json!("failed");
            record["inspectionProgress"]["active"] = json!(false);
            record["inspectionProgress"]["phase"] = json!("finished");
            if record["inspectionStatus"] != "failed" {
                record["inspectionStatus"] = json!("partial");
            }
            let mut reasons = config::array(&record["coverageReasons"]).to_vec();
            if !reasons.contains(&json!("daemon_restarted")) {
                reasons.push(json!("daemon_restarted"));
            }
            record["coverageReasons"] = json!(reasons);
            db.execute(
                "UPDATE audit SET outcome=?, inspection=?, data=? WHERE id=?",
                params![
                    record["outcome"].as_str(),
                    record["inspectionStatus"].as_str(),
                    record.to_string(),
                    id
                ],
            )?;
        }
        db.execute("UPDATE audit_snapshots SET data=json_set(data,'$.state','gap','$.gapReason','daemon_restarted') WHERE json_extract(data,'$.state')='receiving'",[])?;
        restore_codex_sessions(&db)?;
        restore_security_statuses(&db)?;
    }
    maintain(&db, path)?;
    Ok(db)
}

fn restore_codex_sessions(db: &Connection) -> Result<()> {
    // Repair only missing navigation metadata from complete original headers.
    // Run on startup, before queued writes, and leave bodies/findings untouched.
    let tx = db.unchecked_transaction()?;
    {
        let mut records = tx.prepare(
            "SELECT a.id,a.data,json_extract(s.data,'$.byteLength') FROM audit a
             JOIN audit_snapshots s ON s.audit_id=a.id AND s.id='request/headers'
             WHERE a.kind='request' AND json_extract(a.data,'$.target')='codex'
             AND json_extract(a.data,'$.sessionKey') IS NULL
             AND json_extract(s.data,'$.source')='observed_headers'
             AND json_extract(s.data,'$.contentMode')='original'
             AND json_extract(s.data,'$.state')='complete'
             AND json_extract(s.data,'$.byteLength') BETWEEN 1 AND ?
             ORDER BY a.seq",
        )?;
        let mut chunks = tx.prepare(
            "SELECT start,end,content FROM audit_body_chunks
             WHERE audit_id=? AND snapshot_id='request/headers' ORDER BY start",
        )?;
        let rows = records.query_map([4 * crate::streaming::PAGE], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, usize>(2)?,
            ))
        })?;
        for row in rows {
            let (id, data, length) = row?;
            let mut text = String::new();
            let mut contiguous = true;
            let mut parts = chunks.query([&id])?;
            while let Some(part) = parts.next()? {
                let start: usize = part.get(0)?;
                let end: usize = part.get(1)?;
                let content: String = part.get(2)?;
                if start != text.len() || end != start + content.len() || end > length {
                    contiguous = false;
                    break;
                }
                text.push_str(&content);
            }
            if !contiguous || text.len() != length {
                continue;
            }
            let Ok(headers) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let mut record: Value = serde_json::from_str(&data)?;
            super::session::identify_headers(&mut record, &headers);
            if record["sessionKey"].is_string() {
                tx.execute(
                    "UPDATE audit SET data=? WHERE id=?",
                    params![record.to_string(), id],
                )?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

fn retained_terminal(
    db: &Connection,
    id: &str,
    length: u64,
    protocol: &str,
) -> Result<Option<String>> {
    use crate::streaming::{self, EventFramer};

    let mut chunks = db.prepare("SELECT start,end,content FROM audit_body_chunks WHERE audit_id=? AND snapshot_id='response' ORDER BY start")?;
    let mut rows = chunks.query([id])?;
    let mut offset = 0;
    let mut framer = EventFramer::new();
    let mut terminal = None;
    while let Some(row) = rows.next()? {
        let start: u64 = row.get(0)?;
        let end: u64 = row.get(1)?;
        let content: String = row.get(2)?;
        if start != offset || end != start + content.len() as u64 || end > length {
            return Ok(None);
        }
        offset = end;
        for byte in content.bytes() {
            let Some(event) = framer.byte(byte)? else {
                continue;
            };
            let data = streaming::event_data(&event)?;
            if data.payload.len == 0 {
                continue;
            }
            let Ok(info) = streaming::index(&data.payload, None) else {
                return Ok(None);
            };
            let kind = config::text(&info.values["type"]).to_owned();
            if super::status::terminal_outcome(protocol, &kind).is_some() {
                if terminal.is_none()
                    || matches!(
                        kind.as_str(),
                        "error" | "response.failed" | "response.incomplete"
                    )
                {
                    terminal = Some(kind);
                }
            } else if terminal.is_some() && kind != "ping" {
                return Ok(None);
            }
        }
    }
    if offset != length || framer.finish()?.is_some() {
        return Ok(None);
    }
    Ok(terminal)
}

fn restore_security_statuses(db: &Connection) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    {
        let mut records = tx.prepare("SELECT id,data FROM audit WHERE kind='request' AND coalesce(json_extract(data,'$.statusVersion'),0)<1 ORDER BY seq")?;
        let rows =
            records.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, data) = row?;
            let mut record: Value = serde_json::from_str(&data)?;
            // Correct only settled, retained responses. Missing bytes and failed
            // inspections never become successful based on a textual marker.
            if record["outcome"] == "interrupted"
                && record["inspectionStatus"] != "failed"
                && record["requestBodyState"] == "complete"
                && record["responseBodyState"] == "interrupted"
                && record["captureGap"].is_null()
                && config::array(&record["coverageGaps"]).is_empty()
                // Saved SSE normalizes delimiters, including unfinished events.
                // The original inspection must have confirmed no framing or parsing gaps.
                && config::array(&record["coverageReasons"]).contains(&json!("body_not_complete"))
                && config::array(&record["coverageReasons"]).iter().all(|reason| {
                    *reason == "body_not_complete" || super::status::limitation(config::text(reason))
                })
            {
                let manifest = tx
                    .query_row(
                        "SELECT data FROM audit_snapshots WHERE audit_id=? AND id='response'",
                        [&id],
                        |r| r.get::<_, String>(0),
                    )
                    .ok();
                if let Some(manifest) = manifest {
                    let mut manifest: Value = serde_json::from_str(&manifest)?;
                    if manifest["source"] == "upstream_response"
                        && manifest["contentMode"] == "original"
                        && manifest["state"] == "interrupted"
                    {
                        if let Some(event) = manifest["byteLength"].as_u64().and_then(|len| {
                            retained_terminal(&tx, &id, len, config::text(&record["protocol"]))
                                .ok()
                                .flatten()
                        }) {
                            record["responseTransportState"] = json!("interrupted");
                            super::status::apply_terminal(&mut record, &event);
                            record["responseBodyState"] = json!("complete");
                            let reasons = config::array(&record["coverageReasons"])
                                .iter()
                                .filter(|r| **r != "body_not_complete")
                                .cloned()
                                .collect::<Vec<_>>();
                            record["coverageReasons"] = json!(reasons);
                            manifest["state"] = json!("complete");
                            tx.execute("UPDATE audit_snapshots SET data=? WHERE audit_id=? AND id='response'", params![manifest.to_string(), id])?;
                        }
                    }
                }
            }
            super::status::classify(&mut record);
            if record["inspectionProgress"].is_object()
                && record["inspectionProgress"]["state"] != "failed"
            {
                record["inspectionProgress"]["state"] = record["inspectionStatus"].clone();
            }
            record["statusVersion"] = json!(1);
            tx.execute(
                "UPDATE audit SET outcome=?,inspection=?,data=? WHERE id=?",
                params![
                    record["outcome"].as_str(),
                    record["inspectionStatus"].as_str(),
                    record.to_string(),
                    id
                ],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn disk_bytes(path: &Path) -> u64 {
    [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ]
    .iter()
    .filter_map(|p| std::fs::metadata(p).ok())
    .map(|m| m.len())
    .sum()
}

fn body_budget() -> u64 {
    crate::streaming::budget("CABLETIDY_TEST_AUDIT_BODY_BYTES", 80 * 1024 * 1024)
}

fn used_bytes(db: &Connection) -> Result<u64> {
    Ok(db.query_row(
        "SELECT (page_count-freelist_count)*page_size FROM pragma_page_count(),pragma_freelist_count(),pragma_page_size()",
        [], |r| r.get(0),
    )?)
}

fn prune_completed(db: &Connection, protected: Option<&str>) -> Result<usize> {
    Ok(db.execute(
        "DELETE FROM audit WHERE seq IN (SELECT seq FROM audit WHERE outcome NOT IN ('started','streaming') AND inspection NOT IN ('pending','running') AND coalesce(json_extract(data,'$.inspectionProgress.active'),0)=0 AND (?1 IS NULL OR id != ?1) ORDER BY seq LIMIT 10)",
        [protected],
    )?)
}

fn reclaim_body_pages(db: &Connection, protected: Option<&str>, additional: u64) -> Result<bool> {
    // Use the same live-page budget for maintenance and body writes. Free pages
    // can be reused immediately without waiting for database or WAL truncation.
    while used_bytes(db)?.saturating_add(additional) > body_budget() {
        if prune_completed(db, protected)? == 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

fn maintain(db: &Connection, path: &Path) -> Result<()> {
    let cutoff = chrono::Utc::now().timestamp_millis() - RETENTION_DAYS * 86_400_000;
    db.execute("DELETE FROM audit WHERE at < ? AND outcome NOT IN ('started','streaming') AND inspection NOT IN ('pending','running') AND coalesce(json_extract(data,'$.inspectionProgress.active'),0)=0", [cutoff])?;
    reclaim_body_pages(db, None, 0)?;
    db.execute_batch("PRAGMA incremental_vacuum(2048); PRAGMA wal_checkpoint(TRUNCATE);")?;
    if disk_bytes(path) > BUDGET * 3 / 4 {
        prune_completed(db, None)?;
        db.execute_batch("PRAGMA incremental_vacuum(2048); PRAGMA wal_checkpoint(TRUNCATE);")?;
    }
    Ok(())
}

fn persist(db: &mut Connection, mut record: Value) -> Result<()> {
    let findings = record
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("invalid audit record"))?
        .remove("findings")
        .unwrap_or(json!([]));
    let tx = db.transaction()?;
    tx.execute("INSERT INTO audit(id,at,kind,provider,outcome,inspection,severity,data) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,outcome=excluded.outcome,inspection=excluded.inspection,severity=excluded.severity,data=excluded.data",
        params![record["id"].as_str(), record["atMs"].as_i64(), record["kind"].as_str(), record["providerId"].as_str().unwrap_or(""),
            record["outcome"].as_str(), record["inspectionStatus"].as_str(), record["severity"].as_str(), record.to_string()])?;
    for finding in config::array(&findings) {
        tx.execute("INSERT OR IGNORE INTO findings(id,audit_id,at,category,severity,confidence,stage,data) VALUES(?,?,?,?,?,?,?,?)",
            params![finding["id"].as_str(), record["id"].as_str(), finding["atMs"].as_i64(), finding["category"].as_str(),
                finding["severity"].as_str(), finding["confidence"].as_str(), finding["evidenceStage"].as_str(), finding.to_string()])?;
    }
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM findings WHERE audit_id=?",
        [record["id"].as_str()],
        |r| r.get(0),
    )?;
    let severity:String=tx.query_row("SELECT coalesce((SELECT severity FROM findings WHERE audit_id=? ORDER BY CASE severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END DESC LIMIT 1),'informational')",[record["id"].as_str()],|r|r.get(0))?;
    record["findingCount"] = json!(count);
    record["severity"] = json!(severity);
    tx.execute(
        "UPDATE audit SET severity=?,data=? WHERE id=?",
        params![severity, record.to_string(), record["id"].as_str()],
    )?;
    tx.commit()?;
    Ok(())
}

fn persist_body(db: &Connection, audit: &str, value: &Value) -> Result<()> {
    let id = config::text(&value["id"]);
    if let Some(content) = value["content"].as_str() {
        // Reuse the existing column; tagged annotations distinguish original-content
        // ranges from redactions written by older versions.
        let redactions = value
            .get("annotations")
            .unwrap_or(&value["redactions"])
            .to_string();
        let page_size: u64 = db.query_row("PRAGMA page_size", [], |r| r.get(0))?;
        // Leave database pages available for terminal states, findings and gap records.
        let additional = (content.len() + redactions.len()) as u64 + 4 * page_size;
        if !reclaim_body_pages(db, Some(audit), additional)? {
            bail!("audit_body_budget");
        }
        let changed=db.execute("INSERT OR IGNORE INTO audit_body_chunks(audit_id,snapshot_id,start,end,content,redactions)
            SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM audit_snapshots WHERE audit_id=? AND id=? AND json_extract(data,'$.state')='receiving')
            AND ?=(SELECT coalesce(max(end),0) FROM audit_body_chunks WHERE audit_id=? AND snapshot_id=?)",
            params![audit,id,value["start"].as_u64(),value["end"].as_u64(),content,redactions,audit,id,value["start"].as_u64(),audit,id])?;
        if changed == 0 {
            bail!("immutable_or_noncontiguous_body_chunk");
        }
        db.execute("UPDATE audit_snapshots SET data=json_set(data,'$.byteLength',?) WHERE audit_id=? AND id=?",params![value["end"].as_u64(),audit,id])?;
    } else {
        db.execute("INSERT INTO audit_snapshots(audit_id,id,data) VALUES(?,?,?) ON CONFLICT(audit_id,id) DO UPDATE SET data=excluded.data WHERE json_extract(audit_snapshots.data,'$.state')='receiving'",
            params![audit,id,value.to_string()])?;
    }
    Ok(())
}

fn read_body_page(db: &Connection, audit: &str, snapshot: &str, offset: u64) -> Result<Value> {
    use rusqlite::OptionalExtension;
    let data: Option<String> = db
        .query_row(
            "SELECT data FROM audit_snapshots WHERE audit_id=? AND id=?",
            params![audit, snapshot],
            |r| r.get(0),
        )
        .optional()?;
    let Some(data) = data else {
        return Ok(Value::Null);
    };
    let manifest: Value = serde_json::from_str(&data)?;
    if manifest.get("body").is_some() {
        // Old bounded snapshots remain readable without being included in every detail response.
        return Ok(json!({"legacySnapshot":manifest}));
    }
    let source = manifest["sourceSnapshotId"].as_str().unwrap_or(snapshot);
    let start = manifest["rangeStart"].as_u64().unwrap_or(0);
    let end = manifest["rangeEnd"]
        .as_u64()
        .or_else(|| manifest["byteLength"].as_u64())
        .unwrap_or(u64::MAX);
    let offset = offset.max(start);
    let mut stmt = db.prepare("SELECT start,end,content,redactions FROM audit_body_chunks WHERE audit_id=? AND snapshot_id=? AND end>? AND start<? ORDER BY start LIMIT 4")?;
    let chunks = stmt
        .query_map(params![audit, source, offset, end], |r| {
            Ok((
                r.get::<_, u64>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut items = Vec::new();
    let mut gap = false;
    let mut previous = None;
    for (at, to, content, marks) in chunks {
        if previous.is_some_and(|p| p != at) {
            gap = true;
        }
        previous = Some(to);
        let mut left = start.saturating_sub(at).min(content.len() as u64) as usize;
        let mut right = end.saturating_sub(at).min(content.len() as u64) as usize;
        while left < right && !content.is_char_boundary(left) {
            left += 1;
        }
        while right > left && !content.is_char_boundary(right) {
            right -= 1;
        }
        let marks: Value = serde_json::from_str(&marks)?;
        let marks: Vec<_> = config::array(&marks)
            .iter()
            .filter(|m| {
                m["start"].as_u64().unwrap_or(0) < at + right as u64
                    && m["end"].as_u64().unwrap_or(0) > at + left as u64
            })
            .collect();
        let sensitive: Vec<_> = marks.iter().filter(|m| m["kind"] == "sensitive").collect();
        let coverage: Vec<_> = marks.iter().filter(|m| m["kind"] == "coverage").collect();
        let legacy: Vec<_> = marks.iter().filter(|m| m["kind"].is_null()).collect();
        items.push(json!({"start":at+left as u64,"end":at+right as u64,"content":&content[left..right],"sensitiveRanges":sensitive,"coverageRanges":coverage,"redactions":legacy}));
    }
    let first = items
        .first()
        .and_then(|v| v["start"].as_u64())
        .unwrap_or(offset);
    let last = items
        .last()
        .and_then(|v| v["end"].as_u64())
        .unwrap_or(offset);
    let has_more: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM audit_body_chunks WHERE audit_id=? AND snapshot_id=? AND start>=? AND start<?)",params![audit,source,last,end],|r|r.get(0))?;
    gap |= items.is_empty() && offset < end
        || first > offset.saturating_add(3)
        || !has_more && last.saturating_add(3) < end
        || manifest["state"] == "gap";
    Ok(
        json!({"snapshotId":snapshot,"chunks":items,"offset":first,"nextOffset":if has_more {Some(last)}else{None},
        "previousOffset":if first>start.saturating_add(3) {Some(first.saturating_sub(4*crate::streaming::PAGE as u64).max(start))}else{None},
        "rangeStart":start,"rangeEnd":end,"state":manifest["state"],"gap":gap}),
    )
}

fn read(db: &Connection, mut query: Query) -> Result<Value> {
    if let Some(id) = query.detail {
        let visible: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM audit WHERE id=? AND kind != 'management')",
            [&id],
            |r| r.get(0),
        )?;
        if !visible {
            return Ok(Value::Null);
        }
        if let Some((snapshot, offset)) = query.body {
            return read_body_page(db, &id, &snapshot, offset);
        }
        if query.content_offset.is_some() {
            // Only check visibility here; projection belongs to the readonly worker.
            return Ok(json!({}));
        }
        let mut stmt = db.prepare("SELECT data FROM audit WHERE id=?")?;
        let mut rows = stmt.query([&id])?;
        let Some(row) = rows.next()? else {
            return Ok(Value::Null);
        };
        let mut data: Value = serde_json::from_str(&row.get::<_, String>(0)?)?;
        let mut stmt = db.prepare("SELECT data FROM findings WHERE audit_id=? ORDER BY seq")?;
        let findings = stmt
            .query_map([&id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        data["findings"] = json!(findings
            .iter()
            .map(|s| serde_json::from_str::<Value>(s))
            .collect::<serde_json::Result<Vec<_>>>()?);
        let mut stmt =
            db.prepare("SELECT data FROM audit_snapshots WHERE audit_id=? ORDER BY rowid")?;
        let snapshots = stmt
            .query_map([&id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        data["bodySnapshots"] = json!(snapshots
            .iter()
            .map(|s| serde_json::from_str::<Value>(s).map(|mut v| {
                if let Some(m) = v.as_object_mut() {
                    m.remove("body");
                    m.remove("headers");
                    m.remove("redactions");
                    m.remove("fieldOrder");
                }
                v
            }))
            .collect::<serde_json::Result<Vec<_>>>()?);
        data["findingCount"] = json!(config::array(&data["findings"]).len());
        return Ok(json!({"record":data}));
    }
    let mut conditions = vec!["a.at >= ?".to_owned()];
    let mut args = vec![rusqlite::types::Value::Integer(
        chrono::Utc::now().timestamp_millis() - query.hours * 3_600_000,
    )];
    if let Some(session) = &query.session {
        // A request UUID remains a valid entry after body inspection identifies
        // its session. Resolve it before applying filters or pagination.
        let session: String = db.query_row(
            "SELECT coalesce((SELECT json_extract(data,'$.sessionKey') FROM audit WHERE id=?1 AND kind='request'),?1)",
            [session], |r| r.get(0),
        )?;
        conditions = vec!["coalesce(json_extract(a.data,'$.sessionKey'),a.id) = ?".into()];
        args = vec![session.clone().into()];
        query.session = Some(session);
    }
    // Historical configuration records are outside content auditing. Keep their
    // retention lifecycle, but do not expose them through audit reads.
    conditions.push(
        if query.sessions || query.session.is_some() {
            "a.kind = 'request'"
        } else {
            "a.kind != 'management'"
        }
        .into(),
    );
    let mut finding_conditions = Vec::new();
    let mut finding_args = Vec::new();
    for (key, value) in &query.filters {
        let column = match key.as_str() {
            "provider" => "a.provider",
            "outcome" => "a.outcome",
            "inspection" => "a.inspection",
            "kind" => "a.kind",
            "severity" => "a.severity",
            "hasRisk" => {
                conditions.push(format!(
                    "{}EXISTS (SELECT 1 FROM findings f WHERE f.audit_id=a.id)",
                    if value == "true" { "" } else { "NOT " }
                ));
                continue;
            }
            "category" | "confidence" | "stage" => {
                finding_conditions.push(format!("f.{key} = ?"));
                finding_args.push(value.clone().into());
                continue;
            }
            _ => bail!("invalid filter"),
        };
        conditions.push(format!("{column} = ?"));
        args.push(value.clone().into());
    }
    if !finding_conditions.is_empty() {
        conditions.push(format!(
            "EXISTS (SELECT 1 FROM findings f WHERE f.audit_id=a.id AND {})",
            finding_conditions.join(" AND ")
        ));
        args.extend(finding_args);
    }
    let filter = conditions.join(" AND ");
    if query.sessions {
        return read_sessions(db, &query, &filter, &args);
    }
    let (total, risky, finding_count): (i64, i64, i64) = db.query_row(
        &format!("SELECT count(*), coalesce(sum(EXISTS (SELECT 1 FROM findings f WHERE f.audit_id=a.id)),0),
            coalesce(sum((SELECT count(*) FROM findings f WHERE f.audit_id=a.id)),0) FROM audit a WHERE {filter}"),
        params_from_iter(&args), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let mut counts = json!({"informational":0,"low":0,"medium":0,"high":0,"critical":0});
    let mut stmt = db.prepare(&format!(
        "SELECT a.severity,count(*) FROM audit a WHERE {filter} GROUP BY a.severity"
    ))?;
    for row in stmt.query_map(params_from_iter(&args), |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })? {
        let (severity, count) = row?;
        counts[severity] = json!(count);
    }
    if query.cursor > 0 {
        conditions.push(
            if query.session.is_some() {
                "a.seq > ?"
            } else {
                "a.seq < ?"
            }
            .into(),
        );
        args.push(query.cursor.into());
    }
    let sql = format!("SELECT a.seq,a.data,(SELECT count(*) FROM findings f WHERE f.audit_id=a.id) FROM audit a WHERE {} ORDER BY a.seq {} LIMIT ?", conditions.join(" AND "), if query.session.is_some() { "ASC" } else { "DESC" });
    args.push(((query.limit + 1) as i64).into());
    let mut stmt = db.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(&args), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let more = rows.len() > query.limit;
    let mut items = Vec::new();
    for (seq, data, findings) in rows.into_iter().take(query.limit) {
        let mut v: Value = serde_json::from_str(&data)?;
        v["cursor"] = json!(seq.to_string());
        v["findingCount"] = json!(findings);
        items.push(v);
    }
    let next = if more {
        items.last().map(|v| v["cursor"].clone())
    } else {
        None
    };
    let oldest: Option<i64> = db.query_row(
        "SELECT min(at) FROM audit WHERE kind != 'management'",
        [],
        |r| r.get(0),
    )?;
    let mut stmt = db.prepare(
        "SELECT DISTINCT provider FROM audit WHERE kind='request' AND provider != '' ORDER BY provider LIMIT 200",
    )?;
    let providers = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(
        json!({"items":items,"sessionId":query.session,"total":total,"riskRecordCount":risky,"findingCount":finding_count,"counts":counts,"nextCursor":next,"oldestAtMs":oldest,"providers":providers}),
    )
}

// Filters select sessions; summaries include all retained requests in those sessions.
// Grouping happens before pagination, so one session never splits across list pages.
fn read_sessions(
    db: &Connection,
    query: &Query,
    filter: &str,
    args: &[rusqlite::types::Value],
) -> Result<Value> {
    let cte = format!("WITH matching AS (
        SELECT DISTINCT coalesce(json_extract(a.data,'$.sessionKey'),a.id) AS key FROM audit a WHERE {filter}
    ), grouped AS (
        SELECT coalesce(json_extract(a.data,'$.sessionKey'),a.id) AS key,
        min(a.seq) AS first_seq, max(a.seq) AS last_seq, min(a.at) AS first_at, max(a.at) AS last_at,
        count(*) AS requests,
        sum(coalesce(json_extract(a.data,'$.findingCount'),0)) AS findings,
        sum(CASE WHEN coalesce(json_extract(a.data,'$.findingCount'),0)>0 THEN 1 ELSE 0 END) AS risky,
        sum(CASE WHEN a.outcome IN ('started','streaming') THEN 1 ELSE 0 END) AS active,
        sum(CASE WHEN a.outcome NOT IN ('started','streaming','completed') THEN 1 ELSE 0 END) AS errors,
        sum(CASE WHEN a.inspection IN ('pending','running','partial','failed') THEN 1 ELSE 0 END) AS incomplete,
        sum(CASE WHEN a.inspection = 'limited' THEN 1 ELSE 0 END) AS limited,
        sum(json_extract(a.data,'$.durationMs')) AS duration,
        max(CASE a.severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END) AS severity
        FROM audit a JOIN matching m ON m.key=coalesce(json_extract(a.data,'$.sessionKey'),a.id) WHERE a.kind = 'request' GROUP BY m.key
    )");
    let (total, records, risky, findings): (i64,i64,i64,i64) = db.query_row(
        &format!("{cte} SELECT count(*),coalesce(sum(requests),0),coalesce(sum(risky>0),0),coalesce(sum(findings),0) FROM grouped"),
        params_from_iter(args), |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    let mut page_args = args.to_vec();
    let cursor = if query.cursor > 0 {
        page_args.push(query.cursor.into());
        "WHERE g.last_seq < ?"
    } else {
        ""
    };
    page_args.push(((query.limit + 1) as i64).into());
    let sql = format!("{cte} SELECT g.key,g.last_seq,first.data,
        json_object('firstAtMs',g.first_at,'lastAtMs',g.last_at,'requestCount',g.requests,'findingCount',g.findings,
        'riskRecordCount',g.risky,'activeCount',g.active,'errorCount',g.errors,'incompleteCount',g.incomplete,'limitedCount',g.limited,
        'durationMs',g.duration,'severityRank',g.severity),
        (SELECT json_extract(t.data,'$.sessionTitle') FROM audit t WHERE t.kind='request' AND coalesce(json_extract(t.data,'$.sessionKey'),t.id)=g.key AND json_extract(t.data,'$.sessionTitle') IS NOT NULL ORDER BY t.seq LIMIT 1)
        FROM grouped g JOIN audit first ON first.seq=g.first_seq {cursor} ORDER BY g.last_seq DESC LIMIT ?");
    let mut stmt = db.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(&page_args), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let more = rows.len() > query.limit;
    let mut items = Vec::new();
    for (key, cursor, first, aggregate, title) in rows.into_iter().take(query.limit) {
        let first: Value = serde_json::from_str(&first)?;
        let mut item: Value = serde_json::from_str(&aggregate)?;
        for field in [
            "providerId",
            "target",
            "clientModelId",
            "sessionSource",
            "sessionTitle",
            "kind",
            "action",
        ] {
            item[field] = first[field].clone();
        }
        item["sessionTitle"] = json!(title);
        item["id"] = json!(key);
        item["cursor"] = json!(cursor.to_string());
        item["identified"] = json!(first["sessionKey"].is_string());
        item["severity"] = json!(
            [
                "informational",
                "informational",
                "low",
                "medium",
                "high",
                "critical"
            ][item["severityRank"].as_u64().unwrap_or(1) as usize]
        );
        items.push(item);
    }
    let next = if more {
        items.last().map(|v| v["cursor"].clone())
    } else {
        None
    };
    let oldest: Option<i64> = db.query_row(
        "SELECT min(at) FROM audit WHERE kind != 'management'",
        [],
        |r| r.get(0),
    )?;
    let mut stmt = db.prepare(
        "SELECT DISTINCT provider FROM audit WHERE kind='request' AND provider != '' ORDER BY provider LIMIT 200",
    )?;
    let providers = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(
        json!({"items":items,"sessionId":query.session,"total":total,"recordCount":records,"riskSessionCount":risky,"findingCount":findings,"nextCursor":next,"providers":providers,"oldestAtMs":oldest}),
    )
}

fn content_worker(path: PathBuf, receiver: mpsc::Receiver<ContentJob>) {
    let mut cache = super::content::Cache::default();
    let mut responses = super::response::Cache::default();
    while let Ok(ContentJob {
        audit,
        offset,
        response,
        detail,
        deadline,
        done,
    }) = receiver.recv()
    {
        let cancelled = || done.is_closed() || Instant::now() >= deadline;
        if cancelled() {
            continue;
        }
        let result = (|| -> Result<Value> {
            // Opening here tolerates initial database creation/recovery. This
            // connection never migrates, maintains, or writes audit storage.
            let db =
                Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            db.busy_timeout(Duration::from_millis(250))?;
            let tx = db.unchecked_transaction()?;
            let visible: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM audit WHERE id=? AND kind != 'management')",
                [&audit],
                |r| r.get(0),
            )?;
            let value = if visible {
                if detail {
                    json!({"requestContent":cache.read(&tx, &audit, 0, &cancelled)?,"responseContent":responses.read(&tx, &audit, 0, &cancelled)?})
                } else if response {
                    responses.read(&tx, &audit, offset, &cancelled)?
                } else {
                    cache.read(&tx, &audit, offset, &cancelled)?
                }
            } else {
                Value::Null
            };
            tx.commit()?;
            Ok(value)
        })();
        let _ = done.send(result);
    }
}

fn worker(path: PathBuf, receiver: mpsc::Receiver<Job>, health: Arc<Mutex<Value>>) {
    let mut db = open(&path, true).ok();
    let mut recover_pending = db.is_none();
    update_health(&health, &path, db.is_some(), "audit_open_failed");
    let mut writes = 0;
    let mut reported_loss = 0;
    while let Ok(job) = receiver.recv() {
        if db.is_none() {
            db = open(&path, recover_pending).ok();
            if db.is_some() {
                recover_pending = false;
            }
        }
        match job {
            Job::Body(audit_id, value, done) => {
                let result = db
                    .as_mut()
                    .ok_or_else(|| anyhow::anyhow!("audit_unavailable"))
                    .and_then(|db| {
                        if disk_bytes(&path) > BUDGET * 3 / 4 {
                            maintain(db, &path)?;
                        }
                        if disk_bytes(&path) > BUDGET {
                            bail!("audit_capacity");
                        }
                        persist_body(db, &audit_id, &value)
                    });
                if result.is_err() {
                    let mut h = health.lock().unwrap();
                    h["failedWrites"] = json!(h["failedWrites"].as_u64().unwrap_or(0) + 1);
                    h["state"] = json!(if db.is_some() {
                        "degraded"
                    } else {
                        "unavailable"
                    });
                    h["lastError"] = json!("body_write_failed");
                }
                let _ = done.send(result.is_ok());
            }
            Job::Flush(done) => {
                let ok = db.as_ref().is_some_and(|db| maintain(db, &path).is_ok());
                update_health(&health, &path, ok, "audit_maintenance_failed");
                let _ = done.send(());
            }
            Job::Query(query, done) => {
                let result = db
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("audit_unavailable"))
                    .and_then(|db| {
                        maintain(db, &path)?;
                        read(db, query)
                    });
                update_health(&health, &path, result.is_ok(), "audit_read_failed");
                if result.is_err() {
                    db = None;
                }
                let _ = done.send(result);
            }
            Job::Write(record) => {
                let result = db
                    .as_mut()
                    .ok_or_else(|| anyhow::anyhow!("audit_unavailable"))
                    .and_then(|db| {
                        if writes % 100 == 0 || disk_bytes(&path) > BUDGET * 3 / 4 {
                            maintain(db, &path)?;
                        }
                        if disk_bytes(&path) > BUDGET {
                            bail!("audit_capacity");
                        }
                        persist(db, record)
                    });
                writes += 1;
                let mut h = health.lock().unwrap();
                h["bytes"] = json!(disk_bytes(&path));
                if result.is_ok() {
                    h["lastWrittenAt"] = json!(config::now());
                    let loss = h["failedWrites"].as_u64().unwrap_or(0)
                        + h["droppedWrites"].as_u64().unwrap_or(0);
                    h["state"] = json!(if loss > 0 { "degraded" } else { "ready" });
                    h["lastError"] = Value::Null;
                    drop(h);
                    if loss > reported_loss {
                        let gap = json!({"id":uuid::Uuid::new_v4().to_string(),"atMs":chrono::Utc::now().timestamp_millis(),"at":config::now(),
                            "kind":"system","providerId":"","outcome":"completed","inspectionStatus":"skipped","severity":"informational",
                            "action":"audit.gap","lostWrites":loss-reported_loss,"mode":"record_only","findings":[]});
                        if db.as_mut().is_some_and(|db| persist(db, gap).is_ok()) {
                            reported_loss = loss;
                        }
                    }
                } else {
                    h["failedWrites"] = json!(h["failedWrites"].as_u64().unwrap_or(0) + 1);
                    h["state"] = json!("unavailable");
                    h["lastError"] = json!("audit_write_failed");
                    db = None;
                }
            }
        }
    }
}

fn update_health(health: &Mutex<Value>, path: &Path, ready: bool, error: &str) {
    let mut h = health.lock().unwrap();
    h["bytes"] = json!(disk_bytes(path));
    h["state"] = json!(if !ready {
        "unavailable"
    } else if h["failedWrites"].as_u64().unwrap_or(0) + h["droppedWrites"].as_u64().unwrap_or(0) > 0
    {
        "degraded"
    } else {
        "ready"
    });
    h["lastError"] = if ready { Value::Null } else { json!(error) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_history_is_excluded_without_removing_integrity_records() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = open(&dir.path().join("audit.sqlite3"), true).unwrap();
        let mut management = record("legacy-config", "completed");
        management["kind"] = json!("management");
        management["providerId"] = json!("legacy-config-only");
        management["action"] = json!("config.commit");
        persist(&mut db, management).unwrap();
        let mut gap = record("storage-gap", "completed");
        gap["kind"] = json!("system");
        gap["action"] = json!("audit.gap");
        persist(&mut db, gap).unwrap();
        persist(&mut db, record("agent-request", "completed")).unwrap();
        assert_eq!(read(&db, Query::parse("").unwrap()).unwrap()["total"], 2);
        assert_eq!(
            read(&db, Query::parse("kind=management").unwrap()).unwrap()["total"],
            0
        );
        assert_eq!(
            read(&db, Query::parse("kind=system").unwrap()).unwrap()["total"],
            1
        );
        let mut sessions = Query::parse("").unwrap();
        sessions.sessions = true;
        let result = read(&db, sessions).unwrap();
        assert_eq!(result["total"], 1);
        assert_eq!(result["items"][0]["id"], "agent-request");
        assert!(!result["providers"]
            .as_array()
            .unwrap()
            .contains(&json!("legacy-config-only")));
        assert_eq!(
            read(&db, Query::parse("session=legacy-config").unwrap()).unwrap()["total"],
            0
        );
        for body in [None, Some(("request".into(), 0))] {
            assert!(read(
                &db,
                Query {
                    detail: Some("legacy-config".into()),
                    body,
                    ..Query::default()
                }
            )
            .unwrap()
            .is_null());
        }
        assert_eq!(
            db.query_row("SELECT count(*) FROM audit", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    #[test]
    fn segmented_snapshots_are_lazy_contiguous_immutable_and_range_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.sqlite3");
        let mut db = open(&path, true).unwrap();
        let mut audit = record("segments", "completed");
        audit["inspectionStatus"] = json!("running");
        persist(&mut db, audit).unwrap();
        persist_body(
            &db,
            "segments",
            &json!({"id":"response","state":"receiving","byteLength":0}),
        )
        .unwrap();
        let content = "before 安全 hit";
        persist_body(&db,"segments",&json!({"id":"response","start":0,"end":content.len(),"content":content,"redactions":[]})).unwrap();
        persist_body(&db,"segments",&json!({"id":"evidence/test","state":"complete","sourceSnapshotId":"response","rangeStart":8,"rangeEnd":content.len(),"byteLength":content.len()-8})).unwrap();
        persist_body(&db,"segments",&json!({"id":"response","start":content.len(),"end":content.len()+6,"content":" later","redactions":[]})).unwrap();
        let view = read_body_page(&db, "segments", "evidence/test", 0).unwrap();
        assert_eq!(view["chunks"][0]["content"], "全 hit");
        assert_eq!(view["nextOffset"], Value::Null);
        assert_eq!(view["previousOffset"], Value::Null);
        assert!(!view.to_string().contains("later"));
        assert_eq!(view["gap"], false);
        persist_body(
            &db,
            "segments",
            &json!({"id":"response","state":"complete","byteLength":content.len()+6}),
        )
        .unwrap();
        assert!(persist_body(
            &db,
            "segments",
            &json!({"id":"response","start":0,"end":7,"content":"changed","redactions":[]})
        )
        .is_err());
        assert!(persist_body(&db,"segments",&json!({"id":"response","start":content.len()+6,"end":content.len()+7,"content":"!","redactions":[]})).is_err());
        persist_body(
            &db,
            "segments",
            &json!({"id":"evidence/test","state":"complete","rangeEnd":100000}),
        )
        .unwrap();
        assert_eq!(
            read_body_page(&db, "segments", "evidence/test", 0).unwrap()["rangeEnd"],
            content.len()
        );
        drop(db);
        let db = open(&path, true).unwrap();
        let state = read(
            &db,
            Query {
                detail: Some("segments".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(state["record"]["outcome"], "completed");
        assert_eq!(state["record"]["inspectionStatus"], "partial");
        assert_eq!(state["record"]["inspectionProgress"]["state"], "failed");
        assert!(state["record"]["bodySnapshots"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v.get("body").is_none()));
        db.execute("DELETE FROM audit WHERE id='segments'", [])
            .unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM audit_body_chunks", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    fn record(id: &str, outcome: &str) -> Value {
        json!({"id":id,"atMs":chrono::Utc::now().timestamp_millis(),"at":config::now(),
            "kind":"request","providerId":"provider_one","outcome":outcome,
            "inspectionStatus":"complete","severity":"high","findingCount":1,
            "findings":[{"id":format!("f-{id}"),"requestId":id,"atMs":chrono::Utc::now().timestamp_millis(),
                "category":"destructive_action","severity":"high","confidence":"high","evidenceStage":"tool_call_proposed"}]})
    }

    #[test]
    fn startup_repairs_statuses_only_from_contiguous_framed_terminal_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.sqlite3");
        let mut db = open(&path, true).unwrap();
        for (id, content, expected) in [
            ("completed", "data: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n", "completed"),
            ("claude", "data: {\"type\":\"message_stop\"}\r\n\r\n", "completed"),
            ("done", "data: [DONE]\n\n", "interrupted"),
            ("done-garbage", "data: [DONE]garbage\n\n", "interrupted"),
            ("failed", "data: {\"type\":\"response.failed\"}\n\n", "stream_error"),
            ("incomplete", "data: {\"type\":\"response.incomplete\"}\n\n", "stream_error"),
            ("error-done", "data: {\"type\":\"error\"}\n\ndata: [DONE]\n\n", "interrupted"),
            ("foreign-messages", "data: {\"type\":\"message_stop\"}\n\n", "interrupted"),
            ("foreign-responses", "data: {\"type\":\"response.completed\"}\n\n", "interrupted"),
            ("unknown-protocol", "data: {\"type\":\"response.completed\"}\n\n", "interrupted"),
            ("missing-protocol", "data: {\"type\":\"response.completed\"}\n\n", "interrupted"),
            ("reported-framing-gap", "data: {\"type\":\"response.completed\"}\n\n", "interrupted"),
            ("unframed", "data: {\"type\":\"response.completed\"}\n", "interrupted"),
            ("item-done", "data: {\"type\":\"response.output_item.done\"}\n\n", "interrupted"),
            ("marker-in-text", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"response.completed\"}\n\n", "interrupted"),
            ("missing-prefix", "data: {\"type\":\"response.completed\"}\n\n", "interrupted"),
            ("wrong-length", "data: {\"type\":\"response.completed\"}\n\n", "interrupted"),
            ("capture-gap", "data: {\"type\":\"response.completed\"}\n\n", "interrupted"),
            ("worker-failed", "data: {\"type\":\"response.completed\"}\n\n", "interrupted"),
            ("trailing-fragment", "data: {\"type\":\"response.completed\"}\n\ndata: {", "interrupted"),
        ] {
            let mut audit = record(id, "interrupted");
            audit["protocol"] = json!(match id {
                "claude" | "foreign-responses" => "anthropic.messages",
                "unknown-protocol" => "future.protocol",
                "missing-protocol" => "",
                _ => "openai.responses",
            });
            audit["httpStatus"] = json!(200);
            audit["requestBodyState"] = json!("complete");
            audit["responseBodyState"] = json!("interrupted");
            audit["inspectionStatus"] = json!(if id == "worker-failed" { "failed" } else { "partial" });
            audit["coverageReasons"] = json!(["body_not_complete", "unsupported_tool"]);
            if id == "reported-framing-gap" {
                audit["coverageReasons"] = json!(["body_not_complete", "incomplete_stream_fragment", "missing_terminal_event"]);
            }
            if id == "capture-gap" {
                audit["coverageGaps"] = json!([{"snapshotId":"response"}]);
            }
            persist(&mut db, audit).unwrap();
            persist_body(&db, id, &json!({"id":"response","state":"receiving"})).unwrap();
            let mid = content.len() / 2;
            for (start, end) in [(0, mid), (mid, content.len())] {
                persist_body(&db, id, &json!({"id":"response","start":start,"end":end,"content":&content[start..end],"annotations":[]})).unwrap();
            }
            persist_body(&db, id, &json!({"id":"response","source":"upstream_response","contentMode":"original","state":"interrupted","byteLength":content.len()})).unwrap();
            if id == "missing-prefix" {
                db.execute("DELETE FROM audit_body_chunks WHERE audit_id=? AND start=0", [id]).unwrap();
            }
            if id == "wrong-length" {
                db.execute("UPDATE audit_snapshots SET data=json_set(data,'$.byteLength',999) WHERE audit_id=?", [id]).unwrap();
            }
            let evidence = || db.prepare("SELECT content,redactions FROM audit_body_chunks WHERE audit_id=? ORDER BY start").unwrap().query_map([id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
            let before = evidence();
            restore_security_statuses(&db).unwrap();
            assert_eq!(before, evidence(), "{id}: body bytes and annotations stay unchanged");
            let data: String = db.query_row("SELECT data FROM audit WHERE id=?", [id], |r| r.get(0)).unwrap();
            let audit: Value = serde_json::from_str(&data).unwrap();
            assert_eq!(audit["outcome"], expected, "{id}");
            let state = if expected == "interrupted" {
                if id == "worker-failed" { "failed" } else { "partial" }
            } else { "limited" };
            assert_eq!(audit["inspectionStatus"], state, "{id}");
            let stored_state: String = db.query_row("SELECT json_extract(data,'$.state') FROM audit_snapshots WHERE audit_id=? AND id='response'", [id], |r| r.get(0)).unwrap();
            assert_eq!(stored_state, if expected == "interrupted" { "interrupted" } else { "complete" });
            assert_eq!(audit["findingCount"], 1);
            assert_eq!(db.query_row("SELECT count(*) FROM findings WHERE audit_id=?", [id], |r| r.get::<_, i64>(0)).unwrap(), 1);
            restore_security_statuses(&db).unwrap();
            let again: String = db.query_row("SELECT data FROM audit WHERE id=?", [id], |r| r.get(0)).unwrap();
            assert_eq!(data, again, "{id}: repair is idempotent");
        }
    }

    #[tokio::test]
    async fn startup_does_not_upgrade_delimiters_normalized_by_real_sse_capture() {
        use crate::security::{capture::Redactor, pipeline, BodyCapture};
        use crate::streaming::Spool;
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.sqlite3");
        let store = Store::start(dir.path());
        let request = b"{\"input\":\"hello\"}";
        let response = b"data: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n";
        let spool = |bytes: &[u8]| {
            let mut spool = Spool::new().unwrap();
            spool.write_all(bytes).unwrap();
            spool.seal().unwrap()
        };
        let mut audit = record("normalized-tail", "interrupted");
        audit["protocol"] = json!("openai.responses");
        audit["httpStatus"] = json!(200);
        audit["responseBytes"] = json!(response.len());
        audit["observedBytes"] = json!(request.len() + response.len());
        store.write(audit.clone());
        pipeline::run(
            store.clone(),
            audit,
            json!({}),
            Redactor::new(&json!({})),
            BodyCapture {
                sealed: Some(spool(request)),
                started: true,
                complete: true,
                observed: request.len() as u64,
                ..Default::default()
            },
            BodyCapture {
                sealed: Some(spool(response)),
                started: true,
                observed: response.len() as u64,
                ..Default::default()
            },
            true,
            true,
        );
        store.flush().await;
        drop(store);

        let db = open(&path, false).unwrap();
        let retained: String = db.query_row("SELECT group_concat(content,'') FROM (SELECT content FROM audit_body_chunks WHERE audit_id='normalized-tail' AND snapshot_id='response' ORDER BY start)", [], |r| r.get(0)).unwrap();
        assert!(
            retained.ends_with("\n\n"),
            "the real capture fills in the missing delimiter"
        );
        assert_eq!(retained.len(), response.len() + 1);
        // Recreate a pre-PR record, preserving the original capture's gap reasons.
        db.execute("UPDATE audit SET data=json_remove(data,'$.statusVersion','$.responseTransportState','$.responseTerminalEvent','$.coverageLimitations','$.inspectionIssues') WHERE id='normalized-tail'", []).unwrap();
        drop(db);

        let db = open(&path, true).unwrap();
        let result = read(
            &db,
            Query {
                detail: Some("normalized-tail".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result["record"]["outcome"], "interrupted");
        assert_eq!(result["record"]["responseBodyState"], "interrupted");
        assert_eq!(result["record"]["inspectionStatus"], "partial");
        assert!(result["record"]["responseTerminalEvent"].is_null());
        for reason in [
            "body_not_complete",
            "incomplete_stream_fragment",
            "missing_terminal_event",
        ] {
            assert!(
                config::array(&result["record"]["inspectionIssues"]).contains(&json!(reason)),
                "{reason}"
            );
        }
        assert_eq!(
            result["record"]["bodySnapshots"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["id"] == "response")
                .unwrap()["state"],
            "interrupted"
        );
        let after: String = db.query_row("SELECT group_concat(content,'') FROM (SELECT content FROM audit_body_chunks WHERE audit_id='normalized-tail' AND snapshot_id='response' ORDER BY start)", [], |r| r.get(0)).unwrap();
        assert_eq!(retained, after);
    }

    #[test]
    fn startup_restores_codex_sessions_from_complete_original_headers_only() {
        fn seed(db: &mut Connection, id: &str, content: &str) {
            let mut audit = record(id, "completed");
            audit["target"] = json!("codex");
            audit["protocol"] = json!("openai.responses");
            persist(db, audit).unwrap();
            persist_body(db, id, &json!({"id":"request/headers","state":"receiving"})).unwrap();
            let mid = content.len() / 2;
            for (start, end) in [(0, mid), (mid, content.len())] {
                persist_body(db, id, &json!({"id":"request/headers","start":start,"end":end,"content":&content[start..end],"redactions":[]})).unwrap();
            }
            persist_body(db, id, &json!({"id":"request/headers","source":"observed_headers","contentMode":"original","state":"complete","byteLength":content.len()})).unwrap();
        }
        fn evidence(db: &Connection) -> Vec<String> {
            db.prepare("SELECT json_array(audit_id,id,data) FROM audit_snapshots UNION ALL SELECT json_array(audit_id,snapshot_id,start,end,content,redactions) FROM audit_body_chunks UNION ALL SELECT json_array(id,data) FROM findings ORDER BY 1")
                .unwrap().query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.sqlite3");
        let mut db = open(&path, true).unwrap();
        for session in ["one", "two"] {
            for (i, header) in ["session-id", "session_id", "thread-id"].iter().enumerate() {
                seed(
                    &mut db,
                    &format!("{session}-{i}"),
                    &json!({*header:[session]}).to_string(),
                );
            }
        }
        let valid = json!({"session-id":["one"]}).to_string();
        for id in [
            "other-provider",
            "already-grouped",
            "claude",
            "gap",
            "redacted",
            "missing-chunk",
            "wrong-length",
            "oversized",
        ] {
            seed(&mut db, id, &valid);
        }
        seed(&mut db, "invalid-json", "{invalid}");
        seed(
            &mut db,
            "invalid-id",
            &json!({"session-id":["not a session"]}).to_string(),
        );
        seed(
            &mut db,
            "no-id",
            &json!({"x-client-request-id":["one"]}).to_string(),
        );
        db.execute("UPDATE audit SET data=json_set(data,'$.providerId','provider_two') WHERE id='other-provider'", []).unwrap();
        db.execute("UPDATE audit SET data=json_set(data,'$.sessionKey','keep-existing','$.sessionSource','metadata.session_id') WHERE id='already-grouped'", []).unwrap();
        db.execute(
            "UPDATE audit SET data=json_set(data,'$.target','claude-code') WHERE id='claude'",
            [],
        )
        .unwrap();
        db.execute(
            "UPDATE audit_snapshots SET data=json_set(data,'$.state','gap') WHERE audit_id='gap'",
            [],
        )
        .unwrap();
        db.execute("UPDATE audit_snapshots SET data=json_set(data,'$.contentMode','redacted') WHERE audit_id='redacted'", []).unwrap();
        db.execute(
            "DELETE FROM audit_body_chunks WHERE audit_id='missing-chunk' AND start=0",
            [],
        )
        .unwrap();
        db.execute("UPDATE audit_snapshots SET data=json_set(data,'$.byteLength',999) WHERE audit_id='wrong-length'", []).unwrap();
        db.execute("UPDATE audit_snapshots SET data=json_set(data,'$.byteLength',999999) WHERE audit_id='oversized'", []).unwrap();
        let before = evidence(&db);
        drop(db);
        let db = open(&path, true).unwrap();
        for session in ["one", "two"] {
            let trace = read(&db, Query::parse(&format!("session={session}-0")).unwrap()).unwrap();
            assert_eq!(trace["total"], 3);
            let mut expected =
                json!({"kind":"request","providerId":"provider_one","protocol":"openai.responses"});
            super::super::session::identify(&mut expected, session, "session-id");
            assert_eq!(trace["sessionId"], expected["sessionKey"]);
        }
        assert_eq!(
            read(&db, Query::parse("session=other-provider").unwrap()).unwrap()["total"],
            1
        );
        assert_eq!(
            read(&db, Query::parse("session=already-grouped").unwrap()).unwrap()["sessionId"],
            "keep-existing"
        );
        for id in [
            "claude",
            "gap",
            "redacted",
            "missing-chunk",
            "wrong-length",
            "oversized",
            "invalid-json",
            "invalid-id",
            "no-id",
        ] {
            let result = read(&db, Query::parse(&format!("session={id}")).unwrap()).unwrap();
            assert_eq!(result["total"], 1, "{id}");
            assert!(result["items"][0]["sessionKey"].is_null(), "{id}");
        }
        let mut query = Query::parse("").unwrap();
        query.sessions = true;
        let sessions = read(&db, query).unwrap();
        assert_eq!(
            sessions["items"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item["requestCount"] == 3)
                .count(),
            2
        );
        assert_eq!(
            before,
            evidence(&db),
            "snapshots, chunks and findings stay unchanged"
        );
        let changes = db.total_changes();
        restore_codex_sessions(&db).unwrap();
        assert_eq!(
            db.total_changes(),
            changes,
            "repeated recovery leaves existing identities alone"
        );
        assert_eq!(
            read(&db, Query::parse("session=one-0").unwrap()).unwrap()["total"],
            3
        );
    }

    #[test]
    fn body_budget_reclaims_completed_records_before_disk_maintenance_threshold() {
        for restart in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("audit.sqlite3");
            let mut db = open(&path, true).unwrap();
            persist(&mut db, record("old", "completed")).unwrap();
            persist_body(&db, "old", &json!({"id":"request","state":"receiving"})).unwrap();
            // Reproduce an existing database between the old 80 MiB write limit
            // and the 96 MiB disk-maintenance threshold, using normal-size pages.
            let tx = db.transaction().unwrap();
            let mut offset = 0;
            {
                let content = "x".repeat(crate::streaming::PAGE);
                let mut insert = tx.prepare("INSERT INTO audit_body_chunks(audit_id,snapshot_id,start,end,content,redactions) VALUES('old','request',?,?,?,'[]')").unwrap();
                while used_bytes(&tx).unwrap() < 84 * 1024 * 1024 {
                    insert
                        .execute(params![offset, offset + content.len(), content])
                        .unwrap();
                    offset += content.len();
                }
            }
            tx.commit().unwrap();
            persist_body(
                &db,
                "old",
                &json!({"id":"request","state":"complete","byteLength":offset}),
            )
            .unwrap();
            db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
            assert!(used_bytes(&db).unwrap() > body_budget());
            assert!(disk_bytes(&path) < BUDGET * 3 / 4);
            if restart {
                drop(db);
                db = open(&path, true).unwrap();
            }
            persist(&mut db, record("streaming", "streaming")).unwrap();
            let mut pending = record("pending", "completed");
            pending["inspectionStatus"] = json!("pending");
            persist(&mut db, pending).unwrap();
            for i in 0..3 {
                let id = format!("new-{i}");
                let mut current = record(&id, "completed");
                current["inspectionStatus"] = json!("running");
                persist(&mut db, current).unwrap();
                persist_body(&db, &id, &json!({"id":"request","state":"receiving"})).unwrap();
                persist_body(
                    &db,
                    &id,
                    &json!({"id":"request","start":0,"end":5,"content":"hello","redactions":[]}),
                )
                .unwrap();
                persist_body(
                    &db,
                    &id,
                    &json!({"id":"request","state":"complete","byteLength":5}),
                )
                .unwrap();
                persist(&mut db, record(&id, "completed")).unwrap();
                assert_eq!(
                    read_body_page(&db, &id, "request", 0).unwrap()["chunks"][0]["content"],
                    "hello"
                );
            }
            assert!(used_bytes(&db).unwrap() < body_budget());
            assert_eq!(
                db.query_row("SELECT count(*) FROM audit WHERE id='old'", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                db.query_row(
                    "SELECT count(*) FROM audit_body_chunks WHERE audit_id='old'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            assert_eq!(
                db.query_row(
                    "SELECT count(*) FROM audit WHERE id IN ('streaming','pending')",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                2
            );
        }
    }

    #[test]
    fn failed_but_active_inspections_keep_findings_and_bodies_during_all_retention_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.sqlite3");
        let mut db = open(&path, true).unwrap();
        let mut failed = record("active", "completed");
        failed["atMs"] = json!(chrono::Utc::now().timestamp_millis() - 31 * 86_400_000);
        failed["inspectionStatus"] = json!("failed");
        failed["inspectionProgress"] = json!({"state":"failed","phase":"detecting","active":true});
        persist(&mut db, failed.clone()).unwrap();
        persist_body(&db, "active", &json!({"id":"request","state":"receiving"})).unwrap();
        persist_body(
            &db,
            "active",
            &json!({"id":"request","start":0,"end":8,"content":"evidence","redactions":[]}),
        )
        .unwrap();
        assert_eq!(prune_completed(&db, Some("another-request")).unwrap(), 0);
        maintain(&db, &path).unwrap();
        let detail = read(
            &db,
            Query {
                detail: Some("active".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(detail["record"]["findingCount"], 1);
        assert_eq!(
            read_body_page(&db, "active", "request", 0).unwrap()["chunks"][0]["content"],
            "evidence"
        );
        failed["inspectionProgress"]["active"] = json!(false);
        persist(&mut db, failed).unwrap();
        assert_eq!(prune_completed(&db, Some("another-request")).unwrap(), 1);
        assert_eq!(
            read_body_page(&db, "active", "request", 0).unwrap(),
            Value::Null
        );
    }

    #[test]
    fn restart_ends_failed_active_inspections_without_losing_prior_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.sqlite3");
        let mut db = open(&path, true).unwrap();
        let mut failed = record("failed-active", "completed");
        failed["inspectionStatus"] = json!("failed");
        failed["inspectionProgress"] = json!({"state":"failed","phase":"detecting","active":true});
        failed["coverageReasons"] = json!(["body_storage_or_processing_failure"]);
        persist(&mut db, failed).unwrap();
        persist_body(
            &db,
            "failed-active",
            &json!({"id":"response","state":"receiving"}),
        )
        .unwrap();
        drop(db);
        let db = open(&path, true).unwrap();
        let detail = read(
            &db,
            Query {
                detail: Some("failed-active".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(detail["record"]["outcome"], "completed");
        assert_eq!(detail["record"]["inspectionStatus"], "failed");
        assert_eq!(detail["record"]["inspectionProgress"]["active"], false);
        assert_eq!(detail["record"]["inspectionProgress"]["phase"], "finished");
        assert_eq!(
            detail["record"]["coverageReasons"],
            json!(["body_storage_or_processing_failure", "daemon_restarted"])
        );
        assert_eq!(detail["record"]["findingCount"], 1);
        assert_eq!(detail["record"]["bodySnapshots"][0]["state"], "gap");
        assert_eq!(prune_completed(&db, None).unwrap(), 1);
    }

    #[test]
    fn snapshots_deduplicate_findings_and_keep_keyset_pages_stable() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = open(&dir.path().join("audit.sqlite3"), true).unwrap();
        for id in ["a", "b", "c"] {
            persist(&mut db, record(id, "streaming")).unwrap();
        }
        let page = read(&db, Query::parse("limit=2&provider=provider_one").unwrap()).unwrap();
        assert_eq!(page["total"], 3);
        assert_eq!(page["items"][0]["id"], "c");
        let mut final_record = record("a", "completed");
        final_record["providerId"] = json!("provider_two");
        persist(&mut db, final_record).unwrap();
        persist(&mut db, record("d", "completed")).unwrap();
        let next = read(
            &db,
            Query::parse(&format!(
                "limit=2&cursor={}",
                page["nextCursor"].as_str().unwrap()
            ))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(next["items"].as_array().unwrap().len(), 1);
        assert_eq!(next["items"][0]["id"], "a");
        assert_eq!(next["items"][0]["outcome"], "completed");
        let findings = read(&db, Query::parse("provider=provider_two&category=destructive_action&severity=high&confidence=high&stage=tool_call_proposed&outcome=completed").unwrap()).unwrap();
        assert_eq!(findings["total"], 1);
        assert_eq!(findings["riskRecordCount"], 1);
        assert_eq!(findings["counts"]["high"], 1);
        let detail = read(
            &db,
            Query {
                detail: Some("a".into()),
                ..Query::default()
            },
        )
        .unwrap();
        assert_eq!(detail["record"]["findings"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn restart_recovers_only_unfinished_requests_and_retention_cascades() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.sqlite3");
        let mut db = open(&path, true).unwrap();
        let mut unfinished = record("unfinished", "streaming");
        unfinished["coverageReasons"] = json!(["unsupported_tool"]);
        persist(&mut db, unfinished).unwrap();
        persist(&mut db, record("completed", "completed")).unwrap();
        let mut old = record("expired", "completed");
        old["atMs"] = json!(chrono::Utc::now().timestamp_millis() - 31 * 86_400_000);
        persist(&mut db, old).unwrap();
        drop(db);
        let db = open(&path, true).unwrap();
        let result = read(&db, Query::parse("hours=720").unwrap()).unwrap();
        assert_eq!(result["total"], 2);
        let detail = read(
            &db,
            Query {
                detail: Some("unfinished".into()),
                ..Query::default()
            },
        )
        .unwrap();
        assert_eq!(detail["record"]["outcome"], "unknown");
        assert_eq!(detail["record"]["inspectionStatus"], "partial");
        assert_eq!(
            detail["record"]["coverageReasons"],
            json!(["unsupported_tool", "daemon_restarted"])
        );
        let findings: i64 = db
            .query_row("SELECT count(*) FROM findings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(findings, 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn failed_storage_recovers_with_a_persisted_gap_and_health() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.sqlite3");
        std::fs::create_dir(&path).unwrap();
        let store = Store::start(dir.path());
        store.write(record("lost", "completed"));
        store.flush().await;
        assert!(store.query(Query::parse("").unwrap()).await.is_err());
        assert_eq!(store.status()["state"], "unavailable");
        assert_eq!(store.status()["failedWrites"], 1);
        assert!(!store.body("lost", json!({"id":"request","state":"receiving"})));
        assert_eq!(store.status()["state"], "unavailable");
        assert_eq!(store.status()["failedWrites"], 2);
        store.write(json!({"oversize":"x".repeat(MAX_RECORD)}));
        assert_eq!(store.status()["state"], "unavailable");
        assert_eq!(store.status()["droppedWrites"], 1);
        std::fs::remove_dir(path).unwrap();
        store.write(record("retained", "completed"));
        store.flush().await;
        let result = store
            .query(Query::parse("kind=system").unwrap())
            .await
            .unwrap();
        assert_eq!(result["items"][0]["action"], "audit.gap");
        assert_eq!(result["items"][0]["lostWrites"], 3);
        assert_eq!(result["storage"]["state"], "degraded");
    }

    #[test]
    fn queue_and_record_limits_are_visible_and_queries_reject_unsafe_filters() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let (content_sender, _content_receiver) = mpsc::sync_channel(1);
        let store = Store {
            sender,
            content_sender,
            health: Arc::new(Mutex::new(json!({}))),
        };
        store.write(record("queued", "completed"));
        store.write(record("overflow", "completed"));
        store.write(json!({"oversize":"x".repeat(MAX_RECORD)}));
        assert_eq!(store.status()["droppedWrites"], 2);
        assert_eq!(store.status()["state"], "degraded");
        for query in [
            "hours=0",
            "limit=101",
            "cursor=-1",
            "severity=untrusted",
            "provider=%27%20OR%201=1",
            "unknown=1",
        ] {
            assert!(Query::parse(query).is_err(), "{query}");
        }
        assert!(Query::parse("stage=tool_call_proposed").is_ok());
    }

    #[tokio::test]
    async fn queued_overviews_never_block_audit_queries_or_body_writes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::start(dir.path());
        store.write(record("reading", "completed"));
        store.flush().await;
        // Hold the overview receiver without running it. This proves isolation
        // deterministically instead of relying on how fast a machine parses JSON.
        let (content_sender, content_receiver) = mpsc::sync_channel(4);
        let isolated = Arc::new(Store {
            sender: store.sender.clone(),
            content_sender,
            health: store.health.clone(),
        });
        let mut reads = Vec::new();
        for _ in 0..4 {
            let store = isolated.clone();
            reads.push(tokio::spawn(async move {
                store
                    .query(Query {
                        detail: Some("reading".into()),
                        content_offset: Some(0),
                        ..Query::default()
                    })
                    .await
            }));
        }
        let (pending, content_receiver) = tokio::task::spawn_blocking(move || {
            let pending = (0..4)
                .map(|_| {
                    content_receiver
                        .recv_timeout(Duration::from_secs(10))
                        .unwrap()
                })
                .collect::<Vec<_>>();
            (pending, content_receiver)
        })
        .await
        .unwrap();
        // Keep the receiver alive and fill its queue to verify bounded rejection.
        for _ in 0..4 {
            let (done, _result) = oneshot::channel();
            isolated
                .content_sender
                .try_send(ContentJob {
                    audit: "reading".into(),
                    offset: 0,
                    response: false,
                    detail: false,
                    deadline: Instant::now() + Duration::from_secs(30),
                    done,
                })
                .unwrap();
        }
        // Complete audit IO while the overview receiver remains blocked.
        // The deadline guards deadlocks, not machine-dependent IO speed.
        tokio::time::timeout(Duration::from_secs(10), async {
            let busy = isolated
                .query(Query {
                    detail: Some("reading".into()),
                    content_offset: Some(0),
                    ..Query::default()
                })
                .await;
            assert!(busy.is_err());
            let writer = isolated.clone();
            assert!(tokio::task::spawn_blocking(move || {
                writer.write(record("new-write", "completed"));
                writer.body(
                    "new-write",
                    json!({"id":"request","state":"receiving","byteLength":0}),
                )
            })
            .await
            .unwrap());
            let listed = isolated.query(Query::parse("").unwrap()).await.unwrap();
            assert_eq!(listed["total"], 2);
            let body = isolated
                .query(Query {
                    detail: Some("new-write".into()),
                    body: Some(("request".into(), 0)),
                    ..Query::default()
                })
                .await
                .unwrap();
            assert_eq!(body["state"], "receiving");
        })
        .await
        .expect("audit IO must complete while the overview receiver is blocked");
        for job in pending {
            let _ = job.done.send(Ok(json!({"items":[],"state":"complete"})));
        }
        for read in reads {
            assert!(read.await.unwrap().is_ok());
        }
        drop(content_receiver);
        assert_eq!(store.status()["failedWrites"], 0);
        assert_eq!(store.status()["droppedWrites"], 0);
    }

    #[test]
    fn corrupt_or_newer_databases_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let corrupt = dir.path().join("corrupt.sqlite3");
        std::fs::write(&corrupt, b"not a database").unwrap();
        assert!(open(&corrupt, true).is_err());
        assert_eq!(std::fs::read(&corrupt).unwrap(), b"not a database");
        let newer = dir.path().join("newer.sqlite3");
        let db = open(&newer, true).unwrap();
        db.execute_batch("PRAGMA user_version=4").unwrap();
        drop(db);
        assert!(open(&newer, true).is_err());
        let version: i64 = Connection::open(newer)
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 4);
    }

    #[test]
    fn unified_filters_count_records_once_and_all_their_findings() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = open(&dir.path().join("audit.sqlite3"), true).unwrap();
        let mut risky = record("many", "completed");
        let mut second = risky["findings"][0].clone();
        second["id"] = json!("second");
        second["confidence"] = json!("low");
        let mut third = second.clone();
        third["id"] = json!("third");
        third["category"] = json!("sensitive_data");
        third["evidenceStage"] = json!("request_content");
        risky["findings"]
            .as_array_mut()
            .unwrap()
            .extend([second, third]);
        persist(&mut db, risky).unwrap();
        let mut clean = record("clean", "completed");
        clean["findings"] = json!([]);
        clean["severity"] = json!("informational");
        persist(&mut db, clean).unwrap();
        let all = read(&db, Query::parse("limit=1").unwrap()).unwrap();
        assert_eq!(all["total"], 2);
        assert_eq!(all["riskRecordCount"], 1);
        assert_eq!(all["findingCount"], 3);
        assert_eq!(all["items"][0]["findingCount"], 0);
        for query in [
            "hasRisk=true",
            "category=destructive_action",
            "severity=high&category=sensitive_data",
            "confidence=low&stage=request_content",
        ] {
            let result = read(&db, Query::parse(query).unwrap()).unwrap();
            assert_eq!(result["total"], 1, "{query}");
            assert_eq!(result["findingCount"], 3, "{query}");
            assert_eq!(result["items"][0]["findingCount"], 3);
        }
        let none = read(
            &db,
            Query::parse("category=sensitive_data&confidence=high").unwrap(),
        )
        .unwrap();
        assert_eq!(
            none["total"], 0,
            "finding predicates must match the same finding"
        );
        let clean = read(&db, Query::parse("hasRisk=false").unwrap()).unwrap();
        assert_eq!(clean["total"], 1);
        assert_eq!(clean["riskRecordCount"], 0);
        assert_eq!(clean["findingCount"], 0);
    }

    #[tokio::test]
    async fn legacy_schemas_migrate_and_preserve_immutable_snapshots() {
        for version in [1, 2] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("audit.sqlite3");
            let mut db = open(&path, true).unwrap();
            persist(&mut db, record("legacy", "completed")).unwrap();
            if version == 1 {
                db.execute_batch("DROP TABLE audit_snapshots; PRAGMA user_version=1")
                    .unwrap();
            } else {
                // Seed the stored format directly; retired writers are not needed to read old data.
                db.execute(
                    "INSERT INTO audit_snapshots(audit_id,id,data) VALUES(?,?,?)",
                    params![
                        "legacy",
                        "evidence/one",
                        json!({"id":"evidence/one","body":"first content"}).to_string()
                    ],
                )
                .unwrap();
                db.execute_batch("PRAGMA user_version=2").unwrap();
            }
            drop(db);
            let store = Store::start(dir.path());
            let detail = store
                .query(Query {
                    detail: Some("legacy".into()),
                    ..Query::default()
                })
                .await
                .unwrap();
            assert_eq!(detail["record"]["findings"].as_array().unwrap().len(), 1);
            let db = open(&path, false).unwrap();
            assert_eq!(
                db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                3
            );
            if version == 1 {
                assert_eq!(detail["record"]["bodySnapshots"], json!([]));
            } else {
                assert_eq!(
                    detail["record"]["bodySnapshots"],
                    json!([{"id":"evidence/one"}])
                );
                persist_body(
                    &db,
                    "legacy",
                    &json!({"id":"evidence/one","state":"complete","body":"later content"}),
                )
                .unwrap();
                let page = store
                    .query(Query {
                        detail: Some("legacy".into()),
                        body: Some(("evidence/one".into(), 0)),
                        ..Query::default()
                    })
                    .await
                    .unwrap();
                assert_eq!(page["legacySnapshot"]["body"], "first content");
            }
            db.execute("UPDATE audit SET at=0 WHERE id='legacy'", [])
                .unwrap();
            maintain(&db, &path).unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM audit_snapshots", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }
}
