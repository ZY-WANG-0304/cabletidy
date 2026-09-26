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
    }
    if !a["catalogPlan"]["catalog"].is_null() {
        warnings.push(json!("模型目录覆盖作用于当前 Codex 配置，不按 provider 隔离；切换到其他 provider 前需恢复官方定义或原目录。重新启动 Codex 后读取更新。"));
        let mut catalog = a["catalogPlan"]["catalog"].clone();
        if !previous_catalog.is_null() {
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
    let provider_doc: DocumentMut = text(&a["providerContents"]).parse()?;
    if doc.get("model_providers").is_none() {
        let mut table = Table::new();
        table.set_implicit(true);
        doc["model_providers"] = Item::Table(table);
    }
    let providers = doc["model_providers"]
        .as_table_like_mut()
        .context("model_providers must be a table")?;
    providers.insert(provider, provider_doc["model_providers"][provider].clone());
    let root = format!("{}\n", doc.to_string().trim_end());
    let _: DocumentMut = root.parse()?;
    files.insert(0, json!({"path":"config.toml","contents":root}));
    a["files"] = json!(files);
    a["rootBefore"] = json!(existing);
    a["codexHome"] = json!(o.codex_home);
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
    let result = async {
        if let Some(state) = staged.get("catalogState") {
            backup(&state_file, &o.paths.backups, "codex-catalog-state.json").await?;
            write_json(&state_file, state).await?;
        }
        backup(&root, &o.paths.backups, "codex-config.toml").await?;
        atomic_write(&root, text(&staged["files"][0]["contents"]).as_bytes()).await
    }
    .await;
    if let Err(e) = result {
        if staged.get("catalogState").is_some() {
            if let Some(previous) = previous_state {
                atomic_write(&state_file, previous.as_bytes()).await?;
            } else {
                let _ = tokio::fs::remove_file(&state_file).await;
            }
        }
        return Err(e);
    }
    applied.insert(0, root);
    Ok(
        json!({"applied":applied,"environment":staged["environment"],"mode":staged["mode"],"warnings":staged["warnings"],"catalogSummary":staged["catalogSummary"]}),
    )
}
