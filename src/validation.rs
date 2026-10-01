use crate::config::{array, configuration_id, entries, nonempty, normalize, text};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const PROTOCOLS: &[&str] = &[
    "openai.responses",
    "openai.chat_completions",
    "anthropic.messages",
    "gemini.generate_content",
];
pub const IMPLEMENTED: &[&str] = &["openai.responses", "anthropic.messages"];
pub fn loopback(host: &str) -> bool {
    ["127.0.0.1", "localhost", "::1", "[::1]"].contains(&host.trim().to_lowercase().as_str())
}
fn id(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v.as_bytes()[0].is_ascii_alphanumeric()
        && v.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
fn string_array(v: &Value) -> bool {
    v.is_array() && array(v).iter().all(nonempty)
}
fn integer(v: &Value) -> bool {
    v.as_u64().is_some_and(|v| v > 0)
}
fn token(v: &Value) -> bool {
    nonempty(v)
        && text(v)
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&c))
}
pub fn validate(input: &Value) -> Value {
    let c = normalize(input);
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut add = |path: String, message: String| {
        errors.push(json!({"path":path,"message":message}));
    };
    macro_rules! check {
        ($cond:expr,$path:expr,$message:expr) => {
            if !($cond) {
                add(($path).to_string(), ($message).to_string());
            }
        };
    }
    check!(c["version"] == 1, "version", "当前 MVP 只支持 version = 1");
    check!(
        integer(&c["web"]["port"]) && c["web"]["port"].as_u64().unwrap_or(0) <= 65535,
        "web.port",
        "Web 端口必须是 1 到 65535 之间的整数"
    );
    check!(
        loopback(text(&c["web"]["listenHost"])),
        "web.listenHost",
        "Web 管理台必须监听 127.0.0.1、localhost 或 ::1；本地管理台不支持远程监听"
    );
    for (key, u) in entries(&c["upstreams"]) {
        let p = format!("upstreams.{key}");
        check!(u.is_object(), p, "upstream 必须是 object");
        check!(id(key), p, "upstream ID 包含非法字符");
        check!(
            url::Url::parse(text(&u["baseUrl"]))
                .is_ok_and(|u| ["http", "https"].contains(&u.scheme())),
            format!("{p}.baseUrl"),
            "必须是 http 或 https URL"
        );
        check!(
            PROTOCOLS.contains(&text(&u["protocol"])),
            format!("{p}.protocol"),
            "不支持的协议"
        );
        if let Some(v) = u.get("integration") {
            check!(
                v == "codex-native-provider",
                format!("{p}.integration"),
                "未注册的上游接入方式"
            );
        }
        if let Some(v) = u["auth"].get("header").or_else(|| u.get("authHeader")) {
            check!(
                token(v),
                format!("{p}.auth.header"),
                "认证 header 名称不合法"
            );
        }
        if let Some(v) = u["auth"].get("scheme") {
            check!(
                token(v),
                format!("{p}.auth.scheme"),
                "认证 scheme 必须是合法的 HTTP token"
            );
        }
    }
    for (key, m) in entries(&c["models"]) {
        let p = format!("models.{key}");
        check!(m.is_object(), p, "Model Profile 必须是 object");
        check!(id(key), p, "Model Profile ID 包含非法字符");
        check!(
            string_array(&m["aliases"]),
            format!("{p}.aliases"),
            "aliases 必须是非空字符串数组"
        );
        if let Some(v) = m.get("clientModelId") {
            check!(
                nonempty(v),
                format!("{p}.clientModelId"),
                "必须是非空字符串"
            );
        }
        if let Some(v) = m.get("capabilities") {
            check!(
                string_array(v),
                format!("{p}.capabilities"),
                "capabilities 必须是非空字符串数组"
            );
        }
        if let Some(v) = m.get("contextWindow") {
            check!(
                integer(v),
                format!("{p}.contextWindow"),
                "contextWindow 必须是正整数"
            );
        }
        if let Some(v) = m.get("codex") {
            check!(
                v.is_object() && ["official", "override"].contains(&text(&v["metadataMode"])),
                format!("{p}.codex"),
                "Codex metadataMode 必须为 official 或 override"
            );
            if let Some(v) = v.get("inputModalities") {
                check!(
                    v.is_array()
                        && array(v).contains(&json!("text"))
                        && array(v)
                            .iter()
                            .all(|v| ["text", "image"].contains(&text(v))),
                    format!("{p}.codex.inputModalities"),
                    "输入类型必须包含 text，且只能包含 text 或 image"
                );
            }
        }
        if let Some(v) = m.get("compact") {
            check!(
                v.is_object() && v.get("tokenLimit").is_none_or(integer),
                format!("{p}.compact"),
                "compact 必须包含合法的 tokenLimit"
            );
            if let Some(v) = v.get("strategy") {
                check!(
                    ["auto", "manual", "disabled"].contains(&text(v)),
                    format!("{p}.compact.strategy"),
                    "不支持的 compact strategy"
                );
            }
        }
        check!(
            m["upstreams"].is_object() && entries(&m["upstreams"]).count() == 1,
            format!("{p}.upstreams"),
            "每个 Model Profile 必须且只能映射一个 upstream"
        );
        for (uid, b) in entries(&m["upstreams"]) {
            let bp = format!("{p}.upstreams.{uid}");
            check!(!c["upstreams"][uid].is_null(), bp, "引用的 upstream 不存在");
            check!(b.is_object(), bp, "模型设置必须是 object");
            if let Some(v) = b.get("upstreamModelId") {
                check!(
                    nonempty(v),
                    format!("{bp}.upstreamModelId"),
                    "如需改名，必须填写非空字符串"
                );
            }
            if let Some(v) = b.get("capabilityOverrides") {
                check!(
                    string_array(v),
                    format!("{bp}.capabilityOverrides"),
                    "capabilityOverrides 必须是非空字符串数组"
                );
            }
        }
    }
    for (key, r) in entries(&c["routes"]) {
        let p = format!("routes.{key}");
        check!(r.is_object(), p, "route 必须是 object");
        check!(id(key), p, "route ID 包含非法字符");
        check!(
            r["backends"].is_array() && array(&r["backends"]).len() == 1,
            format!("{p}.backends"),
            "每份配置必须且只能连接一个 upstream（一个 backend）"
        );
        for (i, b) in array(&r["backends"]).iter().enumerate() {
            let bp = format!("{p}.backends.{i}");
            check!(b.is_object(), bp, "backend 必须是 object");
            check!(
                !c["upstreams"][text(&b["upstream"])].is_null(),
                format!("{bp}.upstream"),
                "upstream 不存在"
            );
            if let Some(v) = b.get("models") {
                check!(
                    string_array(v),
                    format!("{bp}.models"),
                    "models 必须是非空字符串数组，可留空以透传模型名"
                );
            }
            for v in array(&b["models"]) {
                check!(
                    c["models"][text(v)]["upstreams"]
                        .get(text(&b["upstream"]))
                        .is_some(),
                    format!("{bp}.models"),
                    format!("模型不存在或没有 upstream 的模型映射: {}", text(v))
                );
            }
        }
    }
    for (key, pv) in entries(&c["virtualProviders"]) {
        let p = format!("virtualProviders.{key}");
        check!(pv.is_object(), p, "Virtual Provider 必须是 object");
        check!(id(key), p, "Virtual Provider ID 包含非法字符");
        check!(
            key.starts_with("cabletidy_"),
            format!("{p}.id"),
            "Virtual Provider ID 应为 cabletidy_<配置ID>"
        );
        check!(
            key != "cabletidy_api",
            format!("{p}.id"),
            "配置 ID api 是管理接口保留路径"
        );
        check!(
            PROTOCOLS.contains(&text(&pv["ingressProtocol"])),
            format!("{p}.ingressProtocol"),
            "未注册的 ingress protocol"
        );
        if PROTOCOLS.contains(&text(&pv["ingressProtocol"]))
            && !IMPLEMENTED.contains(&text(&pv["ingressProtocol"]))
        {
            warnings.push(json!({"path":format!("{p}.ingressProtocol"),"message":format!("当前数据面尚未实现 {}，请求会返回 501",text(&pv["ingressProtocol"]))}));
        }
        let route = &c["routes"][text(&pv["route"])];
        check!(!route.is_null(), format!("{p}.route"), "route 不存在");
        if let Some(v) = pv.get("defaultModel") {
            check!(
                nonempty(v),
                format!("{p}.defaultModel"),
                "defaultModel 必须是非空字符串"
            );
        }
        if let Some(v) = pv.get("allowedModels") {
            check!(
                string_array(v),
                format!("{p}.allowedModels"),
                "模型设置必须是数组，可留空以透传模型名"
            );
        }
        let mut aliases = HashMap::new();
        for mid in array(&pv["allowedModels"]) {
            let m = &c["models"][text(mid)];
            let b = &route["backends"][0];
            check!(
                !m.is_null(),
                format!("{p}.allowedModels"),
                format!("模型不存在: {}", text(mid))
            );
            if m.is_null() {
                continue;
            }
            check!(
                array(&b["models"]).contains(mid)
                    && m["upstreams"].get(text(&b["upstream"])).is_some(),
                format!("{p}.allowedModels"),
                "模型必须映射到当前配置的 upstream"
            );
            for alias in [mid, &m["clientModelId"]]
                .into_iter()
                .chain(array(&m["aliases"]))
            {
                if !nonempty(alias) {
                    continue;
                }
                let a = text(alias);
                check!(
                    aliases.get(a).is_none_or(|owner| owner == mid),
                    format!("{p}.allowedModels"),
                    format!("模型名或 alias \"{a}\" 在当前 Virtual Provider 内重复")
                );
                aliases.insert(a, mid.clone());
            }
        }
    }
    let mut names = HashMap::new();
    let mut owners = HashMap::new();
    for (key, b) in entries(&c["bindings"]) {
        let p = format!("bindings.{key}");
        let name = configuration_id(text(&b["name"]), key);
        let provider = text(&b["virtualProvider"]);
        check!(b.is_object(), p, "Binding 必须是 object");
        check!(id(key), p, "Binding ID 包含非法字符");
        check!(
            name != "api",
            format!("{p}.name"),
            "配置 ID api 是管理接口保留路径"
        );
        check!(
            !names.contains_key(&name),
            format!("{p}.name"),
            format!("配置名称规范化后重复: {name}")
        );
        names.insert(name.clone(), key);
        check!(
            key == &name,
            format!("{p}.id"),
            format!("配置 ID 应为 {name}，请检查名称或 ID 冲突")
        );
        check!(
            !owners.contains_key(provider),
            format!("{p}.virtualProvider"),
            "配置与 Virtual Provider 必须一对一"
        );
        owners.insert(provider, key);
        check!(
            provider == format!("cabletidy_{key}"),
            format!("{p}.virtualProvider"),
            "Virtual Provider ID 应为 cabletidy_<配置ID>"
        );
        check!(
            ["codex", "claude-code", "generic-env"].contains(&text(&b["target"])),
            format!("{p}.target"),
            "不支持的 target"
        );
        let pv = &c["virtualProviders"][provider];
        check!(
            !pv.is_null(),
            format!("{p}.virtualProvider"),
            "Virtual Provider 不存在"
        );
        for (target, protocol) in [
            ("codex", "openai.responses"),
            ("claude-code", "anthropic.messages"),
        ] {
            if b["target"] == target {
                check!(
                    pv["ingressProtocol"] == protocol,
                    format!("{p}.virtualProvider"),
                    format!("{target} binding 必须连接 {protocol} Virtual Provider")
                );
            }
        }
        if let Some(v) = b.get("defaultModel") {
            check!(
                nonempty(v),
                format!("{p}.defaultModel"),
                "defaultModel 必须是非空字符串"
            );
        }
        if let Some(v) = b.get("integration") {
            check!(
                v == "codex-native-provider",
                format!("{p}.integration"),
                "未注册的上游接入方式"
            );
        }
        if let Some(v) = b.get("targetFormat") {
            check!(
                [
                    "codex.config.toml.v1",
                    "claude.env.v1",
                    "claude.settings.json.v1",
                    "generic.env.v1"
                ]
                .contains(&text(v)),
                format!("{p}.targetFormat"),
                "未注册的 target format"
            );
            if b["target"] == "codex" {
                check!(
                    v == "codex.config.toml.v1",
                    format!("{p}.targetFormat"),
                    "Codex binding 必须使用本地 config.toml 接入"
                );
            }
            if b["target"] == "claude-code" {
                check!(
                    ["claude.env.v1", "claude.settings.json.v1"].contains(&text(v)),
                    format!("{p}.targetFormat"),
                    "Claude Code binding 必须使用 Claude settings 或 env 接入"
                );
            }
        }
        if b["target"] == "claude-code" {
            if let Some(v) = b.get("claude") {
                check!(
                    v.is_object(),
                    format!("{p}.claude"),
                    "Claude 设置必须是 object"
                );
                for key in ["setModel", "discoverModels"] {
                    if let Some(v) = v.get(key) {
                        check!(
                            v.is_boolean(),
                            format!("{p}.claude.{key}"),
                            "必须是 boolean"
                        );
                    }
                }
                if let Some(v) = v.get("models") {
                    check!(
                        v.is_object(),
                        format!("{p}.claude.models"),
                        "模型选择必须是 object"
                    );
                    for (key, v) in entries(v) {
                        check!(
                            ["opus", "sonnet", "fable", "haiku", "subagent"]
                                .contains(&key.as_str())
                                && nonempty(v),
                            format!("{p}.claude.models.{key}"),
                            "仅支持 opus、sonnet、fable、haiku、subagent 的非空模型 ID"
                        );
                    }
                }
            }
        }
        if b["target"] == "generic-env" && b["env"].get("prefix").is_some() {
            let prefix = text(&b["env"]["prefix"]);
            check!(
                !prefix.is_empty()
                    && !prefix.as_bytes()[0].is_ascii_digit()
                    && prefix
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'),
                format!("{p}.env.prefix"),
                "generic env prefix 必须是大写环境变量名"
            );
        }
    }
    for (key, message) in [
        ("upstreams", "还没有配置 upstream"),
        ("virtualProviders", "还没有配置本地 Virtual Provider"),
    ] {
        if entries(&c[key]).count() == 0 {
            warnings.push(json!({"path":key,"message":message}));
        }
    }
    json!({"ok":errors.is_empty(),"errors":errors,"warnings":warnings,"config":c})
}
