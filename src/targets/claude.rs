use super::{digest, Options};
use crate::config::{atomic_write, backup, ensure_dir, entries, read_optional, text, write_json};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::Path};
const STATE: &str = ".cabletidy-settings.json";
async fn read_regular(path: &Path) -> Result<Option<String>> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(m) if !m.is_file() || m.is_symlink() => {
            bail!("Expected a regular file: {}", path.display())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
        _ => {}
    }
    read_optional(path).await
}
fn hash(text: Option<&str>) -> String {
    digest(text.unwrap_or("<absent>").as_bytes())
}
struct Current {
    settings: Value,
    state: Value,
    text: Option<String>,
    state_text: Option<String>,
}
async fn read(home: &Path) -> Result<Current> {
    let text = read_regular(&home.join("settings.json")).await?;
    let settings: Value = if let Some(t) = &text {
        serde_json::from_str(t)?
    } else {
        json!({})
    };
    if !settings.is_object() || settings.get("env").is_some_and(|v| !v.is_object()) {
        bail!("Invalid Claude settings object");
    }
    let state_text = read_regular(&home.join(STATE)).await?;
    let mut state: Value = if let Some(t) = &state_text {
        serde_json::from_str(t)?
    } else {
        Value::Null
    };
    if let Some(pending) = state.get("pending") {
        if hash(text.as_deref()) == pending["before"] {
            state = pending["previous"].clone();
        } else if hash(text.as_deref()) == pending["after"] {
            state.as_object_mut().unwrap().remove("pending");
        } else {
            bail!("Claude settings changed during an interrupted apply; restore from backup before retrying.");
        }
    }
    if !state.is_null()
        && (state["version"] != 1
            || !state["fields"].is_object()
            || !state["bindingId"].is_string())
    {
        bail!("Invalid CableTidy ownership record");
    }
    for (key, field) in entries(&state["fields"]) {
        if (!key.starts_with("ANTHROPIC_") && !key.starts_with("CLAUDE_CODE_"))
            || !field["before"].is_object()
            || !field["applied"].is_string()
        {
            bail!("Invalid managed environment record");
        }
    }
    Ok(Current {
        settings,
        state,
        text,
        state_text,
    })
}
fn snapshot(env: &Value, key: &str) -> Value {
    if let Some(value) = env.get(key) {
        json!({"present":true,"value":value})
    } else {
        json!({"present":false})
    }
}
fn plan(current: &Current, vars: &Value, id: &str) -> Value {
    let mut next = current.settings.clone();
    let mut env = current
        .settings
        .get("env")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut fields = json!({});
    let mut conflicts = Vec::new();
    let mut changed = Vec::new();
    for (key, field) in entries(&current.state["fields"]) {
        if snapshot(&env, key) != json!({"present":true,"value":field["applied"]}) {
            conflicts.push(format!("env.{key}"));
        }
    }
    let keys: BTreeSet<_> = entries(&current.state["fields"])
        .chain(entries(vars))
        .map(|(k, _)| k)
        .collect();
    for key in keys {
        let old = &current.state["fields"][key];
        let before = snapshot(&env, key);
        if let Some(v) = vars.get(key) {
            fields[key] = json!({"before":old.get("before").unwrap_or(&before),"applied":v});
            env[key] = v.clone();
        } else if old["before"]["present"] == true {
            env[key] = old["before"]["value"].clone();
        } else {
            env.as_object_mut().unwrap().remove(key);
        }
        if before != snapshot(&env, key) {
            changed.push(format!("env.{key}"));
        }
    }
    let had_env = current.state["hadEnv"]
        .as_bool()
        .unwrap_or(current.settings.get("env").is_some());
    if entries(&env).count() > 0 || had_env {
        next["env"] = env;
    } else {
        next.as_object_mut().unwrap().remove("env");
    }
    json!({"next":next,"conflicts":conflicts,"changed":changed,"state":{"version":1,"bindingId":id,"fields":fields,"hadEnv":had_env}})
}
fn warnings(settings: &Value, vars: &Value) -> Vec<String> {
    let mut w = Vec::new();
    for (key, v) in entries(vars) {
        if settings["env"].get(key).is_some_and(|s| s != v) {
            w.push(format!(
                "Will replace env.{key}; its original value is retained for restore."
            ));
        }
    }
    if !settings["apiKeyHelper"].is_null() {
        w.push("An existing apiKeyHelper is preserved. Verify the active credential source with /status.".into());
    }
    if !settings["forceLoginMethod"].is_null() {
        w.push("An existing forceLoginMethod may require a different login method.".into());
    }
    w.push("Project settings, --settings and managed policies can override user settings. Restart Claude Code and check /status after applying.".into());
    w
}
pub async fn prepare(mut a: Value, o: &Options) -> Result<Value> {
    let current = read(&o.claude_home).await?;
    let plan = plan(&current, &a["environment"]["vars"], text(&a["bindingId"]));
    a["settingsPath"] = json!(o.claude_home.join("settings.json"));
    a["changes"] = plan["changed"].clone();
    a["canApply"] = json!(crate::config::array(&plan["conflicts"]).is_empty());
    a["canRestore"] = json!(current.state["bindingId"] == a["bindingId"]);
    a["conflicts"] = plan["conflicts"].clone();
    a["warnings"] = json!(warnings(&current.settings, &a["environment"]["vars"]));
    Ok(a)
}
async fn acquire(o: &Options) -> Result<crate::lifecycle::InstanceLock> {
    ensure_dir(&o.claude_home).await?;
    let canonical = tokio::fs::canonicalize(&o.claude_home).await?;
    let mut paths = crate::config::Paths::new(canonical.clone());
    paths.lock = canonical.with_file_name(format!(
        "{}.lock",
        canonical.file_name().unwrap().to_string_lossy()
    ));
    for attempt in 0..21 {
        match crate::lifecycle::InstanceLock::acquire(&paths).await {
            Ok(lock) => return Ok(lock),
            Err(e) if attempt < 20 && e.to_string().contains("ELOCKED") => {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}
async fn commit(current: &Current, plan: &Value, o: &Options, restoring: bool) -> Result<Value> {
    if !crate::config::array(&plan["conflicts"]).is_empty() {
        bail!("Claude settings were edited after applying CableTidy: {}. Preserve your edits before retrying.",crate::config::array(&plan["conflicts"]).iter().map(text).collect::<Vec<_>>().join(", "));
    }
    let file = o.claude_home.join("settings.json");
    let state_file = o.claude_home.join(STATE);
    let backup = backup(&file, &o.paths.backups, "claude-settings.json").await?;
    super::super::config::backup(&state_file, &o.paths.backups, "claude-settings-state.json")
        .await?;
    if read_regular(&file).await? != current.text
        || read_regular(&state_file).await? != current.state_text
    {
        bail!("Claude settings changed during apply; preview and retry.");
    }
    let contents = format!("{}\n", serde_json::to_string_pretty(&plan["next"])?);
    let mut state = plan["state"].clone();
    state["pending"] = json!({"before":hash(current.text.as_deref()),"after":hash(Some(&contents)),"previous":current.state});
    write_json(&state_file, &state).await?;
    let result = async {
        if read_regular(&file).await? != current.text {
            bail!("Claude settings changed during apply; preview and retry.");
        }
        atomic_write(&file, contents.as_bytes()).await
    }
    .await;
    if let Err(e) = result {
        if let Some(s) = &current.state_text {
            atomic_write(&state_file, s.as_bytes()).await?;
        } else {
            tokio::fs::remove_file(&state_file).await?;
        }
        return Err(e);
    }
    if restoring {
        tokio::fs::remove_file(&state_file).await?;
    } else {
        write_json(&state_file, &plan["state"]).await?;
    }
    Ok(
        json!({"applied":[file],"backup":backup,"changes":plan["changed"],"mode":if restoring{"restored"}else{"managed_proxy"}}),
    )
}
pub async fn apply(a: &Value, o: &Options) -> Result<Value> {
    let lock = acquire(o).await?;
    let result = async {
        let current = read(&o.claude_home).await?;
        let plan = plan(&current, &a["environment"]["vars"], text(&a["bindingId"]));
        let mut out = commit(&current, &plan, o, false).await?;
        out["environment"] = a["environment"].clone();
        out["warnings"] = json!(warnings(&current.settings, &a["environment"]["vars"]));
        Ok(out)
    }
    .await;
    lock.release().await?;
    result
}
pub async fn restore(id: &str, o: &Options) -> Result<Value> {
    let lock = acquire(o).await?;
    let result = async {
        let current = read(&o.claude_home).await?;
        if current.state.is_null() {
            bail!("No Claude settings are managed by CableTidy.");
        }
        if current.state["bindingId"] != id {
            bail!(
                "Claude Code currently uses another CableTidy configuration: {}",
                text(&current.state["bindingId"])
            );
        }
        let plan = plan(&current, &json!({}), id);
        commit(&current, &plan, o, true).await
    }
    .await;
    lock.release().await?;
    result
}
