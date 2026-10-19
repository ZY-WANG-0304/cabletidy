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
import { CLAUDE_MODEL_CATALOG } from "../web/claude-models.js";
import { publicConfig, applyConfigOperation, claudeModelChoices, configurationEndpoints, contentRiskRanges, evidenceNative } from "./helpers/native.mjs";

const source = (await fs.readFile(new URL("../web/app.js", import.meta.url), "utf8"))
  .replace(/^import .* from "\.\/claude-models\.js";\r?\n/gm, "");

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
  return formNode("cable-create-form", {
    cableName: "Development", target: "codex",
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
  const historyEntries = options.historyEntries || [{ url: location.href, state: null }];
  let historyIndex = historyEntries.length - 1;
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
    TextEncoder, TextDecoder, AbortController,
    navigator: { clipboard: { writeText: async value => { messages.push(value); } } },
    CLAUDE_MODEL_CATALOG, contentRiskRanges,
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
        const response = await securityFixture(url);
        return { ok: (response.status || 200) < 400, status: response.status || 200, json: async () => response.body };
      }
      if (url === "/api/v1/config/commit") {
        if (body.baseRevision !== persisted.revision) return {
          ok: false, status: 409, json: async () => ({ error: { message: "配置已在其他窗口变更" } }),
        };
        const override = await options.onCommit?.(body);
        if (override) return { ok: false, status: override.status, json: async () => override.body };
        let edit;
        try { edit = body.operation ? await applyConfigOperation(persisted, body.operation, options.catalog || catalogFixture()) : { config: body.config }; }
        catch (error) { return { ok: false, status: 422, json: async () => ({ error: { message: error.message } }) }; }
        persisted = normalizeConfig(edit.config);
        persisted.revision += 1;
        return { ok: true, json: async () => ({
          config: clone(persisted), revision: persisted.revision, selection: edit.selection, page: edit.page,
          runtime: { virtualProviders: configurationEndpoints(persisted), health: {} },
        }) };
      }
      if (url === "/api/v1/targets/apply" || url === "/api/v1/targets/restore") {
        const override = await options.onTarget?.(url, body);
        if (override) return { ok: (override.status || 200) < 400, status: override.status || 200, json: async () => override.body };
      }
      const responses = {
        "/api/v1/config": { config: clone(persisted) },
        "/api/v1/claude/models": claudeModelChoices(),
        "/api/v1/runtime": { virtualProviders: configurationEndpoints(persisted), health: {} },
        "/api/v1/events": { events: [] },
        "/api/v1/tests/upstream": { ok: true, message: "上游可连接", latencyMs: 1, secretConfigured: true },
        "/api/v1/codex/models": publicCodexCatalog(options.catalog || catalogFixture()),
        "/api/v1/codex/models?refresh=1": options.refreshCatalog || publicCodexCatalog(options.catalog || catalogFixture()),
        "/api/v1/targets/apply": { target: persisted.cables[body?.cableId]?.target },
        "/api/v1/targets/restore": { target: "claude-code", report: { mode: "restored" } },
        "/api/v1/config/preview-target-artifacts": { artifacts: { target: persisted.cables[body?.cableId]?.target } },
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
  const fixtureBodies = new Map();
  const rawSecurity = async url => await options.onSecurity?.(url) || { body: url.endsWith("/status")
    ? { mode: "record_only", storage: { state: "ready", retentionDays: 30 } }
    : { items: [], total: 0, riskRecordCount: 0, findingCount: 0, counts: {}, nextCursor: null, providers: [] } };
  async function retainedBodies(record, findings) {
    const bodies = {};
    for (const finding of findings) {
      const ref = finding.evidence?.bodyRef;
      if (!ref || bodies[ref.snapshotId]) continue;
      const pages = [];
      let offset = Math.max(0, (ref.start || 0) - 512);
      while (true) {
        const url = `/api/v1/security/audit/${encodeURIComponent(record.id)}/body?${new URLSearchParams({ snapshot: ref.snapshotId, offset })}`;
        const result = await rawSecurity(url);
        if ((result.status || 200) >= 400) throw new Error(result.body.error?.message || "evidence read failed");
        pages.push(result.body);
        if (result.body.nextOffset == null || result.body.nextOffset <= offset || result.body.nextOffset >= ref.end) break;
        offset = result.body.nextOffset;
      }
      bodies[ref.snapshotId] = pages;
    }
    return bodies;
  }
  async function projectContent(page, record, response) {
    if (!page?.items) return page;
    const findings = (record.findings || []).filter(finding => page.items.some(item => evidenceNative("evidence.associated", finding, item, response)));
    if (!findings.length) return evidenceNative("evidence.fixture", page, [], {}, response);
    const cacheKey = record.id;
    let bodies = fixtureBodies.get(cacheKey);
    const missing = findings.filter(f => !bodies?.[f.evidence.bodyRef.snapshotId]);
    if (missing.length) { bodies = { ...bodies, ...await retainedBodies(record, missing) }; fixtureBodies.set(cacheKey, bodies); }
    return evidenceNative("evidence.fixture", page, findings, bodies, response);
  }
  async function securityFixture(url) {
    const parsed = new URL(url, "http://test"), params = parsed.searchParams;
    const content = parsed.pathname.endsWith("/content") || parsed.pathname.endsWith("/response-content");
    const record = vm.runInContext("state.security.detail", context);
    if (content) {
      let offset = Number(params.get("offset") || 0);
      let result;
      while (true) {
        const query = new URL(url, "http://test"); query.searchParams.set("offset", offset); query.searchParams.delete("finding");
        result = await rawSecurity(query.pathname + query.search);
        if ((result.status || 200) >= 400) return result;
        result = { ...result, body: await projectContent(result.body, record || {}, parsed.pathname.endsWith("/response-content")) };
        if (!params.has("finding") || result.body.items?.some(item => item.findingIds?.includes(params.get("finding"))) || result.body.nextOffset == null || result.body.nextOffset <= offset) break;
        offset = result.body.nextOffset;
      }
      return result;
    }
    if (parsed.pathname.endsWith("/body")) {
      const query = new URL(url, "http://test"); query.searchParams.delete("finding");
      let result = await rawSecurity(query.pathname + query.search);
      if ((result.status || 200) >= 400) return result;
      const findings = record?.findings || [];
      let page = evidenceNative("evidence.body", result.body, findings, params.get("snapshot"));
      if (params.has("finding")) {
        const finding = findings.find(f => f.id === params.get("finding"));
        if (finding) {
          const bodies = await retainedBodies(record, [finding]);
          page = evidenceNative("evidence.fixture", page, findings, bodies, false, finding.id);
          const offset = Math.max(0, (page.findingSelection?.start || 0) - 512);
          query.searchParams.set("offset", offset);
          result = await rawSecurity(query.pathname + query.search);
          const selection = page.findingSelection;
          page = evidenceNative("evidence.body", result.body, findings, params.get("snapshot"));
          page.findingSelection = selection;
        }
      }
      return { ...result, body: page };
    }
    const result = await rawSecurity(url);
    if (result.body?.record) {
      result.body.record = evidenceNative("evidence.record", result.body.record);
      for (const [key, response] of [["requestContent", false], ["responseContent", true]]) {
        if (result.body.record[key]) result.body.record[key] = await projectContent(result.body.record[key], result.body.record, response);
      }
    }
    return result;
  }
  async function projectInjected() {
    const record = vm.runInContext("state.security.detail", context);
    if (!record) return;
    const normalized = evidenceNative("evidence.record", record);
    Object.assign(record, { findings: normalized.findings, bodySnapshots: normalized.bodySnapshots });
    for (const [key, response] of [["requestContent", false], ["responseContent", true]]) {
      if (record[key]) record[key] = await projectContent(record[key], record, response);
    }
  }
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
    read: (expression) => {
      if (expression.includes("state.security.detail =")) fixtureBodies.clear();
      return vm.runInContext(expression, context);
    },
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
      return (async () => {
        if (action === "security-trace-tab") await projectInjected();
        else if (action === "security-finding") {
          const record = vm.runInContext("state.security.detail", context);
          if (record) {
            const normalized = evidenceNative("evidence.record", record);
            Object.assign(record, { findings: normalized.findings, bodySnapshots: normalized.bodySnapshots });
          }
        }
        return vm.runInContext(`handleAction(${JSON.stringify(action)}, actionElement)`, context);
      })();
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

test("supplier token lengths convert decimal units exactly and reject rounding", async () => {
  const app = await controller();
  for (const [value,unit,tokens] of [
    ["", "M", null], ["128K", "tokens", 128000], ["1.5M", "K", 1500000],
    ["8.192", "K", 8192], ["0.000001", "M", 1], ["128001", "tokens", 128001],
    ["1.000001m", "tokens", 1000001], ["0.001K", "tokens", 1],
    ["9007199254740991", "tokens", Number.MAX_SAFE_INTEGER],
  ]) {
    const result = app.read(`parseTokenLength(${JSON.stringify(value)}, ${JSON.stringify(unit)})`);
    assert.equal(result.error, "");
    assert.equal(result.tokens, tokens);
  }
  for (const [value,unit] of [["0", "tokens"], ["-1", "K"], ["1.5", "tokens"], ["0.0001", "K"], ["0.0000001M", "tokens"], ["abc", "tokens"], ["9007199254740992", "tokens"]]) {
    assert.ok(app.read(`parseTokenLength(${JSON.stringify(value)}, ${JSON.stringify(unit)}).error`));
  }
  for (const tokens of [1, 999, 1000, 8192, 128001, 1000001, 123456789, Number.MAX_SAFE_INTEGER]) {
    assert.equal(app.read(`(() => { const display = tokenLengthDisplay(${tokens}); return parseTokenLength(display.value, display.unit).tokens; })()`), tokens);
  }
});

test("supplier length values and units merge together on refresh", async () => {
  const app = await controller();
  const field = (name,type,value) => [name,type,{},"",value];
  const length = (value,unit) => [field("contextWindow","text",value),field("contextWindow:unit","select-one",unit)];
  const base = length("128","K");
  const local = length("1.5","M");
  const remote = length("200","K");
  assert.equal(app.read(`mergeSupplierModelFields(${JSON.stringify(base)},${JSON.stringify(local)},${JSON.stringify(remote)})`),null);
  const equalRemote = length("1500000","tokens");
  assert.deepEqual(clone(app.read(`mergeSupplierModelFields(${JSON.stringify(base)},${JSON.stringify(local)},${JSON.stringify(equalRemote)})`)),local);
  const merged = app.read(`mergeSupplierModelFields(${JSON.stringify([...base,field("identity","text","old")])},${JSON.stringify([...local,field("identity","text","old")])},${JSON.stringify([...base,field("identity","text","new")])})`);
  assert.deepEqual(clone(merged),[field("identity","text","new"),...local]);
});

test("top-level settings save finite and independently unlimited audit limits", async () => {
  const app = await controller(undefined, { url: "http://test/#settings" });
  assert.equal(app.read("state.page"), "settings");
  assert.equal(app.node("#page-title").textContent, "设置");
  assert.match(app.node("#page-content").innerHTML, /settings-row/);
  assert.match(app.node("#page-content").innerHTML, /name="budgetMiB"[^>]*min="16"/);
  assert.match(app.node("#page-content").innerHTML, /name="budgetMiB"[^>]*value="5120"/);
  const cables = clone(app.persisted().cables);
  for (const [fields, expected] of [
    [{ retentionDays: "30", budgetMiB: "5120" }, { retentionDays: 30, budgetBytes: 5 * 1024 ** 3 }],
    [{ retentionDays: "7", budgetMiB: "64" }, { retentionDays: 7, budgetBytes: 64 * 1048576 }],
    [{ retentionUnlimited: "on", budgetMiB: "256" }, { retentionDays: null, budgetBytes: 256 * 1048576 }],
    [{ retentionDays: "90", storageUnlimited: "on" }, { retentionDays: 90, budgetBytes: null }],
    [{ retentionUnlimited: "on", storageUnlimited: "on" }, { retentionDays: null, budgetBytes: null }],
  ]) {
    await app.submit(formNode("audit-settings-form", fields));
    assert.deepEqual(app.persisted().audit, expected);
    assert.deepEqual(app.persisted().cables, cables);
    assert.equal(app.read("state.page"), "settings");
  }
  assert.equal(app.requests.filter(({ url }) => url === "/api/v1/config/commit").length, 5);
  app.read('navigatePage("overview")');
  await app.back();
  assert.equal(app.read("state.page"), "settings");
});

test("settings validation and revision conflicts preserve the draft without a partial save", async () => {
  const app = await controller();
  for (const fields of [
    { retentionDays: "0", budgetMiB: "128" }, { retentionDays: "1.5", budgetMiB: "128" },
    { retentionDays: "7", budgetMiB: "" }, { retentionDays: "7", budgetMiB: "15.9" },
  ]) {
    const form = formNode("audit-settings-form", fields);
    await app.submit(form);
    assert.ok(form.feedback);
    assert.equal(app.persisted().revision, 0);
  }
  assert.equal(app.requests.filter(({ url }) => url === "/api/v1/config/commit").length, 0);
  app.externalUpdate(config => { config.audit.retentionDays = 90; });
  const form = formNode("audit-settings-form", { retentionDays: "7", storageUnlimited: "on" });
  await app.submit(form);
  assert.match(form.feedback.innerHTML, /配置已在其他窗口变更/);
  assert.deepEqual(form.fields, { retentionDays: "7", storageUnlimited: "on" });
  assert.equal(app.persisted().audit.retentionDays, 90);
});

test("temporary directory form saves independently, restores the default and preserves conflicts", async () => {
  const app = await controller(undefined, { url: "http://test/#settings" });
  const audit = clone(app.persisted().audit);
  assert.match(app.node("#page-content").innerHTML, /id="temporary-settings-form"/);
  assert.match(app.node("#page-content").innerHTML, /保存后需重启 CableTidy 才会切换目录/);
  await app.submit(formNode("temporary-settings-form", { temporaryDirectory: " /data/cabletidy temporary " }));
  assert.equal(app.persisted().temporaryDirectory, "/data/cabletidy temporary");
  assert.deepEqual(app.persisted().audit, audit);
  assert.ok(app.messages.some(message => /重启 CableTidy 后生效/.test(message)));
  await app.submit(formNode("temporary-settings-form", { temporaryDirectory: "" }));
  assert.equal(app.persisted().temporaryDirectory, null);
  app.externalUpdate(config => { config.temporaryDirectory = "/other/temp"; });
  const form = formNode("temporary-settings-form", { temporaryDirectory: "/draft/temp" });
  await app.submit(form);
  assert.ok(form.feedback);
  assert.equal(form.fields.temporaryDirectory, "/draft/temp");
  assert.equal(app.persisted().temporaryDirectory, "/other/temp");
});

test("audit status displays unlimited retention and storage without default fallbacks", async () => {
  const app = await controller(undefined, { onSecurity(url) {
    if (url.endsWith("/status")) return { body: { storage: { state: "ready", retentionDays: null, budgetBytes: null } } };
    return { body: { items: [], total: 0, counts: {}, storage: { state: "ready", retentionDays: null, budgetBytes: null } } };
  } });
  app.read('navigatePage("security")');
  await setImmediate();
  assert.match(app.node("#page-content").innerHTML, /保存周期不设上限/);
  assert.match(app.node("#page-content").innerHTML, /存储不设上限/);
  assert.doesNotMatch(app.node("#page-content").innerHTML, /保留 30 天/);
});

function mountSettingsEditor(app) {
  const page = app.node("#page-content");
  let current;
  const makeForm = () => {
    const audit = app.read("state.config.audit");
    const inputs = [
      inputNode("retentionDays", String(audit.retentionDays ?? 30), { type: "number" }),
      inputNode("retentionUnlimited", "on", { type: "checkbox", checked: audit.retentionDays === null }),
      inputNode("budgetMiB", String(audit.budgetBytes === null ? 5120 : audit.budgetBytes / 1048576), { type: "number" }),
      inputNode("storageUnlimited", "on", { type: "checkbox", checked: audit.budgetBytes === null }),
    ];
    const form = formNode("audit-settings-form");
    const cleanup = { hidden: true };
    form.querySelector = selector => selector === "[data-form-feedback]" ? form.feedback
      : selector === "#audit-settings-cleanup" ? cleanup
      : inputs.find(input => selector === `[name="${input.name}"]`) || null;
    form.querySelectorAll = selector => selector === "input, select, textarea" ? inputs : [];
    form.replaceWith = replacement => { current = replacement; };
    Object.defineProperty(form, "fields", { get: () => Object.fromEntries(inputs
      .filter(input => !input.disabled && (input.type !== "checkbox" || input.checked))
      .map(input => [input.name, input.value])) });
    return form;
  };
  app.read('state.page = "settings"');
  Object.defineProperty(page, "innerHTML", { configurable: true, set: () => { current = makeForm(); } });
  page.querySelectorAll = selector => selector === "form" ? [current] : [];
  page.querySelector = selector => selector === "#audit-settings-form" ? current : null;
  app.read("render()");
  return { form: () => current, input: name => current.querySelector(`[name="${name}"]`) };
}

for (const [key, name] of [["retentionDays", "retentionDays"], ["budgetBytes", "budgetMiB"]]) {
  test(`${key} number and unlimited edits conflict as one setting and remain blocked until reloaded`, async () => {
    const app = await controller();
    const editor = mountSettingsEditor(app);
    const draftValue = key === "budgetBytes" ? "64" : "7";
    editor.input(name).value = draftValue;
    app.externalUpdate(config => { config.audit[key] = null; });
    const draft = editor.form();
    await app.submit(draft);
    assert.match(draft.feedback.innerHTML, /其他窗口变更/);
    const attempts = app.requests.filter(({ url }) => url.endsWith("/config/commit")).length;
    for (let i = 0; i < 2; i++) {
      await app.action("refresh");
      assert.equal(editor.form(), draft);
      assert.equal(editor.input(name).value, draftValue);
      assert.equal(editor.input(name).disabled, false);
      assert.match(draft.feedback.innerHTML, /冲突.*暂停保存/);
      await app.submit(draft);
      assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, attempts);
    }
    await app.action("reload-form", { closest: () => draft });
    assert.equal(editor.input(name).disabled, true);
    assert.equal(app.edited(editor.form()), false);
    assert.equal(app.persisted().audit[key], null);
  });
}

test("settings refresh merges independent limits including a remote unlimited edit", async () => {
  const app = await controller();
  const editor = mountSettingsEditor(app);
  editor.input("retentionDays").value = "7";
  app.externalUpdate(config => { config.audit.budgetBytes = null; });
  await app.action("refresh");
  assert.equal(editor.input("retentionDays").value, "7");
  assert.equal(editor.input("storageUnlimited").checked, true);
  assert.equal(editor.input("budgetMiB").disabled, true);
  assert.equal(editor.form().feedback, null);
  await app.submit(editor.form());
  assert.deepEqual(app.persisted().audit, { retentionDays: 7, budgetBytes: null });
});

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
  assert.equal(app.requests.filter(r => r.url.includes("/body?")).length, 2);
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
  const projection = evidenceNative("evidence.legacy", { "12": "second", "z": "first" }, "request", { request: ["z", "12"] });
  const range = projection.locations.find(range => range.path === "request/field/0");
  assert.equal(Buffer.from(projection.text).subarray(range.start, range.end).toString(), '"first"');
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
  form.fields.cableName = "";
  form.querySelectorAll = () => [{ querySelector: (selector) => ({ value: selector.includes("clientModelId") ? "claude-sonnet-4-6" : "vendor-sonnet" }) }];
  assert.match(app.read("renderCableCreate()"), /value="claude-code" selected/);
  assert.doesNotMatch(app.read("createModelRow()"), /data-official-model/);
  await app.submit(form);
  const config = app.persisted();
  const cable = config.cables["claude-code-example-invalid"];
  assert.equal(cable.target, "claude-code");
  assert.equal(cable.targetFormat, "claude.settings.json.v1");
  assert.equal(cable.defaultModel, undefined);
  const provider = config.virtualProviders[cable.virtualProvider];
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
  const html = app.read("renderCableDetail()");
  assert.match(html, /应用到 Claude Code/);
  assert.match(html, /撤销接入/);
  assert.doesNotMatch(html, /Compact strategy|850000|data-codex-metadata|open-advanced-models/);
  assert.equal(app.read("cableEndpoint(selectedCable())"), "http://127.0.0.1:43100/claude-code-example-invalid");
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
  const cable = config.cables.development;
  assert.equal(cable.defaultModel, "opus");
  assert.equal(config.virtualProviders[cable.virtualProvider].defaultModel, "opus");
  assert.deepEqual(cable.claude, {
    setModel: true,
    models: { opus: "custom-client", sonnet: "custom-client", fable: "custom-client", haiku: "custom-client", subagent: "haiku" },
  });
  assert.equal(app.read("claudeDefaultModel(selectedCable())"), "opus");
  assert.equal(validateConfig(config).ok, true);
  assert.equal(app.requests.some(({ url }) => url.endsWith("/targets/apply")), false);
  for (const section of ["upstreams", "routes", "virtualProviders", "cables"]) {
    for (const [id, value] of Object.entries(before[section])) assert.deepEqual(config[section][id], value);
  }
});

test("Claude creation allows empty optional sections and clears values outside the selectable candidates", async () => {
  for (const defaultModel of ["", "unregistered-startup"]) {
    const app = await controller();
    const form = formNode("cable-create-form", {
      ...creationForm().fields, target: "claude-code", defaultModel,
      opus: "", sonnet: "", fable: "", haiku: "", subagent: defaultModel ? "unregistered-worker" : " ",
    });
    await app.submit(form);
    const config = app.persisted();
    const cable = config.cables.development;
    const provider = config.virtualProviders[cable.virtualProvider];
    assert.deepEqual(provider.models, {});
    assert.equal(cable.defaultModel, undefined);
    assert.equal(provider.defaultModel, undefined);
    assert.deepEqual(cable.claude, {});
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
    assert.match(form.feedback.innerHTML, /当前线路中已保存的客户端模型 ID/);
    assert.deepEqual(app.persisted(), before);
    assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 1);
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
  await app.action("open-cable", { dataset: { id: "claude-main" } });
  await app.submit(formNode("claude-client-form", { defaultModel: "claude-sonnet-4-6", sonnet: "claude-sonnet-4-6", fable: "claude-sonnet-4-6", subagent: "sonnet", discoverModels: "on" }));
  const cable = app.persisted().cables["claude-main"];
  assert.equal(cable.defaultModel, "claude-sonnet-4-6");
  assert.deepEqual(cable.claude, { setModel: true, discoverModels: true, models: { sonnet: "claude-sonnet-4-6", fable: "claude-sonnet-4-6", subagent: "sonnet" } });
  assert.equal(app.requests.some(({ url }) => url.endsWith("/targets/apply")), false);
  await app.action("apply-target", {});
  assert.equal(app.requests.at(-1).url, "/api/v1/targets/apply");
  assert.equal(app.requests.at(-1).body.cableId, "claude-main");
  await app.action("restore-target", {});
  assert.equal(app.requests.at(-1).url, "/api/v1/targets/restore");
  await app.submit(formNode("claude-client-form", {}));
  assert.equal(app.persisted().cables["claude-main"].defaultModel, undefined);
  assert.deepEqual(app.persisted().cables["claude-main"].claude.models, {});
});

test("Claude details use the simple connectivity action without inference controls or parameters", async () => {
  const app = await controller(claudeConfigFixture());
  await app.action("open-cable", { dataset: { id: "claude-main" } });
  const html = app.read("renderCableDetail()");
  assert.match(html, /data-action="test-upstream" data-id="relay">测试连通性/);
  assert.doesNotMatch(html, /claude-probe-form|测试模型|测试推理|测试 SSE/);
  await app.action("test-upstream", { dataset: { id: "relay" } });
  const requests = app.requests.filter(({ url }) => url === "/api/v1/tests/upstream");
  assert.deepEqual(requests, [{ url: "/api/v1/tests/upstream", body: { id: "relay" } }]);
  assert.ok(app.messages.some((message) => message.includes("上游可连接")));
});

test("Claude upstream authentication can switch without replacing its saved credential", async () => {
  const app = await controller(claudeConfigFixture());
  await app.action("open-cable", { dataset: { id: "claude-main" } });
  await app.submit(formNode("cable-upstream-form", { id: "relay", name: "Relay", protocol: "anthropic.messages", baseUrl: "https://example.invalid/v1", authHeader: "authorization", secret: "" }));
  assert.deepEqual(app.persisted().upstreams.relay.auth, { header: "authorization", scheme: "Bearer" });
  assert.equal(app.persisted().upstreams.relay.secretRef, "secret://upstreams/relay");
  const commit = app.requests.find(({ url }) => url.endsWith("config/commit"));
  assert.equal(commit.body.operation.data.secret || "", "");
});

test("Claude mapping edits do not invent capability or compaction policies", async () => {
  const app = await controller(claudeConfigFixture());
  await app.action("open-cable", { dataset: { id: "claude-main" } });
  const controls = { "[data-cable-model-client]": "claude-sonnet-4-6", '[data-cable-model-upstream="relay"]': "new-model" };
  await app.submit(formNode("cable-models-form", {}, [{ dataset: { modelId: "claude-sonnet-4-6" }, querySelector: (selector) => selector in controls ? { value: controls[selector] } : null }]));
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
  assert.match(app.read("renderCableCreate()"), /datalist id="claude-model-suggestions"/);
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
  assert.match(app.read('claudeAliasSelect(selectedCable(), "fable")'), /value="custom-client-model"/);
  const html = app.read("renderCableDetail()");
  assert.doesNotMatch(html, /data-claude-model-name|data-claude-model-description|显示名称|模型列表显示/);
  await app.action("open-cable", { dataset: { id: "relay" } });
  const codexHtml = app.read("renderCableDetail()");
  assert.match(codexHtml, /data-official-model/);
  assert.doesNotMatch(codexHtml, /claude-model-suggestions|别名指向/);
});

test("Claude alias choices are scoped to saved client IDs and keep references through rename and removal", async () => {
  const config = claudeConfigFixture();
  config.virtualProviders.cabletidy_other = { ...clone(config.virtualProviders["cabletidy_claude-main"]), id: "cabletidy_other", models: { "other-configuration-model": {} } };
  const app = await controller(config);
  await app.action("open-cable", { dataset: { id: "claude-main" } });
  const choices = app.read('claudeAliasSelect(selectedCable(), "opus")');
  assert.match(choices, /由 Claude 默认决定/);
  assert.doesNotMatch(choices, /other-configuration-model|vendor-sonnet/);
  const invalid = formNode("claude-client-form", { opus: "not-configured" });
  await app.submit(invalid);
  assert.match(invalid.feedback.innerHTML, /已保存的客户端模型 ID/);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 1);
  await app.submit(formNode("claude-client-form", { opus: "claude-sonnet-4-6", sonnet: "claude-sonnet-4-6", fable: "claude-sonnet-4-6", haiku: "claude-sonnet-4-6" }));
  const controls = { "[data-cable-model-client]": "my-claude", '[data-cable-model-upstream="relay"]': "" };
  await app.submit(formNode("cable-models-form", {}, [{ dataset: { modelId: "claude-sonnet-4-6" }, querySelector: (selector) => selector in controls ? { value: controls[selector] } : null }]));
  assert.deepEqual(app.persisted().cables["claude-main"].claude.models, { opus: "my-claude", sonnet: "my-claude", fable: "my-claude", haiku: "my-claude" });
  assert.equal(validateConfig(app.persisted()).ok, true);
  await app.submit(formNode("cable-models-form"));
  assert.deepEqual(app.persisted().cables["claude-main"].claude.models, {});
  assert.equal(validateConfig(app.persisted()).ok, true);
});

test("Claude legacy alias values stay visible until the user chooses a registered model or the default", async () => {
  const config = claudeConfigFixture();
  config.cables["claude-main"].claude.models = { haiku: "legacy-unregistered-model" };
  const app = await controller(config);
  await app.action("open-cable", { dataset: { id: "claude-main" } });
  assert.match(app.read('claudeAliasSelect(selectedCable(), "haiku")'), /legacy-unregistered-model.*selected disabled/);
  const untouched = formNode("claude-client-form", {});
  await app.submit(untouched);
  assert.match(untouched.feedback.innerHTML, /未配置的模型/);
  assert.equal(app.persisted().cables["claude-main"].claude.models.haiku, "legacy-unregistered-model");
  await app.submit(formNode("claude-client-form", { haiku: "" }));
  assert.deepEqual(app.persisted().cables["claude-main"].claude.models, {});
});

test("Claude default client IDs follow mapping renames and removals in saved settings and artifacts", async () => {
  for (const useProviderDefault of [false, true]) {
    const config = claudeConfigFixture();
    config.virtualProviders["cabletidy_claude-main"].defaultModel = "claude-sonnet-4-6";
    if (!useProviderDefault) config.cables["claude-main"].defaultModel = "claude-sonnet-4-6";
    config.cables["claude-main"].claude = { discoverModels: true, models: { sonnet: "claude-sonnet-4-6", subagent: "claude-sonnet-4-6" } };
    const app = await controller(config);
    await app.action("open-cable", { dataset: { id: "claude-main" } });
    const controls = { "[data-cable-model-client]": "renamed-client", '[data-cable-model-upstream="relay"]': "vendor-sonnet" };
    await app.submit(formNode("cable-models-form", {}, [{ dataset: { modelId: "claude-sonnet-4-6" }, querySelector: (selector) => selector in controls ? { value: controls[selector] } : null }]));
    let saved = app.persisted();
    assert.equal(saved.cables["claude-main"].defaultModel, "renamed-client");
    assert.equal(saved.virtualProviders["cabletidy_claude-main"].defaultModel, "renamed-client");
    assert.deepEqual(saved.cables["claude-main"].claude, { setModel: true, discoverModels: true, models: { sonnet: "renamed-client", subagent: "renamed-client" } });
    let env = buildTargetArtifacts(saved, { cableId: "claude-main" }).environment.vars;
    assert.equal(env.ANTHROPIC_MODEL, "renamed-client");
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "renamed-client");
    assert.equal(app.read("claudeDefaultModel(selectedCable())"), "renamed-client");
    await app.submit(formNode("cable-models-form"));
    saved = app.persisted();
    assert.equal(saved.cables["claude-main"].defaultModel, undefined);
    assert.equal(saved.virtualProviders["cabletidy_claude-main"].defaultModel, undefined);
    assert.deepEqual(saved.cables["claude-main"].claude, { setModel: false, discoverModels: true, models: {} });
    assert.equal(app.read("claudeDefaultModel(selectedCable())"), "");
    env = buildTargetArtifacts(saved, { cableId: "claude-main" }).environment.vars;
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
    await app.action("open-cable", { dataset: { id: "claude-main" } });
    await app.submit(formNode("claude-client-form", { defaultModel: "sonnet", subagent: "sonnet", sonnet: clientModelId }));
    await app.submit(formNode("cable-models-form"));
    const saved = app.persisted();
    assert.equal(saved.cables["claude-main"].defaultModel, "sonnet");
    assert.equal(saved.virtualProviders["cabletidy_claude-main"].defaultModel, "sonnet");
    assert.deepEqual(saved.cables["claude-main"].claude.models, { subagent: "sonnet" });
    const env = buildTargetArtifacts(saved, { cableId: "claude-main" }).environment.vars;
    assert.equal(env.ANTHROPIC_MODEL, "sonnet");
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
  }
});

test("Claude default model selectors expose field-specific aliases and current client IDs only", async () => {
  const config = claudeConfigFixture();
  config.virtualProviders.cabletidy_other = { ...clone(config.virtualProviders["cabletidy_claude-main"]), id: "cabletidy_other", models: { "other-configuration-model": {} } };
  config.cables["claude-main"].defaultModel = "legacy-startup";
  config.cables["claude-main"].claude.models = { subagent: "legacy-subagent" };
  const app = await controller(config);
  await app.action("open-cable", { dataset: { id: "claude-main" } });
  const html = app.read("renderCableDetail()");
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
  assert.equal(app.persisted().cables["claude-main"].defaultModel, undefined);
  assert.deepEqual(app.persisted().cables["claude-main"].claude.models, {});
});

test("cable upstream edits preserve authentication and disabled state when an input shadows the form ID", async () => {
  const config = normalizeConfig(codexConfigFixture());
  config.upstreams.relay.auth = { header: "x-custom-key", prefix: "Token " };
  config.upstreams.relay.secretRef = "secret://upstreams/custom-relay";
  config.upstreams.relay.enabled = false;
  const app = await controller(config);
  const form = formNode("cable-upstream-form", {
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
  assert.equal(commits[0].body.operation.data.secret || "", "");
  assert.equal(app.read("state.busy"), false);
});

test("preview and apply follow the selected cable after creation, switching and cancellation", async () => {
  const app = await controller();
  await app.submit(creationForm());
  for (const id of ["development", "relay"]) {
    await app.action("open-cable", { dataset: { id } });
    await app.action("preview-artifacts", {});
    assert.equal(app.requests.at(-1).body.cableId, id);
    await app.action("apply-target", {});
    assert.equal(app.requests.at(-1).url, "/api/v1/targets/apply");
    assert.equal(app.requests.at(-1).body.cableId, id);
  }
  await app.action("create-cable", {});
  await app.action("back-overview", {});
  await app.action("open-cable", { dataset: { id: "development" } });
  await app.action("apply-target", {});
  assert.equal(app.requests.at(-1).body.cableId, "development");
});

for (const action of ["apply", "restore"]) {
  for (const accept of [false, true]) {
    test(`Claude ${action} conflict ${accept ? "continues after confirmation" : "keeps settings when cancelled"}`, async () => {
      const app = await controller(normalizeConfig(claudeConfigFixture()), {
        confirmLeave: accept,
        onTarget(url, body) {
          if (body.confirmationToken) return { body: { target: "claude-code", report: { mode: action === "restore" ? "restored" : "managed_proxy" } } };
          return { status: 409, body: { error: { code: "claude_settings_conflict", details: {
            settingsPath: "/client/settings.json", fields: ["env.ANTHROPIC_API_KEY", "env.ANTHROPIC_BASE_URL"], confirmationToken: "current-files",
          } } } };
        },
      });
      await app.action("open-cable", { dataset: { id: "claude-main" } });
      await app.action(`${action}-target`, {});
      const requests = app.requests.filter(({ url }) => url === `/api/v1/targets/${action}`);
      assert.equal(requests.length, accept ? 2 : 1);
      assert.deepEqual(requests[0].body, { cableId: "claude-main" });
      if (accept) assert.deepEqual(requests[1].body, { cableId: "claude-main", confirmationToken: "current-files" });
      assert.equal(app.confirmations.length, 1);
      assert.equal(app.confirmations[0], action === "restore"
        ? "检测到以下字段与 CableTidy 上次应用的记录不一致，可能被手工或其他工具修改：\n\n/client/settings.json\nenv.ANTHROPIC_API_KEY\nenv.ANTHROPIC_BASE_URL\n\n继续撤销将把接管字段恢复为首次接入 CableTidy 前的值，覆盖现有修改。写入前会自动备份。\n\n选择“确定”继续撤销，选择“取消”保留当前文件。"
        : "检测到以下字段与 CableTidy 上次应用的记录不一致，可能被手工或其他工具修改：\n\n/client/settings.json\nenv.ANTHROPIC_API_KEY\nenv.ANTHROPIC_BASE_URL\n\n继续应用将使用当前选择的配置覆盖现有修改，写入前会自动备份。\n\n选择“确定”继续应用，选择“取消”保留当前文件。");
      if (!accept) assert.equal(app.messages.some(message => /配置已应用|原接入配置已恢复/.test(message)), false);
      assert.equal(app.read("state.busy"), false);
    });
  }
}

test("Claude apply asks again when settings change during confirmation", async () => {
  let attempt = 0;
  const app = await controller(normalizeConfig(claudeConfigFixture()), {
    onTarget(url, body) {
      if (++attempt > 2) return { body: { target: "claude-code", report: { mode: "managed_proxy" } } };
      return { status: 409, body: { error: { code: "claude_settings_conflict", details: {
        settingsPath: "/client/settings.json", fields: ["env.ANTHROPIC_API_KEY"], confirmationToken: `files-${attempt}`,
      } } } };
    },
  });
  await app.action("open-cable", { dataset: { id: "claude-main" } });
  await app.action("apply-target", {});
  const requests = app.requests.filter(({ url }) => url.endsWith("/targets/apply"));
  assert.deepEqual(requests.map(({ body }) => body.confirmationToken), [undefined, "files-1", "files-2"]);
  assert.equal(app.confirmations.length, 2);
  assert.match(app.confirmations[1], /^确认期间配置再次发生变化，请重新确认。\n\n检测到以下字段/);
});

test("Claude apply failures other than conflicts do not offer to overwrite", async () => {
  const app = await controller(normalizeConfig(claudeConfigFixture()), {
    onTarget: () => ({ status: 422, body: { error: { code: "target_apply_failed", message: "Invalid Claude settings object" } } }),
  });
  await app.action("open-cable", { dataset: { id: "claude-main" } });
  await app.action("apply-target", { closest: () => null });
  assert.equal(app.confirmations.length, 0);
  assert.ok(app.messages.includes("Invalid Claude settings object"));
});

for (const action of ["apply", "restore"]) {
  test(`Claude ${action} stops after a cable change without asking for another confirmation`, async () => {
    const app = await controller(normalizeConfig(claudeConfigFixture()), {
      onTarget(url, body) {
        if (body.confirmationToken) return { status: 409, body: { error: {
          code: "target_configuration_changed", message: "线路已被其他窗口修改，请刷新后重新应用",
        } } };
        return { status: 409, body: { error: { code: "claude_settings_conflict", details: {
          settingsPath: "/client/settings.json", fields: ["env.ANTHROPIC_API_KEY"], confirmationToken: "previous-cable.files",
        } } } };
      },
    });
    await app.action("open-cable", { dataset: { id: "claude-main" } });
    await app.action(`${action}-target`, { closest: () => null });
    assert.equal(app.requests.filter(({ url }) => url === `/api/v1/targets/${action}`).length, 2);
    assert.equal(app.confirmations.length, 1);
    assert.ok(app.messages.includes("线路已被其他窗口修改，请刷新后重新应用"));
    assert.equal(app.messages.some(message => /配置已应用|原接入配置已恢复/.test(message)), false);
    assert.equal(app.read("state.busy"), false);
  });
}

for (const [target, fixture, id] of [
  ["Codex", codexConfigFixture, "relay"],
  ["Claude Code", claudeConfigFixture, "claude-main"],
]) {
  test(`${target} configuration deletion removes its dependencies and returns to an empty list`, async () => {
    const app = await controller(normalizeConfig(fixture()));
    assert.match(app.read("renderOverview()"), new RegExp(`data-action="delete-cable" data-id="${id}"`));
    await app.action("open-cable", { dataset: { id } });
    assert.match(app.read("renderCableDetail()"), /data-action="delete-cable"/);
    const name = app.read("selectedCable().name");
    app.read(`state.artifactPreview = { cableId: ${JSON.stringify(id)} }; state.resolveResult = { ok: true }`);
    await app.action("delete-cable", { dataset: { id }, closest: () => null });

    const saved = app.persisted();
    for (const field of ["cables", "virtualProviders", "routes", "upstreams"]) assert.deepEqual(saved[field], {});
    assert.equal(validateConfig(saved).ok, true);
    assert.equal(app.read("state.page"), "overview");
    assert.equal(app.read("state.selected.cable"), null);
    assert.equal(app.read("state.selected.virtualProvider"), null);
    assert.equal(app.read("state.selected.model"), null);
    assert.equal(app.read("state.artifactPreview"), null);
    assert.equal(app.read("state.resolveResult"), null);
    assert.equal(app.read("state.busy"), false);
    assert.match(app.read("renderOverview()"), /暂无线路/);
    assert.ok(app.confirmations[0].includes(`「${name}」`));
    assert.match(app.confirmations[0], /本地地址将停止服务/);
    if (target === "Claude Code") assert.match(app.confirmations[0], /先撤销接入或切换其他线路/);
    assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 1);
    assert.ok(!app.requests.some(({ url }) => url.includes("/targets/")));
    assert.deepEqual(app.messages, ["配置已删除并生效。"]);
  });
}

for (const deletedId of ["first", "second"]) {
  test(`deleting ${deletedId} preserves the other configuration and keeps a valid selection`, async () => {
    const initial = normalizeConfig(namedCodexConfigFixture({ first: "first", second: "second" }));
    const app = await controller(initial);
    await app.action("delete-cable", { dataset: { id: deletedId }, closest: () => null });
    const remainingId = deletedId === "first" ? "second" : "first";
    const saved = app.persisted();
    assert.deepEqual(Object.keys(saved.cables), [remainingId]);
    for (const field of ["cables", "routes", "upstreams"]) {
      assert.deepEqual(saved[field][remainingId], initial[field][remainingId]);
      assert.equal(saved[field][deletedId], undefined);
    }
    assert.deepEqual(saved.virtualProviders, { [`cabletidy_${remainingId}`]: initial.virtualProviders[`cabletidy_${remainingId}`] });
    assert.equal(app.read("state.selected.cable"), remainingId);
    assert.equal(app.read("state.selected.virtualProvider"), `cabletidy_${remainingId}`);
    assert.equal(app.read("state.selected.model"), "gpt-5.5");
    assert.equal(validateConfig(saved).ok, true);
  });
}

test("deletion after cancelling creation clears stale provider and model selections", async () => {
  const app = await controller();
  await app.action("create-cable", {});
  await app.action("back-overview", {});
  await app.action("delete-cable", { dataset: { id: "relay" }, closest: () => null });
  assert.equal(app.read("state.selected.cable"), null);
  assert.equal(app.read("state.selected.virtualProvider"), null);
  assert.equal(app.read("state.selected.model"), null);
});

for (const shared of ["route", "upstream"]) {
  test(`configuration deletion preserves a shared ${shared} and unrelated unused resources`, async () => {
    const initial = namedCodexConfigFixture({ first: "first", second: "second", unused: "unused" });
    delete initial.cables.unused;
    delete initial.virtualProviders.cabletidy_unused;
    if (shared === "route") initial.virtualProviders.cabletidy_second.route = "first";
    else initial.routes.second.backends[0].upstream = "first";
    const app = await controller(normalizeConfig(initial));
    const before = app.persisted();
    await app.action("delete-cable", { dataset: { id: "first" }, closest: () => null });
    const saved = app.persisted();
    assert.equal(saved.cables.first, undefined);
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
  app.read('state.page = "cable-detail"');
  const input = inputNode("name", "Relay");
  const form = mountTrackedForm(app, "cable-upstream-form", [input]);
  input.value = "Unsaved relay";
  const before = app.persisted();
  await app.action("delete-cable", { dataset: { id: "relay" }, closest: () => null });
  assert.deepEqual(app.persisted(), before);
  assert.equal(app.read("state.page"), "cable-detail");
  assert.equal(app.read("state.selected.cable"), "relay");
  assert.equal(input.value, "Unsaved relay");
  assert.equal(app.edited(form), true);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 0);
  assert.match(app.confirmations[0], /未保存的修改也会丢失/);
  assert.equal(app.read("state.busy"), false);
});

for (const status of [409, 422, 500]) {
  test(`failed deletion (${status}) retains the configuration, selection and unsaved form`, async () => {
    const app = await controller(undefined, { onCommit: () => ({ status, body: { error: { message: "删除失败" } } }) });
    app.read('state.page = "cable-detail"; state.artifactPreview = { cableId: "relay" }');
    const input = inputNode("name", "Relay");
    const form = mountTrackedForm(app, "cable-upstream-form", [input]);
    input.value = "Unsaved relay";
    const before = app.persisted();
    await app.action("delete-cable", { dataset: { id: "relay" }, closest: () => null });
    assert.deepEqual(app.persisted(), before);
    assert.deepEqual(clone(app.read("state.candidate")), before);
    assert.equal(app.read("state.selected.cable"), "relay");
    assert.equal(app.read("state.selected.virtualProvider"), "cabletidy_relay");
    assert.equal(app.read("state.artifactPreview.cableId"), "relay");
    assert.equal(app.read("state.page"), "cable-detail");
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
  const first = app.action("delete-cable", button);
  await setImmediate();
  assert.equal(app.read("state.busy"), true);
  await app.action("delete-cable", button);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 1);
  release();
  await first;
  assert.deepEqual(app.persisted().cables, {});
  assert.equal(app.read("state.busy"), false);
});

test("creation commits immediately and clears transient secrets", async () => {
  const app = await controller(normalizeConfig({}));
  app.read('state.page = "cable-create"');
  await app.submit(creationForm());
  assert.equal(app.read("state.page"), "cable-detail");
  const config = app.persisted();
  const cable = Object.values(config.cables)[0];
  assert.equal(cable.name, "Development");
  assert.equal(cable.id, "development");
  assert.equal(cable.virtualProvider, "cabletidy_development");
  assert.equal(config.virtualProviders.cabletidy_development.id, cable.virtualProvider);
  assert.equal(app.read("state.selected.cable"), cable.id);
  assert.equal(app.read("state.selected.virtualProvider"), cable.virtualProvider);
  assert.match(app.read("renderCableDetail()"), /cabletidy_development/);
  assert.match(app.read("renderCableDetail()"), /http:\/\/127\.0\.0\.1:43100\/development\/v1/);
  assert.equal(config.virtualProviders.cabletidy_development.listenPort, undefined);
  assert.deepEqual(Object.keys(config.virtualProviders.cabletidy_development.models), ["gpt-5.5"]);
  assert.equal(config.virtualProviders.cabletidy_development.models["gpt-5.5"].upstreamModelId, "vendor-gpt");
  const commits = app.requests.filter(({ url }) => url.endsWith("/config/commit"));
  assert.equal(commits.length, 1);
  assert.equal(commits[0].body.operation.data.upstreamSecret, "test-key");
  assert.doesNotMatch(JSON.stringify(app.read("state.candidate")), /test-key/);
  assert.equal(app.requests.some(({ url }) => url.endsWith("/config/validate")), false);
  assert.doesNotMatch(app.read("renderDiagnostics()"), /配置校验|校验草稿/);
});

test("an empty configuration name derives a stable identity from the upstream host", async () => {
  const app = await controller(normalizeConfig({}));
  const form = creationForm();
  form.fields.cableName = "";
  await app.submit(form);
  const cable = Object.values(app.persisted().cables)[0];
  assert.equal(cable.name, "Codex / example.invalid");
  assert.equal(cable.id, "codex-example-invalid");
  assert.equal(cable.virtualProvider, "cabletidy_codex-example-invalid");
});

test("creating a duplicate normalized name preserves the existing configuration", async () => {
  const app = await controller(normalizeConfig({}));
  await app.submit(creationForm());
  const first = app.persisted();
  const form = creationForm();
  form.fields.cableName = "development";
  await app.submit(form);
  assert.match(form.feedback.innerHTML, /ID 已存在/);
  assert.deepEqual(app.persisted(), first);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 2);
});

test("creation needs only upstream credentials and keeps other configurations' model settings isolated", async () => {
  const app = await controller();
  app.read('state.codexCatalog = { available: false, models: [], error: { message: "unavailable" } }');
  assert.doesNotMatch(app.read("renderCableCreate()"), /data-create-model[ >]/);
  await app.submit(formNode("cable-create-form", creationForm().fields));
  const config = app.persisted();
  assert.equal(config.cables.development.defaultModel, undefined);
  assert.deepEqual(config.virtualProviders.cabletidy_development.models, {});
  assert.equal(config.virtualProviders.cabletidy_development.defaultModel, undefined);
  assert.equal(config.routes[config.virtualProviders.cabletidy_development.route].backends[0].models, undefined);
  assert.deepEqual(Object.keys(config.virtualProviders.cabletidy_relay.models), ["gpt-5.5"]);
  assert.equal(validateConfig(config).ok, true);
  assert.match(app.read("renderCableDetail()"), /模型名直接透传/);
  assert.doesNotMatch(app.read("renderCableDetail()"), /data-model-id="model"/);
  const commit = app.requests.find(({ url }) => url.endsWith("/config/commit"));
  assert.equal(commit.body.operation.data.upstreamSecret, "test-key");
});

test("model settings can override context without a rename and can all be removed", async () => {
  const app = await controller();
  await app.submit(formNode("cable-models-form", {}, [{
    dataset: { modelId: "gpt-5.5" },
    querySelector(selector) {
      if (selector === "[data-cable-model-client]") return { value: "gpt-5.5" };
      if (selector.startsWith("[data-cable-model-upstream=")) return { value: "" };
      if (selector === "[data-codex-metadata-mode]") return { value: "override" };
      if (selector === "[data-cable-model-context]") return { value: "128000" };
      if (selector === "[data-codex-vision]") return { checked: true };
      return null;
    },
  }]));
  let config = app.persisted();
  assert.equal(config.virtualProviders.cabletidy_relay.models["gpt-5.5"].contextWindow, 128000);
  assert.equal(config.virtualProviders.cabletidy_relay.models["gpt-5.5"].codex.metadataMode, "override");
  assert.equal(config.virtualProviders.cabletidy_relay.models["gpt-5.5"].upstreamModelId, undefined);
  assert.equal(validateConfig(config).ok, true);
  await app.submit(formNode("cable-models-form"));
  config = app.persisted();
  assert.equal(config.models, undefined);
  assert.deepEqual(config.virtualProviders.cabletidy_relay.models, {});
  assert.equal(config.routes.route.backends[0].models, undefined);
  assert.equal(config.virtualProviders.cabletidy_relay.defaultModel, undefined);
  assert.equal(config.cables.relay.defaultModel, undefined);
  assert.equal(validateConfig(config).ok, true);
});

test("optional creation rows may leave the upstream model name blank", async () => {
  const app = await controller(normalizeConfig({}));
  await app.submit(formNode("cable-create-form", creationForm().fields, [{
    querySelector: selector => ({ value: selector.includes("clientModelId") ? "gpt-5.5" : "" }),
  }]));
  const config = app.persisted();
  const model = Object.values(config.virtualProviders.cabletidy_development.models)[0];
  assert.equal(model.upstreamModelId, undefined);
  assert.equal(config.cables.development.defaultModel, undefined);
  assert.equal(validateConfig(config).ok, true);
});

test("separate configurations each keep their own upstream and model mappings", async () => {
  const app = await controller(normalizeConfig({}));
  await app.submit(creationForm());
  const second = creationForm();
  second.fields.cableName = "Production";
  await app.submit(second);
  const config = app.persisted();
  assert.equal(Object.keys(config.cables).length, 2);
  const upstreamIds = new Set();
  for (const cable of Object.values(config.cables)) {
    const provider = config.virtualProviders[cable.virtualProvider];
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

test("Generic CLI model editing preserves legacy policies without exposing inactive controls", async () => {
  const config = normalizeConfig(codexConfigFixture());
  config.cables.relay.target = "generic-env";
  const model = config.virtualProviders.cabletidy_relay.models["gpt-5.5"];
  model.contextWindow = 64000;
  model.compact = { strategy: "auto", tokenLimit: 50000 };
  const app = await controller(config);
  const cableHtml = app.read("renderCableDetail()");
  assert.match(cableHtml, /高级模型设置/);
  assert.doesNotMatch(cableHtml, /Context window|Compact strategy|compactTokenLimit|contextWindow/);
  const html = app.read("renderModels()");
  assert.doesNotMatch(html, /Context window|Compact strategy|compactTokenLimit|contextWindow/);
  await app.submit(formNode("model-form", {
    id: "model", clientModelId: "gpt-5.5", aliases: "gpt-5.5",
    upstreamId: "relay", upstreamModelId: "changed-model", capabilityOverrides: "-vision",
    capabilities: "streaming, tools",
  }));
  const saved = app.persisted().virtualProviders.cabletidy_relay.models["gpt-5.5"];
  assert.equal(saved.contextWindow, 64000);
  assert.deepEqual(saved.compact, { strategy: "auto", tokenLimit: 50000 });
  assert.deepEqual(saved.capabilities, ["streaming", "tools"]);
});

test("a rejected creation stays on the form and can be retried without duplicate records", async () => {
  let reject = true;
  const app = await controller(normalizeConfig({}), {
    onCommit: () => reject ? {
      status: 422,
      body: { error: { message: "配置校验失败" }, errors: [{ path: "upstreams.relay-main.baseUrl", message: "地址不合法" }] },
    } : null,
  });
  app.read('state.page = "cable-create"');
  const form = creationForm();
  await app.submit(form);
  assert.equal(app.read("state.page"), "cable-create");
  assert.equal(app.read("Object.keys(state.candidate.cables).length"), 0);
  assert.equal(Object.keys(app.persisted().cables).length, 0);
  assert.equal(app.read("state.selected.cable"), null);
  assert.deepEqual(clone(app.read("state.candidate")), app.persisted());
  assert.match(form.feedback.innerHTML, /地址不合法/);
  assert.equal(form.fields.upstreamSecret, "test-key");
  assert.equal(app.messages.length, 0);
  reject = false;
  await app.submit(form);
  assert.equal(Object.keys(app.persisted().cables).length, 1);
  assert.equal(Object.keys(app.persisted().upstreams).length, 1);
  assert.equal(app.read("state.page"), "cable-detail");
});

test("local form validation does not write or leave a partial candidate", async () => {
  const app = await controller(normalizeConfig({}));
  app.read('state.page = "cable-create"');
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
    app.read('state.page = "cable-detail"');
    const form = formNode("cable-upstream-form", {
      id: "relay", name: "Unsaved relay", protocol: "openai.responses",
      baseUrl: "https://example.invalid/v1", secret: "new-key",
    });
    await app.submit(form);
    assert.match(form.feedback.innerHTML, failure.expected);
    assert.equal(form.fields.name, "Unsaved relay");
    assert.equal(app.read("state.config.upstreams.relay.name"), "Relay");
    assert.equal(app.read("state.candidate.upstreams.relay.name"), "Relay");
    assert.equal(app.read("state.page"), "cable-detail");
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
  assert.equal(Object.keys(app.persisted().cables).length, 1);
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
    await app.submit(formNode("cable-create-form", creationForm().fields, [{
      querySelector: (selector) => ({ value: selector.includes("clientModelId") ? id : "vendor-security" }),
    }]));
    const model = app.persisted().virtualProviders.cabletidy_development.models[id];
    const upstreamId = app.read("selectedCable().upstreamId");
    assert.ok(model);
    assert.match(app.read('renderCableDetail()'), new RegExp(`value="${id}" selected`));
    await app.submit(formNode("cable-models-form", {}, [{
      dataset: { modelId: id },
      querySelector(selector) {
        if (selector === "[data-cable-model-client]") return { value: id };
        if (selector.startsWith("[data-cable-model-upstream=")) return { value: "updated-security" };
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
      const form = formNode("cable-create-form");
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
      cli.matches = (selector) => selector === '#cable-create-form [name="target"]';
      return form;
    };
    Object.defineProperty(page, "innerHTML", { configurable: true, set: () => { current = makeForm(); } });
    page.querySelectorAll = (selector) => selector === "form" ? [current] : [];
    page.querySelector = (selector) => selector === "#cable-create-form" ? current : null;
    await app.action("create-cable");
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
    assert.equal(config.cables.development.target, target);
    assert.equal(config.cables.development.defaultModel, target === "claude-code" ? "opus" : undefined);
    assert.equal(config.cables.development.claude?.models?.subagent, target === "claude-code" ? "haiku" : undefined);
    assert.equal(config.upstreams.relay.name, "Other window update");
    assert.equal(validateConfig(config).ok, true);
    const commit = app.requests.find(({ url }) => url.endsWith("/config/commit"));
    assert.equal(commit.body.operation.data.upstreamSecret, "test-key");
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
  const form = mountTrackedForm(app, "cable-upstream-form", inputs);
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
  const inputs = [inputNode("", "gpt-5.5", { dataset: { cableModelClient: "" } })];
  const form = mountTrackedForm(app, "cable-models-form", inputs);
  inputs.push(inputNode("", "gpt-daybreak-blue-latest", { dataset: { cableModelClient: "" } }));
  assert.equal(app.edited(form), true);
  inputs.pop();
  assert.equal(app.edited(form), false);
});

test("cancelled navigation retains the page, selection and unsaved input", async () => {
  const app = await controller(undefined, { confirmLeave: false });
  const input = inputNode("name", "Relay");
  const form = mountTrackedForm(app, "cable-upstream-form", [input]);
  app.read('state.page = "cable-detail"');
  input.value = "Unsaved relay";
  app.read('navigatePage("diagnostics")');
  assert.equal(app.read("state.page"), "cable-detail");
  assert.equal(app.edited(form), true);
  await app.action("back-overview");
  assert.equal(app.read("state.page"), "cable-detail");
  assert.equal(input.value, "Unsaved relay");
  assert.equal(app.confirmations.length, 2);
  assert.equal(app.read("state.busy"), false);
});

test("confirmed navigation proceeds, while reverted edits need no confirmation", async () => {
  const app = await controller();
  const input = inputNode("name", "Relay");
  mountTrackedForm(app, "cable-upstream-form", [input]);
  app.read('state.page = "cable-detail"');
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

for (const direction of ["back", "forward"]) {
  for (const accept of [false, true]) {
    test(`browser ${direction} ${accept ? "discards a settings draft only after confirmation" : "keeps the settings URL and draft when cancelled"}`, async () => {
      const app = await controller(undefined, { confirmLeave: accept });
      app.read('navigatePage("settings")');
      app.read('navigatePage("security")');
      await setImmediate();
      await app.back();
      const input = inputNode("retentionDays", "30", { type: "number" });
      const form = mountTrackedForm(app, "audit-settings-form", [input]);
      input.value = "7";
      await app[direction]();
      assert.equal(app.confirmations.length, 1);
      assert.equal(app.read("state.page"), accept ? (direction === "back" ? "overview" : "security") : "settings");
      assert.equal(app.read("window.location.hash"), accept ? (direction === "back" ? "" : "#security") : "#settings");
      if (!accept) {
        assert.equal(input.value, "7");
        assert.equal(app.edited(form), true);
      }
    });
  }
}

test("cancelling back to an older history entry preserves the settings draft without reloading", async () => {
  const app = await controller(undefined, {
    confirmLeave: false, url: "http://test/#settings",
    historyEntries: [
      { url: "http://test/", state: { page: "overview" } },
      { url: "http://test/#settings", state: { page: "settings" } },
    ],
  });
  const input = inputNode("retentionDays", "30", { type: "number" });
  const form = mountTrackedForm(app, "audit-settings-form", [input]);
  input.value = "7";
  await app.back();
  assert.equal(app.confirmations.length, 1);
  assert.equal(app.read("state.page"), "settings");
  assert.equal(app.read("window.location.hash"), "#settings");
  assert.equal(input.value, "7");
  assert.equal(app.edited(form), true);
});

test("clicking the active navigation page does not rerender or discard input", async () => {
  const app = await controller();
  const input = inputNode("name", "Relay");
  const form = mountTrackedForm(app, "cable-upstream-form", [input]);
  app.read('state.page = "cable-detail"');
  input.value = "Unsaved";
  app.read('navigatePage("cable-detail")');
  assert.equal(app.edited(form), true);
  assert.equal(app.confirmations.length, 0);
});

test("browser unload is guarded only for actual configuration changes", async () => {
  const app = await controller();
  const input = inputNode("name", "Relay");
  mountTrackedForm(app, "cable-upstream-form", [input]);
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
  mountTrackedForm(app, "cable-upstream-form", [input]);
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
  Object.assign(select, { name: "", type: "select-one", dataset: { cableModelClient: "", officialModel: "" } });
  const context = inputNode("", "272000", { dataset: { cableModelContext: "" }, type: "number", disabled: mode === "official" });
  const vision = inputNode("", "on", { dataset: { codexVision: "" }, type: "checkbox", checked: true, disabled: mode === "official" });
  const metadataMode = inputNode("", mode, { dataset: { codexMetadataMode: "" }, type: "select-one" });
  const instructions = { textContent: "Original definition" };
  const row = {
    dataset: { modelId: "gpt-5.5" },
    querySelector: (selector) => ({
      "[data-cable-model-client]": select,
      "[data-cable-model-context]": context,
      "[data-codex-vision]": vision,
      "[data-codex-metadata-mode]": metadataMode,
      "[data-codex-instructions]": instructions,
    })[selector] || null,
  };
  const inputs = [select, context, vision, metadataMode];
  inputs.forEach(input => { input.closest = (selector) => selector === "[data-cable-model]" ? row : null; });
  return { row, select, context, vision, metadataMode, instructions, inputs };
}

for (const mode of ["official", "override"]) {
  test(`catalog refresh synchronizes ${mode} metadata without changing user overrides or dirty state`, async () => {
    const latest = publicCodexCatalog(catalogFixture());
    Object.assign(latest.models[0], { name: "Updated model", contextWindow: 128000, maxContextWindow: 512000, inputModalities: ["text"] });
    const app = await controller(undefined, { refreshCatalog: latest });
    const metadata = metadataRow(mode);
    const form = mountTrackedForm(app, "cable-models-form", metadata.inputs);
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
  const form = mountTrackedForm(app, "cable-models-form", metadata.inputs);
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
  config.cables.relay.defaultModel = "gpt-5.6-sol";
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
    querySelector: selector => selector === "[data-cable-model-client]" ? { value: name }
      : selector === '[data-cable-model-upstream="relay"]' ? { value: upstreamModelId } : null,
  }));
  const form = formNode("cable-models-form", {}, rows);
  await app.submit(form);
  assert.equal(form.feedback, null);
  const saved = app.persisted();
  const provider = saved.virtualProviders.cabletidy_relay;
  assert.deepEqual(Object.keys(provider.models), ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-luna"]);
  assert.equal(provider.models["gpt-6-sol"].upstreamModelId, "new-sol");
  assert.equal(provider.models["gpt-5.6-sol"].upstreamModelId, "old-sol");
  assert.equal(provider.defaultModel, "gpt-6-sol");
  assert.equal(saved.cables.relay.defaultModel, "gpt-6-sol");
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
    querySelector: selector => selector === "[data-cable-model-client]" ? { value: name }
      : selector === '[data-cable-model-upstream="relay"]' ? { value: mapping } : null,
  }));
  const form = formNode("cable-models-form", {}, rows);
  await app.submit(form);
  assert.equal(form.feedback, null);
  const provider = app.persisted().virtualProviders.cabletidy_relay;
  assert.equal(provider.models["gpt-5.6-sol"].upstreamModelId, "first");
  assert.equal(provider.models["gpt-5.5"].upstreamModelId, "second");
  assert.equal(provider.defaultModel, "gpt-5.6-sol");
});

// Model the form replacement lifecycle, not just the saved configuration object.
function mountCableEditor(app) {
  const page = app.node("#page-content");
  let current;
  const makeForm = () => {
    const config = app.read("state.candidate");
    const form = formNode("cable-models-form");
    form.rows = [];
    const attribute = form.getAttribute;
    form.getAttribute = (name) => name === "data-cable-context"
      ? JSON.stringify(["relay", "codex", config.cables.relay.virtualProvider, "route", config.routes.route.backends[0].upstream]) : attribute(name);
    form.replaceWith = (replacement) => { current = replacement; };
    const list = {
      querySelector: () => null,
      append(row) {
        row.remove();
        row.remove = () => { form.rows = form.rows.filter(item => item !== row); };
        form.rows.push(row);
      },
    };
    form.querySelector = (selector) => selector === "#cable-model-list" ? list
      : selector === "[data-form-feedback]" ? form.feedback : null;
    form.querySelectorAll = (selector) => selector === "[data-cable-model]" ? [...form.rows]
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
        dataset: { cableModelUpstream: "relay" }, closest: () => row,
      });
      const query = row.querySelector;
      row.querySelector = (selector) => selector === '[data-cable-model-upstream="relay"]' ? mapping : query(selector);
      row.inputs = [...metadata.inputs, mapping];
      row.mapping = mapping;
      row.context = context;
      row.remove = () => { form.rows = form.rows.filter(item => item !== row); };
      form.rows.push(row);
    }
    return form;
  };
  app.read('state.page = "cable-detail"');
  Object.defineProperty(page, "innerHTML", { configurable: true, set: () => { current = makeForm(); } });
  page.querySelectorAll = (selector) => selector === "form" ? [current] : [];
  page.querySelector = (selector) => selector === "#cable-models-form" ? current : null;
  app.read("render()");
  return { form: () => current, row: (id = "gpt-5.5") => current.rows.find(row => row.dataset.modelId === id) };
}

test("conflict refresh merges another window's added model before retrying a local mapping edit", async () => {
  const app = await controller();
  const editor = mountCableEditor(app);
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
  const editor = mountCableEditor(app);
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
  const editor = mountCableEditor(app);
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
  const editor = mountCableEditor(app);
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
    const editor = mountCableEditor(app);
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
  const editor = mountCableEditor(app);
  const added = metadataRow().row;
  added.dataset.modelId = "";
  added.inputs = [inputNode("", "new-model", { dataset: { cableModelClient: "" }, closest: () => added })];
  added.remove = () => {};
  editor.form().querySelector("#cable-model-list").append(added);
  app.externalUpdate(config => addFixtureModel(config));
  await app.action("refresh");
  assert.deepEqual(editor.form().rows.map(row => row.dataset.modelId), ["gpt-5.5", "gpt-5.6-sol", ""]);
  assert.equal(app.edited(editor.form()), true);
  added.remove();
  assert.equal(app.edited(editor.form()), false);
});

test("a changed cable upstream cannot silently retarget local model edits", async () => {
  const app = await controller();
  const editor = mountCableEditor(app);
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
    const editor = mountCableEditor(app);
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
  const editor = mountCableEditor(app);
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
  const editor = mountCableEditor(app);
  const select = editor.row().querySelector("[data-cable-model-client]");
  select.value = "gpt-daybreak-blue-latest";
  app.change(select);
  app.externalUpdate(config => addFixtureModel(config));
  await app.action("refresh");
  const merged = editor.row().querySelector("[data-cable-model-client]");
  assert.equal(merged.value, "gpt-daybreak-blue-latest");
  assert.match(merged.hint.textContent, /防御性安全工作/);
  assert.equal(merged.hint.hidden, false);
});

test("inspection coverage limits and missing content have distinct labels and notices", async () => {
  const app = await controller();
  assert.equal(app.read('securityInspectionLabel({ inspectionStatus: "limited" })'), "已检查（覆盖有限）");
  assert.equal(app.read('securityInspectionLabel({ inspectionStatus: "partial" })'), "检测不完整");
  let html = app.read('renderSecurityCoverage({ inspectionStatus: "limited", coverageLimitations: ["unsupported_tool", "reasoning_content_not_inspected"], inspectionIssues: [] })');
  assert.match(html, /覆盖范围限制/);
  assert.match(html, /推理文本已做凭据检查/);
  assert.doesNotMatch(html, /notice warning|检查缺口/);
  html = app.read('renderSecurityCoverage({ inspectionStatus: "partial", coverageLimitations: ["unsupported_tool"], inspectionIssues: ["body_not_complete"] })');
  assert.match(html, /notice warning">检查缺口：正文接收未完成/);
  assert.match(html, /覆盖范围限制：工具语义暂不支持/);
  html = app.read('securitySessionRow({ id: "one", requestCount: 36, errorCount: 12, incompleteCount: 2, limitedCount: 34 })');
  assert.match(html, /12 条异常/);
  assert.match(html, /2 条待检查 \/ 不完整/);
  assert.match(html, /34 条覆盖有限/);
  const facts = app.read('JSON.stringify(securityRecordFacts({ outcome: "completed", responseTerminalEvent: "response.completed", responseTransportState: "interrupted" }))');
  assert.match(facts, /收到结束事件后连接关闭/);
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
  assert.doesNotMatch(html, /工具提议/);
  assert.doesNotMatch(app.read("renderTraceInspector()"), /查看请求与响应原文/);
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
  html = app.read("renderTraceInspector()");
  assert.match(html, /模型<\/dt><dd>未记录 → 未记录<\/dd>/);
  assert.doesNotMatch(html, /工具调用提议/);
  assert.equal(app.read("state.page"), "security-session");
  await app.back();
  assert.equal(app.read("state.page"), "security");
  assert.equal(app.read("window.scrollY"), 400);
  await app.forward();
  assert.equal(app.read("state.page"), "security-session");
  assert.equal(app.read("state.trace.summary.requestCount"), 2);
});

test("session trace uses neutral risk labels for legacy records and three states for modern records", async () => {
  const records = [
    { id: "clean", schemaVersion: 5, findingCount: 0, newFindingCount: 0, historicalFindingCount: 0 },
    { id: "new", schemaVersion: 5, findingCount: 1, newFindingCount: 1, historicalFindingCount: 0 },
    { id: "history", schemaVersion: 5, findingCount: 2, newFindingCount: 0, historicalFindingCount: 2 },
    { id: "mixed", schemaVersion: 6, findingCount: 3, newFindingCount: 1, historicalFindingCount: 2 },
    { id: "legacy", schemaVersion: 4, findingCount: 1 },
    { id: "unversioned", findingCount: 1 },
    { id: "legacy-clean", schemaVersion: 3, findingCount: 0 },
  ];
  const app = await controller();
  app.read(`state.trace.result = ${JSON.stringify({ items: records, total: records.length })}`);
  const html = app.read("renderSecuritySession()");
  const row = id => html.match(new RegExp(`<button class="trace-event-row [^"]*"[^>]*data-id="${id}"[^>]*>([\\s\\S]*?)</button>`))[1];
  assert.match(row("clean"), /未发现风险/);
  assert.match(row("new"), /新增风险 1 项/);
  assert.doesNotMatch(row("new"), /历史风险/);
  assert.match(row("history"), /仅历史风险 2 项/);
  assert.doesNotMatch(row("history"), /新增风险/);
  assert.match(row("mixed"), /新增风险 1 项 · 历史风险 2 项/);
  for (const id of ["legacy", "unversioned"]) {
    assert.match(row(id), /风险 1 项/);
    assert.doesNotMatch(row(id), /新增风险|历史风险/);
    assert.match(html, new RegExp(`class="trace-segment has-risk [^"]*"[^>]*data-id="${id}"`));
    assert.doesNotMatch(html, new RegExp(`class="trace-segment has-new-risk [^"]*"[^>]*data-id="${id}"`));
  }
  assert.match(row("legacy-clean"), /未发现风险/);
  assert.match(html, /class="trace-segment has-history-risk [^"]*"[^>]*data-id="history"/);
  assert.match(html, /class="trace-segment has-new-risk [^"]*"[^>]*data-id="mixed"/);
  assert.match(html, /风险 \/ 新增风险<\/span>/);
  await app.action("security-trace-risk", { dataset: {} });
  assert.deepEqual(clone(app.read("traceItems().map(item => item.id)")), ["new", "history", "mixed", "legacy", "unversioned"]);
});

test("legacy session summaries and legends never describe old findings as new", async () => {
  const app = await controller();
  const summary = { id: "legacy-session", requestCount: 2, findingCount: 3, newFindingCount: 0, legacyFindingCount: 3, historicalFindingCount: 0 };
  app.read(`state.trace.summary = ${JSON.stringify(summary)}; state.trace.result = ${JSON.stringify({ items: [
    { id: "legacy-risk", schemaVersion: 4, findingCount: 3 },
    { id: "legacy-clean", schemaVersion: 4, findingCount: 0 },
  ] })}; state.security.result = ${JSON.stringify({ ...summary, items: [summary] })}`);
  const trace = app.read("renderSecuritySession()");
  assert.match(trace, /trace-risk-swatch"[^>]*><\/i>风险<\/span>/);
  assert.doesNotMatch(trace, /新增风险|仅历史风险|trace-history-risk-swatch/);
  assert.match(trace, /<strong>3<\/strong> 项风险/);
  const list = app.read("renderSecurity()");
  assert.match(list, /风险 3 项/);
  assert.match(list, /<strong>3<\/strong><span>项风险<\/span>/);
  assert.doesNotMatch(list, /新增风险|项新增|历史关联/);
  const clean = { ...summary, requestCount: 1, findingCount: 0, legacyFindingCount: 0 };
  app.read(`state.trace.summary = ${JSON.stringify(clean)}; state.trace.result.items = [state.trace.result.items[1]]; state.security.result = ${JSON.stringify({ ...clean, items: [clean] })}`);
  const cleanTrace = app.read("renderSecuritySession()");
  assert.match(cleanTrace, /trace-totals[^]*?<span>未发现风险<\/span>/);
  assert.doesNotMatch(cleanTrace, /新增风险|仅历史风险/);
  assert.doesNotMatch(app.read("renderSecurity()"), /新增风险|项新增|历史关联/);
});

test("mixed session summaries and individual navigation keep legacy risks separate from modern findings", async () => {
  const app = await controller();
  const summary = { id: "mixed-session", findingCount: 6, legacyFindingCount: 3, newFindingCount: 1, historicalFindingCount: 2 };
  const list = app.read(`securitySessionRow(${JSON.stringify(summary)})`);
  assert.match(list, /风险 3 项（旧记录） · 新增风险 1 项 · 2 次历史关联/);
  const records = [
    { id: "legacy", schemaVersion: 4, findingCount: 3 },
    { id: "new", schemaVersion: 5, findingCount: 1, newFindingCount: 1, historicalFindingCount: 0 },
    { id: "history", schemaVersion: 5, findingCount: 2, newFindingCount: 0, historicalFindingCount: 2 },
    ...Array.from({ length: 118 }, (_, i) => ({ id: `clean-${i}`, schemaVersion: 5, findingCount: 0, newFindingCount: 0, historicalFindingCount: 0 })),
  ];
  app.read(`state.trace.summary = ${JSON.stringify(summary)}; state.trace.result = ${JSON.stringify({ items: records })}`);
  const html = app.read("renderSecuritySession()");
  assert.match(html, /<strong>4<\/strong> 项风险（含旧记录 3 项） · 2 次历史关联/);
  assert.match(html, /title="请求 1[^\"]*风险 3 项"/);
  assert.match(html, /title="请求 2[^\"]*新增风险 1 项"/);
  assert.match(html, /title="请求 3[^\"]*仅历史风险 2 项"/);
  assert.match(html, /class="trace-segment has-risk [^\"]*"[^>]*data-id="legacy"/);
  assert.match(html, /class="trace-segment has-new-risk [^\"]*"[^>]*data-id="new"/);
  assert.match(html, /class="trace-segment has-history-risk [^\"]*"[^>]*data-id="history"/);
  app.read(`state.trace.result.items[1] = ${JSON.stringify({ id: "legacy-clean", schemaVersion: 4, findingCount: 0 })}`);
  const withHistory = app.read("renderSecuritySession()");
  assert.match(withHistory, /class="trace-segment has-risk [^\"]*"[^>]*data-id="legacy"/);
  assert.match(withHistory, /title="请求 1[^\"]*风险 3 项"/);
  assert.match(withHistory, /title="请求 3[^\"]*仅历史风险 2 项"/);
  assert.doesNotMatch(withHistory, /相邻请求合并显示/);
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
  assert.equal(app.requests.filter(r => r.url.includes("/body?")).length, 0, "content projection includes evidence without browser body reads");
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
    if (url.includes("/response-content?")) return new Promise(resolve => { release = () => resolve({ body: record.responseContent }); });
    if (url.includes("/body?")) return { body: { chunks: [{ start: 500, end: finding.evidence.bodyRef.end, content: escaped }] } };
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
    const html = app.read(`securityPageText(${JSON.stringify({ chunks: [{ start: 0, content }] })}, ${JSON.stringify(selection)}, ${JSON.stringify(evidenceNative("evidence.selections", record.findings, "request"))})`);
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
  assert.deepEqual(Array.from(ranges, range => text.slice(range.start, range.end)), ["rm -rf /important", "/workspace"], "inspected fields match formatted output at their values");
  const record = { responseContent: { offset: 0, total: 1, counts: {}, state: "partial", items: [{ index: 0, kind: "tool_call", state: "partial", preview: evidence }] } };
  assert.match(app.read(`renderResponseContent(${JSON.stringify(record)})`), /调用未完成.*实际执行状态未知/);
});

test("filtered tool evidence highlights unchanged commands with extra fields in both content views", async () => {
  const cmd = "rm -rf /important", evidence = JSON.stringify({ cmd });
  const preview = JSON.stringify({ description: "cleanup", workdir: "/workspace", cmd });
  for (const response of [false, true]) {
    const key = response ? "responseContent" : "requestContent", source = response ? "stream/tool" : "request";
    const finding = { id: "delete", ruleId: "SEC-DELETE-001", evidenceStage: response ? "tool_call_proposed" : "request_content", evidence: { bodyRef: { snapshotId: "evidence/tool", sourceSnapshotId: source, start: 0, end: evidence.length } } };
    const item = { index: 0, kind: "tool_call", start: 0, end: 200, preview, structure: JSON.stringify({ type: "function_call", arguments: preview }, null, 2), contentSnapshotIds: [source] };
    const app = await controller(undefined, { onSecurity(url) {
      if (url.includes("/body?")) return { body: { chunks: [{ start: 0, end: evidence.length, content: evidence }] } };
    } });
    app.read(`state.page = "security-session"; state.security.detail = ${JSON.stringify({ id: "unchanged", findings: [finding], [key]: { offset: 0, total: 1, counts: {}, state: "complete", items: [item] } })}`);
    await app.action("security-trace-tab", { dataset: { tab: response ? "response" : "request" } });
    for (const field of ["preview", "structure"]) {
      const ranges = app.read(`state.security.detail.${key}.items[0].riskRanges.${field}`);
      assert.deepEqual(Array.from(ranges, range => item[field].slice(range.start, range.end)), [cmd]);
    }
    assert.equal(app.read(`state.security.detail.${key}.items[0].riskVersions.length`), 0);
    assert.match(app.read("renderTraceInspector()"), /security-risk-hit/);
    assert.doesNotMatch(app.read("renderTraceInspector()"), /检测时的工具参数与当前参数不同|security-body-hit/);
    await app.action("security-finding", { dataset: { id: "delete" } });
    assert.equal(app.read("state.security.contentNavigation.field"), "preview");
    assert.match(app.read("renderTraceInspector()"), /data-security-content-anchor/);
    assert.doesNotMatch(app.read("renderTraceInspector()"), /风险检测时的内容/);
  }
});

test("tool evidence matches corresponding fields across formatting, ordering and escaped envelopes", async () => {
  const app = await controller(), cmd = 'rm -rf /important/秘密🙂 "quoted"\nnext\\path';
  const evidence = JSON.stringify({ cmd, path: "/workspace" });
  const argumentsText = '{ "description": "cleanup", "path": "/workspace", "c\\u006dd" : ' + JSON.stringify(cmd).replace("秘密", "\\u79d8\\u5bc6") + " }";
  for (const text of [argumentsText,
    JSON.stringify({ type: "function_call", arguments: argumentsText }, null, 2),
    JSON.stringify({ type: "tool_use", input: JSON.parse(argumentsText) }, null, 2)]) {
    const ranges = app.read(`contentRiskRanges(${JSON.stringify(text)}, ${JSON.stringify(evidence)}, "delete", true)`);
    assert.equal(ranges.length, 2);
    const marked = Array.from(ranges, range => text.slice(range.start, range.end));
    if (JSON.parse(text).type === "function_call") {
      // First decode the envelope's escapes, then the argument value's escapes.
      assert.equal(JSON.parse('"' + JSON.parse('"' + marked[0] + '"') + '"'), cmd);
    } else assert.equal(JSON.parse('"' + marked[0] + '"'), cmd);
    assert.equal(marked[1], "/workspace");
  }
  const nestedEvidence = JSON.stringify({ input: { cmd, options: ["one", { two: true }] } });
  const nested = JSON.stringify({ input: { options: ["one", { two: true }], cmd }, description: "cleanup" }, null, 2);
  const ranges = app.read(`contentRiskRanges(${JSON.stringify(nested)}, ${JSON.stringify(nestedEvidence)}, "nested", true)`);
  assert.equal(ranges.length, 1);
  assert.deepEqual(JSON.parse(nested.slice(ranges[0].start, ranges[0].end)), JSON.parse(nestedEvidence).input);
});

test("changed tool evidence cannot match an auxiliary field, another key or nested text", async () => {
  const app = await controller(), cmd = "rm -rf /important";
  for (const evidence of [{ cmd }, { cmd, path: "/workspace" }]) {
    const current = { cmd: "ls", path: "/workspace", description: cmd, archived: { cmd } };
    for (const text of [JSON.stringify(current),
      JSON.stringify({ type: "function_call", arguments: JSON.stringify(current) }, null, 2),
      JSON.stringify({ type: "tool_use", input: current }, null, 2)]) {
      assert.equal(app.read(`contentRiskRanges(${JSON.stringify(text)}, ${JSON.stringify(JSON.stringify(evidence))}, "delete", true)`).length, 0);
    }
  }
  for (const text of ['{"cmd":"rm -rf /important"', '{"cmd":"rm -rf /important","cmd":"ls"}', '{"command":"rm -rf /important"}']) {
    assert.equal(app.read(`contentRiskRanges(${JSON.stringify(text)}, ${JSON.stringify(JSON.stringify({ cmd }))}, "delete", true)`).length, 0);
  }
});

test("scalar and array tool inputs keep value ranges without matching surrounding text", async () => {
  const app = await controller();
  for (const value of ["*** Begin Patch\n*** End Patch", '{"literal":"custom tool text"}', ["rm", "-rf", "/important"]]) {
    const evidence = JSON.stringify(value);
    const texts = [evidence, JSON.stringify({ type: "function_call", arguments: evidence }, null, 2)];
    if (typeof value === "string") texts.push(value, JSON.stringify({ type: "custom_tool_call", input: value }, null, 2));
    for (const text of texts) assert.equal(app.read(`contentRiskRanges(${JSON.stringify(text)}, ${JSON.stringify(evidence)}, "tool", true)`).length, 1);
  }
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

for (const destination of ["all", "folded", "risk"]) for (const lateFailure of [false, true]) {
  test(`late historical page ${lateFailure ? "failure" : "result"} cannot replace ${destination} content`, async () => {
    let release, delayed = false;
    const hit = "risk at item 80";
    const item = index => ({ index, kind:"assistant", start:index*100, end:index*100+80, preview:index === 80 ? hit : `Historical item ${index}` });
    const page = offset => ({ view:"all", offset, nextOffset:offset+40 < 101 ? offset+40 : null, total:101, counts:{}, state:"complete", items:Array.from({length:Math.min(40,101-offset)},(_,i) => item(offset+i)) });
    const folded = { view:"folded", offset:0, nextOffset:null, total:101, nodeTotal:2, historicalCount:100, newCount:1, firstNewIndex:100, counts:{}, state:"complete",
      nodes:[{kind:"history_range",startIndex:0,endIndex:99},item(100)], items:[item(100)] };
    const finding = { id:"history-risk", contentIndex:80, ruleId:"SEC-INJECT-001", evidenceStage:"request_content", evidence:{bodyRef:{snapshotId:"request",start:8000,end:8000+hit.length}} };
    const app = await controller(undefined, { onSecurity(url) {
      if (url.includes("/content?")) {
        const params = new URL(url,"http://test").searchParams, offset = Number(params.get("offset"));
        if (offset === 40 && !delayed) {
          delayed = true;
          return new Promise(resolve => { release = () => resolve(lateFailure ? {status:503,body:{error:{message:"old history failed"}}} : {body:page(40)}); });
        }
        return {body:params.get("view") === "folded" ? clone(folded) : page(offset)};
      }
      if (url.includes("/body?")) return {body:{chunks:[{start:8000,end:8000+hit.length,content:hit}]}};
    } });
    app.read(`state.page = "security-session"; state.trace.tab = "request"; state.security.detail = ${JSON.stringify({id:"history-paging",findings:[finding],requestContent:folded})}`);
    const pending = app.action("security-history-page", {dataset:{start:"0",end:"99",offset:"40"}});
    await setImmediate();
    if (destination === "risk") await app.action("security-finding", {dataset:{id:finding.id}});
    else await app.action("security-content-view", {dataset:{view:destination}});
    const current = app.read("state.security.detail.requestContent"), before = clone(current);
    if (destination === "risk") assert.equal(app.read("state.security.contentNavigation.index"),80);
    if (destination === "all") assert.equal(current.items.length,40);
    release(); await pending;
    assert.equal(app.read("state.security.detail.requestContent"),current);
    assert.deepEqual(clone(current),before,"the old page cannot add items or change pagination");
    assert.equal(app.read("state.security.detail.historyRanges?.[0]?.error ?? null"),null);
    assert.equal(app.read("state.security.detail.historyRanges?.[0]?.loading ?? false"),false);
    assert.equal(app.read("state.security.contentError"),null);
    if (destination === "folded") {
      await app.action("security-history-page", {dataset:{start:"0",end:"99",offset:"0"}});
      assert.equal(app.read("state.security.detail.historyRanges[0].page.offset"),0,"history remains loadable after the discarded request");
    }
  });
}

test("legacy source navigation uses structural positions without adding risk highlighting", async () => {
  const app = await controller();
  const body = { input: [{ role: "user", content: "long preceding content ".repeat(1000) }, { role: "user", content: "TARGET <script>literal</script>" }] };
  const page = evidenceNative("evidence.body", { legacySnapshot: { body, root: "request" } }, [], "request");
  const html = app.read(`securityPageText(${JSON.stringify(page)}, { navigation: { start: 1, location: "request/field/0/1" } })`);
  assert.match(html, /<span data-security-body-anchor tabindex="-1">\{<\/span>\n\s+&quot;role&quot;:/);
  assert.match(html, /TARGET &lt;script&gt;literal/);
  assert.doesNotMatch(html, /security-body-hit|<script>/);
  assert.equal(html.replace(/<[^>]*>/g, ""), app.read(`esc(${JSON.stringify(evidenceNative("evidence.legacy", body, "request", {}).text)})`));
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
  assert.equal(app.read("traceSegments(state.trace.result.items).length"), 120);
  assert.equal(app.read("traceSegments(state.trace.result.items).find(item => item.selected).order"), 81);
  assert.match(app.read("renderSecuritySession()"), /aria-label="选择请求 81" aria-pressed="true"/);
  assert.match(app.read("renderSecuritySession()"), /trace-axis-tick[^>]*><span>120<\/span>/);
  assert.doesNotMatch(app.read("renderSecuritySession()"), /相邻请求合并显示/);
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
  assert.deepEqual([...overview.matchAll(/data-action="security-trace-tab" data-tab="([^"]+)" aria-pressed=/g)].map(match => match[1]), ["overview", "risks", "protection", "request", "response", "body"]);
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

test("credential protection settings render every cable with its effective state and replace the detail form", async () => {
  const config = normalizeConfig(namedCodexConfigFixture({ alpha: '<Alpha> "线路"', beta: "Beta", gamma: "Gamma" }));
  config.credentialProtection.enabled = true;
  config.virtualProviders.cabletidy_beta.credentialProtection = false;
  config.virtualProviders.cabletidy_gamma.credentialProtection = true;
  config.cables.beta.target = "claude-code";
  config.virtualProviders.cabletidy_beta.ingressProtocol = "anthropic.messages";
  config.cables.gamma.target = "generic-env";
  const app = await controller(config);
  const html = app.read("renderSettings()");
  assert.match(html, /&lt;Alpha&gt; &quot;线路&quot;/);
  assert.match(html, /data-protection-cable="alpha"[^>]*checked/);
  assert.doesNotMatch(html, /data-protection-cable="beta"[^>]*checked/);
  assert.match(html, /data-protection-cable="gamma"[^>]*checked/);
  assert.match(html, /配置保护线路/);
  assert.match(html, /已选 2 \/ 3 条/);
  assert.match(html, /name="mappingTtlValue"[^>]*value="1"/);
  assert.match(html, /value="hours" selected/);
  assert.doesNotMatch(html, /<small>[^<]* · (alpha|beta|gamma)<\/small>/);
  assert.equal((html.match(/保存后对新请求生效/g) || []).length, 1);
  assert.match(html, /<details class="protection-scope"><summary>保护范围说明/);
  assert.doesNotMatch(app.read("renderCableDetail()"), /cable-protection-form|cable-protection-title/);
});

test("credential protection can save its global switch and TTL before any cables exist", async () => {
  const app = await controller(normalizeConfig({}));
  assert.match(app.read("renderSettings()"), /暂无线路/);
  await app.submit(formNode("protection-settings-form", { enabled: "on", mappingTtlValue: "30", mappingTtlUnit: "days" }));
  assert.deepEqual(app.persisted().credentialProtection, { enabled: true, mappingTtlSeconds: 2592000 });
  assert.deepEqual(app.persisted().virtualProviders, {});
});

test("credential protection settings save the global toggle, individual exclusions and idle timeout in one commit", async () => {
  const config = normalizeConfig(namedCodexConfigFixture({ alpha: "Alpha", beta: "Beta" }));
  config.virtualProviders.cabletidy_alpha.credentialProtection = false;
  const app = await controller(config);
  await app.submit(formNode("protection-settings-form", { enabled: "on", mappingTtlValue: "1", mappingTtlUnit: "minutes", "cableProtection:alpha": "on" }));
  let saved = app.persisted();
  assert.deepEqual(saved.credentialProtection, { enabled: true, mappingTtlSeconds: 60 });
  assert.equal(saved.virtualProviders.cabletidy_alpha.credentialProtection, true);
  assert.equal(saved.virtualProviders.cabletidy_beta.credentialProtection, false);
  assert.equal(saved.revision, config.revision + 1);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 1);
  await app.action("refresh");
  assert.match(app.read("renderSettings()"), /data-protection-cable="alpha"[^>]*checked/);
  assert.doesNotMatch(app.read("renderSettings()"), /data-protection-cable="beta"[^>]*checked/);
  const disabledLines = [{ name: "cableProtection:alpha", checked: true }, { name: "cableProtection:beta", checked: false }];
  await app.submit(formNode("protection-settings-form", { mappingTtlValue: "1", mappingTtlUnit: "hours" }, disabledLines));
  saved = app.persisted();
  assert.deepEqual(saved.credentialProtection, { enabled: false, mappingTtlSeconds: 3600 });
  assert.equal(saved.virtualProviders.cabletidy_alpha.credentialProtection, true);
  assert.equal(saved.virtualProviders.cabletidy_beta.credentialProtection, false);
});

test("credential protection master switch disables lines while select-all supports mixed and shared choices", async () => {
  const app = await controller();
  const inputs = ["alpha", "beta", "gamma"].map((id, index) => ({
    name: `cableProtection:${id}`, checked: index === 0,
    dataset: { protectionCable: id, protectionProvider: index < 2 ? "shared" : "other" },
    matches: selector => selector === '#protection-settings-form input[type="checkbox"]',
    closest: () => form,
  }));
  const global = { name: "enabled", checked: true, dataset: {}, matches: inputs[0].matches, closest: () => form };
  const all = { checked: true, dataset: { protectionAll: "" }, matches: inputs[0].matches, closest: () => form };
  const count = { textContent: "" };
  const form = { querySelectorAll: () => inputs, querySelector: selector => ({ '[name="enabled"]': global, '[data-protection-all]': all, '[data-protection-count]': count })[selector] || null };
  app.change(global);
  assert.equal(count.textContent, "已选 1 / 3 条");
  assert.deepEqual(inputs.map(input => input.checked), [true, false, false]);
  assert.equal(all.indeterminate, true);
  assert.equal(all.checked, false);
  all.checked = true;
  app.change(all);
  assert.deepEqual(inputs.map(input => input.checked), [true, true, true]);
  inputs[0].checked = false;
  app.change(inputs[0]);
  assert.deepEqual(inputs.map(input => input.checked), [false, false, true]);
  assert.equal(global.checked, true);
  assert.equal(all.indeterminate, true);
  global.checked = false;
  app.change(global);
  assert.deepEqual(inputs.map(input => input.checked), [false, false, true]);
  assert.ok(inputs.every(input => input.disabled));
  assert.equal(all.disabled, true);
  global.checked = true;
  app.change(global);
  assert.ok(inputs.every(input => !input.disabled));
  assert.deepEqual(inputs.map(input => input.checked), [false, false, true]);
  all.checked = false;
  app.change(all);
  assert.deepEqual(inputs.map(input => input.checked), [false, false, false]);
  assert.equal(all.indeterminate, false);
});

test("credential protection displays IDs only for duplicate line names", async () => {
  const config = normalizeConfig(namedCodexConfigFixture({ alpha: "Alpha", beta: "Beta", gamma: "Gamma" }));
  const app = await controller(config);
  const html = app.read('state.config.cables.beta.name = "Alpha"; renderSettings()');
  assert.match(html, /<small>Codex · alpha<\/small>/);
  assert.match(html, /<small>Codex · beta<\/small>/);
  assert.match(html, /Gamma<small>Codex<\/small>/);
});

test("credential protection duration saves all units as exact integer seconds", async () => {
  const app = await controller(normalizeConfig({}));
  for (const [value, unit, seconds] of [["61", "seconds", 61], ["1.5", "minutes", 90], ["0.5", "hours", 1800], ["2", "days", 172800]]) {
    await app.submit(formNode("protection-settings-form", { mappingTtlValue: value, mappingTtlUnit: unit }));
    assert.equal(app.persisted().credentialProtection.mappingTtlSeconds, seconds);
  }
  for (const [value, unit] of [["0.01", "minutes"], ["31", "days"], ["1", "unknown"]]) {
    const before = app.persisted();
    const form = formNode("protection-settings-form", { mappingTtlValue: value, mappingTtlUnit: unit });
    await app.submit(form);
    assert.ok(form.feedback);
    assert.deepEqual(app.persisted(), before);
  }
  assert.equal(app.read('protectionTtlSeconds(String(61 / 3600), "hours")'), 61);
});

test("credential protection merges duration values and units as one setting", async () => {
  const app = await controller();
  const value = (number, unit) => [
    ["mappingTtlValue", "number", {}, "", String(number)],
    ["mappingTtlUnit", "select-one", {}, "", unit],
  ];
  const merged = (base, local, remote) => app.read(`mergeProtectionSettingsFields(${JSON.stringify(base)}, ${JSON.stringify(local)}, ${JSON.stringify(remote)})`);
  const base = value(1, "hours");
  // Converting the local display is compatible with a remote duration change.
  assert.deepEqual(JSON.parse(JSON.stringify(merged(base, value(60, "minutes"), value(2, "hours")))), value(2, "hours"));
  assert.equal(merged(base, value(30, "minutes"), value(2, "hours")), null);
  assert.deepEqual(JSON.parse(JSON.stringify(merged(base, value(0.5, "hours"), value(30, "minutes")))), value(0.5, "hours"));
});

test("invalid or rejected credential protection saves leave all settings unchanged", async () => {
  for (const failure of ["invalid", "conflict", "persist"]) {
    const app = await controller(undefined, { onCommit: () => failure === "invalid" ? null : {
      status: failure === "conflict" ? 409 : 500, body: { error: { message: "Save rejected" } },
    } });
    const before = app.persisted();
    const form = formNode("protection-settings-form", { enabled: "on", mappingTtlValue: failure === "invalid" ? "59" : "60", mappingTtlUnit: "seconds", "cableProtection:relay": "on" });
    await app.submit(form);
    assert.deepEqual(app.persisted(), before);
    assert.deepEqual(JSON.parse(app.read("JSON.stringify(state.candidate)")), before);
    assert.ok(form.feedback);
  }
});

test("protection shows escaped A/B, highlights A alongside risks and decorates only replaced trace segments", async () => {
  const app = await controller();
  const mapping = { id: "CTSEC_v1_id", original: "<token>🙂", replacement: "CTSEC_v1_id", requestCount: 1, responseCount: 1, createdAtMs: 1000, expiresAtMs: 3601000 };
  const record = { id: "protected", protection: { enabled: true, status: "completed", requestCount: 1, responseCount: 1, mappingTtlSeconds: 3600, mappings: [mapping] }, requestContent: { state: "complete", total: 1, counts: { user: 1 }, items: [{ index: 0, kind: "user", preview: "prefix <token>🙂", protectionRanges: { preview: [{ start: 7, end: 16, mappingId: mapping.id }] }, riskRanges: { preview: [{ start: 7, end: 16, findingId: "risk" }] } }] } };
  app.read(`state.page = "security-session"; state.security.detail = ${JSON.stringify(record)}; state.trace.tab = "protection"`);
  let html = app.read("renderTraceInspector()");
  assert.ok(html.includes("&lt;token&gt;🙂")); assert.match(html, /CTSEC_v1_id|映射创建|到期时间/); assert.doesNotMatch(html, /<token>/);
  app.read('state.trace.tab = "request"'); html = app.read("renderTraceInspector()");
  assert.match(html, /security-risk-hit security-protection-hit/); assert.doesNotMatch(html, /CTSEC_v1_id/);
  assert.equal(app.read(`protectionOccurred(${JSON.stringify(record)})`), true);
  assert.equal(app.read('protectionOccurred({protection:{enabled:true,requestCount:0,responseCount:0}})'), false);
});

test("protection groups original credentials, folds unused mappings and distinguishes operation counts", async () => {
  const app = await controller();
  const mappings = [
    {id:"new", original:"same A", replacement:"B-new", requestCount:2, responseCount:1, reused:false},
    {id:"reuse", original:"same A", replacement:"B-old", requestCount:1, responseCount:0, reused:true},
    {id:"response", original:"response A", replacement:"B-response", requestCount:0, responseCount:2, reused:true},
    {id:"unused", original:"unused A", replacement:"B-unused", requestCount:0, responseCount:0, reused:true},
  ];
  const record = {protection:{enabled:true,status:"completed",requestCount:3,responseCount:3,mappings}};
  const html = app.read(`renderProtection(${JSON.stringify(record)})`);
  assert.match(html, /涉及 <b>2<\/b> 个凭据 · 请求替换 <b>3<\/b> 次 · 响应还原 <b>3<\/b> 次/);
  assert.equal((html.match(/class="security-finding protection-mapping"/g)||[]).length, 2);
  assert.ok(html.indexOf('会话已有映射 · 1 条') < html.indexOf('class="security-finding protection-mapping"'));
  assert.doesNotMatch(html, /<details[^>]+ open/);
  assert.match(html, /请求原文（3 处）/); assert.match(html, /响应原文（2 处）/);
  assert.doesNotMatch(html, /原文（0 处）/);
  assert.match(html, /新建/); assert.match(html, /复用/); assert.match(html, /本次续期到期时间/);
});

test("protection separates disabled, zero operations, failure and unavailable evidence", async () => {
  const app = await controller();
  const html = protection => app.read(`renderProtection(${JSON.stringify({protection})})`);
  assert.match(html(null), /此请求未启用凭据保护/);
  assert.match(html({enabled:true,status:"completed",mappings:[],requestCount:0,responseCount:0}), /已启用，本次没有替换或还原/);
  const failed = html({enabled:true,status:"failed",reason:"request_protection_failed"});
  assert.match(failed, /请求未发送到上游/); assert.doesNotMatch(failed, /已启用，本次没有/);
  const unavailable = html({enabled:true,status:"completed",requestCount:3,responseCount:1,evidenceState:"unavailable",mappings:[]});
  assert.match(unavailable, /保护证据不可用/); assert.match(unavailable, /凭据数量不可确认/);
  assert.doesNotMatch(unavailable, /涉及 <b>0|已启用，本次没有/);
  assert.match(html({enabled:true,status:"failed",reason:"response_restore_failed",mappings:[]}), /响应还原未完成/);
});

test("modal locates every occurrence, preserves tab/content and copies A", async () => {
  const ranges = [{mappingId:"mapping",start:11,end:14},{mappingId:"mapping",start:19,end:22}];
  const app = await controller(undefined, {onSecurity:url => {
    if (url.includes('/protection-locations?')) return {body:{items:ranges.map(r=>({...r,snapshotId:"request"})),total:2}};
    if (url.includes('/body?')) return {body:{chunks:[{start:0,end:25,content:"中文🙂 A<& and A<& tail"}],protectionRanges:ranges,riskRanges:[{start:11,end:14}]}};
  }});
  app.read('state.page="security-session"; state.trace.tab="protection"; state.security.detail={id:"protected",findings:[{id:"risk",ruleId:"SEC-SECRET-001",evidence:{bodyRef:{snapshotId:"request",start:11,end:14,matchKind:"sensitive"}}}],requestContent:{keep:true},protection:{enabled:true,mappings:[{id:"mapping",original:"A<&",requestCount:2,responseCount:0}]}}');
  await app.action("security-protection-source",{dataset:{id:"mapping",side:"request"}});
  assert.equal(app.read('state.trace.tab'), "protection");
  assert.equal(app.read('state.security.detail.requestContent.keep'), true);
  let html = app.node('#protection-source-dialog').innerHTML;
  assert.match(html, /1 \/ 2 处/); assert.match(html, /字节 11–14/);
  assert.match(html, /security-protection-hit security-risk-hit security-body-hit/);
  assert.match(html, /A&lt;&amp;/);
  await app.action("security-protection-step",{dataset:{step:"1"}});
  html = app.node('#protection-source-dialog').innerHTML;
  assert.match(html, /2 \/ 2 处/); assert.match(html, /字节 19–22/);
  await app.action("security-protection-copy",{dataset:{id:"mapping"}});
  assert.ok(app.messages.includes('A<&'));
  await app.action("security-protection-close");
  assert.equal(app.read('state.security.protectionSource'), null);
});

for (const change of ["selection", "tab", "close"]) test(`late protection modal cannot overwrite a newer ${change}`, async () => {
  let resolvePage;
  const pending = new Promise(resolve => { resolvePage = resolve; });
  const app = await controller(undefined, { onSecurity: url => url.includes("/protection-locations?") ? pending : undefined });
  app.read('state.page = "security-session"; state.security.detail = {id:"old",protection:{enabled:true,mappings:[{id:"mapping",original:"old A",requestCount:1} ]},findings:[],bodySnapshots:[]}; state.trace.tab = "protection"');
  const navigation = app.action("security-protection-source", { dataset: { id: "mapping", side: "request" } });
  await setImmediate();
  if (change === "selection") app.read('state.security.detail = {id:"new",findings:[],bodySnapshots:[]}; state.security.detailSequence++');
  else if (change === "tab") app.read('state.trace.tab = "response"; state.security.contentNavigation = null');
  else await app.action("security-protection-close");
  const previous = app.node('#protection-source-dialog').innerHTML;
  resolvePage({ body: { items: [{snapshotId:"request",start:0,end:5}],total:1 } });
  await navigation;
  assert.equal(app.node('#protection-source-dialog').innerHTML,previous);
  assert.equal(app.read('state.security.detail.requestContent'), undefined);
  if (change === "selection") assert.equal(app.read('state.security.detail.id'), "new");
  else if (change === "tab") assert.equal(app.read('state.trace.tab'), "response");
  assert.equal(app.requests.filter(r=>r.url.includes('/body?')).length,0);
});

test('credential evidence UI presents actual states, low candidates and legacy uncertainty',async()=>{
  const app=await controller();
  const strong={candidateId:'s',snapshotId:'request',confidence:'strong',credentialType:'password',source:'json_field',location:'request.metadata.password',rawStart:24,rawEnd:28,replacementStatus:'replaced',reason:'executed'};
  const weak={...strong,candidateId:'w',confidence:'low',source:'source_assignment',replacementStatus:'not_replaced',reason:'policy_not_selected',location:'request.input.<img>'};
  const blocked={...strong,candidateId:'b',replacementStatus:'not_replaced',reason:'protection_credential_in_protocol_structure'};
  const render=record=>app.read(`renderProtection(${JSON.stringify(record)})`);
  let html=render({credentialDetection:{snapshotId:'request',candidateCount:3,lowConfidenceCount:1},protection:{enabled:true,status:'completed',mappings:[],decisions:[strong,weak,blocked]}});
  assert.match(html,/低置信候选 1 处/);assert.match(html,/未替换候选 · 2 处/);assert.match(html,/低置信度/);assert.match(html,/结构中无法安全替换/);assert.match(html,/request.input.&lt;img&gt;/);assert.doesNotMatch(html,/<img>/);
  html=render({credentialDetection:{snapshotId:'request',candidateCount:1},findings:[{evidence:{credentialCandidates:[{...strong,replacementStatus:'not_replaced',reason:'protection_disabled'}]}}]});
  assert.match(html,/未替换 · 保护关闭/);
  html=render({credentialDetection:{snapshotId:'request',candidateCount:1},protection:{enabled:true,mappings:[],decisions:[{...strong,replacementStatus:undefined}]}});
  assert.match(html,/替换结果未在此处记录/);assert.doesNotMatch(html,/未替换候选/);
  assert.equal(app.read(`credentialStatus(${JSON.stringify({...weak,replacementStatus:'replaced'})})`),'已替换','confidence cannot override actual state');
  html=app.read(`renderSecurityFindings(${JSON.stringify({findings:[{id:'legacy',ruleId:'SEC-SECRET-001',ruleVersion:'2',confidence:'medium',confidenceReason:'credential_pattern_match',evidence:{}}]})})`);
  assert.match(html,/v2/);assert.doesNotMatch(html,/已替换/);
});
