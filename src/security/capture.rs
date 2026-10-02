use crate::config::array;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

const MARKER: &str = "[REDACTED]";

static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"
).unwrap()
});
static PRIVATE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?s)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)"
).unwrap()
});
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r#"(?i)(?:\b(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|cookie|set-cookie)\b["']?\s*[:=]\s*)(?:"((?:\\.|[^"\\])*(?:\\)?)(?:"|$)|'([^']*)(?:'|$)|([^\s,;}\]]+))"#
).unwrap()
});
static AUTH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)").unwrap());
static URL_AUTH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z][A-Za-z0-9+.-]*://([^/\s@]+)@").unwrap());
static URL_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)[?&](?:api[_-]?key|access[_-]?token|token|secret|password|signature|sig)=([^&#\s"']+)"#).unwrap()
});
static COOKIE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\b(?:cookie|set-cookie)\s*:\s*([^\r\n"']+)"#).unwrap());
static ESCAPED_CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\\+["'](?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|password|passwd|secret|cookie|set-cookie|private[_-]?key|upstreamSecrets)\\+["']\s*[:=]"#).unwrap()
});

pub fn credential_field(key: &str) -> bool {
    let key: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    matches!(
        key.as_str(),
        "authorization"
            | "proxyauthorization"
            | "apikey"
            | "xapikey"
            | "password"
            | "passwd"
            | "secret"
            | "clientsecret"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "token"
            | "cookie"
            | "setcookie"
            | "cookies"
            | "upstreamsecrets"
            | "privatekey"
            | "secretaccesskey"
            | "awssecretaccesskey"
            | "anthropicapikey"
            | "openaiapikey"
            | "xauthtoken"
            | "authentication"
    )
}

#[derive(Clone)]
struct Span {
    start: usize,
    end: usize,
    reason: &'static str,
}

pub struct Redactor {
    secrets: Vec<String>,
    complete: bool,
    memory: crate::streaming::Reservation,
}

impl Redactor {
    pub fn available(&self) -> bool {
        self.complete
    }
    pub fn unavailable(&mut self) {
        self.complete = false;
    }
    pub fn credential(&mut self, s: &str) {
        self.learn(&json!(s));
    }
    pub fn new(secrets: &Value) -> Self {
        let mut r = Self {
            secrets: Vec::new(),
            complete: true,
            memory: crate::streaming::Reservation::memory(),
        };
        for value in secrets.as_object().into_iter().flatten().map(|(_, v)| v) {
            r.learn(value);
        }
        r
    }

    fn learn(&mut self, value: &Value) {
        match value {
            Value::String(s) if !s.is_empty() => {
                if self.secrets.iter().any(|v| v == s) {
                    return;
                }
                if self
                    .memory
                    .grow(s.len().saturating_mul(12).saturating_add(128))
                    .is_err()
                {
                    self.complete = false;
                } else {
                    self.secrets.push(s.clone());
                }
            }
            Value::Object(m) => {
                for v in m.values() {
                    self.learn(v);
                }
            }
            Value::Array(a) => {
                for v in a {
                    self.learn(v);
                }
            }
            _ => {}
        }
    }

    fn learn_fields(&mut self, value: &Value, depth: usize) {
        if depth > 128 {
            self.complete = false;
            return;
        }
        match value {
            Value::Object(m) => {
                for (key, v) in m {
                    if credential_field(key) {
                        self.learn(v);
                        for s in v
                            .as_str()
                            .into_iter()
                            .chain(array(v).iter().filter_map(Value::as_str))
                        {
                            for c in AUTH.captures_iter(s) {
                                self.learn(&json!(&c[1]));
                            }
                            if key.to_ascii_lowercase().contains("cookie") {
                                for pair in s.split(';') {
                                    if let Some((_, token)) = pair.trim().split_once('=') {
                                        self.learn(&json!(token));
                                    }
                                }
                            }
                        }
                    } else {
                        self.learn_fields(v, depth + 1);
                    }
                }
            }
            Value::Array(a) => {
                for v in a {
                    self.learn_fields(v, depth + 1);
                }
            }
            Value::String(s)
                if s.trim_start().starts_with('{') || s.trim_start().starts_with('[') =>
            {
                if let Ok(v) = serde_json::from_str::<Value>(s) {
                    self.learn_fields(&v, depth + 1);
                }
            }
            _ => {}
        }
    }

    pub fn observe(&mut self, value: &Value) {
        self.learn_fields(value, 0);
    }

    pub fn sanitize(&self, value: &mut Value) {
        if self.complete {
            self.scrub(value, "metadata", &mut Vec::new(), 0);
        } else {
            *value = json!(MARKER);
        }
    }

    fn spans(&self, value: &str) -> Vec<Span> {
        let mut spans = Vec::new();
        for secret in &self.secrets {
            // Short configured values are matched as complete values to avoid erasing ordinary prose.
            if secret.len() < 4 && value != secret {
                continue;
            }
            for (start, _) in value.match_indices(secret) {
                spans.push(Span {
                    start,
                    end: start + secret.len(),
                    reason: "known_credential",
                });
            }
            let escaped = serde_json::to_string(secret).unwrap();
            let escaped = &escaped[1..escaped.len() - 1];
            if escaped != secret {
                for (start, _) in value.match_indices(escaped) {
                    spans.push(Span {
                        start,
                        end: start + escaped.len(),
                        reason: "known_credential",
                    });
                }
            }
        }
        for (regex, reason) in [
            (&*TOKEN, "credential_pattern"),
            (&*PRIVATE_KEY, "private_key"),
        ] {
            for m in regex.find_iter(value) {
                spans.push(Span {
                    start: m.start(),
                    end: m.end(),
                    reason,
                });
            }
        }
        for (regex, reason) in [
            (&*ASSIGNMENT, "credential_assignment"),
            (&*AUTH, "authorization"),
            (&*URL_AUTH, "url_credentials"),
            (&*URL_SECRET, "url_credential_parameter"),
            (&*COOKIE, "cookie_header"),
        ] {
            for c in regex.captures_iter(value) {
                if let Some(m) = c.iter().skip(1).flatten().find(|m| !m.is_empty()) {
                    spans.push(Span {
                        start: m.start(),
                        end: m.end(),
                        reason,
                    });
                }
            }
        }
        spans.sort_by_key(|s| (s.start, std::cmp::Reverse(s.end)));
        let mut merged: Vec<Span> = Vec::new();
        for span in spans {
            if let Some(last) = merged.last_mut() {
                if span.start <= last.end {
                    last.end = last.end.max(span.end);
                    continue;
                }
            }
            merged.push(span);
        }
        merged
    }

    fn scrub_text(&self, value: &str, path: &str, marks: &mut Vec<Value>) -> String {
        replace_spans(value, &self.spans(value), path, marks)
    }

    fn scrub(&self, value: &mut Value, path: &str, marks: &mut Vec<Value>, depth: usize) {
        if depth > 128 {
            *value = json!(MARKER);
            mark(marks, path, "redaction_depth_limit", None);
            return;
        }
        match value {
            Value::String(s) => {
                if (s.trim_start().starts_with('{') || s.trim_start().starts_with('['))
                    && depth < 120
                {
                    if let Ok(mut nested) = serde_json::from_str::<Value>(s) {
                        let mut nested_marks = Vec::new();
                        self.scrub(&mut nested, "nested", &mut nested_marks, depth + 1);
                        if !nested_marks.is_empty() {
                            *s = nested.to_string();
                            mark(marks, path, "nested_json_credentials", None);
                        }
                    } else if ESCAPED_CREDENTIAL.is_match(s) {
                        *s = MARKER.into();
                        mark(marks, path, "unparsed_json_credentials", None);
                    }
                }
                *s = self.scrub_text(s, path, marks);
            }
            Value::Array(a) => {
                for (i, v) in a.iter_mut().enumerate() {
                    self.scrub(v, &format!("{path}/{i}"), marks, depth + 1);
                }
            }
            Value::Object(m) => {
                let old = std::mem::take(m);
                let keys: std::collections::HashSet<_> = old.keys().cloned().collect();
                for (i, (key, mut v)) in old.into_iter().enumerate() {
                    let child = format!("{path}/field/{i}");
                    let safe_key = self.scrub_text(&key, &format!("{child}/key"), marks);
                    let safe_key = if safe_key != key {
                        let mut unique = format!("{safe_key}#{i}");
                        while keys.contains(&unique) || m.contains_key(&unique) {
                            unique.push('#');
                        }
                        unique
                    } else {
                        key.clone()
                    };
                    if credential_field(&key) {
                        v = json!(MARKER);
                        mark(marks, &child, "credential_field", None);
                    } else {
                        self.scrub(&mut v, &child, marks, depth + 1);
                    }
                    m.insert(safe_key, v);
                }
            }
            _ => {}
        }
    }
}

fn mark(marks: &mut Vec<Value>, path: &str, reason: &str, range: Option<(usize, usize)>) {
    marks.push(json!({"location":path,"reason":reason,"range":range.map(|(start,end)| json!({"start":start,"end":end,"unit":"utf8_bytes"}))}));
}

fn replace_spans(value: &str, spans: &[Span], path: &str, marks: &mut Vec<Value>) -> String {
    let mut output = String::new();
    let mut at = 0;
    for span in spans {
        if span.start < at || span.start >= span.end {
            continue;
        }
        output.push_str(&value[at..span.start]);
        let start = output.len();
        output.push_str(MARKER);
        mark(marks, path, span.reason, Some((start, output.len())));
        at = span.end;
    }
    output.push_str(&value[at..]);
    output
}

pub struct TextPiece {
    pub raw: String,
    pub text: String,
    pub marks: Vec<Value>,
}

enum OpenMask {
    Jwt { dots: usize, segment: usize },
    Authority,
    Token,
    Assignment(Option<char>, bool),
    Private,
}
pub struct StreamText {
    pending: String,
    forced: bool,
    marked: bool,
    incomplete: bool,
    budget_gap: bool,
    open: Option<OpenMask>,
    _memory: crate::streaming::Reservation,
}
impl StreamText {
    pub fn hide_tail(&mut self) {
        self.incomplete = true;
    }
    pub fn new(forced: bool) -> std::io::Result<Self> {
        let mut memory = crate::streaming::Reservation::memory();
        memory.grow(512 * 1024)?;
        Ok(Self {
            pending: String::new(),
            forced,
            marked: false,
            incomplete: false,
            budget_gap: false,
            open: None,
            _memory: memory,
        })
    }
    pub fn feed(&mut self, input: &str, redactor: &Redactor, end: bool) -> Vec<TextPiece> {
        let needed = (self.pending.len() + input.len()).saturating_mul(64) as u64;
        if needed > self._memory.bytes
            && self
                ._memory
                .grow((needed - self._memory.bytes) as usize)
                .is_err()
        {
            self.forced = true;
            self.budget_gap = true;
        }
        self.pending.push_str(input);
        let mut output = Vec::new();
        let keep = redactor
            .secrets
            .iter()
            .map(|s| s.len() * 6)
            .max()
            .unwrap_or(0)
            .max(32768);
        loop {
            if self.pending.is_empty() {
                break;
            }
            if self.forced {
                let raw = std::mem::take(&mut self.pending);
                let marks = if self.marked {
                    Vec::new()
                } else {
                    vec![
                        json!({"reason":if self.budget_gap{"redaction_buffer_budget"}else{"credential_field"},"start":0,"end":MARKER.len()}),
                    ]
                };
                let text = if self.marked {
                    String::new()
                } else {
                    MARKER.into()
                };
                self.marked = true;
                output.push(TextPiece { raw, text, marks });
                break;
            }
            if let Some(mask) = &mut self.open {
                let stop = match mask {
                    OpenMask::Jwt { dots, segment } => {
                        let mut stop = None;
                        for (i, c) in self.pending.char_indices() {
                            if c == '.' && *dots < 2 && *segment > 0 {
                                *dots += 1;
                                *segment = 0;
                            } else if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                                *segment += 1;
                            } else {
                                stop = Some(i);
                                break;
                            }
                        }
                        stop
                    }
                    OpenMask::Authority => self
                        .pending
                        .char_indices()
                        .find(|(_, c)| c.is_whitespace() || "/@\"'".contains(*c))
                        .map(|(i, _)| i),
                    OpenMask::Token => self
                        .pending
                        .char_indices()
                        .find(|(_, c)| !c.is_ascii_alphanumeric() && !"._~+/=-".contains(*c))
                        .map(|(i, _)| i),
                    OpenMask::Assignment(quote, escaped) => {
                        let mut stop = None;
                        for (i, c) in self.pending.char_indices() {
                            if *escaped {
                                *escaped = false;
                                continue;
                            }
                            if quote.is_some() && c == '\\' {
                                *escaped = true;
                                continue;
                            }
                            if quote.is_some_and(|q| q == c)
                                || quote.is_none() && (c.is_whitespace() || ",;}]".contains(c))
                            {
                                stop = Some(i);
                                break;
                            }
                        }
                        stop
                    }
                    OpenMask::Private => PRIVATE_KEY_END.find(&self.pending).map(|m| m.end()),
                };
                let n = stop.unwrap_or_else(|| {
                    if end {
                        self.pending.len()
                    } else if matches!(mask, OpenMask::Private) {
                        self.pending.len().saturating_sub(128)
                    } else {
                        self.pending.len()
                    }
                });
                let mut n = n;
                while !self.pending.is_char_boundary(n) {
                    n -= 1;
                }
                let reason = match mask {
                    OpenMask::Jwt { dots, segment } if *dots == 2 && *segment > 0 => {
                        "credential_pattern"
                    }
                    OpenMask::Jwt { .. } => "credential_prefix_uncertain",
                    OpenMask::Authority
                        if stop.is_some_and(|i| self.pending.as_bytes()[i] == b'@') =>
                    {
                        "url_credentials"
                    }
                    OpenMask::Authority => "url_authority_uncertain",
                    _ => "credential_continuation",
                };
                if n == 0 {
                    if stop.is_some() {
                        if reason == "url_credentials" {
                            output.push(TextPiece {
                                raw: String::new(),
                                text: MARKER.into(),
                                marks: vec![json!({"reason":reason,"start":0,"end":MARKER.len()})],
                            });
                        }
                        self.open = None;
                        continue;
                    }
                    break;
                }
                let raw = self.pending.drain(..n).collect();
                output.push(TextPiece {
                    raw,
                    text: MARKER.into(),
                    marks: vec![json!({"reason":reason,"start":0,"end":MARKER.len()})],
                });
                if stop.is_some() || end {
                    self.open = None;
                } else {
                    break;
                }
                continue;
            }
            if !end && self.pending.len() <= keep * 2 {
                break;
            }
            let mut cut = if end {
                self.pending.len()
            } else {
                self.pending.len() - keep
            };
            while !self.pending.is_char_boundary(cut) {
                cut -= 1;
            }
            let mut spans = redactor.spans(&self.pending);
            if end && self.incomplete {
                let start = self
                    .pending
                    .rfind(|c: char| c.is_whitespace() || "\"'{}[],:".contains(c))
                    .map_or(0, |i| {
                        i + self.pending[i..].chars().next().unwrap().len_utf8()
                    });
                if start < self.pending.len() {
                    spans.push(Span {
                        start,
                        end: self.pending.len(),
                        reason: "incomplete_body_fragment",
                    });
                }
            }
            // An arbitrarily long authority may still turn out to contain userinfo.
            if !end {
                if let Some(c) = URL_AUTHORITY.captures(&self.pending) {
                    let m = c.get(1).unwrap();
                    if m.start() < cut {
                        spans.push(Span {
                            start: m.start(),
                            end: m.end(),
                            reason: "url_authority_uncertain",
                        });
                        self.open = Some(OpenMask::Authority);
                    }
                }
            }
            if !end {
                if let Some(m) = JWT_PENDING.find(&self.pending) {
                    if m.start() < cut {
                        spans.push(Span {
                            start: m.start(),
                            end: m.end(),
                            reason: "credential_prefix_uncertain",
                        });
                    }
                }
            }
            spans.sort_by_key(|s| (s.start, std::cmp::Reverse(s.end)));
            let mut merged: Vec<Span> = Vec::new();
            for span in spans {
                if let Some(last) = merged.last_mut() {
                    if span.start <= last.end {
                        last.end = last.end.max(span.end);
                        continue;
                    }
                }
                merged.push(span);
            }
            let spans = merged;
            for span in &spans {
                if span.start < cut && span.end > cut {
                    cut = span.end;
                }
                if !end && span.start < cut && span.end == self.pending.len() {
                    self.open = match span.reason {
                        "private_key" => Some(OpenMask::Private),
                        "url_authority_uncertain" => Some(OpenMask::Authority),
                        "credential_prefix_uncertain" => {
                            let token = &self.pending[span.start..span.end];
                            Some(OpenMask::Jwt {
                                dots: token.bytes().filter(|b| *b == b'.').count(),
                                segment: token.rsplit('.').next().unwrap_or("").len(),
                            })
                        }
                        "credential_pattern" | "authorization" => Some(OpenMask::Token),
                        "credential_assignment" | "url_credential_parameter" | "cookie_header" => {
                            let quote = self.pending[..span.start]
                                .chars()
                                .next_back()
                                .filter(|c| *c == '"' || *c == '\'');
                            Some(OpenMask::Assignment(
                                quote,
                                quote.is_some()
                                    && self.pending[span.start..]
                                        .bytes()
                                        .rev()
                                        .take_while(|b| *b == b'\\')
                                        .count()
                                        % 2
                                        == 1,
                            ))
                        }
                        _ => None,
                    };
                }
            }
            let raw: String = self.pending.drain(..cut).collect();
            let mut marks = Vec::new();
            let selected: Vec<_> = spans.into_iter().filter(|s| s.end <= cut).collect();
            let text = replace_spans(&raw, &selected, "", &mut marks);
            for mark in &mut marks {
                mark["start"] = mark["range"]["start"].clone();
                mark["end"] = mark["range"]["end"].clone();
            }
            output.push(TextPiece { raw, text, marks });
            if !end && self.pending.len() <= keep * 2 {
                break;
            }
        }
        output
    }
}
static JWT_PENDING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?$").unwrap());

static PRIVATE_KEY_END: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----").unwrap());

static URL_AUTHORITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z][A-Za-z0-9+.-]*://([^/\s@]+)$").unwrap());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_credential_continuations_do_not_leak_at_escape_or_token_boundaries() {
        let redactor = Redactor::new(&json!({}));
        let quoted = format!(
            "password=\"{}\\\" tail-private-value\" visible",
            "p".repeat(3 * crate::streaming::PAGE - 11)
        );
        let url = format!(
            "https://userinfo-prefix{}-userinfo-tail@example.test/visible",
            "u".repeat(160000)
        );
        let jwt = format!(
            "eyJ{}.{}.jwt-signature visible",
            "A".repeat(160000),
            "B".repeat(100)
        );
        let boundary_url = format!(
            "https://{}@example.test/visible",
            "u".repeat(3 * crate::streaming::PAGE - 8)
        );
        for (raw, forbidden) in [
            (quoted, "tail-private-value"),
            (url, "userinfo-tail"),
            (jwt, "jwt-signature"),
            (boundary_url, "uuuuuuuuuuuuuuuu"),
        ] {
            let mut stream = StreamText::new(false).unwrap();
            let mut safe = String::new();
            let mut rules = super::super::rules::Rules::new(&json!({}));
            for piece in raw.as_bytes().chunks(crate::streaming::PAGE) {
                for output in stream.feed(std::str::from_utf8(piece).unwrap(), &redactor, false) {
                    rules.redactions(&output.marks, "response_content", "response");
                    safe.push_str(&output.text);
                }
            }
            for output in stream.feed("", &redactor, true) {
                rules.redactions(&output.marks, "response_content", "response");
                safe.push_str(&output.text);
            }
            assert!(!safe.contains(forbidden), "{forbidden}: {safe}");
            assert!(safe.contains("visible"));
            assert_eq!(rules.findings.len(), 1, "{forbidden}");
            assert_eq!(rules.findings[0]["confidence"], "medium");
        }
    }
}
