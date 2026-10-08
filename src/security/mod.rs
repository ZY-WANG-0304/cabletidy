mod capture;
mod pipeline;
mod rules;
mod session;
mod sse;
pub mod store;

use crate::{
    config,
    streaming::{self, Spool},
};
use capture::Redactor;
use serde_json::{json, Value};
use std::{
    io::Write,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tokio::sync::Semaphore;

pub struct Security {
    pub store: Arc<store::Store>,
    workers: Arc<Semaphore>,
    jobs: Arc<AtomicUsize>,
}
impl Security {
    pub fn new(home: &std::path::Path) -> Self {
        Self {
            store: store::Store::start(home),
            workers: Arc::new(Semaphore::new(4)),
            jobs: Arc::new(AtomicUsize::new(0)),
        }
    }
    pub fn status(&self) -> Value {
        json!({"mode":"record_only","ruleVersion":"2","categories":rules::CATEGORIES,"storage":self.store.status(),
            "resources":streaming::usage(),"limits":{"bodyPageBytes":4*streaming::PAGE,"concurrentInspections":4},
            "pendingInspections":self.jobs.load(Ordering::Acquire),
            "coverage":["known_credentials","credential_patterns","structured_tool_calls","literal_shell_commands","external_instruction_heuristics"]})
    }
    pub async fn flush(&self) {
        while self.jobs.load(Ordering::Acquire) > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        self.store.flush().await;
    }
    pub fn audit(&self, mut metadata: Value, secrets: &Value) -> Arc<Audit> {
        let redactor = Redactor::new(secrets);
        limit_labels(&mut metadata);
        metadata["id"] = json!(uuid::Uuid::new_v4().to_string());
        metadata["at"] = json!(config::now());
        metadata["atMs"] = json!(chrono::Utc::now().timestamp_millis());
        metadata["schemaVersion"] = json!(4);
        metadata["mode"] = json!("record_only");
        metadata["outcome"] = json!("started");
        metadata["ruleVersion"] = json!("2");
        metadata["requestBodyState"] = json!("pending");
        metadata["responseBodyState"] = json!("pending");
        metadata["executionStatus"] = json!("unknown");
        metadata["inspectionStatus"] = json!("pending");
        metadata["severity"] = json!("informational");
        metadata["findingCount"] = json!(0);
        metadata["findings"] = json!([]);
        metadata["inspectionProgress"] = json!({"state":"pending","phase":"receiving","active":true,"processedBytes":0,"observedBytes":0});
        let audit = Arc::new(Audit {
            store: self.store.clone(),
            workers: self.workers.clone(),
            jobs: self.jobs.clone(),
            started: Instant::now(),
            state: Mutex::new(AuditState {
                record: metadata,
                redactor: Some(redactor),
                secrets: secrets.clone(),
                finished: false,
                response_attached: false,
                sse: false,
                request: BodyCapture::default(),
                response: BodyCapture::default(),
            }),
        });
        audit.publish();
        audit
    }
}
fn limit_labels(record: &mut Value) {
    for key in [
        "providerId",
        "configurationId",
        "clientModelId",
        "upstreamModelId",
        "upstreamId",
        "bindingId",
    ] {
        if let Some(v) = record.get_mut(key) {
            if v.as_str().is_some_and(|s| s.len() > 1024) {
                *v = json!("[metadata omitted: audit envelope budget]");
            }
        }
    }
}
pub(crate) struct BodyCapture {
    spool: Option<Spool>,
    sealed: Option<Arc<Spool>>,
    observed: u64,
    headers: Value,
    started: bool,
    complete: bool,
    gap: bool,
}
impl Default for BodyCapture {
    fn default() -> Self {
        Self {
            spool: None,
            sealed: None,
            observed: 0,
            headers: json!({}),
            started: false,
            complete: false,
            gap: false,
        }
    }
}
impl BodyCapture {
    fn feed(&mut self, bytes: &[u8]) {
        self.started = true;
        self.observed += bytes.len() as u64;
        if self.gap {
            return;
        }
        if self.spool.is_none() {
            self.spool = Spool::new().ok();
        }
        if self
            .spool
            .as_mut()
            .is_none_or(|s| s.write_all(bytes).is_err())
        {
            self.gap = true;
        }
    }
    fn seal(&mut self) {
        if self.sealed.is_none() {
            if self.started && !self.gap && self.spool.is_none() {
                self.spool = Spool::new().ok();
            }
            self.sealed = self.spool.take().and_then(|s| s.seal().ok());
            if self.started && self.sealed.is_none() {
                self.gap = true;
            }
        }
    }
}
fn headers_value(headers: &axum::http::HeaderMap) -> Value {
    let mut value = json!({});
    for key in headers.keys() {
        value[key.as_str()] = json!(headers
            .get_all(key)
            .iter()
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
            .collect::<Vec<_>>());
    }
    value
}
struct AuditState {
    record: Value,
    redactor: Option<Redactor>,
    secrets: Value,
    finished: bool,
    response_attached: bool,
    sse: bool,
    request: BodyCapture,
    response: BodyCapture,
}
pub struct Audit {
    store: Arc<store::Store>,
    workers: Arc<Semaphore>,
    jobs: Arc<AtomicUsize>,
    state: Mutex<AuditState>,
    started: Instant,
}
impl Audit {
    pub fn request_headers(&self, headers: &axum::http::HeaderMap) {
        let mut s = self.state.lock().unwrap();
        for key in ["session_id", "x-session-id", "x-codex-session-id"] {
            if let Some(id) = headers.get(key).and_then(|v| v.to_str().ok()) {
                session::identify(&mut s.record, id, key);
            }
        }
        let h = headers_value(headers);
        if let Some(r) = &mut s.redactor {
            r.observe(&h);
        }
        s.request.headers = h;
    }
    pub fn request_spool(&self, spool: Arc<Spool>, complete: bool) {
        let mut s = self.state.lock().unwrap();
        if let Some(r) = &mut s.redactor {
            pipeline::learn_credentials(&spool, r);
        }
        s.request.observed = spool
            .len
            .max(s.record["requestObservedBytes"].as_u64().unwrap_or(0));
        s.request.gap = !s.record["captureGap"].is_null();
        s.request.started = true;
        s.request.complete = complete;
        s.request.sealed = Some(spool);
    }
    pub fn is_response_attached(&self) -> bool {
        self.state.lock().unwrap().response_attached
    }
    pub fn local_body(&self, bytes: &[u8], headers: &axum::http::HeaderMap) {
        let mut s = self.state.lock().unwrap();
        s.response.headers = headers_value(headers);
        s.response.feed(bytes);
        s.response.complete = true;
    }
    pub fn redact(&self, value: &mut Value) {
        if let Some(r) = &self.state.lock().unwrap().redactor {
            r.sanitize(value);
        }
    }
    pub fn publish(&self) {
        self.store.write(self.state.lock().unwrap().record.clone());
    }
    pub fn set(&self, key: &str, value: Value) {
        let mut s = self.state.lock().unwrap();
        s.record[key] = value;
        limit_labels(&mut s.record);
    }
    pub fn response(&self, status: u16, sse: bool, headers: &axum::http::HeaderMap) {
        let mut s = self.state.lock().unwrap();
        s.response_attached = true;
        s.sse = sse;
        s.response.started = true;
        s.response.headers = headers_value(headers);
        s.record["httpStatus"] = json!(status);
        s.record["headersMs"] = json!(self.started.elapsed().as_millis());
        s.record["outcome"] = json!("streaming");
        self.store.write(s.record.clone());
    }
    pub fn feed(&self, bytes: &[u8]) {
        let mut s = self.state.lock().unwrap();
        let before = s.response.observed;
        s.response.feed(bytes);
        s.record["responseBytes"] = json!(s.response.observed);
        if before / 1048576 != s.response.observed / 1048576 {
            s.record["inspectionProgress"]["observedBytes"] =
                json!(s.request.observed + s.response.observed);
            self.store.write(s.record.clone());
        }
    }
    pub fn eof(&self) {
        let mut s = self.state.lock().unwrap();
        if s.finished {
            return;
        }
        s.response.complete = true;
        let outcome = if s.record["httpStatus"].as_u64().unwrap_or(500) >= 400 {
            "upstream_error"
        } else {
            "completed"
        };
        self.finish_locked(&mut s, outcome);
    }
    pub fn finish(&self, outcome: &str) {
        self.finish_locked(&mut self.state.lock().unwrap(), outcome);
    }
    pub fn finish_local(&self, status: u16) {
        let mut s = self.state.lock().unwrap();
        if s.response_attached || s.finished {
            return;
        }
        s.record["httpStatus"] = json!(status);
        self.finish_locked(
            &mut s,
            if status >= 400 {
                "local_error"
            } else {
                "completed"
            },
        );
    }
    fn finish_locked(&self, s: &mut AuditState, outcome: &str) {
        if s.finished {
            return;
        }
        s.finished = true;
        s.request.seal();
        s.response.seal();
        s.record["outcome"] = json!(outcome);
        s.record["finishedAt"] = json!(config::now());
        s.record["durationMs"] = json!(self.started.elapsed().as_millis());
        s.record["observedBytes"] = json!(s.request.observed + s.response.observed);
        s.record["inspectionProgress"]["observedBytes"] = s.record["observedBytes"].clone();
        s.record["inspectionProgress"]["phase"] = json!("queued");
        self.store.write(s.record.clone());
        let request = std::mem::take(&mut s.request);
        let response = std::mem::take(&mut s.response);
        let record = s.record.clone();
        let sse = s.sse;
        let upstream = s.response_attached;
        let secrets = s.secrets.take();
        let redactor = s.redactor.take().unwrap();
        let store = self.store.clone();
        let workers = self.workers.clone();
        let jobs = self.jobs.clone();
        jobs.fetch_add(1, Ordering::AcqRel);
        tokio::spawn(async move {
            let _permit = workers.acquire_owned().await;
            let failed_store = store.clone();
            let mut failed_record = record.clone();
            if tokio::task::spawn_blocking(move || {
                pipeline::run(
                    store, record, secrets, redactor, request, response, sse, upstream,
                )
            })
            .await
            .is_err()
            {
                failed_record["inspectionStatus"] = json!("failed");
                failed_record["coverageReasons"] = json!(["inspection_worker_failed"]);
                failed_record["inspectionProgress"]["state"] = json!("failed");
                failed_record["inspectionProgress"]["active"] = json!(false);
                failed_record["inspectionProgress"]["phase"] = json!("finished");
                failed_store.write(failed_record);
            }
            jobs.fetch_sub(1, Ordering::AcqRel);
        });
    }
}
pub struct RequestGuard(pub Option<Arc<Audit>>);
impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Some(audit) = &self.0 {
            let mut s = audit.state.lock().unwrap();
            if !s.response_attached && !s.finished {
                audit.finish_locked(&mut s, "interrupted");
            }
        }
    }
}
pub struct ResponseGuard(pub Option<Arc<Audit>>);
impl Drop for ResponseGuard {
    fn drop(&mut self) {
        if let Some(a) = &self.0 {
            a.finish("interrupted");
        }
    }
}
