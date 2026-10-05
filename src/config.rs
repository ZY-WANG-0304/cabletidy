use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tokio::fs;

pub fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn entries(v: &Value) -> impl Iterator<Item = (&String, &Value)> {
    v.as_object().into_iter().flatten()
}
pub fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn truthy(v: &Value) -> bool {
    !v.is_null() && v != false && v != 0 && v != ""
}
pub fn enabled(v: &Value) -> bool {
    v["enabled"] != false
}
pub fn nonempty(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.trim().is_empty())
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[derive(Clone, Debug)]
pub struct Paths {
    pub home: PathBuf,
    pub config: PathBuf,
    pub secrets: PathBuf,
    pub runtime: PathBuf,
    pub lock: PathBuf,
    pub backups: PathBuf,
}
impl Paths {
    pub fn new(home: PathBuf) -> Self {
        Self {
            config: home.join("config.json"),
            secrets: home.join("secrets.json"),
            runtime: home.join("runtime.json"),
            lock: home.join("daemon.lock"),
            backups: home.join("backups"),
            home,
        }
    }
    pub fn from_env() -> Result<Self> {
        let home = std::env::var_os("CABLETIDY_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|p| p.join(".cabletidy")))
            .context("Cannot locate the CableTidy data directory")?;
        Ok(Self::new(home))
    }
}
pub fn defaults() -> Value {
    json!({"version":2,"revision":0,"daemon":{},"web":{"listenHost":"127.0.0.1","port":43100},"upstreams":{},"routes":{},"virtualProviders":{},"bindings":{}})
}
fn merge(base: &mut Value, input: &Value) {
    if let (Some(dst), Some(src)) = (base.as_object_mut(), input.as_object()) {
        for (key, value) in src {
            if dst.get(key).is_some_and(Value::is_object) && value.is_object() {
                merge(&mut dst[key], value);
            } else {
                dst.insert(key.clone(), value.clone());
            }
        }
    }
}
fn remove(v: &mut Value, keys: &[&str]) {
    if let Some(obj) = v.as_object_mut() {
        for key in keys {
            obj.remove(*key);
        }
    }
}
pub fn normalize(input: &Value) -> Value {
    let mut c = defaults();
    merge(&mut c, input);
    if input.get("version").is_none()
        && (input.get("models").is_some()
            || entries(&input["virtualProviders"]).any(|(_, p)| p.get("allowedModels").is_some()))
    {
        c["version"] = json!(1);
    }
    for (key, default) in [("version", 1), ("revision", 0)] {
        let n = c[key]
            .as_u64()
            .or_else(|| text(&c[key]).parse().ok())
            .unwrap_or(default);
        c[key] = json!(if key == "version" && n == 0 { 1 } else { n });
    }
    for key in ["upstreams", "routes", "virtualProviders", "bindings"] {
        if !c[key].is_object() {
            c[key] = json!({});
        }
    }
    remove(&mut c["web"], &["sessionTtlSeconds"]);
    remove(&mut c["daemon"], &["proxyPortRange"]);
    for u in c["upstreams"].as_object_mut().unwrap().values_mut() {
        remove(
            u,
            &[
                "requestMaxRetries",
                "streamMaxRetries",
                "streamIdleTimeoutMs",
                "requiresOpenaiAuth",
                "supportsWebsockets",
                "envKey",
                "codexNative",
                "providerFormat",
                "codexToml",
            ],
        );
    }
    if c["version"] == 1 {
        // Migration is transactional: invalid references or duplicate names must not lose data.
        let mut migrated = c.clone();
        if migrate_models(&mut migrated).is_ok() {
            c = migrated;
        }
    }
    for m in c["virtualProviders"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .filter_map(|p| p.get_mut("models").and_then(Value::as_object_mut))
        .flat_map(|models| models.values_mut())
    {
        remove(m, &["legacyCodex", "reasoning"]);
        if let Some(overrides) = m.get_mut("targetOverrides") {
            remove(overrides, &["codex"]);
            if overrides.as_object().is_some_and(Map::is_empty) {
                remove(m, &["targetOverrides"]);
            }
        }
    }
    for p in c["virtualProviders"].as_object_mut().unwrap().values_mut() {
        remove(p, &["localAuth", "listenHost", "listenPort"]);
    }
    for b in c["bindings"].as_object_mut().unwrap().values_mut() {
        remove(b, &["providerFormat", "legacyCodex"]);
        if let Some(v) = b.get_mut("codex") {
            remove(
                v,
                &[
                    "localEnvKey",
                    "profileFiles",
                    "sourceUpstream",
                    "sourceProviderId",
                    "providerId",
                ],
            );
        }
        if let Some(v) = b.get_mut("claude") {
            remove(v, &["authEnv"]);
        }
    }
    normalize_identities(&mut c);
    c
}

pub fn migrate_models(c: &mut Value) -> Result<()> {
    let legacy = c["models"].clone();
    let mut referenced = std::collections::HashSet::new();
    let mut names_by_provider = HashMap::new();
    for (pid, provider) in entries(&c["virtualProviders"])
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect::<Vec<_>>()
    {
        if !provider.is_object() {
            bail!("virtualProviders.{pid} 必须是 object");
        }
        if provider.get("models").is_some() {
            bail!("virtualProviders.{pid}: 旧配置不能同时包含 models 和 allowedModels");
        }
        if provider
            .get("allowedModels")
            .is_some_and(|v| !v.is_array() || array(v).iter().any(|id| !nonempty(id)))
        {
            bail!("virtualProviders.{pid}.allowedModels 必须是模型引用数组");
        }
        let route = &c["routes"][text(&provider["route"])];
        let backend = &route["backends"][0];
        let upstream = text(&backend["upstream"]);
        let mut models = Map::new();
        let mut names = HashMap::new();
        for old_id in array(&provider["allowedModels"]) {
            let old_id = text(old_id);
            let old = &legacy[old_id];
            if !old.is_object() {
                bail!("virtualProviders.{pid}: 模型不存在: {old_id}");
            }
            if old.get("clientModelId").is_some_and(|v| !nonempty(v))
                || old
                    .get("aliases")
                    .is_some_and(|v| !v.is_array() || array(v).iter().any(|alias| !nonempty(alias)))
            {
                bail!("models.{old_id}: 客户端模型名或 aliases 格式不合法");
            }
            if !array(&backend["models"]).contains(&json!(old_id))
                || entries(&old["upstreams"]).count() != 1
                || !old["upstreams"][upstream].is_object()
            {
                bail!("virtualProviders.{pid}: 模型 {old_id} 必须映射到当前配置的 upstream");
            }
            let name = old
                .get("clientModelId")
                .or_else(|| array(&old["aliases"]).first())
                .and_then(Value::as_str)
                .unwrap_or(old_id);
            if name.trim().is_empty() || (models.contains_key(name) && !names.contains_key(old_id))
            {
                bail!("virtualProviders.{pid}.models: 客户端模型名重复或为空: {name}");
            }
            let mut model = old.clone();
            remove(
                &mut model,
                &["id", "clientModelId", "upstreams", "capabilityOverrides"],
            );
            for (key, value) in entries(&old["upstreams"][upstream]) {
                model[key] = value.clone();
            }
            if let Some(aliases) = model.get_mut("aliases").and_then(Value::as_array_mut) {
                aliases.retain(|alias| alias != name);
            }
            models.insert(name.to_owned(), model);
            names.insert(old_id.to_owned(), name.to_owned());
            referenced.insert(old_id.to_owned());
        }
        let claude = entries(&c["bindings"])
            .any(|(_, b)| b["virtualProvider"] == pid && b["target"] == "claude-code");
        let p = &mut c["virtualProviders"][&pid];
        if let Some(name) = names
            .get(text(&p["defaultModel"]))
            .filter(|_| !claude || !claude_alias(text(&p["defaultModel"])))
        {
            p["defaultModel"] = json!(name);
        }
        p["models"] = Value::Object(models);
        remove(p, &["allowedModels"]);
        names_by_provider.insert(pid, names);
    }
    for (id, _) in entries(&legacy) {
        if !referenced.contains(id) {
            bail!("models.{id}: 模型设置未归属任何配置，请先关联或移除后再迁移");
        }
    }
    for b in c["bindings"].as_object_mut().unwrap().values_mut() {
        if let Some(names) = names_by_provider.get(text(&b["virtualProvider"])) {
            if let Some(name) = names
                .get(text(&b["defaultModel"]))
                .filter(|_| b["target"] != "claude-code" || !claude_alias(text(&b["defaultModel"])))
            {
                b["defaultModel"] = json!(name);
            }
            if b["target"] == "claude-code" {
                if let Some(models) = b
                    .get_mut("claude")
                    .and_then(|claude| claude.get_mut("models"))
                    .and_then(Value::as_object_mut)
                {
                    for field in ["opus", "sonnet", "fable", "haiku", "subagent"] {
                        if let Some(value) = models.get_mut(field) {
                            // Family values are model names; subagents also accept native aliases.
                            if field == "subagent"
                                && ["opus", "sonnet", "fable", "haiku"].contains(&text(value))
                            {
                                continue;
                            }
                            if let Some(name) = names.get(text(value)) {
                                *value = json!(name);
                            }
                        }
                    }
                }
            }
        }
    }
    for r in c["routes"].as_object_mut().unwrap().values_mut() {
        if let Some(backends) = r.get_mut("backends").and_then(Value::as_array_mut) {
            for b in backends {
                remove(b, &["models"]);
            }
        }
    }
    remove(c, &["models"]);
    c["version"] = json!(2);
    Ok(())
}
fn claude_alias(name: &str) -> bool {
    ["best", "opus", "sonnet", "fable", "haiku", "opusplan"].contains(&name)
}
pub fn configuration_id(name: &str, fallback: &str) -> String {
    fn slug(s: &str) -> String {
        let mut out = String::new();
        let mut invalid = false;
        for ch in s.trim().to_lowercase().chars() {
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-' {
                out.push(ch);
                invalid = false;
            } else if !invalid {
                out.push('-');
                invalid = true;
            }
        }
        out = out
            .trim_start_matches(|c: char| !c.is_ascii_alphanumeric())
            .trim_end_matches('-')
            .to_owned();
        out.truncate(out.len().min(54));
        out.trim_end_matches('-').to_owned()
    }
    let a = slug(name);
    if !a.is_empty() {
        return a;
    }
    let b = slug(fallback);
    if b.is_empty() {
        "codex".into()
    } else {
        b
    }
}
fn unique_renames(ids: HashMap<String, String>) -> HashMap<String, String> {
    let mut counts = HashMap::new();
    for id in ids.values() {
        *counts.entry(id.clone()).or_insert(0) += 1;
    }
    let mut out: HashMap<_, _> = ids
        .into_iter()
        .map(|(old, new)| {
            let new = if counts[&new] == 1 { new } else { old.clone() };
            (old, new)
        })
        .collect();
    loop {
        let blocked: Vec<_> = out
            .iter()
            .filter(|(old, new)| old != new && out.get(*new) == Some(*new))
            .map(|(old, _)| old.clone())
            .collect();
        if blocked.is_empty() {
            break;
        }
        for old in blocked {
            out.insert(old.clone(), old);
        }
    }
    out
}
fn normalize_identities(c: &mut Value) {
    let binding_ids: HashMap<_, _> = entries(&c["bindings"])
        .map(|(id, b)| {
            (
                id.clone(),
                if b.is_object() {
                    configuration_id(text(&b["name"]), id)
                } else {
                    id.clone()
                },
            )
        })
        .collect();
    let provider_ids = entries(&c["virtualProviders"])
        .map(|(id, p)| {
            let owners: Vec<_> = entries(&c["bindings"])
                .filter(|(_, b)| b["virtualProvider"] == *id)
                .collect();
            let new = if !p.is_object() || owners.len() > 1 {
                id.clone()
            } else {
                let suffix = owners
                    .first()
                    .map(|(id, _)| binding_ids[*id].clone())
                    .unwrap_or_else(|| {
                        configuration_id(id.strip_prefix("cabletidy_").unwrap_or(id), "codex")
                    });
                format!("cabletidy_{suffix}")
            };
            (id.clone(), new)
        })
        .collect();
    let bs = unique_renames(binding_ids);
    let ps = unique_renames(provider_ids);
    c["bindings"] = Value::Object(
        entries(&c["bindings"])
            .map(|(id, b)| {
                let mut b = b.clone();
                if b.is_object() {
                    b["id"] = json!(bs[id]);
                    if let Some(v) = ps.get(text(&b["virtualProvider"])) {
                        b["virtualProvider"] = json!(v);
                    }
                }
                (bs[id].clone(), b)
            })
            .collect(),
    );
    c["virtualProviders"] = Value::Object(
        entries(&c["virtualProviders"])
            .map(|(id, p)| {
                let mut p = p.clone();
                if p.is_object() {
                    p["id"] = json!(ps[id]);
                }
                (ps[id].clone(), p)
            })
            .collect(),
    );
}
fn clean_config(v: &mut Value, strip_presentation: bool) {
    const KEYS: &[&str] = &[
        "secret",
        "apiKey",
        "api_key",
        "token",
        "accessToken",
        "access_token",
        "refreshToken",
        "refresh_token",
        "clientSecret",
        "client_secret",
        "password",
        "privateKey",
        "private_key",
    ];
    #[derive(Clone, Copy)]
    enum Scope {
        Config,
        Providers,
        Provider,
        Models,
        Fields,
    }
    fn clean(v: &mut Value, scope: Scope, strip_presentation: bool) {
        if let Some(obj) = v.as_object_mut() {
            // Only schema-level model dictionaries contain names instead of field keys.
            if !matches!(scope, Scope::Models) {
                obj.retain(|key, _| {
                    !KEYS.contains(&key.as_str())
                        && !(strip_presentation && key == "secretConfigured")
                });
            }
            for (key, value) in obj {
                let next = match (scope, key.as_str()) {
                    (Scope::Config | Scope::Provider, "models") => Scope::Models,
                    (Scope::Config, "virtualProviders") => Scope::Providers,
                    (Scope::Providers, _) => Scope::Provider,
                    _ => Scope::Fields,
                };
                clean(value, next, strip_presentation);
            }
        } else if let Some(arr) = v.as_array_mut() {
            for item in arr {
                clean(item, Scope::Fields, strip_presentation);
            }
        }
    }
    clean(v, Scope::Config, strip_presentation);
}
pub fn redact(v: &mut Value) {
    clean_config(v, false);
}
pub fn strip_presentation(v: &Value) -> Value {
    let mut out = v.clone();
    clean_config(&mut out, true);
    out
}
pub fn public(c: &Value, secrets: &Value) -> Value {
    let mut out = normalize(c);
    redact(&mut out);
    for (id, u) in out["upstreams"].as_object_mut().unwrap() {
        if u.is_object() {
            let configured = !secret(u, secrets).is_empty();
            if !nonempty(&u["secretRef"]) {
                u["secretRef"] = json!(format!("secret://upstreams/{id}"));
            }
            u["secretConfigured"] = json!(configured);
        }
    }
    out
}
pub fn secret<'a>(u: &Value, secrets: &'a Value) -> &'a str {
    text(&secrets[text(&u["secretRef"])])
}
pub fn apply_secrets(c: &mut Value, secrets: &Value, payload: &Value) -> Value {
    let mut result = secrets.clone();
    if !result.is_object() {
        result = json!({});
    }
    for (id, key) in entries(&payload["upstreamSecrets"]) {
        if !nonempty(key) || !c["upstreams"][id].is_object() {
            continue;
        }
        let u = &mut c["upstreams"][id];
        if !nonempty(&u["secretRef"]) {
            u["secretRef"] = json!(format!("secret://upstreams/{id}"));
        }
        result[text(&u["secretRef"])] = json!(text(key).trim());
    }
    result
}
pub fn base_url(c: &Value, id: &str) -> String {
    format!(
        "http://{}:{}/{id}",
        url_host(text(&c["web"]["listenHost"])),
        c["web"]["port"]
    )
}
pub fn url_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.into()
    }
}
pub async fn ensure_dir(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path).await?;
    Ok(())
}
pub async fn read_optional(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path).await {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub async fn read_json(path: &Path) -> Result<Option<Value>> {
    read_optional(path)
        .await?
        .map(|s| {
            serde_json::from_str(&s).with_context(|| format!("Invalid JSON: {}", path.display()))
        })
        .transpose()
}
pub async fn atomic_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path.parent().context("Missing parent directory")?;
    ensure_dir(parent).await?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let result = async {
        use tokio::io::AsyncWriteExt;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut f = options.open(&tmp).await?;
        f.write_all(contents).await?;
        f.sync_all().await?;
        drop(f);
        crate::fsutil::retry_sharing(|| fs::rename(&tmp, path)).await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    let _ = fs::remove_file(&tmp).await;
    result
}
pub async fn write_json(path: &Path, v: &Value) -> Result<()> {
    atomic_write(
        path,
        format!("{}\n", serde_json::to_string_pretty(v)?).as_bytes(),
    )
    .await
}
pub async fn backup(file: &Path, dir: &Path, label: &str) -> Result<Option<PathBuf>> {
    let bytes = match fs::read(file).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    ensure_dir(dir).await?;
    let dest = dir.join(format!(
        "{}-{}-{label}",
        now().replace([':', '.'], "-"),
        uuid::Uuid::new_v4()
    ));
    atomic_write(&dest, &bytes).await?;
    Ok(Some(dest))
}
pub fn diff(before: &Value, after: &Value) -> Value {
    fn walk(b: Option<&Value>, a: Option<&Value>, path: String, out: &mut Value) {
        if path == "revision" {
            return;
        }
        match (b, a) {
            (None, Some(a)) => out["added"]
                .as_array_mut()
                .unwrap()
                .push(json!({"path":path,"value":a})),
            (Some(b), None) => out["removed"]
                .as_array_mut()
                .unwrap()
                .push(json!({"path":path,"value":b})),
            (Some(b), Some(a)) if b.is_object() && a.is_object() => {
                let keys: std::collections::BTreeSet<_> =
                    entries(b).chain(entries(a)).map(|(k, _)| k).collect();
                for k in keys {
                    walk(
                        b.get(k),
                        a.get(k),
                        if path.is_empty() {
                            k.clone()
                        } else {
                            format!("{path}.{k}")
                        },
                        out,
                    );
                }
            }
            (Some(b), Some(a)) if b != a => out["changed"]
                .as_array_mut()
                .unwrap()
                .push(json!({"path":path,"before":b,"after":a})),
            _ => {}
        }
    }
    let mut out = json!({"added":[],"removed":[],"changed":[]});
    walk(
        Some(&normalize(&strip_presentation(before))),
        Some(&normalize(&strip_presentation(after))),
        String::new(),
        &mut out,
    );
    let paths: Vec<_> = ["added", "removed", "changed"]
        .iter()
        .flat_map(|key| array(&out[*key]))
        .collect();
    let total = paths.len();
    let mut affected = Vec::new();
    for p in paths {
        let root = text(&p["path"]).split('.').next().unwrap_or("");
        if !root.is_empty() && !affected.contains(&root.to_owned()) {
            affected.push(root.to_owned());
        }
    }
    out["total"] = json!(total);
    out["affected"] = json!(affected);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn atomic_replace_preserves_the_previous_file_on_failure_and_cleans_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.json");
        write_json(&file, &json!({"revision":1})).await.unwrap();
        write_json(&file, &json!({"revision":2})).await.unwrap();
        assert_eq!(read_json(&file).await.unwrap().unwrap()["revision"], 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&file).await.unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let blocked = dir.path().join("blocked");
        fs::create_dir(&blocked).await.unwrap();
        fs::write(blocked.join("existing"), "unchanged")
            .await
            .unwrap();
        assert!(write_json(&blocked, &json!({"revision":3})).await.is_err());
        assert_eq!(
            fs::read_to_string(blocked.join("existing")).await.unwrap(),
            "unchanged"
        );
        assert_eq!(read_json(&file).await.unwrap().unwrap()["revision"], 2);
        let mut entries = fs::read_dir(dir.path()).await.unwrap();
        let mut count = 0;
        while entries.next_entry().await.unwrap().is_some() {
            count += 1;
        }
        assert_eq!(count, 2);
    }
}
