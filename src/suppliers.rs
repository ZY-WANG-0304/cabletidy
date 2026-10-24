//! Supplier inventory and explicit Cable model bindings. Legacy routes remain a compatibility view.
use crate::config::{array, enabled, entries, nonempty, text};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

pub const COMPATIBLE_MODELS: &[&str] = &[
    "glm-5.3",
    "glm-5.3-flash",
    "kimi-k3",
    "deepseek-v4-pro",
    "deepseek-flash",
    "MiniMax-M3",
];
pub const ADAPTER_VERSION: &str = "codex-responses-v1";

pub fn compatible(identity: &str) -> bool {
    COMPATIBLE_MODELS
        .iter()
        .any(|name| name.eq_ignore_ascii_case(identity))
}
pub fn interface_key(supplier: &str, interface: &str) -> String {
    format!("supplier.{supplier}.{interface}")
}

pub fn authentication(protocol: &str, method: &str) -> Result<Value> {
    let auth = match (protocol, method) {
        (_, "none") if crate::validation::PROTOCOLS.contains(&protocol) => json!({"method":"none"}),
        ("openai.responses" | "openai.chat_completions", "bearer")
        | ("anthropic.messages" | "gemini.generate_content", "bearer") => {
            json!({"method":"bearer","header":"authorization","scheme":"Bearer"})
        }
        ("openai.responses" | "openai.chat_completions", "api-key") => {
            json!({"method":"api-key","header":"api-key","scheme":""})
        }
        ("anthropic.messages", "api-key") => {
            json!({"method":"api-key","header":"x-api-key","scheme":""})
        }
        ("gemini.generate_content", "api-key") => {
            json!({"method":"api-key","header":"x-goog-api-key","scheme":""})
        }
        _ => bail!("该协议不支持所选认证方式"),
    };
    Ok(auth)
}
pub fn managed(p: &Value) -> bool {
    p["managedModels"] == true
}

/// Normalize the old supply fields without inventing tool formats or server state.
fn normalize_supply(c: &mut Value) {
    migrate_reasoning_settings(c);
    for (_, supplier) in c["suppliers"].as_object_mut().into_iter().flatten() {
        if !supplier.is_object() {
            continue;
        }
        for (_, interface) in supplier["interfaces"].as_object_mut().into_iter().flatten() {
            if let Some(i) = interface.as_object_mut() {
                i.entry("supportsStreaming").or_insert(json!(true));
                i.entry("supportsResponseIdContinuation")
                    .or_insert(json!(false));
            }
        }
        for (_, model) in supplier["models"].as_object_mut().into_iter().flatten() {
            if !model.is_object() {
                continue;
            }
            let legacy_streaming = match text(&model["capabilityStates"]["streaming"]) {
                "supported" => Some(json!(true)),
                "unsupported" => Some(json!(false)),
                "unknown" => Some(Value::Null),
                _ => None,
            };
            let ids = array(&model["interfaces"]).to_vec();
            for iid in ids.iter().filter_map(Value::as_str) {
                if model["interfaceCapabilities"].is_null() {
                    model["interfaceCapabilities"] = json!({});
                }
                if !model["interfaceCapabilities"].is_object() {
                    continue;
                }
                if model["interfaceCapabilities"][iid].is_null() {
                    model["interfaceCapabilities"][iid] = json!({});
                }
                let d = &mut model["interfaceCapabilities"][iid];
                if !d.is_object() {
                    continue;
                }
                let streaming = match text(&d["capabilityStates"]["streaming"]) {
                    "supported" => Some(json!(true)),
                    "unsupported" => Some(json!(false)),
                    "unknown" => Some(Value::Null),
                    _ => legacy_streaming.clone(),
                };
                if let Some(value) = streaming {
                    d.as_object_mut()
                        .unwrap()
                        .entry("supportsStreaming")
                        .or_insert(value);
                }
                d.as_object_mut()
                    .unwrap()
                    .entry("toolForms")
                    .or_insert(json!([]));
                remove_legacy_facts(d);
            }
            remove_legacy_facts(model);
        }
    }
}

/// Earlier managed forms stored client defaults among supply facts. Move only those
/// known fields, preserving ambiguous source defaults and obsolete toggles as evidence.
fn migrate_reasoning_settings(c: &mut Value) {
    let mut defaults = std::collections::HashMap::new();
    for (sid, supplier) in c["suppliers"].as_object_mut().into_iter().flatten() {
        for (mid, model) in supplier["models"].as_object_mut().into_iter().flatten() {
            let common = extract_reasoning_settings(model);
            let ids = array(&model["interfaces"]).to_vec();
            for iid in ids.iter().filter_map(Value::as_str) {
                let difference = model["interfaceCapabilities"]
                    .get_mut(iid)
                    .map(extract_reasoning_settings)
                    .unwrap_or(json!({}));
                let mut settings = common.clone();
                for (key, value) in entries(&difference) {
                    settings[key] = value.clone();
                }
                if entries(&settings).next().is_some() {
                    defaults.insert((sid.clone(), mid.clone(), iid.to_owned()),
                        json!({"settings":settings,"uncertain":entries(&difference).next().is_some()}));
                }
            }
        }
    }
    for (_, cable) in c["cables"].as_object_mut().into_iter().flatten() {
        if cable["managedModels"] != true {
            continue;
        }
        for (_, binding) in cable["models"].as_object_mut().into_iter().flatten() {
            let settings: Vec<_> = array(&binding["sources"])
                .iter()
                .map(|source| {
                    defaults
                        .get(&(
                            text(&source["supplierId"]).to_owned(),
                            text(&source["modelId"]).to_owned(),
                            text(&source["interfaceId"]).to_owned(),
                        ))
                        .cloned()
                        .unwrap_or(json!({"settings":{},"uncertain":false}))
                })
                .collect();
            if settings
                .iter()
                .all(|value| entries(&value["settings"]).next().is_none())
            {
                continue;
            }
            if settings.iter().all(|value| value["uncertain"] == false)
                && settings.windows(2).all(|pair| pair[0] == pair[1])
            {
                if let Some(settings) = settings.first() {
                    if binding["reasoning"].is_null() {
                        binding["reasoning"] = json!({});
                    }
                    if let Some(reasoning) = binding["reasoning"].as_object_mut() {
                        for (key, value) in entries(&settings["settings"]) {
                            reasoning.entry(key).or_insert(value.clone());
                        }
                    }
                }
            } else {
                if binding["migration"].is_null() {
                    binding["migration"] = json!({});
                }
                binding["migration"]["sourceReasoningDefaults"] =
                    json!(settings.iter().map(|v| &v["settings"]).collect::<Vec<_>>());
            }
        }
    }
}

pub fn extract_reasoning_settings(facts: &mut Value) -> Value {
    if !facts.is_object() {
        return json!({});
    }
    let mut settings = json!({});
    let mut evidence = json!({});
    if let Some(reasoning) = facts.get_mut("reasoning").and_then(Value::as_object_mut) {
        for old in ["default", "toggle"] {
            if let Some(value) = reasoning.remove(old).filter(|v| !v.is_null()) {
                evidence[old] = value.clone();
                if old == "default" && value != "ultra" {
                    settings["defaultEffort"] = value;
                }
            }
        }
        if let Some(budget) = reasoning.get_mut("budget").and_then(Value::as_object_mut) {
            if let Some(value) = budget.remove("default").filter(|v| !v.is_null()) {
                evidence["budgetDefault"] = value.clone();
                settings["defaultBudget"] = value;
            }
        }
        if let Some(efforts) = reasoning.get_mut("efforts").and_then(Value::as_array_mut) {
            if efforts.contains(&json!("ultra")) {
                evidence["ultra"] = json!(true);
                efforts.retain(|value| value != "ultra");
            }
        }
    }
    if entries(&evidence).next().is_some() {
        if facts["migration"].is_null() {
            facts["migration"] = json!({});
        }
        let mut old = facts["migration"]["reasoning"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        for (key, value) in entries(&evidence) {
            old.insert(key.clone(), value.clone());
        }
        facts["migration"]["reasoning"] = json!(old);
    }
    settings
}

fn remove_legacy_facts(facts: &mut Value) {
    if facts["history"].is_null()
        || ["native", "stateless", "unknown"].contains(&text(&facts["history"]))
    {
        facts.as_object_mut().unwrap().remove("history");
    }
    for cap in ["streaming", "tools"] {
        if ["supported", "unsupported", "unknown"].contains(&text(&facts["capabilityStates"][cap]))
        {
            facts["capabilityStates"]
                .as_object_mut()
                .unwrap()
                .remove(cap);
        }
    }
    if let Some(caps) = facts.get_mut("capabilities").and_then(Value::as_array_mut) {
        caps.retain(|cap| cap != "streaming" && cap != "tools");
    }
}

pub fn source_profile(c: &Value, source: &Value) -> Result<Value> {
    let sid = text(&source["supplierId"]);
    let mid = text(&source["modelId"]);
    let iid = text(&source["interfaceId"]);
    let supplier = &c["suppliers"][sid];
    let model = &supplier["models"][mid];
    if !supplier.is_object() || !model.is_object() {
        bail!("来源不存在: {sid} / {mid}");
    }
    let interface = &supplier["interfaces"][iid];
    if !interface.is_object() || !array(&model["interfaces"]).contains(&json!(iid)) {
        bail!("模型不可通过接口访问: {sid} / {mid} / {iid}");
    }
    let mut boundary_errors = fact_errors(model, "模型公共配置");
    boundary_errors.extend(association_errors(
        model,
        interface,
        &model["interfaceCapabilities"][iid],
        "关联能力",
    ));
    if let Some(error) = boundary_errors.first() {
        bail!(
            "关联配置越界: {}: {}",
            text(&error["path"]),
            text(&error["message"])
        );
    }
    let mut facts = model.clone();
    if let Some(overrides) = model["interfaceCapabilities"].get(iid) {
        for (key, value) in entries(overrides) {
            if (key == "capabilityStates" || key == "reasoning") && facts[key].is_object() {
                for (cap, state) in entries(value) {
                    if key == "reasoning" && cap == "budget" && facts[key][cap].is_object() {
                        for (k, v) in entries(state) {
                            if v.is_null() && ["min", "max", "unit"].contains(&k.as_str()) {
                                continue;
                            }
                            facts[key][cap][k] = v.clone();
                        }
                    } else {
                        facts[key][cap] = state.clone();
                    }
                }
            } else {
                if value.is_null() && ["contextWindow", "maxOutputTokens"].contains(&key.as_str()) {
                    continue;
                }
                facts[key] = value.clone();
            }
        }
    }
    let difference = &model["interfaceCapabilities"][iid];
    let mut caps = declared_capabilities(model);
    if difference["capabilities"].is_array() {
        caps = array(&difference["capabilities"])
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
    }
    for (cap, state) in entries(&difference["capabilityStates"]) {
        if state == "supported" {
            caps.insert(cap.clone());
        } else {
            caps.remove(cap);
        }
    }
    let mut modalities = if difference["inputModalities"].is_array() {
        array(&difference["inputModalities"]).to_vec()
    } else {
        input_types(model)
    };
    if !caps.contains("vision") {
        modalities.retain(|input| input != "image");
    }
    if !modalities.contains(&json!("image")) {
        caps.remove("vision");
    }
    facts["inputModalities"] = json!(modalities);
    caps.remove("streaming");
    caps.remove("tools");
    facts["supportsStreaming"] = model["interfaceCapabilities"][iid]
        .get("supportsStreaming")
        .unwrap_or(&interface["supportsStreaming"])
        .clone();
    if interface["supportsStreaming"] != true {
        facts["supportsStreaming"] = json!(false);
    }
    facts["supportsResponseIdContinuation"] = interface["supportsResponseIdContinuation"].clone();
    if facts["supportsStreaming"] == true {
        caps.insert("streaming".into());
    }
    if !array(&facts["toolForms"]).is_empty() {
        caps.insert("tools".into());
    }
    facts["capabilities"] = json!(caps);
    facts["upstreamModelId"] = json!(mid);
    facts["supplierId"] = json!(sid);
    facts["interfaceId"] = json!(iid);
    facts["interfaceProtocol"] = interface["protocol"].clone();
    facts["upstream"] = json!(interface_key(sid, iid));
    facts["sourceEnabled"] =
        json!(enabled(supplier) && enabled(interface) && enabled(model) && enabled(source));
    for key in ["contextWindow", "maxOutputTokens"] {
        if facts[key].is_null() {
            facts.as_object_mut().unwrap().remove(key);
        }
    }
    Ok(facts)
}

fn declared_capabilities(facts: &Value) -> std::collections::BTreeSet<String> {
    let mut caps = crate::model::capabilities(facts);
    for (cap, state) in entries(&facts["capabilityStates"]) {
        if state == "supported" {
            caps.insert(cap.clone());
        } else {
            caps.remove(cap);
        }
    }
    caps
}

fn input_types(facts: &Value) -> Vec<Value> {
    if facts["inputModalities"].is_array() {
        return array(&facts["inputModalities"]).to_vec();
    }
    if declared_capabilities(facts).contains("vision") {
        vec![json!("text"), json!("image")]
    } else {
        vec![json!("text")]
    }
}

/// A model/interface association may only narrow the two parent declarations.
fn association_errors(
    model: &Value,
    interface: &Value,
    difference: &Value,
    path: &str,
) -> Vec<Value> {
    let mut errors = fact_errors(difference, path);
    let mut check = |ok: bool, field: &str, message: &str| {
        if !ok {
            errors.push(json!({"path":format!("{path}.{field}"),"message":message}));
        }
    };
    let caps = declared_capabilities(model);
    for cap in declared_capabilities(difference) {
        check(
            caps.contains(&cap),
            "capabilityStates",
            &format!("模型未声明支持 {cap}，关联配置只能收紧"),
        );
    }
    let modalities = input_types(model);
    for input in array(&difference["inputModalities"]) {
        check(
            modalities.contains(input),
            "inputModalities",
            &format!("模型未声明支持输入类型 {}", text(input)),
        );
    }
    for key in ["contextWindow", "maxOutputTokens"] {
        check(
            !matches!((model[key].as_u64(), difference[key].as_u64()), (Some(parent), Some(value)) if value > parent),
            key,
            "长度上限不能超过模型公共限制",
        );
    }
    check(
        difference["supportsStreaming"] != true || interface["supportsStreaming"] == true,
        "supportsStreaming",
        "接口不支持流式响应，关联配置不能开启",
    );
    let reasoning = &difference["reasoning"];
    for key in ["modes", "efforts"] {
        for value in array(&reasoning[key]) {
            check(
                array(&model["reasoning"][key]).contains(value),
                &format!("reasoning.{key}"),
                &format!(
                    "模型未声明支持推理{} {}",
                    if key == "modes" {
                        "控制方式"
                    } else {
                        "档位"
                    },
                    text(value)
                ),
            );
        }
    }
    let parent = &model["reasoning"]["budget"];
    let budget = &reasoning["budget"];
    check(
        budget["unit"].is_null() || parent["unit"].is_null() || budget["unit"] == parent["unit"],
        "reasoning.budget.unit",
        "预算单位必须与模型公共配置一致",
    );
    check(
        !matches!((parent["min"].as_u64(), budget["min"].as_u64()), (Some(parent), Some(value)) if value < parent),
        "reasoning.budget.min",
        "最小预算不能低于模型公共下限",
    );
    check(
        !matches!((parent["max"].as_u64(), budget["max"].as_u64()), (Some(parent), Some(value)) if value > parent),
        "reasoning.budget.max",
        "最大预算不能超过模型公共上限",
    );
    let min = budget["min"].as_u64().or(parent["min"].as_u64());
    let max = budget["max"].as_u64().or(parent["max"].as_u64());
    check(
        !matches!((min, max), (Some(min), Some(max)) if min > max),
        "reasoning.budget",
        "接口继承后的最小预算不能超过最大预算",
    );
    errors
}

pub fn validate_associations(c: &Value) -> Vec<Value> {
    let mut errors = Vec::new();
    for (sid, supplier) in entries(&c["suppliers"]) {
        for (mid, model) in entries(&supplier["models"]) {
            for (iid, difference) in entries(&model["interfaceCapabilities"]) {
                errors.extend(association_errors(
                    model,
                    &supplier["interfaces"][iid],
                    difference,
                    &format!("suppliers.{sid}.models.{mid}.interfaceCapabilities.{iid}"),
                ));
            }
        }
    }
    errors
}

/// Keep existing, structurally valid violations repairable without making them usable.
pub fn unchanged_association_errors(current: &Value, candidate: &Value) -> Vec<Value> {
    let mut errors = Vec::new();
    for (sid, supplier) in entries(&candidate["suppliers"]) {
        for (mid, model) in entries(&supplier["models"]) {
            for (iid, difference) in entries(&model["interfaceCapabilities"]) {
                let interface = &supplier["interfaces"][iid];
                if model != &current["suppliers"][sid]["models"][mid]
                    || interface != &current["suppliers"][sid]["interfaces"][iid]
                {
                    continue;
                }
                let path = format!("suppliers.{sid}.models.{mid}.interfaceCapabilities.{iid}");
                if fact_errors(difference, &path).is_empty() {
                    errors.extend(association_errors(model, interface, difference, &path));
                }
            }
        }
    }
    errors
}

pub fn profile(c: &Value, cable: &Value, binding: &Value) -> Result<Value> {
    let sources = array(&binding["sources"]);
    if sources.is_empty() {
        bail!("来源不存在: 未配置来源");
    }
    let selected = binding["activeSource"].as_u64().unwrap_or(0) as usize;
    sources.get(selected).context("手动来源索引无效")?;
    let mut selected_profile = Value::Null;
    let mut baseline = Value::Null;
    for (index, source) in sources.iter().enumerate() {
        if !array(&cable["suppliers"]).contains(&source["supplierId"]) {
            bail!("来源的供应商未加入 Cable");
        }
        let facts = source_profile(c, source)?;
        // First delivery allows manual groups with an identical published contract only.
        let contract = json!([
            facts["identity"],
            facts["interfaceProtocol"],
            crate::model::capabilities(&facts),
            facts["inputModalities"],
            facts["contextWindow"],
            facts["maxOutputTokens"],
            facts["reasoning"],
            array(&facts["toolForms"])
                .iter()
                .filter_map(Value::as_str)
                .collect::<std::collections::BTreeSet<_>>(),
            crate::codex_adapter::history_policy(&facts)
        ]);
        if index != 0 && contract != baseline {
            bail!("多来源的模型身份、能力及历史约定不兼容，请分别发布模型");
        }
        baseline = contract;
        if index == selected {
            selected_profile = facts;
        }
    }
    selected_profile["aliases"] = binding.get("aliases").cloned().unwrap_or(json!([]));
    selected_profile["clientReasoning"] = binding.get("reasoning").cloned().unwrap_or(json!({}));
    selected_profile["clientContext"] = binding.get("codex").cloned().unwrap_or(json!({}));
    selected_profile["promptStrategy"] = binding
        .get("promptStrategy")
        .cloned()
        .unwrap_or(json!("default"));
    selected_profile["description"] = binding.get("name").cloned().unwrap_or(Value::Null);
    for key in [
        "promptModel",
        "promptVersion",
        "promptHash",
        "supportsSearchTool",
    ] {
        if let Some(value) = binding.get(key) {
            selected_profile[key] = value.clone();
        }
    }
    selected_profile["managedModel"] = json!(true);
    selected_profile["manualSourceGroup"] = json!(sources.len() > 1);
    selected_profile["adapterVersion"] = json!(ADAPTER_VERSION);
    if !["", "default", "native", "selected"].contains(&text(&selected_profile["promptStrategy"]))
        && text(&selected_profile["identity"]).starts_with("gpt-")
    {
        bail!("原生模型使用对应原生定义和提示词");
    }
    Ok(selected_profile)
}

/// Rebuild legacy runtime views from authoritative supplier facts and Cable selections.
pub fn compile(c: &mut Value) {
    if !c["suppliers"].is_object() {
        c["suppliers"] = json!({});
    }
    normalize_supply(c);
    c["upstreams"]
        .as_object_mut()
        .unwrap()
        .retain(|_, u| u.get("managedSupplier").is_none());
    c["routes"]
        .as_object_mut()
        .unwrap()
        .retain(|_, route| route["managedModels"] != true);
    let protections: std::collections::HashMap<String, Value> = entries(&c["virtualProviders"])
        .filter(|(_, p)| p["managedModels"] == true)
        .map(|(id, p)| (id.clone(), p["credentialProtection"].clone()))
        .collect();
    c["virtualProviders"]
        .as_object_mut()
        .unwrap()
        .retain(|_, p| p["managedModels"] != true);
    for (sid, supplier) in entries(&c["suppliers"])
        .map(|(id, v)| (id.clone(), v.clone()))
        .collect::<Vec<_>>()
    {
        for (iid, interface) in entries(&supplier["interfaces"]) {
            if !interface.is_object() {
                continue;
            }
            let uid = interface_key(&sid, iid);
            let mut upstream = interface.clone();
            upstream["id"] = json!(uid);
            upstream["name"] = json!(format!("{} / {}", text(&supplier["name"]), iid));
            upstream["managedSupplier"] = json!(sid);
            upstream["enabled"] = json!(enabled(&supplier) && enabled(interface));
            c["upstreams"][uid] = upstream;
        }
    }
    for (cid, cable) in entries(&c["cables"])
        .filter(|(_, b)| b["managedModels"] == true)
        .map(|(id, b)| (id.clone(), b.clone()))
        .collect::<Vec<_>>()
    {
        let pid = text(&cable["virtualProvider"]).to_owned();
        let rid = format!("{cid}-sources");
        let mut models = json!({});
        let mut backends = Vec::new();
        for sid in array(&cable["suppliers"]).iter().filter_map(Value::as_str) {
            for (iid, _) in entries(&c["suppliers"][sid]["interfaces"]) {
                backends.push(json!({"upstream":interface_key(sid,iid),"enabled":true}));
            }
        }
        for (name, binding) in entries(&cable["models"]) {
            models[name] = match profile(c, &cable, binding) {
                Ok(mut profile) => {
                    if let Err(e) = crate::codex_adapter::validate_profile(&profile) {
                        profile["adaptationError"] = json!(e.to_string());
                    }
                    profile
                }
                Err(e) => {
                    json!({"managedModel":true,"sourceError":e.to_string(),"aliases":binding.get("aliases").cloned().unwrap_or(json!([])),"sources":binding["sources"]})
                }
            };
        }
        c["routes"][&rid] = json!({"id":rid,"managedModels":true,"backends":backends});
        let protection = protections.get(&pid).cloned().unwrap_or(Value::Null);
        c["virtualProviders"][&pid] = json!({"id":pid,"name":cid,"managedModels":true,
            "ingressProtocol":"openai.responses","route":rid,"models":models,"enabled":enabled(&cable)});
        if !protection.is_null() {
            c["virtualProviders"][&pid]["credentialProtection"] = protection;
        }
        if let Some(default) = cable.get("defaultModel") {
            c["virtualProviders"][&pid]["defaultModel"] = default.clone();
        }
        if let Some(fallback) = cable.get("legacyPassthrough") {
            c["virtualProviders"][&pid]["legacyPassthrough"] = fallback.clone();
        }
    }
}

fn fact_errors(facts: &Value, path: &str) -> Vec<Value> {
    let mut errors = Vec::new();
    let mut check = |ok: bool, field: &str, message: &str| {
        if !ok {
            errors.push(json!({"path":format!("{path}.{field}"),"message":message}));
        }
    };
    for field in ["contextWindow", "maxOutputTokens"] {
        check(
            facts[field].is_null() || facts[field].as_u64().is_some_and(|n| n > 0),
            field,
            "限制必须为正整数或未知",
        );
    }
    for field in ["capabilityStates", "reasoning"] {
        check(
            facts
                .get(field)
                .is_none_or(|v| v.is_null() || v.is_object()),
            field,
            "事实结构必须是 object",
        );
    }
    for (_, state) in entries(&facts["capabilityStates"]) {
        check(
            ["supported", "unsupported", "unknown"].contains(&text(state)),
            "capabilityStates",
            "能力状态必须为 supported、unsupported 或 unknown",
        );
    }
    for field in ["inputModalities", "capabilities"] {
        check(
            facts
                .get(field)
                .is_none_or(|v| v.is_array() && array(v).iter().all(nonempty)),
            field,
            "输入类型和能力必须为字符串数组",
        );
    }
    let reasoning = &facts["reasoning"];
    check(
        entries(reasoning)
            .all(|(field, _)| ["modes", "efforts", "budget"].contains(&field.as_str())),
        "reasoning",
        "这里只维护推理供给事实，客户端默认值属于 Cable 模型绑定",
    );
    for field in ["modes", "efforts"] {
        check(
            reasoning
                .get(field)
                .is_none_or(|v| v.is_array() && array(v).iter().all(nonempty)),
            &format!("reasoning.{field}"),
            "推理事实必须是字符串数组",
        );
    }
    for mode in array(&reasoning["modes"]) {
        check(
            ["effort", "toggle", "budget"].contains(&text(mode)),
            "reasoning.modes",
            "推理控制方式无效",
        );
    }
    let budget = &reasoning["budget"];
    check(
        budget.is_null() || budget.is_object(),
        "reasoning.budget",
        "预算事实必须为 object",
    );
    check(
        budget["unit"].is_null() || nonempty(&budget["unit"]),
        "reasoning.budget.unit",
        "预算单位必须为字符串或未知",
    );
    for field in ["min", "max"] {
        check(
            budget[field].is_null() || budget[field].as_u64().is_some(),
            &format!("reasoning.budget.{field}"),
            "预算必须为非负整数或未知",
        );
    }
    check(
        !matches!((budget["min"].as_u64(), budget["max"].as_u64()), (Some(min), Some(max)) if min > max),
        "reasoning.budget",
        "最小预算不能超过最大预算",
    );
    check(
        facts.get("history").is_none(),
        "history",
        "历史处理策略由客户端适配代码决定",
    );
    check(
        facts
            .get("supportsStreaming")
            .is_none_or(|v| v.is_boolean() || v.is_null()),
        "supportsStreaming",
        "模型接口的流式例外必须为布尔值或未知",
    );
    check(
        facts.get("toolForms").is_none_or(|v| {
            v.is_array()
                && array(v)
                    .iter()
                    .all(|form| ["function", "custom"].contains(&text(form)))
                && array(v)
                    .iter()
                    .enumerate()
                    .all(|(i, form)| !array(v)[..i].contains(form))
        }),
        "toolForms",
        "工具形式必须是 function、custom 的无重复数组",
    );
    errors
}

pub fn validate(c: &Value) -> Vec<Value> {
    let mut errors = Vec::new();
    let mut check = |ok: bool, path: String, message: &str| {
        if !ok {
            errors.push(json!({"path":path,"message":message}));
        }
    };
    let identifier = |s: &str| {
        !s.is_empty()
            && s.len() <= 24
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    };
    let mut facts_errors = Vec::new();
    for (sid, supplier) in entries(&c["suppliers"]) {
        let path = format!("suppliers.{sid}");
        check(
            identifier(sid) && supplier.is_object() && nonempty(&supplier["name"]),
            path.clone(),
            "供应商 ID 或名称无效",
        );
        check(
            supplier.get("type").is_none(),
            path.clone(),
            "供应商不限定类型",
        );
        check(
            supplier["interfaces"].is_object() && supplier["models"].is_object(),
            path.clone(),
            "接口与模型列表必须是 object",
        );
        check(
            supplier.get("enabled").is_none_or(Value::is_boolean),
            path.clone(),
            "启停状态必须为布尔值",
        );
        for (iid, i) in entries(&supplier["interfaces"]) {
            let p = format!("{path}.interfaces.{iid}");
            if let Some(method) = i["auth"].get("method") {
                let expected = authentication(text(&i["protocol"]), text(method));
                check(
                    expected.is_ok_and(|expected| expected == i["auth"]),
                    p.clone(),
                    "认证方式必须匹配协议的内置配置",
                );
            }
            check(identifier(iid) && i.is_object(), p.clone(), "接口 ID 无效");
            check(
                i.get("enabled").is_none_or(Value::is_boolean),
                p.clone(),
                "启停状态必须为布尔值",
            );
            for field in ["supportsStreaming", "supportsResponseIdContinuation"] {
                check(
                    i.get(field).is_none_or(Value::is_boolean),
                    format!("{p}.{field}"),
                    "接口能力必须为布尔值",
                );
            }
            check(
                crate::validation::PROTOCOLS.contains(&text(&i["protocol"])),
                p.clone(),
                "协议未注册",
            );
            check(
                url::Url::parse(text(&i["baseUrl"]))
                    .is_ok_and(|u| ["http", "https"].contains(&u.scheme())),
                p,
                "接口 URL 无效",
            );
        }
        for (mid, m) in entries(&supplier["models"]) {
            let p = format!("{path}.models.{mid}");
            facts_errors.extend(fact_errors(m, &p));
            check(
                [
                    "codex",
                    "targetOverrides",
                    "capabilityOverrides",
                    "promptStrategy",
                    "promptModel",
                    "promptVersion",
                    "promptHash",
                    "upstream",
                    "managedModel",
                    "adapterVersion",
                    "sourceError",
                    "toolForms",
                    "supportsStreaming",
                    "supportsResponseIdContinuation",
                    "clientReasoning",
                    "clientContext",
                ]
                .iter()
                .all(|field| m.get(*field).is_none()),
                p.clone(),
                "供应商模型仅维护供给事实，客户端适配与提示词归属 Cable 及代码实现",
            );
            check(
                !mid.trim().is_empty() && m.is_object(),
                p.clone(),
                "上游模型 ID 不能为空",
            );
            check(
                m.get("enabled").is_none_or(Value::is_boolean),
                p.clone(),
                "启停状态必须为布尔值",
            );
            check(
                m.get("id").is_none() && m.get("upstreamModelId").is_none(),
                p.clone(),
                "模型仅使用字典键作为上游 ID，不设独立记录 ID",
            );
            check(
                m["identity"].is_null() || m["identity"].is_string(),
                p.clone(),
                "实际身份必须为字符串或 null（未知）",
            );
            check(
                m["name"].is_null() || m["name"].is_string(),
                format!("{p}.name"),
                "上游模型名称必须为字符串或 null",
            );
            check(
                m.get("version").is_none(),
                format!("{p}.version"),
                "模型版本请使用不同的实际/参考模型身份 ID 区分",
            );
            check(
                m["interfaces"].is_array()
                    && array(&m["interfaces"])
                        .iter()
                        .all(|i| supplier["interfaces"].get(text(i)).is_some()),
                p.clone(),
                "可访问接口必须引用供应商已配置接口",
            );
            check(
                m.get("interfaceCapabilities")
                    .is_none_or(|v| v.is_null() || v.is_object()),
                format!("{p}.interfaceCapabilities"),
                "事实结构必须是 object",
            );
            for (iid, difference) in entries(&m["interfaceCapabilities"]) {
                facts_errors.extend(association_errors(
                    m,
                    &supplier["interfaces"][iid],
                    difference,
                    &format!("{p}.interfaceCapabilities.{iid}"),
                ));
                check(
                    array(&m["interfaces"]).contains(&json!(iid))
                        && difference.is_object()
                        && difference.get("modelId").is_none()
                        && difference.get("upstreamModelId").is_none(),
                    p.clone(),
                    "接口差异仅包含能力，不包含独立模型 ID",
                );
                check(
                    entries(difference).all(|(key, _)| {
                        [
                            "capabilityStates",
                            "capabilities",
                            "inputModalities",
                            "contextWindow",
                            "maxOutputTokens",
                            "reasoning",
                            "toolForms",
                            "supportsStreaming",
                            "migration",
                        ]
                        .contains(&key.as_str())
                    }),
                    p.clone(),
                    "接口差异只能覆盖能力与限制事实",
                );
            }
        }
    }
    for (cid, b) in entries(&c["cables"]).filter(|(_, b)| b["managedModels"] == true) {
        let path = format!("cables.{cid}");
        check(
            b["target"] == "codex",
            path.clone(),
            "首期目录适配仅开放 Codex",
        );
        check(
            b["models"].is_object() && b["suppliers"].is_array(),
            path.clone(),
            "Cable 必须显式配置供应商和模型",
        );
        check(
            array(&b["suppliers"])
                .iter()
                .all(|sid| c["suppliers"].get(text(sid)).is_some()),
            path.clone(),
            "供应商不存在",
        );
        if let Some(default) = b.get("defaultModel") {
            check(
                b["models"].get(text(default)).is_some(),
                path.clone(),
                "默认模型必须属于 Cable 选择",
            );
        }
        for (name, binding) in entries(&b["models"]) {
            let p = format!("{path}.models.{name}");
            for issue in crate::codex_adapter::context_settings_issues(&binding["codex"]) {
                check(false, format!("{p}.codex"), &issue);
            }
            check(
                binding
                    .get("supportsSearchTool")
                    .is_none_or(Value::is_boolean),
                format!("{p}.supportsSearchTool"),
                "supports_search_tool 必须为布尔值",
            );
            check(
                binding["name"].is_null() || binding["name"].is_string(),
                format!("{p}.name"),
                "客户端显示名称必须为字符串或 null",
            );
            check(
                binding
                    .get("nameMode")
                    .is_none_or(|v| v == "auto" || v == "manual"),
                format!("{p}.nameMode"),
                "显示名称生成方式必须为 auto 或 manual",
            );
            check(
                binding.get("reasoning").is_none_or(|v| {
                    v.is_object()
                        && (v["defaultEffort"].is_null() || nonempty(&v["defaultEffort"]))
                        && entries(v).all(|(key, _)| {
                            ["defaultEffort", "defaultBudget"].contains(&key.as_str())
                        })
                }),
                format!("{p}.reasoning"),
                "客户端推理配置必须为 object，默认档位必须为字符串或未配置",
            );
            check(
                binding["reasoning"]["defaultBudget"].is_null()
                    || binding["reasoning"]["defaultBudget"].as_u64().is_some(),
                format!("{p}.reasoning.defaultBudget"),
                "默认预算必须为非负整数或未配置",
            );
            check(
                binding.is_object() && binding["sources"].is_array(),
                p.clone(),
                "绑定必须包含显式 sources 数组",
            );
            check(
                binding.get("activeSource").is_none_or(|v| {
                    v.as_u64()
                        .is_some_and(|n| n < array(&binding["sources"]).len().max(1) as u64)
                }),
                p.clone(),
                "手动来源索引无效",
            );
            // Keep legacy strategy tags readable so users can repair saved bindings.
            // Publication and request validation require a selected native prompt for compatible models.
            check(
                [
                    "",
                    "default",
                    "native",
                    "compatible",
                    "compatible-concise",
                    "selected",
                ]
                .contains(&text(&binding["promptStrategy"])),
                p.clone(),
                "提示词策略无效，请选择 Codex 原生模型提示词",
            );
            for key in ["promptModel", "promptVersion", "promptHash"] {
                check(
                    binding
                        .get(key)
                        .is_none_or(|v| v.is_null() || v.is_string()),
                    format!("{p}.{key}"),
                    "提示词来源与版本必须为字符串",
                );
            }
            check(
                binding
                    .get("strategy")
                    .is_none_or(|v| v == "manual" || v == "fixed"),
                p.clone(),
                "自动路由策略尚未开放",
            );
            for source in array(&binding["sources"]) {
                check(
                    nonempty(&source["supplierId"])
                        && nonempty(&source["modelId"])
                        && nonempty(&source["interfaceId"]),
                    p.clone(),
                    "来源必须包含供应商、上游模型和接口 ID",
                );
                check(
                    array(&b["suppliers"]).contains(&source["supplierId"]),
                    p.clone(),
                    "来源供应商不在 Cable 选择范围",
                );
            }
        }
    }
    errors.extend(facts_errors);
    errors
}
