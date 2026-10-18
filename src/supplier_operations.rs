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
    let mut selection = Value::Null;
    let page;
    if kind.starts_with("supplier.") {
        let sid = text(&op["supplierId"]);
        if sid.is_empty() {
            bail!("供应商 ID 不能为空");
        }
        let old = c["suppliers"].get(sid).cloned().unwrap_or(Value::Null);
        match kind {
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
        page = "suppliers";
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
                    "contextWindow":p["contextWindow"],"reasoning":p["reasoning"],"history":p["history"]});
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
        selection = json!({"cableId":id});
        page = "cable-detail";
    }
    c = config::normalize(&c);
    Ok(json!({"config":c,"upstreamSecrets":secrets,"selection":selection,"page":page}))
}
