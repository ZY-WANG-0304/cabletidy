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
fn portable(c: &Value, include_credentials: bool) -> Result<Value> {
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
        u2["baseUrl"] = if include_credentials {
            u["baseUrl"].clone()
        } else {
            connection_url(&u["baseUrl"])?
        };
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

pub fn export(c: &Value, ids: &Value, secrets: &Value, include_credentials: bool) -> Result<Value> {
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
    let data = portable(&subset, include_credentials)?;
    let mut bundle = json!({"format":"cabletidy.configuration-suites","version":1,"config":data});
    if include_credentials {
        let credentials: Map<String, Value> = entries(&subset["upstreams"])
            .filter_map(|(id, upstream)| {
                let secret = config::secret(upstream, secrets);
                (!secret.is_empty()).then(|| (id.clone(), json!(secret)))
            })
            .collect();
        if !credentials.is_empty() {
            bundle["upstreamSecrets"] = Value::Object(credentials);
        }
        return Ok(bundle);
    }
    // Do not leak a known credential pasted into a display name or model setting.
    let serialized = serde_json::to_string(&data)?;
    for (_, secret) in entries(secrets) {
        let encoded = serde_json::to_string(text(secret))?;
        if !text(secret).is_empty() && serialized.contains(&encoded[1..encoded.len() - 1]) {
            bail!("配置内容含认证凭据，请先移除名称、地址或模型设置中的凭据再导出");
        }
    }
    Ok(bundle)
}

pub fn has_credentials(bundle: &Value) -> bool {
    entries(&bundle["upstreamSecrets"]).any(|(_, value)| config::nonempty(value))
        || entries(&bundle["config"]["upstreams"]).any(|(_, upstream)| {
            url::Url::parse(text(&upstream["baseUrl"])).is_ok_and(|url| {
                !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
            })
        })
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
    use_credentials: bool,
) -> Result<(Value, Value, Value)> {
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
    if let Some(credentials) = bundle.get("upstreamSecrets") {
        if !credentials.is_object()
            || entries(credentials)
                .any(|(id, value)| raw["upstreams"].get(id).is_none() || !config::nonempty(value))
        {
            bail!("配置套装认证凭据格式不合法");
        }
    }
    let source = portable(&config::normalize(raw), use_credentials)?;
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
    let mut imported_secrets = json!({});
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
        // Lowercasing Unicode can expand the slug; reserve space after normalization.
        let mut name_prefix = base_name.to_owned();
        while config::configuration_id(&name_prefix, old_id).len() > 36 {
            if name_prefix.pop().is_none() {
                name_prefix = config::configuration_id(base_name, old_id)[..36].to_owned();
                break;
            }
        }
        while !update && used_suites.contains(&id) {
            name = format!("{name_prefix} (import {n})");
            id = config::configuration_id(&name, old_id);
            n += 1;
        }
        used_suites.insert(id.clone());
        let pid = format!("cabletidy_{id}");
        let mut p = source["virtualProviders"][text(&b["virtualProvider"])].clone();
        let old_rid = text(&p["route"]);
        // File credentials use new references so updating cannot overwrite a shared local secret.
        let credential_group = if use_credentials
            && config::nonempty(
                &bundle["upstreamSecrets"]
                    [text(&source["routes"][old_rid]["backends"][0]["upstream"])],
            ) {
            String::new()
        } else {
            retained_secret_ref.clone()
        };
        let route_key = (old_rid.to_owned(), credential_group.clone());
        let rid = if let Some(id) = route_ids.get(&route_key) {
            id.clone()
        } else {
            let rid = unique_id(old_rid, &mut used_routes);
            let mut r = source["routes"][old_rid].clone();
            for backend in r["backends"].as_array_mut().context("路由结构不合法")? {
                let old_uid = text(&backend["upstream"]);
                let file_secret = &bundle["upstreamSecrets"][old_uid];
                let use_file_secret = use_credentials && config::nonempty(file_secret);
                let upstream_key = (old_uid.to_owned(), credential_group.clone());
                let uid = if let Some(id) = upstream_ids.get(&upstream_key) {
                    id.clone()
                } else {
                    let uid = unique_id(old_uid, &mut used_upstreams);
                    let mut u = source["upstreams"][old_uid].clone();
                    u["id"] = json!(uid);
                    u["secretRef"] = json!(if use_file_secret || retained_secret_ref.is_empty() {
                        format!("secret://imports/{}", uuid::Uuid::new_v4())
                    } else {
                        retained_secret_ref.clone()
                    });
                    result["upstreams"][&uid] = u;
                    if use_file_secret {
                        imported_secrets[&uid] = file_secret.clone();
                    }
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
    Ok((result, json!(summaries), imported_secrets))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configuration(name: &str) -> Value {
        let id = config::configuration_id(name, "suite");
        let pid = format!("cabletidy_{id}");
        config::normalize(&json!({
            "version":2,
            "upstreams":{"relay":{"protocol":"openai.responses","baseUrl":"https://example.invalid/v1","secretRef":"secret://local"}},
            "routes":{"route":{"backends":[{"upstream":"relay"}]}},
            "virtualProviders":{pid.clone():{"ingressProtocol":"openai.responses","route":"route","models":{}}},
            "bindings":{id:{"name":name,"target":"codex","virtualProvider":pid,"codex":{}}}
        }))
    }

    #[test]
    fn unicode_conflicts_reserve_suffix_space_after_lowercasing() {
        let name = "\u{0130}".repeat(30);
        let c = configuration(&name);
        assert_eq!(crate::validation::validate(&c)["ok"], true);
        let ids = json!(c["bindings"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>());
        let bundle = export(&c, &ids, &json!({}), false).unwrap();
        let (next, suites, _) = import(&c, &bundle, &Value::Null, true, true).unwrap();
        let new_id = text(&suites[0]["id"]);
        assert!(new_id.ends_with("import-2"));
        assert_ne!(new_id, text(&ids[0]));
        assert_eq!(crate::validation::validate(&next)["ok"], true);
        let (next, suites, _) = import(&next, &bundle, &Value::Null, true, true).unwrap();
        assert!(text(&suites[0]["id"]).ends_with("import-3"));
        assert_eq!(crate::validation::validate(&next)["ok"], true);
    }

    #[test]
    fn optional_credentials_export_only_selected_secrets_and_import_with_new_references() {
        let mut c = configuration("Suite");
        c["upstreams"]["relay"]["baseUrl"] =
            json!("https://user:password@example.invalid/v1?key=query-key#secret");
        let secrets = json!({"secret://local":"saved-key","secret://other":"unrelated-key"});
        let default = export(&c, &json!(["suite"]), &secrets, false).unwrap();
        assert!(default.get("upstreamSecrets").is_none());
        assert_eq!(
            default["config"]["upstreams"]["relay"]["baseUrl"],
            "https://example.invalid/v1"
        );
        let bundle = export(&c, &json!(["suite"]), &secrets, true).unwrap();
        assert_eq!(bundle["upstreamSecrets"], json!({"relay":"saved-key"}));
        assert!(!bundle.to_string().contains("unrelated-key"));
        assert!(has_credentials(&bundle));
        for update in [false, true] {
            for use_credentials in [false, true] {
                let choices = json!({"suite":if update {"update"} else {"create"}});
                let (next, suites, payload) =
                    import(&c, &bundle, &choices, false, use_credentials).unwrap();
                let b = &next["bindings"][text(&suites[0]["id"])];
                let p = &next["virtualProviders"][text(&b["virtualProvider"])];
                let uid = text(&next["routes"][text(&p["route"])]["backends"][0]["upstream"]);
                let u = &next["upstreams"][uid];
                if use_credentials {
                    assert_eq!(payload[uid], "saved-key");
                    assert_ne!(u["secretRef"], "secret://local");
                    assert_eq!(u["baseUrl"], c["upstreams"]["relay"]["baseUrl"]);
                } else {
                    assert_eq!(payload, json!({}));
                    assert_eq!(u["baseUrl"], "https://example.invalid/v1");
                    assert_eq!(u["secretRef"] == "secret://local", update);
                }
            }
        }
    }

    #[test]
    fn imported_credentials_are_validated_even_when_ignored() {
        let c = configuration("Suite");
        let mut bundle = export(&c, &json!(["suite"]), &json!({}), false).unwrap();
        for invalid in [
            json!([]),
            json!({"missing":"key"}),
            json!({"relay":123}),
            json!({"relay":""}),
        ] {
            bundle["upstreamSecrets"] = invalid;
            assert!(import(&c, &bundle, &json!({"suite":"create"}), false, false).is_err());
        }
    }

    #[test]
    fn using_file_credentials_does_not_replace_a_shared_local_secret() {
        let mut c = configuration("Suite");
        c["bindings"]["other"] =
            json!({"name":"Other","target":"codex","virtualProvider":"cabletidy_other"});
        c["virtualProviders"]["cabletidy_other"] = c["virtualProviders"]["cabletidy_suite"].clone();
        let local = json!({"secret://local":"local-key"});
        let mut bundle = export(&c, &json!(["suite"]), &local, true).unwrap();
        bundle["upstreamSecrets"]["relay"] = json!("file-key");
        let (mut next, suites, payload) =
            import(&c, &bundle, &json!({"suite":"update"}), false, true).unwrap();
        let applied = config::apply_secrets(&mut next, &local, &json!({"upstreamSecrets":payload}));
        assert_eq!(applied["secret://local"], "local-key");
        assert_eq!(
            config::secret(&next["upstreams"]["relay"], &applied),
            "local-key"
        );
        let provider = &next["virtualProviders"]
            [text(&next["bindings"][text(&suites[0]["id"])]["virtualProvider"])];
        let uid = text(&next["routes"][text(&provider["route"])]["backends"][0]["upstream"]);
        assert_eq!(
            config::secret(&next["upstreams"][uid], &applied),
            "file-key"
        );
        assert_eq!(
            next["virtualProviders"]["cabletidy_other"]["route"],
            "route"
        );
    }
}
