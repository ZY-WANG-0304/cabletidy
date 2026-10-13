//! Bounded source indexes. Display coordinates are computed only while reading evidence.
use crate::streaming::Reservation;
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::{cell::Cell, collections::BTreeSet, fmt, rc::Rc};

const NONE: usize = usize::MAX;
const MAX_NODES: usize = 128 * 1024;
const WORKSPACE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct Limit;
impl fmt::Display for Limit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("evidence_working_memory_budget")
    }
}
impl std::error::Error for Limit {}

struct State {
    used: Cell<usize>,
    limit: usize,
    #[cfg(test)]
    prepared: Cell<usize>,
}
pub(super) struct Workspace<'a> {
    state: Rc<State>,
    cancelled: &'a dyn Fn() -> bool,
}
impl<'a> Workspace<'a> {
    pub(super) fn new(cancelled: &'a dyn Fn() -> bool) -> Self {
        Self::with_limit(
            cancelled,
            crate::streaming::budget("CABLETIDY_TEST_EVIDENCE_WORKSPACE_BYTES", WORKSPACE_BYTES)
                as usize,
        )
    }
    pub(super) fn with_limit(cancelled: &'a dyn Fn() -> bool, limit: usize) -> Self {
        Self {
            state: Rc::new(State {
                used: Cell::new(0),
                limit,
                #[cfg(test)]
                prepared: Cell::new(0),
            }),
            cancelled,
        }
    }
    pub(super) fn check(&self) -> Result<()> {
        if (self.cancelled)() {
            bail!("overview_cancelled");
        }
        Ok(())
    }
    pub(super) fn allocation(&self) -> Allocation {
        Allocation {
            state: self.state.clone(),
            memory: Reservation::memory(),
        }
    }
}
pub(super) struct Allocation {
    state: Rc<State>,
    memory: Reservation,
}
impl Allocation {
    pub(super) fn grow(&mut self, bytes: usize) -> Result<()> {
        let used = self.state.used.get().checked_add(bytes).ok_or(Limit)?;
        if used > self.state.limit {
            return Err(Limit.into());
        }
        self.memory.grow(bytes).map_err(|_| Limit)?;
        self.state.used.set(used);
        Ok(())
    }
}
impl Drop for Allocation {
    fn drop(&mut self) {
        self.state
            .used
            .set(self.state.used.get() - self.memory.bytes as usize);
    }
}

// Containers own no values or source strings; every token points into one input.
struct Node {
    start: usize,
    end: usize,
    kind: u8,
    child: usize,
    sibling: usize,
    key_start: usize,
    key_end: usize,
}
struct Index {
    nodes: Vec<Node>,
    _memory: Allocation,
}
impl Index {
    fn parse(input: &str, workspace: &Workspace<'_>) -> Result<Self> {
        struct Parser<'a, 'b, 'c> {
            input: &'a str,
            at: usize,
            checked: usize,
            index: Index,
            workspace: &'b Workspace<'c>,
        }
        impl Parser<'_, '_, '_> {
            fn check(&mut self) -> Result<()> {
                if self.at >= self.checked {
                    self.workspace.check()?;
                    self.checked = self.at.saturating_add(crate::streaming::PAGE);
                }
                Ok(())
            }
            fn ws(&mut self) -> Result<()> {
                while self
                    .input
                    .as_bytes()
                    .get(self.at)
                    .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
                {
                    self.at += 1;
                    self.check()?;
                }
                Ok(())
            }
            fn expect(&mut self, byte: u8) -> Result<()> {
                if self.input.as_bytes().get(self.at) != Some(&byte) {
                    bail!("invalid_json");
                }
                self.at += 1;
                Ok(())
            }
            fn string(&mut self) -> Result<()> {
                self.expect(b'"')?;
                loop {
                    self.check()?;
                    match self.input.as_bytes().get(self.at).copied() {
                        Some(b'"') => {
                            self.at += 1;
                            return Ok(());
                        }
                        Some(b'\\') => {
                            self.at += escaped_char(self.input, self.at)?.1;
                        }
                        Some(0..=31) | None => bail!("invalid_json"),
                        Some(_) => self.at += 1,
                    }
                }
            }
            fn number(&mut self) -> Result<()> {
                let bytes = self.input.as_bytes();
                if bytes.get(self.at) == Some(&b'-') {
                    self.at += 1;
                }
                match bytes.get(self.at) {
                    Some(b'0') => self.at += 1,
                    Some(b'1'..=b'9') => {
                        while bytes.get(self.at).is_some_and(u8::is_ascii_digit) {
                            self.at += 1;
                            self.check()?;
                        }
                    }
                    _ => bail!("invalid_json"),
                }
                for marker in *b".e" {
                    if bytes
                        .get(self.at)
                        .is_some_and(|b| *b == marker || marker == b'e' && *b == b'E')
                    {
                        self.at += 1;
                        if marker == b'e'
                            && bytes.get(self.at).is_some_and(|b| *b == b'+' || *b == b'-')
                        {
                            self.at += 1;
                        }
                        let start = self.at;
                        while bytes.get(self.at).is_some_and(u8::is_ascii_digit) {
                            self.at += 1;
                            self.check()?;
                        }
                        if start == self.at {
                            bail!("invalid_json");
                        }
                    }
                }
                Ok(())
            }
            fn value(&mut self, depth: usize, key: (usize, usize)) -> Result<usize> {
                if depth > 128 || self.index.nodes.len() >= MAX_NODES {
                    return Err(Limit.into());
                }
                self.workspace.check()?;
                self.ws()?;
                let kind = *self
                    .input
                    .as_bytes()
                    .get(self.at)
                    .ok_or_else(|| anyhow::anyhow!("invalid_json"))?;
                let id = self.index.nodes.len();
                if id == self.index.nodes.capacity() {
                    let count = (self.index.nodes.capacity().max(32)).min(MAX_NODES - id);
                    self.index
                        ._memory
                        .grow(count * std::mem::size_of::<Node>())?;
                    self.index
                        .nodes
                        .try_reserve_exact(count)
                        .map_err(|_| Limit)?;
                }
                self.index.nodes.push(Node {
                    start: self.at,
                    end: 0,
                    kind,
                    child: NONE,
                    sibling: NONE,
                    key_start: key.0,
                    key_end: key.1,
                });
                match kind {
                    b'{' | b'[' => {
                        self.at += 1;
                        self.ws()?;
                        let close = if kind == b'{' { b'}' } else { b']' };
                        let mut previous = NONE;
                        if self.input.as_bytes().get(self.at) != Some(&close) {
                            loop {
                                let key = if kind == b'{' {
                                    let start = self.at;
                                    self.string()?;
                                    let end = self.at;
                                    self.ws()?;
                                    self.expect(b':')?;
                                    (start, end)
                                } else {
                                    (NONE, NONE)
                                };
                                let child = self.value(depth + 1, key)?;
                                if previous == NONE {
                                    self.index.nodes[id].child = child;
                                } else {
                                    self.index.nodes[previous].sibling = child;
                                }
                                previous = child;
                                self.ws()?;
                                if self.input.as_bytes().get(self.at) == Some(&close) {
                                    break;
                                }
                                self.expect(b',')?;
                                self.ws()?;
                            }
                        }
                        self.expect(close)?;
                    }
                    b'"' => self.string()?,
                    b't' | b'f' | b'n' => {
                        let word = match kind {
                            b't' => "true",
                            b'f' => "false",
                            _ => "null",
                        };
                        if !self.input[self.at..].starts_with(word) {
                            bail!("invalid_json");
                        }
                        self.at += word.len();
                    }
                    b'-' | b'0'..=b'9' => self.number()?,
                    _ => bail!("invalid_json"),
                }
                self.index.nodes[id].end = self.at;
                Ok(id)
            }
        }
        let mut parser = Parser {
            input,
            at: 0,
            checked: 0,
            index: Self {
                nodes: Vec::new(),
                _memory: workspace.allocation(),
            },
            workspace,
        };
        parser.value(0, (NONE, NONE))?;
        parser.ws()?;
        if parser.at != input.len() {
            bail!("invalid_json");
        }
        Ok(parser.index)
    }
    fn children(&self, id: usize) -> impl Iterator<Item = usize> + '_ {
        std::iter::successors(
            (self.nodes[id].child != NONE).then_some(self.nodes[id].child),
            |id| (self.nodes[*id].sibling != NONE).then_some(self.nodes[*id].sibling),
        )
    }
    fn member(
        &self,
        input: &str,
        id: usize,
        key: &str,
        workspace: &Workspace<'_>,
    ) -> Result<Option<usize>> {
        if self.nodes[id].kind != b'{' {
            return Ok(None);
        }
        let mut found = None;
        for child in self.children(id) {
            if chars_equal(string_chars(self.key(input, child)), key.chars(), workspace)? {
                found = Some(child);
            }
        }
        Ok(found)
    }
    fn key<'a>(&self, input: &'a str, id: usize) -> &'a str {
        &input[self.nodes[id].key_start..self.nodes[id].key_end]
    }
    fn token<'a>(&self, input: &'a str, id: usize) -> &'a str {
        &input[self.nodes[id].start..self.nodes[id].end]
    }
    fn hit(&self, id: usize, finding: usize, nested: bool) -> Hit {
        let node = &self.nodes[id];
        let quote = usize::from(node.kind == b'"');
        Hit {
            start: node.start + quote,
            end: node.end - quote,
            finding,
            nested,
        }
    }
}

fn escaped_char(input: &str, at: usize) -> Result<(char, usize)> {
    let bytes = input.as_bytes();
    let c = match bytes.get(at + 1) {
        Some(b'"') => '"',
        Some(b'\\') => '\\',
        Some(b'/') => '/',
        Some(b'b') => '\u{8}',
        Some(b'f') => '\u{c}',
        Some(b'n') => '\n',
        Some(b'r') => '\r',
        Some(b't') => '\t',
        Some(b'u') => {
            let hex = |from: usize| -> Result<u16> {
                let raw = input
                    .get(from..from + 4)
                    .ok_or_else(|| anyhow::anyhow!("invalid_json"))?;
                if !raw.bytes().all(|b| b.is_ascii_hexdigit()) {
                    bail!("invalid_json");
                }
                Ok(u16::from_str_radix(raw, 16)?)
            };
            let first = hex(at + 2)?;
            if (0xd800..=0xdbff).contains(&first) {
                if bytes.get(at + 6..at + 8) != Some(b"\\u") {
                    bail!("invalid_json");
                }
                let second = hex(at + 8)?;
                if !(0xdc00..=0xdfff).contains(&second) {
                    bail!("invalid_json");
                }
                let scalar =
                    0x10000 + ((u32::from(first) - 0xd800) << 10) + u32::from(second) - 0xdc00;
                return Ok((char::from_u32(scalar).unwrap(), 12));
            }
            return Ok((
                char::from_u32(u32::from(first)).ok_or_else(|| anyhow::anyhow!("invalid_json"))?,
                6,
            ));
        }
        _ => bail!("invalid_json"),
    };
    Ok((c, 2))
}
fn string_chars(token: &str) -> impl Iterator<Item = char> + '_ {
    let end = token.len() - 1;
    let mut at = 1;
    std::iter::from_fn(move || {
        if at >= end {
            return None;
        }
        let (c, size) = if token.as_bytes()[at] == b'\\' {
            escaped_char(token, at).ok()?
        } else {
            let c = token[at..].chars().next()?;
            (c, c.len_utf8())
        };
        at += size;
        Some(c)
    })
}

fn chars_equal(
    mut left: impl Iterator<Item = char>,
    mut right: impl Iterator<Item = char>,
    workspace: &Workspace<'_>,
) -> Result<bool> {
    let mut count = 0;
    loop {
        if count % crate::streaming::PAGE == 0 {
            workspace.check()?;
        }
        match (left.next(), right.next()) {
            (None, None) => return Ok(true),
            (Some(a), Some(b)) if a == b => count += 1,
            _ => return Ok(false),
        }
    }
}

struct Expected<'a> {
    input: &'a str,
    index: Option<Index>,
}
impl<'a> Expected<'a> {
    fn new(input: &'a str, workspace: &Workspace<'_>) -> Result<Self> {
        let index = match Index::parse(input, workspace) {
            Ok(index) => Some(index),
            Err(e) if e.is::<Limit>() => return Err(e),
            Err(e) => {
                workspace.check()?;
                let _ = e;
                None
            }
        };
        Ok(Self { input, index })
    }
    fn string(&self) -> bool {
        self.index.as_ref().is_none_or(|i| i.nodes[0].kind == b'"')
    }
    fn equals_text(&self, text: &str, workspace: &Workspace<'_>) -> Result<bool> {
        if let Some(i) = &self.index {
            Ok(i.nodes[0].kind == b'"'
                && chars_equal(
                    string_chars(i.token(self.input, 0)),
                    text.chars(),
                    workspace,
                )?)
        } else {
            chars_equal(self.input.chars(), text.chars(), workspace)
        }
    }
}

fn matches(
    left: (&Index, &str, usize),
    right: (&Index, &str, usize),
    projection: bool,
    workspace: &Workspace<'_>,
) -> Result<bool> {
    workspace.check()?;
    let (a, input, id) = left;
    let (b, expected, other) = right;
    let node = &a.nodes[id];
    let target = &b.nodes[other];
    let equal = match target.kind {
        b'{' => {
            if node.kind != b'{'
                || !projection && a.children(id).count() != b.children(other).count()
            {
                return Ok(false);
            }
            for child in b.children(other) {
                let key = b.key(expected, child);
                let mut found = None;
                for candidate in a.children(id) {
                    if chars_equal(
                        string_chars(a.key(input, candidate)),
                        string_chars(key),
                        workspace,
                    )? {
                        found = Some(candidate);
                    }
                }
                let Some(found) = found else {
                    return Ok(false);
                };
                if !matches((a, input, found), (b, expected, child), false, workspace)? {
                    return Ok(false);
                }
            }
            true
        }
        b'[' => {
            if node.kind != b'[' || a.children(id).count() != b.children(other).count() {
                return Ok(false);
            }
            for (child, target) in a.children(id).zip(b.children(other)) {
                if !matches((a, input, child), (b, expected, target), false, workspace)? {
                    return Ok(false);
                }
            }
            true
        }
        b'"' => {
            node.kind == b'"'
                && chars_equal(
                    string_chars(a.token(input, id)),
                    string_chars(b.token(expected, other)),
                    workspace,
                )?
        }
        b't' | b'f' | b'n' => node.kind == target.kind,
        _ => {
            if !matches!(node.kind, b'-' | b'0'..=b'9') {
                return Ok(false);
            }
            let token = a.token(input, id);
            let expected = b.token(expected, other);
            if token.len().max(expected.len()) > crate::streaming::PAGE {
                return Err(Limit.into());
            }
            let mut memory = workspace.allocation();
            memory.grow(token.len() + expected.len() + 256)?;
            let a: Value = serde_json::from_str(token)?;
            let b: Value = serde_json::from_str(expected)?;
            a == b
        }
    };
    Ok(equal)
}

struct Decoded {
    input: String,
    index: Index,
    _memory: Allocation,
}
struct Prepared<'a> {
    input: &'a str,
    index: Index,
    node: usize,
    function: bool,
    decoded: Option<Decoded>,
}
impl<'a> Prepared<'a> {
    fn new(input: &'a str, workspace: &Workspace<'_>) -> Result<Self> {
        #[cfg(test)]
        workspace
            .state
            .prepared
            .set(workspace.state.prepared.get() + 1);
        let index = Index::parse(input, workspace)?;
        let kind = index.member(input, 0, "type", workspace)?;
        let is = |name: &str| -> Result<bool> {
            match kind {
                Some(id) if index.nodes[id].kind == b'"' => chars_equal(
                    string_chars(index.token(input, id)),
                    name.chars(),
                    workspace,
                ),
                _ => Ok(false),
            }
        };
        let function = is("function_call")?;
        let node =
            if function || is("custom_tool_call")? || is("tool_use")? || is("server_tool_use")? {
                index
                    .member(
                        input,
                        0,
                        if function { "arguments" } else { "input" },
                        workspace,
                    )?
                    .ok_or_else(|| anyhow::anyhow!("missing_tool_input"))?
            } else {
                0
            };
        let decoded = if index.nodes[node].kind == b'"' {
            let token = index.token(input, node);
            let mut memory = workspace.allocation();
            memory.grow(token.len())?;
            let mut decoded = String::with_capacity(token.len());
            for (i, c) in string_chars(token).enumerate() {
                if i % crate::streaming::PAGE == 0 {
                    workspace.check()?;
                }
                decoded.push(c);
            }
            match Index::parse(&decoded, workspace) {
                Ok(index) => Some(Decoded {
                    input: decoded,
                    index,
                    _memory: memory,
                }),
                Err(e) if e.is::<Limit>() => return Err(e),
                Err(_) => {
                    workspace.check()?;
                    None
                }
            }
        } else {
            None
        };
        Ok(Self {
            input,
            index,
            node,
            function,
            decoded,
        })
    }
    fn hits(
        &self,
        expected: &Expected<'_>,
        finding: usize,
        locator: &Value,
        workspace: &Workspace<'_>,
        memory: &mut Allocation,
        out: &mut Vec<Hit>,
    ) -> Result<()> {
        let nested = self.decoded.is_some() && (!expected.string() || self.function);
        let (index, input, node) = if nested {
            let decoded = self.decoded.as_ref().unwrap();
            (&decoded.index, decoded.input.as_str(), 0)
        } else {
            (&self.index, self.input, self.node)
        };
        let Some(target) = &expected.index else {
            if index.nodes[node].kind == b'"'
                && chars_equal(
                    string_chars(index.token(input, node)),
                    expected.input.chars(),
                    workspace,
                )?
            {
                push_hit(out, index.hit(node, finding, nested), memory)?;
            }
            return Ok(());
        };
        if !matches(
            (index, input, node),
            (target, expected.input, 0),
            true,
            workspace,
        )? {
            return Ok(());
        }
        if target.nodes[0].kind == b'{' {
            for field in target.children(0) {
                let key = target.key(expected.input, field);
                if locator["version"] == 1 {
                    if let Some(fields) = locator["fields"].as_array() {
                        let mut present = false;
                        for field in fields {
                            if let Some(path) = field["path"].as_array() {
                                if path.len() == 1 {
                                    if let Some(name) = path[0].as_str() {
                                        present |= chars_equal(
                                            string_chars(key),
                                            name.chars(),
                                            workspace,
                                        )?;
                                    }
                                }
                            }
                        }
                        if !present {
                            continue;
                        }
                    }
                }
                let mut id = None;
                for child in index.children(node) {
                    if chars_equal(
                        string_chars(index.key(input, child)),
                        string_chars(key),
                        workspace,
                    )? {
                        id = Some(child);
                    }
                }
                let id = id.unwrap();
                push_hit(out, index.hit(id, finding, nested), memory)?;
            }
        } else {
            push_hit(out, index.hit(node, finding, nested), memory)?;
        }
        Ok(())
    }
    fn map_nested(&self, hits: &mut [Hit], workspace: &Workspace<'_>) -> Result<()> {
        let node = &self.index.nodes[self.node];
        map_endpoints(hits, true, workspace, |points| {
            let mut source = node.start + 1;
            let mut decoded = 0;
            for (wanted, slot) in points {
                while decoded < *wanted && source < node.end - 1 {
                    if source % crate::streaming::PAGE < 12 {
                        workspace.check()?;
                    }
                    let (c, consumed) = if self.input.as_bytes()[source] == b'\\' {
                        escaped_char(self.input, source)?
                    } else {
                        let c = self.input[source..].chars().next().unwrap();
                        (c, c.len_utf8())
                    };
                    source += consumed;
                    decoded += c.len_utf8();
                }
                if decoded != *wanted {
                    bail!("invalid_evidence_offset");
                }
                *slot = source;
            }
            Ok(())
        })
    }
}

struct Hit {
    start: usize,
    end: usize,
    finding: usize,
    nested: bool,
}
fn push_hit(out: &mut Vec<Hit>, hit: Hit, memory: &mut Allocation) -> Result<()> {
    if hit.end <= hit.start {
        return Ok(());
    }
    if out.len() == out.capacity() {
        let count = out.capacity().max(8);
        memory.grow(count * std::mem::size_of::<Hit>())?;
        out.try_reserve_exact(count).map_err(|_| Limit)?;
    }
    out.push(hit);
    Ok(())
}
fn map_endpoints(
    hits: &mut [Hit],
    nested_only: bool,
    workspace: &Workspace<'_>,
    map: impl FnOnce(&mut [(usize, usize)]) -> Result<()>,
) -> Result<()> {
    let count = hits.iter().filter(|h| !nested_only || h.nested).count() * 2;
    let mut memory = workspace.allocation();
    memory.grow(count * std::mem::size_of::<(usize, usize)>())?;
    let mut points = Vec::with_capacity(count);
    for (i, hit) in hits
        .iter()
        .enumerate()
        .filter(|(_, h)| !nested_only || h.nested)
    {
        points.push((hit.start, i * 2));
        points.push((hit.end, i * 2 + 1));
    }
    points.sort_unstable_by_key(|p| p.0);
    // Preserve endpoint identities while the mapping replaces their positions.
    let mut order_memory = workspace.allocation();
    order_memory.grow(count * std::mem::size_of::<usize>())?;
    let order: Vec<_> = points.iter().map(|p| p.1).collect();
    map(&mut points)?;
    for ((_, mapped), id) in points.into_iter().zip(order) {
        if id % 2 == 0 {
            hits[id / 2].start = mapped;
        } else {
            hits[id / 2].end = mapped;
        }
    }
    Ok(())
}
fn to_utf16(input: &str, hits: &mut [Hit], workspace: &Workspace<'_>) -> Result<()> {
    map_endpoints(hits, false, workspace, |points| {
        let mut at = 0;
        let mut units = 0;
        for (wanted, result) in points {
            while at < *wanted {
                if at % crate::streaming::PAGE < 4 {
                    workspace.check()?;
                }
                let c = input[at..]
                    .chars()
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("invalid_evidence_offset"))?;
                at += c.len_utf8();
                units += c.len_utf16();
            }
            if at != *wanted {
                bail!("invalid_evidence_offset");
            }
            *result = units;
        }
        Ok(())
    })
}

pub(super) struct Request<'a> {
    pub raw: &'a Value,
    pub id: &'a str,
    pub structured: bool,
    pub locator: &'a Value,
}
pub(super) struct Located {
    pub ranges: Vec<Value>,
    pub gaps: BTreeSet<usize>,
}
pub(super) fn locate(
    input: &str,
    requests: &[Request<'_>],
    workspace: &Workspace<'_>,
    output: &mut Allocation,
) -> Result<Located> {
    let mut gaps = BTreeSet::new();
    let mut hits = Vec::new();
    let mut memory = workspace.allocation();
    let prepared = if requests.iter().any(|r| r.structured) {
        match Prepared::new(input, workspace) {
            Ok(p) => Some(p),
            Err(e) if e.is::<Limit>() => {
                gaps.extend(
                    requests
                        .iter()
                        .enumerate()
                        .filter(|(_, r)| r.structured)
                        .map(|(i, _)| i),
                );
                None
            }
            Err(_) => {
                workspace.check()?;
                None
            }
        }
    } else {
        None
    };
    for (finding, request) in requests.iter().enumerate() {
        workspace.check()?;
        if gaps.contains(&finding) {
            continue;
        }
        let start = hits.len();
        let mut raw = |out: &mut Vec<Hit>| -> Result<()> {
            let raws: Box<dyn Iterator<Item = &str> + '_> =
                if let Some(values) = request.raw.as_array() {
                    Box::new(values.iter().filter_map(Value::as_str))
                } else {
                    Box::new(request.raw.as_str().into_iter())
                };
            for raw in raws {
                if request.structured {
                    let expected = Expected::new(raw, workspace)?;
                    if expected.string() && expected.equals_text(input, workspace)? {
                        push_hit(
                            out,
                            Hit {
                                start: 0,
                                end: input.len(),
                                finding,
                                nested: false,
                            },
                            &mut memory,
                        )?;
                    } else if let Some(p) = &prepared {
                        p.hits(
                            &expected,
                            finding,
                            request.locator,
                            workspace,
                            &mut memory,
                            out,
                        )?;
                    }
                } else {
                    text_hits(input, raw, finding, workspace, &mut memory, out)?;
                }
            }
            Ok(())
        };
        match raw(&mut hits) {
            Ok(()) => (),
            Err(e) if e.is::<Limit>() => {
                hits.truncate(start);
                gaps.insert(finding);
            }
            Err(_) => {
                workspace.check()?;
                hits.truncate(start);
            }
        }
    }
    if let Some(p) = &prepared {
        p.map_nested(&mut hits, workspace)?;
    }
    to_utf16(input, &mut hits, workspace)?;
    let mut ranges = Vec::new();
    output.grow(
        hits.len() * 768
            + hits
                .iter()
                .map(|h| requests[h.finding].id.len())
                .sum::<usize>(),
    )?;
    ranges.try_reserve_exact(hits.len()).map_err(|_| Limit)?;
    for hit in hits {
        ranges.push(json!({"start":hit.start,"end":hit.end,"findingId":requests[hit.finding].id}));
    }
    Ok(Located { ranges, gaps })
}

pub(super) fn render(
    value: &Value,
    pretty: bool,
    workspace: &Workspace<'_>,
    memory: &mut Allocation,
) -> Result<String> {
    struct Count<'a, 'b> {
        bytes: usize,
        checked: usize,
        workspace: &'a Workspace<'b>,
    }
    impl std::io::Write for Count<'_, '_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes = self
                .bytes
                .checked_add(bytes.len())
                .ok_or_else(|| std::io::Error::other(Limit))?;
            if self.bytes >= self.checked {
                self.workspace.check().map_err(std::io::Error::other)?;
                self.checked = self.bytes.saturating_add(crate::streaming::PAGE);
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count {
        bytes: 0,
        checked: 0,
        workspace,
    };
    if pretty {
        serde_json::to_writer_pretty(&mut count, value)?;
    } else {
        serde_json::to_writer(&mut count, value)?;
    }
    workspace.check()?;
    memory.grow(count.bytes)?;
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(count.bytes).map_err(|_| Limit)?;
    if pretty {
        serde_json::to_writer_pretty(&mut bytes, value)?;
    } else {
        serde_json::to_writer(&mut bytes, value)?;
    }
    workspace.check()?;
    Ok(String::from_utf8(bytes)?)
}

fn text_hits(
    input: &str,
    raw: &str,
    finding: usize,
    workspace: &Workspace<'_>,
    memory: &mut Allocation,
    out: &mut Vec<Hit>,
) -> Result<()> {
    fn insert(
        candidates: &mut BTreeSet<String>,
        value: String,
        memory: &mut Allocation,
    ) -> Result<()> {
        if !value.is_empty() && !candidates.contains(&value) {
            memory.grow(64)?;
            candidates.insert(value);
        }
        Ok(())
    }
    fn collect(
        value: &Value,
        candidates: &mut BTreeSet<String>,
        memory: &mut Allocation,
        workspace: &Workspace<'_>,
    ) -> Result<()> {
        workspace.check()?;
        match value {
            Value::String(s) if !s.is_empty() => {
                memory.grow(s.len())?;
                insert(candidates, s.clone(), memory)?;
            }
            Value::Array(_) | Value::Object(_) => {
                let compact = render(value, false, workspace, memory)?;
                insert(candidates, compact, memory)?;
                let pretty = render(value, true, workspace, memory)?;
                insert(candidates, pretty, memory)?;
                for v in value.as_array().map(Vec::as_slice).unwrap_or(&[]) {
                    collect(v, candidates, memory, workspace)?;
                }
                if let Some(m) = value.as_object() {
                    for v in m.values() {
                        collect(v, candidates, memory, workspace)?;
                    }
                }
            }
            _ => (),
        }
        Ok(())
    }
    if raw.is_empty() {
        return Ok(());
    }
    let mut candidates = BTreeSet::new();
    let mut allocation = workspace.allocation();
    allocation.grow(raw.len())?;
    insert(&mut candidates, raw.into(), &mut allocation)?;
    let mut parsed = workspace.allocation();
    parsed.grow(raw.len().saturating_mul(16).saturating_add(256))?;
    if let Ok(v) = serde_json::from_str::<Value>(raw) {
        collect(&v, &mut candidates, &mut allocation, workspace)?;
    }
    drop(parsed);
    let mut quoted_memory = workspace.allocation();
    quoted_memory.grow(raw.len().saturating_mul(8).saturating_add(256))?;
    if let Ok(v) = serde_json::from_str::<Value>(&format!("\"{raw}\"")) {
        collect(&v, &mut candidates, &mut allocation, workspace)?;
    }
    drop(quoted_memory);
    let mut order_memory = workspace.allocation();
    order_memory.grow(candidates.len() * std::mem::size_of::<String>())?;
    let mut candidates: Vec<_> = candidates.into_iter().collect();
    candidates.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for candidate in candidates {
        workspace.check()?;
        let mut from = 0;
        while from < input.len() {
            workspace.check()?;
            // Search one page of possible starts, retaining overlap for matches
            // crossing the page boundary. No copied buffers or byte maps.
            let mut boundary = from.saturating_add(crate::streaming::PAGE).min(input.len());
            while !input.is_char_boundary(boundary) {
                boundary += 1;
            }
            let mut end = boundary.saturating_add(candidate.len()).min(input.len());
            while !input.is_char_boundary(end) {
                end += 1;
            }
            let Some(relative) = input[from..end].find(&candidate) else {
                from = boundary;
                continue;
            };
            let start = from + relative;
            if start >= boundary {
                from = boundary;
                continue;
            }
            let end = start + candidate.len();
            if !out
                .iter()
                .any(|h| h.finding == finding && h.start <= start && h.end >= end)
            {
                push_hit(
                    out,
                    Hit {
                        start,
                        end,
                        finding,
                        nested: false,
                    },
                    memory,
                )?;
            }
            from = end;
        }
    }
    Ok(())
}

pub fn content_ranges(input: &str, evidence: &Value, id: &str, structured: bool) -> Value {
    let workspace = Workspace::new(&|| false);
    let mut output = workspace.allocation();
    locate(
        input,
        &[Request {
            raw: evidence,
            id,
            structured,
            locator: &Value::Null,
        }],
        &workspace,
        &mut output,
    )
    .map(|located| json!(located.ranges))
    .unwrap_or_else(|_| json!([]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selected(input: &str, range: &Value) -> String {
        let units: Vec<_> = input.encode_utf16().collect();
        String::from_utf16(
            &units[range["start"].as_u64().unwrap() as usize
                ..range["end"].as_u64().unwrap() as usize],
        )
        .unwrap()
    }

    #[test]
    fn large_nested_unused_fields_and_many_findings_share_one_small_index() {
        let input = format!(
            "{{\"cmd\":\"rm -rf /important\",\"extra\":{}\"{}\"{}}}",
            "{\"a\":".repeat(70),
            "x".repeat(4 * 1024 * 1024),
            "}".repeat(70)
        );
        let raw = json!(r#"{"cmd":"rm -rf /important"}"#);
        let requests: Vec<_> = (0..16)
            .map(|_| Request {
                raw: &raw,
                id: "risk",
                structured: true,
                locator: &Value::Null,
            })
            .collect();
        let workspace = Workspace::with_limit(&|| false, 64 * 1024);
        let mut output = workspace.allocation();
        let found = locate(&input, &requests, &workspace, &mut output).unwrap();
        assert_eq!(workspace.state.prepared.get(), 1);
        assert!(found.gaps.is_empty());
        assert_eq!(found.ranges.len(), requests.len());
        for range in found.ranges {
            assert_eq!(selected(&input, &range), "rm -rf /important");
        }
        drop(output);
        assert_eq!(workspace.state.used.get(), 0);
    }

    #[test]
    fn sparse_endpoints_preserve_unicode_escapes_and_mixed_finding_identity() {
        let command = "🙂\\\"\n秘密";
        let arguments = json!({"cmd":command,"tail":"x".repeat(2 * 1024 * 1024)}).to_string();
        let input =
            json!({"type":"function_call","arguments":arguments,"name":"工具🙂"}).to_string();
        let raw = json!(json!({"cmd":command}).to_string());
        let plain = json!("工具🙂");
        let requests = [
            Request {
                raw: &raw,
                id: "tool",
                structured: true,
                locator: &Value::Null,
            },
            Request {
                raw: &plain,
                id: "text",
                structured: false,
                locator: &Value::Null,
            },
            Request {
                raw: &raw,
                id: "second",
                structured: true,
                locator: &Value::Null,
            },
        ];
        let workspace = Workspace::with_limit(&|| false, 8 * 1024 * 1024);
        let mut output = workspace.allocation();
        let found = locate(&input, &requests, &workspace, &mut output).unwrap();
        assert!(found.gaps.is_empty());
        assert_eq!(workspace.state.prepared.get(), 1);
        assert_eq!(found.ranges.len(), 3);
        for (range, id) in found.ranges.iter().zip(["tool", "text", "second"]) {
            assert_eq!(range["findingId"], id);
            let hit = selected(&input, range);
            if id == "text" {
                assert_eq!(hit, "工具🙂");
            } else {
                assert_eq!(
                    serde_json::from_str::<String>(&format!("\"{hit}\"")).unwrap(),
                    serde_json::to_string(command).unwrap().trim_matches('"')
                );
            }
        }
    }

    #[test]
    fn node_budget_releases_failed_work_and_other_findings_still_match() {
        let input = format!(
            "{{\"cmd\":\"rm -rf /important\",\"extra\":[{}]}}",
            "0,".repeat(20_000).trim_end_matches(',')
        );
        let raw = json!(r#"{"cmd":"rm -rf /important"}"#);
        let plain = json!("rm -rf /important");
        let requests = [
            Request {
                raw: &raw,
                id: "tool",
                structured: true,
                locator: &Value::Null,
            },
            Request {
                raw: &plain,
                id: "text",
                structured: false,
                locator: &Value::Null,
            },
        ];
        let workspace = Workspace::with_limit(&|| false, 16 * 1024);
        let mut output = workspace.allocation();
        let found = locate(&input, &requests, &workspace, &mut output).unwrap();
        assert_eq!(found.gaps, BTreeSet::from([0]));
        assert_eq!(found.ranges.len(), 1);
        assert_eq!(found.ranges[0]["findingId"], "text");
        let small = locate(
            r#"{"cmd":"rm -rf /important"}"#,
            &requests[..1],
            &workspace,
            &mut output,
        )
        .unwrap();
        assert!(small.gaps.is_empty());
        assert_eq!(small.ranges.len(), 1);
        drop(output);
        assert_eq!(workspace.state.used.get(), 0);
    }

    #[test]
    fn invalid_or_truncated_json_never_produces_structured_hits() {
        let raw = json!(r#"{"cmd":"danger"}"#);
        for input in [
            r#"{"cmd":"danger""#,
            r#"{"cmd":"danger",}"#,
            r#"{"cmd":"danger","x":01}"#,
            r#"{"cmd":"danger","x":1.}"#,
            r#"{"cmd":"danger","x":1e+}"#,
            r#"{"cmd":"danger","x":"\ud800"}"#,
            r#"{"cmd":"danger","x":"\u+123"}"#,
            "{\"cmd\":\"danger\",\u{b}\"x\":0}",
            r#"{"cmd":"danger"} trailing"#,
        ] {
            assert_eq!(
                content_ranges(input, &raw, "risk", true),
                json!([]),
                "{input}"
            );
        }
    }

    #[test]
    fn source_members_use_the_last_duplicate_and_nested_values_match_exactly() {
        for (input, raw, count) in [
            (r#"{"cmd":"old","cmd":"danger"}"#, r#"{"cmd":"danger"}"#, 1),
            (r#"{"cmd":"danger","cmd":"safe"}"#, r#"{"cmd":"danger"}"#, 0),
            (
                r#"{"input":{"x":[1,true,"🙂"],"y":0},"extra":1}"#,
                r#"{"input":{"x":[1,true,"🙂"],"y":0}}"#,
                1,
            ),
            (
                r#"{"input":{"x":[1,true,"🙂"],"y":0}}"#,
                r#"{"input":{"x":[1,true,"🙂"]}}"#,
                0,
            ),
        ] {
            assert_eq!(
                content_ranges(input, &json!(raw), "risk", true)
                    .as_array()
                    .unwrap()
                    .len(),
                count
            );
        }
    }

    #[test]
    fn cancellation_interrupts_token_scans_comparisons_and_unmatched_text() {
        let input = format!("\"{}\"", "x".repeat(1024 * 1024));
        let calls = Cell::new(0);
        let cancelled = || {
            calls.set(calls.get() + 1);
            calls.get() > 4
        };
        let workspace = Workspace::new(&cancelled);
        assert!(Index::parse(&input, &workspace)
            .err()
            .unwrap()
            .to_string()
            .contains("overview_cancelled"));
        calls.set(0);
        assert!(chars_equal(input.chars(), input.chars(), &workspace)
            .unwrap_err()
            .to_string()
            .contains("overview_cancelled"));
        calls.set(0);
        let mut output = workspace.allocation();
        let raw = json!("not present");
        assert!(locate(
            &input,
            &[Request {
                raw: &raw,
                id: "risk",
                structured: false,
                locator: &Value::Null
            }],
            &workspace,
            &mut output
        )
        .err()
        .unwrap()
        .to_string()
        .contains("overview_cancelled"));
    }

    #[test]
    fn locator_paths_do_not_bypass_full_evidence_validation() {
        let raw = json!(r#"{"cmd":"danger","path":"/workspace"}"#);
        let locator = json!({"version":1,"fields":[{"path":["path"]}]});
        let request = [Request {
            raw: &raw,
            id: "risk",
            structured: true,
            locator: &locator,
        }];
        let workspace = Workspace::new(&|| false);
        let mut output = workspace.allocation();
        assert!(locate(
            r#"{"cmd":"safe","path":"/workspace"}"#,
            &request,
            &workspace,
            &mut output
        )
        .unwrap()
        .ranges
        .is_empty());
        let found = locate(
            r#"{"cmd":"danger","path":"/workspace"}"#,
            &request,
            &workspace,
            &mut output,
        )
        .unwrap();
        assert_eq!(found.ranges.len(), 1);
        assert_eq!(
            selected(r#"{"cmd":"danger","path":"/workspace"}"#, &found.ranges[0]),
            "/workspace"
        );
    }
}
