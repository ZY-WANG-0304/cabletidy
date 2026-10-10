import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { createApplication } from "./helpers/native-app.mjs";
import { getPaths, normalizeConfig, saveConfig, saveSecrets } from "./helpers/native.mjs";
import { catalogFixture, namedCodexConfigFixture } from "./helpers/codex-fixture.mjs";
import { claudeConfigFixture } from "./helpers/claude-fixture.mjs";

async function fixture(t, legacyModel = false) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-transfer-"));
  const paths = getPaths(home);
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const config = normalizeConfig(namedCodexConfigFixture({ alpha: "Alpha", beta: "Beta" }));
  config.web.port = port;
  const claude = claudeConfigFixture();
  for (const key of ["upstreams", "routes", "virtualProviders", "bindings"]) Object.assign(config[key], claude[key]);
  config.upstreams.alpha.secretRef = "secret://upstreams/alpha";
  config.upstreams.alpha.auth = { header: "authorization", scheme: "Bearer", password: "auth-password" };
  config.upstreams.alpha.baseUrl = "https://url-user:url-password@alpha.example.invalid/v1?custom_auth=query-secret#fragment-secret";
  config.upstreams.alpha.headers = { Authorization: "Bearer header-secret", Cookie: "cookie-secret" };
  config.upstreams.alpha.apiKey = "inline-secret";
  config.upstreams.alpha.custom = { secret: "nested-secret" };
  config.virtualProviders.cabletidy_alpha.models.token = {
    aliases: ["custom-alias"], upstreamModelId: "custom-model", contextWindow: 123456,
    codex: { metadataMode: "override", inputModalities: ["text"], token: "model-secret" },
    api_key: "model-key", unknown: { password: "unknown-secret" },
  };
  if (!legacyModel) delete config.virtualProviders.cabletidy_alpha.models.token;
  config.virtualProviders.cabletidy_alpha.models["gpt-5.5"].contextWindow = 200000;
  config.virtualProviders.cabletidy_alpha.models["gpt-5.5"].codex = { metadataMode: "override", inputModalities: ["text"] };
  config.bindings["claude-main"].claude = { setModel: true, models: { sonnet: "claude-sonnet-4-6", subagent: "sonnet" }, env: { ANTHROPIC_API_KEY: "claude-secret" } };
  await saveConfig(config, paths);
  await saveSecrets({ "secret://upstreams/alpha": "saved-api-key", "secret://upstreams/alpha-2": "orphan-secret" }, paths);
  const app = await createApplication({ paths, loadCodexCatalog: async () => catalogFixture() });
  t.after(async () => { await app.close(); await fs.rm(home, { recursive: true, force: true }); });
  async function call(endpoint, body) {
    const response = await fetch(new URL(`/api/v1/config${endpoint}`, app.url), {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  return { paths, call };
}

test("selective export preserves suite dependencies and settings while omitting credentials", async t => {
  const { call, paths } = await fixture(t, true);
  const before = await fs.readFile(paths.config, "utf8");
  const result = await call("/export", { bindingIds: ["alpha", "claude-main"] });
  assert.equal(result.status, 200);
  const bundle = result.body;
  assert.equal(bundle.format, "cabletidy.configuration-suites");
  assert.deepEqual(Object.keys(bundle.config.bindings), ["alpha", "claude-main"]);
  assert.deepEqual(Object.keys(bundle.config.upstreams), ["alpha", "relay"]);
  assert.deepEqual(Object.keys(bundle.config.routes), ["alpha", "route"]);
  assert.equal(bundle.config.upstreams.alpha.baseUrl, "https://alpha.example.invalid/v1");
  assert.deepEqual(bundle.config.upstreams.alpha.auth, { header: "authorization", scheme: "Bearer" });
  assert.equal(bundle.config.upstreams.alpha.secretRef, undefined);
  assert.equal(bundle.config.upstreams.alpha.secretConfigured, undefined);
  const model = bundle.config.virtualProviders.cabletidy_alpha.models.token;
  assert.equal(model.upstreamModelId, "custom-model");
  assert.deepEqual(model.aliases, ["custom-alias"]);
  assert.equal(model.contextWindow, 123456);
  assert.deepEqual(model.codex, { metadataMode: "override", inputModalities: ["text"] });
  assert.deepEqual(bundle.config.bindings["claude-main"].claude, {
    setModel: true, models: { sonnet: "claude-sonnet-4-6", subagent: "sonnet" },
  });
  for (const key of ["web", "daemon", "revision", "secrets", "runtime"]) assert.equal(bundle.config[key], undefined);
  assert.doesNotMatch(JSON.stringify(bundle), /saved-api-key|orphan-secret|url-user|url-password|query-secret|fragment-secret|header-secret|cookie-secret|inline-secret|nested-secret|model-secret|model-key|unknown-secret|claude-secret|auth-password/);
  assert.equal(await fs.readFile(paths.config, "utf8"), before);
  assert.equal((await call("/export", { bindingIds: [] })).status, 422);
  assert.equal((await call("/export", { bindingIds: ["missing"] })).status, 422);
  assert.equal((await call("/export", {})).status, 422);
  const config = (await call("")).body.config;
  delete config.virtualProviders.cabletidy_alpha.models.token;
  config.bindings.alpha.name = "saved-api-key";
  assert.equal((await call("/commit", { baseRevision: config.revision, config })).status, 200);
  assert.equal((await call("/export", { bindingIds: ["saved-api-key"] })).status, 422);
});

test("import previews without writes and adds renamed suites without inheriting local secrets", async t => {
  const { call, paths } = await fixture(t);
  const original = (await call("")).body.config;
  // An official model is needed only for the imported Codex suite; arbitrary legacy names stay exportable.
  const bundle = (await call("/export", { bindingIds: ["alpha", "claude-main"] })).body;
  delete bundle.config.virtualProviders.cabletidy_alpha.models.token;
  bundle.config.upstreams.alpha.secretRef = "secret://upstreams/alpha";
  bundle.config.upstreams.alpha.apiKey = "injected-secret";
  bundle.config.upstreams.alpha.baseUrl += "?token=injected-url-secret";
  bundle.config.web = { listenHost: "0.0.0.0", port: 1 };

  bundle.config.bindings.alpha.codex = { api_key: "injected-client-secret" };
  const before = await fs.readFile(paths.config, "utf8");
  const preview = await call("/import", { bundle, preview: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.suites.map(s => s.name), ["Alpha (import 2)", "claude-main (import 2)"]);
  assert.equal(await fs.readFile(paths.config, "utf8"), before);
  const result = await call("/import", { bundle, baseRevision: preview.body.baseRevision, choices: Object.fromEntries(preview.body.suites.filter(s => s.conflict).map(s => [s.sourceId, "create"])) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const config = result.body.config;
  assert.equal(config.revision, original.revision + 1);
  assert.deepEqual(config.web, original.web);
  for (const [id, b] of Object.entries(original.bindings)) assert.deepEqual(config.bindings[id], b);
  assert.equal(Object.keys(config.bindings).length, 5);
  const imported = config.bindings[preview.body.suites[0].id];
  const provider = config.virtualProviders[imported.virtualProvider];
  const upstreamId = config.routes[provider.route].backends[0].upstream;
  assert.equal(upstreamId, "alpha-2");
  assert.equal(config.upstreams[upstreamId].secretConfigured, false);
  assert.match(config.upstreams[upstreamId].secretRef, /^secret:\/\/imports\//);
  assert.equal(config.upstreams.alpha.secretConfigured, true);
  assert.equal(provider.models["gpt-5.5"].contextWindow, 200000);
  assert.equal(config.upstreams[upstreamId].baseUrl, "https://alpha.example.invalid/v1");
  assert.doesNotMatch(await fs.readFile(paths.config, "utf8"), /injected-secret|injected-url-secret|injected-client-secret/);
  assert.equal((await call("/import", { bundle, baseRevision: preview.body.baseRevision, choices: Object.fromEntries(preview.body.suites.filter(s => s.conflict).map(s => [s.sourceId, "create"])) })).status, 409);
  assert.equal((await call("/import", { bundle })).status, 409);
  assert.deepEqual(JSON.parse(await fs.readFile(paths.secrets, "utf8")), { "secret://upstreams/alpha": "saved-api-key", "secret://upstreams/alpha-2": "orphan-secret" });
});

test("invalid bundles cannot partially import and shared dependencies stay shared", async t => {
  const { call, paths } = await fixture(t);
  const bundle = (await call("/export", { bindingIds: ["alpha", "beta"] })).body;
  delete bundle.config.virtualProviders.cabletidy_alpha.models.token;
  bundle.config.virtualProviders.cabletidy_beta.route = "alpha";
  delete bundle.config.routes.beta;
  delete bundle.config.upstreams.beta;
  const preview = await call("/import", { bundle, preview: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const result = await call("/import", { bundle, baseRevision: preview.body.baseRevision, choices: Object.fromEntries(preview.body.suites.filter(s => s.conflict).map(s => [s.sourceId, "create"])) });
  assert.equal(result.status, 200);
  const providers = preview.body.suites.map(s => result.body.config.virtualProviders[result.body.config.bindings[s.id].virtualProvider]);
  assert.equal(providers[0].route, providers[1].route);
  const before = await fs.readFile(paths.config, "utf8");
  for (const bad of [
    {}, { ...bundle, version: 9 }, { ...bundle, config: { ...bundle.config, bindings: {} } },
    { ...bundle, config: { ...bundle.config, routes: {} } },
    { ...bundle, config: { ...bundle.config, upstreams: [] } },
  ]) {
    assert.equal((await call("/import", { bundle: bad, baseRevision: result.body.revision })).status, 422);
    assert.equal(await fs.readFile(paths.config, "utf8"), before);
  }
});

test("same-name suites require a choice and support mixed updates and copies", async t => {
  const { call, paths } = await fixture(t);
  const original = (await call("")).body.config;
  const bundle = (await call("/export", { bindingIds: ["alpha", "beta"] })).body;
  bundle.config.upstreams.alpha.baseUrl = "https://updated.example.invalid/v1";
  bundle.config.virtualProviders.cabletidy_alpha.models["gpt-5.5"].upstreamModelId = "updated-model";
  const before = await fs.readFile(paths.config, "utf8");
  const preview = await call("/import", { bundle, preview: true });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.suites.map(s => [s.sourceId, s.conflict]), [["alpha", true], ["beta", true]]);
  for (const choices of [undefined, { alpha: "update" }, { alpha: "skip", beta: "create" }, { missing: "update" }]) {
    const result = await call("/import", { bundle, baseRevision: original.revision, choices });
    assert.equal(result.status, 422, JSON.stringify(result.body));
    assert.equal(await fs.readFile(paths.config, "utf8"), before);
  }
  const choices = { alpha: "update", beta: "create" };
  const updatedPreview = await call("/import", { bundle, preview: true, choices });
  assert.equal(updatedPreview.status, 200);
  assert.equal(updatedPreview.body.suites[0].name, "Alpha");
  assert.equal(updatedPreview.body.suites[0].action, "update");
  assert.equal(await fs.readFile(paths.config, "utf8"), before);
  const imported = await call("/import", { bundle, baseRevision: original.revision, choices });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const config = imported.body.config;
  assert.equal(Object.keys(config.bindings).length, 4);
  assert.equal(config.bindings.alpha.name, "Alpha");
  assert.deepEqual(config.bindings.beta, original.bindings.beta);
  assert.ok(config.bindings["beta-import-2"]);
  const provider = config.virtualProviders.cabletidy_alpha;
  assert.equal(provider.models["gpt-5.5"].upstreamModelId, "updated-model");
  const upstream = config.upstreams[config.routes[provider.route].backends[0].upstream];
  assert.equal(upstream.baseUrl, "https://updated.example.invalid/v1");
  assert.equal(upstream.secretConfigured, true);
  assert.equal(upstream.secretRef, "secret://upstreams/alpha");
  assert.equal(config.routes.alpha, undefined);
  assert.equal(config.upstreams.alpha, undefined);
  assert.equal(JSON.parse(await fs.readFile(paths.secrets, "utf8"))["secret://upstreams/alpha"], "saved-api-key");
});

test("updating a suite preserves old dependencies and credentials still shared by another suite", async t => {
  const { call } = await fixture(t);
  const config = (await call("")).body.config;
  config.virtualProviders.cabletidy_beta.route = "alpha";
  assert.equal((await call("/commit", { config, baseRevision: config.revision })).status, 200);
  const bundle = (await call("/export", { bindingIds: ["alpha"] })).body;
  const preview = (await call("/import", { bundle, preview: true })).body;
  const result = await call("/import", { bundle, baseRevision: preview.baseRevision, choices: { alpha: "update" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.config.virtualProviders.cabletidy_beta.route, "alpha");
  assert.equal(result.body.config.upstreams.alpha.secretConfigured, true);
  const provider = result.body.config.virtualProviders.cabletidy_alpha;
  assert.notEqual(provider.route, "alpha");
  const uid = result.body.config.routes[provider.route].backends[0].upstream;
  assert.equal(result.body.config.upstreams[uid].secretConfigured, true);
});

for (const firstAction of ["update", "create"]) {
  test(`shared imported connections isolate retained credentials when first choice is ${firstAction}`, async t => {
    const { call, paths } = await fixture(t);
    const config = (await call("")).body.config;
    const bundle = (await call("/export", { bindingIds: ["alpha", "beta"] })).body;
    bundle.config.virtualProviders.cabletidy_beta.route = "alpha";
    delete bundle.config.routes.beta;
    delete bundle.config.upstreams.beta;
    const choices = firstAction === "update" ? { alpha: "update", beta: "create" } : { alpha: "create", beta: "update" };
    // Beta has no existing credential; alpha does. Only updated suites may retain one.
    const result = await call("/import", { bundle, baseRevision: config.revision, choices });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const updatedId = firstAction === "update" ? "alpha" : "beta";
    const createdId = firstAction === "update" ? "beta-import-2" : "alpha-import-2";
    const connection = id => {
      const provider = result.body.config.virtualProviders[result.body.config.bindings[id].virtualProvider];
      return result.body.config.upstreams[result.body.config.routes[provider.route].backends[0].upstream];
    };
    assert.equal(connection(createdId).secretConfigured, false);
    assert.match(connection(createdId).secretRef, /^secret:\/\/imports\//);
    assert.equal(connection(updatedId).secretConfigured, firstAction === "update");
    if (firstAction === "update") {
      assert.equal(connection(updatedId).secretRef, "secret://upstreams/alpha");
      assert.notEqual(connection(updatedId).id, connection(createdId).id);
    }
    assert.doesNotMatch(await fs.readFile(paths.config, "utf8"), /saved-api-key/);
  });
}

test("two updates sharing an imported connection retain each suite's distinct credentials", async t => {
  const { call, paths } = await fixture(t);
  const config = (await call("")).body.config;
  assert.equal((await call("/commit", { config, baseRevision: config.revision, upstreamSecrets: { beta: "beta-existing-key" } })).status, 200);
  const loaded = (await call("")).body.config;
  const bundle = (await call("/export", { bindingIds: ["alpha", "beta"] })).body;
  bundle.config.virtualProviders.cabletidy_beta.route = "alpha";
  delete bundle.config.routes.beta;
  delete bundle.config.upstreams.beta;
  const result = await call("/import", { bundle, baseRevision: loaded.revision, choices: { alpha: "update", beta: "update" } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const refs = ["alpha", "beta"].map(id => {
    const provider = result.body.config.virtualProviders[`cabletidy_${id}`];
    const uid = result.body.config.routes[provider.route].backends[0].upstream;
    assert.equal(result.body.config.upstreams[uid].secretConfigured, true);
    return result.body.config.upstreams[uid].secretRef;
  });
  assert.deepEqual(refs, ["secret://upstreams/alpha", "secret://upstreams/beta"]);
  const secrets = JSON.parse(await fs.readFile(paths.secrets, "utf8"));
  assert.equal(secrets[refs[0]], "saved-api-key");
  assert.equal(secrets[refs[1]], "beta-existing-key");
});
