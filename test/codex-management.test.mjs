import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createApplication } from "./helpers/native-app.mjs";
import { getPaths, normalizeConfig, saveConfig } from "./helpers/native.mjs";
import { readCodexConfig } from "./helpers/native.mjs";
import { catalogFixture, codexConfigFixture, namedCodexConfigFixture } from "./helpers/codex-fixture.mjs";

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("Web model discovery, dynamic validation, preview and apply share official metadata", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-management-test-"));
  const paths = getPaths(home);
  const client = path.join(home, "client");
  const initial = normalizeConfig({ web: { port: await freePort() } });
  await saveConfig(initial, paths);
  let unavailable = false;
  const app = await createApplication({ paths, codexHome: client, loadCodexCatalog: async () => {
    if (unavailable) throw new Error("Codex directory unavailable");
    return catalogFixture();
  } });
  t.after(async () => { await app.close(); await fs.rm(home, { recursive: true, force: true }); });
  const call = async (url, body) => {
    const response = await fetch(`${app.url}api/v1${url}`, body ? {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    } : {});
    return { status: response.status, body: await response.json() };
  };
  const catalog = await call("/codex/models");
  assert.equal(catalog.body.models.length, 2);
  assert.doesNotMatch(JSON.stringify(catalog.body), /base_instructions/);
  const candidate = normalizeConfig({ ...codexConfigFixture(), web: initial.web });
  candidate.virtualProviders.cabletidy_relay.enabled = false;
  const profile = candidate.virtualProviders.cabletidy_relay.models["gpt-5.5"];
  candidate.virtualProviders.cabletidy_relay.models = { "unknown-model": profile };
  let result = await call("/config/commit", { config: candidate, baseRevision: 0 });
  assert.equal(result.status, 422);
  assert.equal(app.state.config.revision, 0);
  candidate.virtualProviders.cabletidy_relay.models = { "gpt-5.5": profile };
  candidate.virtualProviders.cabletidy_relay.models["gpt-5.5"].codex = { metadataMode: "override", inputModalities: ["text"] };
  candidate.virtualProviders.cabletidy_relay.models["gpt-5.5"].contextWindow = 128000;
  result = await call("/config/commit", {
    config: candidate, baseRevision: 0, upstreamSecrets: { relay: "upstream-key" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.revision, 1);
  assert.equal(result.body.runtime.counts.models, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(paths.secrets, "utf8")), {
    "secret://upstreams/relay": "upstream-key",
  });
  const preview = await call("/config/preview-target-artifacts", { bindingId: "relay" });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.artifacts.files.length, 2);
  assert.equal(preview.body.artifacts.catalogPlan, undefined);
  const previewToml = preview.body.artifacts.files.find((file) => file.path === "config.toml").contents;
  assert.equal(readCodexConfig(previewToml).model_providers.cabletidy_relay.base_url, `${app.url}relay/v1`);
  assert.doesNotMatch(previewToml, /upstream-key|profiles\./);
  assert.equal(previewToml.includes(candidate.upstreams.relay.baseUrl), false);
  const applied = await call("/targets/apply", { bindingId: "relay" });
  assert.equal(applied.status, 200);
  const root = await fs.readFile(path.join(client, "config.toml"), "utf8");
  assert.equal(root, previewToml);
  const settings = readCodexConfig(root);
  const generated = JSON.parse(await fs.readFile(settings.model_catalog_json, "utf8"));
  assert.equal(generated.models[0].context_window, 128000);
  assert.equal(generated.models[0].base_instructions, catalogFixture().catalog.models[0].base_instructions);
  unavailable = true;
  assert.equal((await call("/codex/models?refresh=1")).body.available, false);
  assert.equal((await call("/targets/apply", { bindingId: "relay" })).status, 422);
  assert.equal(await fs.readFile(path.join(client, "config.toml"), "utf8"), root);
  assert.equal((await call("/runtime")).status, 200);
});

test("target APIs select bindings consistently and retired aliases return 404", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-target-api-test-"));
  const paths = getPaths(home);
  const client = path.join(home, "client");
  const config = normalizeConfig(namedCodexConfigFixture({ generic: "generic", relay: "relay" }));
  config.web.port = await freePort();
  config.bindings.generic.target = "generic-env";
  config.bindings.relay.enabled = false;
  await saveConfig(config, paths);
  const app = await createApplication({ paths, codexHome: client, loadCodexCatalog: async () => catalogFixture() });
  t.after(async () => { await app.close(); await fs.rm(home, { recursive: true, force: true }); });
  const call = async (url, body = {}) => {
    const response = await fetch(`${app.url}api/v1${url}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  for (const [body, bindingId, target] of [[{ bindingId: "relay" }, "relay", "codex"], [{}, "generic", "generic-env"]]) {
    const preview = await call("/config/preview-target-artifacts", body);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.artifacts.bindingId, bindingId);
    assert.equal(preview.body.artifacts.target, target);
  }
  for (const endpoint of ["/config/preview-codex-config", "/config/preview-provider-artifacts", "/targets/codex/apply"]) {
    const retired = await call(endpoint, { bindingId: "relay" });
    assert.equal(retired.status, 404);
    assert.equal(retired.body.error.code, "not_found");
  }
  await assert.rejects(fs.access(path.join(client, "config.toml")), { code: "ENOENT" });

  const unsupported = await call("/targets/apply");
  assert.equal(unsupported.status, 501);
  assert.equal(unsupported.body.target, "generic-env");
  assert.equal(unsupported.body.bindingId, "generic");
  await assert.rejects(fs.access(path.join(client, "config.toml")), { code: "ENOENT" });

  const current = await call("/targets/apply", { bindingId: "relay" });
  assert.equal(current.status, 200);
  assert.equal(current.body.target, "codex");
  const events = (await (await fetch(`${app.url}api/v1/events`)).json()).events;
  assert.equal(events[0].type, "target.apply");
  assert.deepEqual(events[0].data, {
    bindingId: "relay", target: "codex", files: current.body.report.applied,
  });
  const contents = await fs.readFile(path.join(client, "config.toml"), "utf8");
  assert.match(contents, /cabletidy_relay/);

  const failed = await call("/targets/apply", { bindingId: "missing" });
  assert.equal(failed.status, 422);
  assert.equal(failed.body.error.code, "target_apply_failed");
  assert.equal(await fs.readFile(path.join(client, "config.toml"), "utf8"), contents);
});
