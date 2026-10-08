//! Bounded navigation metadata. Bodies remain the source of truth.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn identify_headers(record: &mut Value, headers: &Value) {
    for key in [
        "x-claude-code-session-id",
        "session-id",
        "session_id",
        "x-session-id",
        "x-codex-session-id",
        "thread-id",
    ] {
        // Prefer the native client's session header. Never use per-request or
        // context-window IDs to group a conversation.
        if key == "x-claude-code-session-id" && record["target"] != "claude-code" {
            continue;
        }
        if matches!(key, "session-id" | "thread-id") && record["target"] != "codex" {
            continue;
        }
        if let Some(id) = headers[key][0].as_str() {
            identify(record, id, key);
        }
    }
}

pub fn identify(record: &mut Value, id: &str, source: &str) {
    if record["kind"] != "request"
        || record["sessionKey"].is_string()
        || id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
    {
        return;
    }
    // IDs are scoped to a provider and protocol; account identifiers are never sessions.
    let scope = json!([record["providerId"], record["protocol"], id]);
    record["sessionKey"] = json!(format!("{:x}", Sha256::digest(scope.to_string())));
    record["sessionSource"] = json!(source);
}

#[derive(Default)]
struct Frame {
    field: String,
    kind: u8,
    value: String,
    preview: String,
    response_preview: String,
    role: String,
    item_type: String,
}

#[derive(Default)]
pub struct Capture {
    frames: Vec<Frame>,
}

fn append(to: &mut String, text: &str, limit: usize) {
    let mut end = text.len().min(limit.saturating_sub(to.len()));
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    to.push_str(&text[..end]);
}

impl Capture {
    pub fn start(&mut self, field: &str, kind: u8) {
        self.frames.push(Frame {
            field: field.into(),
            kind,
            ..Frame::default()
        });
    }
    pub fn text(&mut self, text: &str) {
        if let Some(f) = self.frames.last_mut() {
            if f.kind == b'"'
                && matches!(
                    f.field.as_str(),
                    "text" | "content" | "input" | "role" | "type" | "session_id" | "user_id"
                )
            {
                append(&mut f.value, text, 1024);
            }
        }
    }
    pub fn end(&mut self, record: &mut Value, root: &str) {
        let Some(mut f) = self.frames.pop() else {
            return;
        };
        if f.kind == b'k' {
            return;
        }
        if root == "request"
            && f.kind == b'"'
            && self.frames.len() == 2
            && self.frames.last().is_some_and(|p| p.field == "metadata")
        {
            if f.field == "session_id" {
                identify(record, &f.value, "metadata.session_id");
            }
            if f.field == "user_id" && record["target"] == "claude-code" {
                if let Ok(value) = serde_json::from_str::<Value>(&f.value) {
                    if let Some(id) = value["session_id"].as_str() {
                        identify(record, id, "metadata.user_id");
                    }
                } else if let Some((_, id)) = f.value.rsplit_once("_session_") {
                    if uuid::Uuid::parse_str(id).is_ok() {
                        identify(record, id, "metadata.user_id");
                    }
                }
            }
        }
        let tool = matches!(
            f.item_type.as_str(),
            "tool_result"
                | "function_call_output"
                | "custom_tool_call_output"
                | "tool_use"
                | "function_call"
                | "custom_tool_call"
        );
        let content = if f.kind == b'"' && matches!(f.field.as_str(), "text" | "content" | "input")
        {
            &f.value
        } else {
            &f.preview
        };
        if root == "request" {
            let message = f.role == "user"
                && self.frames.len() == 2
                && self
                    .frames
                    .last()
                    .is_some_and(|p| matches!(p.field.as_str(), "input" | "messages"));
            let plain_input = self.frames.len() == 1 && f.field == "input" && f.kind == b'"';
            if (message || plain_input) && !content.trim().is_empty() {
                let mut preview = String::new();
                append(&mut preview, content.trim(), 480);
                if record["sessionTitle"].is_null() {
                    let mut title = String::new();
                    append(&mut title, content.trim().lines().next().unwrap_or(""), 120);
                    record["sessionTitle"] = json!(title);
                }
                record["requestPreview"] = json!(preview);
            }
        } else if root == "response" || root.starts_with("stream/") {
            if tool {
                f.response_preview.clear();
            } else if f.kind == b'{'
                && (matches!(f.item_type.as_str(), "text" | "output_text")
                    || root.starts_with("stream/")
                        && self.frames.is_empty()
                        && f.item_type.is_empty())
                && !content.trim().is_empty()
            {
                f.response_preview.clear();
                append(&mut f.response_preview, content.trim(), 480);
            }
            // Propagate a bounded candidate through completed parents. Their
            // type may follow the text in JSON, so only the root can commit it.
            if self.frames.is_empty() && !f.response_preview.is_empty() {
                record["responsePreview"] = json!(f.response_preview);
            }
        }
        if let Some(parent) = self.frames.last_mut() {
            if f.field == "type" {
                parent.item_type = f.value.clone();
            }
            if f.field == "role" {
                parent.role = f.value.clone();
            }
            // Anthropic reports tool results inside a user-role message. Do not
            // present that content as a new instruction from the person.
            if !content.is_empty() && !tool {
                if !parent.preview.is_empty() {
                    append(&mut parent.preview, "\n", 480);
                }
                append(&mut parent.preview, content, 480);
            }
            if !f.response_preview.is_empty() {
                parent.response_preview = f.response_preview;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture(record: &mut Value, value: Value, root: &str) {
        use crate::streaming::{JsonStream, Node, Spool, Visitor};
        struct Adapter<'a> {
            capture: Capture,
            record: &'a mut Value,
            root: &'a str,
        }
        impl Visitor for Adapter<'_> {
            fn start(&mut self, _: &str, field: &str, kind: u8, _: u64) -> anyhow::Result<()> {
                self.capture.start(field, kind);
                Ok(())
            }
            fn text(&mut self, text: &str) -> anyhow::Result<()> {
                self.capture.text(text);
                Ok(())
            }
            fn end(&mut self, _: &Node) -> anyhow::Result<()> {
                self.capture.end(self.record, self.root);
                Ok(())
            }
        }
        let mut spool = Spool::new().unwrap();
        serde_json::to_writer(&mut spool, &value).unwrap();
        let spool = spool.seal().unwrap();
        JsonStream::new(spool.reader())
            .parse(
                &mut Adapter {
                    capture: Capture::default(),
                    record,
                    root,
                },
                root,
            )
            .unwrap();
    }

    #[test]
    fn summaries_preserve_roles_unicode_bounds_and_latest_observed_text() {
        let mut record = json!({"kind":"request","target":"codex"});
        capture(
            &mut record,
            json!({"input":[
                {"content":"修复输入状态\n这是补充上下文", "role":"user"},
                {"role":"assistant","content":"准备检查"},
                {"role":"user","content":[{"type":"text","text":"汉🙂".repeat(1000)}]},
            {"type":"function_call","arguments":"不要用工具参数充当用户输入"},
            {"role":"user","content":[{"content":"不要用工具结果充当用户输入", "type":"tool_result"}]}
            ]}),
            "request",
        );
        assert_eq!(record["sessionTitle"], "修复输入状态");
        assert!(record["requestPreview"].as_str().unwrap().len() <= 480);
        assert!(record["requestPreview"]
            .as_str()
            .unwrap()
            .starts_with("汉🙂"));
        capture(
            &mut record,
            json!({"output":[{"text":"较长的早期模型输出", "type":"output_text"}]}),
            "response",
        );
        capture(
            &mut record,
            json!({"output":[{"text":"最终输出", "type":"output_text"}]}),
            "response",
        );
        assert_eq!(record["responsePreview"], "最终输出");
        capture(&mut record, json!({"text":"流式文本摘要"}), "stream/test");
        assert_eq!(record["responsePreview"], "流式文本摘要");
        capture(
            &mut record,
            json!({"output":[{"type":"tool_use","input":{"text":"工具参数"}}]}),
            "response",
        );
        assert_eq!(record["responsePreview"], "流式文本摘要");
        capture(
            &mut record,
            json!({"tools":[{"metadata":{"session_id":"not-a-session"}}]}),
            "request",
        );
        assert!(record["sessionKey"].is_null());
    }

    #[test]
    fn response_previews_wait_for_ancestor_types_in_any_field_order() {
        for kind in [
            "tool_use",
            "function_call",
            "custom_tool_call",
            "tool_result",
        ] {
            for type_first in [true, false] {
                let mut tool = json!({});
                if type_first {
                    tool["type"] = json!(kind);
                }
                tool["input"] = json!({"nested":{"type":"text","text":"工具参数，不是模型输出"}});
                if !type_first {
                    tool["type"] = json!(kind);
                }
                for root in ["response", "stream/test"] {
                    let mut record = json!({});
                    capture(&mut record, tool.clone(), root);
                    assert!(
                        record["responsePreview"].is_null(),
                        "{kind}, {type_first}, {root}"
                    );
                    capture(
                        &mut record,
                        json!({"content":[
                            {"text":"真实模型输出", "type":"text"}, tool.clone()
                        ]}),
                        root,
                    );
                    assert_eq!(record["responsePreview"], "真实模型输出");
                    capture(&mut record, tool.clone(), root);
                    assert_eq!(
                        record["responsePreview"], "真实模型输出",
                        "a tool-only snapshot cannot replace model text"
                    );
                }
            }
        }
    }

    #[test]
    fn codex_headers_validate_fallbacks_and_preserve_other_clients() {
        let headers = json!({
            "session-id":["canonical"], "session_id":["legacy"],
            "x-session-id":["generic"], "x-codex-session-id":["codex-legacy"],
            "thread-id":["thread"], "x-client-request-id":["request"],
            "x-codex-window-id":["window"]
        });
        let mut codex = json!({"kind":"request","target":"codex"});
        identify_headers(&mut codex, &headers);
        assert_eq!(codex["sessionSource"], "session-id");
        let mut claude = json!({"kind":"request","target":"claude-code"});
        identify_headers(&mut claude, &headers);
        assert_eq!(claude["sessionSource"], "session_id");
        for invalid in ["", "invalid id", &"x".repeat(129)] {
            let mut record = json!({"kind":"request","target":"codex"});
            identify_headers(
                &mut record,
                &json!({"session-id":[invalid],"thread-id":["valid-thread"]}),
            );
            assert_eq!(record["sessionSource"], "thread-id");
        }
        for target in ["codex", "claude-code"] {
            let mut record = json!({"kind":"request","target":target});
            identify_headers(
                &mut record,
                &json!({"x-client-request-id":["request"],"x-codex-window-id":["window"]}),
            );
            assert!(record["sessionKey"].is_null());
        }
        let mut claude = json!({"kind":"request","target":"claude-code"});
        identify_headers(
            &mut claude,
            &json!({"session-id":["codex"],"thread-id":["thread"]}),
        );
        assert!(claude["sessionKey"].is_null());
    }

    #[test]
    fn claude_headers_take_precedence_and_invalid_values_allow_body_fallback() {
        let headers =
            json!({"x-claude-code-session-id":["claude-session"],"session_id":["legacy"]});
        let mut claude = json!({"kind":"request","target":"claude-code"});
        identify_headers(&mut claude, &headers);
        assert_eq!(claude["sessionSource"], "x-claude-code-session-id");
        let mut codex = json!({"kind":"request","target":"codex"});
        identify_headers(&mut codex, &headers);
        assert_eq!(codex["sessionSource"], "session_id");
        for invalid in ["", "invalid id", &"x".repeat(129)] {
            let mut record = json!({"kind":"request","target":"claude-code"});
            identify_headers(&mut record, &json!({"x-claude-code-session-id":[invalid]}));
            assert!(record["sessionKey"].is_null());
            capture(
                &mut record,
                json!({"metadata":{"user_id":json!({"session_id":"body-session"}).to_string()}}),
                "request",
            );
            assert_eq!(record["sessionSource"], "metadata.user_id");
            identify_headers(&mut record, &headers);
            assert_eq!(
                record["sessionSource"], "metadata.user_id",
                "existing identities stay stable"
            );
        }
    }

    #[test]
    fn identities_are_scoped_and_validated() {
        let mut first = json!({"kind":"request","providerId":"a","protocol":"openai.responses"});
        let mut second = json!({"kind":"request","providerId":"b","protocol":"openai.responses"});
        identify(&mut first, "thread-one", "session_id");
        identify(&mut second, "thread-one", "session_id");
        assert_ne!(first["sessionKey"], second["sessionKey"]);
        let key = first["sessionKey"].clone();
        identify(&mut first, "different", "metadata.session_id");
        assert_eq!(first["sessionKey"], key, "headers take precedence");
        let mut invalid = json!({"kind":"request"});
        for id in ["", "an id with spaces", &"x".repeat(129)] {
            identify(&mut invalid, id, "test");
        }
        assert!(invalid["sessionKey"].is_null());
        invalid["kind"] = json!("management");
        identify(&mut invalid, "thread-one", "session_id");
        assert!(invalid["sessionKey"].is_null());
    }
}
