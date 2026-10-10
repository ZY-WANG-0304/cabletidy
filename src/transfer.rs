//! Portable configuration suites. Project the schema rather than copying arbitrary fields.
use crate::config::{self, array, entries, text};
use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

fn fields(v: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|k| {
                v.get(*k)
                    .filter(|v| {
                        !v.is_object()
                            && (!v.is_array()
                                || array(v)
                                    .iter()
                                    .all(|item| !item.is_object() && !item.is_array()))
                    })
                    .map(|v| ((*k).into(), v.clone()))
            })
            .collect(),
    )
}
fn connection_url(v: &Value) -> Result<Value> {
    let mut url = url::Url::parse(text(v)).context("上游地址不是有效 URL")?;
    let _ = url.set_username("");
    let _ = url.set_password(None);
    // Query strings and fragments can carry arbitrary authentication credentials.
    url.set_query(None);
    url.set_fragment(None);
    Ok(json!(url.as_str()))
}
fn portable(c: &Value) -> Result<Value> {
    let mut out =
        json!({"version":2,"upstreams":{},"routes":{},"virtualProviders":{},"bindings":{}});
    for (id, u) in entries(&c["upstreams"]) {
        let mut u2 = fields(
            u,
            &[
                "id",
                "name",
                "protocol",
                "integration",
                "enabled",
                "authHeader",
            ],
        );
        u2["baseUrl"] = connection_url(&u["baseUrl"])?;
        if let Some(auth) = u.get("auth") {
            u2["auth"] = fields(auth, &["header", "scheme"]);
        }
        out["upstreams"][id] = u2;
    }
    for (id, r) in entries(&c["routes"]) {
        let mut r2 = fields(r, &["id", "name", "enabled"]);
        r2["backends"] = Value::Array(
            array(&r["backends"])
                .iter()
                .map(|b| fields(b, &["upstream", "enabled"]))
                .collect(),
        );
        out["routes"][id] = r2;
    }
    for (id, p) in entries(&c["virtualProviders"]) {
        let mut p2 = fields(
            p,
            &[
                "id",
                "name",
                "ingressProtocol",
                "route",
                "defaultModel",
                "enabled",
                "capabilities",
            ],
        );
        let mut models = Map::new();
        for (name, m) in entries(&p["models"]) {
            let mut m2 = fields(
                m,
                &[
                    "description",
                    "family",
                    "aliases",
                    "upstreamModelId",
                    "capabilities",
                    "capabilityOverrides",
                    "contextWindow",
                ],
            );
            if let Some(codex) = m.get("codex") {
                m2["codex"] = fields(codex, &["metadataMode", "inputModalities"]);
            }
            if let Some(compact) = m.get("compact") {
                m2["compact"] = fields(compact, &["strategy", "tokenLimit"]);
            }
            models.insert(name.clone(), m2);
        }
        p2["models"] = Value::Object(models);
        out["virtualProviders"][id] = p2;
    }
    for (id, b) in entries(&c["bindings"]) {
        let mut b2 = fields(
            b,
            &[
                "id",
                "name",
                "target",
                "integration",
                "targetFormat",
                "mode",
                "virtualProvider",
                "defaultModel",
                "enabled",
            ],
        );
        if b.get("codex").is_some() {
            b2["codex"] = json!({});
        }
        if let Some(claude) = b.get("claude") {
            b2["claude"] = fields(claude, &["setModel", "discoverModels"]);
            if let Some(models) = claude.get("models") {
                b2["claude"]["models"] =
                    fields(models, &["opus", "sonnet", "fable", "haiku", "subagent"]);
            }
        }
        if let Some(env) = b.get("env") {
            b2["env"] = fields(env, &["prefix"]);
        }
        out["bindings"][id] = b2;
    }
    Ok(out)
}

pub fn export(c: &Value, ids: &Value, secrets: &Value) -> Result<Value> {
    let ids = ids.as_array().context("请选择要导出的配置套装")?;
    if ids.is_empty() {
        bail!("请至少选择一套配置");
    }
    let mut subset =
        json!({"version":2,"upstreams":{},"routes":{},"virtualProviders":{},"bindings":{}});
    for id in ids {
        let id = id.as_str().context("配置 ID 必须是字符串")?;
        let b = &c["bindings"][id];
        if !b.is_object() {
            bail!("所选配置不存在，请刷新列表");
        }
        let pid = text(&b["virtualProvider"]);
        let p = &c["virtualProviders"][pid];
        let rid = text(&p["route"]);
        let r = &c["routes"][rid];
        if !p.is_object() || !r.is_object() {
            bail!("配置依赖不完整");
        }
        subset["bindings"][id] = b.clone();
        subset["virtualProviders"][pid] = p.clone();
        subset["routes"][rid] = r.clone();
        for backend in array(&r["backends"]) {
            let uid = text(&backend["upstream"]);
            if !c["upstreams"][uid].is_object() {
                bail!("上游连接不存在");
            }
            subset["upstreams"][uid] = c["upstreams"][uid].clone();
        }
    }
    let data = portable(&subset)?;
    // Do not leak a known credential pasted into a display name or model setting.
    let serialized = serde_json::to_string(&data)?;
    for (_, secret) in entries(secrets) {
        let encoded = serde_json::to_string(text(secret))?;
        if !text(secret).is_empty() && serialized.contains(&encoded[1..encoded.len() - 1]) {
            bail!("配置内容含认证凭据，请先移除名称、地址或模型设置中的凭据再导出");
        }
    }
    Ok(json!({"format":"cabletidy.configuration-suites","version":1,"config":data}))
}

fn unique_id(id: &str, used: &mut HashSet<String>) -> String {
    let mut next = id.to_owned();
    let mut n = 2;
    while used.contains(&next) {
        next = format!("{}-{n}", &id[..id.len().min(48)]);
        n += 1;
    }
    used.insert(next.clone());
    next
}

pub fn import(
    current: &Value,
    bundle: &Value,
    choices: &Value,
    preview: bool,
) -> Result<(Value, Value)> {
    if bundle["format"] != "cabletidy.configuration-suites"
        || bundle["version"] != 1
        || bundle["config"]["version"] != 2
    {
        bail!("不支持的配置套装文件或版本");
    }
    let raw = &bundle["config"];
    for key in ["bindings", "virtualProviders", "routes", "upstreams"] {
        if !raw[key].is_object() || entries(&raw[key]).any(|(_, v)| !v.is_object()) {
            bail!("配置套装结构不合法");
        }
    }
    if entries(&raw["bindings"]).next().is_none() {
        bail!("配置套装文件为空");
    }
    // Validate before projection: malformed references must never disappear during normalization.
    let mut validation_input = json!({"version":2});
    for key in ["bindings", "virtualProviders", "routes", "upstreams"] {
        validation_input[key] = raw[key].clone();
    }
    let check = crate::validation::validate(&validation_input);
    if check["ok"] != true {
        bail!("配置套装校验失败: {}", check["errors"]);
    }
    let source = portable(&config::normalize(raw))?;
    if !choices.is_null() && !choices.is_object() {
        bail!("同名配置处理选项必须是 object");
    }
    for (id, choice) in entries(choices) {
        if source["bindings"].get(id).is_none() || !["update", "create"].contains(&text(choice)) {
            bail!("同名配置处理选项不合法");
        }
    }
    let mut result = current.clone();
    let mut upstream_ids: HashMap<(String, String), String> = HashMap::new();
    let mut route_ids: HashMap<(String, String), String> = HashMap::new();
    let mut used_upstreams = entries(&current["upstreams"])
        .map(|(k, _)| k.clone())
        .collect();
    let mut used_routes = entries(&current["routes"])
        .map(|(k, _)| k.clone())
        .collect();
    let mut used_suites: HashSet<_> = entries(&current["bindings"])
        .map(|(k, _)| k.clone())
        .chain(
            entries(&current["virtualProviders"])
                .map(|(k, _)| k.strip_prefix("cabletidy_").unwrap_or(k).to_owned()),
        )
        .collect();
    let mut summaries = Vec::new();
    let mut replaced_providers = HashSet::new();
    let mut replaced_routes = HashSet::new();
    let mut replaced_upstreams = HashSet::new();
    // Share imported dependencies only when their retained credential references agree.
    for (old_id, b) in entries(&source["bindings"]) {
        let base_name = b["name"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(old_id);
        let mut name = base_name.to_owned();
        let mut id = config::configuration_id(&name, old_id);
        let existing = current["bindings"].get(&id);
        let conflict = existing.is_some();
        let choice = text(&choices[old_id]);
        if conflict && choice.is_empty() && !preview {
            bail!("请选择同名配置的处理方式：更新已有配置或创建新配置");
        }
        if !conflict && choice == "update" {
            bail!("没有可更新的同名配置，请重新预览");
        }
        let update = conflict && choice == "update";
        let mut retained_secret_ref = String::new();
        if update {
            let old_pid = text(&existing.unwrap()["virtualProvider"]);
            replaced_providers.insert(old_pid.to_owned());
            let old_rid = text(&current["virtualProviders"][old_pid]["route"]);
            replaced_routes.insert(old_rid.to_owned());
            for backend in array(&current["routes"][old_rid]["backends"]) {
                let uid = text(&backend["upstream"]);
                replaced_upstreams.insert(uid.to_owned());
                retained_secret_ref = text(&current["upstreams"][uid]["secretRef"]).to_owned();
            }
        }
        let mut n = 2;
        while !update && used_suites.contains(&id) {
            name = format!(
                "{} (import {n})",
                base_name.chars().take(36).collect::<String>()
            );
            id = config::configuration_id(&name, old_id);
            n += 1;
        }
        used_suites.insert(id.clone());
        let pid = format!("cabletidy_{id}");
        let mut p = source["virtualProviders"][text(&b["virtualProvider"])].clone();
        let old_rid = text(&p["route"]);
        let route_key = (old_rid.to_owned(), retained_secret_ref.clone());
        let rid = if let Some(id) = route_ids.get(&route_key) {
            id.clone()
        } else {
            let rid = unique_id(old_rid, &mut used_routes);
            let mut r = source["routes"][old_rid].clone();
            for backend in r["backends"].as_array_mut().context("路由结构不合法")? {
                let old_uid = text(&backend["upstream"]);
                let upstream_key = (old_uid.to_owned(), retained_secret_ref.clone());
                let uid = if let Some(id) = upstream_ids.get(&upstream_key) {
                    id.clone()
                } else {
                    let uid = unique_id(old_uid, &mut used_upstreams);
                    let mut u = source["upstreams"][old_uid].clone();
                    u["id"] = json!(uid);
                    u["secretRef"] = json!(if retained_secret_ref.is_empty() {
                        format!("secret://imports/{}", uuid::Uuid::new_v4())
                    } else {
                        retained_secret_ref.clone()
                    });
                    result["upstreams"][&uid] = u;
                    upstream_ids.insert(upstream_key, uid.clone());
                    uid
                };
                backend["upstream"] = json!(uid);
            }
            r["id"] = json!(rid);
            result["routes"][&rid] = r;
            route_ids.insert(route_key, rid.clone());
            rid
        };
        p["id"] = json!(pid);
        p["route"] = json!(rid);
        result["virtualProviders"][&pid] = p;
        let mut b = b.clone();
        b["id"] = json!(id);
        b["name"] = json!(name);
        b["virtualProvider"] = json!(pid);
        summaries.push(json!({"id":id,"name":name,"target":b["target"],"sourceId":old_id,"sourceName":base_name,"conflict":conflict,"existingName":existing.map(|b| b["name"].as_str().unwrap_or(old_id)),"action":if update {"update"} else {"create"}}));
        result["bindings"][&id] = b;
    }
    // Remove only superseded dependencies; shared connections retain their own credentials.
    for pid in replaced_providers {
        if !entries(&result["bindings"]).any(|(_, b)| b["virtualProvider"] == pid) {
            result["virtualProviders"]
                .as_object_mut()
                .unwrap()
                .remove(&pid);
        }
    }
    for rid in replaced_routes {
        if !entries(&result["virtualProviders"]).any(|(_, p)| p["route"] == rid) {
            result["routes"].as_object_mut().unwrap().remove(&rid);
        }
    }
    for uid in replaced_upstreams {
        if !entries(&result["routes"])
            .any(|(_, r)| array(&r["backends"]).iter().any(|b| b["upstream"] == uid))
        {
            result["upstreams"].as_object_mut().unwrap().remove(&uid);
        }
    }
    Ok((result, json!(summaries)))
}
