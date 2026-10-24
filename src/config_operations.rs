//! Configuration edits expressed as domain operations, independent of browser forms.
use crate::{
    catalog::{self, Catalog},
    config::{self, array, entries, text},
    targets::claude,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

fn trimmed(v: &Value) -> &str {
    text(v).trim()
}
fn set_optional(value: &mut Value, key: &str, input: &Value) {
    if input.is_null() || input == "" {
        value.as_object_mut().unwrap().remove(key);
    } else {
        value[key] = input.clone();
    }
}
fn list(v: &Value) -> Value {
    if v.is_array() {
        return v.clone();
    }
    json!(text(v)
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>())
}
fn unique(record: &Value, base: &str) -> String {
    let mut id = base.to_owned();
    let mut n = 2;
    while record.get(&id).is_some() {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}
fn choice(value: &Value, ids: &Value, aliases: &[&str]) -> Value {
    let name = trimmed(value);
    if !name.is_empty() && (aliases.contains(&name) || ids.get(name).is_some()) {
        json!(name)
    } else {
        Value::Null
    }
}
fn claude_selections(cable: &mut Value, provider: &mut Value, data: &Value) -> Result<()> {
    let ids = &provider["models"];
    let default = choice(&data["defaultModel"], ids, claude::DEFAULT_MODEL_ALIASES);
    let mut models = Map::new();
    for family in claude::MODEL_FAMILIES {
        let value = data.get(*family);
        let previous = &cable["claude"]["models"][*family];
        if value.is_none() && !text(previous).is_empty() && ids.get(text(previous)).is_none() {
            bail!("{family} 别名指向未配置的模型，请重新选择");
        }
        let name = value.map(trimmed).unwrap_or("");
        if !name.is_empty() {
            if ids.get(name).is_none() {
                bail!("{family} 别名请选择当前线路中已保存的客户端模型 ID");
            }
            models.insert((*family).into(), json!(name));
        }
    }
    let subagent = choice(&data["subagent"], ids, claude::SUBAGENT_MODEL_ALIASES);
    if !subagent.is_null() {
        models.insert("subagent".into(), subagent);
    }
    set_optional(cable, "defaultModel", &default);
    set_optional(provider, "defaultModel", &default);
    if !cable["claude"].is_object() {
        cable["claude"] = json!({});
    }
    cable["claude"]["setModel"] = json!(!default.is_null());
    cable["claude"]["models"] = Value::Object(models);
    cable["claude"]["discoverModels"] = json!(data["discoverModels"] == true);
    Ok(())
}
fn sync_selections(
    cable: &mut Value,
    provider: &mut Value,
    renames: &HashMap<String, String>,
    next: &Value,
) {
    let is_claude = cable["target"] == "claude-code";
    let sync = |value: &Value, aliases: &[&str]| -> Value {
        let name = text(value);
        if aliases.contains(&name) {
            return value.clone();
        }
        if let Some(new) = renames.get(name) {
            return json!(new);
        }
        if next.get(name).is_some() {
            return value.clone();
        }
        if is_claude || provider["models"].get(name).is_some() {
            Value::Null
        } else {
            value.clone()
        }
    };
    let (cdefault, pdefault) = if is_claude {
        let old = if cable["claude"]["setModel"] == false {
            &Value::Null
        } else {
            cable
                .get("defaultModel")
                .or_else(|| provider.get("defaultModel"))
                .unwrap_or(&Value::Null)
        };
        let d = sync(old, claude::DEFAULT_MODEL_ALIASES);
        (d.clone(), d)
    } else {
        (
            sync(&cable["defaultModel"], &[]),
            sync(&provider["defaultModel"], &[]),
        )
    };
    if is_claude && cable["claude"].is_object() {
        let selections: Vec<_> = entries(&cable["claude"]["models"])
            .map(|(key, value)| {
                (
                    key.clone(),
                    sync(
                        value,
                        if key == "subagent" {
                            claude::SUBAGENT_MODEL_ALIASES
                        } else {
                            &[]
                        },
                    ),
                )
            })
            .collect();
        for (key, value) in selections {
            set_optional(&mut cable["claude"]["models"], &key, &value);
        }
        cable["claude"]["setModel"] = json!(!cdefault.is_null());
    }
    set_optional(cable, "defaultModel", &cdefault);
    set_optional(provider, "defaultModel", &pdefault);
}

pub async fn apply(current: &Value, operation: &Value, catalog: &Catalog) -> Result<Value> {
    if !operation.is_object() || !operation["type"].is_string() {
        bail!("配置操作必须包含 type");
    }
    let mut c = config::strip_presentation(current);
    let kind = text(&operation["type"]);
    if crate::supplier_operations::applies(kind) {
        return crate::supplier_operations::apply(current, operation);
    }
    let data = &operation["data"];
    if matches!(
        kind,
        "cable.create" | "cable.upstream" | "cable.protection" | "model.save" | "claude.save"
    ) && !data.is_object()
    {
        bail!("配置操作 data 必须是 object");
    }
    if matches!(kind, "cable.create" | "models.replace") && !operation["models"].is_array() {
        bail!("配置操作 models 必须是 array");
    }
    for key in ["upstreams", "routes", "virtualProviders", "cables"] {
        if !c[key].is_object() {
            bail!("配置 {key} 必须是 object");
        }
    }
    let mut id = text(&operation["cableId"]).to_owned();
    let mut secrets = json!({});
    if kind == "cable.create" {
        let target = data["target"].as_str().unwrap_or("codex");
        if !["codex", "claude-code"].contains(&target) {
            bail!("请选择 Codex 或 Claude Code");
        }
        let is_claude = target == "claude-code";
        let base = trimmed(&data["upstreamBaseUrl"]);
        let secret = trimmed(&data["upstreamSecret"]);
        if base.is_empty() || secret.is_empty() {
            bail!("请填写上游地址和上游 API Key");
        }
        let uid = unique(&c["upstreams"], "relay-main");
        let rid = unique(&c["routes"], &format!("{uid}-route"));
        let fallback = unique(
            &c["cables"],
            if is_claude {
                "claude-main"
            } else {
                "codex-main"
            },
        );
        let upstream_name = url::Url::parse(base)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or(uid.clone());
        let name = if trimmed(&data["cableName"]).is_empty() {
            format!(
                "{} / {upstream_name}",
                if is_claude { "Claude Code" } else { "Codex" }
            )
        } else {
            trimmed(&data["cableName"]).to_owned()
        };
        id = config::configuration_id(&name, &fallback);
        let pid = format!("cabletidy_{id}");
        if c["cables"].get(&id).is_some() || c["virtualProviders"].get(&pid).is_some() {
            bail!("线路名称对应的 ID 已存在: {id}，请使用不同的线路名称");
        }
        let mut models = json!({});
        for row in array(&operation["models"]) {
            let name = trimmed(&row["clientModelId"]);
            if name.is_empty() {
                bail!("添加模型设置时请选择客户端模型");
            }
            if models.get(name).is_some() {
                bail!("客户端模型 ID 不能重复");
            }
            let mut profile = json!({"family":if is_claude {"claude"} else {"codex"}});
            if !is_claude {
                catalog::configure_model(&mut profile, name, &json!({}), catalog).await?;
            }
            if !trimmed(&row["upstreamModelId"]).is_empty() {
                profile["upstreamModelId"] = json!(trimmed(&row["upstreamModelId"]));
            }
            models[name] = profile;
        }
        let protocol = if is_claude {
            "anthropic.messages"
        } else {
            "openai.responses"
        };
        c["upstreams"][&uid] = json!({"id":uid,"name":upstream_name,"protocol":protocol,"baseUrl":base,"secretRef":format!("secret://upstreams/{uid}"),"enabled":true});
        if is_claude {
            c["upstreams"][&uid]["auth"] =
                json!({"header":data["upstreamAuth"].as_str().unwrap_or("x-api-key")});
        } else {
            c["upstreams"][&uid]["integration"] = json!("codex-native-provider");
        }
        c["routes"][&rid] = json!({"id":rid,"name":format!("{upstream_name} route"),"backends":[{"upstream":uid,"enabled":true}]});
        let mut provider = json!({"id":pid,"name":format!("{} via {upstream_name}",if is_claude {"Claude Code"} else {"Codex"}),"ingressProtocol":protocol,"route":rid,"models":models,"enabled":true});
        let mut cable = json!({"id":id,"name":name,"target":target,"targetFormat":if is_claude {"claude.settings.json.v1"} else {"codex.config.toml.v1"},"mode":"config","virtualProvider":pid});
        if is_claude {
            cable["claude"] = json!({});
            claude_selections(&mut cable, &mut provider, data)?;
            cable["claude"]
                .as_object_mut()
                .unwrap()
                .remove("discoverModels");
            if cable["claude"]["setModel"] == false {
                cable["claude"].as_object_mut().unwrap().remove("setModel");
            }
            if cable["claude"]["models"]
                .as_object()
                .is_some_and(Map::is_empty)
            {
                cable["claude"].as_object_mut().unwrap().remove("models");
            }
        } else {
            cable["codex"] = json!({});
            cable["integration"] = json!("codex-native-provider");
        }
        c["cables"][&id] = cable;
        c["virtualProviders"][&pid] = provider;
        secrets[&uid] = json!(secret);
    } else {
        let mut cable = c["cables"]
            .get(&id)
            .filter(|v| v.is_object())
            .context("线路不存在，请刷新列表。")?
            .clone();
        let pid = text(&cable["virtualProvider"]).to_owned();
        let mut provider = c["virtualProviders"]
            .get(&pid)
            .filter(|v| v.is_object())
            .context("Virtual Provider 不存在")?
            .clone();
        match kind {
            "cable.protection" => match data["enabled"].as_bool() {
                Some(value) => provider["credentialProtection"] = json!(value),
                None if data["enabled"].is_null() => {
                    provider
                        .as_object_mut()
                        .unwrap()
                        .remove("credentialProtection");
                }
                None => bail!("凭据保护开关必须是布尔值，或 null（沿用全局设置）"),
            },
            "cable.delete" => {
                c["cables"].as_object_mut().unwrap().remove(&id);
                let rid = text(&provider["route"]).to_owned();
                if !entries(&c["cables"]).any(|(_, b)| b["virtualProvider"] == pid) {
                    c["virtualProviders"].as_object_mut().unwrap().remove(&pid);
                    if !entries(&c["virtualProviders"]).any(|(_, p)| p["route"] == rid) {
                        let upstreams: Vec<_> = array(&c["routes"][&rid]["backends"])
                            .iter()
                            .map(|b| text(&b["upstream"]).to_owned())
                            .collect();
                        c["routes"].as_object_mut().unwrap().remove(&rid);
                        for uid in upstreams
                            .into_iter()
                            .filter(|_| cable["managedModels"] != true)
                        {
                            if !entries(&c["routes"]).any(|(_, r)| {
                                array(&r["backends"]).iter().any(|b| b["upstream"] == uid)
                            }) {
                                c["upstreams"].as_object_mut().unwrap().remove(&uid);
                            }
                        }
                    }
                }
            }
            "cable.upstream" => {
                let rid = text(&provider["route"]);
                let backends = array(&c["routes"][rid]["backends"]);
                if backends.len() != 1 {
                    bail!("当前线路没有可用的上游");
                }
                let uid = text(&backends[0]["upstream"]).to_owned();
                if data["id"] != uid {
                    bail!("上游已变更，请刷新后重试");
                }
                let mut upstream = c["upstreams"][&uid].clone();
                if !upstream.is_object() {
                    bail!("上游不存在");
                }
                upstream["name"] = json!(data["name"].as_str().unwrap_or(&uid).trim());
                upstream["protocol"] = data["protocol"].clone();
                upstream["baseUrl"] = json!(trimmed(&data["baseUrl"]));
                if trimmed(&upstream["secretRef"]).is_empty() {
                    upstream["secretRef"] = json!(format!("secret://upstreams/{uid}"));
                }
                if data["protocol"] == "openai.responses" {
                    upstream["integration"] = json!("codex-native-provider");
                } else {
                    upstream.as_object_mut().unwrap().remove("integration");
                }
                if data["protocol"] == "anthropic.messages" && !text(&data["authHeader"]).is_empty()
                {
                    let header = text(&data["authHeader"]);
                    let previous = upstream["auth"]["header"]
                        .as_str()
                        .or_else(|| upstream["authHeader"].as_str())
                        .unwrap_or("x-api-key");
                    if header != previous {
                        upstream["auth"] = json!({"header":header});
                        if header == "authorization" {
                            upstream["auth"]["scheme"] = json!("Bearer");
                        }
                        upstream.as_object_mut().unwrap().remove("authHeader");
                    }
                }
                if !trimmed(&data["secret"]).is_empty() {
                    secrets[&uid] = json!(trimmed(&data["secret"]));
                }
                c["upstreams"][uid] = upstream;
            }
            "models.replace" | "model.save" | "model.delete" => {
                let mut next = if kind == "models.replace" {
                    json!({})
                } else {
                    provider["models"]
                        .as_object()
                        .map(|m| Value::Object(m.clone()))
                        .unwrap_or(json!({}))
                };
                let mut renames = HashMap::new();
                let mut old_ids = HashSet::new();
                if kind == "model.delete" {
                    next.as_object_mut()
                        .unwrap()
                        .remove(text(&operation["modelId"]));
                } else {
                    let rows = if kind == "model.save" {
                        vec![data]
                    } else {
                        array(&operation["models"]).iter().collect()
                    };
                    for row in rows {
                        let name = trimmed(&row["clientModelId"]);
                        let old = text(&row["oldId"]);
                        if name.is_empty() {
                            bail!("每个模型都必须填写客户端模型 ID");
                        }
                        if !old.is_empty() && !old_ids.insert(old) {
                            bail!("重复的原模型 ID");
                        }
                        if !old.is_empty() && provider["models"].get(old).is_none() {
                            bail!("原模型不存在，请刷新后重试: {old}");
                        }
                        if next.get(name).is_some() && (kind == "models.replace" || name != old) {
                            bail!("客户端模型 ID 不能重复");
                        }
                        let existing = provider["models"].get(old).cloned().unwrap_or(json!({}));
                        if !existing.is_object() {
                            bail!("原模型设置必须是 object");
                        }
                        let mut profile = existing.clone();
                        if kind == "model.save" {
                            next.as_object_mut().unwrap().remove(old);
                            for field in ["aliases", "capabilities", "capabilityOverrides"] {
                                profile[field] = list(&row[field]);
                            }
                            profile["family"] =
                                json!(row["family"].as_str().unwrap_or("codex").trim());
                        } else {
                            if let Some(aliases) = row.get("aliases") {
                                profile["aliases"] = list(aliases);
                            }
                            if profile.get("family").is_none() {
                                profile["family"] = json!(if cable["target"] == "claude-code" {
                                    "claude"
                                } else {
                                    "codex"
                                });
                            }
                            if cable["target"] == "codex" {
                                catalog::configure_model(
                                    &mut profile,
                                    name,
                                    &row["policy"],
                                    catalog,
                                )
                                .await?;
                            } else if cable["target"] == "claude-code" {
                                profile.as_object_mut().unwrap().remove("description");
                            } else {
                                let caps = list(&row["capabilities"]);
                                profile["capabilities"] = if array(&caps).is_empty() {
                                    json!(["streaming", "tools", "reasoning"])
                                } else {
                                    caps
                                };
                            }
                            if let Some(overrides) = row.get("capabilityOverrides") {
                                let v = list(overrides);
                                set_optional(
                                    &mut profile,
                                    "capabilityOverrides",
                                    if array(&v).is_empty() {
                                        &Value::Null
                                    } else {
                                        &v
                                    },
                                );
                            }
                        }
                        set_optional(
                            &mut profile,
                            "upstreamModelId",
                            &json!(trimmed(&row["upstreamModelId"])),
                        );
                        next[name] = profile;
                        if !old.is_empty() {
                            renames.insert(old.to_owned(), name.to_owned());
                        }
                    }
                }
                sync_selections(&mut cable, &mut provider, &renames, &next);
                provider["models"] = next;
            }
            "claude.save" => {
                if cable["target"] != "claude-code" {
                    bail!("请选择 Claude Code 配置");
                }
                claude_selections(&mut cable, &mut provider, data)?;
            }
            _ => bail!("未知配置操作: {kind}"),
        }
        if kind != "cable.delete" {
            c["cables"][&id] = cable;
            c["virtualProviders"][&pid] = provider;
        }
    }
    c = config::normalize(&c);
    let selected = if kind == "cable.delete" {
        entries(&c["cables"]).next().map(|(id, _)| id.clone())
    } else {
        Some(id)
    };
    let selection = selected
        .map(|id| json!({"cableId":id,"virtualProviderId":c["cables"][&id]["virtualProvider"]}))
        .unwrap_or(Value::Null);
    Ok(
        json!({"config":c,"upstreamSecrets":secrets,"selection":selection,"page":if kind=="cable.delete" {"overview"} else {"cable-detail"}}),
    )
}
