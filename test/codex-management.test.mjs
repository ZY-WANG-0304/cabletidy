import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../src/server.mjs";
import { getPaths, normalizeConfig, saveConfig } from "../src/config.mjs";
import { readCodexConfig } from "../src/codex-config-file.mjs";
import { catalogFixture, codexConfigFixture } from "./helpers/codex-fixture.mjs";

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
  candidate.models.model.clientModelId = "unknown-model";
  let result = await call("/config/commit", { config: candidate, baseRevision: 0 });
  assert.equal(result.status, 422);
  assert.equal(app.state.config.revision, 0);
  candidate.models.model.clientModelId = "gpt-5.5";
  candidate.models.model.codex = { metadataMode: "override", inputModalities: ["text"] };
  candidate.models.model.contextWindow = 128000;
  result = await call("/config/commit", { config: candidate, baseRevision: 0 });
  assert.equal(result.status, 200);
  const preview = await call("/config/preview-target-artifacts", { bindingId: "relay" });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.artifacts.files.length, 2);
  assert.equal(preview.body.artifacts.catalogPlan, undefined);
  const applied = await call("/targets/apply", { bindingId: "relay" });
  assert.equal(applied.status, 200);
  const root = await fs.readFile(path.join(client, "config.toml"), "utf8");
  assert.equal(root, preview.body.artifacts.files[0].contents);
  const settings = readCodexConfig(root);
  const generated = JSON.parse(await fs.readFile(settings.model_catalog_json, "utf8"));
  assert.equal(generated.models[0].context_window, 128000);
  assert.equal(generated.models[0].base_instructions, catalogFixture().catalog.models[0].base_instructions);
  unavailable = true;
  assert.equal((await call("/codex/models")).body.available, false);
  assert.equal((await call("/targets/apply", { bindingId: "relay" })).status, 422);
  assert.equal(await fs.readFile(path.join(client, "config.toml"), "utf8"), root);
  assert.equal((await call("/runtime")).status, 200);
});
