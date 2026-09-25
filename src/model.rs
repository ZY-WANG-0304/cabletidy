use crate::config::{array, enabled, entries, nonempty, text, truthy};
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[derive(Debug, Clone)]
pub struct ResolveError {
    pub code: &'static str,
    pub message: String,
    pub details: Value,
}
impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for ResolveError {}
fn error(code: &'static str, message: impl Into<String>) -> ResolveError {
    ResolveError {
        code,
        message: message.into(),
        details: json!({}),
    }
}
#[derive(Clone)]
pub struct Resolution {
    pub client: String,
    pub profile_id: Option<String>,
    pub profile: Value,
}
#[derive(Clone)]
pub struct Backend {
    pub route: String,
    pub upstream: Value,
    pub model: String,
    pub capabilities: BTreeSet<String>,
}
pub fn client_model<'a>(id: &'a str, profile: &'a Value) -> &'a str {
    if nonempty(&profile["clientModelId"]) {
        text(&profile["clientModelId"])
    } else {
        array(&profile["aliases"])
            .first()
            .and_then(Value::as_str)
            .unwrap_or(id)
    }
}
pub fn resolve(
    c: &Value,
    p: &Value,
    requested: Option<&Value>,
) -> Result<Resolution, ResolveError> {
    if requested.is_some_and(|v| !nonempty(v)) {
        return Err(error("invalid_model", "model 必须是非空字符串"));
    }
    let name = requested.unwrap_or(&p["defaultModel"]);
    if !nonempty(name) {
        return Err(error(
            "model_required",
            "请求没有模型，Virtual Provider 也没有默认模型",
        ));
    }
    let allowed = array(&p["allowedModels"]);
    let key = text(name);
    let matched = entries(&c["models"])
        .filter(|(id, _)| allowed.contains(&json!(id)))
        .find(|(id, _)| id.as_str() == key)
        .or_else(|| {
            entries(&c["models"])
                .filter(|(id, _)| allowed.contains(&json!(id)))
                .find(|(_, m)| m["clientModelId"] == key || array(&m["aliases"]).contains(name))
        });
    match matched {
        Some((id, profile)) => Ok(Resolution {
            client: if requested.is_some() {
                key.into()
            } else {
                client_model(id, profile).into()
            },
            profile_id: Some(id.clone()),
            profile: profile.clone(),
        }),
        None => Ok(Resolution {
            client: key.into(),
            profile_id: None,
            profile: Value::Null,
        }),
    }
}
pub fn capabilities(p: &Value, b: &Value) -> BTreeSet<String> {
    let mut out: BTreeSet<_> = array(&p["capabilities"])
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    for v in array(&b["capabilityOverrides"]) {
        let s = text(v);
        if let Some(v) = s.strip_prefix('-') {
            out.remove(v);
        } else {
            out.insert(s.trim_start_matches('+').to_owned());
        }
    }
    if p["codex"]["metadataMode"] == "override"
        && p["codex"].get("inputModalities").is_some()
        && !array(&p["codex"]["inputModalities"]).contains(&json!("image"))
    {
        out.remove("vision");
    }
    out
}
fn contains_image(v: &Value) -> bool {
    if let Some(a) = v.as_array() {
        a.iter().any(contains_image)
    } else if v.is_object() {
        ["input_image", "image", "image_url"].contains(&text(&v["type"]))
            || contains_image(&v["content"])
    } else {
        false
    }
}
pub fn select(c: &Value, p: &Value, r: &Resolution, body: &Value) -> Result<Backend, ResolveError> {
    let route = &c["routes"][text(&p["route"])];
    if !route.is_object() {
        return Err(error(
            "route_not_found",
            format!("Route 不存在: {}", text(&p["route"])),
        ));
    }
    let backends = array(&route["backends"]);
    if backends.len() != 1 {
        return Err(error(
            "invalid_route",
            "每份配置必须且只能连接一个 upstream",
        ));
    }
    let b = &backends[0];
    let u = &c["upstreams"][text(&b["upstream"])];
    let profile = &r.profile;
    let binding = &profile["upstreams"][text(&b["upstream"])];
    if entries(&profile["upstreams"]).count() > 1 {
        return Err(error(
            "invalid_model_binding",
            "每个 Model Profile 只能映射一个 upstream",
        ));
    }
    let caps = capabilities(profile, binding);
    let mut required = BTreeSet::new();
    for (key, cap) in [
        ("stream", "streaming"),
        ("tool_choice", "tools"),
        ("parallel_tool_calls", "parallel_tool_calls"),
        ("reasoning", "reasoning"),
    ] {
        if truthy(&body[key]) {
            required.insert(cap.to_owned());
        }
    }
    if !array(&body["tools"]).is_empty() {
        required.insert("tools".into());
    }
    if truthy(&body["thinking"]) && body["thinking"]["type"] != "disabled" {
        required.insert("reasoning".into());
    }
    if truthy(&body["images"])
        || truthy(&body["image_input"])
        || contains_image(&body["input"])
        || contains_image(&body["messages"])
    {
        required.insert("vision".into());
    }
    let reason = if !enabled(b) || !u.is_object() || !enabled(u) {
        Some("upstream_disabled_or_missing")
    } else if !profile.is_null() && !array(&b["models"]).contains(&json!(r.profile_id)) {
        Some("model_not_in_route")
    } else if !profile.is_null() && binding.is_null() {
        Some("model_binding_missing")
    } else if p["ingressProtocol"] != u["protocol"] {
        Some("protocol_transform_missing")
    } else if !profile.is_null()
        && (p["ingressProtocol"] != "anthropic.messages"
            || profile.get("capabilities").is_some()
            || !array(&binding["capabilityOverrides"]).is_empty())
        && !required.is_subset(&caps)
    {
        Some("capability_missing")
    } else {
        None
    };
    if let Some(reason) = reason {
        let mut rejected = json!({"index":0,"reason":reason});
        if reason == "capability_missing" {
            rejected["missing"] = json!(required.difference(&caps).collect::<Vec<_>>());
        }
        return Err(ResolveError {
            code: "no_compatible_upstream",
            message: format!("当前配置的 upstream 无法处理模型 {}", r.client),
            details: json!({"profileId":r.profile_id,"rejected":[rejected]}),
        });
    }
    Ok(Backend {
        route: text(&p["route"]).into(),
        upstream: u.clone(),
        model: if nonempty(&binding["upstreamModelId"]) {
            text(&binding["upstreamModelId"]).into()
        } else {
            r.client.clone()
        },
        capabilities: caps,
    })
}
pub fn models(config: &Value, provider: &Value) -> Vec<Value> {
    array(&provider["allowedModels"])
        .iter()
        .filter_map(|id| {
            let model = &config["models"][text(id)];
            if model.is_null() {
                return None;
            }
            Some(json!({
                "id": client_model(text(id), model),
                "profileId": id,
                "aliases": array(&model["aliases"]),
                "family": model.get("family").unwrap_or(&json!("unknown")),
                "capabilities": array(&model["capabilities"]),
                "object": "model",
                "owned_by": "cabletidy"
            }))
        })
        .collect()
}
pub fn rewrite(v: &mut Value, client: &str, upstream: &str, claude: bool) {
    if claude {
        if v["type"] == "message" && v["model"] == upstream {
            v["model"] = json!(client);
        }
        if v["type"] == "message_start" && v["message"]["model"] == upstream {
            v["message"]["model"] = json!(client);
        }
        return;
    }
    if let Some(o) = v.as_object_mut() {
        for (k, v) in o {
            if k == "model" && v == upstream {
                *v = json!(client);
            } else {
                rewrite(v, client, upstream, false);
            }
        }
    } else if let Some(a) = v.as_array_mut() {
        for v in a {
            rewrite(v, client, upstream, false);
        }
    }
}
