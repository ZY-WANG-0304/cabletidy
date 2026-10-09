//! Read-only, paged projections of retained Responses and Messages request bodies.
use crate::streaming::{JsonStream, Node, Visitor};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::io::{self, Read};

const PAGE_ITEMS: usize = 40;

// Read one stored chunk at a time. Never assemble a potentially large request in RAM.
struct BodyReader<'a> {
    db: &'a Connection,
    audit: &'a str,
    next: u64,
    chunk: Vec<u8>,
    position: usize,
}
impl Read for BodyReader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        if self.position == self.chunk.len() {
            let row: Option<(u64, u64, String)> = self.db.query_row(
                "SELECT start,end,content FROM audit_body_chunks WHERE audit_id=? AND snapshot_id='request' AND start>=? ORDER BY start LIMIT 1",
                params![self.audit, self.next], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ).optional().map_err(io::Error::other)?;
            let Some((start, end, content)) = row else {
                return Ok(0);
            };
            if start != self.next || end != start + content.len() as u64 || end <= start {
                return Err(io::Error::other("retained_body_gap"));
            }
            self.next = end;
            self.chunk = content.into_bytes();
            self.position = 0;
        }
        let n = bytes.len().min(self.chunk.len() - self.position);
        bytes[..n].copy_from_slice(&self.chunk[self.position..self.position + n]);
        self.position += n;
        Ok(n)
    }
}

#[derive(Default)]
struct Frame {
    path: String,
    field: String,
    kind: u8,
    start: u64,
    value: String,
    raw: String,
    preview: String,
    role: String,
    item_type: String,
    name: String,
    call_id: String,
    id: String,
    capture: bool,
    parts: Vec<String>,
    opaque: bool,
    cache_control: String,
    is_error: Option<bool>,
    content_blocks: usize,
    content_array: bool,
    role_items: u64,
}

struct Projection {
    frames: Vec<Frame>,
    offset: usize,
    total: usize,
    counts: Value,
    items: Vec<Value>,
    // On a second pass, retain only metadata needed to associate this page.
    relations: Option<Vec<Value>>,
}
impl Projection {
    fn selected(&self) -> bool {
        self.relations.is_none() && self.total >= self.offset && self.items.len() < PAGE_ITEMS
    }
    fn new(offset: usize) -> Self {
        Self {
            frames: Vec::new(),
            offset,
            total: 0,
            counts: json!({}),
            items: Vec::new(),
            relations: None,
        }
    }
    fn item(&mut self, mut item: Value) {
        item["index"] = json!(self.total);
        self.total += 1;
        if let Some(selected) = &mut self.relations {
            for target in selected {
                let opposite = matches!(
                    (target["kind"].as_str(), item["kind"].as_str()),
                    (Some("tool_call"), Some("tool_result"))
                        | (Some("tool_result"), Some("tool_call"))
                );
                if !target["callId"].is_string() || target["callId"] != item["callId"] {
                    continue;
                }
                if target["index"] != item["index"] && target["kind"] == item["kind"] {
                    target["ambiguousRelation"] = json!(true);
                }
                if opposite {
                    if target["relatedIndex"].is_null() {
                        target["relatedIndex"] = item["index"].clone();
                        if target["kind"] == "tool_result" {
                            target["name"] = item["name"].clone();
                        }
                    } else {
                        target["ambiguousRelation"] = json!(true);
                    }
                }
            }
            return;
        }
        let kind = item["kind"].as_str().unwrap_or("other");
        self.counts[kind] = json!(self.counts[kind].as_u64().unwrap_or(0) + 1);
        if self.total > self.offset && self.items.len() < PAGE_ITEMS {
            self.items.push(item);
        }
    }
}

impl Visitor for Projection {
    fn start(&mut self, path: &str, field: &str, kind: u8, at: u64) -> Result<()> {
        let depth = self.frames.len();
        let parent = self.frames.last().map(|f| f.field.as_str()).unwrap_or("");
        let boundary = depth == 1
            && (matches!(
                field,
                "instructions" | "previous_response_id" | "conversation"
            ) || field == "input" && kind == b'"'
                || field == "system" && kind != b'[')
            || depth == 2 && matches!(parent, "input" | "tools" | "system" | "messages")
            || depth == 4
                && self.frames[1].field == "messages"
                && self.frames[3].field == "content";
        let mut capture = if boundary {
            self.selected()
        } else {
            self.frames.last().is_some_and(|f| f.capture)
        };
        // A Messages array is projected per block. Do not retain the enclosing
        // message's full history while collecting only the current page.
        if depth == 3 && self.frames[1].field == "messages" && field == "content" && kind == b'[' {
            let message = self.frames.last_mut().unwrap();
            message.capture = false;
            message.raw.clear();
            message.preview.clear();
            capture = false;
        }
        let raw = match kind {
            b'{' => "{",
            b'[' => "[",
            b'"' | b'k' => "\"",
            _ => "",
        };
        self.frames.push(Frame {
            path: path.into(),
            field: field.into(),
            kind,
            start: at,
            raw: if capture { raw.into() } else { String::new() },
            capture,
            ..Frame::default()
        });
        Ok(())
    }
    fn text(&mut self, text: &str) -> Result<()> {
        let f = self.frames.last_mut().unwrap();
        if f.capture {
            let escaped = serde_json::to_string(text)?;
            f.raw.push_str(&escaped[1..escaped.len() - 1]);
        }
        if matches!(
            f.field.as_str(),
            "role" | "type" | "name" | "tool_name" | "call_id" | "tool_use_id" | "id"
        ) || f.capture
            && matches!(
                f.field.as_str(),
                "text"
                    | "content"
                    | "input"
                    | "output"
                    | "arguments"
                    | "instructions"
                    | "refusal"
                    | "description"
                    | "system"
                    | "thinking"
            )
        {
            f.value.push_str(text);
        }
        Ok(())
    }
    fn scalar(&mut self, value: &str) -> Result<()> {
        let f = self.frames.last_mut().unwrap();
        if f.capture {
            f.raw.push_str(value);
        }
        if f.field == "is_error" && matches!(value, "true" | "false") {
            f.value = value.into();
        }
        Ok(())
    }
    fn punctuation(&mut self, value: &str) -> Result<()> {
        // Container delimiters are emitted on start/end instead.
        if matches!(value, "," | ":") {
            let f = self.frames.last_mut().unwrap();
            if f.capture {
                f.raw.push_str(value);
            }
        }
        Ok(())
    }
    fn end(&mut self, node: &Node) -> Result<()> {
        let mut f = self.frames.pop().unwrap();
        let closing = match f.kind {
            b'{' => "}",
            b'[' => "]",
            b'"' | b'k' => "\"",
            _ => "",
        };
        if f.capture {
            f.raw.push_str(closing);
        }
        let top = self.frames.len() == 1;
        let parent = self.frames.last().map(|p| p.field.as_str()).unwrap_or("");
        let message = self.frames.len() == 2 && parent == "messages";
        let message_block = self.frames.len() == 4
            && self.frames[1].field == "messages"
            && self.frames[3].field == "content";
        let system_block = self.frames.len() == 2 && parent == "system";
        let system = top && f.field == "system" && f.kind != b'[';
        let input_item = self.frames.len() == 2 && parent == "input";
        let definition = self.frames.len() == 2 && parent == "tools";
        let instructions = top && f.field == "instructions";
        let reference = top && matches!(f.field.as_str(), "previous_response_id" | "conversation");
        let plain_input = top && f.field == "input" && f.kind == b'"';
        let boundary = input_item
            || definition
            || instructions
            || reference
            || plain_input
            || system
            || system_block
            || message_block
            || message && f.content_blocks == 0 && !f.content_array;
        if f.kind != b'k' && boundary && f.kind != b'n' {
            let kind = if definition {
                "tool_definition"
            } else if instructions || system || system_block {
                "system"
            } else if reference
                || matches!(f.item_type.as_str(), "item_reference" | "tool_reference")
            {
                "reference"
            } else if matches!(
                f.item_type.as_str(),
                "function_call" | "custom_tool_call" | "tool_use" | "server_tool_use"
            ) || f.item_type.ends_with("_call")
            {
                "tool_call"
            } else if matches!(
                f.item_type.as_str(),
                "function_call_output" | "custom_tool_call_output" | "tool_result"
            ) || f.item_type.ends_with("_output")
                || f.item_type.ends_with("_tool_result")
            {
                "tool_result"
            } else if matches!(
                f.item_type.as_str(),
                "reasoning" | "compaction" | "thinking" | "redacted_thinking"
            ) {
                "reasoning"
            } else if message_block {
                match f.item_type.as_str() {
                    "text" | "image" | "document" | "search_result" => {
                        match self.frames[2].role.as_str() {
                            "user" => "user",
                            "assistant" => "assistant",
                            "" => "message",
                            _ => "other",
                        }
                    }
                    _ => "other",
                }
            } else if plain_input {
                "user"
            } else {
                match f.role.as_str() {
                    "system" => "system",
                    "developer" => "developer",
                    "user" => "user",
                    "assistant" => "assistant",
                    "tool" => "tool_result",
                    _ => "other",
                }
            };
            let message_index = if message_block {
                Some(
                    self.frames[2]
                        .path
                        .rsplit('/')
                        .next()
                        .unwrap_or("")
                        .to_owned(),
                )
            } else if message {
                Some(f.path.rsplit('/').next().unwrap_or("").to_owned())
            } else {
                None
            };
            let source = if message_block {
                format!(
                    "messages[{}].content[{}]",
                    message_index.as_deref().unwrap_or(""),
                    f.path.rsplit('/').next().unwrap_or("")
                )
            } else if input_item || definition || system_block || message {
                format!("{parent}[{}]", f.path.rsplit('/').next().unwrap_or(""))
            } else {
                f.field.clone()
            };
            let preview = if definition
                || matches!(
                    kind,
                    "tool_call" | "tool_result" | "tool_definition" | "other" | "reference"
                ) && f.preview.is_empty()
            {
                &f.raw
            } else if f.kind == b'"' {
                &f.value
            } else {
                &f.preview
            };
            let mut item = json!({"kind":kind,"type":f.item_type,"role":f.role,"source":source,
                "preview":preview,
                "parts":f.parts,"opaque":f.opaque,"start":f.start,"end":node.end,"location":f.path});
            if !f.name.is_empty() {
                item["name"] = json!(f.name);
            }
            if !f.call_id.is_empty() {
                item["callId"] = json!(f.call_id);
            } else if matches!(f.item_type.as_str(), "tool_use" | "server_tool_use")
                && !f.id.is_empty()
            {
                item["callId"] = json!(f.id);
            }
            if !f.id.is_empty() {
                item["id"] = json!(f.id);
            }
            if let Some(message_index) = message_index {
                item["messageIndex"] = json!(message_index);
            }
            if message_block {
                item["role"] = json!(self.frames[2].role);
            }
            if !f.cache_control.is_empty() {
                item["cacheControl"] = json!(f.cache_control);
            }
            if let Some(is_error) = f.is_error {
                item["isError"] = json!(is_error);
            }
            if f.item_type == "server_tool_use" || f.item_type.ends_with("_tool_result") {
                item["serverTool"] = json!(true);
            }
            if f.item_type == "redacted_thinking" {
                item["opaque"] = json!(true);
            }
            if matches!(f.item_type.as_str(), "image" | "document" | "search_result")
                && !item["parts"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(f.item_type))
            {
                item["parts"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(f.item_type));
            }
            if f.capture
                && (item["opaque"] == true
                    || !item["parts"].as_array().unwrap().is_empty()
                    || matches!(f.item_type.as_str(), "thinking" | "reasoning")
                    || matches!(kind, "tool_call" | "tool_result" | "other" | "reference"))
            {
                item["structure"] = json!(f.raw);
            }
            if message_block {
                self.frames[2].content_blocks += 1;
                if kind == "message" {
                    self.frames[2].role_items += 1;
                }
            }
            self.item(item);
        }
        if message {
            let role_kind = match f.role.as_str() {
                "user" => "user",
                "assistant" => "assistant",
                _ => "other",
            };
            // role may follow content in JSON. Resolve only after the whole message
            // has ended, without buffering its unbounded number of content blocks.
            if self.relations.is_none() && f.role_items > 0 {
                self.counts["message"] = json!(self.counts["message"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_sub(f.role_items));
                self.counts[role_kind] =
                    json!(self.counts[role_kind].as_u64().unwrap_or(0) + f.role_items);
                if self.counts["message"] == 0 {
                    self.counts.as_object_mut().unwrap().remove("message");
                }
            }
            for item in &mut self.items {
                if item["messageIndex"] == f.path.rsplit('/').next().unwrap_or("") {
                    item["role"] = json!(f.role);
                    if item["kind"] == "message" {
                        item["kind"] = json!(role_kind);
                    }
                }
            }
        }
        let message_content = self.frames.len() == 3 && self.frames[1].field == "messages";
        if let Some(parent) = self.frames.last_mut() {
            if parent.capture && !boundary {
                parent.raw.push_str(&f.raw);
            }
            if f.kind == b'k' {
                return Ok(());
            }
            match f.field.as_str() {
                "role" => parent.role = f.value.clone(),
                "type" => parent.item_type = f.value.clone(),
                "name" | "tool_name" => parent.name = f.value.clone(),
                "content" if f.kind == b'[' && message_content => parent.content_array = true,
                "call_id" | "tool_use_id" => parent.call_id = f.value.clone(),
                "id" => parent.id = f.value.clone(),
                "encrypted_content" => parent.opaque = f.kind != b'n',
                "cache_control" if f.kind == b'{' => parent.cache_control = f.raw.clone(),
                "is_error" => {
                    parent.is_error = match f.value.as_str() {
                        "true" => Some(true),
                        "false" => Some(false),
                        _ => None,
                    }
                }
                _ => {}
            }
            let content = if f.kind == b'"' { &f.value } else { &f.preview };
            let is_text = matches!(
                f.field.as_str(),
                "text"
                    | "content"
                    | "input"
                    | "output"
                    | "arguments"
                    | "instructions"
                    | "summary"
                    | "refusal"
                    | "description"
                    | "thinking"
                    | "system"
            );
            let structured_payload = matches!(f.field.as_str(), "input" | "arguments" | "output")
                && matches!(f.kind, b'{' | b'[');
            if parent.capture
                && !boundary
                && !structured_payload
                && (is_text || (f.kind == b'{' && !f.preview.is_empty()))
                && !content.is_empty()
            {
                if !parent.preview.is_empty() {
                    parent.preview.push('\n');
                }
                parent.preview.push_str(content);
            }
            if parent.capture && !boundary && structured_payload && matches!(f.kind, b'{' | b'[') {
                parent.preview.push_str(&f.raw);
            }
            if f.kind == b'{'
                && matches!(
                    f.item_type.as_str(),
                    "input_image"
                        | "input_file"
                        | "input_audio"
                        | "input_video"
                        | "refusal"
                        | "image"
                        | "document"
                        | "search_result"
                        | "tool_reference"
                )
                && parent.parts.len() < 12
                && !parent.parts.contains(&f.item_type)
            {
                parent.parts.push(f.item_type.clone());
            }
            for part in f.parts {
                if parent.parts.len() < 12 && !parent.parts.contains(&part) {
                    parent.parts.push(part);
                }
            }
            parent.opaque |= f.opaque;
        }
        Ok(())
    }
}

pub(super) fn read(db: &Connection, audit: &str, offset: usize) -> Result<Value> {
    let manifest: Option<String> = db
        .query_row(
            "SELECT data FROM audit_snapshots WHERE audit_id=? AND id='request'",
            [audit],
            |r| r.get(0),
        )
        .optional()?;
    let Some(manifest) = manifest else {
        return Ok(json!({"items":[],"total":0,"counts":{},"offset":offset,"state":"unavailable"}));
    };
    let manifest: Value = serde_json::from_str(&manifest)?;
    let legacy = manifest.get("body").map(serde_json::to_vec).transpose()?;
    let parse = |projection: &mut Projection| -> Result<()> {
        if let Some(bytes) = &legacy {
            JsonStream::new(&bytes[..]).parse(projection, "request")
        } else {
            JsonStream::new(BodyReader {
                db,
                audit,
                next: 0,
                chunk: Vec::new(),
                position: 0,
            })
            .parse(projection, "request")
        }
    };
    let mut projection = Projection::new(offset);
    let parsed = parse(&mut projection).is_ok();
    // An incomplete message may end before its role arrives. Preserve completed
    // blocks as unknown content rather than inventing a user/assistant role.
    if let Some(count) = projection.counts.as_object_mut().unwrap().remove("message") {
        projection.counts["other"] =
            json!(projection.counts["other"].as_u64().unwrap_or(0) + count.as_u64().unwrap_or(0));
        for item in &mut projection.items {
            if item["kind"] == "message" {
                item["kind"] = json!("other");
            }
        }
    }
    if projection
        .items
        .iter()
        .any(|item| item["callId"].is_string())
    {
        let mut lookup = Projection::new(0);
        lookup.relations = Some(std::mem::take(&mut projection.items));
        let _ = parse(&mut lookup);
        projection.items = lookup.relations.unwrap();
    }
    let complete = parsed && (manifest["state"] == "complete" || legacy.is_some());
    Ok(
        json!({"items":projection.items,"total":projection.total,"counts":projection.counts,"offset":offset,
        "nextOffset":if offset.saturating_add(PAGE_ITEMS) < projection.total { Some(offset.saturating_add(PAGE_ITEMS)) } else { None },
        "state":if complete { "complete" } else { "partial" },"bodyState":manifest["state"]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(body: Value, offset: usize) -> Projection {
        let mut projection = Projection::new(offset);
        JsonStream::new(&serde_json::to_vec(&body).unwrap()[..])
            .parse(&mut projection, "request")
            .unwrap();
        projection
    }

    fn associate(body: &Value, projection: Projection) -> Vec<Value> {
        let mut lookup = Projection::new(0);
        lookup.relations = Some(projection.items);
        JsonStream::new(&serde_json::to_vec(body).unwrap()[..])
            .parse(&mut lookup, "request")
            .unwrap();
        lookup.relations.unwrap()
    }

    #[test]
    fn claude_blocks_keep_parent_roles_tool_payloads_and_multimodal_results() {
        let body = json!({"system":[
            {"type":"text","text":"System instructions","cache_control":{"type":"ephemeral","ttl":"1h"}},
            {"text":"Repository context","type":"text"}
        ],"messages":[
            {"content":[{"text":"Question","type":"text"}],"role":"user"},
            {"content":[
                {"thinking":"Inspect source","signature":"opaque-signature","type":"thinking"},
                {"type":"redacted_thinking","data":"encrypted-thought"},
                {"type":"text","text":"Reading files"},
                {"type":"tool_use","id":"read","name":"Read","input":{"text":"keep JSON keys","path":"src/main.rs"}},
                {"type":"tool_use","id":"bash","name":"Bash","input":{"command":"pwd"}}
            ],"role":"assistant"},
            {"content":[
                {"type":"tool_result","tool_use_id":"bash","content":"/project","is_error":false},
                {"type":"text","text":"Continue <script>literal</script>"},
                {"type":"tool_result","tool_use_id":"read","content":[
                    {"type":"text","text":"Read failed"},
                    {"type":"image","source":{"type":"base64","data":"opaque-image"}},
                    {"type":"document","source":{"type":"base64","data":"opaque-pdf"}},
                    {"type":"tool_reference","tool_name":"Edit"}
                ],"is_error":true,"cache_control":{"type":"ephemeral"}},
                {"type":"image","source":{"type":"base64","data":"opaque-image"}},
                {"type":"document","source":{"type":"text","data":"document body"}},
                {"type":"future_block","payload":"retained"}
            ],"role":"user"}
        ],"tools":[{"name":"Read","description":"Read a file","input_schema":{"type":"object"},"cache_control":{"type":"ephemeral"}}]});
        let projection = project(body.clone(), 0);
        assert_eq!(projection.total, 15);
        assert_eq!(
            projection.counts,
            json!({"system":2,"user":4,"assistant":1,"reasoning":2,"tool_call":2,"tool_result":2,"other":1,"tool_definition":1})
        );
        let items = associate(&body, projection);
        assert_eq!(items[0]["preview"], "System instructions");
        assert_eq!(
            items[0]["cacheControl"],
            "{\"type\":\"ephemeral\",\"ttl\":\"1h\"}"
        );
        assert_eq!(items[3]["preview"], "Inspect source");
        assert!(!items[3]["preview"].as_str().unwrap().contains("signature"));
        assert_eq!(items[4]["preview"], "");
        assert_eq!(items[4]["opaque"], true);
        assert_eq!(
            items[6]["preview"],
            "{\"text\":\"keep JSON keys\",\"path\":\"src/main.rs\"}"
        );
        assert_eq!(items[6]["relatedIndex"], 10);
        assert_eq!(items[8]["kind"], "tool_result");
        assert_eq!(items[8]["role"], "user");
        assert_eq!(items[8]["relatedIndex"], 7);
        assert_eq!(items[8]["isError"], false);
        assert_eq!(items[10]["name"], "Read");
        assert_eq!(items[10]["isError"], true);
        assert_eq!(items[10]["preview"], "Read failed");
        assert_eq!(
            items[10]["parts"],
            json!(["image", "document", "tool_reference"])
        );
        assert_eq!(items[10]["source"], "messages[2].content[2]");
        assert_eq!(items[10]["location"], "request/field/1/2/field/0/2");
        let encoded = serde_json::to_string(&body).unwrap();
        for item in &items {
            assert!(serde_json::from_str::<Value>(
                &encoded[item["start"].as_u64().unwrap() as usize
                    ..item["end"].as_u64().unwrap() as usize]
            )
            .is_ok());
        }
    }

    #[test]
    fn claude_empty_tool_only_server_tools_and_duplicate_ids_are_explicit() {
        for body in [
            json!({}),
            json!({"system":null,"messages":[],"tools":[]}),
            json!({"system":[],"messages":[{"role":"user","content":[]}]} ),
        ] {
            assert_eq!(project(body, 0).total, 0);
        }
        assert_eq!(
            project(
                json!({"system":"你好🙂","messages":[{"role":"user","content":"Plain question"}]}),
                0
            )
            .counts,
            json!({"system":1,"user":1})
        );
        let body = json!({"messages":[
            {"role":"assistant","content":[
                {"type":"server_tool_use","id":"srv","name":"web_search","input":{"query":"docs"}},
                {"type":"web_search_tool_result","tool_use_id":"srv","content":[{"type":"web_search_result","title":"Docs","url":"https://example.test"}]},
                {"type":"tool_use","id":"dup","name":"Bash","input":{}},
                {"type":"tool_use","id":"dup","name":"Read","input":{}},
                {"type":"tool_use","id":"unfinished","name":"Edit","input":{}}
            ]},
            {"role":"user","content":[
                {"type":"tool_result","tool_use_id":"dup","content":"Reported"},
                {"type":"tool_result","tool_use_id":"missing"},
                {"type":"tool_result","tool_use_id":"missing"},
                {"type":"tool_result","tool_use_id":"x".repeat(200),"content":"long ID"}
            ]}
        ]});
        let projection = project(body.clone(), 0);
        assert_eq!(projection.counts, json!({"tool_call":4,"tool_result":5}));
        let items = associate(&body, projection);
        assert_eq!(items[0]["serverTool"], true);
        assert_eq!(items[1]["serverTool"], true);
        assert_eq!(items[1]["name"], "web_search");
        assert_eq!(items[1]["relatedIndex"], 0);
        for i in [2, 3, 5, 6, 7] {
            assert_eq!(items[i]["ambiguousRelation"], true);
        }
        for i in [4, 6, 7, 8] {
            assert!(items[i]["relatedIndex"].is_null());
        }
        assert_eq!(items[8]["callId"], "x".repeat(200));
    }

    #[test]
    fn claude_single_message_pages_resolve_role_in_either_field_order() {
        for encoded in [
            format!("{{\"messages\":[{{\"role\":\"user\",\"content\":{}}}]}}", serde_json::to_string(&(0..105).map(|i| json!({"type":"text","text":format!("{i}:{}", "汉🙂".repeat(500))})).collect::<Vec<_>>()).unwrap()),
            serde_json::to_string(&json!({"messages":[{"content":(0..105).map(|i| json!({"type":"text","text":format!("{i}:{}", "汉🙂".repeat(500))})).collect::<Vec<_>>(),"role":"user"}]})).unwrap()
        ] {
            for offset in [0,40,80] {
                let mut projection = Projection::new(offset);
                JsonStream::new(encoded.as_bytes()).parse(&mut projection, "request").unwrap();
                assert_eq!(projection.total, 105);
                assert_eq!(projection.counts, json!({"user":105}));
                assert_eq!(projection.items.len(), if offset == 80 {25} else {40});
                for (i,item) in projection.items.iter().enumerate() {
                    assert_eq!(item["index"], offset+i);
                    assert_eq!(item["kind"], "user");
                    assert_eq!(item["role"], "user");
                    assert_eq!(item["preview"], format!("{}:{}",offset+i,"汉🙂".repeat(500)));
                    assert!(item["truncated"].is_null());
                }
            }
        }
    }

    #[test]
    fn claude_partial_message_keeps_completed_blocks_without_inventing_role() {
        for (tail, expected) in [
            (
                "\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"kept\"},",
                "user",
            ),
            (
                "\"content\":[{\"type\":\"text\",\"text\":\"kept\"},",
                "other",
            ),
        ] {
            let db = Connection::open_in_memory().unwrap();
            db.execute_batch("CREATE TABLE audit_snapshots (audit_id TEXT,id TEXT,data TEXT); CREATE TABLE audit_body_chunks (audit_id TEXT,snapshot_id TEXT,start INTEGER,end INTEGER,content TEXT);").unwrap();
            db.execute(
                "INSERT INTO audit_snapshots VALUES('partial','request','{\"state\":\"partial\"}')",
                [],
            )
            .unwrap();
            let encoded = format!("{{\"messages\":[{{{tail}");
            db.execute(
                "INSERT INTO audit_body_chunks VALUES('partial','request',0,?,?)",
                params![encoded.len(), encoded],
            )
            .unwrap();
            let content = read(&db, "partial", 0).unwrap();
            assert_eq!(content["state"], "partial");
            assert_eq!(content["total"], 1);
            assert_eq!(content["counts"], json!({expected:1}));
            assert_eq!(content["items"][0]["kind"], expected);
            assert_eq!(content["items"][0]["preview"], "kept");
        }
    }

    #[test]
    fn mixed_codex_context_keeps_order_roles_and_payloads_in_any_field_order() {
        let body = json!({"instructions":"Follow the system instructions", "input":[
            {"content":[{"text":"Project instructions", "type":"input_text"}], "role":"developer"},
            {"role":"system","content":"Additional system message"},
            {"content":[{"text":"First question", "type":"input_text"},{"type":"input_image","image_url":"data:image/png;base64,opaque"}],"role":"user"},
            {"summary":[{"text":"Inspect the files", "type":"summary_text"}],"encrypted_content":"ciphertext","type":"reasoning"},
            {"arguments":"{\"cmd\":\"pwd\"}","name":"exec_command","call_id":"call_1","type":"function_call"},
            {"output":"/project", "call_id":"call_1", "type":"function_call_output"},
            {"role":"assistant","content":[{"type":"output_text","text":"Found the project"}]},
            {"input":"*** Begin Patch\n*** End Patch", "call_id":"call_2", "type":"custom_tool_call", "name":"apply_patch"},
            {"type":"custom_tool_call_output","call_id":"call_2","output":{"ok":true}},
            {"role":"user","content":"Second question"},
            {"type":"item_reference","id":"prior_item"},
            {"type":"future_item","payload":{"secret":"keep in raw view"}}
        ], "tools":[{"type":"function","name":"exec_command","parameters":{"type":"object"}}, {"type":"custom","name":"apply_patch","description":"Apply edits"}],"previous_response_id":"resp_prior"});
        let projection = project(body.clone(), 0);
        assert_eq!(projection.total, 16);
        assert_eq!(
            projection.counts,
            json!({"system":2,"developer":1,"user":2,"reasoning":1,"tool_call":2,"tool_result":2,"assistant":1,"reference":2,"other":1,"tool_definition":2})
        );
        assert_eq!(projection.items[0]["source"], "instructions");
        assert_eq!(projection.items[1]["source"], "input[0]");
        assert_eq!(projection.items[3]["preview"], "First question");
        assert_eq!(projection.items[3]["parts"], json!(["input_image"]));
        assert_eq!(projection.items[4]["preview"], "Inspect the files");
        assert_eq!(projection.items[4]["opaque"], true);
        assert_eq!(projection.items[5]["preview"], "{\"cmd\":\"pwd\"}");
        assert_eq!(projection.items[6]["preview"], "/project");
        assert_eq!(projection.items[7]["preview"], "Found the project");
        assert_eq!(
            projection.items[8]["preview"],
            "*** Begin Patch\n*** End Patch"
        );
        assert_eq!(projection.items[9]["preview"], "{\"ok\":true}");
        let encoded = serde_json::to_string(&body).unwrap();
        for item in &projection.items {
            let value: Value = serde_json::from_str(
                &encoded[item["start"].as_u64().unwrap() as usize
                    ..item["end"].as_u64().unwrap() as usize],
            )
            .unwrap();
            if item["source"] == "input[4]" {
                assert_eq!(value["name"], "exec_command");
            }
        }
        let mut lookup = Projection::new(0);
        lookup.relations = Some(projection.items);
        JsonStream::new(encoded.as_bytes())
            .parse(&mut lookup, "request")
            .unwrap();
        let items = lookup.relations.unwrap();
        assert_eq!(items[5]["relatedIndex"], 6);
        assert_eq!(items[6]["relatedIndex"], 5);
        assert_eq!(items[6]["name"], "exec_command");
        assert_eq!(items[9]["name"], "apply_patch");
    }

    #[test]
    fn absent_empty_opaque_and_tool_only_inputs_are_not_invented_as_user_messages() {
        for body in [
            json!({}),
            json!({"instructions":null,"input":[],"tools":[],"previous_response_id":null}),
        ] {
            assert_eq!(project(body, 0).total, 0);
        }
        assert_eq!(
            project(json!({"input":"你好🙂"}), 0).items[0]["preview"],
            "你好🙂"
        );
        let projection = project(
            json!({"input":[
                {"type":"function_call_output","call_id":"unmatched","output":"Only a tool result"},
                {"type":"reasoning","encrypted_content":"ciphertext","summary":[]},
                {"role":"user","content":[{"type":"input_file","filename":"example.pdf","file_data":"opaque"}]}
            ]}),
            0,
        );
        assert_eq!(projection.items[0]["kind"], "tool_result");
        assert_eq!(projection.items[1]["preview"], "");
        assert_eq!(projection.items[1]["opaque"], true);
        assert_eq!(projection.items[2]["preview"], "");
        assert_eq!(projection.items[2]["parts"], json!(["input_file"]));
    }

    #[test]
    fn long_requests_keep_exact_counts_page_bounds_and_complete_unicode_content() {
        let body = json!({"input":(0..105).map(|i| json!({"role":"user","content":format!("{i}:{}", "汉🙂".repeat(500))})).collect::<Vec<_>>()});
        let first = project(body.clone(), 0);
        let second = project(body.clone(), 40);
        let last = project(body, 80);
        assert_eq!(first.total, 105);
        assert_eq!(first.counts["user"], 105);
        assert_eq!(first.items.len(), 40);
        assert_eq!(second.items[0]["index"], 40);
        assert_eq!(last.items.len(), 25);
        assert_eq!(last.items[24]["index"], 104);
        for item in first.items {
            assert_eq!(
                item["preview"],
                format!("{}:{}", item["index"], "汉🙂".repeat(500))
            );
            assert!(item["truncated"].is_null());
        }
    }

    #[test]
    fn full_page_preserves_long_text_parameters_results_definitions_and_opaque_structures() {
        let text = format!(
            "{}\nEND <script>literal</script>",
            "汉🙂\\\"\n".repeat(16000)
        );
        let id = "tool_id_".repeat(50);
        for body in [
            json!({"instructions":text,"input":[
                {"role":"developer","content":text},
                {"role":"user","content":[{"type":"input_text","text":text},{"type":"input_text","text":"Last block"}]},
                {"type":"function_call","call_id":id,"name":"Read","arguments":{"text":text,"other":"preserved"}},
                {"type":"function_call_output","call_id":id,"output":{"text":text,"metadata":{"ok":true}}},
                {"type":"reasoning","summary":[{"text":text}],"encrypted_content":text}
            ],"tools":[{"type":"function","name":"Read","description":text,"parameters":{"type":"object","properties":{"path":{"description":"complete schema tail"}}}}]}),
            json!({"system":text,"messages":[
                {"role":"user","content":text},
                {"content":[
                    {"type":"text","text":text},
                    {"type":"tool_use","id":id,"name":"Read","input":{"text":text,"other":"preserved"}},
                    {"type":"thinking","thinking":text,"signature":text}
                ],"role":"assistant"},
                {"content":[{"type":"tool_result","tool_use_id":id,"content":text}],"role":"user"}
            ],"tools":[{"name":"Read","description":text,"input_schema":{"type":"object","properties":{"path":{"description":"complete schema tail"}}}}]}),
        ] {
            let projection = project(body.clone(), 0);
            let items = associate(&body, projection);
            assert_eq!(items[0]["preview"], text);
            assert_eq!(items[1]["preview"], text);
            let call = items
                .iter()
                .find(|item| item["kind"] == "tool_call")
                .unwrap();
            assert_eq!(call["callId"], id);
            assert_eq!(
                serde_json::from_str::<Value>(call["preview"].as_str().unwrap()).unwrap(),
                json!({"text":text,"other":"preserved"})
            );
            let result = items
                .iter()
                .find(|item| item["kind"] == "tool_result")
                .unwrap();
            assert_eq!(result["relatedIndex"], call["index"]);
            if body.get("input").is_some() {
                assert_eq!(items[2]["preview"], format!("{text}\nLast block"));
                assert_eq!(
                    serde_json::from_str::<Value>(result["preview"].as_str().unwrap()).unwrap(),
                    json!({"text":text,"metadata":{"ok":true}})
                );
            } else {
                assert_eq!(result["preview"], text);
            }
            let reasoning = items
                .iter()
                .find(|item| item["kind"] == "reasoning")
                .unwrap();
            assert_eq!(reasoning["preview"], text);
            let structure: Value =
                serde_json::from_str(reasoning["structure"].as_str().unwrap()).unwrap();
            assert_eq!(
                structure
                    .get("signature")
                    .or_else(|| structure.get("encrypted_content"))
                    .unwrap(),
                &json!(text)
            );
            let definition = items
                .iter()
                .find(|item| item["kind"] == "tool_definition")
                .unwrap();
            let raw: Value = serde_json::from_str(definition["preview"].as_str().unwrap()).unwrap();
            assert_eq!(raw["description"], text);
            assert!(definition["preview"].as_str().unwrap().ends_with("}}}}"));
            assert!(items.iter().all(|item| item["truncated"].is_null()));
        }
    }

    #[test]
    fn off_page_content_and_enclosing_history_are_not_collected() {
        let mut projection = Projection::new(40);
        let head = r#"{"messages":[{"content":[{"type":"text","text":"first"},"#;
        assert!(JsonStream::new(head.as_bytes())
            .parse(&mut projection, "request")
            .is_err());
        assert_eq!(projection.total, 1);
        assert!(projection.items.is_empty());
        assert!(projection
            .frames
            .iter()
            .all(|frame| !frame.capture && frame.raw.is_empty() && frame.preview.is_empty()));
        let body = json!({"messages":[{"content":(0..105).map(|i|json!({"type":"text","text":format!("{i}:{}","long ".repeat(300))})).collect::<Vec<_>>(),"role":"user"}]});
        let tail = project(body, 80);
        assert_eq!(tail.items.len(), 25);
        assert!(tail.items[0]["preview"]
            .as_str()
            .unwrap()
            .starts_with("80:"));
    }

    #[test]
    fn retained_chunks_legacy_snapshots_and_gaps_are_projected_without_writes() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE audit_snapshots (audit_id TEXT,id TEXT,data TEXT); CREATE TABLE audit_body_chunks (audit_id TEXT,snapshot_id TEXT,start INTEGER,end INTEGER,content TEXT);").unwrap();
        let body = json!({"instructions":"system", "input":[{"role":"user","content":"Hello"},{"type":"function_call_output","call_id":"missing","output":"reported"}]});
        let encoded = serde_json::to_string_pretty(&body).unwrap();
        db.execute(
            "INSERT INTO audit_snapshots VALUES('new','request',?)",
            [json!({"state":"complete"}).to_string()],
        )
        .unwrap();
        for (i, bytes) in encoded.as_bytes().chunks(20).enumerate() {
            db.execute(
                "INSERT INTO audit_body_chunks VALUES('new','request',?,?,?)",
                params![
                    i * 20,
                    i * 20 + bytes.len(),
                    std::str::from_utf8(bytes).unwrap()
                ],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO audit_snapshots VALUES('old','request',?)",
            [json!({"body":body,"state":"complete"}).to_string()],
        )
        .unwrap();
        let new = read(&db, "new", 0).unwrap();
        let old = read(&db, "old", 0).unwrap();
        assert_eq!(new["counts"], old["counts"]);
        assert_eq!(new["state"], "complete");
        assert_eq!(new["items"][2]["relatedIndex"], Value::Null);
        for item in new["items"].as_array().unwrap() {
            assert!(serde_json::from_str::<Value>(
                &encoded[item["start"].as_u64().unwrap() as usize
                    ..item["end"].as_u64().unwrap() as usize]
            )
            .is_ok());
        }
        assert_eq!(read(&db, "missing", 0).unwrap()["state"], "unavailable");
        db.execute(
            "DELETE FROM audit_body_chunks WHERE audit_id='new' AND start=100",
            [],
        )
        .unwrap();
        let partial = read(&db, "new", 0).unwrap();
        assert_eq!(partial["state"], "partial");
        assert_eq!(partial["items"][0]["kind"], "system");
        assert!(partial["total"].as_u64().unwrap() < new["total"].as_u64().unwrap());
        assert_eq!(
            db.query_row("SELECT count(*) FROM audit_snapshots", [], |r| r
                .get::<_, u64>(0))
                .unwrap(),
            2
        );
    }
}
