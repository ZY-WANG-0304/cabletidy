//! Bounded literal reader. It never evaluates source code or interpolates values.
use super::capture::{credential_field, credential_type, CredentialHit, MatchPolicy};
use regex::Regex;
use std::sync::LazyLock;

static FIELD_HINT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\b[A-Za-z][A-Za-z0-9_-]*["']?\s*[:=]"#).unwrap());
static SIMPLE_TYPE_ASSIGNMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:string|str|&str|String)\s*=\s*").unwrap());

fn skip_space(text: &str, mut at: usize) -> usize {
    while let Some(c) = text[at..].chars().next().filter(|c| c.is_whitespace()) {
        at += c.len_utf8();
    }
    at
}
fn quoted(text: &str, at: usize) -> (usize, bool) {
    let delimiter = text.as_bytes()[at];
    let mut escaped = false;
    for (offset, c) in text[at + 1..].char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c as u32 == delimiter as u32 {
            return (at + 1 + offset, true);
        }
    }
    (text.len(), false)
}
fn decode(raw: &str, quote: u8) -> Option<String> {
    if !raw.contains('\\') {
        return Some(raw.into());
    }
    if quote == b'"' {
        return serde_json::from_str::<String>(&format!("\"{raw}\"")).ok();
    }
    let mut value = String::new();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            value.push(c);
        } else {
            value.push(match chars.next()? {
                '\\' => '\\',
                '\'' if quote == b'\'' => '\'',
                '`' if quote == b'`' => '`',
                _ => return None,
            });
        }
    }
    Some(value)
}

pub(super) fn assignments(text: &str) -> Vec<CredentialHit> {
    if !FIELD_HINT.find_iter(text).any(|m| {
        credential_field(
            m.as_str()
                .trim_end_matches([':', '=', ' ', '\t', '\r', '\n', '"', '\'']),
        )
    }) {
        return Vec::new();
    }
    let mut hits = Vec::new();
    let mut at = 0;
    let mut depth = 0usize;
    let mut type_depth = None;
    let mut type_pending = false;
    let mut unclosed = [false; 2];
    while at < text.len() {
        let c = text[at..].chars().next().unwrap();
        let begin = at;
        // Markdown delimiters are not values. Backticks on the RHS are read below.
        if c == '`' {
            at += 1;
            continue;
        }
        if c == '/' && text[..at].trim_end().ends_with(['=', '(', ':', ',']) {
            let (end, closed) = quoted(text, at);
            if closed {
                at = end + 1;
                continue;
            }
        }
        let (key, next) = if matches!(c, '"' | '\'') {
            let index = usize::from(c == '\'');
            if unclosed[index] || text[..at].ends_with('\\') {
                at += 1;
                continue;
            }
            let (end, closed) = quoted(text, at);
            if !closed {
                unclosed[index] = true;
                at += c.len_utf8();
                continue;
            }
            (&text[at + 1..end], end + 1)
        } else if c.is_ascii_alphabetic() || c == '_' {
            at += c.len_utf8();
            while let Some(c) = text[at..]
                .chars()
                .next()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
            {
                at += c.len_utf8();
            }
            (&text[begin..at], at)
        } else {
            match c {
                '{' => {
                    depth += 1;
                    if type_pending {
                        type_depth = Some(depth);
                        type_pending = false;
                    }
                }
                '}' => {
                    if type_depth == Some(depth) {
                        type_depth = None;
                    }
                    depth = depth.saturating_sub(1);
                }
                ';' => type_pending = false,
                _ => {}
            }
            at += c.len_utf8();
            continue;
        };
        at = next;
        if matches!(key, "type" | "interface")
            && text[skip_space(text, next)..].starts_with(|c: char| c.is_ascii_alphabetic())
        {
            type_pending = true;
        }
        if !credential_field(key) {
            continue;
        }
        let separator = skip_space(text, next);
        if !matches!(text.as_bytes().get(separator), Some(b':' | b'=')) {
            continue;
        }
        let mut start = skip_space(text, separator + 1);
        if start == text.len() || matches!(text.as_bytes()[start], b'=' | b'>') {
            continue;
        }
        let prefix = &text[..begin];
        let line = prefix.rsplit('\n').next().unwrap_or("").trim();
        let statement = line.rsplit([';', '}']).next().unwrap_or(line).trim();
        let statement = if statement.is_empty() {
            line
        } else {
            statement
        };
        let mut annotation_limit = text.len().min(start.saturating_add(128));
        while !text.is_char_boundary(annotation_limit) {
            annotation_limit -= 1;
        }
        let annotation = (text.as_bytes()[separator] == b':')
            .then(|| SIMPLE_TYPE_ASSIGNMENT.find(&text[start..annotation_limit]))
            .flatten();
        let source_type = text.as_bytes()[separator] == b':'
            && (type_depth.is_some()
                || type_pending
                || statement.starts_with("type ")
                || statement.starts_with("interface ")
                || (matches!(statement, "const" | "let")
                    || statement.starts_with("const ")
                    || statement.starts_with("let "))
                    && !line.contains('=')
                    && annotation.is_none());
        let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
        if source_type || normalized.contains("cookie") {
            continue;
        }
        if text.as_bytes()[separator] == b':' {
            // Only common scalar annotations followed by an assignment. Type
            // declarations above remain excluded; never evaluate an expression.
            if let Some(annotation) = annotation {
                start += annotation.end();
                if !matches!(text.as_bytes().get(start), Some(b'"' | b'\'' | b'`')) {
                    continue;
                }
            }
        }
        let env = text.as_bytes()[separator] == b'=' && (line.is_empty() || line == "export");
        let quote = text.as_bytes()[start];
        if quote == b'`' && prefix.trim_end().ends_with('`') {
            continue;
        }
        let is_quoted = matches!(quote, b'"' | b'\'' | b'`');
        let (end, closed) = if is_quoted {
            quoted(text, start)
        } else {
            let end = text[start..]
                .find(|c: char| c.is_whitespace() || ",;}]".contains(c))
                .map_or(text.len(), |offset| start + offset);
            (end, true)
        };
        if quote == b'`' && (!closed || env) {
            continue;
        }
        let content_start = start + usize::from(is_quoted);
        let raw = &text[content_start..end];
        let remainder = if closed && is_quoted {
            &text[end + 1..]
        } else {
            &text[end..]
        };
        let dynamic = is_quoted
            && (remainder.trim_start().starts_with(['+', '%', '.', '*'])
                || quote != b'\'' && raw.contains("${")
                || env && quote == b'"' && raw.contains(['$', '`'])
                || env
                    && remainder.starts_with(|c: char| {
                        c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '`')
                    }));
        let reference = !is_quoted
            && (raw.starts_with(['`', '&', '{', '(', '/', '='])
                || raw.contains(['(', ')', '[', ']', '\\'])
                || raw.starts_with('$')
                    && raw[1..]
                        .starts_with(|c: char| c.is_ascii_alphabetic() || c == '_' || c == '{')
                || raw.contains("${"));
        let bare_data = !is_quoted
            && (env
                || line.is_empty()
                    && text.as_bytes()[separator] == b':'
                    && raw.chars().any(|c| c.is_ascii_digit())
                || prefix.trim_end().ends_with("Tool output:")
                    && super::capture::substring_matchable(raw));
        if raw.is_empty() || dynamic || reference || !is_quoted && !bare_data {
            continue;
        }
        let decoded = if is_quoted && closed {
            decode(raw, quote)
        } else if !is_quoted {
            Some(raw.into())
        } else {
            None
        };
        let reason = if decoded.is_some() {
            "credential_assignment"
        } else {
            "credential_literal_unverified"
        };
        let mut hit = CredentialHit::new(
            content_start,
            end,
            reason,
            if env {
                "environment_assignment"
            } else {
                "source_assignment"
            },
            credential_type(key),
        );
        if normalized.ends_with("authorization") {
            if let Some((scheme, token)) = raw.split_once(char::is_whitespace) {
                if matches!(scheme.to_ascii_lowercase().as_str(), "bearer" | "basic") {
                    let token = token.trim();
                    hit.start = end - token.len();
                    hit.decoded = Some(token.into());
                    hit.reason = "authorization";
                    hit.source = "authorization_header";
                    if !super::capture::substring_matchable(token) {
                        hit.match_policy = MatchPolicy::CompleteValue;
                    }
                    hits.push(hit);
                }
                at = end + usize::from(is_quoted && closed);
                continue;
            }
        }
        hit.value_type = if decoded.is_some() {
            "literal"
        } else {
            "unknown"
        };
        hit.match_policy = if super::capture::substring_matchable(decoded.as_deref().unwrap_or(raw))
        {
            MatchPolicy::CredentialUnit
        } else {
            MatchPolicy::CompleteValue
        };
        hit.decoded = decoded;
        hits.push(hit);
        at = end + usize::from(is_quoted && closed);
    }
    hits
}
