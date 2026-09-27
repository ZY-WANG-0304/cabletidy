import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";
import { normalizeConfig } from "./helpers/native.mjs";
import { publicCodexCatalog } from "./helpers/native.mjs";
import { validateConfig } from "./helpers/native.mjs";
import { buildTargetArtifacts } from "./helpers/native.mjs";
import { catalogFixture, codexConfigFixture } from "./helpers/codex-fixture.mjs";
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
    if (url.includes("/audit?")) return { body: { items: [{ id: "request-one", severity: "high", kind: "request", action: "model.request", findingCount: 6 }], total: 60, riskRecordCount: 10, findingCount: 60, counts: { high: 60 }, providers: ["retired_provider"], nextCursor: url.includes("cursor=") ? null : "12", storage: { state: "degraded", droppedWrites: 3 } } };
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
  assert.ok(app.requests.some(r => r.url === "/api/v1/security/audit?hours=168&severity=high&stage=tool_call_proposed"));
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
  assert.match(html, /审计日志/);
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
  assert.match(app.read("renderSecurityDetailPage()"), /审计存储暂不可用|返回审计日志/);
  await app.action("security-back", {});
  await app.action("refresh", {});
  const html = app.read("renderSecurity()");
  assert.match(html, /暂时无法读取记录/);
  assert.match(html, /最近成功读取/);
  assert.doesNotMatch(html, /当前筛选范围内没有审计记录|审计存储正常/);
  assert.equal(app.read("state.security.result"), null);
});

test("late security responses cannot replace a newer filter result", async () => {
  let release;
  const app = await controller(undefined, { onSecurity(url) {
    if (url.includes("hours=1&")) return new Promise(resolve => { release = resolve; });
    if (url.includes("/audit?")) return { body: { items: [], total: 2 } };
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
    if (url.includes("/audit?")) return { body: { items: [{ id: "request-one" }], total: 60, nextCursor: url.includes("cursor=") ? null : "page-two" } };
  } });
  app.read('navigatePage("security")'); await setImmediate();
  await app.submit(formNode("security-filter-form", { hours: "168", hasRisk: "true", category: "sensitive_data" }));
  await app.action("security-next", { dataset: {} });
  app.read('window.scrollTo({ top: 1380, left: 0 })');
  const listReads = app.requests.filter(r => r.url.includes("/audit?")).length;
  const checkList = () => {
    assert.equal(app.read("state.page"), "security");
    assert.equal(app.read("state.security.filters.category"), "sensitive_data");
    assert.equal(app.read("state.security.filters.hasRisk"), "true");
    assert.equal(app.read("state.security.cursor"), "page-two");
    assert.equal(app.read("state.security.history.length"), 1);
    assert.equal(app.read("window.scrollY"), 1380);
    assert.equal(app.requests.filter(r => r.url.includes("/audit?")).length, listReads, "return uses the retained list page");
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
  assert.match(app.node("#page-content").innerHTML, /返回审计日志/);
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
  assert.match(html, /检测时的流式内容快照/);
  assert.match(html, /<mark[^>]+>rm -rf \/<\/mark>/);
  assert.match(html, /查看完整正文上下文/);
  await app.action("refresh", {});
  assert.equal(app.read("state.security.bodySelection.snapshotId"), "evidence/one");
  await app.action("security-source", { dataset: { id: "request", offset: "0" } });
  await app.action("security-location", { dataset: { start: String(start), end: String(start + 10) } });
  assert.match(app.read("renderSecurityDetailPage()"), /<mark[^>]+>\[REDACTED\]<\/mark>/);
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
  const model = config.models[backend.models[0]];
  assert.equal(model.clientModelId, "claude-sonnet-4-6");
  assert.equal(model.capabilities, undefined);
  assert.equal(model.contextWindow, undefined);
  assert.ok(config.models.model);
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
  for (const section of ["models", "upstreams", "routes", "virtualProviders", "bindings"]) {
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
    assert.deepEqual(provider.allowedModels, []);
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
  await app.submit(formNode("suite-models-form", {}, [{ dataset: { modelId: "sonnet" }, querySelector: (selector) => selector in controls ? { value: controls[selector] } : null }]));
  const model = app.persisted().models.sonnet;
  assert.equal(model.upstreams.relay.upstreamModelId, "new-model");
  assert.equal(model.name, "claude-sonnet-4-6");
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
  const model = Object.values(config.models).find((model) => model.clientModelId === "custom-client-model");
  assert.deepEqual(Object.values(model.upstreams), [{}]);
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
  config.models.other = { ...structuredClone(config.models.sonnet), id: "other", clientModelId: "other-configuration-model" };
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
  await app.submit(formNode("suite-models-form", {}, [{ dataset: { modelId: "sonnet" }, querySelector: (selector) => selector in controls ? { value: controls[selector] } : null }]));
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
    await app.submit(formNode("suite-models-form", {}, [{ dataset: { modelId: "sonnet" }, querySelector: (selector) => selector in controls ? { value: controls[selector] } : null }]));
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
    config.models.sonnet.clientModelId = clientModelId;
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
  config.models.other = { ...structuredClone(config.models.sonnet), id: "other", clientModelId: "other-configuration-model" };
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
  assert.equal(Object.values(config.models)[0].clientModelId, "gpt-5.5");
  assert.equal(Object.values(Object.values(config.models)[0].upstreams)[0].upstreamModelId, "vendor-gpt");
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
  assert.deepEqual(config.virtualProviders.cabletidy_development.allowedModels, []);
  assert.equal(config.virtualProviders.cabletidy_development.defaultModel, undefined);
  assert.deepEqual(config.routes[config.virtualProviders.cabletidy_development.route].backends[0].models, []);
  assert.deepEqual(Object.keys(config.models), ["model"]);
  assert.equal(validateConfig(config).ok, true);
  assert.match(app.read("renderSuiteDetail()"), /模型名直接透传/);
  assert.doesNotMatch(app.read("renderSuiteDetail()"), /data-model-id="model"/);
  const commit = app.requests.find(({ url }) => url.endsWith("/config/commit"));
  assert.deepEqual(Object.values(commit.body.upstreamSecrets), ["test-key"]);
});

test("model settings can override context without a rename and can all be removed", async () => {
  const app = await controller();
  await app.submit(formNode("suite-models-form", {}, [{
    dataset: { modelId: "model" },
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
  assert.equal(config.models.model.contextWindow, 128000);
  assert.equal(config.models.model.codex.metadataMode, "override");
  assert.deepEqual(config.models.model.upstreams.relay, {});
  assert.equal(validateConfig(config).ok, true);
  await app.submit(formNode("suite-models-form"));
  config = app.persisted();
  assert.deepEqual(config.models, {});
  assert.deepEqual(config.virtualProviders.cabletidy_relay.allowedModels, []);
  assert.deepEqual(config.routes.route.backends[0].models, []);
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
  const model = Object.values(config.models)[0];
  assert.deepEqual(Object.values(model.upstreams), [{}]);
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
    for (const modelId of provider.allowedModels) {
      assert.deepEqual(Object.keys(config.models[modelId].upstreams), [upstreamId]);
    }
  }
  assert.equal(upstreamIds.size, 2);
  assert.equal(validateConfig(config).ok, true);
});

test("advanced model editor exposes one upstream and saves only its model mapping", async () => {
  const app = await controller();
  const models = app.read("renderModels()");
  assert.equal((models.match(/name="upstreamId"/g) || []).length, 1);
  await app.submit(formNode("model-form", {
    id: "model", clientModelId: "gpt-5.5", aliases: "gpt-5.5",
    upstreamId: "relay", upstreamModelId: "changed-model", capabilityOverrides: "-vision",
    capabilities: "streaming, tools, reasoning",
  }));
  const model = app.persisted().models.model;
  assert.deepEqual(Object.keys(model.upstreams), ["relay"]);
  assert.equal(model.upstreams.relay.upstreamModelId, "changed-model");
  assert.deepEqual(model.upstreams.relay.capabilityOverrides, ["-vision"]);
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
    const model = Object.values(app.persisted().models)[0];
    const upstreamId = Object.keys(model.upstreams)[0];
    assert.equal(model.clientModelId, id);
    assert.match(app.read('renderSuiteDetail()'), new RegExp(`value="${id}" selected`));
    await app.submit(formNode("suite-models-form", {}, [{
      dataset: { modelId: model.id },
      querySelector(selector) {
        if (selector === "[data-suite-model-client]") return { value: id };
        if (selector.startsWith("[data-suite-model-upstream=")) return { value: "updated-security" };
        if (selector === "[data-codex-metadata-mode]") return { value: "official" };
        return null;
      },
    }]));
    assert.equal(app.persisted().models[model.id].clientModelId, id);
    assert.equal(app.persisted().models[model.id].upstreams[upstreamId].upstreamModelId, "updated-security");
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
    dataset: { modelId: "model" },
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

function addFixtureModel(config, id = "second", clientModelId = "gpt-5.6-sol") {
  config.models[id] = { ...clone(config.models.model), id, clientModelId, aliases: [clientModelId] };
  config.virtualProviders.cabletidy_relay.allowedModels.push(id);
  config.routes.route.backends[0].models.push(id);
}

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
    for (const id of config.virtualProviders.cabletidy_relay.allowedModels) {
      const model = config.models[id];
      const metadata = metadataRow(model.codex?.metadataMode);
      const { row, select, context, vision } = metadata;
      row.dataset.modelId = id;
      select.value = model.clientModelId;
      context.value = String(model.contextWindow || 272000);
      vision.checked = model.codex?.inputModalities?.includes("image") ?? true;
      const mapping = inputNode("", model.upstreams.relay.upstreamModelId, {
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
  return { form: () => current, row: (id = "model") => current.rows.find(row => row.dataset.modelId === id) };
}

test("conflict refresh merges another window's added model before retrying a local mapping edit", async () => {
  const app = await controller();
  const editor = mountSuiteEditor(app);
  editor.row().mapping.value = "LOCAL-MAPPING";
  app.externalUpdate(config => addFixtureModel(config));
  await app.submit(editor.form());
  assert.match(editor.form().feedback.innerHTML, /其他窗口变更/);
  assert.equal(app.persisted().models.model.upstreams.relay.upstreamModelId, "VENDOR-GPT");
  await app.action("refresh");
  assert.deepEqual(editor.form().rows.map(row => row.dataset.modelId), ["model", "second"]);
  assert.equal(editor.row().mapping.value, "LOCAL-MAPPING");
  assert.equal(app.edited(editor.form()), true);
  await app.submit(editor.form());
  const saved = app.persisted();
  assert.deepEqual(Object.keys(saved.models), ["model", "second"]);
  assert.deepEqual(saved.routes.route.backends[0].models, ["model", "second"]);
  assert.deepEqual(saved.virtualProviders.cabletidy_relay.allowedModels, ["model", "second"]);
  assert.equal(saved.models.model.upstreams.relay.upstreamModelId, "LOCAL-MAPPING");
  assert.equal(validateConfig(saved).ok, true);
  assert.equal(app.edited(editor.form()), false);
});

test("refresh merges disjoint fields on the same model and does not keep stale server values", async () => {
  const config = normalizeConfig(codexConfigFixture());
  config.models.model.codex = { metadataMode: "override", inputModalities: ["text"] };
  config.models.model.contextWindow = 64000;
  const app = await controller(config);
  const editor = mountSuiteEditor(app);
  editor.row().mapping.value = "LOCAL-MAPPING";
  app.externalUpdate(config => { config.models.model.contextWindow = 128000; });
  await app.action("refresh");
  assert.equal(editor.row().mapping.value, "LOCAL-MAPPING");
  assert.equal(editor.row().context.value, "128000");
  await app.submit(editor.form());
  assert.equal(app.persisted().models.model.contextWindow, 128000);
  assert.equal(app.persisted().models.model.upstreams.relay.upstreamModelId, "LOCAL-MAPPING");
});

test("overlapping edits remain blocked across repeated refreshes until explicitly reloaded", async () => {
  const app = await controller();
  const editor = mountSuiteEditor(app);
  const local = editor.form();
  editor.row().mapping.value = "LOCAL-MAPPING";
  app.externalUpdate(config => { config.models.model.upstreams.relay.upstreamModelId = "REMOTE-MAPPING"; });
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
  const app = await controller(config);
  const editor = mountSuiteEditor(app);
  editor.row().remove();
  app.externalUpdate(config => addFixtureModel(config, "replacement", "gpt-5.5"));
  await app.action("refresh");
  assert.deepEqual(editor.form().rows.map(row => row.dataset.modelId), ["second", "replacement"]);
  await app.submit(editor.form());
  assert.deepEqual(Object.keys(app.persisted().models), ["second", "replacement"]);
  assert.deepEqual(app.persisted().virtualProviders.cabletidy_relay.allowedModels, ["second", "replacement"]);
});

for (const localDeletes of [true, false]) {
  test(`refresh blocks ${localDeletes ? "local removal versus remote edit" : "local edit versus remote removal"}`, async () => {
    const config = normalizeConfig(codexConfigFixture());
    addFixtureModel(config);
    const app = await controller(config);
    const editor = mountSuiteEditor(app);
    if (localDeletes) editor.row("second").remove();
    else editor.row("second").mapping.value = "LOCAL-MAPPING";
    app.externalUpdate(config => {
      if (localDeletes) config.models.second.upstreams.relay.upstreamModelId = "REMOTE-MAPPING";
      else {
        delete config.models.second;
        config.virtualProviders.cabletidy_relay.allowedModels = ["model"];
        config.routes.route.backends[0].models = ["model"];
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
  assert.deepEqual(editor.form().rows.map(row => row.dataset.modelId), ["model", "second", ""]);
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
      if (property === "model") config.models.model.clientModelId = "gpt-5.6-sol";
      else config.models.model.codex = { metadataMode: "override", inputModalities: ["text"] };
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
    delete config.models.second;
    config.virtualProviders.cabletidy_relay.allowedModels = ["model"];
    config.routes.route.backends[0].models = ["model"];
  });
  await app.action("refresh");
  assert.deepEqual(editor.form().rows.map(row => row.dataset.modelId), ["model"]);
  await app.submit(editor.form());
  assert.deepEqual(Object.keys(app.persisted().models), ["model"]);
  assert.equal(app.persisted().models.model.upstreams.relay.upstreamModelId, "LOCAL-MAPPING");
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
