import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeConfig } from "./helpers/native.mjs";
import { publicCodexCatalog, planCodexCatalog, validateCodexChanges, catalogEntryForProfile } from "./helpers/native.mjs";
import { prepareCodexArtifacts, applyCodexArtifacts, publicArtifacts } from "./helpers/native.mjs";
import { readCodexConfig } from "./helpers/native.mjs";
import { catalogFixture, codexConfigFixture } from "./helpers/codex-fixture.mjs";

async function fixture(t) {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-catalog-test-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  return {
    config: normalizeConfig(codexConfigFixture()),
    options: { codexHome, bindingId: "relay", paths: { backups: path.join(codexHome, "backups") }, loadCatalog: async () => catalogFixture() },
    root: path.join(codexHome, "config.toml"),
  };
}

function enableOverrides(config, window = 128000) {
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].codex = { metadataMode: "override", inputModalities: ["text"] };
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].contextWindow = window;
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].capabilities = ["streaming", "tools", "reasoning", "parallel_tool_calls"];
}

function restoreOfficial(config) {
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].codex = { metadataMode: "official" };
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].capabilities = codexConfigFixture().virtualProviders.cabletidy_relay.models["gpt-5.5"].capabilities;
}

test("public official catalog omits prompts and rejects third-party entries as selectable models", () => {
  const snapshot = catalogFixture();
  snapshot.catalog.models.push({ slug: "third-party", supported_in_api: true });
  const result = publicCodexCatalog(snapshot);
  assert.deepEqual(result.models.map((model) => model.id), ["gpt-5.5", "gpt-5.6-sol"]);
  assert.doesNotMatch(JSON.stringify(result), /instructions|Official base/);
});

test("official mode keeps one config file without forced effort or a generated catalog", async (t) => {
  const { config, options } = await fixture(t);
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].contextWindow = 1000000;
  const artifacts = await prepareCodexArtifacts(config, options);
  assert.deepEqual(artifacts.files.map((file) => file.path), ["config.toml"]);
  const settings = readCodexConfig(artifacts.files[0].contents);
  assert.equal(settings.model, "gpt-5.5");
  assert.equal(settings.model_catalog_json, undefined);
  assert.equal(settings.model_reasoning_effort, undefined);
  assert.equal(settings.model_context_window, undefined);
  assert.equal(settings.model_providers.cabletidy_relay.env_key, undefined);
  const publicView = publicArtifacts(artifacts);
  assert.equal(publicView.catalogPlan, undefined);
  assert.equal(Object.hasOwn(publicView, "localSecret"), false);
  assert.equal(Object.hasOwn(publicView.environment, "value"), false);
});

test("passthrough can be applied without a model catalog and preserves the client's model choice", async (t) => {
  const { config, options, root } = await fixture(t);
  config.virtualProviders.cabletidy_relay.models = {};
  delete config.virtualProviders.cabletidy_relay.defaultModel;
  delete config.bindings.relay.defaultModel;
  options.loadCatalog = async () => { throw new Error("catalog must not be needed"); };
  let artifacts = await prepareCodexArtifacts(config, options);
  assert.equal(readCodexConfig(artifacts.files[0].contents).model, undefined);
  assert.equal(artifacts.clientModelId, null);
  await fs.writeFile(root, 'model = "client-selected-model"\nmodel_reasoning_effort = "high"\n');
  artifacts = await prepareCodexArtifacts(config, options);
  await applyCodexArtifacts(artifacts, options);
  const settings = readCodexConfig(await fs.readFile(root, "utf8"));
  assert.equal(settings.model, "client-selected-model");
  assert.equal(settings.model_reasoning_effort, "high");
  assert.equal(settings.model_provider, "cabletidy_relay");
  assert.equal(settings.model_providers.cabletidy_relay.wire_api, "responses");
  assert.deepEqual(artifacts.files.map(file => file.path), ["config.toml"]);
});

test("metadata-only settings preserve names and restore the original catalog after the last setting is removed", async (t) => {
  const { config, options, root } = await fixture(t);
  await fs.writeFile(root, 'model = "gpt-5.6-sol"\nmodel_context_window = 64000\n');
  enableOverrides(config);
  delete config.virtualProviders.cabletidy_relay.models["gpt-5.5"].upstreamModelId;
  delete config.virtualProviders.cabletidy_relay.defaultModel;
  delete config.bindings.relay.defaultModel;
  const artifacts = await prepareCodexArtifacts(config, options);
  assert.equal(JSON.parse(artifacts.files[1].contents).models[0].context_window, 128000);
  assert.equal(readCodexConfig(artifacts.files[0].contents).model, "gpt-5.6-sol");
  await applyCodexArtifacts(artifacts, options);
  config.virtualProviders.cabletidy_relay.models = {};
  options.loadCatalog = async () => { throw new Error("catalog must not be needed"); };
  await applyCodexArtifacts(await prepareCodexArtifacts(config, options), options);
  const settings = readCodexConfig(await fs.readFile(root, "utf8"));
  assert.equal(settings.model, "gpt-5.6-sol");
  assert.equal(settings.model_catalog_json, undefined);
  assert.equal(settings.model_context_window, 64000);
});

test("legacy context and compact values are preserved but require explicit metadata opt-in", async (t) => {
  const { config, options } = await fixture(t);
  delete config.virtualProviders.cabletidy_relay.models["gpt-5.5"].codex;
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].contextWindow = 1000000;
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].compact = { strategy: "auto", tokenLimit: 850000 };
  const artifacts = await prepareCodexArtifacts(config, options);
  assert.equal(artifacts.files.length, 1);
  assert.ok(artifacts.warnings.some((warning) => warning.includes("未同步")));
  assert.equal(config.virtualProviders.cabletidy_relay.models["gpt-5.5"].compact.tokenLimit, 850000);
});

test("overrides preserve all official instructions, tools and reasoning options", async (t) => {
  const { config, options } = await fixture(t);
  enableOverrides(config);
  const artifacts = await prepareCodexArtifacts(config, options);
  const catalog = JSON.parse(artifacts.files[1].contents);
  const expected = catalogFixture().catalog;
  expected.models[0].context_window = 128000;
  expected.models[0].max_context_window = 128000;
  expected.models[0].input_modalities = ["text"];
  assert.deepEqual(catalog, expected);
  assert.equal(catalog.models[0].slug, "gpt-5.5");
  assert.match(readCodexConfig(artifacts.files[0].contents).model_catalog_json, /model-catalogs/);
  assert.equal(artifacts.catalogSummary.sourceVersion, "codex-cli test");
});

test("unknown models, excessive windows and unsupported input types fail explicitly", () => {
  const config = normalizeConfig(codexConfigFixture());
  const plan = () => planCodexCatalog(config, config.virtualProviders.cabletidy_relay, catalogFixture());
  const profile = config.virtualProviders.cabletidy_relay.models["gpt-5.5"];
  config.virtualProviders.cabletidy_relay.models = { "non-gpt": profile };
  assert.throws(plan, /未匹配/);
  config.virtualProviders.cabletidy_relay.models = { "gpt-999": profile };
  assert.throws(plan, /未匹配/);
  config.virtualProviders.cabletidy_relay.models = { "gpt-5.5": profile };
  enableOverrides(config, 1000001);
  assert.throws(plan, /context window/);
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].contextWindow = 128000;
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].codex.inputModalities = ["text", "audio"];
  assert.throws(plan, /输入类型/);
  const snapshot = catalogFixture();
  snapshot.catalog.models[0].base_instructions = "";
  snapshot.catalog.models[0].model_messages = null;
  assert.throws(() => catalogEntryForProfile(snapshot, "gpt-5.5", config.virtualProviders.cabletidy_relay.models["gpt-5.5"]), /缺少指令/);
});

test("upstream vision restrictions are reflected in the catalog without changing instructions", () => {
  const config = normalizeConfig(codexConfigFixture());
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].capabilityOverrides = ["-vision"];
  const plan = planCodexCatalog(config, config.virtualProviders.cabletidy_relay, catalogFixture());
  assert.deepEqual(plan.catalog.models[0].input_modalities, ["text"]);
  assert.equal(plan.catalog.models[0].base_instructions, catalogFixture().catalog.models[0].base_instructions);
  assert.ok(plan.warnings.some((warning) => /vision/.test(warning)));
});

test("official hidden models remain selectable and source catalogs are not mutated", () => {
  const snapshot = catalogFixture();
  snapshot.catalog.models[0].visibility = "hide";
  const before = structuredClone(snapshot);
  const config = normalizeConfig(codexConfigFixture());
  enableOverrides(config);
  assert.ok(publicCodexCatalog(snapshot).models.some((model) => model.id === "gpt-5.5" && model.hidden));
  planCodexCatalog(config, config.virtualProviders.cabletidy_relay, snapshot);
  assert.deepEqual(snapshot, before);
});

test("only changed Codex models require validation; saved legacy models are not rewritten", async () => {
  const previous = normalizeConfig(codexConfigFixture());
  previous.virtualProviders.cabletidy_relay.models = { "legacy-alias": previous.virtualProviders.cabletidy_relay.models["gpt-5.5"] };
  const candidate = structuredClone(previous);
  let calls = 0;
  const load = async () => { calls++; return catalogFixture(); };
  candidate.upstreams.relay.name = "New display name";
  assert.deepEqual(await validateCodexChanges(candidate, previous, load), []);
  assert.equal(calls, 0);
  candidate.virtualProviders.cabletidy_relay.models["legacy-alias"].upstreamModelId = "changed-name";
  assert.match((await validateCodexChanges(candidate, previous, load))[0].message, /未匹配/);
  assert.deepEqual(Object.keys(candidate.virtualProviders.cabletidy_relay.models), ["legacy-alias"]);
});

test("switching a configuration to Codex validates its models even when their settings are unchanged", async () => {
  const previous = normalizeConfig(codexConfigFixture());
  previous.bindings.relay.target = "claude-code";
  previous.virtualProviders.cabletidy_relay.ingressProtocol = "anthropic.messages";
  previous.upstreams.relay.protocol = "anthropic.messages";
  previous.virtualProviders.cabletidy_relay.models = { "custom-client": {} };
  const candidate = structuredClone(previous);
  candidate.bindings.relay.target = "codex";
  candidate.virtualProviders.cabletidy_relay.ingressProtocol = "openai.responses";
  candidate.upstreams.relay.protocol = "openai.responses";
  const errors = await validateCodexChanges(candidate, previous, async () => catalogFixture());
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, "virtualProviders.cabletidy_relay.models.custom-client");
});

test("apply preserves other providers and multiline instructions, and is idempotent", async (t) => {
  const { config, options, root } = await fixture(t);
  const original = [
    '# User configuration',
    'model = "old" # current model',
    'model_provider = "other"',
    'developer_instructions = """',
    'model = "this is not a config assignment"',
    '[model_providers.cabletidy_relay]',
    '# >>> CABLETIDY MANAGED PROVIDER cabletidy_relay -->',
    '"""',
    'model_instructions_file = "/user/custom.md"',
    'model_reasoning_effort = "high"',
    '',
    '[model_providers."other"]',
    'name = "Keep me"',
    'base_url = "https://other.test/v1" # untouched',
    'env_key = "EXISTING_KEY"',
    '',
    '# >>> CABLETIDY MANAGED PROVIDER cabletidy_old -->',
    '[model_providers.cabletidy_old]',
    'base_url = "http://127.0.0.1:43101/v1"',
    'env_key = "LEGACY_LOCAL_KEY"',
    '# <<< CABLETIDY MANAGED PROVIDER cabletidy_old <--',
    '',
    '[model_providers."cabletidy_relay"]',
    'env_key = "OLD_KEY"',
    '[model_providers.cabletidy_relay.auth]',
    'command = "/old/helper"',
    '',
    '[mcp_servers.test]',
    'command = "/user/tool"',
  ].join('\n');
  await fs.writeFile(root, original);
  const artifacts = await prepareCodexArtifacts(config, options);
  assert.ok(artifacts.warnings.some((item) => item.includes("model_instructions_file")));
  const report = await applyCodexArtifacts(artifacts, options);
  assert.deepEqual(report.applied, [root]);
  assert.deepEqual((await fs.readdir(options.codexHome)).sort(), ["backups", "config.toml"]);
  const first = await fs.readFile(root, "utf8");
  const current = readCodexConfig(first);
  const before = readCodexConfig(original);
  assert.equal(current.developer_instructions, before.developer_instructions);
  assert.equal(current.model_instructions_file, before.model_instructions_file);
  assert.equal(current.model_reasoning_effort, "high");
  assert.deepEqual(current.model_providers.other, before.model_providers.other);
  assert.deepEqual(current.model_providers.cabletidy_old, before.model_providers.cabletidy_old);
  assert.deepEqual(current.mcp_servers, before.mcp_servers);
  assert.equal(current.model_provider, "cabletidy_relay");
  assert.equal((first.match(/^model_provider\s*=/gm) || []).length, 1);
  assert.doesNotMatch(first, /profiles\./);
  assert.equal(current.model_providers.cabletidy_relay.auth, undefined);
  assert.equal(current.model_providers.cabletidy_relay.env_key, undefined);
  assert.ok(
    first.indexOf("[model_providers.cabletidy_relay]") <
      first.indexOf('[model_providers."other"]'),
  );
  assert.ok(first.includes('base_url = "https://other.test/v1" # untouched'));
  await applyCodexArtifacts(artifacts, options);
  assert.equal(await fs.readFile(root, "utf8"), first);
});

test("catalog apply keeps foreign entries and restores the original catalog and window", async (t) => {
  const { config, options, root } = await fixture(t);
  const previous = catalogFixture().catalog;
  previous.models[0].base_instructions = "User custom base";
  previous.models.push({ slug: "foreign-model", base_instructions: "foreign prompt" });
  const foreignFile = path.join(options.codexHome, "user-models.json");
  await fs.writeFile(foreignFile, JSON.stringify(previous));
  await fs.writeFile(root, 'model_catalog_json = "user-models.json"\nmodel_context_window = 64000\nmodel_auto_compact_token_limit = 50000\n');
  enableOverrides(config);
  let artifacts = await prepareCodexArtifacts(config, options);
  await applyCodexArtifacts(artifacts, options);
  let settings = readCodexConfig(await fs.readFile(root, "utf8"));
  assert.equal(settings.model_context_window, undefined);
  assert.equal(settings.model_auto_compact_token_limit, 50000);
  const managed = JSON.parse(await fs.readFile(settings.model_catalog_json, "utf8"));
  assert.equal(managed.models[0].base_instructions, catalogFixture().catalog.models[0].base_instructions);
  assert.deepEqual(managed.models.at(-1), previous.models.at(-1));
  assert.deepEqual(JSON.parse(await fs.readFile(foreignFile, "utf8")), previous);
  const firstPath = settings.model_catalog_json;
  config.virtualProviders.cabletidy_relay.models["gpt-5.5"].contextWindow = 100000;
  await applyCodexArtifacts(await prepareCodexArtifacts(config, options), options);
  settings = readCodexConfig(await fs.readFile(root, "utf8"));
  assert.notEqual(settings.model_catalog_json, firstPath);
  assert.equal(JSON.parse(await fs.readFile(firstPath, "utf8")).models[0].context_window, 128000);
  restoreOfficial(config);
  artifacts = await prepareCodexArtifacts(config, options);
  await applyCodexArtifacts(artifacts, options);
  settings = readCodexConfig(await fs.readFile(root, "utf8"));
  assert.equal(settings.model_catalog_json, "user-models.json");
  assert.equal(settings.model_context_window, 64000);
});

test("switching to a suite without overrides restores absent root settings", async (t) => {
  const { config, options, root } = await fixture(t);
  enableOverrides(config);
  await applyCodexArtifacts(await prepareCodexArtifacts(config, options), options);
  restoreOfficial(config);
  config.bindings.relay.name = "other";
  await applyCodexArtifacts(await prepareCodexArtifacts(config, options), options);
  const settings = readCodexConfig(await fs.readFile(root, "utf8"));
  assert.equal(settings.model_catalog_json, undefined);
  assert.equal(settings.model_context_window, undefined);
  assert.ok(settings.model_providers.cabletidy_relay);
  assert.ok(settings.model_providers.cabletidy_other);
});

test("bad TOML or an unreadable existing catalog never overwrites config", async (t) => {
  const { config, options, root } = await fixture(t);
  enableOverrides(config);
  for (const original of ['bad = [', 'model_catalog_json = "missing.json"\n']) {
    await fs.writeFile(root, original);
    await assert.rejects(prepareCodexArtifacts(config, options));
    assert.equal(await fs.readFile(root, "utf8"), original);
  }
});

test("external catalog edits are not undone when returning to official mode", async (t) => {
  const { config, options, root } = await fixture(t);
  enableOverrides(config);
  await applyCodexArtifacts(await prepareCodexArtifacts(config, options), options);
  await fs.writeFile(root, 'model_catalog_json = "external.json"\nmodel_context_window = 12345\n');
  restoreOfficial(config);
  await applyCodexArtifacts(await prepareCodexArtifacts(config, options), options);
  const settings = readCodexConfig(await fs.readFile(root, "utf8"));
  assert.equal(settings.model_catalog_json, "external.json");
  assert.equal(settings.model_context_window, 12345);
});
