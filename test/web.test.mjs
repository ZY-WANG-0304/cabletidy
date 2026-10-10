import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";
import { normalizeConfig } from "./helpers/native.mjs";
import { publicCodexCatalog } from "./helpers/native.mjs";
import { validateConfig } from "./helpers/native.mjs";
import { buildTargetArtifacts } from "./helpers/native.mjs";
import { catalogFixture, codexConfigFixture, namedCodexConfigFixture } from "./helpers/codex-fixture.mjs";
import { claudeConfigFixture } from "./helpers/claude-fixture.mjs";
import { CLAUDE_MODEL_CATALOG, CLAUDE_MODEL_ALIASES } from "../web/claude-models.js";
import { configurationId, providerIdForConfiguration, normalizeConfigurationIdentities, configurationBaseUrl } from "../web/config-identity.js";

const source = (await fs.readFile(new URL("../web/app.js", import.meta.url), "utf8"))
  .replace(/^import .* from "\.\/(?:config-identity|claude-models)\.js";\r?\n/gm, "");

function formNode(id, fields = {}, rows = []) {
  const form = {
    fields, feedback: null,
    getAttribute: (attribute) => attribute === "id" ? id : null,
    setAttribute() {}, removeAttribute() {},
    prepend(node) { form.feedback = node; },
    querySelector: (selector) => selector === "[data-form-feedback]" ? form.feedback : null,
    querySelectorAll: () => rows,
  };
  return form;
}

function creationForm() {
  return formNode("suite-create-form", {
    suiteName: "Development", target: "codex",
    upstreamBaseUrl: "https://example.invalid/v1", upstreamSecret: "test-key",
  }, [{
    querySelector: (selector) => ({ value: selector.includes("clientModelId") ? "gpt-5.5" : "vendor-gpt" }),
  }]);
}

async function controller(config = normalizeConfig(codexConfigFixture()), options = {}) {
  const messages = [];
  const requests = [];
  const confirmations = [];
  const nodes = new Map();
  let controls = [];
  let persisted = clone(config);
  const location = new URL(options.url || "http://test/");
  const historyEntries = [{ url: location.href, state: null }];
  let historyIndex = 0;
  let navigation = Promise.resolve();
  const browserHistory = {
    get state() { return historyEntries[historyIndex].state; },
    replaceState(state, unused, url) {
      if (url !== undefined) location.href = new URL(url, location).href;
      historyEntries[historyIndex] = { url: location.href, state: clone(state) };
    },
    pushState(state, unused, url) {
      location.href = new URL(url, location).href;
      historyEntries.splice(++historyIndex, Infinity, { url: location.href, state: clone(state) });
    },
    go(delta) {
      if (!historyEntries[historyIndex + delta]) return;
      historyIndex += delta;
      location.href = historyEntries[historyIndex].url;
      navigation = Promise.all((context.window.listeners.get("popstate") || []).map(handler => handler({ state: this.state })));
    },
    back() { this.go(-1); },
    forward() { this.go(1); },
  };
  const node = () => ({
    textContent: "", innerHTML: "", hidden: false, disabled: false, dataset: {},
    listeners: new Map(),
    addEventListener(name, handler) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(handler);
    },
    querySelectorAll: () => [], querySelector: () => null,
    setAttribute() {}, removeAttribute() {}, remove() {}, focus() {}, scrollIntoView() {},
    parentElement: { classList: { add() {}, remove() {} } },
    append(item) { messages.push(item.textContent); },
  });
  const context = vm.createContext({
    TextEncoder, TextDecoder,
    configurationId, providerIdForConfiguration, normalizeConfigurationIdentities, configurationBaseUrl, CLAUDE_MODEL_CATALOG, CLAUDE_MODEL_ALIASES,
    window: {
      ...node(),
      location, history: browserHistory, scrollX: 0, scrollY: 0,
      scrollTo({ left = 0, top = 0 }) { this.scrollX = left; this.scrollY = top; },
      confirm(message) { confirmations.push(message); return options.confirmLeave ?? true; },
    },
    document: {
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, node());
        return nodes.get(selector);
      },
      querySelectorAll: () => controls,
      createElement: node,
    },
    fetch: async (url, request = {}) => {
      const body = request.body ? JSON.parse(request.body) : null;
      requests.push({ url, body });
      if (url.startsWith("/api/v1/security/")) {
        const result = await options.onSecurity?.(url) || { body: url.endsWith("/status")
          ? { mode: "record_only", storage: { state: "ready", retentionDays: 30 } }
          : { items: [], total: 0, riskRecordCount: 0, findingCount: 0, counts: {}, nextCursor: null, providers: [] } };
        return { ok: (result.status || 200) < 400, status: result.status || 200, json: async () => result.body };
      }
      if (url === "/api/v1/config/commit") {
        if (body.baseRevision !== persisted.revision) return {
          ok: false, status: 409, json: async () => ({ error: { message: "配置已在其他窗口变更" } }),
        };
        const override = await options.onCommit?.(body);
        if (override) return { ok: false, status: override.status, json: async () => override.body };
        persisted = normalizeConfig(body.config);
        persisted.revision += 1;
        return { ok: true, json: async () => ({
          config: clone(persisted), revision: persisted.revision,
          runtime: { virtualProviders: [], health: {} },
        }) };
      }
      const responses = {
        "/api/v1/config": { config: clone(persisted) },
        "/api/v1/runtime": { virtualProviders: [], health: {} },
        "/api/v1/events": { events: [] },
        "/api/v1/tests/upstream": { ok: true, message: "上游可连接", latencyMs: 1, secretConfigured: true },
        "/api/v1/codex/models": publicCodexCatalog(options.catalog || catalogFixture()),
        "/api/v1/codex/models?refresh=1": options.refreshCatalog || publicCodexCatalog(options.catalog || catalogFixture()),
        "/api/v1/targets/apply": { target: persisted.bindings[body?.bindingId]?.target },
        "/api/v1/targets/restore": { target: "claude-code", report: { mode: "restored" } },
        "/api/v1/config/preview-target-artifacts": { artifacts: { target: persisted.bindings[body?.bindingId]?.target } },
      };
      assert.ok(url in responses, "Unexpected endpoint: " + url);
      return { ok: true, json: async () => responses[url] };
    },
    FormData: class {
      constructor(form) { return new Map(Object.entries(form.fields)); }
    },
    URL, URLSearchParams,
    CSS: { escape: (value) => value },
    structuredClone,
    setTimeout() {},
  });
  vm.runInContext(source, context);
  await setImmediate();
  return {
    messages, requests, confirmations,
    async back() { browserHistory.back(); await navigation; },
    async forward() { browserHistory.forward(); await navigation; },
    controls: (items) => { controls = items; },
    node: (selector) => nodes.get(selector),
    persisted: () => clone(persisted),
    externalUpdate(update) { update(persisted); persisted.revision += 1; },
    read: (expression) => vm.runInContext(expression, context),
    track(form) {
      context.trackedForm = form;
      vm.runInContext("formBaselines.set(trackedForm, formSnapshot(trackedForm))", context);
    },
    edited(form) {
      context.trackedForm = form;
      return vm.runInContext("isFormEdited(trackedForm)", context);
    },
    beforeUnload(event) {
      for (const handler of context.window.listeners.get("beforeunload") || []) handler(event);
    },
    change(target) {
      for (const handler of nodes.get("#page-content").listeners.get("change") || []) handler({ target });
    },
    action(action, element) {
      context.actionElement = element;
      return vm.runInContext(`handleAction(${JSON.stringify(action)}, actionElement)`, context);
    },
    async submit(form) {
      context.submittedForm = form;
      await vm.runInContext("handleFormSubmit({ preventDefault() {} }, submittedForm)", context);
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

test("security page filters, paginates and renders evidence as text without control actions", async () => {
  const finding = { id: "finding-one", requestId: "request-one", severity: "high", category: "sensitive_data", ruleId: "SEC-SECRET-001", ruleVersion: "1", evidenceStage: "tool_call_proposed", confidence: "low", inspectionStatus: "partial", outcome: "completed", at: "2026-09-26T10:00:00Z", evidence: { location: '<script>alert("x")</script>' } };
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/audit/request-one")) return { body: { record: { id: "request-one", kind: "request", inspectionStatus: "partial", coverageReasons: ["unsupported_tool"], findings: [finding] } } };
    if (url.includes("/sessions?")) return { body: { items: [{ id: "request-one", severity: "high", kind: "request", action: "model.request", findingCount: 6 }], total: 60, riskRecordCount: 10, findingCount: 60, counts: { high: 60 }, providers: ["retired_provider"], nextCursor: url.includes("cursor=") ? null : "12", storage: { state: "degraded", droppedWrites: 3 } } };
  } });
  app.read('navigatePage("security")');
  await setImmediate();
  assert.equal(app.read("state.page"), "security");
  let html = app.read("renderSecurity()");
  assert.match(html, /仅记录|本轮调用提议/);
  assert.match(html, /低置信度/);
  assert.match(html, /审计有记录缺口/);
  assert.match(html, /retired_provider/);
  assert.doesNotMatch(html, /data-action="(?:block|approve|notify)/);
  const form = formNode("security-filter-form", { hours: "168", severity: "high", stage: "tool_call_proposed" });
  await app.submit(form);
  assert.ok(app.requests.some(r => r.url === "/api/v1/security/sessions?hours=168&severity=high&stage=tool_call_proposed"));
  await app.action("security-next", { dataset: {} });
  assert.equal(app.read("state.security.cursor"), "12");
  await app.action("security-prev", { dataset: {} });
  assert.equal(app.read("state.security.cursor"), "");
  await app.action("security-detail", { dataset: { id: "request-one" } });
  assert.equal(app.read("state.page"), "security-detail");
  html = app.read("renderSecurityDetailPage()");
  assert.doesNotMatch(html, /security-filter-form|security-table|security-summary/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /工具真实执行状态：未知/);
  assert.match(html, /工具语义暂不支持/);
  await app.action("security-back", {});
  assert.equal(app.read("state.security.filters.hours"), "168");
  await app.action("security-reset", { dataset: {} });
  html = app.read("renderSecurity()");
  assert.match(html, /审计记录/);
  assert.match(html, /name="confidence"/);
  assert.doesNotMatch(html, /security-view|data-view="findings"/);
  assert.equal(app.read("state.security.filters.hours"), "24");
});

test("security reads distinguish empty results from failures and refresh visible details", async () => {
  let fail = false;
  let outcome = "streaming";
  const app = await controller(undefined, { onSecurity(url) {
    if (fail) return { status: 503, body: { error: { message: "审计存储暂不可用" } } };
    if (url.includes("/audit/request-one")) return { body: { record: { id: "request-one", outcome, findings: [] } } };
  } });
  app.read('state.page = "security"');
  await app.read("loadSecurity()");
  assert.match(app.read("renderSecurity()"), /当前筛选范围内没有审计记录/);
  await app.action("security-detail", { dataset: { id: "request-one" } });
  outcome = "completed";
  await app.action("refresh", {});
  assert.equal(app.read("state.security.detail.outcome"), "completed");
  fail = true;
  await app.action("refresh", {});
  assert.match(app.read("renderSecurityDetailPage()"), /审计存储暂不可用|返回审计记录/);
  await app.action("security-back", {});
  await app.action("refresh", {});
  const html = app.read("renderSecurity()");
  assert.match(html, /暂时无法读取记录/);
  assert.match(html, /最近成功读取/);
  assert.doesNotMatch(html, /当前筛选范围内没有审计记录|审计存储正常/);
  assert.equal(app.read("state.security.result"), null);
});

test("failed audit stages remain visibly active until the inspection task finishes", async () => {
  let active = true;
  const app = await controller(undefined, { onSecurity(url) {
    const record = { id: "one", kind: "request", outcome: "completed", severity: "critical", inspectionStatus: "failed", findings: [],
      inspectionProgress: { state: "failed", active, phase: active ? "detecting" : "finished", processedBytes: 128, observedBytes: 4096 } };
    if (url.includes("/audit/one")) return { body: { record } };
    if (url.includes("/sessions?")) return { body: { items: [{ ...record, requestCount: 1, incompleteCount: 1 }], total: 1 } };
  } });
  app.read('state.page = "security"');
  await app.read("loadSecurity()");
  assert.match(app.read("renderSecurity()"), /1 条待检查 \/ 不完整/);
  await app.action("security-detail", { dataset: { id: "one" } });
  assert.match(app.read("renderSecurityDetailPage()"), /检测进度：128 \/ 4096 字节 · 部分步骤失败，仍在检测/);
  active = false;
  await app.action("refresh", {});
  assert.match(app.read("renderSecurityDetailPage()"), /检测失败/);
  assert.doesNotMatch(app.read("renderSecurityDetailPage()"), /仍在检测/);
  await app.action("security-back", {});
  await app.action("refresh", {});
  assert.match(app.read("renderSecurity()"), /1 条待检查 \/ 不完整/);
  assert.doesNotMatch(app.read("renderSecurity()"), /仍在检测/);
});

test("late security responses cannot replace a newer filter result", async () => {
  let release;
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("hours=1&")) return new Promise(resolve => { release = resolve; });
    if (url.includes("/sessions?")) return { body: { items: [], total: 2 } };
  } });
  app.read('state.page = "security"; state.security.filters = { hours: "1", severity: "high" }');
  const first = app.read("loadSecurity()");
  app.read('state.security.filters = { hours: "24" }');
  await app.read("loadSecurity()");
  release({ body: { items: [], total: 99 } });
  await first;
  assert.equal(app.read("state.security.result.total"), 2);
});

test("audit detail navigation restores filters, pagination and scroll through back and forward", async () => {
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/audit/request-one")) return { body: { record: { id: "request-one", findings: [] } } };
    if (url.includes("/sessions?")) return { body: { items: [{ id: "request-one" }], total: 60, nextCursor: url.includes("cursor=") ? null : "page-two" } };
  } });
  app.read('navigatePage("security")'); await setImmediate();
  await app.submit(formNode("security-filter-form", { hours: "168", hasRisk: "true", category: "sensitive_data" }));
  await app.action("security-next", { dataset: {} });
  app.read('window.scrollTo({ top: 1380, left: 0 })');
  const listReads = app.requests.filter(r => r.url.includes("/sessions?")).length;
  const checkList = () => {
    assert.equal(app.read("state.page"), "security");
    assert.equal(app.read("state.security.filters.category"), "sensitive_data");
    assert.equal(app.read("state.security.filters.hasRisk"), "true");
    assert.equal(app.read("state.security.cursor"), "page-two");
    assert.equal(app.read("state.security.history.length"), 1);
    assert.equal(app.read("window.scrollY"), 1380);
    assert.equal(app.requests.filter(r => r.url.includes("/sessions?")).length, listReads, "return uses the retained list page");
    assert.doesNotMatch(app.node("#page-content").innerHTML, /aria-label="审计详情"/);
  };
  await app.action("security-detail", { dataset: { id: "request-one" } });
  assert.equal(app.read("window.location.hash"), "#security/audit/request-one");
  assert.equal(app.read("window.scrollY"), 0);
  assert.doesNotMatch(app.node("#page-content").innerHTML, /security-filter-form|security-table/);
  await app.action("security-back", {}); checkList();
  await app.forward();
  assert.equal(app.read("state.page"), "security-detail");
  assert.equal(app.read("state.security.detail.id"), "request-one");
  await app.back(); checkList();
});

test("a direct audit detail URL loads independently and failed reads retain list navigation", async () => {
  const app = await controller(undefined, { url: "http://test/#security/audit/missing", onSecurity(url) {
    if (url.includes("/audit/missing")) return { status: 404, body: { error: { message: "记录已清理" } } };
  } });
  await setImmediate();
  assert.equal(app.read("state.page"), "security-detail");
  assert.match(app.node("#page-content").innerHTML, /记录已清理/);
  assert.match(app.node("#page-content").innerHTML, /返回审计记录/);
  assert.doesNotMatch(app.node("#page-content").innerHTML, /security-table|security-filter-form/);
  await app.action("security-back", {});
  assert.equal(app.read("state.page"), "security");
  assert.equal(app.read("window.location.hash"), "#security");
});

test("old credential windows locate the annotated hit across pages without highlighting context", async () => {
  const preceding = "x".repeat(90000) + "[REDACTED]" + "x".repeat(41062);
  const prefix = "普通上下文 ".repeat(4000);
  const start = 131072 + Buffer.byteLength(prefix);
  const content = prefix + "[REDACTED] retained context";
  const ref = { snapshotId: "request", start: 80000, end: start + 100 };
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/body?")) {
      const offset = Number(new URL(url, "http://test").searchParams.get("offset"));
      return { body: offset < 131072
        ? { chunks: [{ start: 0, end: 131072, content: preceding, redactions: [{ start: 90000, end: 90010, reason: "unsupported_stream_fragment" }] }], offset: 0, nextOffset: 131072 }
        : { chunks: [{ start: 131072, end: 131072 + Buffer.byteLength(content), content, redactions: [{ start, end: start + 10, reason: "known_credential" }] }], offset: 131072, nextOffset: null } };
    }
    if (url.includes("/audit/one")) return { body: { record: { id: "one", bodySnapshots: [{ id: "request" }], findings: [{ id: "secret", ruleId: "SEC-SECRET-001", evidence: { bodyRef: ref } }] } } };
  } });
  app.read('state.page = "security"');
  await app.action("security-detail", { dataset: { id: "one" } });
  await app.action("security-finding", { dataset: { id: "secret" } });
  assert.equal(app.requests.filter(r => r.url.includes("/body?")).length, 3);
  assert.equal(app.read("state.security.bodySelection.start"), start);
  assert.equal(app.read("state.security.bodySelection.end"), start + 10);
  assert.equal(app.read("state.security.detail.findings[0].evidence.bodyRef.start"), 80000, "historical evidence is immutable");
  assert.match(app.node("#page-content").innerHTML, /<mark[^>]+>\[REDACTED\]<\/mark> retained context/);
  assert.doesNotMatch(app.node("#page-content").innerHTML, /<mark[^>]+>普通上下文/);
});

test("original sensitive content is highlighted automatically across UTF-8 chunks and remains escaped", async () => {
  const credential = '秘密<&"key';
  const prefix = "普通上下文 ";
  const content = prefix + credential + " tail";
  const start = Buffer.byteLength(prefix);
  const end = start + Buffer.byteLength(credential);
  const split = start + Buffer.byteLength("秘密");
  const bytes = Buffer.from(content);
  const range = { start, end, reason: "known_credential" };
  const chunks = [
    { start: 0, end: split, content: bytes.subarray(0, split).toString(), sensitiveRanges: [range] },
    { start: split, end: bytes.length, content: bytes.subarray(split).toString(), sensitiveRanges: [range] },
  ];
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/body?")) return { body: { chunks, nextOffset: null } };
    if (url.includes("/audit/original")) return { body: { record: { id: "original", schemaVersion: 4,
      bodySnapshots: [{ id: "request", contentMode: "original" }],
      findings: [{ id: "secret", ruleId: "SEC-SECRET-001", evidence: { bodyRef: { snapshotId: "request", start, end, matchKind: "sensitive" } } }],
    } } };
  } });
  assert.equal(app.read('PAGE_META.security'), "审计记录");
  await app.action("security-detail", { dataset: { id: "original" } });
  let html = app.read("securityPageText(state.security.bodyPage, state.security.bodySelection)");
  assert.match(html, /security-sensitive-hit/);
  assert.doesNotMatch(html, /security-body-hit/);
  assert.equal(html.replace(/<mark[^>]*>|<\/mark>/g, ""), app.read(`esc(${JSON.stringify(content)})`));
  assert.match(app.node("#page-content").innerHTML, /敏感内容保留原文并高亮显示/);
  assert.match(app.node("#page-content").innerHTML, /本页敏感位置 · 1/);
  await app.action("security-finding", { dataset: { id: "secret" } });
  html = app.read("securityPageText(state.security.bodyPage, state.security.bodySelection)");
  assert.equal([...html.matchAll(/<mark[^>]*security-body-hit[^>]*>(.*?)<\/mark>/g)].map(match => match[1]).join(""), app.read(`esc(${JSON.stringify(credential)})`));
  assert.equal(app.read("state.security.bodySelection.hitUnavailable"), false);
  assert.doesNotMatch(html, /�|\[REDACTED\]/);
});

test("missing credential annotations show a location gap instead of highlighting a whole window", async () => {
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/body?")) return { body: { chunks: [{ start: 0, end: 100, content: "retained context", redactions: [] }], nextOffset: null, gap: true } };
    if (url.includes("/audit/one")) return { body: { record: { id: "one", bodySnapshots: [{ id: "request" }], findings: [{ id: "secret", ruleId: "SEC-SECRET-001", evidence: { bodyRef: { snapshotId: "request", start: 0, end: 100 } } }] } } };
  } });
  app.read('state.page = "security"');
  await app.action("security-detail", { dataset: { id: "one" } });
  await app.action("security-finding", { dataset: { id: "secret" } });
  assert.match(app.node("#page-content").innerHTML, /未保留可定位的凭据命中点/);
  assert.doesNotMatch(app.node("#page-content").innerHTML, /<mark/);
});

test("security review lazily loads pages, locates UTF-8 evidence and preserves context", async () => {
  const body = '普通上下文 <script>context</script> [REDACTED] tail';
  const start = Buffer.byteLength('普通上下文 <script>context</script> ');
  const snapshots = [{ id: "request", source: "client_request", state: "complete", byteLength: Buffer.byteLength(body) }, { id: "evidence/one", source: "stream_inspection", state: "complete", byteLength: 28 }];
  const findings = [{ id: "one", severity: "high", ruleId: "SEC-SECRET-001", evidence: { bodyRef: { snapshotId: "request", start, end: start + 10 } } }, { id: "two", severity: "critical", ruleId: "SEC-DELETE-001", evidence: { bodyRef: { snapshotId: "evidence/one", start: 0, end: 8, sourceSnapshotId: "request", sourceStart: 0 } } }];
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/audit/request-one/body?")) {
      const params = new URL(url, "http://test").searchParams;
      const request = params.get("snapshot") === "request";
      const content = request ? body : 'rm -rf /; echo "context"';
      return { body: { chunks: [{ start: 0, end: Buffer.byteLength(content), content, redactions: request ? [{ start, end: start + 10, reason: "known_credential" }] : [] }], offset: 0, nextOffset: request ? 100 : null, previousOffset: null } };
    }
    if (url.includes("/audit/request-one")) return { body: { record: { id: "request-one", schemaVersion: 3, kind: "request", bodySnapshots: snapshots, findings, inspectionProgress: { state: "running", processedBytes: 12, observedBytes: 40 } } } };
  } });
  app.read('state.page = "security"');
  await app.action("security-detail", { dataset: { id: "request-one" } });
  assert.equal(app.requests.filter(r => r.url.includes("/body?")).length, 1, "one selected body page only");
  await app.action("security-finding", { dataset: { id: "one" } });
  let html = app.read("renderSecurityDetailPage()");
  assert.match(html, /<mark[^>]+>\[REDACTED\]<\/mark>/);
  assert.match(html, /普通上下文 &lt;script&gt;context&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /脱敏位置 · 1/);
  assert.match(html, /检测进度：12 \/ 40 字节/);
  await app.action("security-body-page", { dataset: { offset: "100" } });
  assert.ok(app.requests.at(-1).url.includes("offset=100"));
  await app.action("security-finding", { dataset: { id: "two" } });
  html = app.read("renderSecurityDetailPage()");
  assert.match(html, /data-security-snapshot="request" open/);
  assert.doesNotMatch(html, /data-security-snapshot="evidence\/one"/);
  assert.match(html, /证据来自检测时的流式内容快照，当前已定位到对应的请求正文/);
  await app.action("refresh", {});
  assert.equal(app.read("state.security.bodySelection.snapshotId"), "request");
  await app.action("security-source", { dataset: { id: "request", offset: "0" } });
  await app.action("security-location", { dataset: { start: String(start), end: String(start + 10) } });
  assert.match(app.read("renderSecurityDetailPage()"), /<mark[^>]+>\[REDACTED\]<\/mark>/);
});

test("stream findings map to the response body and expose a separate event timeline", async () => {
  const snapshots = [
    { id: "request", source: "client_request", state: "complete", byteLength: 12 },
    { id: "response", source: "upstream_response", state: "complete", byteLength: 24 },
    { id: "stream/one", source: "stream_inspection", state: "interrupted", byteLength: 24 },
    { id: "stream/two", source: "stream_inspection", state: "complete", byteLength: 23 },
  ];
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/audit/stream-one/body?")) {
      const snapshot = new URL(url, "http://test").searchParams.get("snapshot");
      return { body: { chunks: [{ start: 0, end: 24, content: snapshot === "stream/one" ? '{"text":"partial event"}' : snapshot === "stream/two" ? '{"text":"next event"}' : "response context", redactions: [] }], nextOffset: null, gap: snapshot === "stream/one" } };
    }
    if (url.includes("/audit/stream-one")) return { body: { record: { id: "stream-one", bodySnapshots: snapshots, findings: [{ id: "stream-risk", ruleId: "SEC-SECRET-001", evidence: { bodyRef: { snapshotId: "stream/one", start: 0, end: 10, sourceSnapshotId: "stream/one", sourceStart: 4, sourceEnd: 14 } } }, { id: "stream-unmapped", ruleId: "SEC-SECRET-001", evidence: { bodyRef: { snapshotId: "stream/one", start: 0, end: 10, sourceSnapshotId: "stream/one" } } }] } } };
  } });
  app.read('state.page = "security"');
  await app.action("security-detail", { dataset: { id: "stream-one" } });
  await app.action("security-finding", { dataset: { id: "stream-risk" } });
  const html = app.read("renderSecurityDetailPage()");
  assert.equal(app.read("state.security.bodySelection.snapshotId"), "response");
  assert.match(html, /data-security-snapshot="response" open/);
  assert.doesNotMatch(html, /data-security-snapshot="stream\/one"/);
  assert.match(html, /流式事件时间线/);
  assert.match(html, /artial event/);
  assert.match(html, /接收中断或未观察到协议结束/);
  assert.ok(app.requests.some(r => r.url.includes("snapshot=stream%2Fone")));
  await app.action("security-event", { dataset: { id: "stream/two" } });
  const nextEventHtml = app.read("renderSecurityDetailPage()");
  assert.match(nextEventHtml, /ext event/);
  assert.doesNotMatch(nextEventHtml, /<mark class="security-body-hit">/);
  await app.action("security-finding", { dataset: { id: "stream-unmapped" } });
  assert.equal(app.read("state.security.bodySelection.hitUnavailable"), true);
  const unmappedHtml = app.read("renderSecurityDetailPage()");
  const responsePanel = unmappedHtml.match(/data-security-snapshot="response"[\s\S]*?<\/details><section class="security-event-timeline"/)?.[0] || "";
  assert.doesNotMatch(responsePanel, /security-body-hit/);
});

for (const streamed of [false, true]) test(`original ${streamed ? "stream" : "response"} evidence opens the actual credential at its source offsets`, async () => {
  const credential = "original-response-credential";
  const start = 1200000;
  const end = start + Buffer.byteLength(credential);
  const source = streamed ? "stream/one" : "response";
  const evidence = "evidence/one";
  const snapshots = [
    { id: "request", contentMode: "original" },
    { id: "response", contentMode: "original" },
    ...(streamed ? [{ id: source, contentMode: "original" }] : []),
    { id: evidence, sourceSnapshotId: source, rangeStart: start - 10, rangeEnd: end, contentMode: "original" },
  ];
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/body?")) {
      const id = new URL(url, "http://test").searchParams.get("snapshot");
      if (streamed && id === "response") return { body: { chunks: [{ start: 0, end: 34, content: '{"contentSnapshotId":"stream/one"}' }] } };
      return { body: { chunks: [{ start, end, content: credential, sensitiveRanges: [{ start, end, reason: "known_credential" }] }], nextOffset: end } };
    }
    if (url.includes("/audit/original-response")) return { body: { record: { id: "original-response", bodySnapshots: snapshots,
      findings: [{ id: "secret", ruleId: "SEC-SECRET-001", evidence: { bodyRef: { snapshotId: evidence, sourceSnapshotId: source, start, end, matchKind: "sensitive" } } }],
    } } };
  } });
  await app.action("security-detail", { dataset: { id: "original-response" } });
  await app.action("security-finding", { dataset: { id: "secret" } });
  let html = app.read("renderSecurityDetailPage()");
  assert.match(html, /<mark[^>]*security-body-hit[^>]*>original-response-credential<\/mark>/);
  assert.ok(app.requests.some(r => r.url.includes(`offset=${start - 512}`)));
  assert.doesNotMatch(html, /未保留可定位的凭据命中点/);
  if (streamed) {
    assert.match(html, /class="security-event" open/);
    assert.match(html, /aria-label="检测快照"/);
    assert.match(html, /data-action="security-body" data-id="stream\/one"/);
    await app.action("security-event-page", { dataset: { offset: String(end) } });
    assert.ok(app.requests.at(-1).url.includes(`offset=${end}`));
    await app.action("security-body", { dataset: { id: source } });
    assert.equal(app.read("state.security.streamPageSnapshotId"), source);
    html = app.read("renderSecurityDetailPage()");
    assert.match(html, /<mark[^>]*security-sensitive-hit[^>]*>original-response-credential<\/mark>/);
  } else {
    assert.equal(app.read("state.security.bodySelection.start"), start);
  }
});

test("late stream evidence cannot replace the currently selected event", async () => {
  let releaseOne;
  let releaseTwo;
  const snapshots = [
    { id: "request", source: "client_request", state: "complete" },
    { id: "response", source: "upstream_response", state: "complete" },
    { id: "stream/one", source: "stream_inspection", state: "complete" },
    { id: "stream/two", source: "stream_inspection", state: "complete" },
  ];
  const app = await controller(undefined, { onSecurity(url) {
    const snapshot = url.includes("/body?") ? new URL(url, "http://test").searchParams.get("snapshot") : null;
    if (snapshot === "stream/one") return new Promise(resolve => { releaseOne = resolve; });
    if (snapshot === "stream/two") return new Promise(resolve => { releaseTwo = resolve; });
    if (url.includes("/body?")) return { body: { chunks: [{ start: 0, end: 8, content: "response", redactions: [] }], nextOffset: null } };
    if (url.includes("/audit/late-stream")) return { body: { record: { id: "late-stream", bodySnapshots: snapshots, findings: [{ id: "risk", ruleId: "SEC-SECRET-001", evidence: { bodyRef: { snapshotId: "stream/one", sourceSnapshotId: "stream/one", start: 0, end: 4, sourceStart: 0, sourceEnd: 4 } } }] } } };
  } });
  app.read('state.page = "security"');
  await app.action("security-detail", { dataset: { id: "late-stream" } });
  const first = app.action("security-finding", { dataset: { id: "risk" } });
  for (let i = 0; i < 20 && !releaseOne; i++) await setImmediate();
  const second = app.action("security-event", { dataset: { id: "stream/two" } });
  for (let i = 0; i < 20 && !releaseTwo; i++) await setImmediate();
  releaseTwo({ body: { chunks: [{ start: 0, end: 9, content: "event two", redactions: [] }] } });
  await second;
  await setImmediate();
  assert.match(app.read("renderSecurityDetailPage()"), /t two/);
  releaseOne({ body: { chunks: [{ start: 0, end: 9, content: "event one", redactions: [] }] } });
  await first;
  assert.match(app.read("renderSecurityDetailPage()"), /t two/);
  assert.doesNotMatch(app.read("renderSecurityDetailPage()"), /t one/);
});

for (const firstCompleted of ["body", "stream"]) test(`body and stream loads complete independently when ${firstCompleted} finishes first`, async () => {
  let releaseBody, releaseStream;
  const app = await controller(undefined, { onSecurity(url) {
    const snapshot = url.includes("/body?") ? new URL(url, "http://test").searchParams.get("snapshot") : null;
    if (snapshot === "request/headers") return new Promise(resolve => { releaseBody = resolve; });
    if (snapshot === "stream/one") return new Promise(resolve => { releaseStream = resolve; });
    if (snapshot) return { body: { chunks: [{ start: 0, end: 7, content: "request" }] } };
    if (url.includes("/audit/interleaved")) return { body: { record: { id: "interleaved", bodySnapshots: [
      { id: "request" }, { id: "request/headers" }, { id: "stream/one" },
    ] } } };
  } });
  await app.action("security-detail", { dataset: { id: "interleaved" } });
  const body = app.action("security-body", { dataset: { id: "request/headers" } });
  const stream = app.action("security-event", { dataset: { id: "stream/one" } });
  const completeBody = async () => {
    releaseBody({ body: { chunks: [{ start: 0, end: 7, content: "headers" }] } });
    await body;
    assert.equal(app.read("state.security.bodyLoading"), false);
    assert.equal(app.read("state.security.bodyPage.chunks[0].content"), "headers");
  };
  const completeStream = async () => {
    releaseStream({ body: { chunks: [{ start: 0, end: 5, content: "event" }] } });
    await stream;
    assert.equal(app.read("state.security.streamLoading"), false);
    assert.equal(app.read("state.security.streamPage.chunks[0].content"), "event");
  };
  if (firstCompleted === "body") { await completeBody(); await completeStream(); }
  else { await completeStream(); await completeBody(); }
  assert.equal(app.read("state.security.bodySelection.snapshotId"), "request/headers");
  assert.equal(app.read("state.security.bodySelection.detectionSnapshotId"), "stream/one");
  assert.equal(app.requests.filter(r => r.url.includes("snapshot=stream%2Fone")).length, 1);
  const html = app.read("renderSecurityDetailPage()");
  assert.match(html, />headers<\/pre>/);
  assert.match(html, />event<\/pre>/);
  assert.doesNotMatch(html, /正在加载正文片段|正在加载检测证据/);
});

test("late body pages cannot replace a new snapshot or closed detail", async () => {
  let release;
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/body?")) {
      if (url.includes("snapshot=request")) return new Promise(resolve => { release = resolve; });
      return { body: { chunks: [{ start: 0, end: 6, content: "second", redactions: [] }] } };
    }
    if (url.includes("/audit/one")) return { body: { record: { id: "one", bodySnapshots: [{ id: "request" }, { id: "response" }] } } };
  } });
  app.read('state.page = "security"');
  const first = app.action("security-detail", { dataset: { id: "one" } });
  for (let i = 0; i < 10 && !release; i++) await setImmediate();
  await app.action("security-body", { dataset: { id: "response" } });
  release({ body: { chunks: [{ start: 0, end: 5, content: "stale", redactions: [] }] } }); await first;
  assert.equal(app.read("state.security.bodyPage.chunks[0].content"), "second");
  const pending = app.action("security-body", { dataset: { id: "request" } });
  await app.action("security-back", {});
  release({ body: { chunks: [{ content: "stale" }] } }); await pending;
  assert.equal(app.read("state.security.detail"), null);
  assert.equal(app.read("state.security.bodyPage"), null);
});

test("body locations retain numeric key order and select enclosing command arguments", async () => {
  const app = await controller();
  const range = JSON.parse(app.read('JSON.stringify(securityBodyText({ "12": "second", "z": "first" }, "request", "request/field/0/command/0", { request: ["z", "12"] }))'));
  assert.equal(range.text.slice(range.range.start, range.range.end), '"first"');
  assert.equal(range.range.path, "request/field/0");
});

test("returning to the list invalidates pending detail reads", async () => {
  let release;
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/audit/old")) return new Promise(resolve => { release = resolve; });
  } });
  app.read('state.page = "security"');
  const pending = app.action("security-detail", { dataset: { id: "old" } });
  await app.action("security-back", {});
  release({ body: { record: { id: "old" } } });
  await pending;
  assert.equal(app.read("state.security.detail"), null);
});

test("Claude configurations can be created without a Codex catalog and retain native protocol and scoped models", async () => {
  const app = await controller();
  app.read('state.codexCatalog = { available: false, models: [] }; state.createTarget = "claude-code"');
  const form = creationForm();
  form.fields.target = "claude-code";
  form.fields.upstreamAuth = "authorization";
  form.fields.suiteName = "";
  form.querySelectorAll = () => [{ querySelector: (selector) => ({ value: selector.includes("clientModelId") ? "claude-sonnet-4-6" : "vendor-sonnet" }) }];
  assert.match(app.read("renderSuiteCreate()"), /value="claude-code" selected/);
  assert.doesNotMatch(app.read("createModelRow()"), /data-official-model/);
  await app.submit(form);
  const config = app.persisted();
  const binding = config.bindings["claude-code-example-invalid"];
  assert.equal(binding.target, "claude-code");
  assert.equal(binding.targetFormat, "claude.settings.json.v1");
  assert.equal(binding.defaultModel, undefined);
  const provider = config.virtualProviders[binding.virtualProvider];
  const backend = config.routes[provider.route].backends[0];
  assert.equal(provider.ingressProtocol, "anthropic.messages");
  assert.equal(config.upstreams[backend.upstream].protocol, "anthropic.messages");
  assert.deepEqual(config.upstreams[backend.upstream].auth, { header: "authorization" });
  assert.equal(config.upstreams[backend.upstream].integration, undefined);
  const model = provider.models["claude-sonnet-4-6"];
  assert.deepEqual(Object.keys(provider.models), ["claude-sonnet-4-6"]);
  assert.equal(model.capabilities, undefined);
  assert.equal(model.contextWindow, undefined);
  assert.ok(config.virtualProviders.cabletidy_relay.models["gpt-5.5"]);
  assert.equal(validateConfig(config).ok, true);
  const html = app.read("renderSuiteDetail()");
  assert.match(html, /应用到 Claude Code/);
  assert.match(html, /撤销接入/);
  assert.doesNotMatch(html, /Compact strategy|850000|data-codex-metadata|open-advanced-models/);
  assert.equal(app.read("suiteEndpoint(selectedSuite())"), "http://127.0.0.1:43100/claude-code-example-invalid");
});

test("Claude creation saves family aliases and selectable defaults without applying or changing existing Codex configurations", async () => {
  const app = await controller();
  const before = app.persisted();
  const form = creationForm();
  Object.assign(form.fields, {
    target: "claude-code", defaultModel: " opus ", subagent: " haiku ",
    opus: "custom-client", sonnet: "custom-client", fable: "custom-client", haiku: "custom-client",
  });
  form.querySelectorAll = () => [{ querySelector: (selector) => ({ value: selector.includes("clientModelId") ? "custom-client" : "upstream-custom" }) }];
  await app.submit(form);
  const config = app.persisted();
  const binding = config.bindings.development;
  assert.equal(binding.defaultModel, "opus");
  assert.equal(config.virtualProviders[binding.virtualProvider].defaultModel, "opus");
  assert.deepEqual(binding.claude, {
    setModel: true,
    models: { opus: "custom-client", sonnet: "custom-client", fable: "custom-client", haiku: "custom-client", subagent: "haiku" },
  });
  assert.equal(app.read("claudeDefaultModel(selectedSuite())"), "opus");
  assert.equal(validateConfig(config).ok, true);
  assert.equal(app.requests.some(({ url }) => url.endsWith("/targets/apply")), false);
  for (const section of ["upstreams", "routes", "virtualProviders", "bindings"]) {
    for (const [id, value] of Object.entries(before[section])) assert.deepEqual(config[section][id], value);
  }
});

test("Claude creation allows empty optional sections and clears values outside the selectable candidates", async () => {
  for (const defaultModel of ["", "unregistered-startup"]) {
    const app = await controller();
    const form = formNode("suite-create-form", {
      ...creationForm().fields, target: "claude-code", defaultModel,
      opus: "", sonnet: "", fable: "", haiku: "", subagent: defaultModel ? "unregistered-worker" : " ",
    });
    await app.submit(form);
    const config = app.persisted();
    const binding = config.bindings.development;
    const provider = config.virtualProviders[binding.virtualProvider];
    assert.deepEqual(provider.models, {});
    assert.equal(binding.defaultModel, undefined);
    assert.equal(provider.defaultModel, undefined);
    assert.deepEqual(binding.claude, {});
    assert.equal(validateConfig(config).ok, true);
  }
});

test("Claude creation rejects family aliases outside the draft client IDs before committing", async () => {
  for (const family of ["opus", "sonnet", "fable", "haiku"]) {
    const app = await controller();
    const before = app.persisted();
    const form = creationForm();
    Object.assign(form.fields, { target: "claude-code", [family]: "vendor-gpt" });
    await app.submit(form);
    assert.match(form.feedback.innerHTML, /本次填写的客户端模型 ID/);
    assert.deepEqual(app.persisted(), before);
    assert.equal(app.requests.some(({ url }) => url.endsWith("/config/commit")), false);
  }
});

test("Codex creation ignores values in the hidden Claude optional sections", async () => {
  const baseline = await controller();
  await baseline.submit(creationForm());
  const app = await controller();
  const form = creationForm();
  Object.assign(form.fields, {
    defaultModel: "claude-custom", subagent: "worker-custom",
    opus: "claude-custom", sonnet: "claude-custom", fable: "claude-custom", haiku: "claude-custom",
  });
  await app.submit(form);
  assert.deepEqual(app.persisted(), baseline.persisted());
});

test("Claude client selection saves optional family defaults, applies explicitly, and can restore", async () => {
  const app = await controller(claudeConfigFixture());
  await app.action("open-suite", { dataset: { id: "claude-main" } });
  await app.submit(formNode("claude-client-form", { defaultModel: "claude-sonnet-4-6", sonnet: "claude-sonnet-4-6", fable: "claude-sonnet-4-6", subagent: "sonnet", discoverModels: "on" }));
  const binding = app.persisted().bindings["claude-main"];
  assert.equal(binding.defaultModel, "claude-sonnet-4-6");
  assert.deepEqual(binding.claude, { setModel: true, discoverModels: true, models: { sonnet: "claude-sonnet-4-6", fable: "claude-sonnet-4-6", subagent: "sonnet" } });
  assert.equal(app.requests.some(({ url }) => url.endsWith("/targets/apply")), false);
  await app.action("apply-target", {});
  assert.equal(app.requests.at(-1).url, "/api/v1/targets/apply");
  assert.equal(app.requests.at(-1).body.bindingId, "claude-main");
  await app.action("restore-target", {});
  assert.equal(app.requests.at(-1).url, "/api/v1/targets/restore");
  await app.submit(formNode("claude-client-form", {}));
  assert.equal(app.persisted().bindings["claude-main"].defaultModel, undefined);
  assert.deepEqual(app.persisted().bindings["claude-main"].claude.models, {});
});

test("Claude details use the simple connectivity action without inference controls or parameters", async () => {
  const app = await controller(claudeConfigFixture());
  await app.action("open-suite", { dataset: { id: "claude-main" } });
  const html = app.read("renderSuiteDetail()");
  assert.match(html, /data-action="test-upstream" data-id="relay">测试连通性/);
  assert.doesNotMatch(html, /claude-probe-form|测试模型|测试推理|测试 SSE/);
  await app.action("test-upstream", { dataset: { id: "relay" } });
  const requests = app.requests.filter(({ url }) => url === "/api/v1/tests/upstream");
  assert.deepEqual(requests, [{ url: "/api/v1/tests/upstream", body: { id: "relay" } }]);
  assert.ok(app.messages.some((message) => message.includes("上游可连接")));
});

test("Claude upstream authentication can switch without replacing its saved credential", async () => {
  const app = await controller(claudeConfigFixture());
  await app.action("open-suite", { dataset: { id: "claude-main" } });
  await app.submit(formNode("suite-upstream-form", { id: "relay", name: "Relay", protocol: "anthropic.messages", baseUrl: "https://example.invalid/v1", authHeader: "authorization", secret: "" }));
  assert.deepEqual(app.persisted().upstreams.relay.auth, { header: "authorization", scheme: "Bearer" });
  assert.equal(app.persisted().upstreams.relay.secretRef, "secret://upstreams/relay");
  const commit = app.requests.find(({ url }) => url.endsWith("config/commit"));
  assert.deepEqual(commit.body.upstreamSecrets, {});
});

test("Claude mapping edits do not invent capability or compaction policies", async () => {
  const app = await controller(claudeConfigFixture());
  await app.action("open-suite", { dataset: { id: "claude-main" } });
  const controls = { "[data-suite-model-client]": "claude-sonnet-4-6", '[data-suite-model-upstream="relay"]': "new-model" };
  await app.submit(formNode("suite-models-form", {}, [{ dataset: { modelId: "claude-sonnet-4-6" }, querySelector: (selector) => selector in controls ? { value: controls[selector] } : null }]));
  const model = app.persisted().virtualProviders["cabletidy_claude-main"].models["claude-sonnet-4-6"];
  assert.equal(model.upstreamModelId, "new-model");
  assert.equal(model.id, undefined);
  assert.equal(model.description, undefined);
  assert.equal(model.capabilities, undefined);
  assert.equal(model.contextWindow, undefined);
  assert.equal(model.compact, undefined);
  assert.equal(validateConfig(app.persisted()).ok, true);
});

test("Claude model suggestions allow custom IDs and empty upstream mappings without changing Codex selection", async () => {
  const app = await controller();
  app.read('state.createTarget = "claude-code"');
  assert.match(app.read("renderSuiteCreate()"), /datalist id="claude-model-suggestions"/);
  assert.match(app.read("createModelRow()"), /list="claude-model-suggestions"/);
  assert.match(app.read("claudeModelSuggestions()"), /claude-fable-5-1/);
  const form = creationForm();
  form.fields.target = "claude-code";
  form.querySelectorAll = () => [{ querySelector: (selector) => ({ value: selector.includes("clientModelId") ? "custom-client-model" : "" }) }];
  await app.submit(form);
  const config = app.persisted();
  assert.equal(validateConfig(config).ok, true);
  const model = config.virtualProviders.cabletidy_development.models["custom-client-model"];
  assert.equal(model.upstreamModelId, undefined);
  assert.match(app.read('claudeAliasSelect(selectedSuite(), "fable")'), /value="custom-client-model"/);
  const html = app.read("renderSuiteDetail()");
  assert.doesNotMatch(html, /data-claude-model-name|data-claude-model-description|显示名称|模型列表显示/);
  await app.action("open-suite", { dataset: { id: "relay" } });
  const codexHtml = app.read("renderSuiteDetail()");
  assert.match(codexHtml, /data-official-model/);
  assert.doesNotMatch(codexHtml, /claude-model-suggestions|别名指向/);
});

test("Claude alias choices are scoped to saved client IDs and keep references through rename and removal", async () => {
  const config = claudeConfigFixture();
  config.virtualProviders.cabletidy_other = { ...clone(config.virtualProviders["cabletidy_claude-main"]), id: "cabletidy_other", models: { "other-configuration-model": {} } };
  const app = await controller(config);
  await app.action("open-suite", { dataset: { id: "claude-main" } });
  const choices = app.read('claudeAliasSelect(selectedSuite(), "opus")');
  assert.match(choices, /由 Claude 默认决定/);
  assert.doesNotMatch(choices, /other-configuration-model|vendor-sonnet/);
  const invalid = formNode("claude-client-form", { opus: "not-configured" });
  await app.submit(invalid);
  assert.match(invalid.feedback.innerHTML, /已保存的客户端模型 ID/);
  assert.equal(app.requests.some(({ url }) => url.endsWith("/config/commit")), false);
  await app.submit(formNode("claude-client-form", { opus: "claude-sonnet-4-6", sonnet: "claude-sonnet-4-6", fable: "claude-sonnet-4-6", haiku: "claude-sonnet-4-6" }));
  const controls = { "[data-suite-model-client]": "my-claude", '[data-suite-model-upstream="relay"]': "" };
  await app.submit(formNode("suite-models-form", {}, [{ dataset: { modelId: "claude-sonnet-4-6" }, querySelector: (selector) => selector in controls ? { value: controls[selector] } : null }]));
  assert.deepEqual(app.persisted().bindings["claude-main"].claude.models, { opus: "my-claude", sonnet: "my-claude", fable: "my-claude", haiku: "my-claude" });
  assert.equal(validateConfig(app.persisted()).ok, true);
  await app.submit(formNode("suite-models-form"));
  assert.deepEqual(app.persisted().bindings["claude-main"].claude.models, {});
  assert.equal(validateConfig(app.persisted()).ok, true);
});

test("Claude legacy alias values stay visible until the user chooses a registered model or the default", async () => {
  const config = claudeConfigFixture();
  config.bindings["claude-main"].claude.models = { haiku: "legacy-unregistered-model" };
  const app = await controller(config);
  await app.action("open-suite", { dataset: { id: "claude-main" } });
  assert.match(app.read('claudeAliasSelect(selectedSuite(), "haiku")'), /legacy-unregistered-model.*selected disabled/);
  const untouched = formNode("claude-client-form", {});
  await app.submit(untouched);
  assert.match(untouched.feedback.innerHTML, /未配置的模型/);
  assert.equal(app.persisted().bindings["claude-main"].claude.models.haiku, "legacy-unregistered-model");
  await app.submit(formNode("claude-client-form", { haiku: "" }));
  assert.deepEqual(app.persisted().bindings["claude-main"].claude.models, {});
});

test("Claude default client IDs follow mapping renames and removals in saved settings and artifacts", async () => {
  for (const useProviderDefault of [false, true]) {
    const config = claudeConfigFixture();
    config.virtualProviders["cabletidy_claude-main"].defaultModel = "claude-sonnet-4-6";
    if (!useProviderDefault) config.bindings["claude-main"].defaultModel = "claude-sonnet-4-6";
    config.bindings["claude-main"].claude = { discoverModels: true, models: { sonnet: "claude-sonnet-4-6", subagent: "claude-sonnet-4-6" } };
    const app = await controller(config);
    await app.action("open-suite", { dataset: { id: "claude-main" } });
    const controls = { "[data-suite-model-client]": "renamed-client", '[data-suite-model-upstream="relay"]': "vendor-sonnet" };
    await app.submit(formNode("suite-models-form", {}, [{ dataset: { modelId: "claude-sonnet-4-6" }, querySelector: (selector) => selector in controls ? { value: controls[selector] } : null }]));
    let saved = app.persisted();
    assert.equal(saved.bindings["claude-main"].defaultModel, "renamed-client");
    assert.equal(saved.virtualProviders["cabletidy_claude-main"].defaultModel, "renamed-client");
    assert.deepEqual(saved.bindings["claude-main"].claude, { setModel: true, discoverModels: true, models: { sonnet: "renamed-client", subagent: "renamed-client" } });
    let env = buildTargetArtifacts(saved, { bindingId: "claude-main" }).environment.vars;
    assert.equal(env.ANTHROPIC_MODEL, "renamed-client");
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "renamed-client");
    assert.equal(app.read("claudeDefaultModel(selectedSuite())"), "renamed-client");
    await app.submit(formNode("suite-models-form"));
    saved = app.persisted();
    assert.equal(saved.bindings["claude-main"].defaultModel, undefined);
    assert.equal(saved.virtualProviders["cabletidy_claude-main"].defaultModel, undefined);
    assert.deepEqual(saved.bindings["claude-main"].claude, { setModel: false, discoverModels: true, models: {} });
    assert.equal(app.read("claudeDefaultModel(selectedSuite())"), "");
    env = buildTargetArtifacts(saved, { bindingId: "claude-main" }).environment.vars;
    assert.equal(env.ANTHROPIC_MODEL, undefined);
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
    assert.equal(validateConfig(saved).ok, true);
    assert.equal(app.requests.some(({ url }) => url.endsWith("/targets/apply")), false);
  }
});

test("Claude default aliases survive removal of a same-named model profile or client ID", async () => {
  for (const clientModelId of ["claude-sonnet-4-6", "sonnet"]) {
    const config = claudeConfigFixture();
    config.virtualProviders["cabletidy_claude-main"].models = { [clientModelId]: config.virtualProviders["cabletidy_claude-main"].models["claude-sonnet-4-6"] };
    const app = await controller(config);
    await app.action("open-suite", { dataset: { id: "claude-main" } });
    await app.submit(formNode("claude-client-form", { defaultModel: "sonnet", subagent: "sonnet", sonnet: clientModelId }));
    await app.submit(formNode("suite-models-form"));
    const saved = app.persisted();
    assert.equal(saved.bindings["claude-main"].defaultModel, "sonnet");
    assert.equal(saved.virtualProviders["cabletidy_claude-main"].defaultModel, "sonnet");
    assert.deepEqual(saved.bindings["claude-main"].claude.models, { subagent: "sonnet" });
    const env = buildTargetArtifacts(saved, { bindingId: "claude-main" }).environment.vars;
    assert.equal(env.ANTHROPIC_MODEL, "sonnet");
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
  }
});

test("Claude default model selectors expose field-specific aliases and current client IDs only", async () => {
  const config = claudeConfigFixture();
  config.virtualProviders.cabletidy_other = { ...clone(config.virtualProviders["cabletidy_claude-main"]), id: "cabletidy_other", models: { "other-configuration-model": {} } };
  config.bindings["claude-main"].defaultModel = "legacy-startup";
  config.bindings["claude-main"].claude.models = { subagent: "legacy-subagent" };
  const app = await controller(config);
  await app.action("open-suite", { dataset: { id: "claude-main" } });
  const html = app.read("renderSuiteDetail()");
  assert.match(html, /<h3 id="claude-defaults-title">默认模型/);
  assert.match(html, /name="defaultModel" data-claude-default-model/);
  assert.match(html, /name="subagent" data-claude-default-model/);
  assert.match(html, /value="best"/);
  assert.match(html, /value="opusplan"/);
  assert.doesNotMatch(html, /value="opus\[1m\]"|value="sonnet\[1m\]"|value="opusplan\[1m\]"/);
  assert.doesNotMatch(html, /value="other-configuration-model"/);
  assert.doesNotMatch(html, /value="legacy-startup"/);
  assert.doesNotMatch(html, /value="legacy-subagent"/);
  const defaultOptions = app.read('claudeDefaultModelOptions("defaultModel", ["claude-sonnet-4-6"], "")');
  const subagentOptions = app.read('claudeDefaultModelOptions("subagent", ["claude-sonnet-4-6"], "")');
  assert.match(defaultOptions, /value="best"/);
  assert.match(defaultOptions, /value="claude-sonnet-4-6"/);
  assert.doesNotMatch(defaultOptions, /\[1m\]/);
  assert.doesNotMatch(defaultOptions, /value="inherit"/);
  assert.doesNotMatch(subagentOptions, /value="best"|value="opusplan"/);
  assert.match(subagentOptions, /value="opus"/);
  assert.match(subagentOptions, /value="claude-sonnet-4-6"/);
  await app.submit(formNode("claude-client-form", { defaultModel: "", subagent: "", opus: "", sonnet: "", fable: "", haiku: "" }));
  assert.equal(app.persisted().bindings["claude-main"].defaultModel, undefined);
  assert.deepEqual(app.persisted().bindings["claude-main"].claude.models, {});
});

test("suite upstream edits preserve authentication and disabled state when an input shadows the form ID", async () => {
  const config = normalizeConfig(codexConfigFixture());
  config.upstreams.relay.auth = { header: "x-custom-key", prefix: "Token " };
  config.upstreams.relay.secretRef = "secret://upstreams/custom-relay";
  config.upstreams.relay.enabled = false;
  const app = await controller(config);
  const form = formNode("suite-upstream-form", {
    id: "relay", name: "Edited relay", protocol: "openai.responses",
    baseUrl: "https://example.invalid/v1", secret: "",
  });
  // HTMLFormElement exposes the named input as form.id.
  form.id = { name: "id", value: "relay" };
  await app.submit(form);
  assert.equal(app.persisted().upstreams.relay.name, "Edited relay");
  assert.equal(app.read("state.config.upstreams.relay.name"), "Edited relay");
  assert.deepEqual(app.persisted().upstreams.relay.auth, config.upstreams.relay.auth);
  assert.equal(app.persisted().upstreams.relay.secretRef, config.upstreams.relay.secretRef);
  assert.equal(app.persisted().upstreams.relay.enabled, false);
  const commits = app.requests.filter(({ url }) => url.endsWith("/config/commit"));
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].body.upstreamSecrets, {});
  assert.equal(app.read("state.busy"), false);
});

test("preview and apply follow the selected suite after creation, switching and cancellation", async () => {
  const app = await controller();
  await app.submit(creationForm());
  for (const id of ["development", "relay"]) {
    await app.action("open-suite", { dataset: { id } });
    await app.action("preview-artifacts", {});
    assert.equal(app.requests.at(-1).body.bindingId, id);
    await app.action("apply-target", {});
    assert.equal(app.requests.at(-1).url, "/api/v1/targets/apply");
    assert.equal(app.requests.at(-1).body.bindingId, id);
  }
  await app.action("create-suite", {});
  await app.action("back-overview", {});
  await app.action("open-suite", { dataset: { id: "development" } });
  await app.action("apply-target", {});
  assert.equal(app.requests.at(-1).body.bindingId, "development");
});

for (const [target, fixture, id] of [
  ["Codex", codexConfigFixture, "relay"],
  ["Claude Code", claudeConfigFixture, "claude-main"],
]) {
  test(`${target} configuration deletion removes its dependencies and returns to an empty list`, async () => {
    const app = await controller(normalizeConfig(fixture()));
    assert.match(app.read("renderOverview()"), new RegExp(`data-action="delete-suite" data-id="${id}"`));
    await app.action("open-suite", { dataset: { id } });
    assert.match(app.read("renderSuiteDetail()"), /data-action="delete-suite"/);
    const name = app.read("selectedSuite().name");
    app.read(`state.artifactPreview = { bindingId: ${JSON.stringify(id)} }; state.resolveResult = { ok: true }`);
    await app.action("delete-suite", { dataset: { id }, closest: () => null });

    const saved = app.persisted();
    for (const field of ["bindings", "virtualProviders", "routes", "upstreams"]) assert.deepEqual(saved[field], {});
    assert.equal(validateConfig(saved).ok, true);
    assert.equal(app.read("state.page"), "overview");
    assert.equal(app.read("state.selected.suite"), null);
    assert.equal(app.read("state.selected.virtualProvider"), null);
    assert.equal(app.read("state.selected.model"), null);
    assert.equal(app.read("state.artifactPreview"), null);
    assert.equal(app.read("state.resolveResult"), null);
    assert.equal(app.read("state.busy"), false);
    assert.match(app.read("renderOverview()"), /暂无配置/);
    assert.ok(app.confirmations[0].includes(`「${name}」`));
    assert.match(app.confirmations[0], /本地地址将停止服务/);
    if (target === "Claude Code") assert.match(app.confirmations[0], /先撤销接入或切换其他配置/);
    assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 1);
    assert.ok(!app.requests.some(({ url }) => url.includes("/targets/")));
    assert.deepEqual(app.messages, ["配置已删除并生效。"]);
  });
}

for (const deletedId of ["first", "second"]) {
  test(`deleting ${deletedId} preserves the other configuration and keeps a valid selection`, async () => {
    const initial = normalizeConfig(namedCodexConfigFixture({ first: "first", second: "second" }));
    const app = await controller(initial);
    await app.action("delete-suite", { dataset: { id: deletedId }, closest: () => null });
    const remainingId = deletedId === "first" ? "second" : "first";
    const saved = app.persisted();
    assert.deepEqual(Object.keys(saved.bindings), [remainingId]);
    for (const field of ["bindings", "routes", "upstreams"]) {
      assert.deepEqual(saved[field][remainingId], initial[field][remainingId]);
      assert.equal(saved[field][deletedId], undefined);
    }
    assert.deepEqual(saved.virtualProviders, { [`cabletidy_${remainingId}`]: initial.virtualProviders[`cabletidy_${remainingId}`] });
    assert.equal(app.read("state.selected.suite"), remainingId);
    assert.equal(app.read("state.selected.virtualProvider"), `cabletidy_${remainingId}`);
    assert.equal(app.read("state.selected.model"), "gpt-5.5");
    assert.equal(validateConfig(saved).ok, true);
  });
}

test("deletion after cancelling creation clears stale provider and model selections", async () => {
  const app = await controller();
  await app.action("create-suite", {});
  await app.action("back-overview", {});
  await app.action("delete-suite", { dataset: { id: "relay" }, closest: () => null });
  assert.equal(app.read("state.selected.suite"), null);
  assert.equal(app.read("state.selected.virtualProvider"), null);
  assert.equal(app.read("state.selected.model"), null);
});

for (const shared of ["route", "upstream"]) {
  test(`configuration deletion preserves a shared ${shared} and unrelated unused resources`, async () => {
    const initial = namedCodexConfigFixture({ first: "first", second: "second", unused: "unused" });
    delete initial.bindings.unused;
    delete initial.virtualProviders.cabletidy_unused;
    if (shared === "route") initial.virtualProviders.cabletidy_second.route = "first";
    else initial.routes.second.backends[0].upstream = "first";
    const app = await controller(normalizeConfig(initial));
    const before = app.persisted();
    await app.action("delete-suite", { dataset: { id: "first" }, closest: () => null });
    const saved = app.persisted();
    assert.equal(saved.bindings.first, undefined);
    assert.equal(saved.virtualProviders.cabletidy_first, undefined);
    assert.deepEqual(saved.upstreams, before.upstreams);
    assert.deepEqual(saved.routes.unused, before.routes.unused);
    assert.deepEqual(saved.routes.second, before.routes.second);
    if (shared === "route") assert.deepEqual(saved.routes.first, before.routes.first);
    else assert.equal(saved.routes.first, undefined);
    assert.equal(validateConfig(saved).ok, true);
  });
}

test("cancelling deletion retains unsaved edits and makes no commit", async () => {
  const app = await controller(undefined, { confirmLeave: false });
  app.read('state.page = "suite-detail"');
  const input = inputNode("name", "Relay");
  const form = mountTrackedForm(app, "suite-upstream-form", [input]);
  input.value = "Unsaved relay";
  const before = app.persisted();
  await app.action("delete-suite", { dataset: { id: "relay" }, closest: () => null });
  assert.deepEqual(app.persisted(), before);
  assert.equal(app.read("state.page"), "suite-detail");
  assert.equal(app.read("state.selected.suite"), "relay");
  assert.equal(input.value, "Unsaved relay");
  assert.equal(app.edited(form), true);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 0);
  assert.match(app.confirmations[0], /未保存的修改也会丢失/);
  assert.equal(app.read("state.busy"), false);
});

for (const status of [409, 422, 500]) {
  test(`failed deletion (${status}) retains the configuration, selection and unsaved form`, async () => {
    const app = await controller(undefined, { onCommit: () => ({ status, body: { error: { message: "删除失败" } } }) });
    app.read('state.page = "suite-detail"; state.artifactPreview = { bindingId: "relay" }');
    const input = inputNode("name", "Relay");
    const form = mountTrackedForm(app, "suite-upstream-form", [input]);
    input.value = "Unsaved relay";
    const before = app.persisted();
    await app.action("delete-suite", { dataset: { id: "relay" }, closest: () => null });
    assert.deepEqual(app.persisted(), before);
    assert.deepEqual(clone(app.read("state.candidate")), before);
    assert.equal(app.read("state.selected.suite"), "relay");
    assert.equal(app.read("state.selected.virtualProvider"), "cabletidy_relay");
    assert.equal(app.read("state.artifactPreview.bindingId"), "relay");
    assert.equal(app.read("state.page"), "suite-detail");
    assert.equal(input.value, "Unsaved relay");
    assert.equal(app.edited(form), true);
    assert.equal(app.read("state.busy"), false);
    assert.deepEqual(app.messages, ["删除失败"]);
  });
}

test("a pending deletion cannot submit a second change", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const app = await controller(undefined, { onCommit: () => pending });
  const button = { dataset: { id: "relay" }, closest: () => null };
  const first = app.action("delete-suite", button);
  await setImmediate();
  assert.equal(app.read("state.busy"), true);
  await app.action("delete-suite", button);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 1);
  release();
  await first;
  assert.deepEqual(app.persisted().bindings, {});
  assert.equal(app.read("state.busy"), false);
});

test("creation commits immediately and clears transient secrets", async () => {
  const app = await controller(normalizeConfig({}));
  app.read('state.page = "suite-create"');
  await app.submit(creationForm());
  assert.equal(app.read("state.page"), "suite-detail");
  const config = app.persisted();
  const binding = Object.values(config.bindings)[0];
  assert.equal(binding.name, "Development");
  assert.equal(binding.id, "development");
  assert.equal(binding.virtualProvider, "cabletidy_development");
  assert.equal(config.virtualProviders.cabletidy_development.id, binding.virtualProvider);
  assert.equal(app.read("state.selected.suite"), binding.id);
  assert.equal(app.read("state.selected.virtualProvider"), binding.virtualProvider);
  assert.match(app.read("renderSuiteDetail()"), /cabletidy_development/);
  assert.match(app.read("renderSuiteDetail()"), /http:\/\/127\.0\.0\.1:43100\/development\/v1/);
  assert.equal(config.virtualProviders.cabletidy_development.listenPort, undefined);
  assert.deepEqual(Object.keys(config.virtualProviders.cabletidy_development.models), ["gpt-5.5"]);
  assert.equal(config.virtualProviders.cabletidy_development.models["gpt-5.5"].upstreamModelId, "vendor-gpt");
  const commits = app.requests.filter(({ url }) => url.endsWith("/config/commit"));
  assert.equal(commits.length, 1);
  assert.deepEqual(Object.values(commits[0].body.upstreamSecrets), ["test-key"]);
  assert.equal(app.read("Object.keys(state.pendingSecrets.upstreamSecrets).length"), 0);
  assert.equal(app.requests.some(({ url }) => url.endsWith("/config/validate")), false);
  assert.doesNotMatch(app.read("renderDiagnostics()"), /配置校验|校验草稿/);
});

test("an empty configuration name derives a stable identity from the upstream host", async () => {
  const app = await controller(normalizeConfig({}));
  const form = creationForm();
  form.fields.suiteName = "";
  await app.submit(form);
  const binding = Object.values(app.persisted().bindings)[0];
  assert.equal(binding.name, "Codex / example.invalid");
  assert.equal(binding.id, "codex-example-invalid");
  assert.equal(binding.virtualProvider, "cabletidy_codex-example-invalid");
});

test("creating a duplicate normalized name preserves the existing configuration", async () => {
  const app = await controller(normalizeConfig({}));
  await app.submit(creationForm());
  const first = app.persisted();
  const form = creationForm();
  form.fields.suiteName = "development";
  await app.submit(form);
  assert.match(form.feedback.innerHTML, /ID 已存在/);
  assert.deepEqual(app.persisted(), first);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 1);
});

test("creation needs only upstream credentials and keeps other configurations' model settings isolated", async () => {
  const app = await controller();
  app.read('state.codexCatalog = { available: false, models: [], error: { message: "unavailable" } }');
  assert.doesNotMatch(app.read("renderSuiteCreate()"), /data-create-model[ >]/);
  await app.submit(formNode("suite-create-form", creationForm().fields));
  const config = app.persisted();
  assert.equal(config.bindings.development.defaultModel, undefined);
  assert.deepEqual(config.virtualProviders.cabletidy_development.models, {});
  assert.equal(config.virtualProviders.cabletidy_development.defaultModel, undefined);
  assert.equal(config.routes[config.virtualProviders.cabletidy_development.route].backends[0].models, undefined);
  assert.deepEqual(Object.keys(config.virtualProviders.cabletidy_relay.models), ["gpt-5.5"]);
  assert.equal(validateConfig(config).ok, true);
  assert.match(app.read("renderSuiteDetail()"), /模型名直接透传/);
  assert.doesNotMatch(app.read("renderSuiteDetail()"), /data-model-id="model"/);
  const commit = app.requests.find(({ url }) => url.endsWith("/config/commit"));
  assert.deepEqual(Object.values(commit.body.upstreamSecrets), ["test-key"]);
});

test("model settings can override context without a rename and can all be removed", async () => {
  const app = await controller();
  await app.submit(formNode("suite-models-form", {}, [{
    dataset: { modelId: "gpt-5.5" },
    querySelector(selector) {
      if (selector === "[data-suite-model-client]") return { value: "gpt-5.5" };
      if (selector.startsWith("[data-suite-model-upstream=")) return { value: "" };
      if (selector === "[data-codex-metadata-mode]") return { value: "override" };
      if (selector === "[data-suite-model-context]") return { value: "128000" };
      if (selector === "[data-codex-vision]") return { checked: true };
      return null;
    },
  }]));
  let config = app.persisted();
  assert.equal(config.virtualProviders.cabletidy_relay.models["gpt-5.5"].contextWindow, 128000);
  assert.equal(config.virtualProviders.cabletidy_relay.models["gpt-5.5"].codex.metadataMode, "override");
  assert.equal(config.virtualProviders.cabletidy_relay.models["gpt-5.5"].upstreamModelId, undefined);
  assert.equal(validateConfig(config).ok, true);
  await app.submit(formNode("suite-models-form"));
  config = app.persisted();
  assert.equal(config.models, undefined);
  assert.deepEqual(config.virtualProviders.cabletidy_relay.models, {});
  assert.equal(config.routes.route.backends[0].models, undefined);
  assert.equal(config.virtualProviders.cabletidy_relay.defaultModel, undefined);
  assert.equal(config.bindings.relay.defaultModel, undefined);
  assert.equal(validateConfig(config).ok, true);
});

test("optional creation rows may leave the upstream model name blank", async () => {
  const app = await controller(normalizeConfig({}));
  await app.submit(formNode("suite-create-form", creationForm().fields, [{
    querySelector: selector => ({ value: selector.includes("clientModelId") ? "gpt-5.5" : "" }),
  }]));
  const config = app.persisted();
  const model = Object.values(config.virtualProviders.cabletidy_development.models)[0];
  assert.equal(model.upstreamModelId, undefined);
  assert.equal(config.bindings.development.defaultModel, undefined);
  assert.equal(validateConfig(config).ok, true);
});

test("separate configurations each keep their own upstream and model mappings", async () => {
  const app = await controller(normalizeConfig({}));
  await app.submit(creationForm());
  const second = creationForm();
  second.fields.suiteName = "Production";
  await app.submit(second);
  const config = app.persisted();
  assert.equal(Object.keys(config.bindings).length, 2);
  const upstreamIds = new Set();
  for (const binding of Object.values(config.bindings)) {
    const provider = config.virtualProviders[binding.virtualProvider];
    const route = config.routes[provider.route];
    assert.equal(route.backends.length, 1);
    const upstreamId = route.backends[0].upstream;
    upstreamIds.add(upstreamId);
    assert.deepEqual(Object.keys(provider.models), ["gpt-5.5"]);
    assert.equal(provider.models["gpt-5.5"].upstreamModelId, "vendor-gpt");
  }
  assert.equal(upstreamIds.size, 2);
  assert.equal(validateConfig(config).ok, true);
});

test("advanced model editor exposes one upstream and saves only its model mapping", async () => {
  const app = await controller();
  const models = app.read("renderModels()");
  assert.equal((models.match(/name="upstreamId"/g) || []).length, 0);
  assert.doesNotMatch(models, /CableTidy Model ID/);
  await app.submit(formNode("model-form", {
    id: "model", clientModelId: "gpt-5.5", aliases: "gpt-5.5",
    upstreamId: "relay", upstreamModelId: "changed-model", capabilityOverrides: "-vision",
    capabilities: "streaming, tools, reasoning",
  }));
  const model = app.persisted().virtualProviders.cabletidy_relay.models["gpt-5.5"];
  assert.equal(model.upstreams, undefined);
  assert.equal(model.upstreamModelId, "changed-model");
  assert.deepEqual(model.capabilityOverrides, ["-vision"]);
});

test("a rejected creation stays on the form and can be retried without duplicate records", async () => {
  let reject = true;
  const app = await controller(normalizeConfig({}), {
    onCommit: () => reject ? {
      status: 422,
      body: { error: { message: "配置校验失败" }, errors: [{ path: "upstreams.relay-main.baseUrl", message: "地址不合法" }] },
    } : null,
  });
  app.read('state.page = "suite-create"');
  const form = creationForm();
  await app.submit(form);
  assert.equal(app.read("state.page"), "suite-create");
  assert.equal(app.read("Object.keys(state.candidate.bindings).length"), 0);
  assert.equal(Object.keys(app.persisted().bindings).length, 0);
  assert.equal(app.read("state.selected.suite"), null);
  assert.equal(app.read("Object.keys(state.pendingSecrets.upstreamSecrets).length"), 0);
  assert.match(form.feedback.innerHTML, /地址不合法/);
  assert.equal(form.fields.upstreamSecret, "test-key");
  assert.equal(app.messages.length, 0);
  reject = false;
  await app.submit(form);
  assert.equal(Object.keys(app.persisted().bindings).length, 1);
  assert.equal(Object.keys(app.persisted().upstreams).length, 1);
  assert.equal(app.read("state.page"), "suite-detail");
});

test("local form validation does not write or leave a partial candidate", async () => {
  const app = await controller(normalizeConfig({}));
  app.read('state.page = "suite-create"');
  const form = creationForm();
  form.fields.upstreamSecret = "";
  await app.submit(form);
  assert.match(form.feedback.innerHTML, /API Key/);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 0);
  assert.equal(app.read("Object.keys(state.candidate.upstreams).length"), 0);
  assert.equal(app.read("state.busy"), false);
});

for (const failure of [
  { status: 409, body: { error: { code: "revision_conflict", message: "配置已经变更" } }, expected: /其他窗口变更/ },
  { status: 500, body: { error: { code: "config_reload_failed", message: "端口被占用" } }, expected: /端口被占用/ },
]) {
  test("save failure " + failure.status + " preserves the active configuration and form input", async () => {
    const app = await controller(undefined, { onCommit: () => failure });
    app.read('state.page = "suite-detail"');
    const form = formNode("suite-upstream-form", {
      id: "relay", name: "Unsaved relay", protocol: "openai.responses",
      baseUrl: "https://example.invalid/v1", secret: "new-key",
    });
    await app.submit(form);
    assert.match(form.feedback.innerHTML, failure.expected);
    assert.equal(form.fields.name, "Unsaved relay");
    assert.equal(app.read("state.config.upstreams.relay.name"), "Relay");
    assert.equal(app.read("state.candidate.upstreams.relay.name"), "Relay");
    assert.equal(app.read("state.page"), "suite-detail");
    assert.equal(app.read("state.busy"), false);
    assert.equal(app.messages.length, 0);
  });
}

test("a pending save cannot submit a second change", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const app = await controller(normalizeConfig({}), { onCommit: () => pending });
  const form = creationForm();
  const first = app.submit(form);
  await setImmediate();
  assert.equal(app.read("state.busy"), true);
  await app.submit(form);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 1);
  release();
  await first;
  assert.equal(Object.keys(app.persisted().bindings).length, 1);
  assert.equal(app.read("state.busy"), false);
});

function securityCatalogFixture() {
  const catalog = catalogFixture();
  const base = catalog.catalog.models[0];
  catalog.catalog.models.splice(1, 0, ...["blue", "red"].map((color) => ({
    ...base, slug: `gpt-daybreak-${color}-latest`, display_name: `Daybreak ${color}`, visibility: "hide",
  })));
  catalog.catalog.models.push({ ...base, slug: "gpt-hidden-general", visibility: "hide" });
  return catalog;
}

function officialSelectNode(value = "") {
  const hint = { textContent: "", hidden: true };
  return {
    value, innerHTML: "", hint,
    parentElement: { querySelector: () => hint },
    matches: (selector) => selector === "[data-official-model]",
    closest: () => null,
  };
}

test("Daybreak options remain selectable in a trailing security group without classifying other hidden models", async () => {
  const app = await controller(undefined, { catalog: securityCatalogFixture() });
  const html = app.read('officialModelOptions("gpt-daybreak-blue-latest")');
  const group = html.match(/<optgroup label="安全专项模型">([\s\S]*?)<\/optgroup>/)[1];
  assert.match(group, /value="gpt-daybreak-blue-latest" selected>Daybreak Blue · 需授权/);
  assert.match(group, /value="gpt-daybreak-red-latest" >Daybreak Red · 需专项授权/);
  assert.equal((group.match(/<option /g) || []).length, 2);
  assert.doesNotMatch(html, /disabled/);
  assert.doesNotMatch(group, /gpt-hidden-general|gpt-5\.5|gpt-5\.6-sol/);
  assert.ok(html.indexOf('value="gpt-hidden-general"') < html.indexOf("<optgroup"));
  assert.match(html, /<\/optgroup>\s*$/);
});

test("ordinary catalogs do not gain an empty security group or a permission hint", async () => {
  const app = await controller();
  const html = app.read('officialModelSelect("", "gpt-5.5")');
  assert.doesNotMatch(html, /optgroup|需授权|需专项授权/);
  assert.match(html, /data-official-model-hint aria-live="polite" hidden/);
});

test("security guidance follows selection changes and each picker has its own accessible hint", async () => {
  const app = await controller(undefined, { catalog: securityCatalogFixture() });
  const select = officialSelectNode("gpt-daybreak-blue-latest");
  app.change(select);
  assert.match(select.hint.textContent, /防御性安全工作/);
  assert.equal(select.hint.hidden, false);
  select.value = "gpt-daybreak-red-latest";
  app.change(select);
  assert.match(select.hint.textContent, /单独获得 Red 授权/);
  assert.doesNotMatch(select.hint.textContent, /防御性/);
  for (const value of ["gpt-5.5", "gpt-hidden-general", ""]) {
    select.value = value;
    app.change(select);
    assert.equal(select.hint.hidden, true);
    assert.equal(select.hint.textContent, "");
  }
  const first = app.read('officialModelSelect("", "gpt-daybreak-blue-latest")');
  const second = app.read('officialModelSelect("", "gpt-daybreak-red-latest")');
  const firstId = first.match(/aria-describedby="([^"]+)"/)[1];
  const secondId = second.match(/aria-describedby="([^"]+)"/)[1];
  assert.notEqual(firstId, secondId);
  assert.ok(first.includes(`id="${firstId}"`));
  assert.ok(second.includes(`id="${secondId}"`));
});

for (const color of ["blue", "red"]) {
  test(`Daybreak ${color} can be created and existing mappings can be saved without changing model IDs`, async () => {
    const id = `gpt-daybreak-${color}-latest`;
    const app = await controller(normalizeConfig({}), { catalog: securityCatalogFixture() });
    await app.submit(formNode("suite-create-form", creationForm().fields, [{
      querySelector: (selector) => ({ value: selector.includes("clientModelId") ? id : "vendor-security" }),
    }]));
    const model = app.persisted().virtualProviders.cabletidy_development.models[id];
    const upstreamId = app.read("selectedSuite().upstreamId");
    assert.ok(model);
    assert.match(app.read('renderSuiteDetail()'), new RegExp(`value="${id}" selected`));
    await app.submit(formNode("suite-models-form", {}, [{
      dataset: { modelId: id },
      querySelector(selector) {
        if (selector === "[data-suite-model-client]") return { value: id };
        if (selector.startsWith("[data-suite-model-upstream=")) return { value: "updated-security" };
        if (selector === "[data-codex-metadata-mode]") return { value: "official" };
        return null;
      },
    }]));
    assert.deepEqual(Object.keys(app.persisted().virtualProviders.cabletidy_development.models), [id]);
    assert.equal(app.persisted().virtualProviders.cabletidy_development.models[id].upstreamModelId, "updated-security");
    assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 2);
  });
}

test("catalog refresh retains Daybreak selection and refreshes stale missing-catalog hints", async () => {
  const app = await controller(undefined, { catalog: securityCatalogFixture() });
  assert.match(app.read("codexCatalogStatus()"), /刷新模型列表/);
  assert.doesNotMatch(app.read("codexCatalogStatus()"), /刷新目录/);
  const select = officialSelectNode("gpt-daybreak-red-latest");
  const page = app.node("#page-content");
  page.querySelectorAll = (selector) => selector === "[data-official-model]" ? [select] : [];
  app.read('state.codexCatalog.models = []');
  app.change(select);
  assert.match(select.hint.textContent, /未匹配/);
  await app.action("refresh-codex-models");
  assert.equal(select.value, "gpt-daybreak-red-latest");
  assert.match(select.innerHTML, /value="gpt-daybreak-red-latest" selected/);
  assert.match(select.hint.textContent, /单独获得 Red 授权/);
  assert.doesNotMatch(select.hint.textContent, /未匹配/);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 0);
});

test("a failed catalog refresh keeps the selected Daybreak ID and guidance", async () => {
  const app = await controller(undefined, {
    catalog: securityCatalogFixture(),
    refreshCatalog: { available: false, models: [], error: { message: "目录不可用" } },
  });
  const select = officialSelectNode("gpt-daybreak-blue-latest");
  app.node("#page-content").querySelectorAll = (selector) => selector === "[data-official-model]" ? [select] : [];
  await app.action("refresh-codex-models");
  assert.match(select.innerHTML, /value="gpt-daybreak-blue-latest" selected/);
  assert.match(select.hint.textContent, /防御性安全工作.*未匹配本机官方目录/);
  assert.equal(select.hint.hidden, false);
  assert.equal(app.read("state.busy"), false);
});

function inputNode(name, value, extra = {}) {
  return { name, value, type: "text", dataset: {}, disabled: false, closest: () => null, ...extra };
}

function mountTrackedForm(app, id, inputs) {
  const form = formNode(id);
  form.querySelectorAll = () => inputs;
  app.node("#page-content").querySelectorAll = (selector) => selector === "form" ? [form] : [];
  app.track(form);
  return form;
}

for (const target of ["claude-code", "codex"]) {
  test(`${target} creation retains a switched CLI, model rows and settings across refresh before submission`, async () => {
    const app = await controller();
    const page = app.node("#page-content");
    let current;
    const makeForm = () => {
      const form = formNode("suite-create-form");
      const inputs = Object.entries({ ...creationForm().fields, target: app.read("state.createTarget"), defaultModel: "", subagent: "" })
        .map(([name, value]) => inputNode(name, value, { type: name === "target" ? "select-one" : "text" }));
      form.rows = [];
      form.input = (name) => inputs.find(input => input.name === name);
      Object.defineProperty(form, "fields", { get: () => Object.fromEntries(inputs.map(input => [input.name, input.value])) });
      form.replaceWith = (replacement) => { current = replacement; };
      form.querySelector = (selector) => selector === "[data-form-feedback]" ? form.feedback : { hidden: false };
      form.querySelectorAll = (selector) => selector === "input, select, textarea" ? [...inputs, ...form.rows.flatMap(row => row.inputs)]
        : selector === "[data-create-model]" ? form.rows
        : selector === '[data-create-field="clientModelId"]' ? form.rows.map(row => row.inputs[0]) : [];
      const cli = form.input("target");
      cli.closest = (selector) => selector === "form" ? form : null;
      cli.matches = (selector) => selector === '#suite-create-form [name="target"]';
      return form;
    };
    Object.defineProperty(page, "innerHTML", { configurable: true, set: () => { current = makeForm(); } });
    page.querySelectorAll = (selector) => selector === "form" ? [current] : [];
    page.querySelector = (selector) => selector === "#suite-create-form" ? current : null;
    await app.action("create-suite");
    const draft = current;
    for (const cli of ["claude-code", target]) {
      draft.input("target").value = cli;
      app.change(draft.input("target"));
    }
    draft.input("defaultModel").value = "opus";
    draft.input("subagent").value = "haiku";
    const client = target === "claude-code" ? "custom-claude-client" : "gpt-5.5";
    const inputs = [inputNode("", client, { dataset: { createField: "clientModelId" } }), inputNode("", "vendor-custom", { dataset: { createField: "upstreamModelId" } })];
    draft.rows.push({ inputs, querySelector: (selector) => selector.includes("clientModelId") ? inputs[0] : inputs[1] });
    assert.equal(app.edited(draft), true, app.messages.join("; "));
    app.externalUpdate(config => { config.upstreams.relay.name = "Other window update"; });
    for (let i = 0; i < 2; i++) {
      await app.action("refresh");
      assert.equal(current, draft, app.messages.join("; "));
      assert.equal(draft.feedback, null);
      assert.equal(app.edited(draft), true);
      assert.equal(app.requests.some(({ url }) => url.endsWith("/config/commit")), false);
    }
    await app.submit(draft);
    const config = app.persisted();
    assert.equal(config.bindings.development.target, target);
    assert.equal(config.bindings.development.defaultModel, target === "claude-code" ? "opus" : undefined);
    assert.equal(config.bindings.development.claude?.models?.subagent, target === "claude-code" ? "haiku" : undefined);
    assert.equal(config.upstreams.relay.name, "Other window update");
    assert.equal(validateConfig(config).ok, true);
    const commit = app.requests.find(({ url }) => url.endsWith("/config/commit"));
    assert.deepEqual(Object.values(commit.body.upstreamSecrets), ["test-key"]);
  });
}

test("dirty state follows current text, select, checkbox and secret values rather than past input events", async () => {
  const app = await controller();
  const inputs = [
    inputNode("name", "Relay"),
    inputNode("model", "gpt-5.5", { type: "select-one" }),
    inputNode("enabled", "on", { type: "checkbox", checked: true }),
    inputNode("secret", "", { type: "password" }),
  ];
  const form = mountTrackedForm(app, "suite-upstream-form", inputs);
  for (const input of inputs) {
    const key = input.type === "checkbox" ? "checked" : "value";
    const original = input[key];
    input[key] = key === "checked" ? false : "changed";
    assert.equal(app.edited(form), true, input.name);
    input[key] = original;
    assert.equal(app.edited(form), false, input.name);
  }
  inputs.forEach(input => { input.disabled = true; });
  assert.equal(app.edited(form), false, "Transient control locking is not a configuration change");
  inputs[0].value = "Changed while locked";
  assert.equal(app.edited(form), true);
});

test("adding and removing the same model row restores a clean form", async () => {
  const app = await controller();
  const inputs = [inputNode("", "gpt-5.5", { dataset: { suiteModelClient: "" } })];
  const form = mountTrackedForm(app, "suite-models-form", inputs);
  inputs.push(inputNode("", "gpt-daybreak-blue-latest", { dataset: { suiteModelClient: "" } }));
  assert.equal(app.edited(form), true);
  inputs.pop();
  assert.equal(app.edited(form), false);
});

test("cancelled navigation retains the page, selection and unsaved input", async () => {
  const app = await controller(undefined, { confirmLeave: false });
  const input = inputNode("name", "Relay");
  const form = mountTrackedForm(app, "suite-upstream-form", [input]);
  app.read('state.page = "suite-detail"');
  input.value = "Unsaved relay";
  app.read('navigatePage("diagnostics")');
  assert.equal(app.read("state.page"), "suite-detail");
  assert.equal(app.edited(form), true);
  await app.action("back-overview");
  assert.equal(app.read("state.page"), "suite-detail");
  assert.equal(input.value, "Unsaved relay");
  assert.equal(app.confirmations.length, 2);
  assert.equal(app.read("state.busy"), false);
});

test("confirmed navigation proceeds, while reverted edits need no confirmation", async () => {
  const app = await controller();
  const input = inputNode("name", "Relay");
  mountTrackedForm(app, "suite-upstream-form", [input]);
  app.read('state.page = "suite-detail"');
  input.value = "Changed";
  app.read('navigatePage("diagnostics")');
  assert.equal(app.read("state.page"), "diagnostics");
  assert.equal(app.confirmations.length, 1);
  input.value = "Relay";
  app.track(app.node("#page-content").querySelectorAll("form")[0]);
  input.value = "Temporary";
  input.value = "Relay";
  app.read('navigatePage("overview")');
  assert.equal(app.read("state.page"), "overview");
  assert.equal(app.confirmations.length, 1);
});

test("clicking the active navigation page does not rerender or discard input", async () => {
  const app = await controller();
  const input = inputNode("name", "Relay");
  const form = mountTrackedForm(app, "suite-upstream-form", [input]);
  app.read('state.page = "suite-detail"');
  input.value = "Unsaved";
  app.read('navigatePage("suite-detail")');
  assert.equal(app.edited(form), true);
  assert.equal(app.confirmations.length, 0);
});

test("browser unload is guarded only for actual configuration changes", async () => {
  const app = await controller();
  const input = inputNode("name", "Relay");
  mountTrackedForm(app, "suite-upstream-form", [input]);
  const event = { prevented: 0, preventDefault() { this.prevented++; } };
  app.beforeUnload(event);
  assert.equal(event.prevented, 0);
  input.value = "Changed";
  app.beforeUnload(event);
  assert.equal(event.prevented, 1);
  assert.equal(event.returnValue, "");
  input.value = "Relay";
  app.beforeUnload(event);
  assert.equal(event.prevented, 1);
  mountTrackedForm(app, "resolve-form", [input]);
  input.value = "Diagnostic query";
  app.beforeUnload(event);
  assert.equal(event.prevented, 1, "Diagnostic query fields are not unsaved configuration");
});

test("reverting edits allows Codex apply without an unnecessary commit", async () => {
  const app = await controller();
  const input = inputNode("name", "Relay");
  mountTrackedForm(app, "suite-upstream-form", [input]);
  input.value = "Changed";
  await app.action("apply-target");
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/targets/apply")).length, 0);
  input.value = "Relay";
  await app.action("apply-target");
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/targets/apply")).length, 1);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 0);
});

function metadataRow(mode = "official") {
  const select = officialSelectNode("gpt-5.5");
  Object.assign(select, { name: "", type: "select-one", dataset: { suiteModelClient: "", officialModel: "" } });
  const context = inputNode("", "272000", { dataset: { suiteModelContext: "" }, type: "number", disabled: mode === "official" });
  const vision = inputNode("", "on", { dataset: { codexVision: "" }, type: "checkbox", checked: true, disabled: mode === "official" });
  const metadataMode = inputNode("", mode, { dataset: { codexMetadataMode: "" }, type: "select-one" });
  const instructions = { textContent: "Original definition" };
  const row = {
    dataset: { modelId: "gpt-5.5" },
    querySelector: (selector) => ({
      "[data-suite-model-client]": select,
      "[data-suite-model-context]": context,
      "[data-codex-vision]": vision,
      "[data-codex-metadata-mode]": metadataMode,
      "[data-codex-instructions]": instructions,
    })[selector] || null,
  };
  const inputs = [select, context, vision, metadataMode];
  inputs.forEach(input => { input.closest = (selector) => selector === "[data-suite-model]" ? row : null; });
  return { row, select, context, vision, metadataMode, instructions, inputs };
}

for (const mode of ["official", "override"]) {
  test(`catalog refresh synchronizes ${mode} metadata without changing user overrides or dirty state`, async () => {
    const latest = publicCodexCatalog(catalogFixture());
    Object.assign(latest.models[0], { name: "Updated model", contextWindow: 128000, maxContextWindow: 512000, inputModalities: ["text"] });
    const app = await controller(undefined, { refreshCatalog: latest });
    const metadata = metadataRow(mode);
    const form = mountTrackedForm(app, "suite-models-form", metadata.inputs);
    if (mode === "override") {
      metadata.context.value = "64000";
      metadata.vision.checked = false;
    }
    app.controls(metadata.inputs);
    app.node("#page-content").querySelectorAll = (selector) => selector === "form" ? [form]
      : selector === "[data-official-model]" ? [metadata.select] : [];
    await app.action("refresh-codex-models");
    assert.equal(metadata.context.value, mode === "official" ? 128000 : "64000");
    assert.equal(metadata.context.max, 512000);
    assert.equal(metadata.context.disabled, mode === "official");
    assert.equal(metadata.vision.checked, false);
    assert.equal(metadata.vision.disabled, true, "Latest modality restriction survives unlocking");
    assert.match(metadata.instructions.textContent, /Updated model/);
    assert.equal(app.edited(form), mode === "override");
    assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 0);
  });
}

test("official metadata changes are ignored when determining whether a form is dirty", async () => {
  const app = await controller();
  const metadata = metadataRow();
  const form = mountTrackedForm(app, "suite-models-form", metadata.inputs);
  metadata.context.value = "128000";
  metadata.vision.checked = false;
  assert.equal(app.edited(form), false);
  metadata.metadataMode.value = "override";
  assert.equal(app.edited(form), true);
  metadata.metadataMode.value = "official";
  assert.equal(app.edited(form), false);
});

function addFixtureModel(config, clientModelId = "gpt-5.6-sol") {
  config.virtualProviders.cabletidy_relay.models[clientModelId] = clone(config.virtualProviders.cabletidy_relay.models["gpt-5.5"] || { codex: { metadataMode: "official" }, upstreamModelId: "VENDOR-GPT" });
}

test("renaming saved models frees their old client names for new rows without hidden ID collisions", async () => {
  const config = normalizeConfig(codexConfigFixture());
  const profile = config.virtualProviders.cabletidy_relay.models["gpt-5.5"];
  config.virtualProviders.cabletidy_relay.models = {
    "gpt-5.6-sol": { ...profile, upstreamModelId: "old-sol" },
    "gpt-5.6-luna": { ...profile, upstreamModelId: "old-luna" },
  };
  config.virtualProviders.cabletidy_relay.defaultModel = "gpt-5.6-sol";
  config.bindings.relay.defaultModel = "gpt-5.6-sol";
  const catalog = catalogFixture();
  catalog.catalog.models = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna"].map(slug => ({ ...catalog.catalog.models[0], slug }));
  const app = await controller(config, { catalog });
  const rows = [
    ["gpt-5.6-sol", "gpt-6-sol", "new-sol"],
    ["gpt-5.6-luna", "gpt-6-luna", "new-luna"],
    ["", "gpt-5.6-sol", "old-sol"],
    ["", "gpt-5.6-luna", "old-luna"],
  ].map(([oldName, name, upstreamModelId]) => ({
    dataset: { modelId: oldName },
    querySelector: selector => selector === "[data-suite-model-client]" ? { value: name }
      : selector === '[data-suite-model-upstream="relay"]' ? { value: upstreamModelId } : null,
  }));
  const form = formNode("suite-models-form", {}, rows);
  await app.submit(form);
  assert.equal(form.feedback, null);
  const saved = app.persisted();
  const provider = saved.virtualProviders.cabletidy_relay;
  assert.deepEqual(Object.keys(provider.models), ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-luna"]);
  assert.equal(provider.models["gpt-6-sol"].upstreamModelId, "new-sol");
  assert.equal(provider.models["gpt-5.6-sol"].upstreamModelId, "old-sol");
  assert.equal(provider.defaultModel, "gpt-6-sol");
  assert.equal(saved.bindings.relay.defaultModel, "gpt-6-sol");
  assert.equal(saved.models, undefined);
  assert.equal(provider.allowedModels, undefined);
  assert.equal(validateConfig(saved).ok, true);
});

test("model names can be swapped while mappings and defaults follow the edited rows", async () => {
  const config = normalizeConfig(codexConfigFixture());
  addFixtureModel(config);
  const app = await controller(config);
  const rows = [["gpt-5.5", "gpt-5.6-sol", "first"], ["gpt-5.6-sol", "gpt-5.5", "second"]].map(([oldName, name, mapping]) => ({
    dataset: { modelId: oldName },
    querySelector: selector => selector === "[data-suite-model-client]" ? { value: name }
      : selector === '[data-suite-model-upstream="relay"]' ? { value: mapping } : null,
  }));
  const form = formNode("suite-models-form", {}, rows);
  await app.submit(form);
  assert.equal(form.feedback, null);
  const provider = app.persisted().virtualProviders.cabletidy_relay;
  assert.equal(provider.models["gpt-5.6-sol"].upstreamModelId, "first");
  assert.equal(provider.models["gpt-5.5"].upstreamModelId, "second");
  assert.equal(provider.defaultModel, "gpt-5.6-sol");
});

// Model the form replacement lifecycle, not just the saved configuration object.
function mountSuiteEditor(app) {
  const page = app.node("#page-content");
  let current;
  const makeForm = () => {
    const config = app.read("state.candidate");
    const form = formNode("suite-models-form");
    form.rows = [];
    const attribute = form.getAttribute;
    form.getAttribute = (name) => name === "data-suite-context"
      ? JSON.stringify(["relay", "codex", config.bindings.relay.virtualProvider, "route", config.routes.route.backends[0].upstream]) : attribute(name);
    form.replaceWith = (replacement) => { current = replacement; };
    const list = {
      querySelector: () => null,
      append(row) {
        row.remove();
        row.remove = () => { form.rows = form.rows.filter(item => item !== row); };
        form.rows.push(row);
      },
    };
    form.querySelector = (selector) => selector === "#suite-model-list" ? list
      : selector === "[data-form-feedback]" ? form.feedback : null;
    form.querySelectorAll = (selector) => selector === "[data-suite-model]" ? [...form.rows]
      : selector === "input, select, textarea" ? form.rows.flatMap(row => row.inputs)
      : selector === "[data-official-model]" ? form.rows.flatMap(row => row.inputs.filter(input => "officialModel" in input.dataset)) : [];
    for (const id of Object.keys(config.virtualProviders.cabletidy_relay.models)) {
      const model = config.virtualProviders.cabletidy_relay.models[id];
      const metadata = metadataRow(model.codex?.metadataMode);
      const { row, select, context, vision } = metadata;
      row.dataset.modelId = id;
      select.value = id;
      context.value = String(model.contextWindow || 272000);
      vision.checked = model.codex?.inputModalities?.includes("image") ?? true;
      const mapping = inputNode("", model.upstreamModelId, {
        dataset: { suiteModelUpstream: "relay" }, closest: () => row,
      });
      const query = row.querySelector;
      row.querySelector = (selector) => selector === '[data-suite-model-upstream="relay"]' ? mapping : query(selector);
      row.inputs = [...metadata.inputs, mapping];
      row.mapping = mapping;
      row.context = context;
      row.remove = () => { form.rows = form.rows.filter(item => item !== row); };
      form.rows.push(row);
    }
    return form;
  };
  app.read('state.page = "suite-detail"');
  Object.defineProperty(page, "innerHTML", { configurable: true, set: () => { current = makeForm(); } });
  page.querySelectorAll = (selector) => selector === "form" ? [current] : [];
  page.querySelector = (selector) => selector === "#suite-models-form" ? current : null;
  app.read("render()");
  return { form: () => current, row: (id = "gpt-5.5") => current.rows.find(row => row.dataset.modelId === id) };
}

test("conflict refresh merges another window's added model before retrying a local mapping edit", async () => {
  const app = await controller();
  const editor = mountSuiteEditor(app);
  editor.row().mapping.value = "LOCAL-MAPPING";
  app.externalUpdate(config => addFixtureModel(config));
  await app.submit(editor.form());
  assert.match(editor.form().feedback.innerHTML, /其他窗口变更/);
  assert.equal(app.persisted().virtualProviders.cabletidy_relay.models["gpt-5.5"].upstreamModelId, "VENDOR-GPT");
  await app.action("refresh");
  assert.deepEqual(editor.form().rows.map(row => row.dataset.modelId), ["gpt-5.5", "gpt-5.6-sol"]);
  assert.equal(editor.row().mapping.value, "LOCAL-MAPPING");
  assert.equal(app.edited(editor.form()), true);
  await app.submit(editor.form());
  const saved = app.persisted();
  assert.deepEqual(Object.keys(saved.virtualProviders.cabletidy_relay.models), ["gpt-5.5", "gpt-5.6-sol"]);
  assert.equal(saved.routes.route.backends[0].models, undefined);
  assert.deepEqual(Object.keys(saved.virtualProviders.cabletidy_relay.models), ["gpt-5.5", "gpt-5.6-sol"]);
  assert.equal(saved.virtualProviders.cabletidy_relay.models["gpt-5.5"].upstreamModelId, "LOCAL-MAPPING");
  assert.equal(validateConfig(saved).ok, true);
  assert.equal(app.edited(editor.form()), false);
});

test("refresh merges disjoint fields on the same model and does not keep stale server values", async () => {
  const config = normalizeConfig(codexConfigFixture());
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].codex = { metadataMode: "override", inputModalities: ["text"] };
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].contextWindow = 64000;
  const app = await controller(config);
  const editor = mountSuiteEditor(app);
  editor.row().mapping.value = "LOCAL-MAPPING";
  app.externalUpdate(config => { config.virtualProviders.cabletidy_relay.models["gpt-5.5"].contextWindow = 128000; });
  await app.action("refresh");
  assert.equal(editor.row().mapping.value, "LOCAL-MAPPING");
  assert.equal(editor.row().context.value, "128000");
  await app.submit(editor.form());
  assert.equal(app.persisted().virtualProviders.cabletidy_relay.models["gpt-5.5"].contextWindow, 128000);
  assert.equal(app.persisted().virtualProviders.cabletidy_relay.models["gpt-5.5"].upstreamModelId, "LOCAL-MAPPING");
});

test("overlapping edits remain blocked across repeated refreshes until explicitly reloaded", async () => {
  const app = await controller();
  const editor = mountSuiteEditor(app);
  const local = editor.form();
  editor.row().mapping.value = "LOCAL-MAPPING";
  app.externalUpdate(config => { config.virtualProviders.cabletidy_relay.models["gpt-5.5"].upstreamModelId = "REMOTE-MAPPING"; });
  await app.submit(local);
  const commits = () => app.requests.filter(({ url }) => url.endsWith("/config/commit")).length;
  const attempts = commits();
  for (let i = 0; i < 2; i++) {
    await app.action("refresh");
    assert.equal(editor.form(), local);
    assert.equal(editor.row().mapping.value, "LOCAL-MAPPING");
    assert.match(local.feedback.innerHTML, /冲突.*暂停保存/);
    assert.match(local.feedback.innerHTML, /加载最新配置/);
    await app.submit(local);
    assert.equal(commits(), attempts);
  }
  await app.action("apply-target");
  assert.equal(app.requests.some(({ url }) => url.endsWith("/targets/apply")), false);
  await app.action("reload-form", { closest: () => local });
  assert.match(app.confirmations.at(-1), /放弃此表单/);
  assert.equal(editor.row().mapping.value, "REMOTE-MAPPING");
  assert.equal(app.edited(editor.form()), false);
});

test("local model removal and remote model addition are merged independently", async () => {
  const config = normalizeConfig(codexConfigFixture());
  addFixtureModel(config);
  const catalog = catalogFixture();
  catalog.catalog.models.push({ ...catalog.catalog.models[0], slug: "gpt-5.6-luna" });
  const app = await controller(config, { catalog });
  const editor = mountSuiteEditor(app);
  editor.row().remove();
  app.externalUpdate(config => addFixtureModel(config, "gpt-5.6-luna"));
  await app.action("refresh");
  assert.deepEqual(editor.form().rows.map(row => row.dataset.modelId), ["gpt-5.6-sol", "gpt-5.6-luna"]);
  await app.submit(editor.form());
  assert.deepEqual(Object.keys(app.persisted().virtualProviders.cabletidy_relay.models), ["gpt-5.6-sol", "gpt-5.6-luna"]);
});

for (const localDeletes of [true, false]) {
  test(`refresh blocks ${localDeletes ? "local removal versus remote edit" : "local edit versus remote removal"}`, async () => {
    const config = normalizeConfig(codexConfigFixture());
    addFixtureModel(config);
    const app = await controller(config);
    const editor = mountSuiteEditor(app);
    if (localDeletes) editor.row("gpt-5.6-sol").remove();
    else editor.row("gpt-5.6-sol").mapping.value = "LOCAL-MAPPING";
    app.externalUpdate(config => {
      if (localDeletes) config.virtualProviders.cabletidy_relay.models["gpt-5.6-sol"].upstreamModelId = "REMOTE-MAPPING";
      else {
        delete config.virtualProviders.cabletidy_relay.models["gpt-5.6-sol"];
      }
    });
    await app.action("refresh");
    assert.match(editor.form().feedback.innerHTML, /冲突/);
    await app.submit(editor.form());
    assert.equal(app.requests.some(({ url }) => url.endsWith("/config/commit")), false);
  });
}

test("pending new rows survive remote additions and the refreshed baseline tracks only local edits", async () => {
  const app = await controller();
  const editor = mountSuiteEditor(app);
  const added = metadataRow().row;
  added.dataset.modelId = "";
  added.inputs = [inputNode("", "new-model", { dataset: { suiteModelClient: "" }, closest: () => added })];
  added.remove = () => {};
  editor.form().querySelector("#suite-model-list").append(added);
  app.externalUpdate(config => addFixtureModel(config));
  await app.action("refresh");
  assert.deepEqual(editor.form().rows.map(row => row.dataset.modelId), ["gpt-5.5", "gpt-5.6-sol", ""]);
  assert.equal(app.edited(editor.form()), true);
  added.remove();
  assert.equal(app.edited(editor.form()), false);
});

test("a changed suite upstream cannot silently retarget local model edits", async () => {
  const app = await controller();
  const editor = mountSuiteEditor(app);
  editor.row().mapping.value = "LOCAL-MAPPING";
  app.externalUpdate(config => { config.routes.route.backends[0].upstream = "another-upstream"; });
  await app.action("refresh");
  assert.match(editor.form().feedback.innerHTML, /冲突/);
  await app.submit(editor.form());
  assert.equal(app.requests.some(({ url }) => url.endsWith("/config/commit")), false);
});

for (const property of ["model", "metadata mode"]) {
  test(`concurrent ${property} changes cannot reinterpret local mapping edits`, async () => {
    const app = await controller();
    const editor = mountSuiteEditor(app);
    editor.row().mapping.value = "LOCAL-MAPPING";
    app.externalUpdate(config => {
      if (property === "model") config.virtualProviders.cabletidy_relay.models = { "gpt-5.6-sol": config.virtualProviders.cabletidy_relay.models["gpt-5.5"] };
      else config.virtualProviders.cabletidy_relay.models["gpt-5.5"].codex = { metadataMode: "override", inputModalities: ["text"] };
    });
    await app.action("refresh");
    assert.match(editor.form().feedback.innerHTML, /冲突/);
    await app.submit(editor.form());
    assert.equal(app.requests.some(({ url }) => url.endsWith("/config/commit")), false);
  });
}

test("an unchanged model removed remotely is not resurrected by a local edit to another row", async () => {
  const config = normalizeConfig(codexConfigFixture());
  addFixtureModel(config);
  const app = await controller(config);
  const editor = mountSuiteEditor(app);
  editor.row().mapping.value = "LOCAL-MAPPING";
  app.externalUpdate(config => {
    delete config.virtualProviders.cabletidy_relay.models["gpt-5.6-sol"];
  });
  await app.action("refresh");
  assert.deepEqual(editor.form().rows.map(row => row.dataset.modelId), ["gpt-5.5"]);
  await app.submit(editor.form());
  assert.deepEqual(Object.keys(app.persisted().virtualProviders.cabletidy_relay.models), ["gpt-5.5"]);
  assert.equal(app.persisted().virtualProviders.cabletidy_relay.models["gpt-5.5"].upstreamModelId, "LOCAL-MAPPING");
});

test("merged local model selection keeps its matching security hint", async () => {
  const app = await controller(undefined, { catalog: securityCatalogFixture() });
  const editor = mountSuiteEditor(app);
  const select = editor.row().querySelector("[data-suite-model-client]");
  select.value = "gpt-daybreak-blue-latest";
  app.change(select);
  app.externalUpdate(config => addFixtureModel(config));
  await app.action("refresh");
  const merged = editor.row().querySelector("[data-suite-model-client]");
  assert.equal(merged.value, "gpt-daybreak-blue-latest");
  assert.match(merged.hint.textContent, /防御性安全工作/);
  assert.equal(merged.hint.hidden, false);
});

test("session trace preserves context, selects steps lazily, filters summaries and restores navigation", async () => {
  const records = [
    { id: "a", sessionKey: "session-one", kind: "request", outcome: "completed", inspectionStatus: "complete", requestPreview: "检查输入状态", responsePreview: "<script>literal</script>", clientModelId: "gpt-5.5", upstreamModelId: "<vendor-gpt>", findingCount: 0, findings: [], bodySnapshots: [] },
    { id: "b", sessionKey: "session-one", kind: "request", outcome: "completed", inspectionStatus: "partial", requestPreview: "保留上下文", toolNames: ["exec_command"], findingCount: 1, findings: [], bodySnapshots: [] },
  ];
  const summary = { id: "session-one", identified: true, kind: "request", sessionTitle: "检查输入状态", requestCount: 2, findingCount: 1 };
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/sessions?")) return { body: { items: [summary], total: 1 } };
    if (url.includes("/audit?")) return { body: { items: records, total: 2 } };
    if (url.includes("/audit/")) return { body: { record: records.find(r => url.endsWith(`/${r.id}`)) } };
  } });
  app.read('navigatePage("security")'); await setImmediate();
  app.read('window.scrollY = 400');
  await app.action("security-session", { dataset: { id: "session-one" } });
  assert.equal(app.read("state.page"), "security-session");
  assert.equal(app.read("state.security.detail.id"), "a");
  assert.equal(app.requests.some(r => r.url.includes("/body?")), false, "overview never fetches bodies");
  let html = app.read("renderSecuritySession()");
  assert.match(html, /&lt;script&gt;literal/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /模型<\/span><strong[^>]*>gpt-5\.5 → &lt;vendor-gpt&gt;<\/strong>/);
  assert.doesNotMatch(html, /<vendor-gpt>/);
  assert.match(app.read("renderTraceInspector()"), /模型<\/dt><dd>gpt-5\.5 → &lt;vendor-gpt&gt;<\/dd>/);
  assert.equal(app.read("traceItems().length"), 2);
  await app.submit(formNode("security-trace-search", { search: "VENDOR-GPT" }));
  assert.equal(app.read("traceItems().length"), 1);
  assert.equal(app.read("traceItems()[0].id"), "a");
  await app.submit(formNode("security-trace-search", { search: "" }));
  await app.action("security-trace-risk", { dataset: {} });
  assert.equal(app.read("traceItems().length"), 1);
  await app.submit(formNode("security-trace-search", { search: "missing" }));
  assert.match(app.read("renderSecuritySession()"), /已加载的轨迹中没有匹配的步骤/);
  await app.submit(formNode("security-trace-search", { search: "exec_command" }));
  assert.equal(app.read("traceItems()[0].id"), "b");
  await app.action("security-trace-select", { dataset: { id: "b" } });
  assert.equal(app.read("state.security.detail.id"), "b");
  assert.match(app.read("renderTraceInspector()"), /模型<\/dt><dd>未记录 → 未记录<\/dd>/);
  assert.equal(app.read("state.page"), "security-session");
  await app.back();
  assert.equal(app.read("state.page"), "security");
  assert.equal(app.read("window.scrollY"), 400);
  await app.forward();
  assert.equal(app.read("state.page"), "security-session");
  assert.equal(app.read("state.trace.summary.requestCount"), 2);
});

test("Codex request overview shows every role, links tool results, paginates and locates retained source safely", async () => {
  const items = [
    { index: 0, kind: "system", source: "instructions", preview: "System <script>literal</script>", start: 20, end: 60 },
    { index: 1, kind: "developer", source: "input[0]", preview: "Repository instructions" },
    { index: 2, kind: "user", source: "input[1]", preview: "First question" },
    { index: 3, kind: "assistant", preview: "Historical answer" },
    { index: 4, kind: "tool_call", name: "exec_command", callId: "call_1", relatedIndex: 5, preview: '{"cmd":"pwd"}' },
    { index: 5, kind: "tool_result", name: "exec_command", callId: "call_1", relatedIndex: 4, preview: "/project" },
    { index: 6, kind: "reasoning", preview: "", opaque: true },
    { index: 7, kind: "user", preview: "Follow up", parts: ["input_image"], start: 200, end: 300 },
    { index: 8, kind: "reference", preview: '"resp_prior"' },
    { index: 9, kind: "tool_definition", name: "exec_command", preview: "Available tool" },
  ];
  const record = { id: "mixed", kind: "request", outcome: "completed", toolNames: ["apply_patch"], findings: [], bodySnapshots: [{ id: "request", state: "complete", contentMode: "original" }], requestContent: { state: "complete", total: 45, offset: 0, nextOffset: 40, counts: { system: 1, developer: 1, user: 2, assistant: 1, tool_call: 1, tool_result: 1, reasoning: 1, reference: 1, tool_definition: 1 }, items } };
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/content?")) return { body: { state: "complete", total: 45, offset: 40, nextOffset: null, counts: record.requestContent.counts, items: [{ index: 40, kind: "user", preview: "Later message" }] } };
    if (url.includes("/body?")) return { body: { chunks: [{ start: 0, end: 400, content: "retained source" }] } };
    if (url.includes("/audit?")) return { body: { items: [record], total: 1 } };
    if (url.includes("/audit/")) return { body: { record: clone(record) } };
    if (url.includes("/sessions?")) return { body: { items: [{ id: "mixed-session", kind: "request", requestCount: 1 }], total: 1 } };
  } });
  await app.action("security-session", { dataset: { id: "mixed-session" } });
  await app.action("security-trace-tab", { dataset: { tab: "request" } });
  let html = app.read("renderTraceInspector()");
  for (const label of ["系统提示词", "开发者指令", "用户输入", "历史模型消息", "历史工具调用", "工具结果", "推理 / 压缩上下文", "可用工具定义"]) assert.match(html, new RegExp(label));
  assert.match(html, /First question/);
  assert.match(html, /Follow up/);
  assert.match(html, /对应第 5 项 · 客户端报告的结果/);
  assert.match(html, /仅保留加密或不透明内容/);
  assert.match(html, /图片 · 非文本内容见完整结构或原文/);
  assert.doesNotMatch(html, /本轮模型输出|工具调用提议/);
  assert.match(html, /System &lt;script&gt;literal/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(app.requests.some(request => request.url.includes("/body?")), false);
  await app.action("security-content-source", { dataset: { index: "7" } });
  assert.equal(app.read("state.trace.tab"), "body");
  assert.equal(app.read("state.security.bodySelection.navigation.start"), 200);
  assert.equal(app.read("state.security.bodySelection.start"), undefined);
  assert.equal(app.read("state.security.bodySelection.end"), undefined);
  await app.action("security-trace-tab", { dataset: { tab: "request" } });
  await app.action("security-content-page", { dataset: { offset: "40" } });
  html = app.read("renderTraceInspector()");
  assert.match(html, /Later message/);
  assert.doesNotMatch(html, /First question/);
  assert.equal(app.read("state.security.detail.requestContent.offset"), 40);
});

test("Codex overview distinguishes missing, partial and empty request content", async () => {
  const app = await controller();
  for (const [state, text] of [["unavailable", "请求正文未保留"], ["partial", "请求正文存在缺口"], ["complete", "本次请求未包含提示词"]]) {
    app.read(`state.security.detail = { requestContent: { state: ${JSON.stringify(state)}, total: 0, offset: 0, counts: {}, items: [] } }`);
    await app.action("security-trace-tab", { dataset: { tab: "request" } });
    const html = app.read("renderTraceInspector()");
    assert.match(html, new RegExp(text));
    assert.doesNotMatch(html, /最近用户输入/);
  }
});

test("source navigation anchors the exact UTF-8 position without selecting a risk range", async () => {
  const app = await controller();
  const text = "前置🙂\n".repeat(4000) + "TARGET <script>literal</script> 敏感值";
  const start = 65536;
  const position = start + Buffer.byteLength(text.slice(0, text.indexOf("TARGET")));
  const sensitive = start + Buffer.byteLength(text.slice(0, text.indexOf("敏感值")));
  const page = { chunks: [{ start, end: start + Buffer.byteLength(text), content: text, sensitiveRanges: [{ start: sensitive, end: sensitive + Buffer.byteLength("敏感值") }] }] };
  let html = app.read(`securityPageText(${JSON.stringify(page)}, { navigation: { start: ${position} } })`);
  assert.match(html, /<span data-security-body-anchor tabindex="-1">T<\/span>ARGET/);
  assert.doesNotMatch(html, /security-body-hit/);
  assert.match(html, /<mark class="security-sensitive-hit">敏感值<\/mark>/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(html.replace(/<[^>]*>/g, ""), app.read(`esc(${JSON.stringify(text)})`), "anchor preserves all original text");
  const emoji = start + Buffer.byteLength(text.slice(0, text.indexOf("🙂")));
  html = app.read(`securityPageText(${JSON.stringify(page)}, { navigation: { start: ${emoji} } })`);
  assert.match(html, /<span data-security-body-anchor tabindex="-1">🙂<\/span>/);
  assert.doesNotMatch(html, /�|security-body-hit/);
  html = app.read(`securityPageText(${JSON.stringify(page)}, { navigation: { start: ${page.chunks[0].end} } })`);
  assert.doesNotMatch(html, /data-security-body-anchor|security-body-hit/);
});

test("request risks stay highlighted and navigate across content pages without opening original content", async () => {
  const hit = 'rm -rf 秘密🙂 <script>literal</script>';
  const finding = { id: "delete", ruleId: "SEC-DELETE-001", evidenceStage: "tool_call_replayed", evidence: { bodyRef: { snapshotId: "evidence/delete", sourceSnapshotId: "request", sourceStart: 900, sourceEnd: 1000, start: 0, end: Buffer.byteLength(JSON.stringify({ cmd: hit })) } } };
  const item = { index: 44, kind: "tool_call", start: 880, end: 1020, preview: JSON.stringify({ cmd: hit }) };
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/content?")) {
      const offset = Number(new URL(url, "http://test").searchParams.get("offset"));
      return { body: { offset, total: 45, nextOffset: offset === 0 ? 40 : null, counts: {}, state: "complete", items: offset === 0 ? [{ index: 0, start: 0, end: 100, preview: "safe" }] : [item] } };
    }
    if (url.includes("/body?")) return { body: { chunks: [{ start: 0, end: finding.evidence.bodyRef.end, content: JSON.stringify({ cmd: hit }) }] } };
  } });
  app.read(`state.page = "security-session"; state.security.detail = ${JSON.stringify({ id: "risk", findings: [finding], requestContent: { offset: 40, total: 45, counts: {}, state: "complete", items: [item] } })}`);
  await app.action("security-trace-tab", { dataset: { tab: "request" } });
  let html = app.read("renderTraceInspector()");
  assert.match(html, /security-risk-hit/);
  assert.doesNotMatch(html, /security-body-hit|<script>/);
  app.read('state.security.detail.requestContent = { offset: 0, items: [] }');
  await app.action("security-finding", { dataset: { id: "delete" } });
  assert.equal(app.read("state.trace.tab"), "request");
  assert.equal(app.read("state.security.detail.requestContent.offset"), 40);
  assert.equal(app.read("state.security.contentNavigation.index"), 44);
  html = app.read("renderTraceInspector()");
  assert.match(html, /data-security-content-anchor/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(app.requests.filter(r => r.url.includes("/body?")).length, 1, "evidence is reused across pages and navigation");
  assert.equal(app.requests.some(r => r.url.includes("snapshot=request")), false);
  await app.action("security-trace-tab", { dataset: { tab: "request" } });
  assert.match(app.read("renderTraceInspector()"), /security-risk-hit/);
  assert.doesNotMatch(app.read("renderTraceInspector()"), /security-body-hit/);
});

test("stream response risks map to retained output and stale navigation cannot replace a newer request", async () => {
  let release;
  const secret = '秘密🙂&"key';
  const escaped = JSON.stringify(secret).slice(1, -1);
  const finding = { id: "secret", ruleId: "SEC-SECRET-001", evidenceStage: "response_content", evidence: { bodyRef: { snapshotId: "evidence/stream", sourceSnapshotId: "stream/one", start: 500, end: 500 + Buffer.byteLength(escaped), matchKind: "sensitive" } } };
  const record = { id: "response-risk", findings: [finding], responseContent: { state: "complete", offset: 0, total: 1, counts: {}, items: [{ index: 0, kind: "assistant", start: 0, end: 100, contentSnapshotIds: ["stream/one"], preview: `before ${secret} after` }] } };
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/body?")) return new Promise(resolve => { release = () => resolve({ body: { chunks: [{ start: 500, end: finding.evidence.bodyRef.end, content: escaped }] } }); });
  } });
  app.read(`state.page = "security-session"; state.security.detail = ${JSON.stringify(record)}`);
  let pending = app.action("security-finding", { dataset: { id: "secret" } });
  await setImmediate();
  release(); await pending;
  assert.equal(app.read("state.trace.tab"), "response");
  assert.match(app.read("renderTraceInspector()"), /data-security-content-anchor/);
  assert.equal(app.read("state.security.contentNavigation.index"), 0);
  app.read(`state.security.detail = ${JSON.stringify(record)}; state.security.detailSequence++`);
  pending = app.action("security-finding", { dataset: { id: "secret" } });
  await setImmediate();
  app.read('state.security.detail = { id: "newer", responseContent: { items: [] } }; state.security.detailSequence++; state.security.contentNavigation = null');
  release(); await pending;
  assert.equal(app.read("state.security.detail.id"), "newer");
  assert.equal(app.read("state.security.contentNavigation"), null);
});

test("all original risk ranges remain highlighted during ordinary and source navigation", async () => {
  const app = await controller();
  const content = '普通🙂 first and second <script>literal</script>';
  const start = Buffer.byteLength('普通🙂 '), second = Buffer.byteLength('普通🙂 first and ');
  const record = { findings: [
    { ruleId: "SEC-INJECT-001", evidence: { bodyRef: { snapshotId: "request", start, end: start + 5 } } },
    { ruleId: "SEC-DELETE-001", evidence: { bodyRef: { snapshotId: "evidence/one", sourceSnapshotId: "request", sourceStart: second, sourceEnd: second + 6 } } },
  ] };
  for (const selection of [{}, { navigation: { start: 0 } }]) {
    const html = app.read(`securityPageText(${JSON.stringify({ chunks: [{ start: 0, content }] })}, ${JSON.stringify(selection)}, securityRiskSelections(${JSON.stringify(record)}, "request"))`);
    assert.equal((html.match(/security-risk-hit/g) || []).length, 2);
    assert.match(html, /security-risk-hit">first<\/mark>/);
    assert.match(html, /security-risk-hit">second<\/mark>/);
    assert.doesNotMatch(html, /security-body-hit|<script>|�/);
    assert.equal(html.replace(/<[^>]*>/g, ""), app.read(`esc(${JSON.stringify(content)})`));
  }
});

test("changed streamed content keeps the detected risk version highlighted in response content", async () => {
  const old = '{"cmd":"rm -rf /important","path":"/workspace"}';
  const finding = { id: "old-delete", ruleId: "SEC-DELETE-001", evidenceStage: "tool_call_proposed", evidence: { bodyRef: { snapshotId: "evidence/old", sourceSnapshotId: "stream/old", start: 0, end: Buffer.byteLength(old) } } };
  const record = { id: "changed", findings: [finding], bodySnapshots: [{ id: "stream/old", state: "complete" }], responseContent: { offset: 0, total: 1, counts: {}, state: "complete", items: [{ index: 0, kind: "tool_call", preview: '{"cmd":"ls","path":"/workspace"}', contentSnapshotIds: ["stream/old"] }] } };
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/body?")) return { body: { chunks: [{ start: 0, end: Buffer.byteLength(old), content: old }] } };
  } });
  app.read(`state.page = "security-session"; state.security.detail = ${JSON.stringify(record)}`);
  await app.action("security-trace-tab", { dataset: { tab: "response" } });
  assert.match(app.read("renderTraceInspector()"), /风险检测时的内容/);
  assert.match(app.read("renderTraceInspector()"), /security-risk-hit/);
  assert.doesNotMatch(app.read("renderTraceInspector()"), /security-body-hit/);
  await app.action("security-finding", { dataset: { id: "old-delete" } });
  assert.equal(app.read("state.trace.tab"), "response");
  assert.match(app.read("renderTraceInspector()"), /data-security-content-anchor/);
  assert.match(app.read("renderTraceInspector()"), /rm -rf \/important/);
  assert.equal(app.read("state.security.detail.responseContent.items[0].preview"), '{"cmd":"ls","path":"/workspace"}');
  assert.equal(app.read("state.security.detail.responseContent.items[0].riskRanges.preview.length"), 0, "unchanged auxiliary fields do not stand in for the old command");
  assert.match(app.read("renderTraceInspector()"), /检测时的工具参数与当前参数不同/);
  assert.match(app.read("renderTraceInspector()"), /不表示最终参数仍有风险/);
});

test("complete tool evidence stays highlighted while incomplete calls retain explicit status", async () => {
  const app = await controller();
  const evidence = '{"cmd":"rm -rf /important","path":"/workspace"}';
  const text = JSON.stringify(JSON.parse(evidence), null, 2);
  const ranges = app.read(`contentRiskRanges(${JSON.stringify(text)}, ${JSON.stringify(evidence)}, "delete", true)`);
  assert.equal(ranges.length, 1, "complete inspected arguments match formatted output");
  assert.equal(text.slice(ranges[0].start, ranges[0].end), text);
  const record = { responseContent: { offset: 0, total: 1, counts: {}, state: "partial", items: [{ index: 0, kind: "tool_call", state: "partial", preview: evidence }] } };
  assert.match(app.read(`renderResponseContent(${JSON.stringify(record)})`), /调用未完成.*实际执行状态未知/);
});

for (const response of [false, true]) for (const lateFailure of [false, true]) {
  test(`${response ? "response" : "request"} risk navigation invalidates a late ordinary page ${lateFailure ? "failure" : "result"}`, async () => {
    let release;
    const key = response ? "responseContent" : "requestContent", endpoint = response ? "/response-content?" : "/content?";
    const hit = "risk text🙂";
    const finding = { id: "risk", ruleId: "SEC-INJECT-001", evidenceStage: response ? "response_content" : "request_content", evidence: { bodyRef: { snapshotId: response ? "response" : "request", start: 800, end: 800 + Buffer.byteLength(hit) } } };
    const page = offset => ({ offset, nextOffset: offset < 80 ? offset + 40 : null, total: 81, counts: {}, state: "complete", items: [{ index: offset, kind: "user", start: offset * 10, end: offset * 10 + 100, preview: offset === 80 ? hit : "safe" }] });
    let firstPage = true;
    const app = await controller(undefined, { onSecurity(url) {
      if (url.includes(endpoint)) {
        const offset = Number(new URL(url, "http://test").searchParams.get("offset"));
        if (offset === 40 && firstPage) {
          firstPage = false;
          return new Promise(resolve => { release = () => resolve(lateFailure ? { status: 503, body: { error: { message: "old page failed" } } } : { body: page(40) }); });
        }
        return { body: page(offset) };
      }
      if (url.includes("/body?")) return { body: { chunks: [{ start: 800, end: finding.evidence.bodyRef.end, content: hit }] } };
    } });
    app.read(`state.page = "security-session"; state.trace.tab = "${response ? "response" : "request"}"; state.security.detail = ${JSON.stringify({ id: "paging", findings: [finding], [key]: page(0) })}`);
    const pending = app.action(response ? "security-response-content-page" : "security-content-page", { dataset: { offset: "40" } });
    await setImmediate();
    await app.action("security-finding", { dataset: { id: "risk" } });
    const located = app.read(`state.security.detail.${key}`);
    assert.equal(located.offset, 80);
    assert.equal(app.read("state.security.contentNavigation.index"), 80);
    release(); await pending;
    assert.equal(app.read(`state.security.detail.${key}`), located);
    assert.equal(app.read(`state.security.${response ? "responseContentError" : "contentError"}`), null);
    assert.equal(app.read(`state.security.${response ? "responseContentLoading" : "contentLoading"}`), false);
    assert.match(app.read("renderTraceInspector()"), /data-security-content-anchor/);
  });
}

test("legacy source navigation uses structural positions without adding risk highlighting", async () => {
  const app = await controller();
  const body = { input: [{ role: "user", content: "long preceding content ".repeat(1000) }, { role: "user", content: "TARGET <script>literal</script>" }] };
  const page = { legacySnapshot: { body, root: "request" } };
  const html = app.read(`securityPageText(${JSON.stringify(page)}, { navigation: { start: 1, location: "request/field/0/1" } })`);
  assert.match(html, /<span data-security-body-anchor tabindex="-1">\{<\/span>\n\s+&quot;role&quot;:/);
  assert.match(html, /TARGET &lt;script&gt;literal/);
  assert.doesNotMatch(html, /security-body-hit|<script>/);
  assert.equal(html.replace(/<[^>]*>/g, ""), app.read(`esc(securityBodyText(${JSON.stringify(body)}, "request").text)`));
});

test("source navigation scrolls after loading and cannot scroll a newer request", async () => {
  let release, fail = false, scrolled = 0, focused = 0;
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/body?")) {
      if (fail) return { status: 503, body: { error: { message: "body unavailable" } } };
      return new Promise(resolve => { release = () => resolve({ body: { chunks: [{ start: 0, end: 100, content: "retained source" }] } }); });
    }
  } });
  app.node("#page-content").querySelector = selector => selector === "[data-security-body-anchor]" ? {
    scrollIntoView() { scrolled++; }, focus() { focused++; },
  } : null;
  const record = { id: "source", bodySnapshots: [{ id: "request", state: "complete" }], requestContent: { items: [{ index: 1, start: 80, end: 100, location: "request/field/0/1" }] } };
  app.read(`state.page = "security-session"; state.security.detail = ${JSON.stringify(record)}`);
  app.read('state.security.bodySelection = { snapshotId: "request", start: 0, end: 10, findingId: "previous-risk" }');
  let pending = app.action("security-content-source", { dataset: { index: "1" } });
  await setImmediate();
  assert.equal(scrolled, 0, "do not scroll before the body is loaded");
  assert.equal(app.read("state.security.bodySelection.findingId"), undefined);
  assert.equal(app.read("state.security.bodySelection.start"), undefined);
  release(); await pending;
  assert.equal(scrolled, 1);
  assert.equal(focused, 1);
  pending = app.action("security-content-source", { dataset: { index: "1" } });
  await setImmediate();
  app.read('state.security.detail = { id: "newer", bodySnapshots: [] }');
  release(); await pending;
  assert.equal(scrolled, 1, "stale body completion must not scroll a newer request");
  app.read(`state.security.detail = ${JSON.stringify(record)}`);
  fail = true;
  await app.action("security-content-source", { dataset: { index: "1" } });
  assert.equal(scrolled, 1, "failed loads must not scroll");
});

test("Claude overview separates mixed tool results from user blocks and exposes roles, errors and cache metadata", async () => {
  const items = [
    { index: 0, kind: "system", type: "text", preview: "System prompt", cacheControl: '{"type":"ephemeral","ttl":"1h"}' },
    { index: 1, kind: "reasoning", type: "thinking", messageIndex: "1", role: "assistant", preview: "Inspect source" },
    { index: 2, kind: "reasoning", type: "redacted_thinking", messageIndex: "1", role: "assistant", preview: "", opaque: true },
    { index: 3, kind: "tool_call", type: "tool_use", name: "Read", messageIndex: "1", role: "assistant", callId: "read", relatedIndex: 4, preview: '{"path":"src/main.rs"}' },
    { index: 4, kind: "tool_result", type: "tool_result", name: "Read", messageIndex: "2", role: "user", callId: "read", relatedIndex: 3, isError: false, preview: "File content", parts: ["image", "document", "tool_reference"], start: 200, end: 350 },
    { index: 5, kind: "tool_result", type: "tool_result", messageIndex: "2", role: "user", callId: "missing", isError: true, ambiguousRelation: true, preview: "Read failed" },
    { index: 6, kind: "user", type: "text", messageIndex: "2", role: "user", preview: "Continue <script>literal</script>" },
    { index: 7, kind: "tool_result", type: "web_search_tool_result", messageIndex: "1", role: "assistant", name: "web_search", serverTool: true, relatedIndex: 8, preview: "Search result" },
    { index: 8, kind: "tool_call", type: "server_tool_use", messageIndex: "1", role: "assistant", name: "web_search", serverTool: true, relatedIndex: 7, preview: '{"query":"docs"}' },
    { index: 9, kind: "reference", type: "tool_reference", name: "Edit", preview: "" },
    { index: 10, kind: "tool_definition", name: "Read", preview: "Available tool" },
    { index: 11, kind: "user", type: "document", messageIndex: "2", role: "user", preview: "", parts: ["document"] },
  ];
  const record = { id: "claude-blocks", protocol: "anthropic.messages", kind: "request", findings: [], bodySnapshots: [{ id: "request", state: "complete", contentMode: "original" }], requestContent: { state: "complete", total: 12, offset: 0, nextOffset: null, counts: { system: 1, reasoning: 2, user: 2, tool_call: 2, tool_result: 3, reference: 1, tool_definition: 1 }, items } };
  const app = await controller(claudeConfigFixture(), { onSecurity(url) {
    if (url.includes("/body?")) return { body: { chunks: [{ start: 0, end: 400, content: "retained source" }] } };
    if (url.includes("/audit?")) return { body: { items: [record], total: 1 } };
    if (url.includes("/audit/")) return { body: { record: clone(record) } };
    if (url.includes("/sessions?")) return { body: { items: [{ id: "claude-session", kind: "request", requestCount: 1 }], total: 1 } };
  } });
  await app.action("security-session", { dataset: { id: "claude-session" } });
  await app.action("security-trace-tab", { dataset: { tab: "request" } });
  const html = app.read("renderTraceInspector()");
  assert.match(html, /按消息内容块展示/);
  assert.match(html, /用户输入 <strong>2<\/strong>/);
  assert.match(html, /工具结果 <strong>3<\/strong>/);
  assert.match(html, /第 3 条消息 · user · tool_result/);
  assert.match(html, /第 2 条消息 · assistant · thinking/);
  assert.match(html, /对应第 4 项 · 客户端报告的结果/);
  assert.match(html, /客户端报告工具错误/);
  assert.match(html, /客户端未标记工具错误/);
  assert.match(html, /本次请求未找到对应调用，标识重复，关联存在歧义/);
  assert.match(html, /服务端工具结果/);
  assert.match(html, /缓存控制：.*ephemeral.*1h/);
  assert.match(html, /图片 · 文档 · 工具引用/);
  assert.match(html, /工具引用指向可用工具，不表示已经调用/);
  assert.match(html, /仅保留加密或不透明内容，没有可读文本/);
  assert.match(html, /Continue &lt;script&gt;literal/);
  assert.match(html, /data-content-index="6" open/);
  assert.match(html, /data-content-index="11" open/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(app.requests.some(request => request.url.includes("/body?")), false);
  await app.action("security-content-source", { dataset: { index: "4" } });
  assert.equal(app.read("state.trace.tab"), "body");
  assert.equal(app.read("state.security.bodySelection.navigation.start"), 200);
  assert.equal(app.read("state.security.bodySelection.start"), undefined);
  assert.equal(app.read("state.security.bodySelection.end"), undefined);
});

test("request items display complete long content with the source action in the title", async () => {
  const app = await controller();
  const text = "完整文本 汉🙂\n".repeat(3000) + "END <script>literal</script>";
  const structure = JSON.stringify({ type: "thinking", thinking: text, signature: "signature-tail" });
  app.read(`state.security.detail = ${JSON.stringify({ protocol: "anthropic.messages", requestContent: { state: "complete", total: 2, offset: 0, nextOffset: null, counts: { system: 1, reasoning: 1 }, items: [
    { index: 0, kind: "system", preview: text, truncated: true },
    { index: 1, kind: "reasoning", preview: text, structure },
  ] } })}`);
  await app.action("security-trace-tab", { dataset: { tab: "request" } });
  const html = app.read("renderTraceInspector()");
  assert.ok(html.includes(`<pre>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;")}</pre>`));
  assert.match(html, /完整内容结构/);
  assert.match(html, /signature-tail/);
  assert.match(html, /<summary><span class="trace-content-title">[\s\S]*?data-action="security-content-source" data-index="0">查看此项原文<\/button><\/summary>/);
  assert.doesNotMatch(html, /END &lt;script&gt;literal&lt;\/script&gt;…/);
  assert.doesNotMatch(html, /有限长度摘要|<script>/);
});

test("late session loads cannot overwrite another session or the list", async () => {
  let resolve;
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/audit?session=slow")) return new Promise(r => { resolve = r; });
    if (url.includes("/sessions?")) return { body: { items: [{ id: "fast", kind: "request" }], total: 1 } };
    if (url.includes("/audit?")) return { body: { items: [], total: 0 } };
  } });
  const slow = app.read('loadSecuritySession("slow")');
  await setImmediate();
  await app.read('loadSecuritySession("fast")');
  resolve({ body: { items: [{ id: "stale" }], total: 1 } });
  await slow;
  assert.equal(app.read("state.trace.id"), "fast");
  assert.equal(app.read("state.trace.result.total"), 0);
  await app.action("security-back", {});
  assert.equal(app.read("state.page"), "security");
});

test("scroll loading appends requests without replacing selection and refresh retains the loaded range", async () => {
  const records = Array.from({ length: 120 }, (_, i) => ({ id: `r${i}`, kind: "request", clientModelId: "gpt-5.5", requestPreview: `request ${i}`, findings: [], bodySnapshots: [] }));
  let fail = true, release;
  const app = await controller(undefined, { onSecurity(url) {
    const parsed = new URL(url, "http://test");
    if (url.includes("/sessions?")) return { body: { items: [{ id: "session", requestCount: 120 }], total: 1 } };
    if (url.includes("/audit?")) {
      const offset = Number(parsed.searchParams.get("cursor") || 0);
      if (offset === 50 && fail) return { status: 503, body: { error: { message: "暂时无法加载后续请求" } } };
      const result = { body: { items: records.slice(offset, offset + 50), total: 120, nextCursor: offset + 50 < 120 ? String(offset + 50) : null } };
      if (offset === 100 && !release) return new Promise(resolve => { release = () => resolve(result); });
      return result;
    }
    if (url.includes("/audit/")) return { body: { record: records.find(r => parsed.pathname.endsWith(`/${r.id}`)) } };
  } });
  await app.read('loadSecuritySession("session")');
  assert.equal(app.read("state.trace.result.items.length"), 50);
  assert.doesNotMatch(app.read("renderSecuritySession()"), /上一页请求|下一页请求|trace-pagination/);
  await app.action("security-trace-more", {});
  assert.match(app.read("renderSecuritySession()"), /重试加载/);
  assert.equal(app.read("state.trace.result.items.length"), 50);
  fail = false;
  await app.action("security-trace-more", {});
  assert.equal(app.read("state.trace.result.items.length"), 100);
  assert.equal(app.read("state.security.detail.id"), "r0");
  await app.action("security-trace-select", { dataset: { id: "r80" } });
  const pending = app.read("loadMoreSecurityTrace()");
  await setImmediate();
  await app.read("loadMoreSecurityTrace()");
  assert.equal(app.requests.filter(r => r.url.includes("cursor=100")).length, 1, "concurrent scrolls share one in-flight fetch");
  release(); await pending;
  assert.equal(app.read("state.trace.result.items.length"), 120);
  assert.equal(app.read("state.security.detail.id"), "r80");
  assert.match(app.read("renderSecuritySession()"), /已显示全部请求/);
  assert.ok(app.read("traceSegments(state.trace.result.items).length") <= 60);
  await app.action("security-session-refresh", {});
  assert.equal(app.read("state.trace.result.items.length"), 120);
  assert.equal(app.read("state.security.detail.id"), "r80");
});

test("pending scroll pages cannot append to a different session", async () => {
  let release;
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("cursor=")) return new Promise(resolve => { release = resolve; });
    if (url.includes("/audit?")) return { body: { items: [], total: 1, nextCursor: "1" } };
    if (url.includes("/sessions?")) return { body: { items: [], total: 0 } };
  } });
  await app.read('loadSecuritySession("first")');
  const pending = app.read("loadMoreSecurityTrace()"); await setImmediate();
  await app.read('loadSecuritySession("second")');
  release({ body: { items: [{ id: "stale" }], total: 1, nextCursor: null } });
  await pending;
  assert.equal(app.read("state.trace.result.items.length"), 0);
  assert.equal(app.read("state.trace.id"), "second");
});

test("session UUID redirects retain the selected request across refresh, old links and history", async () => {
  const records = Array.from({ length: 120 }, (_, i) => ({ id: `r${i}`, kind: "request", requestPreview: `request ${i}`, findings: [], bodySnapshots: [] }));
  let grouped = false;
  const onSecurity = url => {
    const parsed = new URL(url, "http://test");
    const sessionId = grouped ? "canonical" : "r80";
    if (url.includes("/sessions?")) return { body: { sessionId, items: [{ id: sessionId, requestCount: grouped ? 120 : 1 }], total: 1 } };
    if (url.includes("/audit?")) {
      const offset = Number(parsed.searchParams.get("cursor") || 0);
      return { body: { sessionId, items: grouped ? records.slice(offset, offset + 50) : [records[80]], total: grouped ? 120 : 1, nextCursor: grouped && offset + 50 < 120 ? String(offset + 50) : null } };
    }
    if (url.includes("/audit/")) return { body: { record: records.find(record => parsed.pathname.endsWith(`/${record.id}`)) } };
  };
  const app = await controller(undefined, { onSecurity });
  app.read('navigatePage("security")'); await setImmediate();
  app.read('window.scrollY = 400');
  await app.action("security-session", { dataset: { id: "r80" } });
  assert.equal(app.read("state.security.detailId"), "r80");
  grouped = true;
  await app.action("security-session-refresh", {});
  assert.equal(app.read("state.trace.id"), "canonical");
  assert.equal(app.read("window.location.hash"), "#security/session/canonical");
  assert.equal(app.read("window.history.state.sessionRequestId"), "r80");
  assert.equal(app.read("state.trace.result.items.length"), 100, "load enough canonical context to include the selected request");
  assert.equal(app.read("state.security.detailId"), "r80");
  await app.back();
  assert.equal(app.read("state.page"), "security", "redirect replaces history instead of adding a dead UUID entry");
  assert.equal(app.read("window.scrollY"), 400);
  await app.forward();
  assert.equal(app.read("state.security.detailId"), "r80");
  await app.read('restoreSecurityNavigation()');
  assert.equal(app.read("state.security.detailId"), "r80", "reload uses the request stored in this history entry");
  await app.action("security-trace-select", { dataset: { id: "r90" } });
  await app.back(); await app.forward();
  assert.equal(app.read("state.security.detailId"), "r90");
  const reopened = await controller(undefined, { url: "http://test/#security/session/r80", onSecurity });
  assert.equal(reopened.read("window.location.hash"), "#security/session/canonical");
  assert.equal(reopened.read("state.security.detailId"), "r80");
});

test("session redirect handles grouping that finishes between summary and request reads", async () => {
  let summaries = 0;
  const record = { id: "original", kind: "request", findings: [], bodySnapshots: [] };
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/sessions?")) {
      const sessionId = summaries++ ? "canonical" : "original";
      return { body: { sessionId, items: [{ id: sessionId }], total: 1 } };
    }
    if (url.includes("/audit?")) return { body: { sessionId: "canonical", items: [record], total: 1 } };
    if (url.endsWith("/audit/original")) return { body: { record } };
  } });
  await app.read('loadSecuritySession("original")');
  assert.equal(summaries, 2);
  assert.equal(app.read("state.trace.id"), "canonical");
  assert.equal(app.read("state.trace.summary.id"), "canonical");
  assert.equal(app.read("state.security.detailId"), "original");
  assert.equal(app.read("window.location.hash"), "#security/session/canonical");
});

test("failed refreshes retain the full previous view until a complete replacement succeeds", async () => {
  const records = Array.from({ length: 120 }, (_, i) => ({ id: `r${i}`, kind: "request", requestPreview: `request ${i}`, findings: [], bodySnapshots: [] }));
  let failAt = null;
  const app = await controller(undefined, { onSecurity(url) {
    const parsed = new URL(url, "http://test");
    const stage = url.includes("/sessions?") ? "summary" : url.includes("/audit?") ? (parsed.searchParams.has("cursor") ? "later-page" : "first-page") : "detail";
    if (stage === failAt) return { status: 503, body: { error: { message: "临时读取失败" } } };
    if (stage === "summary") return { body: { items: [{ id: "session", requestCount: 120 }], total: 1 } };
    if (stage.endsWith("page")) {
      const offset = Number(parsed.searchParams.get("cursor") || 0);
      return { body: { items: records.slice(offset, offset + 50), total: 120, nextCursor: offset + 50 < 120 ? String(offset + 50) : null } };
    }
    return { body: { record: records.find(record => parsed.pathname.endsWith(`/${record.id}`)) } };
  } });
  await app.read('loadSecuritySession("session")');
  await app.action("security-trace-more", {});
  await app.action("security-trace-select", { dataset: { id: "r80" } });
  await app.action("security-trace-tab", { dataset: { tab: "risks" } });
  for (const stage of ["summary", "first-page", "later-page", "detail"]) {
    const result = app.read("state.trace.result"), summary = app.read("state.trace.summary"), detail = app.read("state.security.detail");
    failAt = stage;
    await app.action("security-session-refresh", {});
    assert.equal(app.read("state.trace.result"), result, stage);
    assert.equal(app.read("state.trace.summary"), summary, stage);
    assert.equal(app.read("state.security.detail"), detail, stage);
    assert.equal(app.read("state.security.detailId"), "r80");
    assert.equal(app.read("state.trace.tab"), "risks");
    assert.match(app.read("renderSecuritySession()"), /临时读取失败/);
    failAt = null;
    await app.action("security-session-refresh", {});
    assert.equal(app.read("state.trace.result.items.length"), 100);
    assert.equal(app.read("state.security.detailId"), "r80");
    assert.equal(app.read("state.trace.error"), null);
  }
});

for (const scenario of ["selected", "pending", "reselected", "failed"]) {
  test(`late session refresh preserves newer request selection (${scenario})`, async () => {
    const records = ["a", "b"].map(id => ({ id, kind: "request", requestPreview: `request ${id}`, responsePreview: `output ${id}`, findings: [], bodySnapshots: [] }));
    let deferRefresh = false, releaseRefresh, releaseSelection;
    const app = await controller(undefined, { onSecurity(url) {
      if (url.includes("/sessions?")) return { body: { sessionId: "session", items: [{ id: "session", requestCount: 2 }], total: 1 } };
      if (url.includes("/audit?")) return { body: { sessionId: "session", items: records, total: 2 } };
      const record = records.find(item => url.endsWith(`/${item.id}`));
      if (record?.id === "a" && deferRefresh) {
        deferRefresh = false;
        return new Promise(resolve => { releaseRefresh = () => resolve(scenario === "failed"
          ? { status: 503, body: { error: { message: "旧请求刷新失败" } } }
          : { body: { record: { ...record, responsePreview: "stale refresh" } } }); });
      }
      if (record?.id === "b" && scenario === "pending" && !releaseSelection) return new Promise(resolve => { releaseSelection = () => resolve({ body: { record } }); });
      return { body: { record } };
    } });
    await app.read('loadSecuritySession("session")');
    deferRefresh = true;
    const refresh = app.action("security-session-refresh", {});
    await setImmediate();
    assert.equal(typeof releaseRefresh, "function");
    const selecting = app.action("security-trace-select", { dataset: { id: "b" } });
    if (scenario !== "pending") await selecting;
    if (scenario === "reselected") await app.action("security-trace-select", { dataset: { id: "a" } });
    const expectedId = scenario === "reselected" ? "a" : "b";
    const selectedDetail = app.read("state.security.detail");
    releaseRefresh(); await refresh;
    assert.equal(app.read("state.security.detailId"), expectedId);
    assert.equal(app.read("state.security.detail"), selectedDetail);
    assert.equal(app.read("window.history.state.sessionRequestId"), expectedId);
    assert.equal(app.read("state.trace.loading"), false);
    assert.equal(app.read("state.trace.error"), null);
    if (scenario === "pending") {
      assert.equal(app.read("state.security.detailLoading"), true);
      releaseSelection(); await selecting;
    }
    assert.equal(app.read("state.security.detail.responsePreview"), `output ${expectedId}`);
    await app.action("security-session-refresh", {});
    assert.equal(app.read("state.security.detailId"), expectedId, "a subsequent refresh still works for the new selection");
  });
}

test("response overview shows full content with independent pagination and response source navigation", async () => {
  const text = "完整模型输出🙂\n".repeat(10000) + "<script>literal</script>";
  const record = { id: "response", protocol: "anthropic.messages", bodySnapshots: [{ id: "response", state: "complete" }],
    requestContent: { state: "complete", total: 1, offset: 0, counts: { user: 1 }, items: [{ index: 0, kind: "user", preview: "Keep request page" }] },
    responseContent: { state: "complete", total: 42, offset: 0, nextOffset: 40, counts: { assistant: 40, tool_call: 1, reasoning: 1 }, items: [
      { index: 0, kind: "assistant", preview: text, snapshotId: "response", start: 200, end: 400, state: "complete" },
      { index: 1, kind: "tool_call", name: "Read", callId: "read-id", preview: '{"file_path":"src/lib.rs"}', state: "complete" },
      { index: 2, kind: "reasoning", preview: "Thinking", structure: '{"thinking":"Thinking","signature":"signature"}', state: "partial" },
    ] } };
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/response-content?")) return { body: { state: "complete", total: 42, offset: 40, nextOffset: null, counts: record.responseContent.counts, items: [{ index: 40, kind: "assistant", preview: "Next response page" }] } };
    if (url.includes("/body?")) return { body: { chunks: [{ start: 0, end: 400, content: "retained response" }] } };
  } });
  app.read(`state.page = "security-session"; state.security.detail = ${JSON.stringify(record)}`);
  const overview = app.read("renderTraceInspector()");
  assert.deepEqual([...overview.matchAll(/data-action="security-trace-tab" data-tab="([^"]+)" aria-pressed=/g)].map(match => match[1]), ["overview", "risks", "request", "response", "body"]);
  assert.doesNotMatch(overview, /trace-content-timeline|完整模型输出|Keep request page/);
  await app.action("security-trace-tab", { dataset: { tab: "response" } });
  let html = app.read("renderTraceInspector()");
  assert.match(html, /aria-label="响应内容"/);
  assert.ok(html.includes(app.read(`esc(${JSON.stringify(text)})`)));
  assert.match(html, /本轮工具调用/);
  assert.match(html, /实际执行状态未知/);
  assert.match(html, /此项尚未完整返回/);
  assert.doesNotMatch(html, /<script>|本次请求未包含对应结果/);
  await app.action("security-response-content-source", { dataset: { index: "0" } });
  assert.equal(app.read("state.security.bodySelection.snapshotId"), "response");
  assert.equal(app.read("state.security.bodySelection.navigation.start"), 200);
  assert.equal(app.read("state.security.bodySelection.start"), undefined);
  assert.ok(app.requests.some(r => r.url.includes("snapshot=response")));
  await app.action("security-trace-tab", { dataset: { tab: "response" } });
  await app.action("security-response-content-page", { dataset: { offset: "40" } });
  html = app.read("renderTraceInspector()");
  assert.match(html, /Next response page/);
  assert.doesNotMatch(html, /Keep request page/);
  await app.action("security-trace-tab", { dataset: { tab: "request" } });
  assert.match(app.read("renderTraceInspector()"), /Keep request page/);
  await app.action("security-trace-tab", { dataset: { tab: "response" } });
  assert.match(app.read("renderTraceInspector()"), /Next response page/);
  assert.equal(app.read("state.security.detail.requestContent.offset"), 0);
});

test("response overview distinguishes empty, unavailable and partial retained output", async () => {
  const app = await controller();
  for (const [state, text] of [["unavailable", "响应正文未保留"], ["partial", "响应正文存在缺口"], ["complete", "本次响应未包含输出内容"]]) {
    const html = app.read(`renderResponseContent({ responseContent: { state: ${JSON.stringify(state)}, total: 0, offset: 0, counts: {}, items: [] } })`);
    assert.match(html, new RegExp(text));
  }
});

test("late response pages and failures remain isolated from request pagination and newer selection", async () => {
  let release;
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("/response-content?")) return new Promise(resolve => { release = resolve; });
    if (url.includes("/content?")) return { body: { state: "complete", total: 41, offset: 40, counts: {}, items: [{ index: 40, kind: "user", preview: "New request page" }] } };
  } });
  const record = { id: "first", requestContent: { offset: 0, items: [] }, responseContent: { offset: 0, items: [] } };
  app.read(`state.page = "security-session"; state.security.detail = ${JSON.stringify(record)}`);
  const pending = app.action("security-response-content-page", { dataset: { offset: "40" } });
  await setImmediate();
  await app.action("security-content-page", { dataset: { offset: "40" } });
  assert.equal(app.read("state.security.detail.requestContent.offset"), 40);
  release({ status: 503, body: { error: { message: "Response busy" } } });
  await pending;
  assert.equal(app.read("state.security.responseContentError"), "Response busy");
  assert.equal(app.read("state.security.contentError"), null);
  const stale = app.action("security-response-content-page", { dataset: { offset: "40" } });
  await setImmediate();
  app.read('state.security.detailSequence++; state.security.detail = { id: "newer", responseContent: { offset: 0 } }; state.security.responseContentLoading = false; state.security.responseContentError = null');
  release({ body: { offset: 40, items: [] } });
  await stale;
  assert.equal(app.read("state.security.detail.responseContent.offset"), 0);
  assert.equal(app.read("state.security.responseContentError"), null);
});
