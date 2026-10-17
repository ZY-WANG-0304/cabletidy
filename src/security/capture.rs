use crate::config::array;
use regex::Regex;
use serde_json::{json, Value};
use std::{collections::BTreeSet, sync::LazyLock};

const MARKER: &str = "[REDACTED]";

static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}\b|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"
).unwrap()
});
static PRIVATE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?s)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)"
).unwrap()
});
// The scheme word must be followed by a credential-shaped token. Ordinary prose such as
// "basic instructions" or "bearer token handling" is not an authorization value.
static AUTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]*[0-9._~+/=-][A-Za-z0-9._~+/=-]*|[A-Za-z]{20,})"
).unwrap()
});
static AUTH_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:proxy[-_]?authorization|authorization)["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+([^\s"';,]+)"#).unwrap()
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
    Regex::new(r#"[?&](?P<query_field>[A-Za-z][A-Za-z0-9_-]*)=(?P<value>[^&#\s"']+)"#).unwrap()
});
static COOKIE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\b(?:cookie|set-cookie)\s*:\s*([^\r\n]+)"#).unwrap());
static ESCAPED_CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)\\+["'](?:{})\\+["']\s*[:=]"#,
        credential_pattern()
    ))
    .unwrap()
});

const CREDENTIAL_FIELDS: &[&str] = &[
    "authorization",
    "proxyauthorization",
    "apikey",
    "xapikey",
    "password",
    "passwd",
    "secret",
    "clientsecret",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "token",
    "cookie",
    "setcookie",
    "cookies",
    "upstreamsecrets",
    "privatekey",
    "secretaccesskey",
    "awssecretaccesskey",
    "anthropicapikey",
    "openaiapikey",
    "xauthtoken",
    "authentication",
];

pub(super) fn credential_pattern() -> String {
    CREDENTIAL_FIELDS
        .iter()
        .map(|field| {
            field
                .chars()
                .map(|c| c.to_string())
                .collect::<Vec<_>>()
                .join("[_-]*")
        })
        .map(|pattern| format!("(?:[A-Za-z][A-Za-z0-9]*[_-]+)*{pattern}"))
        .collect::<Vec<_>>()
        .join("|")
}

pub fn credential_field(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    CREDENTIAL_FIELDS.contains(&normalized.as_str())
        || [
            "password",
            "passwd",
            "apikey",
            "accesstoken",
            "refreshtoken",
            "clientsecret",
            "secretaccesskey",
        ]
        .iter()
        .any(|suffix| {
            if !normalized.ends_with(suffix) {
                return false;
            }
            let prefix = normalized.len() - suffix.len();
            let Some((at, first)) = key
                .char_indices()
                .filter(|(_, c)| c.is_ascii_alphanumeric())
                .nth(prefix)
            else {
                return false;
            };
            let previous = key[..at].chars().next_back();
            previous.is_some_and(|c| !c.is_ascii_alphanumeric())
                || first.is_ascii_uppercase()
                    && (previous.is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                        || key[at + 1..]
                            .chars()
                            .next()
                            .is_some_and(|c| c.is_ascii_lowercase()))
        })
}

fn credential_capture<'a>(captures: &regex::Captures<'a>) -> Option<regex::Match<'a>> {
    if let Some(field) = captures.name("field") {
        if !credential_field(field.as_str()) {
            return None;
        }
        return ["quoted", "single", "bare"]
            .into_iter()
            .filter_map(|name| captures.name(name))
            .find(|value| !value.is_empty());
    }
    if let Some(field) = captures.name("query_field") {
        if !credential_field(field.as_str()) {
            return None;
        }
        return captures.name("value");
    }
    captures
        .iter()
        .skip(1)
        .flatten()
        .find(|value| !value.is_empty())
}

// Explicit template syntax only. A value merely starting with `$` or `<` can be a real
// password, so the whole value must look like a variable reference or a `<...>` slot.
//
// Bare assignment/URL spans may end before a template closer. An angle slot must
// be closed, so a literal password starting with `<` is still inspected.
static TEMPLATE_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?s)^(?:\$\{[^}]*\}?|\$[A-Za-z_][A-Za-z0-9_]*|\{\{[^}]*\}?\}?|\{\{?|<[^<>]*>|%[A-Za-z_][A-Za-z0-9_]*%)$"
).unwrap()
});

// A documented placeholder is not a credential. Templates, environment references and
// masking runs are the common shapes; retaining them as hits buries the real values.
fn placeholder_value(value: &str) -> bool {
    let v = value.trim().trim_matches(['"', '\'']);
    if v.is_empty() {
        return true;
    }
    // Unquoted templates may arrive truncated at a brace or whitespace.
    if TEMPLATE_VALUE.is_match(v) {
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
            | "xxx"
            | "example"
            | "placeholder"
            | "redacted"
            | "[redacted]"
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
    // Masking runs such as xxxxxxxx or ********: one repeated masking character. Digits
    // are excluded, because `00000000` and `11111111` are weak passwords, not masks.
    (4..=32).contains(&v.len())
        && v.chars().collect::<BTreeSet<_>>().len() == 1
        && v.chars()
            .next()
            .is_some_and(|c| "x*.-_#?".contains(c.to_ascii_lowercase()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum MatchPolicy {
    CompleteValue,
    CredentialUnit,
    Embedded,
}
impl MatchPolicy {
    pub fn name(self) -> &'static str {
        match self {
            Self::CompleteValue => "complete_value",
            Self::CredentialUnit => "credential_unit",
            Self::Embedded => "embedded",
        }
    }
}
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Credential {
    pub value: String,
    pub evidence: &'static str,
    pub credential_type: &'static str,
    pub match_policy: MatchPolicy,
}
pub(crate) fn credential_type(field: &str) -> &'static str {
    let name = field.to_ascii_lowercase().replace(['_', '-'], "");
    if name.ends_with("password") || name.ends_with("passwd") {
        "password"
    } else if name.ends_with("privatekey") {
        "private_key"
    } else if name.ends_with("apikey") || name.ends_with("secretaccesskey") {
        "api_key"
    } else if name.contains("cookie") {
        "session_token"
    } else if name.ends_with("token") {
        "access_token"
    } else {
        "authentication_secret"
    }
}
#[derive(Clone)]
pub(crate) struct CredentialHit {
    pub start: usize,
    pub end: usize,
    pub reason: &'static str,
    pub source: &'static str,
    pub credential_type: &'static str,
    pub value_type: &'static str,
    pub decoded: Option<String>,
    pub match_policy: MatchPolicy,
}
impl CredentialHit {
    pub fn new(
        start: usize,
        end: usize,
        reason: &'static str,
        source: &'static str,
        kind: &'static str,
    ) -> Self {
        Self {
            start,
            end,
            reason,
            source,
            credential_type: kind,
            value_type: "literal",
            decoded: None,
            match_policy: MatchPolicy::CredentialUnit,
        }
    }
    pub fn strong(&self) -> bool {
        strong_evidence(self.reason)
    }
}
pub(crate) fn strong_evidence(reason: &str) -> bool {
    !matches!(
        reason,
        "jwt_candidate" | "jwt_shape_unverified" | "credential_literal_unverified"
    )
}

// Offline structural check only; no signature, expiry or network validation.
fn jwt_structure(value: &str) -> bool {
    fn object(segment: &str) -> Option<Value> {
        if segment.len() > 32768 {
            return None;
        }
        let mut bytes = Vec::with_capacity(segment.len());
        let mut bits = 0u32;
        let mut count = 0;
        for c in segment.bytes() {
            let n = match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'-' => 62,
                b'_' => 63,
                _ => return None,
            };
            bits = (bits << 6) | n as u32;
            count += 6;
            if count >= 8 {
                count -= 8;
                bytes.push((bits >> count) as u8);
                bits &= (1 << count) - 1;
            }
        }
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        value.is_object().then_some(value)
    }
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && object(parts[0]).is_some_and(|v| v["alg"].is_string())
        && object(parts[1]).is_some()
}

fn cookie_spans(value: &str) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut base = 0;
    for pair in value.split(';') {
        if let Some((name, token)) = pair.split_once('=') {
            let mut token = token.trim();
            let mut start =
                base + pair.find('=').unwrap() + 1 + pair.split_once('=').unwrap().1.len()
                    - pair.split_once('=').unwrap().1.trim_start().len();
            if token.starts_with('"') && token.ends_with('"') && token.len() >= 2 {
                token = &token[1..token.len() - 1];
                start += 1;
            }
            let normalized = name.trim().to_ascii_lowercase().replace(['_', '-'], "");
            if (credential_field(name.trim())
                || matches!(
                    normalized.as_str(),
                    "session" | "sessionid" | "sessiontoken" | "sid" | "auth" | "authsession"
                ))
                && !placeholder_value(token)
                && !crate::protection::is_placeholder(token)
            {
                spans.push(Span {
                    start,
                    end: start + token.len(),
                    reason: "cookie_header",
                });
            }
        }
        base += pair.len() + 1;
    }
    spans
}
fn cookie_hits(value: &str) -> Vec<CredentialHit> {
    cookie_spans(value)
        .into_iter()
        .map(|s| {
            let mut hit =
                CredentialHit::new(s.start, s.end, s.reason, "cookie_pair", "session_token");
            if !substring_matchable(&value[s.start..s.end]) {
                hit.match_policy = MatchPolicy::CompleteValue;
            }
            hit
        })
        .collect()
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
pub(crate) fn substring_matchable(s: &str) -> bool {
    s.len() >= 8
        && (!(word_shaped(s) && shannon_entropy(s) < 3.5)
            || s.len() >= 12
                && s.chars().any(|c| c.is_ascii_uppercase())
                && s.chars().any(|c| c.is_ascii_lowercase()))
}

// Overlapping ranges collapse into one, but a credential must never be reported under
// an annotation-only reason: that would leave the value readable in metadata and make
// the hit impossible to locate. Credential semantics therefore win the merged range.
fn merge_spans(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_by_key(|s| (s.start, std::cmp::Reverse(s.end)));
    let mut merged: Vec<Span> = Vec::new();
    for span in spans {
        if let Some(last) = merged.last_mut() {
            if span.start <= last.end {
                last.end = last.end.max(span.end);
                if (annotation_only(last.reason) && !annotation_only(span.reason))
                    || (matches!(last.reason, "jwt_candidate" | "jwt_shape_unverified")
                        && !matches!(span.reason, "jwt_candidate" | "jwt_shape_unverified"))
                {
                    last.reason = span.reason;
                    last.start = last.start.min(span.start);
                }
                continue;
            }
        }
        merged.push(span);
    }
    merged
}

#[derive(Clone)]
pub(crate) struct Span {
    pub start: usize,
    pub end: usize,
    pub reason: &'static str,
}

pub struct Redactor {
    secrets: Vec<Credential>,
    complete: bool,
    memory: crate::streaming::Reservation,
}

impl Redactor {
    /// Facts only: consumers choose whether a candidate should be replaced.
    pub(crate) fn credential_hits(&self, value: &str, field: Option<&str>) -> Vec<CredentialHit> {
        let mut hits = Vec::new();
        for secret in &self.secrets {
            for (start, _) in value.match_indices(&secret.value) {
                let end = start + secret.value.len();
                let unit = |c: char| c.is_alphanumeric() || c == '_';
                let boundary = !value[..start].chars().next_back().is_some_and(unit)
                    && !value[end..].chars().next().is_some_and(unit);
                if value == secret.value
                    || match secret.match_policy {
                        MatchPolicy::CompleteValue => false,
                        MatchPolicy::CredentialUnit => boundary,
                        MatchPolicy::Embedded => boundary || !word_shaped(&secret.value),
                    }
                {
                    let mut hit = CredentialHit::new(
                        start,
                        end,
                        "known_credential",
                        if secret.evidence == "registered" {
                            "registered_catalog"
                        } else {
                            "trusted_catalog"
                        },
                        secret.credential_type,
                    );
                    hit.match_policy = secret.match_policy;
                    hits.push(hit);
                }
            }
        }
        for m in TOKEN.find_iter(value) {
            let (reason, kind) = if m.as_str().starts_with("eyJ") {
                (
                    if jwt_structure(m.as_str()) {
                        "jwt_candidate"
                    } else {
                        "jwt_shape_unverified"
                    },
                    "jwt",
                )
            } else if m.as_str().starts_with("AKIA") || m.as_str().starts_with("ASIA") {
                ("credential_pattern", "aws_access_id")
            } else {
                ("credential_pattern", "api_key")
            };
            hits.push(CredentialHit::new(
                m.start(),
                m.end(),
                reason,
                "provider_format",
                kind,
            ));
        }
        for m in PRIVATE_KEY.find_iter(value) {
            let mut hit = CredentialHit::new(
                m.start(),
                m.end(),
                "private_key",
                "private_key_envelope",
                "private_key",
            );
            hit.match_policy = MatchPolicy::Embedded;
            hits.push(hit);
        }
        for hit in super::credential_source::assignments(value) {
            let original = hit.decoded.as_deref().unwrap_or(&value[hit.start..hit.end]);
            if !placeholder_value(original) && !crate::protection::is_placeholder(original) {
                hits.push(hit);
            }
        }
        for (regex, reason, source, kind) in [
            (
                &*AUTH,
                "authorization",
                "authorization_scheme",
                "authentication_secret",
            ),
            (
                &*AUTH_VALUE,
                "authorization",
                "authorization_header",
                "authentication_secret",
            ),
            (
                &*URL_AUTH,
                "url_credentials",
                "url_userinfo",
                "authentication_secret",
            ),
            (
                &*URL_SECRET,
                "url_credential_parameter",
                "url_query",
                "authentication_secret",
            ),
        ] {
            for c in regex.captures_iter(value) {
                if let Some(m) = credential_capture(&c) {
                    if !placeholder_value(m.as_str())
                        && !crate::protection::is_placeholder(m.as_str())
                    {
                        let mut hit = CredentialHit::new(m.start(), m.end(), reason, source, kind);
                        if let Some(field) = c.name("query_field") {
                            hit.credential_type = credential_type(field.as_str());
                        }
                        if !substring_matchable(m.as_str()) {
                            hit.match_policy = MatchPolicy::CompleteValue;
                        }
                        hits.push(hit);
                    }
                }
            }
        }
        for c in COOKIE.captures_iter(value) {
            let m = c.get(1).unwrap();
            hits.extend(cookie_hits(m.as_str()).into_iter().map(|mut hit| {
                hit.start += m.start();
                hit.end += m.start();
                hit
            }));
        }
        if let Some(field) = field.filter(|f| credential_field(f)) {
            let normalized = field.to_ascii_lowercase().replace(['_', '-'], "");
            if normalized.contains("cookie") {
                hits.extend(cookie_hits(value));
            } else if normalized.ends_with("authorization")
                || value.starts_with("Bearer ")
                || value.starts_with("Basic ")
            {
                let token = value.trim();
                let (start, end) =
                    if let Some((scheme, rest)) = token.split_once(char::is_whitespace) {
                        if matches!(scheme.to_ascii_lowercase().as_str(), "bearer" | "basic") {
                            let token = rest.trim();
                            let start = value.trim_end().len() - token.len();
                            (start, start + token.len())
                        } else {
                            (0, 0)
                        }
                    } else {
                        (0, value.len())
                    };
                if start < end {
                    let token = &value[start..end];
                    if !placeholder_value(token) && !crate::protection::is_placeholder(token)
                        || self
                            .secrets
                            .iter()
                            .any(|s| s.value == value || s.value == token)
                    {
                        hits.retain(|s| s.start != 0 || s.end != value.len());
                        let mut hit = CredentialHit::new(
                            start,
                            end,
                            "authorization",
                            "authorization_field",
                            "authentication_secret",
                        );
                        if !substring_matchable(token) {
                            hit.match_policy = MatchPolicy::CompleteValue;
                        }
                        hits.push(hit);
                    }
                }
            } else if (!placeholder_value(value) || matches!(value, "null" | "true" | "false"))
                && !crate::protection::is_placeholder(value)
            {
                let mut hit = CredentialHit::new(
                    0,
                    value.len(),
                    "credential_field",
                    "json_field",
                    credential_type(field),
                );
                if !substring_matchable(value) {
                    hit.match_policy = MatchPolicy::CompleteValue;
                }
                hits.push(hit);
            }
        }
        // Resolve containment before merging, so a strong literal retains its decoded
        // value and provenance rather than acquiring a catalog hit from the second pass.
        hits.sort_by_key(|h| {
            (
                h.start,
                std::cmp::Reverse(h.end),
                !h.strong(),
                h.reason == "known_credential",
                matches!(h.source, "provider_format" | "authorization_scheme"),
            )
        });
        let mut merged: Vec<CredentialHit> = Vec::new();
        for hit in hits {
            if let Some(last) = merged.last_mut() {
                if hit.start < last.end {
                    if !last.strong() && hit.strong() {
                        *last = hit;
                        continue;
                    }
                    if last.strong() && !hit.strong() {
                        continue;
                    }
                    let start = last.start;
                    let end = last.end.max(hit.end);
                    if hit.end > last.end {
                        last.end = hit.end;
                        last.decoded = None;
                    }
                    if last.start != start || last.end != end {
                        last.start = start;
                        last.end = end;
                        last.decoded = None;
                    }
                    continue;
                }
            }
            merged.push(hit);
        }
        merged
    }
    pub(crate) fn credential_spans(&self, value: &str, field: Option<&str>) -> Vec<Span> {
        self.credential_hits(value, field)
            .into_iter()
            .map(|h| Span {
                start: h.start,
                end: h.end,
                reason: h.reason,
            })
            .collect()
    }
    pub(crate) fn protection_ranges(&self, value: &str, forced: bool) -> Vec<(usize, usize)> {
        self.credential_spans(value, forced.then_some("password"))
            .into_iter()
            .filter(|s| strong_evidence(s.reason))
            .map(|s| (s.start, s.end))
            .collect()
    }
    pub(super) fn catalog_digest(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut values: Vec<_> = self
            .secrets
            .iter()
            .map(|s| {
                (
                    &s.value,
                    s.evidence,
                    s.credential_type,
                    s.match_policy.name(),
                )
            })
            .collect();
        values.sort_unstable();
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!([super::credentials::VERSION, self.complete, values]))
                    .unwrap()
            )
        )
    }
    pub fn available(&self) -> bool {
        self.complete
    }
    #[cfg(test)]
    pub fn credential(&mut self, s: &str) {
        self.trust(&Credential {
            value: s.into(),
            evidence: "observed",
            credential_type: "authentication_secret",
            match_policy: if substring_matchable(s) {
                MatchPolicy::Embedded
            } else {
                MatchPolicy::CompleteValue
            },
        });
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

    pub(crate) fn catalog(&self) -> Vec<Credential> {
        self.secrets.clone()
    }
    pub(crate) fn trust(&mut self, entry: &Credential) {
        if entry.value.is_empty() {
            return;
        }
        if let Some(existing) = self.secrets.iter_mut().find(|v| v.value == entry.value) {
            if entry.match_policy > existing.match_policy {
                *existing = entry.clone();
            }
            return;
        }
        if self
            .memory
            .grow(entry.value.len().saturating_mul(12).saturating_add(256))
            .is_err()
        {
            self.complete = false;
        } else {
            self.secrets.push(entry.clone());
        }
    }

    fn learn(&mut self, value: &Value) {
        match value {
            Value::String(s) if !s.is_empty() => {
                self.trust(&Credential {
                    value: s.clone(),
                    evidence: "registered",
                    credential_type: "registered_secret",
                    match_policy: MatchPolicy::Embedded,
                });
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
                        for value in v
                            .as_str()
                            .into_iter()
                            .chain(array(v).iter().filter_map(Value::as_str))
                        {
                            let found = self.credential_hits(value, Some(key));
                            for hit in found.into_iter().filter(CredentialHit::strong) {
                                self.trust(&Credential {
                                    value: hit
                                        .decoded
                                        .unwrap_or_else(|| value[hit.start..hit.end].into()),
                                    evidence: hit.reason,
                                    credential_type: hit.credential_type,
                                    match_policy: hit.match_policy,
                                });
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
        let mut spans = self.endpoint_spans(value);
        spans.extend(self.credential_spans(value, None));
        merge_spans(spans)
    }
    fn endpoint_spans(&self, value: &str) -> Vec<Span> {
        let mut spans = Vec::new();
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
            // A bracketed address is already in host position. Judge its context from
            // before the `[`, since `http://[` cannot end the context pattern.
            let context_end = if bracketed.is_some() {
                address.start().saturating_sub(1)
            } else {
                address.start()
            };
            if port.is_none() && !HOST_CONTEXT.is_match(&value[..context_end]) {
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
        for c in URL_USERNAME.captures_iter(value) {
            if let Some(m) = c.get(1) {
                spans.push(Span {
                    start: m.start(),
                    end: m.end(),
                    reason: "internal_identity",
                });
            }
        }
        merge_spans(spans)
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
    shared_offset: u64,
    shared: bool,
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
            shared_offset: 0,
            shared: false,
            _memory: memory,
        })
    }
    pub(crate) fn feed_detected(
        &mut self,
        input: &str,
        redactor: &Redactor,
        end: bool,
        marks: &[Value],
    ) -> Vec<TextPiece> {
        self.shared = true;
        self.forced = false;
        let mut pieces = self.feed(input, redactor, end);
        for piece in &mut pieces {
            let from = self.shared_offset;
            let to = from + piece.text.len() as u64;
            for mark in marks {
                let start = mark["start"].as_u64().unwrap_or(0).max(from);
                let stop = mark["end"].as_u64().unwrap_or(0).min(to);
                if start < stop {
                    let mut mark = mark.clone();
                    mark["start"] = json!(start - from);
                    mark["end"] = json!(stop - from);
                    piece.marks.push(mark);
                }
            }
            self.shared_offset = to;
        }
        pieces
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
            .map(|s| s.value.len() * 6)
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
            let mut spans = if self.shared {
                redactor.endpoint_spans(&self.pending)
            } else {
                redactor.spans(&self.pending)
            };
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
            if !end && !self.shared {
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
            if !end && !self.shared {
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
            let spans = merge_spans(spans);
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
                        "credential_assignment"
                        | "credential_literal_unverified"
                        | "url_credential_parameter"
                        | "cookie_header" => {
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
    fn assignment_and_url_fields_share_structural_credential_names() {
        let redactor = Redactor::new(&json!({}));
        let secret = "freshPlainCredentialValue42";
        for field in CREDENTIAL_FIELDS
            .iter()
            .filter(|f| !matches!(**f, "cookie" | "cookies" | "setcookie"))
        {
            for name in [
                field.to_string(),
                field.to_ascii_uppercase(),
                field
                    .chars()
                    .map(|c| c.to_string())
                    .collect::<Vec<_>>()
                    .join("_"),
            ] {
                assert!(credential_field(&name));
                assert!(ESCAPED_CREDENTIAL.is_match(&format!(r#"{{\"{name}\":\"{secret}"#)));
                for text in [
                    format!("{name}={secret}"),
                    format!("{name}=\"{secret}\""),
                    format!("https://example.test/?{name}={secret}"),
                ] {
                    let start = text.find(secret).unwrap();
                    assert_eq!(
                        redactor.protection_ranges(&text, false),
                        vec![(start, start + secret.len())],
                        "{text}"
                    );
                    assert!(
                        redactor
                            .spans(&text)
                            .iter()
                            .any(|s| s.start <= start && s.end >= start + secret.len()),
                        "{text}"
                    );
                }
            }
        }
        for text in [
            "type=string",
            "encoding=utf8",
            "https://example.test/?id=ordinary",
            "MY_OPENAI_API_KEY=$MY_OPENAI_API_KEY",
            "Tool output: safe",
        ] {
            assert!(redactor.protection_ranges(text, false).is_empty(), "{text}");
        }
    }

    #[test]
    fn word_shaped_learned_values_do_not_light_up_ordinary_prose() {
        let mut redactor = Redactor::new(&json!({}));
        redactor.credential("instructions");
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
            "password: <token>",
            "api_key: ${API_KEY}",
            "api_key: $API_KEY",
            "secret: {{ vault_secret }}",
            "password = None",
            "api_key: TODO",
            "token=xxxxxxxxxxxx",
            "https://x.test/cb?token=YOUR_TOKEN_HERE",
            "https://x.test/cb?token=${TOKEN}",
        ] {
            assert!(reasons(&redactor, value).is_empty(), "{value}");
        }
        // Real values alongside the same field names are still reported. A `$` prefix
        // or a repeated digit is a weak password, not template or masking syntax.
        for value in [
            "password: hunter2realvalue",
            "https://x.test/cb?token=abc123realtoken",
            "cookie: session=abc123",
            "password: $9fK2mNvQ8xRtZ4wB7hLpY1cD",
            "password: 11111111",
            "password=aaaaaaaa",
            // An unclosed angle bracket is not a slot, and digits are not a mask.
            "password=<9fK2mNvQ8xRtZ4wB7hLpY1cD",
            "password: 00000000",
        ] {
            assert!(!reasons(&redactor, value).is_empty(), "{value}");
        }
    }

    #[test]
    fn credential_semantics_survive_an_overlapping_endpoint_range() {
        let redactor = Redactor::new(&json!({"key": "a1b2c3d4e5"}));
        // `internal_identity` starts earlier than the credential inside the userinfo.
        // The merged range must keep credential semantics or the value stays readable.
        let value = "ssh://user-a1b2c3d4e5@host/repo";
        assert_eq!(reasons(&redactor, value), ["known_credential"]);
        let mut metadata = json!({"url": value});
        redactor.sanitize(&mut metadata);
        assert_eq!(metadata["url"], "ssh://[REDACTED]@host/repo");
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
            // A bracketed URL is host position even without a port.
            ("http://[fd00::1]/", "internal_host"),
            ("http://[2606:4700:4700::1111]/", "public_host"),
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
