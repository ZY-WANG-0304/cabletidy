//! Version-matched Codex definitions, paired built-in prompts and Responses parameter rules.
use crate::{
    config::{array, nonempty, text},
    suppliers,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

const CODING_PROMPT: &str = "You are a coding assistant working with the user in their workspace. Inspect relevant files before editing. Preserve unrelated user changes. Follow the user's instructions and repository instructions. Use the tools supplied in this request to inspect files, run commands and make changes. A tool call proposes an action; wait for the matching tool result before relying on it. Use apply_patch with its declared patch syntax to edit files. Do not invent tools, tool results, files or successful checks. Complete the requested work, run appropriate checks, and clearly report the changes and any remaining limitations.";

pub const SUPPLY_EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

pub fn reasoning_rules() -> Value {
    json!(suppliers::COMPATIBLE_MODELS.iter().map(|identity| {
        let efforts = if identity.starts_with("DeepSeek-") {
            vec!["none", "low", "high", "max"]
        } else if *identity == "MiniMax M3" {
            vec!["none", "high"]
        } else { SUPPLY_EFFORTS.to_vec() };
        json!({"identity":identity,"protocol":"openai.responses","efforts":efforts,
            "effortLabels": if *identity == "MiniMax M3" { json!({"none":"none · 关闭推理","high":"high · 开启推理"}) } else { json!({}) },
            "clientEffortMap": SUPPLY_EFFORTS.iter().map(|effort| (effort.to_string(), json!(upstream_effort(identity, effort)))).collect::<serde_json::Map<_,_>>()})
    }).collect::<Vec<_>>())
}

pub fn upstream_effort<'a>(identity: &str, effort: &'a str) -> &'a str {
    if identity.starts_with("DeepSeek-") {
        deepseek_effort(effort)
    } else if identity.eq_ignore_ascii_case("MiniMax M3") && effort != "none" {
        "high"
    } else {
        effort
    }
}

pub fn history_policy(p: &Value) -> &'static str {
    if suppliers::compatible(text(&p["identity"])) || p["manualSourceGroup"] == true {
        "stateless"
    } else {
        "native"
    }
}

fn require_tool_form(p: &Value, form: &str) -> Result<()> {
    if !array(&p["toolForms"]).contains(&json!(form)) {
        bail!("该模型通过所选接口未声明支持 {form} 工具形式");
    }
    Ok(())
}

pub fn validate_profile(p: &Value) -> Result<()> {
    if p["interfaceProtocol"] != "openai.responses" {
        bail!("首期适配仅支持 Responses 访问协议");
    }
    let identity = text(&p["identity"]);
    if !identity.starts_with("gpt-") && !suppliers::compatible(identity) {
        bail!("模型身份未知或适配尚未实现: {identity}");
    }
    let caps = crate::model::capabilities(p);
    if p["inputModalities"].is_array() && !array(&p["inputModalities"]).contains(&json!("text")) {
        bail!("当前 Codex 适配需要供给支持文本输入");
    }
    if !caps.contains("tools") || !caps.contains("streaming") {
        bail!("请声明该模型的接口工具形式及流式供给能力");
    }
    require_tool_form(p, "function")?;
    if caps.contains("reasoning") && efforts(p)?.is_empty() {
        bail!("该推理控制方式暂无内置映射，请确认 Responses 支持的档位");
    }
    let settings = &p["clientReasoning"];
    let budget = &p["reasoning"]["budget"];
    if matches!((budget["min"].as_u64(),budget["max"].as_u64()),(Some(min),Some(max)) if min > max)
    {
        bail!("接口的有效最小预算不能超过最大预算");
    }
    if let Some(default) = settings["defaultBudget"].as_u64() {
        if budget["min"].as_u64().is_some_and(|min| default < min)
            || budget["max"].as_u64().is_some_and(|max| default > max)
        {
            bail!("客户端默认预算超出有效供给范围");
        }
    }
    if !settings["defaultBudget"].is_null() {
        bail!("当前 Codex × Responses 组合尚未实现默认推理预算映射");
    }
    let default = text(&settings["defaultEffort"]);
    if default == "ultra" {
        bail!("当前适配未开放 Ultra 的客户端委派配置");
    }
    if !default.is_empty()
        && (!caps.contains("reasoning")
            || (!array(&p["reasoning"]["efforts"]).is_empty()
                && !efforts(p)?.iter().any(|e| e == default)))
    {
        bail!("客户端默认推理档位不在有效供给与内置映射范围内: {default}");
    }
    if suppliers::compatible(identity) {
        require_tool_form(p, "custom")?;
        if !p["contextWindow"].as_u64().is_some_and(|v| v > 0) {
            bail!("请确认模型上下文限制");
        }
        if p["promptStrategy"] == "native" {
            bail!("非原生模型不能选择原生提示词");
        }
    }
    Ok(())
}

pub fn catalog_entry(snapshot: &Value, name: &str, p: &Value) -> Result<(Value, Value)> {
    if nonempty(&p["sourceError"]) {
        bail!("{}", text(&p["sourceError"]));
    }
    validate_profile(p)?;
    let identity = text(&p["identity"]);
    let native = array(&snapshot["catalog"]["models"])
        .iter()
        .find(|m| m["slug"] == identity && identity.starts_with("gpt-"));
    let strategy = text(&p["promptStrategy"]);
    let use_native = native.is_some() && ["", "default", "native"].contains(&strategy);
    if strategy == "native" && native.is_none() {
        bail!("实际模型身份未匹配本机原生定义");
    }
    if !use_native && !suppliers::compatible(identity) {
        bail!("实际模型身份未知或尚未实现: {identity}");
    }
    let original = if use_native {
        native.unwrap()
    } else {
        array(&snapshot["catalog"]["models"])
            .first()
            .context("本机 Codex 目录为空")?
    };
    let mut out = original.clone();
    require_tool_form(p, "function")?;
    if !use_native || original["apply_patch_tool_type"] == "freeform" {
        require_tool_form(p, "custom")?;
    }
    out["slug"] = json!(name);
    out["display_name"] = json!(name);
    out["upgrade"] = Value::Null;
    if !use_native {
        for key in [
            "comp_hash",
            "auto_compact_token_limit",
            "available_access_programs",
            "availability_nux",
            "guardian",
            "model_messages",
        ] {
            out.as_object_mut().unwrap().remove(key);
        }
        let prompt = if strategy == "compatible-concise" {
            format!("{CODING_PROMPT}\nKeep explanations concise; prioritize completing and verifying the requested change.")
        } else {
            CODING_PROMPT.into()
        };
        out["base_instructions"] = json!(prompt);
        out["model_messages"] = Value::Null;
        out["description"] = json!(format!(
            "CableTidy compatibility template for {identity}; model validation is separate."
        ));
        out["visibility"] = json!("list");
        out["supported_in_api"] = json!(true);
        out["shell_type"] = json!("unified_exec");
        out["apply_patch_tool_type"] = json!("freeform");
        out["support_verbosity"] = json!(false);
        out["supports_reasoning_summary_parameter"] = json!(false);
        out["default_reasoning_summary"] = json!("none");
        out["supports_parallel_tool_calls"] = json!(false);
        out["additional_speed_tiers"] = json!([]);
        out["service_tiers"] = json!([]);
        out["default_service_tier"] = Value::Null;
        out["supports_image_detail_original"] = json!(false);
        out["experimental_supported_tools"] = json!([]);
        out["supports_search_tool"] = json!(false);
        out["supports_experimental_context"] = json!(false);
        out["use_responses_lite"] = json!(false);
        out["supports_reasoning_effort_updates"] = json!(false);
        out["node_repl_auto_review_required"] = json!(false);
        out["node_repl_disabled"] = json!(true);
        out["auto_review_model_override"] = Value::Null;
        out["model_specialty"] = Value::Null;
        out["tool_mode"] = json!("direct");
        out["multi_agent_version"] = Value::Null;
        out["multi_agent_reasoning_effort"] = Value::Null;
        out["default_verbosity"] = Value::Null;
    }
    if use_native
        && !nonempty(&out["base_instructions"])
        && !nonempty(&out["model_messages"]["instructions_template"])
    {
        bail!("原生模型缺少完整指令定义");
    }
    let caps = crate::model::capabilities(p);
    if !caps.contains("tools") || !caps.contains("streaming") {
        bail!("Codex 模型必须确认支持工具调用及流式输出");
    }
    out["input_modalities"] = if caps.contains("vision")
        && array(&p["inputModalities"]).contains(&json!("image"))
        && (!use_native || array(&original["input_modalities"]).contains(&json!("image")))
    {
        json!(["text", "image"])
    } else {
        json!(["text"])
    };
    if let Some(window) = p["contextWindow"].as_u64() {
        if use_native
            && window
                > original["max_context_window"]
                    .as_u64()
                    .or(original["context_window"].as_u64())
                    .unwrap_or(window)
        {
            bail!("供给上下文不能超过原生定义限制");
        }
        out["context_window"] = json!(window);
        out["max_context_window"] = json!(window);
    } else if !use_native {
        bail!("请确认非原生模型的上下文限制");
    }
    if !caps.contains("reasoning") {
        out["supported_reasoning_levels"] = json!([]);
        out["default_reasoning_level"] = Value::Null;
    } else if !use_native || !array(&p["reasoning"]["efforts"]).is_empty() {
        let efforts = efforts(p)?;
        if efforts.is_empty() {
            bail!("请声明已支持的 Responses 推理档位；预算转换尚未开放");
        }
        let efforts = if use_native {
            efforts
                .into_iter()
                .filter(|effort| {
                    array(&original["supported_reasoning_levels"])
                        .iter()
                        .any(|r| text(&r["effort"]) == effort)
                })
                .collect::<Vec<_>>()
        } else {
            efforts
        };
        if efforts.is_empty() {
            bail!("供给推理档位与原生定义无交集");
        }
        out["supported_reasoning_levels"] = json!(efforts
            .iter()
            .map(|e| json!({"effort":e,"description":e}))
            .collect::<Vec<_>>());
        out["default_reasoning_level"] = json!(efforts
            .iter()
            .find(|e| e.as_str() == text(&original["default_reasoning_level"]))
            .or_else(|| efforts.first()));
    }
    let default = text(&p["clientReasoning"]["defaultEffort"]);
    if !default.is_empty() {
        if !array(&out["supported_reasoning_levels"])
            .iter()
            .any(|level| level["effort"] == default)
        {
            bail!("客户端默认推理档位不在该版本模型定义与供给交集中: {default}");
        }
        out["default_reasoning_level"] = json!(default);
    }
    out["supports_parallel_tool_calls"] = json!(caps.contains("parallel_tool_calls"));
    Ok((original.clone(), out))
}

pub fn efforts(p: &Value) -> Result<Vec<String>> {
    let r = &p["reasoning"];
    if !array(&r["modes"]).contains(&json!("effort")) {
        return Ok(vec![]);
    }
    let levels = array(&r["efforts"]);
    if levels.iter().any(|e| !SUPPLY_EFFORTS.contains(&text(e))) {
        bail!("当前内置规则不支持该推理档位");
    }
    if levels.is_empty() {
        return Ok(vec![]);
    }
    let levels: Vec<String> = levels
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    if text(&p["identity"]).starts_with("DeepSeek-")
        || text(&p["identity"]).eq_ignore_ascii_case("MiniMax M3")
    {
        let identity = text(&p["identity"]);
        let enabled = identity.eq_ignore_ascii_case("MiniMax M3")
            && levels.iter().any(|level| level != "none");
        Ok(SUPPLY_EFFORTS
            .iter()
            .copied()
            .filter(|e| {
                enabled && *e != "none"
                    || levels
                        .iter()
                        .any(|level| level == upstream_effort(identity, e))
            })
            .map(str::to_owned)
            .collect())
    } else {
        Ok(levels)
    }
}
pub fn deepseek_effort(effort: &str) -> &str {
    match effort {
        "minimal" => "low",
        "medium" | "xhigh" => "high",
        other => other,
    }
}

pub fn catalog_plan(c: &Value, p: &Value, snapshot: &Value) -> Result<Value> {
    crate::catalog::validate(&snapshot["catalog"])?;
    if !c["upstreams"].is_object() {
        bail!("上游配置无效");
    }
    let mut models = Vec::new();
    let mut names = Vec::new();
    let mut warnings = Vec::new();
    for (name, profile) in crate::config::entries(&p["models"]) {
        let resolution = crate::model::resolve(p, Some(&json!(name)))?;
        let entry = crate::model::select(c, p, &resolution, &json!({}))
            .map_err(anyhow::Error::from)
            .and_then(|_| catalog_entry(snapshot, name, profile).map(|(_, entry)| entry));
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) if p["defaultModel"] != name.as_str() => {
                warnings.push(format!("{name} 未发布: {e}"));
                continue;
            }
            Err(e) => return Err(e.context("默认模型不可用")),
        };
        if suppliers::compatible(text(&profile["identity"])) {
            warnings.push(format!("{name}: 首期兼容规则开放直接函数工具和 apply_patch；不发布客户端特殊 tool_search 与 multi_agent_v1，相关旧会话需新建。"));
            warnings.push(format!(
                "{name}: 内置兼容模板；真实模型验证状态: {}",
                profile["validation"].as_str().unwrap_or("未实测")
            ));
        }
        names.push(name.clone());
        for alias in array(&profile["aliases"])
            .iter()
            .filter_map(Value::as_str)
            .filter(|alias| *alias != name)
        {
            let mut definition = entry.clone();
            definition["slug"] = json!(alias);
            definition["display_name"] = json!(alias);
            names.push(alias.to_owned());
            models.push(definition);
        }
        models.push(entry);
    }
    if names.is_empty() {
        bail!("请显式选择至少一个可用模型后应用");
    }
    if nonempty(&p["defaultModel"]) && !names.iter().any(|n| n == text(&p["defaultModel"])) {
        bail!("默认模型不可用");
    }
    Ok(
        json!({"sourceVersion":snapshot["version"],"catalog":{"models":models},"models":names,"overrides":names,"warnings":warnings,"explicitModels":true}),
    )
}

/// Transform only small protocol fields, leaving the streamed history and user content intact.
pub fn request_edits(
    source: &std::sync::Arc<crate::streaming::Spool>,
    p: &Value,
) -> Result<crate::streaming::Edits> {
    use crate::streaming::{self, Edits};
    let mut edits = Edits::new();
    if p["managedModel"] != true {
        return Ok(edits);
    }
    let index = streaming::index(source, None)?;
    let mut memory = streaming::Reservation::memory();
    let compatible = suppliers::compatible(text(&p["identity"]));
    let stateless = history_policy(p) == "stateless";
    for (_, field, node) in &index.nodes {
        if field == "parallel_tool_calls"
            && !crate::model::capabilities(p).contains("parallel_tool_calls")
        {
            edits.add(node.start, node.end, b"false".to_vec())?;
        }
        if field == "reasoning" {
            let mut reasoning = node.read(source, &mut memory)?;
            if !reasoning.is_object() {
                bail!("reasoning 必须是 object");
            }
            let effort = text(&reasoning["effort"]).to_owned();
            if !effort.is_empty()
                && p["reasoning"]["efforts"].is_array()
                && !efforts(p)?.iter().any(|e| e == &effort)
            {
                bail!("该来源未声明支持推理档位 {effort}");
            }
            if compatible {
                if reasoning.get("budget").is_some() || reasoning.get("budget_tokens").is_some() {
                    bail!("当前组合尚未实现推理预算参数映射");
                }
                reasoning.as_object_mut().unwrap().remove("summary");
                if !effort.is_empty() {
                    let mapped = upstream_effort(text(&p["identity"]), &effort).to_owned();
                    reasoning["effort"] = json!(mapped);
                }
            }
            edits.add(node.start, node.end, serde_json::to_vec(&reasoning)?)?;
        }
        if field == "max_output_tokens" {
            let output = node.read(source, &mut memory)?;
            if p["maxOutputTokens"]
                .as_u64()
                .is_some_and(|limit| output.as_u64().is_none_or(|n| n > limit))
            {
                bail!("请求超过供应商模型输出限制");
            }
        }
        if stateless
            && ["previous_response_id", "conversation"].contains(&field.as_str())
            && node.kind != b'n'
        {
            bail!("兼容模型需要完整历史，不能使用远端历史引用");
        }
        if !stateless
            && p["supportsResponseIdContinuation"] != true
            && ["previous_response_id", "conversation"].contains(&field.as_str())
            && node.kind != b'n'
        {
            bail!("所选接口未声明支持响应 ID 续接，请发送完整历史");
        }
        if stateless && field == "store" {
            edits.add(node.start, node.end, b"false".to_vec())?;
        }
        if stateless && field == "input" && node.kind == b'[' {
            // Inspect item structure without reading arbitrary large message contents into RAM.
            let items = streaming::index(source, Some(node))?;
            for (_, _, item) in &items.nodes {
                if item.kind != b'{' {
                    continue;
                }
                let fields = streaming::index(source, Some(item))?;
                if compatible
                    && fields.nodes.iter().any(|(_, key, n)| {
                        key == "namespace"
                            && n.read(source, &mut memory)
                                .is_ok_and(|v| v == "multi_agent_v1")
                    })
                {
                    bail!("兼容模板不支持旧多代理历史，请新建会话");
                }
                if fields.nodes.iter().any(|(_, key, n)| {
                    ["encrypted_content"].contains(&key.as_str()) && n.kind != b'n'
                }) {
                    bail!("兼容模型不能回放加密推理或原生压缩历史，请使用新会话");
                }
                if [
                    "item_reference",
                    "compaction",
                    "configuration_update",
                    "tool_search_call",
                    "tool_search_output",
                ]
                .contains(&text(&fields.values["type"]))
                {
                    bail!("兼容模型不能使用该原生历史条目，请新建会话");
                }
            }
        }
        if field == "tools" && node.kind == b'[' {
            let tools = streaming::index(source, Some(node))?;
            let mut removed = Vec::new();
            for (_, _, tool) in &tools.nodes {
                let fields = streaming::index(source, Some(tool))?;
                let kind = text(&fields.values["type"]);
                let name = text(&fields.values["name"]);
                // Current Codex extensions may still emit this special tool when the model
                // disables search. It cannot be represented by a plain function call.
                let unavailable = compatible
                    && (kind == "tool_search" || kind == "namespace" && name == "multi_agent_v1");
                removed.push(unavailable);
                if unavailable {
                    continue;
                }
                check_tool_forms(source, p, tool)?;
                if compatible && kind != "function" && !(kind == "custom" && name == "apply_patch")
                {
                    bail!("兼容模型仅支持 function 工具及 apply_patch 自定义工具；不支持工具类型 {kind}");
                }
            }
            let mut i = 0;
            while i < removed.len() {
                if !removed[i] {
                    i += 1;
                    continue;
                }
                let first = i;
                while i < removed.len() && removed[i] {
                    i += 1;
                }
                let start = if i == removed.len() && first > 0 {
                    tools.nodes[first - 1].2.end
                } else {
                    tools.nodes[first].2.start
                };
                let end = if i < removed.len() {
                    tools.nodes[i].2.start
                } else {
                    tools.nodes[i - 1].2.end
                };
                edits.add(start, end, vec![])?;
            }
        }
    }
    if compatible {
        for key in ["include", "service_tier", "text", "truncation"] {
            if let Some((_, _, node)) = index.nodes.iter().find(|(_, field, _)| field == key) {
                let value = node.read(source, &mut memory)?;
                match key {
                    "include" if array(&value).contains(&json!("reasoning.encrypted_content")) => {
                        let values: Vec<_> = array(&value)
                            .iter()
                            .filter(|v| **v != "reasoning.encrypted_content")
                            .collect();
                        edits.add(node.start, node.end, serde_json::to_vec(&values)?)?;
                    }
                    "text" if value["verbosity"].is_string() => {
                        let mut text = value.clone();
                        text.as_object_mut().unwrap().remove("verbosity");
                        edits.add(node.start, node.end, serde_json::to_vec(&text)?)?;
                    }
                    "service_tier" if !value.is_null() && value != "auto" => {
                        bail!("兼容规则暂不支持服务档位参数")
                    }
                    "truncation" if value == "auto" => bail!("兼容模型不能依赖上游自动截断历史"),
                    _ => {}
                }
            }
        }
    }
    if stateless && !index.nodes.iter().any(|(_, field, _)| field == "store") {
        let root = streaming::request_info(source)?.root;
        edits.add(root.start + 1, root.start + 1, b"\"store\":false,".to_vec())?;
    }
    edits.ranges.sort_by_key(|r| r.0);
    Ok(edits)
}

fn check_tool_forms(
    source: &std::sync::Arc<crate::streaming::Spool>,
    p: &Value,
    tool: &crate::streaming::Node,
) -> Result<()> {
    let fields = crate::streaming::index(source, Some(tool))?;
    let kind = text(&fields.values["type"]);
    if ["function", "custom"].contains(&kind) {
        require_tool_form(p, kind)?;
    }
    if kind == "namespace" {
        if let Some((_, _, node)) = fields.nodes.iter().find(|(_, key, _)| key == "tools") {
            let tools = crate::streaming::index(source, Some(node))?;
            for (_, _, tool) in &tools.nodes {
                check_tool_forms(source, p, tool)?;
            }
        }
    }
    Ok(())
}
