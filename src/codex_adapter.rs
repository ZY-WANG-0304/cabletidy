//! Version-matched Codex definitions, selected native prompts and Responses parameter rules.
use crate::{
    config::{array, nonempty, text},
    suppliers,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn prompt_metadata(snapshot: &Value, model: &Value) -> Value {
    let instructions = json!([model["base_instructions"], model["model_messages"]]);
    json!({"version":snapshot["version"],
        "hash":format!("{:x}", Sha256::digest(instructions.to_string().as_bytes())),
        "contract":{"shell_type":model["shell_type"],"apply_patch_tool_type":model["apply_patch_tool_type"],"tool_mode":model["tool_mode"],"multi_agent_version":model["multi_agent_version"]},
        "text":model["model_messages"]["instructions_template"].as_str()
            .filter(|s| !s.is_empty()).unwrap_or(text(&model["base_instructions"]))})
}

pub const SUPPLY_EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

pub fn reasoning_rules() -> Value {
    json!(suppliers::COMPATIBLE_MODELS.iter().map(|identity| {
        let efforts = if identity.starts_with("deepseek-") {
            vec!["none", "low", "high", "max"]
        } else if *identity == "MiniMax-M3" {
            vec!["none", "high"]
        } else { SUPPLY_EFFORTS.to_vec() };
        json!({"identity":identity,"protocol":"openai.responses","efforts":efforts,
            "effortLabels": if *identity == "MiniMax-M3" { json!({"none":"none · 关闭推理","high":"high · 开启推理"}) } else { json!({}) },
            "clientEffortMap": SUPPLY_EFFORTS.iter().map(|effort| (effort.to_string(), json!(upstream_effort(identity, effort)))).collect::<serde_json::Map<_,_>>()})
    }).collect::<Vec<_>>())
}

pub fn upstream_effort<'a>(identity: &str, effort: &'a str) -> &'a str {
    if identity.starts_with("deepseek-") {
        deepseek_effort(effort)
    } else if identity.eq_ignore_ascii_case("MiniMax-M3") && effort != "none" {
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
        bail!("模型在所选访问接口上未声明支持 {form} 工具形式。请检查供应商模型的“可访问接口”；所选 Codex 模型定义与提示词需要此工具形式");
    }
    Ok(())
}

fn collect_issue(issues: &mut Vec<String>, result: Result<()>) {
    if let Err(error) = result {
        let message = format!("{error:#}");
        if !issues.contains(&message) {
            issues.push(message);
        }
    }
}

pub fn context_settings_issues(settings: &Value) -> Vec<String> {
    if settings.is_null() {
        return vec![];
    }
    if !settings.is_object() {
        return vec!["Codex 窗口配置必须为 object".into()];
    }
    let mut issues = Vec::new();
    for (key, value) in settings.as_object().unwrap() {
        if !["contextWindow", "maxContextWindow"].contains(&key.as_str()) {
            issues.push(format!("不支持的 Codex 窗口配置: {key}"));
        } else if !value.is_null() && !value.as_u64().is_some_and(|n| n > 0) {
            issues.push(format!("Codex {key} 必须为正整数或未配置"));
        }
    }
    if matches!((settings["contextWindow"].as_u64(), settings["maxContextWindow"].as_u64()), (Some(window), Some(max)) if window > max)
    {
        issues.push("Codex 使用窗口不能超过 Codex 窗口上限".into());
    }
    issues
}

// Client budgets are independent of supplier model specifications and selected prompts.
fn context_windows(original: &Value, p: &Value, native: bool) -> Result<(u64, u64)> {
    let settings = &p["clientContext"];
    if let Some(issue) = context_settings_issues(settings).first() {
        bail!("{issue}");
    }
    let supply = p["contextWindow"].as_u64().filter(|n| *n > 0);
    let default_window = if native {
        original["context_window"]
            .as_u64()
            .filter(|n| *n > 0)
            .context("原生目录缺少上下文窗口")?
    } else {
        // A deliberate adapter default, never inherited from the prompt model.
        272_000
    };
    let default_max = if native {
        original["max_context_window"]
            .as_u64()
            .filter(|n| *n > 0)
            .unwrap_or(default_window)
    } else {
        supply.context("请确认非原生模型的上下文限制")?
    };
    let max = settings["maxContextWindow"]
        .as_u64()
        .unwrap_or(supply.map_or(default_max, |limit| default_max.min(limit)));
    let window = settings["contextWindow"]
        .as_u64()
        .unwrap_or(default_window.min(max));
    if window > max {
        bail!(
            "Codex 使用窗口 {window} 不能超过 Codex 窗口上限 {max}；如需扩大，请同时设置窗口上限"
        );
    }
    if let Some(limit) = supply {
        if max > limit {
            bail!("Codex 窗口上限 {max} 不能超过供应商总上下文 {limit}");
        }
    } else if max > default_max {
        bail!("扩大 Codex 窗口上限前，请确认供应商总上下文");
    }
    Ok((window, max))
}

pub fn validate_profile(p: &Value) -> Result<()> {
    if let Some(message) = profile_issues(p).first() {
        bail!("{message}");
    }
    Ok(())
}

fn profile_issues(p: &Value) -> Vec<String> {
    let mut issues = context_settings_issues(&p["clientContext"]);
    if let Some(limit) = p["contextWindow"].as_u64() {
        for key in ["contextWindow", "maxContextWindow"] {
            if p["clientContext"][key].as_u64().is_some_and(|n| n > limit) {
                issues.push(format!("Codex {key} 不能超过供应商总上下文 {limit}"));
            }
        }
    }
    if p["interfaceProtocol"] != "openai.responses" {
        issues.push("首期适配仅支持 Responses 访问协议".into());
    }
    if p.get("supportsSearchTool")
        .is_some_and(|value| !value.is_boolean())
    {
        issues.push("supports_search_tool 必须为布尔值".into());
    }
    let identity = text(&p["identity"]);
    if crate::catalog::is_daybreak(identity) || crate::catalog::is_daybreak(text(&p["promptModel"]))
    {
        issues.push("CableTidy 不支持 Daybreak 模型身份或提示词，请重新选择".into());
    }
    if (p["promptStrategy"] == "selected" || suppliers::compatible(identity))
        && !nonempty(&p["promptModel"])
    {
        issues.push("请选择使用的 Codex 原生模型提示词".into());
    }
    if !identity.starts_with("gpt-") && !suppliers::compatible(identity) {
        issues.push(format!("模型身份未知或适配尚未实现: {identity}"));
    }
    let caps = crate::model::capabilities(p);
    if p["inputModalities"].is_array() && !array(&p["inputModalities"]).contains(&json!("text")) {
        issues.push("当前 Codex 适配需要供给支持文本输入".into());
    }
    if !caps.contains("streaming") {
        issues.push("所选访问接口的有效配置不支持流式响应。请检查供应商接口的“支持流式响应”和模型的接口差异设置".into());
    }
    if !caps.contains("tools") {
        issues.push(
            "模型在所选访问接口上未声明工具形式。请在供应商模型的“可访问接口”中配置支持的工具形式"
                .into(),
        );
    }
    collect_issue(&mut issues, require_tool_form(p, "function"));
    if caps.contains("reasoning") && efforts(p).is_ok_and(|levels| levels.is_empty()) {
        issues.push("该推理控制方式暂无内置映射，请确认 Responses 支持的档位".into());
    }
    if caps.contains("reasoning") {
        collect_issue(&mut issues, efforts(p).map(|_| ()));
    }
    let settings = &p["clientReasoning"];
    let budget = &p["reasoning"]["budget"];
    if matches!((budget["min"].as_u64(),budget["max"].as_u64()),(Some(min),Some(max)) if min > max)
    {
        issues.push("接口的有效最小预算不能超过最大预算".into());
    }
    if let Some(default) = settings["defaultBudget"].as_u64() {
        if budget["min"].as_u64().is_some_and(|min| default < min)
            || budget["max"].as_u64().is_some_and(|max| default > max)
        {
            issues.push("客户端默认预算超出有效供给范围".into());
        }
    }
    if !settings["defaultBudget"].is_null() {
        issues.push("当前 Codex × Responses 组合尚未实现默认推理预算映射".into());
    }
    if suppliers::compatible(identity) {
        collect_issue(&mut issues, require_tool_form(p, "custom"));
        if !p["contextWindow"].as_u64().is_some_and(|v| v > 0) {
            issues.push("请确认模型上下文限制".into());
        }
    }
    issues
}

pub fn catalog_entry(snapshot: &Value, name: &str, p: &Value) -> Result<(Value, Value)> {
    let (original, entry, issues) = inspect_catalog_entry(snapshot, name, p);
    if let Some(message) = issues.first() {
        bail!("{message}");
    }
    Ok((original, entry))
}

fn inspect_catalog_entry(snapshot: &Value, name: &str, p: &Value) -> (Value, Value, Vec<String>) {
    let mut issues = Vec::new();
    if nonempty(&p["sourceError"]) {
        issues.push(text(&p["sourceError"]).to_owned());
    }
    issues.extend(profile_issues(p));
    let identity = text(&p["identity"]);
    let native = crate::catalog::official(snapshot).find(|m| m["slug"] == identity);
    let supports_search = p["supportsSearchTool"].as_bool().unwrap_or_else(|| {
        native
            .and_then(|m| m["supports_search_tool"].as_bool())
            .unwrap_or(
                identity.eq_ignore_ascii_case("deepseek-flash") || !suppliers::compatible(identity),
            )
    });
    let use_native = native.is_some();
    if !use_native && !suppliers::compatible(identity) {
        issues.push(format!("实际模型身份未知或尚未实现: {identity}"));
    }
    let empty = json!({});
    let original = if use_native {
        native.unwrap()
    } else if suppliers::compatible(identity) {
        crate::catalog::official(snapshot).next().unwrap_or(&empty)
    } else {
        &empty
    };
    if array(&snapshot["catalog"]["models"]).is_empty() {
        issues.push("本机 Codex 目录为空，模型定义尚不能确认".into());
    }
    if !use_native && !suppliers::compatible(identity) {
        return (
            Value::Null,
            json!({"slug":name,"supports_search_tool":supports_search,"display_name":p.get("description").filter(|v| nonempty(v)).unwrap_or(&json!(name))}),
            issues,
        );
    }
    let mut out = original.clone();
    collect_issue(&mut issues, require_tool_form(p, "function"));
    if !use_native || original["apply_patch_tool_type"] == "freeform" {
        collect_issue(&mut issues, require_tool_form(p, "custom"));
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
            "base_instructions",
            "model_messages",
        ] {
            out.as_object_mut().unwrap().remove(key);
        }
        out["description"] = json!(format!(
            "CableTidy Responses adapter for {identity}; model validation is separate."
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
    out["supports_search_tool"] = json!(supports_search);
    if use_native
        && !nonempty(&out["base_instructions"])
        && !nonempty(&out["model_messages"]["instructions_template"])
    {
        issues.push("原生模型缺少完整指令定义".into());
    }
    let caps = crate::model::capabilities(p);
    out["input_modalities"] = if p["inputModalities"].is_array()
        && !array(&p["inputModalities"]).contains(&json!("text"))
    {
        Value::Null
    } else if caps.contains("vision")
        && array(&p["inputModalities"]).contains(&json!("image"))
        && (!use_native || array(&original["input_modalities"]).contains(&json!("image")))
    {
        json!(["text", "image"])
    } else {
        json!(["text"])
    };
    match context_windows(original, p, use_native) {
        Ok((window, max)) => {
            out["context_window"] = json!(window);
            out["max_context_window"] = json!(max);
        }
        Err(error) => {
            issues.push(error.to_string());
            out["context_window"] = Value::Null;
            out["max_context_window"] = Value::Null;
        }
    }
    if !caps.contains("reasoning") {
        out["supported_reasoning_levels"] = json!([]);
        out["default_reasoning_level"] = Value::Null;
    } else if !use_native || !array(&p["reasoning"]["efforts"]).is_empty() {
        let efforts = match efforts(p) {
            Ok(levels) => levels,
            Err(error) => {
                issues.push(error.to_string());
                vec![]
            }
        };
        if efforts.is_empty() {
            issues.push("请声明已支持的 Responses 推理档位；预算转换尚未开放".into());
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
            issues.push("供给推理档位与原生定义无交集".into());
        }
        out["supported_reasoning_levels"] = if efforts.is_empty() {
            Value::Null
        } else {
            json!(efforts
                .iter()
                .map(|e| json!({"effort":e,"description":e}))
                .collect::<Vec<_>>())
        };
        out["default_reasoning_level"] = json!(efforts
            .iter()
            .find(|e| e.as_str() == text(&original["default_reasoning_level"]))
            .or_else(|| efforts.first()));
    }
    out["supports_parallel_tool_calls"] = json!(caps.contains("parallel_tool_calls"));
    if nonempty(&p["description"]) {
        out["display_name"] = p["description"].clone();
    }
    if nonempty(&p["promptModel"]) {
        if let Some(prompt) =
            crate::catalog::official(snapshot).find(|m| m["slug"] == p["promptModel"])
        {
            let metadata = prompt_metadata(snapshot, prompt);
            if !nonempty(&metadata["text"]) {
                issues.push("所选原生模型没有完整提示词".into());
            }
            if nonempty(&p["promptHash"]) && p["promptHash"] != metadata["hash"] {
                issues.push("所选原生模型提示词已更新，请刷新目录并重新确认提示词".into());
            }
            // Instructions may name tools or rely on a specific execution mode. Keep
            // actual-model capabilities intact and reject incompatible instruction contracts.
            for key in [
                "shell_type",
                "apply_patch_tool_type",
                "tool_mode",
                "multi_agent_version",
            ] {
                if !prompt[key].is_null() && prompt[key] != out[key] {
                    issues.push(format!("所选提示词的 {key} 与当前模型适配不兼容"));
                }
            }
            if prompt["apply_patch_tool_type"] == "freeform" {
                collect_issue(&mut issues, require_tool_form(p, "custom"));
            }
            for key in ["base_instructions", "model_messages"] {
                out.as_object_mut().unwrap().remove(key);
                if let Some(value) = prompt.get(key) {
                    out[key] = value.clone();
                }
            }
        } else {
            issues.push("所选提示词不在本机 Codex 原生模型目录中，请重新选择".into());
        }
    }
    (original.clone(), out, issues)
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
    if text(&p["identity"]).starts_with("deepseek-")
        || text(&p["identity"]).eq_ignore_ascii_case("MiniMax-M3")
    {
        let identity = text(&p["identity"]);
        let enabled = identity.eq_ignore_ascii_case("MiniMax-M3")
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

/// Preview the same model definition used by apply, without saving a Cable or
/// exposing credentials, the full instruction text, or unrelated model records.
pub fn preview_binding(c: &Value, snapshot: &Value, name: &str, binding: &Value) -> Value {
    let mut issues = Vec::new();
    if name.trim().is_empty() || name.chars().any(char::is_whitespace) {
        issues.push("请填写有效的客户端模型 ID".to_owned());
    }
    let sources = array(&binding["sources"]);
    let mut profile = Value::Null;
    let mut entry = json!({"slug":name,"display_name":binding.get("name").filter(|v| nonempty(v)).unwrap_or(&json!(name))});
    if sources.len() != 1 {
        issues.push("请选择一个上游模型与访问接口".into());
    } else {
        let cable = json!({"suppliers":[sources[0]["supplierId"]]});
        match suppliers::profile(c, &cable, binding) {
            Ok(value) => {
                profile = value;
                if profile["sourceEnabled"] == false {
                    issues.push("来源已停用，当前供应商或模型不可用".into());
                }
                let (_, model, errors) = inspect_catalog_entry(snapshot, name, &profile);
                entry = model;
                issues.extend(errors);
            }
            Err(error) => issues.push(format!("{error:#}")),
        }
    }
    let prompt = if nonempty(&binding["promptModel"]) {
        binding["promptModel"].clone()
    } else if binding["promptStrategy"] == "selected"
        || suppliers::compatible(text(&profile["identity"]))
    {
        Value::Null
    } else {
        profile["identity"].clone()
    };
    let mut unique = Vec::new();
    for issue in issues {
        if !unique.contains(&issue) {
            unique.push(issue);
        }
    }
    json!({"available":unique.is_empty(),"issues":unique,
        "preview":{"sourceVersion":snapshot["version"],"prompt":prompt,
        "context":{"supplyContextWindow":profile["contextWindow"],"supplyMaxOutputTokens":profile["maxOutputTokens"],
            "windowSource":if binding["codex"]["contextWindow"].is_null() { "客户端默认策略（受供给与窗口上限约束）" } else { "Cable 模型设置" },
            "maxSource":if binding["codex"]["maxContextWindow"].is_null() { "客户端默认策略（受供给限制）" } else { "Cable 模型设置" }},
        "model":{"slug":entry["slug"],"display_name":entry["display_name"],
            "context_window":entry["context_window"],"max_context_window":entry["max_context_window"],
            "input_modalities":entry["input_modalities"],
            "supports_parallel_tool_calls":entry["supports_parallel_tool_calls"],
            "supports_search_tool":entry["supports_search_tool"],
            "supported_reasoning_levels":entry["supported_reasoning_levels"],
            "default_reasoning_level":entry["default_reasoning_level"],
            "shell_type":entry["shell_type"],"apply_patch_tool_type":entry["apply_patch_tool_type"],
            "tool_mode":entry["tool_mode"]}}})
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
            Err(e) => bail!("默认模型不可用: {e:#}"),
        };
        if suppliers::compatible(text(&profile["identity"])) {
            warnings.push(format!("{name}: 兼容规则开放直接函数工具、apply_patch 及 Responses 网页搜索透传；不发布客户端特殊 tool_search 与 multi_agent_v1，相关旧会话需新建。"));
            warnings.push(format!(
                "{name}: 使用所选 Codex 原生提示词；真实模型验证状态: {}",
                profile["validation"].as_str().unwrap_or("未实测")
            ));
        }
        names.push(name.clone());
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
                    bail!("当前兼容适配不支持旧多代理历史，请新建会话");
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
                // Hosted Responses search is executed by the upstream service. Preserve
                // its mode/options; model identity alone cannot establish API support.
                if compatible
                    && !["function", "web_search", "web_search_preview"].contains(&kind)
                    && !(kind == "custom" && name == "apply_patch")
                {
                    bail!("当前兼容适配支持 function、apply_patch 自定义工具及 Responses 网页搜索；尚未适配工具类型 {kind}");
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
