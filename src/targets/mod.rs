pub mod claude;
pub mod codex;
use crate::{
    catalog::Catalog,
    config::{
        array, base_url, configuration_id, entries, nonempty, normalize, secret, text, Paths,
    },
    model,
};
use anyhow::{bail, Context, Result};
pub use claude::restore;
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Clone)]
pub struct Options {
    pub paths: Paths,
    pub codex_home: PathBuf,
    pub claude_home: PathBuf,
}
impl Options {
    pub fn new(paths: Paths) -> Result<Self> {
        let home = dirs::home_dir().context("Cannot find user home")?;
        Ok(Self {
            paths,
            codex_home: std::path::absolute(
                std::env::var_os("CODEX_HOME")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".codex")),
            )?,
            claude_home: std::path::absolute(
                std::env::var_os("CLAUDE_CONFIG_DIR")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".claude")),
            )?,
        })
    }
}
pub fn codex_endpoints() -> Value {
    json!([{"method":"GET","path":"/v1/models","purpose":"model_discovery"},{"method":"POST","path":"/v1/responses","purpose":"responses","supportsStreaming":true}])
}
pub fn claude_endpoints() -> Value {
    json!([{"method":"POST","path":"/v1/messages","purpose":"messages","required":true},{"method":"POST","path":"/v1/messages/count_tokens","purpose":"token_counting","required":false},{"method":"GET","path":"/v1/models","purpose":"model_discovery","required":false},{"method":"HEAD","path":"/api/hello","purpose":"connection_probe","required":false}])
}
pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
pub fn build(input: &Value, binding_id: &str, secrets: &Value) -> Result<Value> {
    let mut names = std::collections::HashSet::new();
    for (id, b) in entries(&input["bindings"]) {
        let name = configuration_id(text(&b["name"]), id);
        if !names.insert(name.clone()) {
            bail!("配置名称规范化后重复: {name}");
        }
    }
    let requested = input["bindings"]
        .get(binding_id)
        .map(|b| configuration_id(text(&b["name"]), binding_id))
        .unwrap_or_else(|| binding_id.to_owned());
    let c = normalize(input);
    let (id, b) = entries(&c["bindings"])
        .find(|(id, b)| {
            if requested.is_empty() {
                b["enabled"] != false
            } else {
                id.as_str() == requested || b["id"] == requested
            }
        })
        .context("找不到 Target binding")?;
    let p = &c["virtualProviders"][text(&b["virtualProvider"])];
    if !p.is_object() {
        bail!("Binding 引用的 Virtual Provider 不存在");
    }
    if p["id"] != format!("cabletidy_{id}")
        || entries(&c["bindings"])
            .filter(|(_, b)| b["virtualProvider"] == p["id"])
            .count()
            != 1
    {
        bail!("配置与 Virtual Provider 必须一对一，Virtual Provider ID 必须为 cabletidy_<配置ID>");
    }
    let target = text(&b["target"]);
    let requested = b.get("defaultModel").or_else(|| p.get("defaultModel"));
    let default = if let Some(name) = requested {
        if target == "claude-code"
            && ["best", "opus", "sonnet", "fable", "haiku", "opusplan"].contains(&text(name))
        {
            Some(text(name).to_owned())
        } else {
            let r = model::resolve(p, Some(name))?;
            Some(if let Some(id) = &r.matched_model {
                id.clone()
            } else {
                r.client
            })
        }
    } else {
        None
    };
    let base = base_url(&c, id);
    if target == "codex" {
        let backends = array(&c["routes"][text(&p["route"])]["backends"]);
        if backends.len() != 1 {
            bail!("每份配置必须且只能连接一个 upstream");
        }
        let u = &c["upstreams"][text(&backends[0]["upstream"])];
        if !u.is_object() {
            bail!("找不到 binding 对应的 upstream");
        }
        let provider = text(&p["id"]);
        let active=format!("# >>> CABLETIDY MANAGED ACTIVE PROVIDER {provider} -->\nmodel_provider = {}\n{}# <<< CABLETIDY MANAGED ACTIVE PROVIDER {provider} <--\n",json!(provider),default.as_ref().map(|d|format!("model = {}\n",json!(d))).unwrap_or_default());
        let provider_contents=format!("# >>> CABLETIDY MANAGED PROVIDER {provider} -->\n[model_providers.{provider}]\nname = {}\nbase_url = {}\nwire_api = \"responses\"\nrequires_openai_auth = false\n# <<< CABLETIDY MANAGED PROVIDER {provider} <--\n",json!(format!("CableTidy / {}",text(u.get("name").unwrap_or(&u["id"])))),json!(format!("{base}/v1")));
        let profile = if requested.is_some() {
            model::resolve(p, requested)?.profile
        } else {
            Value::Null
        };
        return Ok(
            json!({"integration":"codex-native-provider","targetFormat":"codex.config.toml.v1","format":"codex.config.toml.v1","target":"codex","mode":"managed_proxy","bindingId":id,"virtualProviderId":p["id"],"providerId":provider,"activeContents":active,"providerContents":provider_contents,"clientModelId":default,"modelPolicy":{"contextWindow":profile["contextWindow"],"compact":profile["compact"]},"files":[{"path":"config.toml","contents":format!("{active}\n{provider_contents}")}],"environment":{"vars":{},"shell":""},"upstream":{"id":u["id"],"baseUrl":u["baseUrl"],"secretConfigured":!secret(u,secrets).is_empty()}}),
        );
    }
    let mut vars = json!({});
    if target == "claude-code" {
        if p["ingressProtocol"] != "anthropic.messages" {
            bail!("Claude Code binding 必须连接 anthropic.messages Virtual Provider");
        }
        vars = json!({"ANTHROPIC_BASE_URL":base,"ANTHROPIC_AUTH_TOKEN":"cabletidy-local","ANTHROPIC_API_KEY":"","CLAUDE_CODE_OAUTH_TOKEN":"","ANTHROPIC_CUSTOM_HEADERS":"","CLAUDE_CODE_USE_BEDROCK":"0","CLAUDE_CODE_USE_VERTEX":"0","CLAUDE_CODE_USE_FOUNDRY":"0","CLAUDE_CODE_USE_ANTHROPIC_AWS":"0","CLAUDE_CODE_USE_MANTLE":"0","CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY":if b["claude"]["discoverModels"]==true{"1"}else{"0"}});
        if b["claude"]["setModel"] != false {
            if let Some(name) = &default {
                vars["ANTHROPIC_MODEL"] = json!(name);
            }
        }
        for family in ["opus", "sonnet", "fable", "haiku"] {
            if nonempty(&b["claude"]["models"][family]) {
                vars[format!("ANTHROPIC_DEFAULT_{}_MODEL", family.to_uppercase())] =
                    b["claude"]["models"][family].clone();
            }
        }
        if nonempty(&b["claude"]["models"]["subagent"]) {
            vars["CLAUDE_CODE_SUBAGENT_MODEL"] = b["claude"]["models"]["subagent"].clone();
        }
    } else if target == "generic-env" {
        let prefix = b["env"]["prefix"].as_str().unwrap_or("CABLETIDY");
        if prefix.is_empty()
            || prefix.as_bytes()[0].is_ascii_digit()
            || !prefix
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
        {
            bail!("generic env prefix 不合法");
        }
        vars[format!("{prefix}_BASE_URL")] = json!(base);
        if let Some(name) = &default {
            vars[format!("{prefix}_MODEL")] = json!(name);
        }
    } else {
        bail!("不支持的 target: {target}");
    }
    let shell = entries(&vars)
        .map(|(key, v)| format!("export {key}='{}'", text(v).replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = json!({"format":if target=="claude-code"{"claude.settings.json.v1"}else{"generic.env.v1"},"target":target,"mode":"managed_proxy","bindingId":id,"virtualProviderId":p["id"],"clientModelId":default,"files":[],"environment":{"vars":vars,"shell":shell}});
    if target == "claude-code" {
        out["files"] = json!([{"path":"cabletidy-claude.settings.json","kind":"json","contents":format!("{}\n",serde_json::to_string_pretty(&json!({"env":vars}))?)}]);
        out["requiredEndpoints"] = claude_endpoints();
        out["environment"]["powershell"] = json!(entries(&vars)
            .map(|(k, v)| format!("$env:{k} = '{}'", text(v).replace('\'', "''")))
            .collect::<Vec<_>>()
            .join("\n"));
        out["instructions"]=json!(["应用时只合并到用户 settings.json 的 env，保留其他设置；原值保存以便撤销接入。","本地入口无需 Key；cabletidy-local 仅满足客户端认证检查，真实凭据只由 CableTidy 发给上游。",format!("ANTHROPIC_BASE_URL 指向本地 Virtual Provider: {base}")]);
    }
    Ok(out)
}
pub async fn prepare(
    c: &Value,
    id: &str,
    secrets: &Value,
    catalog: &Catalog,
    options: &Options,
) -> Result<Value> {
    let mut a = build(c, id, secrets)?;
    match text(&a["target"]) {
        "codex" => {
            let normalized = normalize(c);
            let p = &normalized["virtualProviders"][text(&a["virtualProviderId"])];
            a["catalogPlan"] = if entries(&p["models"]).next().is_none() {
                json!({"catalog":null,"models":[],"overrides":[],"warnings":[]})
            } else {
                crate::catalog::plan(&normalized, p, &catalog.load(false).await?)?
            };
            codex::stage(a, options).await
        }
        "claude-code" => claude::prepare(a, options).await,
        _ => Ok(a),
    }
}
pub async fn apply(a: &Value, options: &Options) -> Result<Value> {
    match text(&a["target"]) {
        "codex" => codex::apply(a, options).await,
        "claude-code" => claude::apply(a, options).await,
        _ => bail!("此 target 没有可持久化写入的客户端配置"),
    }
}
pub fn public(a: &Value) -> Value {
    let mut a = a.clone();
    if let Some(o) = a.as_object_mut() {
        for k in ["catalogPlan", "catalogState", "rootBefore", "codexHome"] {
            o.remove(k);
        }
    }
    a
}
