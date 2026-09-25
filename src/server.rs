use crate::{
    catalog::{self, Catalog},
    config::{self, array, entries, text, Paths},
    lifecycle, model, targets, validation,
};
use anyhow::{bail, Context, Result};
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::State,
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, Uri},
    response::Response,
    routing::any,
    Router,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex, RwLock,
    },
    time::{Duration, Instant},
};
use tokio::sync::Mutex as AsyncMutex;

const MAX_BODY: usize = 8 * 1024 * 1024;
#[derive(Clone)]
pub struct Snapshot {
    pub config: Value,
    pub secrets: Value,
}
pub struct AppState {
    pub paths: Paths,
    pub targets: targets::Options,
    pub identity: Value,
    pub started: String,
    pub snapshot: RwLock<Arc<Snapshot>>,
    events: Mutex<VecDeque<Value>>,
    health: Mutex<Value>,
    config_operation: AsyncMutex<()>,
    target_operation: AsyncMutex<()>,
    pub catalog: Catalog,
    client: reqwest::Client,
    claude_client: reqwest::Client,
    jobs: AtomicUsize,
}
impl AppState {
    fn snapshot(&self) -> Arc<Snapshot> {
        self.snapshot.read().unwrap().clone()
    }
    fn event(&self, kind: &str, data: Value) {
        let mut e = self.events.lock().unwrap();
        e.push_back(json!({"id":uuid::Uuid::new_v4().simple().to_string(),"type":kind,"at":config::now(),"data":data}));
        if e.len() > 200 {
            e.pop_front();
        }
    }
    fn health(&self, id: &str, outcome: &str, status: Option<u16>) {
        let mut health = self.health.lock().unwrap();
        let failures = if outcome == "success" {
            0
        } else {
            health[id]["failures"].as_u64().unwrap_or(0) + 1
        };
        health[id] = json!({"outcome":outcome,"status":status,"failures":failures,"lastCheckedAt":config::now()});
    }
    fn runtime(&self) -> Value {
        let snapshot = self.snapshot();
        let config = &snapshot.config;
        let providers: Vec<_> = entries(&config["virtualProviders"]).map(|(id, provider)| {
            let configuration_id = id.strip_prefix("cabletidy_").unwrap_or(id);
            let base = config::base_url(config, configuration_id);
            json!({
                "id": id,
                "configurationId": configuration_id,
                "listen": format!("{}:{}", config::url_host(text(&config["web"]["listenHost"])), config["web"]["port"]),
                "baseUrl": format!("{base}/v1"),
                "protocol": provider["ingressProtocol"],
                "route": provider["route"],
                "enabled": config::enabled(provider),
                "status": if config::enabled(provider) { "listening" } else { "paused" }
            })
        }).collect();
        let counts: serde_json::Map<_, _> = [
            "upstreams",
            "models",
            "routes",
            "virtualProviders",
            "bindings",
        ]
        .into_iter()
        .map(|key| (key.to_owned(), json!(entries(&config[key]).count())))
        .collect();
        json!({
            "version": crate::VERSION,
            "pid": std::process::id(),
            "startedAt": self.started,
            "revision": config["revision"],
            "web": {"host": config["web"]["listenHost"], "port": config["web"]["port"], "status": "listening"},
            "virtualProviders": providers,
            "health": *self.health.lock().unwrap(),
            "counts": counts
        })
    }
}
pub struct Application {
    pub state: Arc<AppState>,
    pub listener: tokio::net::TcpListener,
    lock: lifecycle::InstanceLock,
}
pub async fn create(
    paths: Paths,
    target_options: targets::Options,
    preferred: u16,
) -> Result<Application> {
    let lock = lifecycle::InstanceLock::acquire(&paths).await?;
    let result = async {
        config::ensure_dir(&paths.backups).await?;
        let existing = config::read_json(&paths.config).await?;
        let fresh = existing.is_none();
        let mut config = existing.as_ref().map(config::normalize).unwrap_or_else(config::defaults);
        if fresh { config["web"]["port"] = json!(preferred); }
        let check = validation::validate(&config);
        if check["ok"] != true {
            bail!("配置校验失败，daemon 未启动: {}", check["errors"]);
        }
        let host = text(&config["web"]["listenHost"]).trim_matches(['[', ']']);
        let port = config["web"]["port"].as_u64().unwrap() as u16;
        let listener = match tokio::net::TcpListener::bind((host, port)).await {
            Ok(listener) => listener,
            Err(error) if fresh && error.kind() == std::io::ErrorKind::AddrInUse => {
                tokio::net::TcpListener::bind((host, 0)).await?
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                bail!("端口 {host}:{port} 已被占用 (EADDRINUSE)。请停止占用端口的服务，或修改 {} 中的 web.port 后重启。", paths.config.display())
            }
            Err(error) => return Err(error.into()),
        };
        config["web"]["port"] = json!(listener.local_addr()?.port());
        let secrets = config::read_json(&paths.secrets).await?.filter(Value::is_object).unwrap_or_else(|| json!({}));
        let state = Arc::new(AppState {
            paths: paths.clone(),
            targets: target_options,
            identity: lock.identity.clone(),
            started: config::now(),
            snapshot: RwLock::new(Arc::new(Snapshot { config: config.clone(), secrets: secrets.clone() })),
            events: Mutex::new(VecDeque::new()),
            health: Mutex::new(json!({})),
            config_operation: AsyncMutex::new(()),
            target_operation: AsyncMutex::new(()),
            catalog: Catalog::default(),
            client: reqwest::Client::builder().no_proxy().build()?,
            claude_client: reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build()?,
            jobs: AtomicUsize::new(0),
        });
        config::write_json(&paths.secrets, &secrets).await?;
        if fresh { config::write_json(&paths.config, &config).await?; }
        lifecycle::persist_runtime(&paths, &lock.identity, &config, &state.started).await?;
        Ok::<_, anyhow::Error>((state, listener))
    }.await;
    match result {
        Ok((state, listener)) => Ok(Application {
            state,
            listener,
            lock,
        }),
        Err(e) => {
            lock.release().await?;
            Err(e)
        }
    }
}
#[derive(Clone, Copy)]
pub enum Shutdown {
    Interrupt,
    Terminate,
    ParentGone,
}

pub async fn serve(app: Application) -> Result<()> {
    let (_sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    serve_controlled(app, receiver).await
}

async fn interrupt() {
    if tokio::signal::ctrl_c().await.is_err() {
        // Detached Windows processes receive launcher signals through the private pipe.
        std::future::pending::<()>().await;
    }
}

pub async fn serve_controlled(
    app: Application,
    mut control: tokio::sync::mpsc::UnboundedReceiver<Shutdown>,
) -> Result<()> {
    let Application {
        state,
        listener,
        lock,
    } = app;
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let signals = tokio::spawn(async move {
        #[cfg(unix)]
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        let mut stop_tx = Some(stop_tx);
        let mut control_open = true;
        loop {
            let event = tokio::select! {
                _ = interrupt() => Shutdown::Interrupt,
                event = control.recv(), if control_open => match event {
                    Some(event) => event,
                    None => { control_open = false; continue; }
                },
                _ = async {
                    #[cfg(unix)]
                    term.recv().await;
                    #[cfg(not(unix))]
                    std::future::pending::<()>().await;
                } => Shutdown::Terminate,
            };
            if matches!(event, Shutdown::ParentGone)
                || (stop_tx.is_none() && matches!(event, Shutdown::Interrupt))
            {
                catalog::force_stop();
                std::process::exit(130);
            }
            if let Some(sender) = stop_tx.take() {
                println!("正在停止 CableTidy，等待请求和清理完成；再次按 Ctrl+C 强制退出。");
                let _ = sender.send(());
            }
        }
    });
    let c = &state.snapshot().config;
    println!(
        "CableTidy Web 管理台: http://{}:{}/",
        config::url_host(text(&c["web"]["listenHost"])),
        c["web"]["port"]
    );
    println!("数据目录: {}", state.paths.home.display());
    println!("按 Ctrl+C 停止 daemon");
    let router = Router::new()
        .fallback(any(handle))
        .with_state(state.clone());
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = stop_rx.await;
        })
        .await;
    while state.jobs.load(Ordering::SeqCst) > 0 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if let Ok(Some(runtime)) = config::read_json(&state.paths.runtime).await {
        if runtime["pid"] == std::process::id() && runtime["startedAt"] == state.started {
            let _ = tokio::fs::remove_file(&state.paths.runtime).await;
        }
    }
    let released = lock.release().await;
    signals.abort();
    result?;
    released
}
struct Job(Arc<AppState>);
impl Drop for Job {
    fn drop(&mut self) {
        self.0.jobs.fetch_sub(1, Ordering::SeqCst);
    }
}
async fn handle(State(state): State<Arc<AppState>>, request: Request<Body>) -> Response {
    // A disconnected management client must not cancel an atomic write halfway through.
    state.jobs.fetch_add(1, Ordering::SeqCst);
    let guard = Job(state.clone());
    if !request.uri().path().starts_with("/api/") {
        let _guard = guard;
        return match dispatch(state, request).await {
            Ok(response) => response,
            Err(error_value) => error(500, "internal_error", &error_value.to_string()),
        };
    }
    match tokio::spawn(async move {
        let _guard = guard;
        dispatch(state, request).await
    })
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => error(500, "internal_error", &e.to_string()),
        Err(_) => error(500, "internal_error", "Request task failed"),
    }
}
fn json_response(status: u16, body: Value) -> Response {
    let mut r = Response::new(Body::from(body.to_string()));
    *r.status_mut() = StatusCode::from_u16(status).unwrap();
    for (k, v) in [
        ("content-type", "application/json; charset=utf-8"),
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-cabletidy", "cabletidy"),
    ] {
        r.headers_mut().insert(k, HeaderValue::from_static(v));
    }
    r
}
fn error(status: u16, code: &str, message: &str) -> Response {
    json_response(status, json!({"error":{"code":code,"message":message}}))
}
fn protocol_error(protocol: &str, status: u16, code: &str, message: &str) -> Response {
    if protocol == "anthropic.messages" {
        let kind = match code {
            "authentication_error" => "authentication_error",
            "rate_limit_error" => "rate_limit_error",
            "overloaded_error" => "overloaded_error",
            "not_found" => "not_found_error",
            _ if status == 413 => "request_too_large",
            _ if status >= 500 => "api_error",
            _ => "invalid_request_error",
        };
        json_response(
            status,
            json!({"type":"error","error":{"type":kind,"message":message}}),
        )
    } else {
        json_response(
            status,
            json!({"error":{"type":"invalid_request_error","code":code,"message":message}}),
        )
    }
}
fn allowed(c: &Value, headers: &HeaderMap) -> bool {
    let expected = c["web"]["port"].as_u64().unwrap_or(43100) as u16;
    for (key, prefix) in [("host", "http://"), ("origin", "")] {
        if let Some(raw) = headers.get(key) {
            let Ok(raw) = raw.to_str() else {
                return false;
            };
            let Ok(url) = url::Url::parse(&format!("{prefix}{raw}")) else {
                return false;
            };
            if !["http", "https"].contains(&url.scheme())
                || !validation::loopback(url.host_str().unwrap_or(""))
            {
                return false;
            }
            let port = if key == "host" {
                url.port().unwrap_or(expected)
            } else {
                url.port_or_known_default().unwrap_or(0)
            };
            if port != expected {
                return false;
            }
        }
    }
    true
}
async fn read_body(body: Body) -> std::result::Result<Value, (u16, &'static str, &'static str)> {
    let bytes = to_bytes(body, MAX_BODY)
        .await
        .map_err(|_| (413, "payload_too_large", "request body too large"))?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes).map_err(|_| (400, "invalid_json", "请求 body 不是合法 JSON"))
}
async fn dispatch(state: Arc<AppState>, request: Request<Body>) -> Result<Response> {
    let (parts, body) = request.into_parts();
    let path = parts.uri.path();
    let snapshot = state.snapshot();
    if path.starts_with("/api/") {
        if !allowed(&snapshot.config, &parts.headers) {
            return Ok(error(
                403,
                "origin_not_allowed",
                "只允许来自当前本地管理台的请求",
            ));
        }
        if parts.method == Method::OPTIONS {
            let mut r = json_response(204, Value::Null);
            *r.body_mut() = Body::empty();
            if let Some(origin) = parts.headers.get("origin") {
                r.headers_mut()
                    .insert("access-control-allow-origin", origin.clone());
            }
            r.headers_mut().insert(
                "access-control-allow-methods",
                HeaderValue::from_static("GET, POST, PATCH, OPTIONS"),
            );
            r.headers_mut().insert(
                "access-control-allow-headers",
                HeaderValue::from_static("content-type"),
            );
            return Ok(r);
        }
        let body = if parts.method == Method::POST || parts.method == Method::PATCH {
            match read_body(body).await {
                Ok(v) => v,
                Err((s, c, m)) => return Ok(error(s, c, m)),
            }
        } else {
            json!({})
        };
        return api(state, &parts.method, &parts.uri, body).await;
    }
    let mut split = path.trim_start_matches('/').splitn(2, '/');
    let id = split.next().unwrap_or("");
    let remainder = split
        .next()
        .map(|s| format!("/{s}"))
        .unwrap_or_else(|| "/".into());
    let provider_path = !id.is_empty()
        && id.len() <= 54
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-');
    if !provider_path {
        return Ok(static_file(path));
    }
    let pid = format!("cabletidy_{id}");
    let provider = &snapshot.config["virtualProviders"][&pid];
    let protocol = provider["ingressProtocol"]
        .as_str()
        .unwrap_or("openai.responses");
    if !allowed(&snapshot.config, &parts.headers) {
        return Ok(protocol_error(
            protocol,
            403,
            "origin_not_allowed",
            "只允许来自当前本地服务的请求",
        ));
    }
    if provider.is_null() {
        return Ok(protocol_error(
            protocol,
            404,
            "not_found",
            &format!("配置入口不存在: {id}"),
        ));
    }
    if !config::enabled(provider) {
        return Ok(protocol_error(
            protocol,
            503,
            "provider_paused",
            "此配置的服务已暂停",
        ));
    }
    proxy(
        state,
        snapshot.clone(),
        &pid,
        &remainder,
        parts.uri.query(),
        &parts.method,
        &parts.headers,
        body,
    )
    .await
}
fn static_file(path: &str) -> Response {
    let (body, kind): (&'static [u8], &str) = match path {
        "/" | "/index.html" => (
            include_bytes!("../web/index.html"),
            "text/html; charset=utf-8",
        ),
        "/app.js" => (
            include_bytes!("../web/app.js"),
            "text/javascript; charset=utf-8",
        ),
        "/config-identity.js" => (
            include_bytes!("../web/config-identity.js"),
            "text/javascript; charset=utf-8",
        ),
        "/claude-models.js" => (
            include_bytes!("../web/claude-models.js"),
            "text/javascript; charset=utf-8",
        ),
        "/styles.css" => (
            include_bytes!("../web/styles.css"),
            "text/css; charset=utf-8",
        ),
        _ => return error(404, "not_found", "Not found"),
    };
    let mut r = Response::new(Body::from(body));
    r.headers_mut()
        .insert("content-type", HeaderValue::from_str(kind).unwrap());
    r.headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    r.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    r
}
async fn api(state: Arc<AppState>, method: &Method, uri: &Uri, body: Value) -> Result<Response> {
    let path = uri.path();
    let snapshot = state.snapshot();
    let c = &snapshot.config;
    if method == Method::GET {
        return Ok(match path {
            "/api/v1/config" => {
                json_response(200, json!({"config":config::public(c,&snapshot.secrets)}))
            }
            "/api/v1/runtime" => json_response(200, state.runtime()),
            "/api/v1/events" => json_response(
                200,
                json!({"events":state.events.lock().unwrap().iter().rev().take(100).collect::<Vec<_>>()}),
            ),
            "/api/v1/codex/models" => match state
                .catalog
                .load(
                    url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
                        .any(|(k, v)| k == "refresh" && v == "1"),
                )
                .await
            {
                Ok(v) => json_response(200, catalog::public(&v)),
                Err(e) => json_response(
                    200,
                    json!({"available":false,"models":[],"error":{"message":e.to_string()}}),
                ),
            },
            "/api/v1/catalog" => json_response(
                200,
                json!({"protocols":validation::PROTOCOLS,"implementedProtocols":validation::IMPLEMENTED,"integrations":["codex-native-provider"],"requiredEndpoints":{"codex-native-provider":targets::codex_endpoints(),"claude-code":targets::claude_endpoints()},"targetFormats":["codex.config.toml.v1","claude.settings.json.v1","claude.env.v1","generic.env.v1"],"targets":["codex","claude-code","generic-env"],"capabilities":["streaming","tools","parallel_tool_calls","vision","reasoning","prompt_cache"]}),
            ),
            "/api/v1/integrations" => json_response(
                200,
                json!({"integrations":[{"id":"codex-native-provider","label":"Codex Native Provider Integration","capabilities":["models","responses","streaming"],"requiredEndpoints":targets::codex_endpoints(),"note":"CableTidy 直接管理上游连接、模型映射和本地 Virtual Provider"}]}),
            ),
            _ => error(404, "not_found", "API endpoint 不存在"),
        });
    }
    if method != Method::POST {
        return Ok(error(404, "not_found", "API endpoint 不存在"));
    }
    if path == "/api/v1/config/validate" {
        let candidate =
            config::normalize(&config::strip_presentation(body.get("config").unwrap_or(c)));
        let mut check = validation::validate(&candidate);
        if check["ok"] == true {
            check["errors"]
                .as_array_mut()
                .unwrap()
                .extend(catalog::validate_changes(&candidate, c, &state.catalog).await);
        }
        let ok = array(&check["errors"]).is_empty();
        return Ok(json_response(
            if ok { 200 } else { 422 },
            json!({"ok":ok,"errors":check["errors"],"warnings":check["warnings"],"diff":config::diff(c,&candidate),"config":config::public(&candidate,&snapshot.secrets)}),
        ));
    }
    if path == "/api/v1/config/commit" {
        return commit(&state, &body).await;
    }
    if let Some(rest) = path.strip_prefix("/api/v1/virtual-providers/") {
        if let Some((id, action)) = rest.rsplit_once('/') {
            if ["start", "pause"].contains(&action) {
                return provider_state(&state, id, action == "start").await;
            }
        }
    }
    if path == "/api/v1/tests/model-resolve" {
        let candidate = config::normalize(body.get("config").unwrap_or(c));
        let p = &candidate["virtualProviders"][text(&body["virtualProviderId"])];
        if p.is_null() {
            return Ok(error(
                404,
                "virtual_provider_not_found",
                "Virtual Provider 不存在",
            ));
        }
        let result = model::resolve(&candidate, p, body.get("model"))
            .and_then(|r| model::select(&candidate, p, &r, &body).map(|b| (r, b)));
        return Ok(match result {
            Ok((r, b)) => json_response(
                200,
                json!({"ok":true,"requestedModel":body["model"],"profileId":r.profile_id,"clientModelId":r.client,"upstreamId":b.upstream["id"],"upstreamModelId":b.model,"routeId":b.route,"capabilities":b.capabilities,"rejectedBackends":[]}),
            ),
            Err(e) => json_response(
                422,
                json!({"ok":false,"error":{"code":e.code,"message":e.message,"details":e.details}}),
            ),
        });
    }
    if path == "/api/v1/tests/upstream" {
        return probe(&state, &snapshot, &body).await;
    }
    if path == "/api/v1/config/preview-target-artifacts" {
        let mut candidate = config::normalize(body.get("config").unwrap_or(c));
        let secrets = config::apply_secrets(&mut candidate, &snapshot.secrets, &body);
        return Ok(
            match targets::prepare(
                &candidate,
                text(&body["bindingId"]),
                &secrets,
                &state.catalog,
                &state.targets,
            )
            .await
            {
                Ok(a) => json_response(200, json!({"ok":true,"artifacts":targets::public(&a)})),
                Err(e) => error(422, "target_artifact_preview_failed", &e.to_string()),
            },
        );
    }
    if path == "/api/v1/targets/apply" {
        let _guard = state.target_operation.lock().await;
        let a = match targets::prepare(
            c,
            text(&body["bindingId"]),
            &snapshot.secrets,
            &state.catalog,
            &state.targets,
        )
        .await
        {
            Ok(a) => a,
            Err(e) => return Ok(error(422, "target_apply_failed", &e.to_string())),
        };
        if a["target"] != "codex" && a["target"] != "claude-code" {
            return Ok(json_response(
                501,
                json!({"error":{"code":"target_apply_not_supported","message":"此 target 没有可持久化写入的客户端配置；请使用管理台预览环境变量"},"target":a["target"],"bindingId":a["bindingId"],"artifacts":targets::public(&a)}),
            ));
        }
        return Ok(match targets::apply(&a, &state.targets).await {
            Ok(report) => {
                state.event("target.apply",json!({"bindingId":a["bindingId"],"target":a["target"],"files":report["applied"]}));
                json_response(200, json!({"ok":true,"target":a["target"],"report":report}))
            }
            Err(e) => error(422, "target_apply_failed", &e.to_string()),
        });
    }
    if path == "/api/v1/targets/restore" {
        let _guard = state.target_operation.lock().await;
        let id = text(&body["bindingId"]);
        if c["bindings"][id]["target"] != "claude-code" {
            return Ok(error(
                422,
                "target_restore_failed",
                "请选择 Claude Code 配置",
            ));
        }
        return Ok(match targets::restore(id, &state.targets).await {
            Ok(report) => {
                state.event(
                    "target.restore",
                    json!({"bindingId":id,"target":"claude-code"}),
                );
                json_response(
                    200,
                    json!({"ok":true,"target":"claude-code","report":report}),
                )
            }
            Err(e) => error(422, "target_restore_failed", &e.to_string()),
        });
    }
    Ok(error(404, "not_found", "API endpoint 不存在"))
}
async fn save_snapshot(state: &AppState, previous: &Snapshot, next: &Snapshot) -> Result<()> {
    if !tokio::fs::metadata(&state.paths.backups).await?.is_dir() {
        bail!("The backup directory is unavailable");
    }
    let revision = &next.config["revision"];
    config::backup(
        &state.paths.config,
        &state.paths.backups,
        &format!("config-{revision}.json"),
    )
    .await?;
    config::backup(
        &state.paths.secrets,
        &state.paths.backups,
        &format!("secrets-{revision}.json"),
    )
    .await?;
    config::write_json(&state.paths.config, &next.config).await?;
    if let Err(e) = config::write_json(&state.paths.secrets, &next.secrets).await {
        config::write_json(&state.paths.config, &previous.config)
            .await
            .context("Failed to restore previous configuration")?;
        return Err(e);
    }
    *state.snapshot.write().unwrap() = Arc::new(next.clone());
    if let Err(e) =
        lifecycle::persist_runtime(&state.paths, &state.identity, &next.config, &state.started)
            .await
    {
        state.event("runtime.persist_failed", json!({"message":e.to_string()}));
    }
    Ok(())
}
async fn commit(state: &AppState, body: &Value) -> Result<Response> {
    let _guard = state.config_operation.lock().await;
    let previous = state.snapshot();
    let c = &previous.config;
    let base = body["baseRevision"]
        .as_u64()
        .or_else(|| text(&body["baseRevision"]).parse().ok());
    if base != c["revision"].as_u64() {
        return Ok(json_response(
            409,
            json!({"error":{"code":"revision_conflict","message":format!("配置已经变更，当前 revision 是 {}",c["revision"]),"currentRevision":c["revision"]},"diff":config::diff(c,&config::strip_presentation(body.get("config").unwrap_or(c))),"config":config::public(c,&previous.secrets)}),
        ));
    }
    let mut candidate = config::normalize(&config::strip_presentation(&body["config"]));
    candidate["revision"] = json!(c["revision"].as_u64().unwrap_or(0) + 1);
    let secrets = config::apply_secrets(&mut candidate, &previous.secrets, body);
    let mut check = validation::validate(&candidate);
    let diff = config::diff(c, &candidate);
    if check["ok"] == true {
        check["errors"]
            .as_array_mut()
            .unwrap()
            .extend(catalog::validate_changes(&candidate, c, &state.catalog).await);
    }
    if !array(&check["errors"]).is_empty() {
        return Ok(json_response(
            422,
            json!({"error":{"code":"config_invalid","message":"配置校验失败"},"errors":check["errors"],"warnings":check["warnings"],"diff":diff}),
        ));
    }
    if candidate["web"]["listenHost"] != c["web"]["listenHost"]
        || candidate["web"]["port"] != c["web"]["port"]
    {
        return Ok(json_response(
            422,
            json!({"error":{"code":"web_listener_restart_required","message":"Web 管理台监听地址或端口需要重启 daemon 后才能修改"},"diff":diff}),
        ));
    }
    let next = Snapshot {
        config: candidate,
        secrets,
    };
    if let Err(e) = save_snapshot(state, &previous, &next).await {
        return Ok(error(500, "config_reload_failed", &e.to_string()));
    }
    state.event("config.commit",json!({"revision":next.config["revision"],"virtualProviders":entries(&next.config["virtualProviders"]).map(|(k,_)|k).collect::<Vec<_>>(),"upstreams":entries(&next.config["upstreams"]).map(|(k,_)|k).collect::<Vec<_>>()}));
    Ok(json_response(
        200,
        json!({"ok":true,"revision":next.config["revision"],"diff":diff,"config":config::public(&next.config,&next.secrets),"runtime":state.runtime()}),
    ))
}
async fn provider_state(state: &AppState, id: &str, enabled: bool) -> Result<Response> {
    let _guard = state.config_operation.lock().await;
    let previous = state.snapshot();
    if !previous.config["virtualProviders"][id].is_object() {
        return Ok(error(
            404,
            "virtual_provider_not_found",
            "Virtual Provider 不存在",
        ));
    }
    let mut next = (*previous).clone();
    next.config["virtualProviders"][id]["enabled"] = json!(enabled);
    next.config["revision"] = json!(previous.config["revision"].as_u64().unwrap_or(0) + 1);
    let check = validation::validate(&next.config);
    if check["ok"] != true {
        return Ok(json_response(
            422,
            json!({"error":{"code":"config_invalid","message":"配置校验失败"},"errors":check["errors"],"warnings":check["warnings"]}),
        ));
    }
    if let Err(e) = save_snapshot(state, &previous, &next).await {
        return Ok(error(500, "virtual_provider_state_failed", &e.to_string()));
    }
    state.event(
        if enabled {
            "virtual_provider.start"
        } else {
            "virtual_provider.pause"
        },
        json!({"virtualProviderId":id,"revision":next.config["revision"]}),
    );
    Ok(json_response(
        200,
        json!({"ok":true,"virtualProviderId":id,"enabled":enabled,"revision":next.config["revision"],"config":config::public(&next.config,&next.secrets),"runtime":state.runtime()}),
    ))
}
fn auth(headers: &mut HeaderMap, u: &Value, protocol: &str, secret: &str) -> Result<()> {
    headers.remove("authorization");
    headers.remove("x-api-key");
    if secret.is_empty() {
        return Ok(());
    }
    let header = u["auth"]["header"]
        .as_str()
        .or_else(|| u["authHeader"].as_str())
        .unwrap_or(if protocol == "anthropic.messages" {
            "x-api-key"
        } else {
            "authorization"
        });
    let value = if header.eq_ignore_ascii_case("authorization") {
        format!(
            "{} {secret}",
            u["auth"]["scheme"].as_str().unwrap_or("Bearer")
        )
    } else {
        secret.into()
    };
    headers.insert(
        axum::http::HeaderName::from_bytes(header.as_bytes())?,
        HeaderValue::from_str(&value)?,
    );
    Ok(())
}
async fn probe(state: &AppState, snapshot: &Snapshot, body: &Value) -> Result<Response> {
    let mut c = config::normalize(&config::strip_presentation(
        body.get("config").unwrap_or(&snapshot.config),
    ));
    let secrets = if body.get("config").is_some() {
        config::apply_secrets(&mut c, &snapshot.secrets, body)
    } else {
        snapshot.secrets.clone()
    };
    let id = text(&body["id"]);
    let u = &c["upstreams"][id];
    if !u.is_object() {
        return Ok(error(404, "upstream_not_found", "upstream 不存在"));
    }
    let mut headers = HeaderMap::new();
    headers.insert("accept", HeaderValue::from_static("application/json"));
    let secret = config::secret(u, &secrets);
    auth(&mut headers, u, text(&u["protocol"]), secret)?;
    let start = Instant::now();
    let result = state
        .client
        .get(text(&u["baseUrl"]))
        .headers(headers)
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    Ok(match result {
        Ok(r) => {
            let status = r.status().as_u16();
            let ok = status < 500 || status == 501;
            state.health(
                id,
                if r.status().is_success() {
                    "success"
                } else {
                    "response"
                },
                Some(status),
            );
            json_response(
                200,
                json!({"ok":ok,"status":status,"latencyMs":start.elapsed().as_millis(),"secretConfigured":!secret.is_empty(),"message":if ok{"上游可连接"}else{"上游返回服务端错误"}}),
            )
        }
        Err(e) => {
            state.health(id, "failure", None);
            json_response(
                200,
                json!({"ok":false,"latencyMs":start.elapsed().as_millis(),"secretConfigured":!secret.is_empty(),"message":if e.is_timeout(){"连接超时".into()}else{e.without_url().to_string()}}),
            )
        }
    })
}
fn upstream_url(base: &str, path: &str, query: Option<&str>) -> Result<url::Url> {
    let mut url = url::Url::parse(base)?;
    let base_path = url.path().trim_end_matches('/');
    let incoming = if base_path.ends_with("/v1") && path.starts_with("/v1/") {
        &path[3..]
    } else {
        path
    };
    let joined = format!("{base_path}/{incoming}")
        .split('/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    url.set_path(&format!("/{joined}"));
    if let Some(query) = query.filter(|query| !query.is_empty()) {
        let mut params: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            let first = params.iter().position(|(old, _)| old == key.as_ref());
            if let Some(index) = first {
                params[index].1 = value.into_owned();
                let mut seen = false;
                params.retain(|(old, _)| {
                    if old != key.as_ref() {
                        return true;
                    }
                    let keep = !seen;
                    seen = true;
                    keep
                });
            } else {
                params.push((key.into_owned(), value.into_owned()));
            }
        }
        url.query_pairs_mut().clear().extend_pairs(params);
    }
    Ok(url)
}
#[allow(clippy::too_many_arguments)]
async fn proxy(
    state: Arc<AppState>,
    snapshot: Arc<Snapshot>,
    pid: &str,
    path: &str,
    query: Option<&str>,
    method: &Method,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response> {
    let c = &snapshot.config;
    let p = &c["virtualProviders"][pid];
    let protocol = text(&p["ingressProtocol"]);
    let claude = protocol == "anthropic.messages";
    if method == Method::OPTIONS {
        let mut r = Response::new(Body::empty());
        *r.status_mut() = StatusCode::NO_CONTENT;
        return Ok(r);
    }
    if !validation::IMPLEMENTED.contains(&protocol) {
        return Ok(protocol_error(
            protocol,
            501,
            "unsupported_protocol",
            "当前 MVP 尚未实现 ingress protocol",
        ));
    }
    if claude && method == Method::HEAD && path == "/api/hello" {
        let mut r = Response::new(Body::empty());
        *r.status_mut() = StatusCode::NO_CONTENT;
        r.headers_mut()
            .insert("cache-control", HeaderValue::from_static("no-store"));
        return Ok(r);
    }
    if method == Method::GET && (path == "/v1/models" || (!claude && path == "/models")) {
        let models = model::models(c, p);
        if !claude {
            return Ok(json_response(200, json!({"object":"list","data":models})));
        }
        let params: std::collections::HashMap<_, _> =
            url::form_urlencoded::parse(query.unwrap_or("").as_bytes())
                .into_owned()
                .collect();
        let limit = params.get("limit").map(String::as_str).unwrap_or("1000");
        let Ok(limit) = limit.parse::<usize>() else {
            return Ok(protocol_error(
                protocol,
                400,
                "invalid_request_error",
                "limit 必须是 1 到 1000 之间的整数",
            ));
        };
        if !(1..=1000).contains(&limit) {
            return Ok(protocol_error(
                protocol,
                400,
                "invalid_request_error",
                "limit 必须是 1 到 1000 之间的整数",
            ));
        }
        let start = if let Some(after) = params.get("after_id") {
            match models.iter().position(|m| m["id"] == *after) {
                Some(i) => i + 1,
                None => {
                    return Ok(protocol_error(
                        protocol,
                        400,
                        "invalid_request_error",
                        "after_id 不在当前模型列表中",
                    ))
                }
            }
        } else {
            0
        };
        let data: Vec<_> = models
            .iter()
            .skip(start)
            .take(limit)
            .map(|m| json!({"id":m["id"],"type":"model","display_name":m["id"]}))
            .collect();
        return Ok(json_response(
            200,
            json!({"data":data,"has_more":models.len()>start+data.len(),"first_id":data.first().map(|m|&m["id"]),"last_id":data.last().map(|m|&m["id"])}),
        ));
    }
    let count_tokens = claude && path == "/v1/messages/count_tokens";
    let supported = if claude {
        ["/v1/messages", "/messages", "/v1/messages/count_tokens"].contains(&path)
    } else {
        ["/v1/responses", "/responses"].contains(&path)
    };
    if method != Method::POST || !supported {
        return Ok(protocol_error(protocol, 404, "not_found", "接口不存在"));
    }
    let mut body = match read_body(body).await {
        Ok(v) => v,
        Err((s, code, msg)) => return Ok(protocol_error(protocol, s, code, msg)),
    };
    if !body.is_object() {
        return Ok(protocol_error(
            protocol,
            400,
            "invalid_request_error",
            "请求 body 必须是 JSON object",
        ));
    }
    let resolution = match model::resolve(c, p, body.get("model")) {
        Ok(r) => r,
        Err(e) => return Ok(protocol_error(protocol, 400, e.code, &e.message)),
    };
    let selected = match model::select(
        c,
        p,
        &resolution,
        if count_tokens { &Value::Null } else { &body },
    ) {
        Ok(b) => b,
        Err(e) => return Ok(protocol_error(protocol, 503, e.code, &e.message)),
    };
    body["model"] = json!(selected.model);
    let u = &selected.upstream;
    let url = upstream_url(text(&u["baseUrl"]), path, query)?;
    let mut outbound = HeaderMap::new();
    outbound.insert("content-type", HeaderValue::from_static("application/json"));
    outbound.insert(
        "accept",
        headers
            .get("accept")
            .cloned()
            .unwrap_or_else(|| HeaderValue::from_static("text/event-stream, application/json")),
    );
    for (key, value) in headers {
        let copy = if claude {
            key.as_str().starts_with("anthropic-") || key.as_str().starts_with("x-claude-code-")
        } else {
            ["openai-beta", "openai-organization", "openai-project"].contains(&key.as_str())
        };
        if copy {
            outbound.insert(key.clone(), value.clone());
        }
    }
    auth(
        &mut outbound,
        u,
        protocol,
        config::secret(u, &snapshot.secrets),
    )?;
    let started = Instant::now();
    let client = if claude {
        &state.claude_client
    } else {
        &state.client
    };
    let upstream = match client
        .post(url)
        .headers(outbound)
        .body(body.to_string())
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            state.health(text(&u["id"]), "failure", None);
            return Ok(protocol_error(
                protocol,
                502,
                "upstream_unavailable",
                &e.without_url().to_string(),
            ));
        }
    };
    let status = upstream.status();
    state.health(
        text(&u["id"]),
        if status.is_success() {
            "success"
        } else {
            "failure"
        },
        Some(status.as_u16()),
    );
    state.event("proxy.request",json!({"virtualProviderId":pid,"upstreamId":u["id"],"clientModelId":resolution.client,"upstreamModelId":selected.model,"path":path,"status":status.as_u16(),"latencyMs":started.elapsed().as_millis()}));
    relay(
        upstream,
        &resolution.client,
        &selected.model,
        claude,
        count_tokens,
    )
    .await
}
async fn relay(
    upstream: reqwest::Response,
    client: &str,
    mapped: &str,
    claude: bool,
    count_tokens: bool,
) -> Result<Response> {
    let status = upstream.status();
    let mut headers = HeaderMap::new();
    let content_type = upstream
        .headers()
        .get("content-type")
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("application/json"));
    let sse = content_type
        .to_str()
        .unwrap_or("")
        .contains("text/event-stream");
    headers.insert("content-type", content_type);
    headers.insert(
        "cache-control",
        upstream
            .headers()
            .get("cache-control")
            .cloned()
            .unwrap_or_else(|| HeaderValue::from_static("no-cache")),
    );
    for (key, value) in upstream.headers() {
        if [
            "x-request-id",
            "request-id",
            "retry-after",
            "x-should-retry",
        ]
        .contains(&key.as_str())
            || key.as_str().starts_with("anthropic-ratelimit-")
        {
            headers.insert(key.clone(), value.clone());
        }
    }
    let body = if !status.is_success() || count_tokens || client == mapped {
        Body::from_stream(upstream.bytes_stream())
    } else if !sse {
        let bytes = upstream.bytes().await?;
        let rewritten = serde_json::from_slice::<Value>(&bytes).ok().map(|mut v| {
            model::rewrite(&mut v, client, mapped, claude);
            v.to_string()
        });
        if let Some(s) = rewritten {
            Body::from(s)
        } else {
            Body::from(bytes)
        }
    } else {
        let mut stream = upstream.bytes_stream();
        let client = client.to_owned();
        let mapped = mapped.to_owned();
        let stream: std::pin::Pin<
            Box<dyn futures_util::Stream<Item = std::result::Result<Bytes, reqwest::Error>> + Send>,
        > = Box::pin(async_stream::try_stream! {
            let mut pending = Vec::new();
            while let Some(chunk) = stream.next().await {
                pending.extend_from_slice(&chunk?);
                while let Some((at, len)) = sse_delimiter(&pending) {
                    let event = pending.drain(..at + len).collect::<Vec<_>>();
                    let mut output = rewrite_event(&event[..at], &client, &mapped, claude);
                    output.extend_from_slice(&event[at..]);
                    yield Bytes::from(output);
                }
            }
            if !pending.is_empty() {
                yield Bytes::from(rewrite_event(&pending, &client, &mapped, claude));
            }
        });
        Body::from_stream(stream)
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}
fn sse_delimiter(bytes: &[u8]) -> Option<(usize, usize)> {
    for i in 0..bytes.len() {
        if bytes[i..].starts_with(b"\n\n") {
            return Some((i, 2));
        }
        if bytes[i..].starts_with(b"\r\n\r\n") {
            return Some((i, 4));
        }
    }
    None
}
pub fn rewrite_event(bytes: &[u8], client: &str, mapped: &str, claude: bool) -> Vec<u8> {
    let Ok(event) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    let separator = if event.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = event.split(separator).map(str::to_owned).collect();
    let data: Vec<_> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            s.strip_prefix("data:")
                .map(|v| (i, v.strip_prefix(' ').unwrap_or(v).to_owned()))
        })
        .collect();
    if data.is_empty() {
        return bytes.to_vec();
    }
    let payload = data
        .iter()
        .map(|(_, s)| s.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let Ok(mut parsed) = serde_json::from_str::<Value>(&payload) else {
        return bytes.to_vec();
    };
    let original = parsed.clone();
    model::rewrite(&mut parsed, client, mapped, claude);
    if original == parsed {
        return bytes.to_vec();
    }
    lines[data[0].0] = format!("data: {parsed}");
    for (i, _) in data.iter().skip(1).rev() {
        lines.remove(*i);
    }
    lines.join(separator).into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_queries_keep_base_parameters_and_replace_in_place() {
        let url = upstream_url(
            "https://relay.invalid/v1?x=0&keep=a%20b&x=1",
            "/v1/responses",
            Some("x=2&x=3&new=c+d"),
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://relay.invalid/v1/responses?x=3&keep=a+b&new=c+d"
        );
        let url = upstream_url(
            "https://relay.invalid/v1?keep=a%20b",
            "/v1/messages",
            Some(""),
        )
        .unwrap();
        assert_eq!(url.as_str(), "https://relay.invalid/v1/messages?keep=a%20b");
    }

    #[test]
    fn sse_rewrite_preserves_native_extensions_and_untouched_bytes() {
        for event in [
            b": ping\n\n".as_slice(),
            b"data: [DONE]\n\n",
            b"event: error\ndata: {\"error\":\"upstream\"}\n\n",
            b"data: {bad json}\n\n",
        ] {
            assert_eq!(rewrite_event(event, "client", "vendor", true), event);
        }
        let event = b"id: 42\r\nevent: message_start\r\ndata: {\"type\":\"message_start\",\r\ndata: \"message\":{\"model\":\"vendor\"},\"extra\":{\"model\":\"vendor\"}}\r\n\r\n";
        let result = String::from_utf8(rewrite_event(event, "client", "vendor", true)).unwrap();
        assert!(result.starts_with("id: 42\r\nevent: message_start\r\n"));
        assert!(result.ends_with("\r\n\r\n"));
        assert!(result.contains("\"message\":{\"model\":\"client\"}"));
        assert!(result.contains("\"extra\":{\"model\":\"vendor\"}"));
        assert_eq!(sse_delimiter(b"partial\r\n\r"), None);
        assert_eq!(sse_delimiter(b"partial\r\n\r\n"), Some((7, 4)));
    }
}
