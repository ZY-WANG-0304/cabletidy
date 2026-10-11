use crate::config::{array, text};
use serde_json::{json, Value};

pub(super) fn limitation(reason: &str) -> bool {
    matches!(
        reason,
        "non_text_or_reasoning_semantics"
            | "reasoning_content_not_inspected"
            | "non_text_content"
            | "opaque_content"
            | "unsupported_tool"
            | "unsupported_tool_arguments"
            | "unsupported_shell_syntax"
            | "unsupported_shell_wrapper"
            | "external_script_not_inspected"
            | "command_semantics_not_inspected"
            | "dynamic_code_not_inspected"
            | "historical_context_not_visible"
    )
}

pub(super) fn classify(record: &mut Value) {
    if record["outcome"] == "interrupted" && record["responseBodyState"] == "not_observed" {
        let mut reasons = array(&record["coverageReasons"]).to_vec();
        if !reasons.contains(&json!("request_interrupted")) {
            reasons.push(json!("request_interrupted"));
        }
        record["coverageReasons"] = json!(reasons);
    }
    if record["inspectionStatus"] == "partial" && array(&record["coverageReasons"]).is_empty() {
        record["coverageReasons"] = json!(["inspection_coverage_unknown"]);
    }
    let (limits, issues): (Vec<_>, Vec<_>) = array(&record["coverageReasons"])
        .iter()
        .cloned()
        .partition(|reason| limitation(text(reason)));
    if matches!(
        text(&record["inspectionStatus"]),
        "complete" | "partial" | "limited"
    ) {
        // Unknown reasons remain issues: new failure codes must not silently look complete.
        record["inspectionStatus"] = json!(if !issues.is_empty() {
            "partial"
        } else if !limits.is_empty() {
            "limited"
        } else {
            "complete"
        });
    }
    record["coverageLimitations"] = json!(limits);
    record["inspectionIssues"] = json!(issues);
}

pub(super) fn terminal_outcome(event: &str) -> Option<&'static str> {
    match event {
        "response.completed" | "message_stop" | "[DONE]" => Some("completed"),
        "response.failed" | "response.incomplete" | "error" => Some("stream_error"),
        _ => None,
    }
}

pub(super) fn apply_terminal(record: &mut Value, event: &str) {
    if let Some(outcome) = terminal_outcome(event) {
        record["responseTerminalEvent"] = json!(event);
        if record["httpStatus"].as_u64().is_some_and(|s| s < 400)
            && matches!(
                text(&record["outcome"]),
                "completed" | "interrupted" | "stream_error" | "unknown"
            )
        {
            record["outcome"] = json!(outcome);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coverage_limits_do_not_hide_missing_content_or_failures() {
        for (state, reasons, expected) in [
            ("complete", json!([]), "complete"),
            (
                "partial",
                json!(["unsupported_tool", "reasoning_content_not_inspected"]),
                "limited",
            ),
            (
                "complete",
                json!(["unsupported_tool", "body_not_complete"]),
                "partial",
            ),
            ("complete", json!(["future_failure"]), "partial"),
            ("failed", json!(["unsupported_tool"]), "failed"),
            ("running", json!(["unsupported_tool"]), "running"),
        ] {
            let mut r = json!({"inspectionStatus":state,"coverageReasons":reasons});
            classify(&mut r);
            assert_eq!(r["inspectionStatus"], expected);
            assert_eq!(
                array(&r["coverageLimitations"]).len() + array(&r["inspectionIssues"]).len(),
                array(&reasons).len()
            );
        }
        let mut unknown = json!({"inspectionStatus":"partial"});
        classify(&mut unknown);
        assert_eq!(unknown["inspectionStatus"], "partial");
        assert_eq!(
            unknown["inspectionIssues"],
            json!(["inspection_coverage_unknown"])
        );

        let mut canceled = json!({"outcome":"interrupted","responseBodyState":"not_observed","inspectionStatus":"complete","coverageReasons":["unsupported_tool"]});
        classify(&mut canceled);
        assert_eq!(canceled["inspectionStatus"], "partial");
        assert_eq!(canceled["inspectionIssues"], json!(["request_interrupted"]));
        assert_eq!(canceled["coverageLimitations"], json!(["unsupported_tool"]));
    }
}
