use crate::config;
use anyhow::{bail, Result};
use rusqlite::{params, params_from_iter, Connection};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
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

pub struct Store {
    sender: mpsc::SyncSender<Job>,
    health: Arc<Mutex<Value>>,
}

#[derive(Default)]
pub struct Query {
    pub detail: Option<String>,
    pub sessions: bool,
    pub session: Option<String>,
    pub body: Option<(String, u64)>,
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
                    "pending", "running", "complete", "partial", "failed", "skipped",
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
        let store = Arc::new(Self {
            sender,
            health: health.clone(),
        });
        let worker_health = health.clone();
        if std::thread::Builder::new()
            .name("security-audit".into())
            .spawn(move || worker(path, receiver, worker_health))
            .is_err()
        {
            health.lock().unwrap()["state"] = json!("unavailable");
        }
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
        let (tx, rx) = oneshot::channel();
        self.sender
            .try_send(Job::Query(query, tx))
            .map_err(|_| anyhow::anyhow!("audit_busy"))?;
        let mut value = tokio::time::timeout(Duration::from_secs(5), rx).await???;
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
    }
    maintain(&db, path)?;
    Ok(db)
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
        sum(CASE WHEN a.inspection != 'complete' AND a.inspection != 'skipped' THEN 1 ELSE 0 END) AS incomplete,
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
        'riskRecordCount',g.risky,'activeCount',g.active,'errorCount',g.errors,'incompleteCount',g.incomplete,
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
        let store = Store {
            sender,
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
