use crate::config::{array, enabled, entries, nonempty, text};
use anyhow::{bail, Context, Result};
use futures_util::{
    future::{BoxFuture, Shared},
    FutureExt,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashSet},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command, sync::Mutex as AsyncMutex};

static CHILDREN: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
fn children() -> &'static Mutex<HashSet<u32>> {
    CHILDREN.get_or_init(Default::default)
}
fn kill_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let taskkill = std::path::PathBuf::from(
            std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
        )
        .join("System32/taskkill.exe");
        let _ = std::process::Command::new(taskkill)
            .creation_flags(0x08000000)
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}
pub fn force_stop() {
    for pid in children().lock().unwrap().iter() {
        kill_tree(*pid);
    }
}
struct ChildGuard(u32);
#[cfg(windows)]
struct ScriptFile(std::path::PathBuf);
#[cfg(windows)]
impl Drop for ScriptFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        kill_tree(self.0);
        children().lock().unwrap().remove(&self.0);
    }
}
async fn bounded(mut stream: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0; 8192];
    loop {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            return Ok(out);
        }
        if out.len() + n > 16 * 1024 * 1024 {
            bail!("codex output exceeded 16 MiB");
        }
        out.extend_from_slice(&buf[..n]);
    }
}
async fn execute(args: &[&str]) -> Result<String> {
    #[cfg(not(windows))]
    let mut command = Command::new("codex");
    #[cfg(not(windows))]
    command.args(args);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    let script = std::env::temp_dir().join(format!("cabletidy-codex-{}.ps1", uuid::Uuid::new_v4()));
    #[cfg(windows)]
    crate::config::atomic_write(&script, include_bytes!("windows-codex.ps1")).await?;
    #[cfg(windows)]
    let _script_cleanup = ScriptFile(script.clone());
    #[cfg(windows)]
    let mut command = Command::new(crate::lifecycle::powershell());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(windows)]
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script)
        .arg(if args == ["--version"] {
            "version"
        } else {
            "models"
        })
        .arg(std::process::id().to_string());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().context("Cannot start codex")?;
    let pid = child.id().context("Missing codex process ID")?;
    children().lock().unwrap().insert(pid);
    let guard = ChildGuard(pid);
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let status = async {
            let status = child.wait().await?;
            if !status.success() {
                bail!("codex exited with {status}");
            }
            Ok::<_, anyhow::Error>(())
        };
        let (_, out, _) = tokio::try_join!(status, bounded(stdout), bounded(stderr))?;
        String::from_utf8(out).context("codex returned invalid UTF-8")
    })
    .await
    .unwrap_or_else(|_| Err(anyhow::anyhow!("codex query timed out")));
    drop(guard);
    let _ = child.kill().await;
    let _ = child.wait().await;
    #[cfg(windows)]
    let _ = tokio::fs::remove_file(script).await;
    result
}
#[derive(Default)]
pub struct Catalog {
    state: AsyncMutex<CatalogState>,
}
type Query = Shared<BoxFuture<'static, std::result::Result<Value, String>>>;
#[derive(Default)]
struct CatalogState {
    cached: Option<(Instant, Value)>,
    pending: Option<(u64, Query)>,
    generation: u64,
}
impl Catalog {
    #[cfg(feature = "test-support")]
    pub fn fixture(snapshot: Value) -> Self {
        Self {
            state: AsyncMutex::new(CatalogState {
                cached: Some((Instant::now(), snapshot)),
                ..Default::default()
            }),
        }
    }

    pub async fn load(&self, refresh: bool) -> Result<Value> {
        let mut state = self.state.lock().await;
        if let Some((when, v)) = &state.cached {
            if !refresh && when.elapsed() < Duration::from_secs(60) {
                return Ok(v.clone());
            }
        }
        if state.pending.is_none() {
            state.generation += 1;
            let query = async {
                let result = async {
                    let version = execute(&["--version"]).await?;
                    let raw = execute(&["debug", "models", "--bundled"]).await?;
                    let catalog: Value =
                        serde_json::from_str(&raw).context("Invalid Codex catalog JSON")?;
                    validate(&catalog)?;
                    Ok::<_, anyhow::Error>(json!({"version": version.trim(), "catalog": catalog}))
                }
                .await;
                result.map_err(|error| format!("{error:#}"))
            }
            .boxed()
            .shared();
            state.pending = Some((state.generation, query));
        }
        let (generation, query) = state.pending.as_ref().unwrap().clone();
        drop(state);
        let result = query.await;
        let mut state = self.state.lock().await;
        if state
            .pending
            .as_ref()
            .is_some_and(|(id, _)| *id == generation)
        {
            state.pending = None;
            if let Ok(snapshot) = &result {
                state.cached = Some((Instant::now(), snapshot.clone()));
            } else {
                state.cached = None;
            }
        }
        result.map_err(anyhow::Error::msg).context("无法读取本机 Codex 官方模型目录。请安装或更新 Codex，并确认 daemon 的 PATH 包含 codex。")
    }
}
pub fn validate(v: &Value) -> Result<()> {
    if array(&v["models"]).is_empty() {
        bail!("Codex 模型目录为空或格式不受支持，请更新 Codex 后重试");
    }
    let mut names = HashSet::new();
    for m in array(&v["models"]) {
        if !nonempty(&m["slug"]) || !names.insert(text(&m["slug"])) {
            bail!("Codex 模型目录包含无效或重复的模型 ID");
        }
    }
    Ok(())
}
fn official(snapshot: &Value) -> impl Iterator<Item = &Value> {
    array(&snapshot["catalog"]["models"]).iter().filter(|m| {
        text(&m["slug"]).to_ascii_lowercase().starts_with("gpt-") && m["supported_in_api"] == true
    })
}
pub fn public(snapshot: &Value) -> Value {
    let models: Vec<_> = official(snapshot).map(|model| {
        let mut capabilities = vec!["streaming", "tools", "parallel_tool_calls"];
        if !array(&model["supported_reasoning_levels"]).is_empty() {
            capabilities.push("reasoning");
        }
        if array(&model["input_modalities"]).contains(&json!("image")) {
            capabilities.push("vision");
        }
        json!({
            "id": model["slug"],
            "name": model.get("display_name").unwrap_or(&model["slug"]),
            "hidden": model["visibility"] == "hide",
            "contextWindow": model["context_window"],
            "maxContextWindow": model.get("max_context_window").unwrap_or(&model["context_window"]),
            "inputModalities": model.get("input_modalities").unwrap_or(&json!(["text"])),
            "capabilities": capabilities
        })
    }).collect();
    json!({"available": true, "version": snapshot["version"], "models": models})
}
pub fn entry(snapshot: &Value, id: &str, p: &Value) -> Result<(Value, Value)> {
    let name = crate::model::client_model(id, p);
    let original=official(snapshot).find(|m|m["slug"]==name).with_context(||format!("模型 {name} 未匹配本机 Codex 官方 GPT 目录。请选择对应的官方模型；若本机目录过旧，请更新 Codex。当前不支持非对应模型。"))?;
    if !nonempty(&original["base_instructions"])
        && !nonempty(&original["model_messages"]["instructions_template"])
    {
        bail!("官方模型 {name} 缺少指令定义，不能生成替代提示词");
    }
    let mut out = original.clone();
    if p["codex"]["metadataMode"] == "override" {
        if let Some(window) = p.get("contextWindow") {
            let max = original
                .get("max_context_window")
                .unwrap_or(&original["context_window"])
                .as_u64()
                .unwrap_or(0);
            if !window
                .as_u64()
                .is_some_and(|v| v > 0 && v <= max && v <= 9_007_199_254_740_991)
            {
                bail!("{name} 的 context window 必须为 1 到 {max} 之间的整数");
            }
            out["context_window"] = window.clone();
            out["max_context_window"] = window.clone();
        }
        if let Some(modalities) = p["codex"].get("inputModalities") {
            let a = array(modalities);
            let unique: BTreeSet<_> = a.iter().map(text).collect();
            if !modalities.is_array()
                || !a.contains(&json!("text"))
                || unique.len() != a.len()
                || a.iter().any(|v| {
                    !["text", "image"].contains(&text(v))
                        || !array(&original["input_modalities"]).contains(v)
                })
            {
                bail!("{name} 的输入类型只能是官方已支持类型的子集，且必须保留 text");
            }
            out["input_modalities"] = modalities.clone();
        }
    }
    Ok((original.clone(), out))
}
pub fn model_ids(c: &Value) -> BTreeSet<String> {
    entries(&c["bindings"])
        .filter(|(_, b)| b["target"] == "codex")
        .flat_map(|(_, b)| {
            array(&c["virtualProviders"][text(&b["virtualProvider"])]["allowedModels"])
        })
        .map(|id| text(id).to_owned())
        .collect()
}
pub async fn validate_changes(c: &Value, old: &Value, catalog: &Catalog) -> Vec<Value> {
    let old_ids = model_ids(old);
    let ids: Vec<_> = model_ids(c)
        .into_iter()
        .filter(|id| !old_ids.contains(id) || c["models"][id] != old["models"][id])
        .collect();
    if ids.is_empty() {
        return vec![];
    }
    let snapshot = match catalog.load(false).await {
        Ok(v) => v,
        Err(e) => return vec![json!({"path":"models","message":e.to_string()})],
    };
    ids.iter()
        .filter_map(|id| {
            entry(&snapshot, id, &c["models"][id])
                .err()
                .map(|e| json!({"path":format!("models.{id}"),"message":e.to_string()}))
        })
        .collect()
}
pub fn plan(c: &Value, p: &Value, snapshot: &Value) -> Result<Value> {
    validate(&snapshot["catalog"])?;
    let mut catalog = snapshot["catalog"].clone();
    let mut overrides = Vec::new();
    let mut warnings = Vec::new();
    let mut models = Vec::new();
    let backends = array(&c["routes"][text(&p["route"])]["backends"]);
    if backends.len() != 1 {
        bail!("每份配置必须且只能连接一个 upstream");
    }
    let backend = &backends[0];
    let upstream = &c["upstreams"][text(&backend["upstream"])];
    for id in array(&p["allowedModels"]) {
        let id = text(id);
        let profile = &c["models"][id];
        if profile.is_null() {
            bail!("模型不存在: {id}");
        }
        let (original, mut changed) = entry(snapshot, id, profile)?;
        let slug = text(&original["slug"]);
        if !enabled(backend)
            || !upstream.is_object()
            || !enabled(upstream)
            || (!array(&backend["models"]).is_empty()
                && !array(&backend["models"]).contains(&json!(id)))
        {
            bail!("{slug} 的 Codex MVP 接入必须对应一个有效上游");
        }
        if upstream["protocol"] != "openai.responses" {
            bail!("{slug} 的 Codex MVP 上游必须使用 Responses 协议，暂不支持跨协议转换");
        }
        let binding = &profile["upstreams"][text(&backend["upstream"])];
        if entries(&profile["upstreams"]).count() != 1 || binding.is_null() {
            bail!("{slug} 必须且只能映射一个 upstream");
        }
        if !profile["codex"].is_null()
            && !crate::model::capabilities(profile, binding).contains("vision")
            && array(&changed["input_modalities"]).contains(&json!("image"))
        {
            changed["input_modalities"] = json!(array(&changed["input_modalities"])
                .iter()
                .filter(|v| *v != &json!("image"))
                .collect::<Vec<_>>());
            warnings.push(format!(
                "{slug} 的上游 vision 能力未启用，生成目录将禁用图片输入。"
            ));
        }
        models.push(slug.to_owned());
        if changed != original {
            for m in catalog["models"].as_array_mut().unwrap() {
                if m["slug"] == slug {
                    *m = changed.clone();
                }
            }
            overrides.push(slug.to_owned());
        }
        if profile["codex"].is_null()
            && (!profile["contextWindow"].is_null() || !profile["compact"].is_null())
        {
            warnings.push(format!(
                "{slug} 的旧 context window / compact 配置未同步；请在模型映射中确认元数据设置。"
            ));
        }
        if !profile["compact"].is_null() {
            warnings.push(format!(
                "{slug} 的 compact 策略仍由 Codex 管理，CableTidy 未同步逐模型压缩配置。"
            ));
        }
    }
    Ok(
        json!({"sourceVersion":snapshot["version"],"catalog":if overrides.is_empty(){Value::Null}else{catalog},"models":models,"overrides":overrides,"warnings":warnings}),
    )
}
