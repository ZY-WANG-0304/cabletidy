// Exercise the Rust library from the existing JavaScript contract tests.
// This binary is feature-gated and is never included in distributions.
use anyhow::{bail, Result};
use cabletidy::{
    catalog::{self, Catalog},
    config::{self, text, Paths},
    lifecycle, model,
    security::evidence,
    targets, validation,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::io::AsyncBufReadExt;

fn options(v: &Value) -> Result<targets::Options> {
    let mut paths = if let Some(home) = v["paths"]["home"].as_str() {
        Paths::new(PathBuf::from(home))
    } else {
        Paths::from_env()?
    };
    if let Some(backups) = v["paths"]["backups"].as_str() {
        paths.backups = PathBuf::from(backups);
    }
    let mut out = targets::Options::new(paths)?;
    if let Some(home) = v["codexHome"].as_str() {
        out.codex_home = std::path::absolute(home)?;
    }
    if let Some(home) = v["claudeHome"].as_str() {
        out.claude_home = std::path::absolute(home)?;
    }
    Ok(out)
}

async fn dispatch(command: &str, a: &[Value], catalog: &Catalog) -> Result<Value> {
    let empty = json!({});
    let x = a.first().unwrap_or(&empty);
    let y = a.get(1).unwrap_or(&empty);
    let z = a.get(2).unwrap_or(&empty);
    Ok(match command {
        "evidence.fixture" => evidence::fixture_projection(
            x, config::array(y), z, a.get(3) == Some(&json!(true)), a.get(4).and_then(Value::as_str),
        )?,
        "evidence.ranges" => evidence::content_ranges(text(x), y, text(z), a.get(3) == Some(&json!(true))),
        "evidence.associated" => json!(evidence::associated(x, y, z == &json!(true))),
        "evidence.record" => {
            let mut record = x.clone();
            evidence::normalize_record(&mut record);
            record
        }
        "evidence.legacy" => evidence::legacy_text(x, text(y), z),
        "evidence.body" => {
            let mut page = x.clone();
            evidence::normalize_body(&mut page, config::array(y), text(z));
            page
        }
        "evidence.selections" => evidence::risk_selections(config::array(x), text(y)),
        "config.defaults" => config::defaults(),
        "config.endpoints" => json!(config::entries(&x["cables"]).map(|(id, b)| {
            json!({"id":b["virtualProvider"],"baseUrl":format!("{}{}",config::base_url(x,id),if b["target"]=="claude-code" {""} else {"/v1"})})
        }).collect::<Vec<_>>()),
        "config.operation" => {
            cabletidy::config_operations::apply(x, y, &Catalog::fixture(z.clone())).await?
        }
        "claude.models" => {
            json!({"aliases": {"defaultModel":targets::claude::DEFAULT_MODEL_ALIASES,"subagent":targets::claude::SUBAGENT_MODEL_ALIASES,"families":targets::claude::MODEL_FAMILIES}})
        }
        "config.normalize" => config::normalize(x),
        "config.validate" => validation::validate(x),
        "config.public" => config::public(x, y),
        "config.diff" => config::diff(x, y),
        "config.secret" => json!(config::secret(x, y)),
        "config.secrets" => {
            let mut c = x.clone();
            let secrets = config::apply_secrets(&mut c, y, z);
            json!({"config":c,"secrets":secrets})
        }
        "config.write" => {
            config::write_json(std::path::Path::new(text(x)), y).await?;
            Value::Null
        }
        "model.resolve" => {
            let r = model::resolve(y, z.get("model"))?;
            let b = model::select(x, y, &r, z)?;
            json!({"clientModelId":r.client,"model":{"clientModelId":r.client,"matchedModel":r.matched_model,"profile":r.profile},"routeId":b.route,"upstream":b.upstream,"upstreamModelId":b.model,"capabilities":b.capabilities})
        }
        "model.models" => json!(model::models(y)),
        "catalog.public" => catalog::public(x),
        "catalog.plan" => catalog::plan(x, y, z)?,
        "catalog.entry" => {
            let (official, entry) = catalog::entry(x, text(y), z)?;
            json!({"official":official,"entry":entry})
        }
        "catalog.changed" => json!(catalog::changed_models(x, y)),
        "catalog.validateChanges" => {
            json!(catalog::validate_changes(x, y, &Catalog::fixture(z.clone())).await)
        }
        "catalog.load" => catalog.load(x["refresh"] == true).await?,
        "catalog.concurrent" => {
            let (left, right) = tokio::join!(catalog.load(false), catalog.load(false));
            json!([reply(left), reply(right)])
        }
        "artifacts.build" => targets::build(x, text(&y["cableId"]), z)?,
        "artifacts.prepare" => {
            let fixture = a.get(3).map(|snapshot| Catalog::fixture(snapshot.clone()));
            targets::prepare(
                x,
                text(&y["cableId"]),
                z,
                fixture.as_ref().unwrap_or(catalog),
                &options(y)?,
            )
            .await?
        }
        "artifacts.public" => targets::public(x),
        "artifacts.apply" => {
            targets::apply(x, &options(y)?, y["confirmationToken"].as_str()).await?
        }
        "codex.apply" => targets::codex::apply(x, &options(y)?).await?,
        "codex.restore" => targets::codex::restore_cable(text(x), &options(y)?).await?,
        "claude.restore" => {
            targets::restore(text(x), &options(y)?, y["confirmationToken"].as_str()).await?
        }
        "claude.home" => json!(options(x)?.claude_home),
        "toml.read" => toml_edit::de::from_str::<Value>(text(x))?,
        "process.startTime" => json!(lifecycle::start_time(x.as_u64().unwrap_or(0) as u32).await),
        "process.inspect" => json!(lifecycle::inspect(x).await),
        _ => bail!("Unknown test operation: {command}"),
    })
}

fn reply(result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"value":value}),
        Err(error) => {
            if let Some(e) = error.downcast_ref::<targets::claude::SettingsConflict>() {
                json!({"error":{"message":e.to_string(),"code":"claude_settings_conflict","details":{"fields":e.fields,"settingsPath":e.settings_path,"confirmationToken":e.confirmation_token}}})
            } else if let Some(e) = error.downcast_ref::<model::ResolveError>() {
                json!({"error":{"message":e.message,"code":e.code,"details":e.details,"name":"ModelResolveError"}})
            } else {
                json!({"error":{"message":error.to_string(),"cause":{"message":format!("{error:#}")}}})
            }
        }
    }
}

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    let catalog = Catalog::default();
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let request: Value = serde_json::from_str(&line)?;
        let result = dispatch(
            text(&request["command"]),
            config::array(&request["args"]),
            &catalog,
        )
        .await;
        println!("{}", reply(result));
    }
    Ok(())
}
