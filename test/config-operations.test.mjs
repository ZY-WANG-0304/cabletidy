import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "./helpers/native-app.mjs";
import { getPaths } from "./helpers/native.mjs";
import { catalogFixture } from "./helpers/codex-fixture.mjs";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-operations-"));
  const paths = getPaths(home);
  const app = await createApplication({ paths, loadCodexCatalog: async () => catalogFixture() });
  t.after(async () => { await app.close(); await fs.rm(home, { recursive: true, force: true }); });
  const call = async (endpoint, body) => {
    const response = await fetch(`${app.url}api/v1/${endpoint}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  let config = (await call("config")).body.config;
  return {
    paths, call, config: () => config,
    async commit(body, status = 200) {
      const result = await call("config/commit", { baseRevision: config.revision, ...body });
      assert.equal(result.status, status, JSON.stringify(result.body));
      if (status === 200) config = result.body.config;
      return result.body;
    },
  };
}
const create = (name, target = "claude-code", models = []) => ({
  type: "cable.create", data: { cableName: name, target, upstreamBaseUrl: "https://example.invalid/v1", upstreamSecret: "operation-test-key" }, models,
});

test("configuration operations create authoritative IDs and URLs and reject stale or malformed edits atomically", async t => {
  const f = await fixture(t);
  const first = await f.commit({ operation: create("Dev Team", "codex", [{ clientModelId: "gpt-5.5" }]) });
  assert.equal(first.selection.cableId, "dev-team");
  assert.equal(first.selection.virtualProviderId, "cabletidy_dev-team");
  assert.equal(first.page, "cable-detail");
  assert.match(first.runtime.virtualProviders[0].baseUrl, /\/dev-team\/v1$/);
  const profile = f.config().virtualProviders["cabletidy_dev-team"].models["gpt-5.5"];
  assert.equal(profile.codex.metadataMode, "official");
  assert.ok(profile.capabilities.includes("vision"));
  assert.equal(profile.upstreamModelId, undefined);
  const persisted = await fs.readFile(f.paths.config, "utf8");
  await f.commit({ operation: create("dev-team") }, 422);
  await f.commit({ baseRevision: 0, operation: create("stale") }, 409);
  for (const operation of [null, [], { type: "cable.create", data: {} }, { type: "models.replace", cableId: "dev-team", models: {} },
    { type: "model.save", cableId: "dev-team", data: { oldId: "absent", clientModelId: "gpt-5.5" } },
    { type: "unknown", cableId: "dev-team" }]) await f.commit({ operation }, 422);
  assert.equal(await fs.readFile(f.paths.config, "utf8"), persisted);
  const second = await f.commit({ operation: create("Second", "codex") });
  assert.ok(second.config.upstreams["relay-main-2"]);
  assert.equal(second.config.cables.second.virtualProvider, "cabletidy_second");
});

test("model operations preserve profiles through swaps and synchronize Claude selections and native aliases", async t => {
  const f = await fixture(t);
  await f.commit({ operation: create("Claude", "claude-code", ["alpha", "beta", "sonnet"].map(clientModelId => ({ clientModelId, upstreamModelId: `vendor-${clientModelId}` }))) });
  const config = structuredClone(f.config());
  config.virtualProviders.cabletidy_claude.models.alpha.futureField = { keep: true };
  config.cables.claude.futureCable = { keep: true };
  await f.commit({ config });
  await f.commit({ operation: { type: "claude.save", cableId: "claude", data: { defaultModel: "alpha", opus: "alpha", sonnet: "beta", subagent: "alpha", discoverModels: true } } });
  await f.commit({ operation: { type: "models.replace", cableId: "claude", models: [
    { oldId: "alpha", clientModelId: "beta", upstreamModelId: "vendor-alpha" },
    { oldId: "beta", clientModelId: "alpha", upstreamModelId: "vendor-beta" },
    { oldId: "sonnet", clientModelId: "sonnet", upstreamModelId: "vendor-sonnet" },
  ] } });
  const cable = f.config().cables.claude, provider = f.config().virtualProviders.cabletidy_claude;
  assert.deepEqual(provider.models.beta.futureField, { keep: true });
  assert.deepEqual(cable.futureCable, { keep: true });
  assert.equal(cable.defaultModel, "beta");
  assert.equal(provider.defaultModel, "beta");
  assert.deepEqual(cable.claude.models, { opus: "beta", sonnet: "alpha", subagent: "beta" });
  const preview = await f.call("config/preview-target-artifacts", { cableId: "claude" });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.artifacts.environment.vars.ANTHROPIC_MODEL, "beta");
  await f.commit({ operation: { type: "model.delete", cableId: "claude", modelId: "beta" } });
  assert.equal(f.config().cables.claude.defaultModel, undefined);
  assert.equal(f.config().cables.claude.claude.models.opus, undefined);
  assert.equal(f.config().cables.claude.claude.models.subagent, undefined);
  await f.commit({ operation: { type: "claude.save", cableId: "claude", data: { defaultModel: "sonnet", sonnet: "sonnet", subagent: "sonnet" } } });
  await f.commit({ operation: { type: "model.delete", cableId: "claude", modelId: "sonnet" } });
  assert.equal(f.config().cables.claude.defaultModel, "sonnet");
  assert.equal(f.config().cables.claude.claude.models.subagent, "sonnet");
  assert.equal(f.config().cables.claude.claude.models.sonnet, undefined);
  assert.deepEqual((await f.call("claude/models")).body.aliases.subagent, ["opus", "sonnet", "fable", "haiku"]);
});

test("cable deletion retains shared dependencies and cleans only removed upstream secrets", async t => {
  const f = await fixture(t);
  await f.commit({ operation: create("First") });
  await f.commit({ operation: create("Second") });
  const config = structuredClone(f.config());
  config.virtualProviders.cabletidy_second.route = config.virtualProviders.cabletidy_first.route;
  const unusedRoute = structuredClone(config.routes["relay-main-2-route"]);
  await f.commit({ config });
  await f.commit({ operation: { type: "cable.delete", cableId: "first" } });
  assert.ok(f.config().routes["relay-main-route"]);
  assert.ok(f.config().upstreams["relay-main"]);
  assert.deepEqual(f.config().routes["relay-main-2-route"], unusedRoute);
  assert.ok(JSON.parse(await fs.readFile(f.paths.secrets, "utf8"))["secret://upstreams/relay-main"]);
  await f.commit({ operation: { type: "cable.delete", cableId: "second" } });
  assert.equal(f.config().routes["relay-main-route"], undefined);
  assert.equal(f.config().upstreams["relay-main"], undefined);
  assert.ok(f.config().upstreams["relay-main-2"]);
  const secrets = JSON.parse(await fs.readFile(f.paths.secrets, "utf8"));
  assert.equal(secrets["secret://upstreams/relay-main"], undefined);
  assert.equal(secrets["secret://upstreams/relay-main-2"], "operation-test-key");
});

test("Codex operation policy uses official metadata and refuses invalid overrides without changing state", async t => {
  const f = await fixture(t);
  await f.commit({ operation: create("Codex", "codex", [{ clientModelId: "gpt-5.5" }]) });
  const operation = contextWindow => ({ type: "models.replace", cableId: "codex", models: [{ oldId: "gpt-5.5", clientModelId: "gpt-5.5", policy: { metadataMode: "override", contextWindow, vision: false } }] });
  await f.commit({ operation: operation(128000) });
  const profile = f.config().virtualProviders.cabletidy_codex.models["gpt-5.5"];
  assert.equal(profile.contextWindow, 128000);
  assert.deepEqual(profile.codex, { metadataMode: "override", inputModalities: ["text"] });
  assert.ok(!profile.capabilities.includes("vision"));
  const persisted = await fs.readFile(f.paths.config, "utf8");
  for (const value of [0, 1.5, 1000001, "bad"]) await f.commit({ operation: operation(value) }, 422);
  assert.equal(await fs.readFile(f.paths.config, "utf8"), persisted);
});
