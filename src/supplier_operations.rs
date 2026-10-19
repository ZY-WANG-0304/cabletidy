use crate::{
    config::{self, array, entries, nonempty, text},
    suppliers,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

pub fn applies(kind: &str) -> bool {
    kind.starts_with("supplier.")
        || [
            "cable.inventory.create",
            "cable.inventory.save",
            "cable.inventory.migrate",
        ]
        .contains(&kind)
}
pub fn apply(current: &Value, op: &Value) -> Result<Value> {
    let mut c = config::normalize(&config::strip_presentation(current));
    let kind = text(&op["type"]);
    let data = &op["data"];
    let mut secrets = json!({});
    let (selection, page) = if kind.starts_with("supplier.") {
        let mut selected_interface = None;
        let generated = format!("s-{}", &uuid::Uuid::new_v4().simple().to_string()[..20]);
        let sid = if kind == "supplier.create" {
            generated.as_str()
        } else {
            text(&op["supplierId"])
        };
        if sid.is_empty() {
            bail!("供应商 ID 不能为空");
        }
        let old = c["suppliers"].get(sid).cloned().unwrap_or(Value::Null);
        match kind {
            "supplier.create" => {
                let mut interfaces = data["interfaces"].clone();
                if interfaces.is_null() && data["interface"].is_object() {
                    let iid = next_interface_id(&json!({}), text(&data["interface"]["protocol"]));
                    interfaces = json!({iid:data["interface"]});
                }
                if !nonempty(&data["name"])
                    || !interfaces.is_object()
                    || entries(&interfaces).next().is_none()
                {
                    bail!("请填写供应商名称并添加至少一个协议接口");
                }
                let models = data.get("models").cloned().unwrap_or(json!({}));
                if !models.is_object() {
                    bail!("模型列表必须是 object");
                }
                let mut prepared = json!({});
                for (iid, row) in entries(&interfaces) {
                    prepared[iid] = prepare_interface(sid, iid, row, &Value::Null, &mut secrets)?;
                }
                selected_interface = entries(&prepared).next().map(|(iid, _)| iid.clone());
                c["suppliers"][sid] = json!({"name":text(&data["name"]).trim(),"enabled":true,"interfaces":prepared,"models":models});
            }
            "supplier.metadata.save" => {
                if !old.is_object() || !nonempty(&data["name"]) {
                    bail!("请填写供应商名称");
                }
                c["suppliers"][sid]["name"] = json!(text(&data["name"]).trim());
                c["suppliers"][sid]["enabled"] =
                    data.get("enabled").cloned().unwrap_or(json!(true));
            }
            "supplier.interface.save" => {
                if !old.is_object() {
                    bail!("供应商不存在");
                }
                let previous_id = text(&data["interfaceId"]);
                let iid = if previous_id.is_empty() {
                    next_interface_id(&old["interfaces"], text(&data["interface"]["protocol"]))
                } else {
                    previous_id.into()
                };
                if !previous_id.is_empty() && old["interfaces"].get(previous_id).is_none() {
                    bail!("接口不存在，请刷新");
                }
                let interface = prepare_interface(
                    sid,
                    &iid,
                    &data["interface"],
                    &old["interfaces"][&iid],
                    &mut secrets,
                )?;
                c["suppliers"][sid]["interfaces"][&iid] = interface;
                selected_interface = Some(iid);
            }
            "supplier.interface.delete" => {
                if !old.is_object() {
                    bail!("供应商不存在");
                }
                let iid = text(&op["interfaceId"]);
                if entries(&old["models"])
                    .any(|(_, m)| array(&m["interfaces"]).contains(&json!(iid)))
                {
                    bail!("接口仍被供应商模型使用，请先修改模型的可访问接口");
                }
                c["suppliers"][sid]["interfaces"]
                    .as_object_mut()
                    .context("接口列表无效")?
                    .remove(iid);
            }
            "supplier.save" => {
                if !data.is_object() || !nonempty(&data["name"]) || !data["interfaces"].is_object()
                {
                    bail!("请填写供应商名称和协议接口");
                }
                let mut supplier = old.clone();
                if !supplier.is_object() {
                    supplier = json!({"models":{}});
                }
                supplier["name"] = data["name"].clone();
                supplier["enabled"] = data.get("enabled").cloned().unwrap_or(json!(true));
                let mut interfaces = json!({});
                for (iid, row) in entries(&data["interfaces"]) {
                    let mut interface = row.clone();
                    if !interface.is_object() {
                        bail!("接口必须是 object");
                    }
                    let uid = suppliers::interface_key(sid, iid);
                    let previous = &old["interfaces"][iid];
                    for field in ["supportsStreaming", "supportsResponseIdContinuation"] {
                        if let Some(value) =
                            previous.get(field).filter(|_| row.get(field).is_none())
                        {
                            interface[field] = value.clone();
                        }
                    }
                    interface["secretRef"] = previous
                        .get("secretRef")
                        .cloned()
                        .unwrap_or(json!(format!("secret://suppliers/{sid}/{iid}")));
                    if nonempty(&row["secret"]) {
                        secrets[&uid] = row["secret"].clone();
                    }
                    interface.as_object_mut().unwrap().remove("secret");
                    interfaces[iid] = interface;
                }
                for (mid, model) in entries(&supplier["models"]) {
                    for iid in array(&model["interfaces"]).iter().filter_map(Value::as_str) {
                        if interfaces.get(iid).is_none() {
                            bail!("接口 {iid} 仍被模型 {mid} 引用，请先修改模型的可访问接口");
                        }
                    }
                }
                supplier["interfaces"] = interfaces;
                c["suppliers"][sid] = supplier;
            }
            "supplier.delete" => {
                if entries(&c["cables"]).any(|(_, b)| array(&b["suppliers"]).contains(&json!(sid)))
                {
                    bail!("请先在 Cable 中解除供应商引用");
                }
                c["suppliers"].as_object_mut().unwrap().remove(sid);
            }
            "supplier.model.save" => {
                if !old.is_object() {
                    bail!("供应商不存在");
                }
                let mid = text(&data["modelId"]).trim();
                if mid.is_empty() || !data["model"].is_object() {
                    bail!("请填写上游模型 ID 和模型事实");
                }
                let previous = text(&data["oldModelId"]);
                if previous != mid && old["models"].get(mid).is_some() {
                    bail!("供应商内上游模型 ID 重复");
                }
                if !previous.is_empty() && old["models"].get(previous).is_none() {
                    bail!("原模型不存在，请刷新");
                }
                // A rename creates a new supply. Cable references are intentionally untouched.
                if previous != mid {
                    c["suppliers"][sid]["models"]
                        .as_object_mut()
                        .unwrap()
                        .remove(previous);
                }
                c["suppliers"][sid]["models"][mid] = data["model"].clone();
            }
            "supplier.model.delete" => {
                if !old.is_object() {
                    bail!("供应商不存在");
                }
                c["suppliers"][sid]["models"]
                    .as_object_mut()
                    .context("模型列表无效")?
                    .remove(text(&op["modelId"]));
            }
            _ => bail!("未知供应商操作"),
        }
        let selection = json!({"supplierId":if kind == "supplier.delete" {Value::Null} else {json!(sid)},"interfaceId":selected_interface});
        let page = if kind == "supplier.delete" {
            "suppliers"
        } else {
            "supplier-detail"
        };
        (selection, page)
    } else {
        let mut id = text(&op["cableId"]).to_owned();
        if kind == "cable.inventory.migrate" {
            let cable = c["cables"].get(&id).context("线路不存在")?.clone();
            if cable["target"] != "codex" {
                bail!("首期迁移仅支持 Codex 线路");
            }
            if cable["managedModels"] == true {
                bail!("线路已使用供应商目录");
            }
            let pid = text(&cable["virtualProvider"]);
            let provider = c["virtualProviders"][pid].clone();
            let backends = array(&c["routes"][text(&provider["route"])]["backends"]);
            if backends.len() != 1 {
                bail!("旧线路上游无效");
            }
            let uid = text(&backends[0]["upstream"]).to_owned();
            let upstream = c["upstreams"][&uid].clone();
            if c["suppliers"].get(&uid).is_some() {
                bail!("同名供应商已存在，请使用显式模型选择重新配置");
            }
            if entries(&provider["models"]).next().is_none() {
                bail!("旧透传线路保留原路径，请新建显式选择的 Cable");
            }
            let mut inventory = json!({});
            let mut bindings = json!({});
            for (name, p) in entries(&provider["models"]) {
                if !nonempty(&p["identity"]) || !nonempty(&p["identitySource"]) {
                    bail!("旧线路未记录实际模型身份依据，不能由客户端名称猜测；保留原路径，请先确认供给事实再新建目录 Cable");
                }
                let mid = p["upstreamModelId"].as_str().unwrap_or(name);
                let facts = json!({"identity":p["identity"],"identitySource":p["identitySource"],"interfaces":["responses"],
                    "capabilities":crate::model::capabilities(p),"inputModalities":p["codex"].get("inputModalities").cloned().unwrap_or(json!(["text"])),
                    "contextWindow":p["contextWindow"],"reasoning":p["reasoning"],
                    "interfaceCapabilities":{"responses":{"toolForms":p.get("toolForms").cloned().unwrap_or(json!([]))}}});
                if inventory.get(mid).is_some_and(|old| old != &facts) {
                    bail!("同一上游模型 ID 的旧能力不同，请先人工确认供给事实");
                }
                inventory[mid] = facts;
                bindings[name] = json!({"sources":[{"supplierId":uid,"modelId":mid,"interfaceId":"responses"}],"aliases":p.get("aliases").cloned().unwrap_or(json!([])),"promptStrategy":"default"});
            }
            c["suppliers"][&uid] = json!({"name":upstream["name"],"interfaces":{"responses":upstream},"models":inventory});
            c["cables"][&id]["suppliers"] = json!([uid]);
            c["cables"][&id]["models"] = bindings;
            c["cables"][&id]["managedModels"] = json!(true);
            c["cables"][&id]["legacyPassthrough"] = json!({"upstream":uid});
        } else {
            if !data.is_object() || !data["models"].is_object() || !data["suppliers"].is_array() {
                bail!("请填写 Cable 名称、供应商选择及模型绑定");
            }
            if kind == "cable.inventory.create" {
                id = config::configuration_id(text(&data["name"]), "codex-main");
                if c["cables"].get(&id).is_some() {
                    bail!("线路名称已存在");
                }
                c["cables"][&id] = json!({"id":id,"name":data["name"],"target":"codex","targetFormat":"codex.config.toml.v1","virtualProvider":format!("cabletidy_{id}"),"codex":{},"managedModels":true});
            } else if c["cables"][&id]["managedModels"] != true {
                bail!("请先迁移该线路到供应商模型目录");
            }
            c["cables"][&id]["suppliers"] = data["suppliers"].clone();
            c["cables"][&id]["models"] = data["models"].clone();
            if nonempty(&data["defaultModel"]) {
                c["cables"][&id]["defaultModel"] = data["defaultModel"].clone();
            } else {
                c["cables"][&id]
                    .as_object_mut()
                    .unwrap()
                    .remove("defaultModel");
            }
        }
        (json!({"cableId":id}), "cable-detail")
    };
    c = config::normalize(&c);
    Ok(json!({"config":c,"upstreamSecrets":secrets,"selection":selection,"page":page}))
}

fn next_interface_id(interfaces: &Value, protocol: &str) -> String {
    let base = match protocol {
        "openai.responses" => "responses",
        "openai.chat_completions" => "chat",
        "anthropic.messages" => "messages",
        "gemini.generate_content" => "gemini",
        _ => "interface",
    };
    let mut id = base.to_owned();
    let mut n = 2;
    while interfaces.get(&id).is_some() {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

fn prepare_interface(
    sid: &str,
    iid: &str,
    data: &Value,
    previous: &Value,
    secrets: &mut Value,
) -> Result<Value> {
    if !data.is_object() || !nonempty(&data["baseUrl"]) {
        bail!("请填写协议和接口地址");
    }
    let mut interface = previous
        .as_object()
        .map(|_| previous.clone())
        .unwrap_or(json!({}));
    for key in [
        "name",
        "protocol",
        "baseUrl",
        "enabled",
        "supportsStreaming",
        "supportsResponseIdContinuation",
    ] {
        if let Some(value) = data.get(key) {
            interface[key] = value.clone();
        }
    }
    let method = text(&data["authMethod"]);
    if method == "existing" {
        if !previous.is_object() || data["protocol"] != previous["protocol"] {
            bail!("现有认证只能用于原接口协议");
        }
    } else {
        interface["auth"] = suppliers::authentication(text(&data["protocol"]), method)?;
    }
    interface["secretRef"] = previous
        .get("secretRef")
        .cloned()
        .unwrap_or(json!(format!("secret://suppliers/{sid}/{iid}")));
    if nonempty(&data["secret"]) && method != "none" {
        secrets[suppliers::interface_key(sid, iid)] = json!(text(&data["secret"]).trim());
    }
    Ok(interface)
}
