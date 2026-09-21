import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";
import { normalizeConfig } from "../src/config.mjs";
import { publicCodexCatalog } from "../src/codex-catalog.mjs";
import { validateConfig } from "../src/validation.mjs";
import { catalogFixture, codexConfigFixture } from "./helpers/codex-fixture.mjs";
import { configurationId, providerIdForConfiguration, normalizeConfigurationIdentities, configurationBaseUrl } from "../web/config-identity.js";

const source = (await fs.readFile(new URL("../web/app.js", import.meta.url), "utf8"))
  .replace(/^import .* from "\.\/config-identity\.js";\n/, "");

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
    configurationId, providerIdForConfiguration, normalizeConfigurationIdentities, configurationBaseUrl,
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
    URL,
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

for (const formId of ["suite-upstream-form", "upstream-form"]) {
  test(formId + " commits edits when a named input shadows the form ID", async () => {
    const app = await controller();
    const form = formNode(formId, {
      id: "relay", name: "Edited relay", protocol: "openai.responses",
      baseUrl: "https://example.invalid/v1", secret: "",
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

test("editing connection fields retains unrelated upstream settings", async () => {
  const config = normalizeConfig(codexConfigFixture());
  Object.assign(config.upstreams.relay, {
    envKey: "RELAY_API_KEY",
    auth: { header: "x-relay-key" },
    enabled: false,
  });
  const app = await controller(config);
  await app.submit(formNode("suite-upstream-form", {
    id: "relay", name: "Edited relay", protocol: "openai.responses",
    baseUrl: "https://example.invalid/v1", secret: "",
  }));
  const upstream = app.persisted().upstreams.relay;
  for (const key of ["auth", "enabled"]) {
    assert.deepEqual(upstream[key], config.upstreams.relay[key], key);
  }
  for (const key of ["envKey", "requestMaxRetries", "streamMaxRetries", "streamIdleTimeoutMs", "requiresOpenaiAuth", "supportsWebsockets"]) {
    assert.equal(upstream[key], undefined, key);
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

test("the catalog action is labelled refresh model list", async () => {
  const app = await controller();
  assert.match(app.read("codexCatalogStatus()"), /刷新模型列表/);
  assert.doesNotMatch(app.read("codexCatalogStatus()"), /刷新目录/);
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
