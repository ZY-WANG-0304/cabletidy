import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";
import { normalizeConfig } from "../src/config.mjs";
import { publicCodexCatalog } from "../src/codex-catalog.mjs";
import { catalogFixture, codexConfigFixture } from "./helpers/codex-fixture.mjs";

const source = await fs.readFile(new URL("../web/app.js", import.meta.url), "utf8");

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
    window: {
      ...node(),
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
      if (url === "/api/v1/config/commit") {
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
        "/api/v1/catalog": {},
        "/api/v1/events": { events: [] },
        "/api/v1/codex/models": publicCodexCatalog(options.catalog || catalogFixture()),
        "/api/v1/codex/models?refresh=1": options.refreshCatalog || publicCodexCatalog(options.catalog || catalogFixture()),
        "/api/v1/targets/apply": { target: "codex" },
      };
      assert.ok(url in responses, "Unexpected endpoint: " + url);
      return { ok: true, json: async () => responses[url] };
    },
    FormData: class {
      constructor(form) { return new Map(Object.entries(form.fields)); }
    },
    CSS: { escape: (value) => value },
    structuredClone,
    setTimeout() {},
  });
  vm.runInContext(source, context);
  await setImmediate();
  return {
    messages, requests, confirmations,
    controls: (items) => { controls = items; },
    node: (selector) => nodes.get(selector),
    persisted: () => clone(persisted),
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
    action: (action) => vm.runInContext(`handleAction(${JSON.stringify(action)})`, context),
    async submit(form) {
      context.submittedForm = form;
      await vm.runInContext("handleFormSubmit({ preventDefault() {} }, submittedForm)", context);
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

for (const formId of ["suite-upstream-form", "upstream-form"]) {
  test(formId + " commits edits when a named input shadows the form ID", async () => {
    const app = await controller();
    const form = formNode(formId, {
      id: "relay", name: "Edited relay", protocol: "openai.responses",
      baseUrl: "https://example.invalid/v1", secret: "", envKey: "",
    });
    // HTMLFormElement exposes the named input as form.id.
    form.id = { name: "id", value: "relay" };
    await app.submit(form);
    assert.equal(app.persisted().upstreams.relay.name, "Edited relay");
    assert.equal(app.read("state.config.upstreams.relay.name"), "Edited relay");
    assert.equal(app.requests.filter(({ url }) => url.endsWith("/config/commit")).length, 1);
    assert.equal(app.read("state.busy"), false);
  });
}

test("creation commits immediately and clears transient secrets", async () => {
  const app = await controller(normalizeConfig({}));
  app.read('state.page = "suite-create"');
  await app.submit(creationForm());
  assert.equal(app.read("state.page"), "suite-detail");
  const config = app.persisted();
  const binding = Object.values(config.bindings)[0];
  assert.equal(binding.name, "Development");
  assert.equal(Object.values(config.models)[0].clientModelId, "gpt-5.5");
  assert.equal(Object.values(Object.values(config.models)[0].upstreams)[0].upstreamModelId, "vendor-gpt");
  const commits = app.requests.filter(({ url }) => url.endsWith("/config/commit"));
  assert.equal(commits.length, 1);
  assert.deepEqual(Object.values(commits[0].body.upstreamSecrets), ["test-key"]);
  assert.equal(app.read("Object.keys(state.pendingSecrets.upstreamSecrets).length"), 0);
  assert.equal(app.requests.some(({ url }) => url.endsWith("/config/validate")), false);
  assert.doesNotMatch(app.read("renderDiagnostics()"), /配置校验|校验草稿/);
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

test("editing connection fields retains unrelated upstream settings", async () => {
  const config = normalizeConfig(codexConfigFixture());
  Object.assign(config.upstreams.relay, {
    auth: { header: "x-relay-key" },
    requestMaxRetries: 7, streamMaxRetries: 4, streamIdleTimeoutMs: 123000,
    requiresOpenaiAuth: true, supportsWebsockets: true, enabled: false,
  });
  const app = await controller(config);
  await app.submit(formNode("suite-upstream-form", {
    id: "relay", name: "Edited relay", protocol: "openai.responses",
    baseUrl: "https://example.invalid/v1", secret: "", envKey: "",
  }));
  const upstream = app.persisted().upstreams.relay;
  for (const key of ["auth", "requestMaxRetries", "streamMaxRetries", "streamIdleTimeoutMs", "requiresOpenaiAuth", "supportsWebsockets", "enabled"]) {
    assert.deepEqual(upstream[key], config.upstreams.relay[key], key);
  }
  assert.equal(upstream.name, "Edited relay");
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
  Object.assign(select, { name: "", type: "select-one", dataset: { suiteModelClient: "" } });
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

test("the catalog action is labelled refresh model list", async () => {
  const app = await controller();
  assert.match(app.read("codexCatalogStatus()"), /刷新模型列表/);
  assert.doesNotMatch(app.read("codexCatalogStatus()"), /刷新目录/);
});
