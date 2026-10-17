//! Bounded literal reader. It never evaluates source code or interpolates values.
use super::capture::{credential_field, credential_type, CredentialHit, MatchPolicy};
use regex::Regex;
use std::sync::LazyLock;

static FIELD_HINT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\b[A-Za-z][A-Za-z0-9_-]*["']?\s*[:=]"#).unwrap());
static SIMPLE_TYPE_ASSIGNMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:string|str|&str|String)\s*=\s*").unwrap());
static TYPE_HINT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:type|interface)\b").unwrap());
static NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[$_\p{ID_Start}][$_\u{200C}\u{200D}\p{ID_Continue}]*").unwrap());

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

#[derive(Clone, Copy)]
enum TokenKind<'a> {
    Name(&'a str),
    Literal,
    Symbol(char),
}
struct Token<'a> {
    kind: TokenKind<'a>,
    start: usize,
    end: usize,
    newline: bool,
}
// Linear lexical reading bounded by the supplied text. Comments and strings
// cannot open/close a type body; no source expressions are evaluated.
fn token(text: &str, mut at: usize) -> Option<Token<'_>> {
    let mut newline = false;
    loop {
        let next = skip_space(text, at);
        newline |= text[at..next].contains(['\r', '\n']);
        at = next;
        if text[at..].starts_with("/*") {
            let end = text[at + 2..].find("*/")? + at + 4;
            newline |= text[at..end].contains(['\r', '\n']);
            at = end;
        } else if text[at..].starts_with("//") {
            at = text[at..].find(['\r', '\n']).map_or(text.len(), |i| at + i);
        } else {
            break;
        }
    }
    let c = text[at..].chars().next()?;
    let (kind, end) = if matches!(c, '\'' | '"' | '`') {
        let (end, closed) = quoted(text, at);
        (TokenKind::Literal, end + usize::from(closed))
    } else if let Some(name) = NAME.find(&text[at..]) {
        let end = at + name.end();
        (TokenKind::Name(&text[at..end]), end)
    } else {
        (TokenKind::Symbol(c), at + c.len_utf8())
    };
    Some(Token {
        kind,
        start: at,
        end,
        newline,
    })
}
fn type_parameters_end(text: &str, mut at: usize) -> Option<usize> {
    let (mut depth, mut nested, mut arrow) = (1usize, 0usize, false);
    while depth > 0 {
        let next = token(text, at)?;
        match next.kind {
            TokenKind::Symbol('<') => {
                depth += 1;
                if depth > 512 {
                    return None;
                }
            }
            TokenKind::Symbol('>') if !arrow => depth -= 1,
            TokenKind::Symbol('{' | '[' | '(') => nested += 1,
            TokenKind::Symbol('}' | ']' | ')') => nested = nested.checked_sub(1)?,
            TokenKind::Symbol(';') if nested == 0 => return None,
            _ => {}
        }
        arrow = matches!(next.kind, TokenKind::Symbol('='));
        at = next.end;
    }
    Some(at)
}
fn type_declaration_end(text: &str, keyword: &str, mut at: usize) -> Option<usize> {
    let name = token(text, at)?;
    if !matches!(name.kind, TokenKind::Name(_)) {
        return None;
    }
    let mut next = token(text, name.end)?;
    if matches!(next.kind, TokenKind::Symbol('<')) {
        at = type_parameters_end(text, next.end)?;
        next = token(text, at)?;
    }
    if keyword == "interface" {
        if matches!(next.kind, TokenKind::Name("extends")) {
            at = next.end;
            loop {
                next = token(text, at)?;
                match next.kind {
                    TokenKind::Name(_) | TokenKind::Symbol('.' | ',') => at = next.end,
                    TokenKind::Symbol('<') => at = type_parameters_end(text, next.end)?,
                    _ => break,
                }
            }
        }
        if !matches!(next.kind, TokenKind::Symbol('{')) {
            return None;
        }
    } else if !matches!(next.kind, TokenKind::Symbol('=')) {
        return None;
    }
    let mut brackets = Vec::new();
    let mut continuation = true;
    let mut previous_equal = false;
    at = if keyword == "interface" {
        next.start
    } else {
        next.end
    };
    while let Some(next) = token(text, at) {
        if brackets.is_empty()
            && (matches!(next.kind, TokenKind::Symbol(';'))
                || next.newline
                    && !continuation
                    && !matches!(
                        next.kind,
                        TokenKind::Symbol('&' | '|' | '?' | ':') | TokenKind::Name("extends")
                    )
                    && !text[next.start..].starts_with("=>"))
        {
            return Some(if matches!(next.kind, TokenKind::Symbol(';')) {
                next.end
            } else {
                at
            });
        }
        let arrow = previous_equal && matches!(next.kind, TokenKind::Symbol('>'));
        previous_equal = matches!(next.kind, TokenKind::Symbol('='));
        continuation = arrow
            || matches!(
                next.kind,
                TokenKind::Symbol('=' | '&' | '|' | '?' | ':' | ',')
            )
            || matches!(
                next.kind,
                TokenKind::Name("extends" | "keyof" | "typeof" | "infer")
            );
        match next.kind {
            TokenKind::Symbol('{' | '[' | '(' | '<') => {
                if brackets.len() >= 512 {
                    return Some(text.len());
                }
                if let TokenKind::Symbol(c) = next.kind {
                    brackets.push(c);
                }
            }
            TokenKind::Symbol(c @ ('}' | ']' | ')' | '>')) => {
                let open = match c {
                    '}' => '{',
                    ']' => '[',
                    ')' => '(',
                    _ => '<',
                };
                if !arrow {
                    // The enclosing block is outside this declaration. Leave its
                    // delimiter for the caller so following statements are scanned.
                    if brackets.last() != Some(&open) {
                        return Some(next.start);
                    }
                    brackets.pop();
                }
                if keyword == "interface" && brackets.is_empty() {
                    return Some(next.end);
                }
            }
            _ => {}
        }
        at = next.end;
    }
    Some(text.len())
}
fn declarations(text: &str) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut at = 0;
    let mut prefix = true;
    while let Some(next) = token(text, at) {
        prefix |= next.newline;
        // Fenced code is source content. Skip only the fence delimiter, so the
        // following line is still lexed; backtick type literals remain whole.
        if text[next.start..].starts_with("```") {
            at = next.start + 3;
            prefix = false;
            continue;
        }
        if prefix {
            if let TokenKind::Name(keyword @ ("type" | "interface")) = next.kind {
                if let Some(end) = type_declaration_end(text, keyword, next.end) {
                    ranges.push(next.start..end);
                    at = end;
                    continue;
                }
            }
        }
        prefix = matches!(next.kind, TokenKind::Symbol(';' | '{' | '}'))
            || prefix && matches!(next.kind, TokenKind::Name("export" | "declare" | "default"));
        at = next.end;
    }
    ranges
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

#[derive(Default)]
pub(super) struct Assignments {
    pub hits: Vec<CredentialHit>,
    pub declaration_ranges: Vec<std::ops::Range<usize>>,
    // Scheme-only detection must respect the same literal/type/expression
    // boundaries as field detection, including rejected authorization values.
    pub authorization_ranges: Vec<std::ops::Range<usize>>,
}

fn spelling_range(raw: &str, quote: u8, start: usize, end: usize) -> Option<(usize, usize)> {
    if !raw.contains('\\') {
        return Some((start, end));
    }
    if quote == b'"' {
        return super::credentials::range_offsets(&format!("\"{raw}\""), start, end)
            .ok()
            .map(|(start, end)| (start - 1, end - 1));
    }
    let (mut at, mut decoded, mut from) = (0, 0, None);
    while decoded < end {
        if decoded == start {
            from = Some(at);
        }
        let next = if raw.as_bytes().get(at) == Some(&b'\\') {
            at + 2
        } else {
            at + raw.get(at..)?.chars().next()?.len_utf8()
        };
        decoded += decode(raw.get(at..next)?, quote)?.len();
        at = next;
    }
    Some((from?, at))
}

pub(super) fn assignments(text: &str) -> Assignments {
    if !FIELD_HINT.find_iter(text).any(|m| {
        credential_field(
            m.as_str()
                .trim_end_matches([':', '=', ' ', '\t', '\r', '\n', '"', '\'']),
        )
    }) && !TYPE_HINT.is_match(text)
    {
        return Assignments::default();
    }
    let ranges = if TYPE_HINT.is_match(text) {
        declarations(text)
    } else {
        Vec::new()
    };
    let mut result = Assignments {
        hits: Vec::new(),
        authorization_ranges: ranges.clone(),
        declaration_ranges: ranges,
    };
    let mut range = 0;
    let mut at = 0;
    let mut unclosed = [false; 2];
    while at < text.len() {
        while range < result.declaration_ranges.len() && at >= result.declaration_ranges[range].end
        {
            range += 1;
        }
        if range < result.declaration_ranges.len() && at >= result.declaration_ranges[range].start {
            at = result.declaration_ranges[range].end;
            continue;
        }
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
            at += c.len_utf8();
            continue;
        };
        at = next;
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
            && ((matches!(statement, "const" | "let")
                || statement.starts_with("const ")
                || statement.starts_with("let "))
                && !line.contains('=')
                && annotation.is_none());
        let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
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
        let cookie = normalized.contains("cookie");
        let authorization = normalized.ends_with("authorization");
        let (end, closed) = if is_quoted {
            quoted(text, start)
        } else if cookie {
            let end = text[start..]
                .find(['\r', '\n'])
                .map_or(text.len(), |offset| start + offset);
            (end, true)
        } else {
            let token_start = if authorization {
                let scheme_end = text[start..]
                    .find(char::is_whitespace)
                    .map_or(text.len(), |offset| start + offset);
                if matches!(
                    text[start..scheme_end].to_ascii_lowercase().as_str(),
                    "bearer" | "basic"
                ) {
                    skip_space(text, scheme_end)
                } else {
                    start
                }
            } else {
                start
            };
            let end = text[token_start..]
                .find(|c: char| c.is_whitespace() || ",;}]\"'".contains(c))
                .map_or(text.len(), |offset| token_start + offset);
            (end, true)
        };
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
                || (cookie || authorization)
                    && text.as_bytes()[separator] == b':'
                    && !line.contains(['{', '=', '('])
                || line.is_empty()
                    && text.as_bytes()[separator] == b':'
                    && raw.chars().any(|c| c.is_ascii_digit())
                || prefix.trim_end().ends_with("Tool output:")
                    && super::capture::substring_matchable(raw));
        if authorization {
            result.authorization_ranges.push(start..end);
        }
        if source_type
            || quote == b'`' && (!closed || env)
            || raw.is_empty()
            || dynamic
            || reference
            || !is_quoted && !bare_data
        {
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
        if cookie {
            let value = decoded.as_deref().unwrap_or(raw);
            for mut hit in super::capture::cookie_hits(value) {
                let range = if decoded.is_some() {
                    spelling_range(raw, quote, hit.start, hit.end)
                } else {
                    Some((hit.start, hit.end))
                };
                let Some((start, end)) = range else {
                    continue;
                };
                hit.decoded = decoded.as_ref().map(|v| v[hit.start..hit.end].into());
                hit.start = content_start + start;
                hit.end = content_start + end;
                if decoded.is_none() {
                    hit.reason = "credential_literal_unverified";
                    hit.value_type = "unknown";
                }
                result.hits.push(hit);
            }
            at = end + usize::from(is_quoted && closed);
            continue;
        }
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
        if authorization {
            let value = decoded.as_deref().unwrap_or(raw);
            if let Some((scheme, rest)) = value.trim_start().split_once(char::is_whitespace) {
                if matches!(scheme.to_ascii_lowercase().as_str(), "bearer" | "basic") {
                    let token = if is_quoted {
                        rest.trim()
                    } else {
                        rest.split_whitespace().next().unwrap_or("")
                    };
                    if token.is_empty() {
                        continue;
                    }
                    let start = value.len() - rest.trim_start().len();
                    let end = start + token.len();
                    let range = if decoded.is_some() {
                        spelling_range(raw, quote, start, end)
                    } else {
                        Some((start, end))
                    };
                    let Some((start, end)) = range else {
                        continue;
                    };
                    hit.start = content_start + start;
                    hit.end = content_start + end;
                    hit.decoded = decoded.as_ref().map(|_| token.into());
                    hit.reason = if decoded.is_some() {
                        "authorization"
                    } else {
                        "credential_literal_unverified"
                    };
                    hit.value_type = if decoded.is_some() {
                        "literal"
                    } else {
                        "unknown"
                    };
                    hit.source = "authorization_header";
                    if !super::capture::substring_matchable(token) {
                        hit.match_policy = MatchPolicy::ContextValue;
                    }
                    result.hits.push(hit);
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
            MatchPolicy::ContextValue
        };
        hit.decoded = decoded;
        result.hits.push(hit);
        at = end + usize::from(is_quoted && closed);
    }
    result
}
