use super::{digest, Options};
use crate::config::{array, atomic_write, backup, read_json, read_optional, text, write_json};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use toml_edit::{DocumentMut, Item, Table};
const STATE: &str = ".cabletidy-model-catalog.json";
fn root_set(doc: &mut DocumentMut, key: &str, v: &Value) -> Result<()> {
    if v.is_null() {
        doc.remove(key);
        return Ok(());
    }
    doc[key] = if let Some(s) = v.as_str() {
        toml_edit::value(s)
    } else if let Some(n) = v.as_i64() {
        toml_edit::value(n)
    } else if let Some(b) = v.as_bool() {
        toml_edit::value(b)
    } else {
        bail!("Unsupported root setting: {key}")
    };
    Ok(())
}
pub async fn stage(mut a: Value, o: &Options) -> Result<Value> {
    let existing = read_optional(&o.codex_home.join("config.toml"))
        .await?
        .unwrap_or_default();
    let mut doc: DocumentMut = existing
        .parse()
        .context("Invalid Codex config.toml; the file was left unchanged")?;
    let current: Value = toml_edit::de::from_str(&existing)?;
    let saved = read_json(&o.codex_home.join(STATE))
        .await?
        .unwrap_or(Value::Null);
    let owns = saved["version"] == 1
        && non_null_equal(&current["model_catalog_json"], &saved["managedPath"]);
    let previous_catalog = if owns {
        saved["previousCatalog"].clone()
    } else {
        current["model_catalog_json"].clone()
    };
    let previous_context = if owns && current["model_context_window"].is_null() {
        saved["previousContext"].clone()
    } else {
        current["model_context_window"].clone()
    };
    let mut warnings = array(&a["catalogPlan"]["warnings"]).to_vec();
    let mut files = Vec::new();
    let mut state = None;
    root_set(&mut doc, "model_provider", &a["providerId"])?;
    if !a["clientModelId"].is_null() {
        root_set(&mut doc, "model", &a["clientModelId"])?;
    } else if a["managedModels"] == true {
        doc.remove("model");
        warnings.push(json!("线路未指定默认模型，请在 Codex 中选择已开放的模型。"));
    }
    if !a["catalogPlan"]["catalog"].is_null() {
        if a["managedModels"] == true {
            if !current["model_instructions_file"].is_null() {
                bail!(
                    "根级 model_instructions_file 会覆盖模型提示词，请移除该设置或使用隔离启动配置"
                );
            }
            if !current["model_reasoning_effort"].is_null() {
                warnings.push(json!("现有 model_reasoning_effort 会覆盖逐模型默认推理档位；需要沿用模型设置时请清除该全局配置。"));
            }
            if !a["webSearch"].is_null() {
                if !crate::config::CODEX_WEB_SEARCH_MODES.contains(&text(&a["webSearch"])) {
                    bail!("不支持的 Codex 网页搜索方式");
                }
                root_set(&mut doc, "web_search", &a["webSearch"])?;
            }
        }
        warnings.push(json!("模型目录覆盖作用于当前 Codex 配置，不按 provider 隔离；切换到其他 provider 前需恢复官方定义或原目录。重新启动 Codex 后读取更新。"));
        let mut catalog = a["catalogPlan"]["catalog"].clone();
        if !previous_catalog.is_null() && a["catalogPlan"]["explicitModels"] != true {
            let path = previous_catalog
                .as_str()
                .context("现有 model_catalog_json 必须为路径字符串")?;
            let path = std::path::PathBuf::from(path);
            let path = if path.is_absolute() {
                path
            } else {
                o.codex_home.join(path)
            };
            let mut previous = read_json(&path)
                .await?
                .context("Cannot read the existing model catalog")?;
            crate::catalog::validate(&previous)?;
            let present: std::collections::HashSet<_> = array(&previous["models"])
                .iter()
                .map(|m| text(&m["slug"]).to_owned())
                .collect();
            for model in previous["models"].as_array_mut().unwrap() {
                if array(&a["catalogPlan"]["models"]).contains(&model["slug"]) {
                    if let Some(replacement) = array(&catalog["models"])
                        .iter()
                        .find(|m| m["slug"] == model["slug"])
                    {
                        *model = replacement.clone();
                    }
                }
            }
            for model in array(&catalog["models"]) {
                if !present.contains(text(&model["slug"])) {
                    previous["models"]
                        .as_array_mut()
                        .unwrap()
                        .push(model.clone());
                }
            }
            catalog = previous;
            warnings.push(json!("已保留原模型目录的其他条目；当前模型的覆盖在 Codex 配置中是全局的，不按 provider 隔离。"));
        }
        let contents = format!("{}\n", serde_json::to_string_pretty(&catalog)?);
        let relative = format!(
            "model-catalogs/cabletidy-{}.json",
            &digest(contents.as_bytes())[..24]
        );
        let managed_path = o.codex_home.join(&relative);
        root_set(&mut doc, "model_catalog_json", &json!(managed_path))?;
        doc.remove("model_context_window");
        state = Some(
            json!({"version":1,"sourceVersion":a["catalogPlan"]["sourceVersion"],"managedPath":managed_path,"previousCatalog":previous_catalog,"previousContext":previous_context}),
        );
        files.push(json!({"path":relative,"contents":contents,"kind":"json"}));
        if !current["model_context_window"].is_null() {
            warnings.push(json!(
                "将暂时移除根级 model_context_window，使逐模型窗口生效；返回官方默认模式时恢复。"
            ));
        }
    } else if owns {
        root_set(&mut doc, "model_catalog_json", &previous_catalog)?;
        if current["model_context_window"].is_null() {
            root_set(&mut doc, "model_context_window", &previous_context)?;
        }
        state = Some(Value::Null);
    }
    for key in [
        "model_instructions_file",
        "model_auto_compact_token_limit",
        "model_supports_reasoning_summaries",
    ] {
        if !current[key].is_null() {
            warnings.push(json!(format!(
                "保留现有 {key}，该用户配置仍会影响 Codex 行为。"
            )));
        }
    }
    if a["catalogPlan"]["catalog"].is_null() {
        if !previous_catalog.is_null() {
            warnings.push(json!(
                "保留现有 model_catalog_json；Codex 将继续使用用户的模型目录。"
            ));
        }
        if !previous_context.is_null() {
            warnings.push(json!(
                "保留现有 model_context_window，它会覆盖模型目录中的上下文窗口。"
            ));
        }
    }
    let provider = text(&a["providerId"]);
    let activation = read_json(&o.codex_home.join(ACTIVATION))
        .await?
        .unwrap_or(Value::Null);
    if activation["cableId"].is_string() && activation["cableId"] != a["cableId"] {
        warnings.push(json!(format!(
            "应用将把当前激活的 Cable {} 切换为 {}，正在运行的旧会话继续使用原地址。",
            text(&activation["cableId"]),
            text(&a["cableId"])
        )));
    }
    let provider_doc: DocumentMut = text(&a["providerContents"]).parse()?;
    if doc.get("model_providers").is_none() {
        let mut table = Table::new();
        table.set_implicit(true);
        doc["model_providers"] = Item::Table(table);
    }
    let providers = doc["model_providers"]
        .as_table_like_mut()
        .context("model_providers must be a table")?;
    let old_provider = text(&activation["providerId"]);
    if activation["cableId"] == a["cableId"]
        && !old_provider.is_empty()
        && old_provider != provider
        && owned_snapshot(&current, activation["after"].get("web_search").is_some())
            == activation["after"]
        && current["model_providers"][old_provider] == activation["providerAfter"]
    {
        if activation["providerBefore"].is_null() {
            providers.remove(old_provider);
        } else {
            let original: DocumentMut = text(&activation["rootBefore"]).parse()?;
            providers.insert(
                old_provider,
                original["model_providers"][old_provider].clone(),
            );
        }
    }
    providers.insert(provider, provider_doc["model_providers"][provider].clone());
    let root = format!("{}\n", doc.to_string().trim_end());
    let _: DocumentMut = root.parse()?;
    files.insert(0, json!({"path":"config.toml","contents":root}));
    a["files"] = json!(files);
    a["rootBefore"] = json!(existing);
    if let Some(state) = state {
        a["catalogState"] = state;
    }
    let mut distinct = Vec::new();
    for w in warnings {
        if !distinct.contains(&w) {
            distinct.push(w);
        }
    }
    a["warnings"] = json!(distinct);
    a["catalogSummary"] = json!({"sourceVersion":a["catalogPlan"]["sourceVersion"],"mode":if a["catalogPlan"]["catalog"].is_null(){"official"}else{"managed"},"overrides":a["catalogPlan"]["overrides"]});
    Ok(a)
}
fn non_null_equal(a: &Value, b: &Value) -> bool {
    !a.is_null() && a == b
}
pub async fn apply(a: &Value, o: &Options) -> Result<Value> {
    if a["format"] != "codex.config.toml.v1"
        || a["target"] != "codex"
        || !crate::config::nonempty(&a["providerId"])
        || !a["providerContents"].is_string()
    {
        bail!("Unsupported Codex artifacts");
    }
    let staged = stage(a.clone(), o).await?;
    let root = o.codex_home.join("config.toml");
    let state_file = o.codex_home.join(STATE);
    let previous_state = read_optional(&state_file).await?;
    let activation_path = o.codex_home.join(ACTIVATION);
    let previous_activation = read_json(&activation_path).await?.unwrap_or(Value::Null);
    let mut applied = Vec::new();
    for f in array(&staged["files"]).iter().skip(1) {
        let rel = std::path::Path::new(text(&f["path"]));
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            bail!("Codex artifact 文件路径不安全");
        }
        let target = o.codex_home.join(rel);
        backup(&target, &o.paths.backups, "codex-model-catalog.json").await?;
        atomic_write(&target, text(&f["contents"]).as_bytes()).await?;
        applied.push(target);
    }
    if read_optional(&root).await?.unwrap_or_default() != text(&staged["rootBefore"]) {
        bail!("Codex 配置在应用期间已改变，请重新预览并重试");
    }
    let before: Value = toml_edit::de::from_str(text(&staged["rootBefore"]))?;
    let after: Value = toml_edit::de::from_str(text(&staged["files"][0]["contents"]))?;
    let same = previous_activation["cableId"] == staged["cableId"]
        && previous_activation["after"]
            == owned_snapshot(
                &before,
                previous_activation["after"].get("web_search").is_some(),
            );
    let provider = text(&staged["providerId"]);
    let mut activation = if same {
        json!({"cableId":staged["cableId"],"providerId":provider,"before":previous_activation["before"],"after":owned_snapshot(&after, !staged["webSearch"].is_null()),"rootBefore":previous_activation["rootBefore"],"providerBefore":previous_activation["providerBefore"],"providerAfter":after["model_providers"][provider],"catalogBefore":previous_activation["catalogBefore"],"previousActivation":previous_activation["previousActivation"]})
    } else {
        json!({"cableId":staged["cableId"],"providerId":provider,"before":owned_snapshot(&before, !staged["webSearch"].is_null()),"after":owned_snapshot(&after, !staged["webSearch"].is_null()),"rootBefore":staged["rootBefore"],"providerBefore":before["model_providers"][provider],"providerAfter":after["model_providers"][provider],"catalogBefore":previous_state.as_ref().and_then(|s|serde_json::from_str::<Value>(s).ok()).unwrap_or(Value::Null),"previousActivation":previous_activation})
    };
    if staged["webSearch"].is_null() {
        activation["before"]
            .as_object_mut()
            .unwrap()
            .remove("web_search");
    } else if activation["before"].get("web_search").is_none() {
        activation["before"]["web_search"] = before["web_search"].clone();
    }
    activation["sourceConfigHash"] = staged["sourceConfigHash"].clone();
    if same && previous_activation["providerId"] != provider {
        activation["providerBefore"] = before["model_providers"][provider].clone();
        activation["rootBefore"] = staged["rootBefore"].clone();
    }
    let track_activation = a["managedModels"] == true || previous_activation.is_object();
    let result = async {
        if let Some(state) = staged.get("catalogState") {
            backup(&state_file, &o.paths.backups, "codex-catalog-state.json").await?;
            write_json(&state_file, state).await?;
        }
        if track_activation {
            write_json(&activation_path, &activation).await?;
        }
        backup(&root, &o.paths.backups, "codex-config.toml").await?;
        atomic_write(&root, text(&staged["files"][0]["contents"]).as_bytes()).await
    }
    .await;
    if let Err(e) = result {
        if staged.get("catalogState").is_some() {
            restore_optional(&state_file, previous_state.as_deref()).await?;
        }
        if track_activation {
            if previous_activation.is_null() {
                restore_optional(&activation_path, None).await?;
            } else {
                write_json(&activation_path, &previous_activation).await?;
            }
        }
        return Err(e);
    }
    applied.insert(0, root);
    Ok(
        json!({"applied":applied,"environment":staged["environment"],"mode":staged["mode"],"warnings":staged["warnings"],"catalogSummary":staged["catalogSummary"]}),
    )
}

// Preserve a complete before/after snapshot only for the fields this Cable owns.
pub(crate) const ACTIVATION: &str = ".cabletidy-active-cable.json";

// Rename tracking only. The client config and its recorded provider remain unchanged until apply.
pub async fn renamed_activation(o: &Options, old_id: &str, new_id: &str) -> Result<Option<Value>> {
    let Some(mut saved) = read_json(&o.codex_home.join(ACTIVATION)).await? else {
        return Ok(None);
    };
    let mut changed = false;
    let mut cursor = &mut saved;
    while cursor.is_object() {
        if cursor["cableId"] == old_id {
            cursor["cableId"] = json!(new_id);
            changed = true;
        }
        let Some(previous) = cursor.get_mut("previousActivation") else {
            break;
        };
        cursor = previous;
    }
    Ok(changed.then_some(saved))
}
const OWNED_ROOT: &[&str] = &[
    "model_provider",
    "model",
    "model_catalog_json",
    "model_context_window",
    "web_search",
];
fn owned_snapshot(value: &Value, owns_search: bool) -> Value {
    let mut out = serde_json::Map::new();
    for key in OWNED_ROOT {
        if *key == "web_search" && !owns_search {
            continue;
        }
        out.insert((*key).into(), value[*key].clone());
    }
    Value::Object(out)
}

// Track the applied line and its resolved model facts, without persisting credentials.
pub fn source_config_hash(config: &Value, cable_id: &str) -> String {
    let cable = &config["cables"][cable_id];
    let provider = &config["virtualProviders"][text(&cable["virtualProvider"])];
    let snapshot = json!({"cable":cable,"models":provider["models"],"baseUrl":crate::config::base_url(config, cable_id)});
    digest(snapshot.to_string().as_bytes())
}

pub async fn activation_status(o: &Options, config: &Value) -> Result<Value> {
    let Some(saved) = read_json(&o.codex_home.join(ACTIVATION)).await? else {
        return Ok(json!({"status":"unmanaged"}));
    };
    let current = read_optional(&o.codex_home.join("config.toml"))
        .await?
        .unwrap_or_default();
    let value: Value = toml_edit::de::from_str(&current)?;
    let matches = owned_snapshot(&value, saved["after"].get("web_search").is_some())
        == saved["after"]
        && value["model_providers"][text(&saved["providerId"])] == saved["providerAfter"];
    let needs_update =
        saved["sourceConfigHash"] != source_config_hash(config, text(&saved["cableId"]));
    Ok(
        json!({"cableId":saved["cableId"],"providerId":saved["providerId"],"status":if matches {"active"} else {"modified"},
        "usingCable":value["model_provider"] == saved["providerId"],"needsUpdate":needs_update}),
    )
}

pub async fn restore_cable(cable_id: &str, o: &Options) -> Result<Value> {
    let state_path = o.codex_home.join(ACTIVATION);
    let saved = read_json(&state_path)
        .await?
        .context("没有可撤销的 Codex 接入记录")?;
    if saved["cableId"] != cable_id {
        anyhow::bail!("当前 Codex 配置由其他 Cable 激活，撤销此线路不会覆盖它");
    }
    let root = o.codex_home.join("config.toml");
    let before = read_optional(&root).await?.unwrap_or_default();
    let value: Value = toml_edit::de::from_str(&before)?;
    if owned_snapshot(&value, saved["after"].get("web_search").is_some()) != saved["after"] {
        anyhow::bail!("Codex 管理字段已被用户修改，保留当前配置；请先核对后手动恢复");
    }
    let mut doc: DocumentMut = before.parse()?;
    for key in OWNED_ROOT {
        if *key == "web_search" && saved["before"].get("web_search").is_none() {
            continue;
        }
        root_set(&mut doc, key, &saved["before"][*key])?;
    }
    let provider = text(&saved["providerId"]);
    if value["model_providers"][provider] != saved["providerAfter"] {
        anyhow::bail!("Codex provider 配置已修改，不能自动撤销");
    }
    if let Some(providers) = doc
        .get_mut("model_providers")
        .and_then(Item::as_table_like_mut)
    {
        if saved["providerBefore"].is_null() {
            providers.remove(provider);
        } else {
            let parsed: DocumentMut = text(&saved["rootBefore"]).parse()?;
            providers.insert(provider, parsed["model_providers"][provider].clone());
        }
    }
    if read_optional(&root).await?.unwrap_or_default() != before {
        anyhow::bail!("Codex 配置已变化，请重新撤销");
    }
    backup(&root, &o.paths.backups, "codex-restore.toml").await?;
    let catalog_path = o.codex_home.join(STATE);
    let catalog_current = read_optional(&catalog_path).await?;
    let result = async {
        if saved["catalogBefore"].is_null() {
            restore_optional(&catalog_path, None).await?;
        } else {
            write_json(&catalog_path, &saved["catalogBefore"]).await?;
        }
        if saved["previousActivation"].is_null() {
            restore_optional(&state_path, None).await?;
        } else {
            write_json(&state_path, &saved["previousActivation"]).await?;
        }
        atomic_write(
            &root,
            format!("{}\n", doc.to_string().trim_end()).as_bytes(),
        )
        .await
    }
    .await;
    if let Err(e) = result {
        restore_optional(&catalog_path, catalog_current.as_deref()).await?;
        write_json(&state_path, &saved).await?;
        return Err(e);
    }
    Ok(json!({"restored":true,"applied":[root],"mode":"restored"}))
}

async fn restore_optional(path: &std::path::Path, contents: Option<&str>) -> Result<()> {
    if let Some(contents) = contents {
        atomic_write(path, contents.as_bytes()).await?;
    } else {
        match tokio::fs::remove_file(path).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
