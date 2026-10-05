import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, validateConfig, resolveRequest, buildTargetArtifacts } from "./helpers/native.mjs";

function legacyConfig(target = "codex") {
  const protocol = target === "codex" ? "openai.responses" : "anthropic.messages";
  return {
    version: 1,
    upstreams: { relay: { id: "relay", protocol, baseUrl: "https://example.invalid/v1" } },
    models: {
      "gpt-5.6-sol": { id: "gpt-5.6-sol", clientModelId: "gpt-6-sol", aliases: ["gpt-6-sol", "fast"], capabilities: ["streaming"], upstreams: { relay: { upstreamModelId: "vendor-sol", capabilityOverrides: ["tools"] } } },
      "gpt-5.6-luna": { id: "gpt-5.6-luna", clientModelId: "gpt-6-luna", aliases: ["gpt-6-luna"], upstreams: { relay: {} } },
      "gpt-5.6-sol-2": { clientModelId: "gpt-5.6-sol", aliases: ["gpt-5.6-sol"], upstreams: { relay: { upstreamModelId: "vendor-old-sol" } } },
      "gpt-5.6-luna-2": { clientModelId: "gpt-5.6-luna", aliases: ["gpt-5.6-luna"], upstreams: { relay: {} } },
    },
    routes: { route: { backends: [{ upstream: "relay", models: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-sol-2", "gpt-5.6-luna-2"] }] } },
    virtualProviders: { cabletidy_relay: { id: "cabletidy_relay", route: "route", ingressProtocol: protocol, allowedModels: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-sol-2", "gpt-5.6-luna-2"], defaultModel: "gpt-5.6-sol" } },
    bindings: { relay: { id: "relay", name: "relay", target, virtualProvider: "cabletidy_relay", defaultModel: "gpt-5.6-sol" } },
  };
}

for (const target of ["codex", "claude-code"]) {
  test(`${target}: migration removes hidden ID collisions and preserves mappings and defaults`, () => {
    const input = legacyConfig(target);
    input.models["gpt-5.6-sol"].name = "Saved display metadata";
    const before = structuredClone(input);
    const result = validateConfig(input);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const c = result.config;
    const p = c.virtualProviders.cabletidy_relay;
    assert.deepEqual(Object.keys(p.models), ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-luna"]);
    assert.equal(c.version, 2);
    assert.equal(c.models, undefined);
    assert.equal(p.allowedModels, undefined);
    assert.equal(c.routes.route.backends[0].models, undefined);
    assert.equal(p.defaultModel, "gpt-6-sol");
    assert.equal(c.bindings.relay.defaultModel, "gpt-6-sol");
    assert.deepEqual(p.models["gpt-6-sol"].aliases, ["fast"]);
    assert.equal(p.models["gpt-6-sol"].name, "Saved display metadata");
    for (const field of ["id", "clientModelId", "upstreams"]) assert.equal(p.models["gpt-6-sol"][field], undefined);
    assert.equal(resolveRequest(c, p, { model: "gpt-5.6-sol" }).upstreamModelId, "vendor-old-sol");
    assert.equal(resolveRequest(c, p, { model: "fast", tools: [{}] }).upstreamModelId, "vendor-sol");
    assert.equal(resolveRequest(c, p, {}).upstreamModelId, "vendor-sol");
    assert.equal(resolveRequest(c, p, { model: "gpt-5.6-sol-2" }).upstreamModelId, "gpt-5.6-sol-2");
    assert.equal(buildTargetArtifacts(c, { bindingId: "relay" }).clientModelId, "gpt-6-sol");
    assert.deepEqual(normalizeConfig(c), c);
    assert.deepEqual(input, before);
  });
}

test("migration keeps same-named models isolated across providers", () => {
  const input = legacyConfig();
  input.upstreams.other = { ...input.upstreams.relay, id: "other" };
  input.models.other = { clientModelId: "gpt-6-sol", aliases: ["fast"], upstreams: { other: { upstreamModelId: "other-vendor" } } };
  input.routes.other = { backends: [{ upstream: "other", models: ["other"] }] };
  input.virtualProviders.cabletidy_other = { ...input.virtualProviders.cabletidy_relay, id: "cabletidy_other", route: "other", allowedModels: ["other"] };
  const result = validateConfig(input);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const c = result.config;
  assert.equal(resolveRequest(c, c.virtualProviders.cabletidy_relay, { model: "fast" }).upstreamModelId, "vendor-sol");
  assert.equal(resolveRequest(c, c.virtualProviders.cabletidy_other, { model: "fast" }).upstreamModelId, "other-vendor");
});

for (const defect of ["duplicate", "missing", "orphan", "wrong upstream", "mixed format", "invalid client name", "invalid aliases"]) {
  test(`migration rejects ${defect} without partially replacing legacy data`, () => {
    const input = legacyConfig();
    if (defect === "duplicate") input.models["gpt-5.6-luna"].clientModelId = "gpt-6-sol";
    if (defect === "missing") delete input.models["gpt-5.6-luna"];
    if (defect === "orphan") input.models.orphan = structuredClone(input.models["gpt-5.6-luna"]);
    if (defect === "wrong upstream") input.models["gpt-5.6-luna"].upstreams = { other: {} };
    if (defect === "mixed format") input.virtualProviders.cabletidy_relay.models = {};
    if (defect === "invalid client name") input.models["gpt-5.6-luna"].clientModelId = 42;
    if (defect === "invalid aliases") input.models["gpt-5.6-luna"].aliases = "not-an-array";
    const normalized = normalizeConfig(input);
    assert.equal(normalized.version, 1);
    assert.deepEqual(normalized.models, input.models);
    assert.deepEqual(normalized.virtualProviders.cabletidy_relay.allowedModels, input.virtualProviders.cabletidy_relay.allowedModels);
    assert.equal(validateConfig(normalized).ok, false);
  });
}

test("migration preserves Claude native default aliases instead of resolving them as internal IDs", () => {
  const input = legacyConfig("claude-code");
  input.models = { sonnet: { clientModelId: "claude-sonnet-4-6", aliases: [], upstreams: { relay: {} } } };
  input.routes.route.backends[0].models = ["sonnet"];
  Object.assign(input.virtualProviders.cabletidy_relay, { allowedModels: ["sonnet"], defaultModel: "sonnet" });
  input.bindings.relay.defaultModel = "sonnet";
  const c = normalizeConfig(input);
  assert.equal(c.virtualProviders.cabletidy_relay.defaultModel, "sonnet");
  assert.equal(c.bindings.relay.defaultModel, "sonnet");
  assert.equal(buildTargetArtifacts(c, { bindingId: "relay" }).clientModelId, "sonnet");
});

test("Claude family and subagent selections migrate through client names to upstream mappings", () => {
  const input = legacyConfig("claude-code");
  const fields = ["opus", "sonnet", "fable", "haiku", "subagent"];
  input.bindings.relay.claude = { models: Object.fromEntries(fields.map((field) => [field, "gpt-5.6-sol"])) };
  const result = validateConfig(input);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const c = result.config;
  const vars = buildTargetArtifacts(c, { bindingId: "relay" }).environment.vars;
  for (const field of fields) {
    const variable = field === "subagent" ? "CLAUDE_CODE_SUBAGENT_MODEL" : `ANTHROPIC_DEFAULT_${field.toUpperCase()}_MODEL`;
    assert.equal(c.bindings.relay.claude.models[field], "gpt-6-sol");
    assert.equal(vars[variable], "gpt-6-sol");
    assert.equal(resolveRequest(c, c.virtualProviders.cabletidy_relay, { model: vars[variable] }).upstreamModelId, "vendor-sol");
  }
  assert.deepEqual(normalizeConfig(c), c);
});

for (const alias of ["best", "opus", "sonnet", "fable", "haiku", "opusplan"]) {
  test(`Claude migration respects field-specific semantics for the native alias ${alias}`, () => {
    const input = legacyConfig("claude-code");
    input.models = { [alias]: { clientModelId: "client-model", upstreams: { relay: { upstreamModelId: "vendor-model" } } } };
    input.routes.route.backends[0].models = [alias];
    Object.assign(input.virtualProviders.cabletidy_relay, { allowedModels: [alias], defaultModel: alias });
    Object.assign(input.bindings.relay, { defaultModel: alias, claude: { models: { sonnet: alias, subagent: alias } } });
    const c = normalizeConfig(input);
    assert.equal(validateConfig(c).ok, true);
    assert.equal(c.virtualProviders.cabletidy_relay.models["client-model"].aliases, undefined);
    const vars = buildTargetArtifacts(c, { bindingId: "relay" }).environment.vars;
    assert.equal(c.virtualProviders.cabletidy_relay.defaultModel, alias);
    assert.equal(vars.ANTHROPIC_MODEL, alias);
    assert.equal(vars.ANTHROPIC_DEFAULT_SONNET_MODEL, "client-model");
    assert.equal(vars.CLAUDE_CODE_SUBAGENT_MODEL, ["opus", "sonnet", "fable", "haiku"].includes(alias) ? alias : "client-model");
    assert.equal(resolveRequest(c, c.virtualProviders.cabletidy_relay, { model: vars.ANTHROPIC_DEFAULT_SONNET_MODEL }).upstreamModelId, "vendor-model");
  });
}

test("Claude selection migration only resolves IDs owned by the binding's provider", () => {
  const input = legacyConfig("claude-code");
  input.models.other = { clientModelId: "other-client", upstreams: { relay: { upstreamModelId: "other-vendor" } } };
  input.routes.other = { backends: [{ upstream: "relay", models: ["other"] }] };
  input.virtualProviders.cabletidy_other = { ingressProtocol: "anthropic.messages", route: "other", allowedModels: ["other"] };
  input.bindings.other = { target: "claude-code", virtualProvider: "cabletidy_other", claude: { models: { sonnet: "other", subagent: "gpt-5.6-sol", haiku: "unconfigured-client" } } };
  const c = normalizeConfig(input);
  assert.deepEqual(c.bindings.other.claude.models, { sonnet: "other-client", subagent: "gpt-5.6-sol", haiku: "unconfigured-client" });
  const vars = buildTargetArtifacts(c, { bindingId: "other" }).environment.vars;
  assert.equal(resolveRequest(c, c.virtualProviders.cabletidy_other, { model: vars.ANTHROPIC_DEFAULT_SONNET_MODEL }).upstreamModelId, "other-vendor");
});

test("client names retain case, separators and length without ID slugification", () => {
  const c = normalizeConfig(legacyConfig());
  const p = c.virtualProviders.cabletidy_relay;
  const name = "Vendor/Model:" + "X".repeat(80);
  p.models = { [name]: { upstreamModelId: "mapped" }, "vendor/model": {} };
  assert.equal(validateConfig(c).ok, true);
  assert.equal(resolveRequest(c, p, { model: name }).upstreamModelId, "mapped");
  assert.equal(resolveRequest(c, p, { model: name.toLowerCase() }).model.matchedModel, null);
});
