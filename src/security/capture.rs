use crate::config::array;
use regex::Regex;
use serde_json::{json, Value};
use std::{collections::BTreeSet, sync::LazyLock};

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
// The scheme word must be followed by a credential-shaped token. Ordinary prose such as
// "basic instructions" or "bearer token handling" is not an authorization value.
static AUTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]*[0-9._~+/=-][A-Za-z0-9._~+/=-]*|[A-Za-z]{20,})"
).unwrap()
});
// Only userinfo that carries a password component, or that is itself token shaped,
// is treated as a credential. `ssh://git@host/repo.git` is an ordinary public form.
static URL_AUTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z][A-Za-z0-9+.-]*://([^/\s@:]+:[^/\s@]*|[A-Za-z0-9_\-.]{20,})@").unwrap()
});
static URL_USERNAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z][A-Za-z0-9+.-]*://([^/\s@:]+)(?::[^/\s@]*)?@").unwrap());
// Any syntactically valid IPv4 address, with an optional port. Whether it is an
// internal or a public endpoint is decided in `host_reason`.
static HOST_ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"\b((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})(:\d{1,5})?\b"
).unwrap()
});
// A bare address is only an endpoint when something nearby says so. Without this,
// ordinary version strings like `1.2.3.4` would be reported as servers.
static HOST_CONTEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)(?://|@|\b(?:host|hostname|server|ip|addr|address|ssh|scp|ping|connect|proxy|endpoint|upstream|origin|target|bind|listen|telnet|rsync|curl|wget|nc|mysql|psql|redis)\b(?:\s+(?:to|at|on|from|is|are|was)\b)?[\s:=\x22']*)$"
).unwrap()
});
// Candidate IPv6 runs, either bracketed with an optional port or bare. The shape is
// deliberately loose: `Ipv6Addr` decides what is actually an address, so MAC addresses,
// timestamps and Rust `::` paths fall out as parse failures rather than regex tuning.
static HOST_ADDRESS6: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"\[([0-9A-Fa-f:.]+)\](:\d{1,5})?|(?:[^0-9A-Za-z:.]|^)([0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f.]{0,4}){2,})(?:[^0-9A-Za-z]|$)"
).unwrap()
});
// Encoded forms of an IPv4 address: integer, hexadecimal, octal and percent-encoded
// spellings all resolve to the same host. They are only read in a URL or userinfo
// position, because a bare large integer elsewhere is ordinary data.
static HOST_ENCODED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?://|@)([0-9A-Fx.%]+)(:\d{1,5})?").unwrap());
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

// A documented placeholder is not a credential. Templates, environment references and
// masking runs are the common shapes; retaining them as hits buries the real values.
fn placeholder_value(value: &str) -> bool {
    let v = value.trim().trim_matches(['"', '\'']);
    if v.is_empty() {
        return true;
    }
    // The surrounding capture stops at `}` or whitespace, so a template opener often
    // arrives truncated (`{{`, `{{vault`). Treat the opener itself as the signal.
    if v.starts_with('<')
        || v.starts_with('{')
        || v.starts_with('$')
        || (v.starts_with('%') && v.ends_with('%') && v.len() > 2)
    {
        return true;
    }
    let lower = v.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "none"
            | "null"
            | "nil"
            | "true"
            | "false"
            | "todo"
            | "fixme"
            | "changeme"
            | "xxx"
            | "test"
            | "example"
            | "placeholder"
            | "redacted"
            | "undefined"
    ) {
        return true;
    }
    // Upper-case instructions such as YOUR_TOKEN_HERE.
    if v.bytes()
        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        && ["YOUR", "HERE", "TOKEN", "KEY", "SECRET", "PASSWORD"]
            .iter()
            .any(|word| v.contains(word))
    {
        return true;
    }
    // Masking runs such as xxxxxxxx or ********. Bounded in length, because a long
    // low-variety string is more likely a real value than a visual mask.
    (4..=32).contains(&v.len()) && v.chars().collect::<BTreeSet<_>>().len() <= 2
}

fn shannon_entropy(s: &str) -> f64 {
    let mut counts = std::collections::BTreeMap::new();
    let mut total = 0f64;
    for c in s.chars() {
        *counts.entry(c).or_insert(0f64) += 1.0;
        total += 1.0;
    }
    if total == 0.0 {
        return 0.0;
    }
    -counts
        .values()
        .map(|n| {
            let p = n / total;
            p * p.log2()
        })
        .sum::<f64>()
}

fn word_shaped(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphabetic())
}

// Endpoints and URL usernames are recorded for review, not hidden. They stay readable
// in metadata instead of being replaced by the redaction marker.
pub fn annotation_only(reason: &str) -> bool {
    matches!(
        reason,
        "internal_host" | "public_host" | "internal_identity"
    )
}

fn private_address(ip: &str) -> bool {
    let mut parts = ip.split('.').filter_map(|p| p.parse::<u8>().ok());
    let (Some(a), Some(b)) = (parts.next(), parts.next()) else {
        return false;
    };
    a == 10
        || a == 127
        || a == 0
        || a >= 224
        || (a == 192 && b == 168)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 169 && b == 254)
}

// Reported ranges follow the same split as IPv4: anything only reachable inside a
// network or reserved for documentation is internal, everything else is a public host.
fn private_address6(ip: std::net::Ipv6Addr) -> bool {
    let [a, b, ..] = ip.segments();
    ip.is_loopback()
        || ip.is_unicast_link_local()
        || ip.is_multicast()
        || (a & 0xfe00) == 0xfc00 // fc00::/7 unique local
        || (a == 0x2001 && b == 0x0db8) // 2001:db8::/32 documentation
        || ip.to_ipv4_mapped().is_some_and(private_address_v4)
}

fn private_address_v4(ip: std::net::Ipv4Addr) -> bool {
    private_address(&ip.to_string())
}

fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

// Decode the alternative spellings a resolver accepts for an IPv4 address. Returns
// `None` for anything that only looks numeric, so ports and ordinary integers are left
// alone. Plain dotted-decimal is handled by `HOST_ADDRESS` and deliberately skipped.
fn decode_address(raw: &str) -> Option<std::net::Ipv4Addr> {
    let decoded = percent_decode(raw);
    let plain = |s: &str| {
        s.split('.').count() == 4
            && s.split('.')
                .all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()))
    };
    if decoded != raw && plain(&decoded) {
        return decoded.parse().ok();
    }
    let single = |value: u32| {
        // Only a value that spans all four octets reads as an address.
        (0x0100_0000..=u32::MAX)
            .contains(&value)
            .then(|| std::net::Ipv4Addr::from(value))
    };
    if !decoded.is_empty() && decoded.bytes().all(|b| b.is_ascii_digit()) {
        return single(decoded.parse().ok()?);
    }
    // A single hexadecimal literal only; a dotted mix falls through to the loop below.
    if let Some(hex) = decoded
        .strip_prefix("0x")
        .or_else(|| decoded.strip_prefix("0X"))
        .filter(|hex| hex.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return single(u32::from_str_radix(hex, 16).ok()?);
    }
    let parts: Vec<&str> = decoded.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut octets = [0u8; 4];
    let mut encoded = false;
    for (slot, part) in octets.iter_mut().zip(&parts) {
        let value = if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
            encoded = true;
            u32::from_str_radix(hex, 16).ok()?
        } else if part.len() > 1 && part.starts_with('0') {
            encoded = true;
            u32::from_str_radix(&part[1..], 8).ok()?
        } else {
            part.parse().ok()?
        };
        *slot = u8::try_from(value).ok()?;
    }
    encoded.then(|| std::net::Ipv4Addr::from(octets))
}

// A server address is an attack surface once it leaks, so a public address is reported
// at least as prominently as an internal one. An address without a port and without
// network context is left alone, because dotted version numbers share its shape.
fn host_reason(value: &str, ip_start: usize, ip: &str, port: bool) -> Option<&'static str> {
    if !port && !HOST_CONTEXT.is_match(&value[..ip_start]) {
        return None;
    }
    Some(if private_address(ip) {
        "internal_host"
    } else {
        "public_host"
    })
}

// Learned values are matched inside longer text only when they look like credentials.
// A low entropy natural-language word would otherwise light up ordinary prose, so it
// is demoted to whole-value or word-boundary matching instead of being dropped.
fn substring_matchable(s: &str) -> bool {
    s.len() >= 8 && !(word_shaped(s) && shannon_entropy(s) < 3.5)
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
            // Word-like low entropy values are matched as complete values only, like
            // short values above. A natural-language word would otherwise mark prose.
            let anywhere = substring_matchable(secret);
            let mut push = |start: usize, len: usize| {
                if anywhere || len == value.len() {
                    spans.push(Span {
                        start,
                        end: start + len,
                        reason: "known_credential",
                    });
                }
            };
            for (start, _) in value.match_indices(secret) {
                push(start, secret.len());
            }
            let escaped = serde_json::to_string(secret).unwrap();
            let escaped = &escaped[1..escaped.len() - 1];
            if escaped != secret {
                for (start, _) in value.match_indices(escaped) {
                    push(start, escaped.len());
                }
            }
        }
        for c in HOST_ADDRESS.captures_iter(value) {
            let ip = c.get(1).unwrap();
            if let Some(reason) = host_reason(value, ip.start(), ip.as_str(), c.get(2).is_some()) {
                spans.push(Span {
                    start: ip.start(),
                    end: c.get(2).map_or(ip.end(), |m| m.end()),
                    reason,
                });
            }
        }
        for c in HOST_ADDRESS6.captures_iter(value) {
            let bracketed = c.get(1);
            let Some(address) = bracketed.or_else(|| c.get(3)) else {
                continue;
            };
            let Ok(ip) = address.as_str().parse::<std::net::Ipv6Addr>() else {
                continue;
            };
            // A bare `::` carries no endpoint, and `::1` style loopback still does.
            if ip.is_unspecified() {
                continue;
            }
            let port = bracketed.and(c.get(2));
            if port.is_none() && !HOST_CONTEXT.is_match(&value[..address.start()]) {
                continue;
            }
            spans.push(Span {
                start: address.start(),
                end: port.map_or(address.end(), |m| m.end()),
                reason: if private_address6(ip) {
                    "internal_host"
                } else {
                    "public_host"
                },
            });
        }
        for c in HOST_ENCODED.captures_iter(value) {
            let address = c.get(1).unwrap();
            let Some(ip) = decode_address(address.as_str()) else {
                continue;
            };
            spans.push(Span {
                start: address.start(),
                end: c.get(2).map_or(address.end(), |m| m.end()),
                reason: if private_address_v4(ip) {
                    "internal_host"
                } else {
                    "public_host"
                },
            });
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
            (&*URL_USERNAME, "internal_identity"),
        ] {
            for c in regex.captures_iter(value) {
                if let Some(m) = c.iter().skip(1).flatten().find(|m| !m.is_empty()) {
                    // A template or masked value names a credential without carrying one.
                    if reason != "internal_identity" && placeholder_value(m.as_str()) {
                        continue;
                    }
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
        if annotation_only(span.reason) {
            output.push_str(&value[span.start..span.end]);
        } else {
            output.push_str(MARKER);
        }
        mark(marks, path, span.reason, Some((start, output.len())));
        at = span.end;
    }
    output.push_str(&value[at..]);
    output
}

pub struct TextPiece {
    pub text: String,
    pub marks: Vec<Value>,
}

enum OpenCredential {
    Jwt { dots: usize, segment: usize },
    Authority,
    Token,
    Assignment(Option<char>, bool),
    Private,
}
pub struct StreamText {
    pending: String,
    forced: bool,
    incomplete: bool,
    budget_gap: bool,
    open: Option<OpenCredential>,
    _memory: crate::streaming::Reservation,
}
impl StreamText {
    pub fn mark_incomplete(&mut self) {
        self.incomplete = true;
    }
    pub fn new(forced: bool) -> std::io::Result<Self> {
        let mut memory = crate::streaming::Reservation::memory();
        memory.grow(512 * 1024)?;
        Ok(Self {
            pending: String::new(),
            forced,
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
            if self.forced || self.budget_gap {
                let raw = std::mem::take(&mut self.pending);
                let marks = vec![
                    json!({"reason":if self.forced{"credential_field"}else{"redaction_buffer_budget"},"start":0,"end":raw.len()}),
                ];
                let text = raw;
                output.push(TextPiece { text, marks });
                break;
            }
            if let Some(mask) = &mut self.open {
                let stop = match mask {
                    OpenCredential::Jwt { dots, segment } => {
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
                    OpenCredential::Authority => self
                        .pending
                        .char_indices()
                        .find(|(_, c)| c.is_whitespace() || "/@\"'".contains(*c))
                        .map(|(i, _)| i),
                    OpenCredential::Token => self
                        .pending
                        .char_indices()
                        .find(|(_, c)| !c.is_ascii_alphanumeric() && !"._~+/=-".contains(*c))
                        .map(|(i, _)| i),
                    OpenCredential::Assignment(quote, escaped) => {
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
                    OpenCredential::Private => PRIVATE_KEY_END.find(&self.pending).map(|m| m.end()),
                };
                let n = stop.unwrap_or_else(|| {
                    if end {
                        self.pending.len()
                    } else if matches!(mask, OpenCredential::Private) {
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
                    OpenCredential::Jwt { dots, segment } if *dots == 2 && *segment > 0 => {
                        "credential_pattern"
                    }
                    OpenCredential::Jwt { .. } => "credential_prefix_uncertain",
                    OpenCredential::Authority
                        if stop.is_some_and(|i| self.pending.as_bytes()[i] == b'@') =>
                    {
                        "url_credentials"
                    }
                    OpenCredential::Authority => "url_authority_uncertain",
                    _ => "credential_continuation",
                };
                if n == 0 {
                    if stop.is_some() {
                        if reason == "url_credentials" {
                            // The authority was emitted before its terminating @ arrived.
                            // Retain and annotate that delimiter when the format is confirmed.
                            self.pending.remove(0);
                            output.push(TextPiece {
                                text: "@".into(),
                                marks: vec![json!({"reason":reason,"start":0,"end":1})],
                            });
                        }
                        self.open = None;
                        continue;
                    }
                    break;
                }
                let raw: String = self.pending.drain(..n).collect();
                output.push(TextPiece {
                    text: raw,
                    marks: vec![json!({"reason":reason,"start":0,"end":n})],
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
                        self.open = Some(OpenCredential::Authority);
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
                        "private_key" => Some(OpenCredential::Private),
                        "url_authority_uncertain" => Some(OpenCredential::Authority),
                        "credential_prefix_uncertain" => {
                            let token = &self.pending[span.start..span.end];
                            Some(OpenCredential::Jwt {
                                dots: token.bytes().filter(|b| *b == b'.').count(),
                                segment: token.rsplit('.').next().unwrap_or("").len(),
                            })
                        }
                        "credential_pattern" | "authorization" => Some(OpenCredential::Token),
                        "credential_assignment" | "url_credential_parameter" | "cookie_header" => {
                            let quote = self.pending[..span.start]
                                .chars()
                                .next_back()
                                .filter(|c| *c == '"' || *c == '\'');
                            Some(OpenCredential::Assignment(
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
            let marks = spans
                .into_iter()
                .filter(|s| s.end <= cut)
                .map(|s| json!({"reason":s.reason,"start":s.start,"end":s.end}))
                .collect();
            let text = raw;
            output.push(TextPiece { text, marks });
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
    fn long_credential_continuations_retain_original_text_at_escape_or_token_boundaries() {
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
                    rules.annotations(&output.marks, "response_content", "response");
                    safe.push_str(&output.text);
                }
            }
            for output in stream.feed("", &redactor, true) {
                rules.annotations(&output.marks, "response_content", "response");
                safe.push_str(&output.text);
            }
            assert_eq!(safe, raw, "{forbidden}");
            assert!(safe.contains("visible"));
            assert_eq!(rules.findings.len(), 1, "{forbidden}");
            assert_eq!(rules.findings[0]["confidence"], "medium");
        }
    }

    fn reasons(redactor: &Redactor, value: &str) -> Vec<&'static str> {
        redactor
            .spans(value)
            .into_iter()
            .map(|s| s.reason)
            .collect()
    }

    #[test]
    fn word_shaped_learned_values_do_not_light_up_ordinary_prose() {
        let redactor = Redactor::new(&json!({"token": "instructions"}));
        let prose = "Usually skip visuals for basic instructions, or information already clear.";
        assert!(reasons(&redactor, prose).is_empty());
        // The value still matches when it is the complete value, which is how it
        // appears once a JSON field is walked down to its own string.
        assert_eq!(reasons(&redactor, "instructions"), ["known_credential"]);
        let mut value = json!({"token": "instructions", "note": "basic instructions here"});
        redactor.sanitize(&mut value);
        assert_eq!(value["token"], MARKER);
        assert_eq!(value["note"], "basic instructions here");
    }

    #[test]
    fn authorization_schemes_in_prose_are_not_credential_values() {
        let redactor = Redactor::new(&json!({}));
        for prose in [
            "Usually skip visuals for basic instructions, or information already clear.",
            "Basic authentication is required for this endpoint",
            "bearer token handling is documented elsewhere",
        ] {
            assert!(reasons(&redactor, prose).is_empty(), "{prose}");
        }
        for header in [
            "Authorization: Basic dXNlcjpwYXNzd29yZA==",
            "Authorization: Bearer sk-proj-9fK2mNvQ8xRtZ4wB7hLpY1cD",
            "sent with Basic dXNlcjpwYXNzd29yZA== today",
        ] {
            // Overlapping spans merge under whichever reason starts first, so assert
            // that the value is detected rather than which reason reported it.
            assert!(!reasons(&redactor, header).is_empty(), "{header}");
        }
    }

    #[test]
    fn high_entropy_learned_values_still_match_inside_longer_text() {
        let redactor = Redactor::new(&json!({"key": "sk-proj-9fK2mNvQ8xRtZ4wB7hLpY1cD"}));
        assert_eq!(
            reasons(&redactor, "prefixsk-proj-9fK2mNvQ8xRtZ4wB7hLpY1cDsuffix"),
            ["known_credential"]
        );
    }

    #[test]
    fn public_git_urls_are_not_credentials_but_internal_endpoints_are_recorded() {
        let redactor = Redactor::new(&json!({}));
        assert_eq!(
            reasons(&redactor, "ssh://git@github.com/foo/bar.git"),
            ["internal_identity"]
        );
        assert_eq!(
            reasons(&redactor, "https://user:s3cr3tpassword@internal.test/repo"),
            ["url_credentials"]
        );
        let git = "nssh://git@10.79.10.70:1022/ziyang01.wang/zeroinput.git";
        assert_eq!(
            reasons(&redactor, git),
            ["internal_identity", "internal_host"]
        );
        assert_eq!(
            reasons(&redactor, "http://10.79.10.70:1080/merge_requests/38"),
            ["internal_host"]
        );
        assert!(reasons(&redactor, "https://api.github.test/repos/x").is_empty());
    }

    #[test]
    fn documented_placeholders_are_not_credential_values() {
        let redactor = Redactor::new(&json!({}));
        for value in [
            "password: <your-password-here>",
            "api_key: ${API_KEY}",
            "secret: {{ vault_secret }}",
            "password = None",
            "api_key: TODO",
            "token=xxxxxxxxxxxx",
            "https://x.test/cb?token=YOUR_TOKEN_HERE",
            "https://x.test/cb?token=${TOKEN}",
        ] {
            assert!(reasons(&redactor, value).is_empty(), "{value}");
        }
        // Real values alongside the same field names are still reported.
        for value in [
            "password: hunter2realvalue",
            "https://x.test/cb?token=abc123realtoken",
            "cookie: session=abc123",
        ] {
            assert!(!reasons(&redactor, value).is_empty(), "{value}");
        }
    }

    #[test]
    fn ipv6_endpoints_are_classified_and_colon_syntax_is_not_an_address() {
        let redactor = Redactor::new(&json!({}));
        for (value, expected) in [
            ("[2606:4700:4700::1111]:8443", "public_host"),
            ("ssh root@2a00:1450:4001:828::200e", "public_host"),
            ("server 2606:4700:4700::1111", "public_host"),
            ("http://[fd00::1]:5432/db", "internal_host"),
            ("connect to fe80::1", "internal_host"),
            ("[::1]:8080", "internal_host"),
            ("endpoint 2001:db8::1", "internal_host"),
        ] {
            assert!(
                reasons(&redactor, value).contains(&expected),
                "{value} -> {:?}",
                reasons(&redactor, value)
            );
        }
        // Colons are common in code and logs without naming a host.
        for value in [
            "the value is ::",
            "std::collections::BTreeMap",
            "use core::fmt::Debug",
            "mac 00:1A:2B:3C:4D:5E",
            "at 12:30:45 today",
            "ratio 1:2",
        ] {
            assert!(reasons(&redactor, value).is_empty(), "{value}");
        }
    }

    #[test]
    fn encoded_addresses_resolve_to_the_same_endpoint_class() {
        let redactor = Redactor::new(&json!({}));
        // Every spelling below resolves to 192.168.1.1.
        for value in [
            "http://3232235777/",
            "http://0xC0A80101/",
            "http://0xC0.0xA8.0x01.0x01/",
            "http://0300.0250.0001.0001/",
        ] {
            assert!(
                reasons(&redactor, value).contains(&"internal_host"),
                "{value} -> {:?}",
                reasons(&redactor, value)
            );
        }
        assert!(reasons(&redactor, "http://%31%30%2e%30%2e%30%2e%31/").contains(&"internal_host"));
        assert!(reasons(&redactor, "http://3475931762/").contains(&"public_host"));
        // Numbers outside a host position, and ports, are ordinary data.
        for value in [
            "timeout 3232235777 ms",
            "http://8080/",
            "offset 0xC0A80101 in the dump",
        ] {
            assert!(reasons(&redactor, value).is_empty(), "{value}");
        }
    }

    #[test]
    fn public_server_addresses_are_reported_and_version_strings_are_not() {
        let redactor = Redactor::new(&json!({}));
        for (value, expected) in [
            ("http://203.0.113.45:8443/admin", "public_host"),
            ("ssh root@198.51.100.7", "public_host"),
            ("server 203.0.113.45", "public_host"),
            ("host: 203.0.113.45", "public_host"),
            ("8.8.8.8:53", "public_host"),
            ("connect to 192.168.1.50:5432", "internal_host"),
            ("http://127.0.0.1:8080/health", "internal_host"),
        ] {
            assert!(
                reasons(&redactor, value).contains(&expected),
                "{value} -> {:?}",
                reasons(&redactor, value)
            );
        }
        // A dotted version number shares the shape of an address but is not an endpoint.
        for value in [
            "version 1.2.3.4 released",
            "schema 1.0.0.0 migration",
            "v1.2.3.4",
            "upgraded to version 10.79.10.70",
        ] {
            assert!(reasons(&redactor, value).is_empty(), "{value}");
        }
    }

    #[test]
    fn internal_endpoints_stay_readable_and_are_not_reported_as_credentials() {
        let redactor = Redactor::new(&json!({}));
        let mut value = json!({"url": "ssh://git@10.79.10.70:1022/x.git"});
        redactor.sanitize(&mut value);
        // Recorded for review, not replaced by the redaction marker.
        assert_eq!(value["url"], "ssh://git@10.79.10.70:1022/x.git");
        let mut rules = super::super::rules::Rules::new(&json!({}));
        let marks: Vec<Value> = reasons(&redactor, "ssh://git@10.79.10.70:1022/x.git")
            .into_iter()
            .map(|reason| json!({"reason": reason}))
            .collect();
        rules.annotations(&marks, "request_content", "input/0");
        assert_eq!(rules.findings.len(), 1);
        assert_eq!(rules.findings[0]["ruleId"], "SEC-INTERNAL-001");
        assert_eq!(rules.findings[0]["severity"], "low");
    }
}
