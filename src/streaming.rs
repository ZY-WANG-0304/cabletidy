use anyhow::{bail, Result};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use serde_json::{json, Value};
use std::{
    io::{self, Read, Seek, SeekFrom, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

pub const PAGE: usize = 32 * 1024;
pub const MEMORY_BUDGET: u64 = 256 * 1024 * 1024;
pub const SPOOL_BUDGET: u64 = 512 * 1024 * 1024;
static MEMORY: AtomicU64 = AtomicU64::new(0);
static DISK: AtomicU64 = AtomicU64::new(0);

pub fn budget(name: &str, default: u64) -> u64 {
    #[cfg(feature = "test-support")]
    if let Ok(value) = std::env::var(name) {
        if let Ok(value) = value.parse() {
            return value;
        }
    }
    let _ = name;
    default
}

pub struct Reservation {
    counter: &'static AtomicU64,
    pub bytes: u64,
    limit: u64,
}
impl Reservation {
    pub fn memory() -> Self {
        Self {
            counter: &MEMORY,
            bytes: 0,
            limit: budget("CABLETIDY_TEST_MEMORY_BYTES", MEMORY_BUDGET),
        }
    }
    fn disk() -> Self {
        Self {
            counter: &DISK,
            bytes: 0,
            limit: budget("CABLETIDY_TEST_SPOOL_BYTES", SPOOL_BUDGET),
        }
    }
    pub fn grow(&mut self, bytes: usize) -> io::Result<()> {
        let bytes = bytes as u64;
        self.counter
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_add(bytes).filter(|n| *n <= self.limit)
            })
            .map_err(|_| io::Error::other("shared_resource_budget"))?;
        self.bytes += bytes;
        Ok(())
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.counter.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
pub fn usage() -> Value {
    json!({"workingMemoryBytes":MEMORY.load(Ordering::Acquire),"workingMemoryBudget":budget("CABLETIDY_TEST_MEMORY_BYTES",MEMORY_BUDGET),"encryptedSpoolBytes":DISK.load(Ordering::Acquire),"encryptedSpoolBudget":budget("CABLETIDY_TEST_SPOOL_BYTES",SPOOL_BUDGET)})
}

// Temporary transport storage is authenticated ciphertext. Keys never leave RAM.
// An anonymous tempfile is unlinked on Unix and deleted on close on Windows.
pub struct Spool {
    file: std::fs::File,
    key: aead::LessSafeKey,
    pending: Vec<u8>,
    blocks: u64,
    pub len: u64,
    reservation: Reservation,
    sealed: bool,
    _memory: Reservation,
}
impl Spool {
    pub fn new() -> io::Result<Self> {
        let mut memory = Reservation::memory();
        memory.grow(8 * PAGE)?;
        let mut key = [0; 32];
        SystemRandom::new()
            .fill(&mut key)
            .map_err(|_| io::Error::other("spool_random"))?;
        let key = aead::UnboundKey::new(&aead::CHACHA20_POLY1305, &key)
            .map_err(|_| io::Error::other("spool_key"))?;
        Ok(Self {
            file: tempfile::tempfile()?,
            key: aead::LessSafeKey::new(key),
            pending: Vec::with_capacity(PAGE),
            blocks: 0,
            len: 0,
            reservation: Reservation::disk(),
            sealed: false,
            _memory: memory,
        })
    }
    fn nonce(block: u64) -> aead::Nonce {
        let mut n = [0; 12];
        n[4..].copy_from_slice(&block.to_be_bytes());
        aead::Nonce::assume_unique_for_key(n)
    }
    fn page(&mut self) -> io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        self.reservation.grow(16)?;
        self.key
            .seal_in_place_append_tag(
                Self::nonce(self.blocks),
                aead::Aad::empty(),
                &mut self.pending,
            )
            .map_err(|_| io::Error::other("spool_encrypt"))?;
        self.file.write_all(&self.pending)?;
        self.pending.clear();
        self.blocks += 1;
        Ok(())
    }
    pub fn seal(mut self) -> io::Result<Arc<Self>> {
        self.page()?;
        self.sealed = true;
        Ok(Arc::new(self))
    }
    pub fn reader(self: &Arc<Self>) -> SpoolReader {
        SpoolReader {
            spool: self.clone(),
            at: 0,
            cached: u64::MAX,
            page: Vec::new(),
        }
    }
}
impl Write for Spool {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.sealed {
            return Err(io::Error::other("spool_sealed"));
        }
        self.reservation.grow(bytes.len())?;
        for part in bytes.chunks(PAGE) {
            let mut part = part;
            while !part.is_empty() {
                let n = (PAGE - self.pending.len()).min(part.len());
                self.pending.extend_from_slice(&part[..n]);
                part = &part[n..];
                if self.pending.len() == PAGE {
                    self.page()?;
                }
            }
        }
        self.len += bytes.len() as u64;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
// Readers use positional I/O, so parallel passes never share a seek cursor.
fn read_at(file: &std::fs::File, bytes: &mut [u8], offset: u64) -> io::Result<usize> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(bytes, offset)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_read(bytes, offset)
    }
}
pub struct SpoolReader {
    spool: Arc<Spool>,
    at: u64,
    cached: u64,
    page: Vec<u8>,
}
impl Read for SpoolReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.at >= self.spool.len || out.is_empty() {
            return Ok(0);
        }
        let block = self.at / PAGE as u64;
        if self.cached != block {
            let size = (self.spool.len - block * PAGE as u64).min(PAGE as u64) as usize + 16;
            self.page.resize(size, 0);
            let mut at = 0;
            while at < size {
                let n = read_at(
                    &self.spool.file,
                    &mut self.page[at..],
                    block * (PAGE + 16) as u64 + at as u64,
                )?;
                if n == 0 {
                    return Err(io::ErrorKind::UnexpectedEof.into());
                }
                at += n;
            }
            let len = self
                .spool
                .key
                .open_in_place(Spool::nonce(block), aead::Aad::empty(), &mut self.page)
                .map_err(|_| io::Error::other("spool_authentication"))?
                .len();
            self.page.truncate(len);
            self.cached = block;
        }
        let offset = (self.at % PAGE as u64) as usize;
        let n = out.len().min(self.page.len() - offset);
        out[..n].copy_from_slice(&self.page[offset..offset + n]);
        self.at += n as u64;
        Ok(n)
    }
}
impl Seek for SpoolReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let at = match pos {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::Current(n) => self.at as i128 + n as i128,
            SeekFrom::End(n) => self.spool.len as i128 + n as i128,
        };
        if at < 0 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        self.at = at as u64;
        Ok(self.at)
    }
}

#[derive(Clone, Debug)]
pub struct Node {
    pub start: u64,
    pub end: u64,
    pub kind: u8,
}
impl Node {
    pub fn read(&self, source: &Arc<Spool>, memory: &mut Reservation) -> Result<Value> {
        let size = (self.end - self.start) as usize;
        // Covers source bytes, decoded strings and the Value tree's allocation overhead.
        memory.grow(
            size.saturating_mul(if self.kind == b'"' { 8 } else { 16 })
                .saturating_add(256),
        )?;
        let mut reader = source.reader();
        reader.seek(SeekFrom::Start(self.start))?;
        Ok(serde_json::from_reader(reader.take(size as u64))?)
    }
}

pub trait Visitor {
    fn start(&mut self, _path: &str, _field: &str, _kind: u8, _at: u64) -> Result<()> {
        Ok(())
    }
    fn text(&mut self, _text: &str) -> Result<()> {
        Ok(())
    }
    fn scalar(&mut self, _value: &str) -> Result<()> {
        Ok(())
    }
    fn end(&mut self, _node: &Node) -> Result<()> {
        Ok(())
    }
    fn punctuation(&mut self, _text: &str) -> Result<()> {
        Ok(())
    }
}

pub struct JsonStream<R: Read> {
    reader: io::BufReader<R>,
    pub at: u64,
    next: Option<u8>,
}
impl<R: Read> JsonStream<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader: io::BufReader::with_capacity(PAGE, reader),
            at: 0,
            next: None,
        }
    }
    fn peek(&mut self) -> Result<Option<u8>> {
        if self.next.is_none() {
            let mut b = [0];
            if self.reader.read(&mut b)? != 0 {
                self.next = Some(b[0]);
            }
        }
        Ok(self.next)
    }
    fn byte(&mut self) -> Result<u8> {
        let b = self
            .peek()?
            .ok_or_else(|| anyhow::anyhow!("invalid_json"))?;
        self.next = None;
        self.at += 1;
        Ok(b)
    }
    fn ws(&mut self) -> Result<()> {
        while self
            .peek()?
            .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
        {
            self.byte()?;
        }
        Ok(())
    }
    fn expect(&mut self, b: u8) -> Result<()> {
        if self.byte()? != b {
            bail!("invalid_json");
        }
        Ok(())
    }
    pub fn parse(&mut self, visitor: &mut impl Visitor, root: &str) -> Result<()> {
        self.value(visitor, root, "", 0)?;
        self.ws()?;
        if self.peek()?.is_some() {
            bail!("invalid_json");
        }
        Ok(())
    }
    pub fn one(&mut self, visitor: &mut impl Visitor, root: &str) -> Result<()> {
        self.value(visitor, root, "", 0)
    }
    fn string(&mut self, mut chunk: impl FnMut(&str) -> Result<()>) -> Result<()> {
        self.expect(b'"')?;
        let mut decoded = Vec::with_capacity(PAGE + 8);
        loop {
            if self.peek()?.is_none() {
                if !decoded.is_empty() {
                    chunk(std::str::from_utf8(&decoded)?)?;
                }
                bail!("invalid_json");
            }
            let b = self.byte()?;
            if b == b'"' {
                if !decoded.is_empty() {
                    chunk(std::str::from_utf8(&decoded)?)?;
                }
                return Ok(());
            }
            if b == b'\\' {
                match self.byte()? {
                    b'"' => decoded.push(b'"'),
                    b'\\' => decoded.push(b'\\'),
                    b'/' => decoded.push(b'/'),
                    b'b' => decoded.push(8),
                    b'f' => decoded.push(12),
                    b'n' => decoded.push(b'\n'),
                    b'r' => decoded.push(b'\r'),
                    b't' => decoded.push(b'\t'),
                    b'u' => {
                        let first = self.hex()?;
                        let cp = if (0xd800..=0xdbff).contains(&first) {
                            self.expect(b'\\')?;
                            self.expect(b'u')?;
                            let second = self.hex()?;
                            if !(0xdc00..=0xdfff).contains(&second) {
                                bail!("invalid_json");
                            }
                            0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)
                        } else {
                            first
                        };
                        let c =
                            char::from_u32(cp).ok_or_else(|| anyhow::anyhow!("invalid_json"))?;
                        let mut bytes = [0; 4];
                        decoded.extend_from_slice(c.encode_utf8(&mut bytes).as_bytes());
                    }
                    _ => bail!("invalid_json"),
                }
            } else if b < 32 {
                bail!("invalid_json");
            } else {
                decoded.push(b);
            }
            if decoded.len() >= PAGE {
                if let Ok(text) = std::str::from_utf8(&decoded) {
                    chunk(text)?;
                    decoded.clear();
                } else if decoded.len() >= PAGE + 4 {
                    bail!("invalid_json");
                }
            }
        }
    }
    fn hex(&mut self) -> Result<u32> {
        let mut n = 0;
        for _ in 0..4 {
            n = n * 16
                + (self.byte()? as char)
                    .to_digit(16)
                    .ok_or_else(|| anyhow::anyhow!("invalid_json"))?;
        }
        Ok(n)
    }
    fn value(&mut self, v: &mut impl Visitor, path: &str, field: &str, depth: usize) -> Result<()> {
        if depth > 512 {
            bail!("parser_stack_budget");
        }
        self.ws()?;
        let start = self.at;
        let kind = self
            .peek()?
            .ok_or_else(|| anyhow::anyhow!("invalid_json"))?;
        v.start(path, field, kind, start)?;
        match kind {
            b'{' | b'[' => {
                self.byte()?;
                v.punctuation(if kind == b'{' { "{" } else { "[" })?;
                self.ws()?;
                let end = if kind == b'{' { b'}' } else { b']' };
                let mut i = 0;
                if self.peek()? != Some(end) {
                    loop {
                        let child = if kind == b'{' {
                            format!("{path}/field/{i}")
                        } else {
                            format!("{path}/{i}")
                        };
                        let mut key = String::new();
                        if kind == b'{' {
                            self.ws()?;
                            let key_start = self.at;
                            v.start(&format!("{child}/key"), "", b'k', key_start)?;
                            self.string(|s| {
                                if key.len() < 256 {
                                    key.extend(s.chars().take(256 - key.len().min(256)));
                                }
                                v.text(s)
                            })?;
                            v.end(&Node {
                                start: key_start,
                                end: self.at,
                                kind: b'k',
                            })?;
                            self.ws()?;
                            self.expect(b':')?;
                            v.punctuation(":")?;
                        }
                        self.value(v, &child, &key, depth + 1)?;
                        i += 1;
                        self.ws()?;
                        if self.peek()? == Some(end) {
                            break;
                        }
                        self.expect(b',')?;
                        v.punctuation(",")?;
                    }
                }
                self.expect(end)?;
                v.punctuation(if kind == b'{' { "}" } else { "]" })?;
            }
            b'"' => self.string(|s| v.text(s))?,
            b't' | b'f' | b'n' => {
                let word = match kind {
                    b't' => "true",
                    b'f' => "false",
                    _ => "null",
                };
                for b in word.bytes() {
                    self.expect(b)?;
                }
                v.scalar(word)?;
            }
            b'-' | b'0'..=b'9' => {
                // Numbers have a finite-state grammar; even huge numeric literals need no buffer.
                let mut number = String::new();
                if self.peek()? == Some(b'-') {
                    number.push(self.byte()? as char);
                }
                match self.byte()? {
                    b'0' => number.push('0'),
                    b @ b'1'..=b'9' => {
                        number.push(b as char);
                        while self.peek()?.is_some_and(|b| b.is_ascii_digit()) {
                            number.push(self.byte()? as char);
                            if number.len() >= PAGE {
                                v.scalar(&number)?;
                                number.clear();
                            }
                        }
                    }
                    _ => bail!("invalid_json"),
                }
                for marker in *b".e" {
                    if self
                        .peek()?
                        .is_some_and(|b| b == marker || marker == b'e' && b == b'E')
                    {
                        number.push(self.byte()? as char);
                        if marker == b'e' && self.peek()?.is_some_and(|b| b == b'+' || b == b'-') {
                            number.push(self.byte()? as char);
                        }
                        if !self.peek()?.is_some_and(|b| b.is_ascii_digit()) {
                            bail!("invalid_json");
                        }
                        while self.peek()?.is_some_and(|b| b.is_ascii_digit()) {
                            number.push(self.byte()? as char);
                            if number.len() >= PAGE {
                                v.scalar(&number)?;
                                number.clear();
                            }
                        }
                    }
                }
                v.scalar(&number)?;
            }
            _ => bail!("invalid_json"),
        }
        v.end(&Node {
            start,
            end: self.at,
            kind,
        })
    }
}

pub struct Index {
    pub nodes: Vec<(String, String, Node)>,
    pub values: Value,
    active: Vec<(String, String, u8, String)>,
    pub memory: Reservation,
}
impl Index {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            values: json!({}),
            active: Vec::new(),
            memory: Reservation::memory(),
        }
    }
}
impl Visitor for Index {
    fn start(&mut self, path: &str, field: &str, kind: u8, _at: u64) -> Result<()> {
        self.active
            .push((path.into(), field.into(), kind, String::new()));
        Ok(())
    }
    fn text(&mut self, s: &str) -> Result<()> {
        let depth = self.active.len();
        let a = self.active.last_mut().unwrap();
        if depth == 2
            && matches!(
                a.1.as_str(),
                "model"
                    | "type"
                    | "name"
                    | "stream"
                    | "output_index"
                    | "index"
                    | "content_index"
                    | "summary_index"
            )
        {
            self.memory.grow(s.len())?;
            a.3.push_str(s);
        }
        Ok(())
    }
    fn scalar(&mut self, s: &str) -> Result<()> {
        self.text(s)
    }
    fn end(&mut self, node: &Node) -> Result<()> {
        let (path, field, kind, value) = self.active.pop().unwrap();
        if self.active.len() == 1 && kind != b'k' {
            self.memory.grow(path.len() + field.len() + 128)?;
            self.nodes.push((path, field.clone(), node.clone()));
            if !value.is_empty() {
                self.values[&field] = if kind == b'"' {
                    json!(value)
                } else {
                    serde_json::from_str(&value).unwrap_or(Value::Null)
                };
            }
        }
        Ok(())
    }
}

pub fn index(source: &Arc<Spool>, node: Option<&Node>) -> Result<Index> {
    let mut reader = source.reader();
    let start = node.map_or(0, |n| n.start);
    reader.seek(SeekFrom::Start(start))?;
    let mut parser = JsonStream::new(reader);
    parser.at = start;
    let mut index = Index::new();
    if node.is_none() {
        parser.parse(&mut index, "node")?;
    } else {
        parser.one(&mut index, "node")?;
    }
    Ok(index)
}

pub fn decoded(source: &Arc<Spool>, node: &Node) -> Result<Arc<Spool>> {
    struct Decode(Spool);
    impl Visitor for Decode {
        fn text(&mut self, s: &str) -> Result<()> {
            self.0.write_all(s.as_bytes())?;
            Ok(())
        }
    }
    if node.kind != b'"' {
        bail!("not_a_string");
    }
    let mut reader = source.reader();
    reader.seek(SeekFrom::Start(node.start))?;
    let mut d = Decode(Spool::new()?);
    JsonStream::new(reader).one(&mut d, "decoded")?;
    Ok(d.0.seal()?)
}

pub struct RequestInfo {
    pub value: Value,
    pub models: Vec<Node>,
    pub root: Node,
    _memory: Reservation,
}
pub fn request_info(source: &Arc<Spool>) -> Result<RequestInfo> {
    struct Info {
        value: Value,
        models: Vec<Node>,
        stack: Vec<(String, u8, String, bool)>,
        root: Option<Node>,
        memory: Reservation,
    }
    impl Visitor for Info {
        fn start(&mut self, _: &str, field: &str, kind: u8, _: u64) -> Result<()> {
            let visible = if self.stack.len() == 1 {
                matches!(field, "input" | "messages")
            } else {
                self.stack
                    .last()
                    .is_some_and(|p| p.3 && (p.1 == b'[' || field == "content" || field == "type"))
            };
            if self.stack.len() == 2 && self.stack[1].0 == "tools" && self.stack[1].1 == b'[' {
                self.value["tools"] = json!([true]);
            }
            if self.stack.len() == 1 && field == "tools" {
                self.value["tools"] = json!([]);
            }
            self.stack
                .push((field.into(), kind, String::new(), visible));
            Ok(())
        }
        fn text(&mut self, s: &str) -> Result<()> {
            let depth = self.stack.len();
            let a = self.stack.last_mut().unwrap();
            if depth == 2
                && matches!(
                    a.0.as_str(),
                    "model"
                        | "stream"
                        | "tool_choice"
                        | "parallel_tool_calls"
                        | "reasoning"
                        | "thinking"
                        | "images"
                        | "image_input"
                )
                || a.3 && a.0 == "type"
                || depth == 3 && a.0 == "type"
            {
                self.memory.grow(s.len() * 2)?;
                a.2.push_str(s);
            }
            Ok(())
        }
        fn scalar(&mut self, s: &str) -> Result<()> {
            self.text(s)
        }
        fn end(&mut self, node: &Node) -> Result<()> {
            let (field, kind, s, visible) = self.stack.pop().unwrap();
            if self.stack.is_empty() {
                self.root = Some(node.clone());
            }
            if visible
                && field == "type"
                && matches!(s.as_str(), "image" | "input_image" | "image_url")
            {
                self.value["images"] = json!(true);
            }
            if self.stack.len() == 2
                && self.stack.last().unwrap().0 == "thinking"
                && field == "type"
                && s == "disabled"
            {
                self.value["thinking"] = json!({"type":"disabled"});
            }
            if self.stack.len() == 1 && kind != b'k' {
                if field == "model" {
                    self.memory.grow(32)?;
                    self.models.push(node.clone());
                }
                if matches!(
                    field.as_str(),
                    "model"
                        | "stream"
                        | "tool_choice"
                        | "parallel_tool_calls"
                        | "reasoning"
                        | "thinking"
                        | "images"
                        | "image_input"
                ) {
                    if field == "thinking" && self.value["thinking"]["type"] == "disabled" {
                        return Ok(());
                    }
                    let v = if kind == b'"' {
                        json!(s)
                    } else if matches!(kind, b'{' | b'[') {
                        json!(true)
                    } else {
                        serde_json::from_str(&s).unwrap_or(Value::Null)
                    };
                    if field != "images" || self.value["images"] != true {
                        self.value[&field] = v;
                    }
                }
            }
            Ok(())
        }
    }
    let mut info = Info {
        value: json!({}),
        models: Vec::new(),
        stack: Vec::new(),
        root: None,
        memory: Reservation::memory(),
    };
    JsonStream::new(source.reader()).parse(&mut info, "request")?;
    Ok(RequestInfo {
        value: info.value,
        models: info.models,
        root: info.root.unwrap(),
        _memory: info.memory,
    })
}

pub struct Edits {
    pub ranges: Vec<(u64, u64, Vec<u8>)>,
    _memory: Reservation,
}
impl Edits {
    pub fn new() -> Self {
        Self {
            ranges: Vec::new(),
            _memory: Reservation::memory(),
        }
    }
    pub fn add(&mut self, start: u64, end: u64, bytes: Vec<u8>) -> Result<()> {
        self._memory.grow(bytes.len() + 64)?;
        self.ranges.push((start, end, bytes));
        Ok(())
    }
    pub fn reader(self, source: &Arc<Spool>) -> EditedReader {
        EditedReader {
            source: source.reader(),
            edits: self,
            at: 0,
            index: 0,
            replacement: 0,
        }
    }
}
pub struct EditedReader {
    source: SpoolReader,
    edits: Edits,
    at: u64,
    index: usize,
    replacement: usize,
}
impl Read for EditedReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        loop {
            let Some((start, end, bytes)) = self.edits.ranges.get(self.index) else {
                return self.source.read(out);
            };
            if self.at < *start {
                let len = out.len().min((*start - self.at) as usize);
                let n = self.source.read(&mut out[..len])?;
                self.at += n as u64;
                return Ok(n);
            }
            if self.replacement < bytes.len() {
                let n = out.len().min(bytes.len() - self.replacement);
                out[..n].copy_from_slice(&bytes[self.replacement..self.replacement + n]);
                self.replacement += n;
                return Ok(n);
            }
            self.source.seek(SeekFrom::Start(*end))?;
            self.at = *end;
            self.index += 1;
            self.replacement = 0;
        }
    }
}

pub fn response_edits(
    source: &Arc<Spool>,
    client: &str,
    mapped: &str,
    claude: bool,
) -> Result<Edits> {
    let top = index(source, None)?;
    let message_start = top.values["type"] == "message_start";
    let message = top.values["type"] == "message";
    struct Models<'a> {
        stack: Vec<(String, bool, String)>,
        client: &'a str,
        mapped: &'a str,
        claude: bool,
        message: bool,
        message_start: bool,
        edits: Edits,
    }
    impl Visitor for Models<'_> {
        fn start(&mut self, _: &str, field: &str, kind: u8, _: u64) -> Result<()> {
            let selected = field == "model"
                && kind == b'"'
                && (!self.claude
                    || self.message && self.stack.len() == 1
                    || self.message_start && self.stack.len() == 2 && self.stack[1].0 == "message");
            self.stack.push((field.into(), selected, String::new()));
            Ok(())
        }
        fn text(&mut self, s: &str) -> Result<()> {
            let a = self.stack.last_mut().unwrap();
            if a.1 {
                if a.2.len() + s.len() > self.mapped.len() {
                    a.1 = false;
                } else {
                    a.2.push_str(s);
                }
            }
            Ok(())
        }
        fn end(&mut self, node: &Node) -> Result<()> {
            let (_, selected, value) = self.stack.pop().unwrap();
            if selected && value == self.mapped {
                self.edits
                    .add(node.start, node.end, serde_json::to_vec(self.client)?)?;
            }
            Ok(())
        }
    }
    let mut m = Models {
        stack: Vec::new(),
        client,
        mapped,
        claude,
        message,
        message_start,
        edits: Edits::new(),
    };
    JsonStream::new(source.reader()).parse(&mut m, "response")?;
    Ok(m.edits)
}

// One encrypted event at a time; both wire and data lines can exceed a page.
pub struct EventFramer {
    spool: Option<Spool>,
    buffer: Vec<u8>,
    tail: [u8; 4],
    tail_len: usize,
}
impl EventFramer {
    pub fn new() -> Self {
        Self {
            spool: None,
            buffer: Vec::with_capacity(PAGE),
            tail: [0; 4],
            tail_len: 0,
        }
    }
    pub fn byte(&mut self, b: u8) -> io::Result<Option<Arc<Spool>>> {
        if self.spool.is_none() {
            self.spool = Some(Spool::new()?);
        }
        self.buffer.push(b);
        self.tail.rotate_left(1);
        self.tail[3] = b;
        self.tail_len = (self.tail_len + 1).min(4);
        let complete = self.tail_len >= 2 && self.tail[2..] == *b"\n\n"
            || self.tail_len >= 3 && self.tail[1..] == *b"\n\r\n";
        if self.buffer.len() == PAGE || complete {
            self.spool.as_mut().unwrap().write_all(&self.buffer)?;
            self.buffer.clear();
        }
        if complete {
            self.tail_len = 0;
            return self.spool.take().unwrap().seal().map(Some);
        }
        Ok(None)
    }
    pub fn finish(&mut self) -> io::Result<Option<Arc<Spool>>> {
        if let Some(mut spool) = self.spool.take() {
            spool.write_all(&self.buffer)?;
            self.buffer.clear();
            Ok(Some(spool.seal()?))
        } else {
            Ok(None)
        }
    }
}

pub struct EventData {
    pub payload: Arc<Spool>,
    pub fields: Arc<Spool>,
}
pub fn event_data(event: &Arc<Spool>) -> Result<EventData> {
    use std::io::BufRead;
    let mut reader = io::BufReader::with_capacity(PAGE, event.reader());
    let mut payload = io::BufWriter::with_capacity(PAGE, Spool::new()?);
    let mut fields = io::BufWriter::with_capacity(PAGE, Spool::new()?);
    let mut prefix = Vec::new();
    let mut data = false;
    let mut line_start = true;
    let mut skip_space = false;
    let mut previous_cr = false;
    let mut has_data = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            break;
        }
        let len = buffer.len();
        for &b in buffer {
            if line_start {
                prefix.push(b);
                if b == b'\n' || prefix.len() == 5 {
                    data = prefix == b"data:";
                    line_start = false;
                    if data {
                        if has_data {
                            payload.write_all(b"\n")?;
                        }
                        has_data = true;
                        skip_space = true;
                    } else {
                        fields.write_all(&prefix)?;
                    }
                    prefix.clear();
                } else {
                    continue;
                }
            } else if b == b'\n' {
                if !data {
                    fields.write_all(b"\n")?;
                }
            } else if data {
                if skip_space && b == b' ' {
                    skip_space = false;
                    continue;
                }
                skip_space = false;
                if previous_cr {
                    payload.write_all(b"\r")?;
                }
                previous_cr = b == b'\r';
                if !previous_cr {
                    payload.write_all(&[b])?;
                }
            } else {
                fields.write_all(&[b])?;
            }
            if b == b'\n' {
                line_start = true;
                previous_cr = false;
            }
        }
        reader.consume(len);
    }
    if !prefix.is_empty() {
        fields.write_all(&prefix)?;
    }
    Ok(EventData {
        payload: payload.into_inner().map_err(|e| e.into_error())?.seal()?,
        fields: fields.into_inner().map_err(|e| e.into_error())?.seal()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spool(bytes: &[u8]) -> Arc<Spool> {
        let mut s = Spool::new().unwrap();
        for part in bytes.chunks(7) {
            s.write_all(part).unwrap();
        }
        s.seal().unwrap()
    }
    #[test]
    fn encrypted_pages_round_trip_seek_and_detect_tampering() {
        let secret = "credential-that-must-never-appear-on-disk";
        let bytes = format!("{}{}{}", "x".repeat(PAGE - 9), secret, "tail".repeat(PAGE));
        let source = spool(bytes.as_bytes());
        let mut raw = vec![0; source.file.metadata().unwrap().len() as usize];
        let mut file = source.file.try_clone().unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        file.read_exact(&mut raw).unwrap();
        assert!(!raw.windows(secret.len()).any(|w| w == secret.as_bytes()));
        let mut reader = source.reader();
        reader.seek(SeekFrom::Start((PAGE - 9) as u64)).unwrap();
        let mut found = vec![0; secret.len()];
        reader.read_exact(&mut found).unwrap();
        assert_eq!(found, secret.as_bytes());
        reader.seek(SeekFrom::Start(0)).unwrap();
        let mut restored = String::new();
        reader.read_to_string(&mut restored).unwrap();
        assert_eq!(restored, bytes);
        file.seek(SeekFrom::Start(0)).unwrap();
        file.write_all(&[raw[0] ^ 1]).unwrap();
        assert!(source.reader().read(&mut [0; 32]).is_err());
    }
    #[test]
    fn tokenizer_accepts_chunked_unicode_and_rejects_invalid_json() {
        let source=spool(format!(r#"{{"input":"{}\uD83D\uDE00","model":"late","tools":[  ],"thinking":{{"type":"disabled"}},"messages":[{{"content":[{{"type":"input_image"}}]}}]}}"#,"hello".repeat(PAGE)).as_bytes());
        let info = request_info(&source).unwrap();
        assert_eq!(info.value["model"], "late");
        assert_eq!(info.value["tools"], json!([]));
        assert_eq!(info.value["images"], true);
        assert_eq!(info.value["thinking"]["type"], "disabled");
        for raw in [
            "[1,]",
            "{\"a\":1,}",
            "{\"x\":01}",
            "{\"x\":1e}",
            "\"\\uD800\"",
            "{} false",
            "{\u{000b}}",
        ] {
            assert!(request_info(&spool(raw.as_bytes())).is_err(), "{raw}");
        }
    }
    #[test]
    fn model_edits_and_large_multiline_events_preserve_extensions() {
        let payload=format!("{{\n\"type\":\"message_start\",\"message\":{{\"model\":\"vendor\"}},\"extension\":{{\"model\":\"vendor\",\"text\":\"{}\"}}}}","x".repeat(300000));
        let wire = format!(
            "id: 4\r\nevent: message_start\r\ndata: {}\r\n\r\n",
            payload.replace('\n', "\r\ndata: ")
        );
        let mut framing = EventFramer::new();
        let mut event = None;
        for b in wire.bytes() {
            if let Some(e) = framing.byte(b).unwrap() {
                assert!(event.is_none());
                event = Some(e);
            }
        }
        let data = event_data(&event.unwrap()).unwrap();
        let edits = response_edits(&data.payload, "client", "vendor", true).unwrap();
        let parsed: Value = serde_json::from_reader(edits.reader(&data.payload)).unwrap();
        assert_eq!(parsed["message"]["model"], "client");
        assert_eq!(parsed["extension"]["model"], "vendor");
        assert_eq!(parsed["extension"]["text"].as_str().unwrap().len(), 300000);
    }
    #[test]
    fn reservations_enforce_shared_budgets_and_release_on_drop() {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let mut a = Reservation {
            counter: &COUNTER,
            bytes: 0,
            limit: 32,
        };
        let mut b = Reservation {
            counter: &COUNTER,
            bytes: 0,
            limit: 32,
        };
        a.grow(20).unwrap();
        assert!(b.grow(13).is_err());
        b.grow(12).unwrap();
        drop(a);
        b.grow(20).unwrap();
        drop(b);
        assert_eq!(COUNTER.load(Ordering::Relaxed), 0);
    }
}
