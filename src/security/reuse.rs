use crate::config::text;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};

pub(super) const LIMITATIONS: &[&str] = &[
    "unsupported_tool_arguments",
    "unsupported_tool",
    "shell_nesting_limit",
    "unsupported_shell_syntax",
    "unsupported_shell_wrapper",
    "external_script_not_inspected",
    "command_semantics_not_inspected",
    "dynamic_code_not_inspected",
];

pub(super) struct Reuse {
    pub dependency: String,
    pub current: Option<Value>,
    pub cached: serde_json::Map<String, Value>,
    pub pending: serde_json::Map<String, Value>,
    units: HashMap<String, Value>,
    inspected: BTreeSet<u64>,
    reused: BTreeSet<u64>,
    pub checks: usize,
    pub hits: usize,
    bytes: usize,
}
impl Reuse {
    pub fn new(prepared: Value, dependency: String) -> Self {
        Self {
            dependency,
            current: None,
            units: prepared["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| (text(&item["location"]).into(), item.clone()))
                .collect(),
            cached: prepared["cache"].as_object().unwrap().clone(),
            pending: serde_json::Map::new(),
            inspected: BTreeSet::new(),
            reused: BTreeSet::new(),
            checks: 0,
            hits: 0,
            bytes: 0,
        }
    }
    pub fn enter(&mut self, location: &str) {
        if let Some(unit) = self.units.get(location) {
            self.current = Some(unit.clone());
        }
    }
    pub fn leave(&mut self, location: &str) {
        if self
            .current
            .as_ref()
            .is_some_and(|unit| unit["location"] == location)
        {
            self.current = None;
        }
    }
    pub fn key(&self, kind: &str, input: &Value, stage: &str, location: &str) -> Option<String> {
        let unit = self.current.as_ref()?;
        let relative = location.strip_prefix(text(&unit["location"]))?;
        Some(format!(
            "{:x}",
            Sha256::digest(json!([unit["fingerprint"], kind, input, stage, relative]).to_string())
        ))
    }
    pub fn counted(&mut self, hit: bool) {
        let index = self.current.as_ref().unwrap()["index"].as_u64().unwrap();
        if hit {
            self.hits += 1;
            self.reused.insert(index);
        } else {
            self.checks += 1;
            self.inspected.insert(index);
        }
    }
    pub fn remember(&mut self, key: String, result: Value) {
        let bytes = key.len() + result.to_string().len();
        if self.pending.len() < 4096
            && bytes <= super::store::MAX_RECORD
            && self.bytes + bytes <= super::history::MAX_INDEX_BYTES
        {
            self.bytes += bytes;
            self.pending.insert(key, result);
        }
    }
    pub fn statistics(&self) -> Value {
        json!({"inspectedUnits":self.inspected.len(),"reusedUnits":self.reused.difference(&self.inspected).count(),"ruleChecks":self.checks,"reusedRuleChecks":self.hits})
    }
    pub fn entries(&self) -> Value {
        json!(self
            .pending
            .iter()
            .map(|(key, result)| json!({"key":key,"result":result}))
            .collect::<Vec<_>>())
    }
}
