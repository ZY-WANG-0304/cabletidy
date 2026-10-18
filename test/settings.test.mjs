import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createApplication } from "./helpers/native-app.mjs";
import { getPaths, normalizeConfig } from "./helpers/native.mjs";
import { catalogFixture, namedCodexConfigFixture } from "./helpers/codex-fixture.mjs";

async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-settings-"));
  const paths = getPaths(home);
  let app = await createApplication({ ...options, paths });
  t.after(async () => { await app.close(); await fs.rm(home, { recursive: true, force: true }); });
  return {
    paths,
    async get(route) { return (await fetch(`${app.url}api/v1/${route}`)).json(); },
    request(route, body) {
      return fetch(`${app.url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    },
    commit(config, baseRevision = config.revision) {
      return fetch(`${app.url}api/v1/config/commit`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ config, baseRevision }),
      });
    },
    async restart() { await app.close(); app = await createApplication({ ...options, paths }); },
  };
}

test("credential protection saves global, cable selection and TTL atomically and applies to the next request and after restart", async t => {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push(body.input);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: body.input }] }] }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const f = await fixture(t, { loadCodexCatalog: async () => catalogFixture() });
  let { config } = await f.get("config");
  const lines = normalizeConfig(namedCodexConfigFixture({ alpha: "Alpha", beta: "Beta" }));
  Object.assign(config, { upstreams: lines.upstreams, routes: lines.routes, virtualProviders: lines.virtualProviders, cables: lines.cables });
  for (const value of Object.values(config.upstreams)) value.baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  config = (await (await f.commit(config)).json()).config;
  const credential = "sk-proj-9fK2mNvQ8xRtZ4wB7hLpY1cD";
  const checkRequests = async selected => {
    for (const id of ["alpha", "beta"]) {
      const response = await f.request(`${id}/v1/responses`, { model: "gpt-5.5", input: credential });
      assert.equal(response.status, 200, id);
      assert.equal((await response.json()).output[0].content[0].text, credential, "client receives the original credential");
      if (selected.includes(id)) assert.match(calls.at(-1), /^CTSEC_v1_[a-f0-9]{32}$/);
      else assert.equal(calls.at(-1), credential);
    }
  };
  for (const [enabled, seconds, selected] of [[true, 60, ["alpha"]], [false, 120, ["alpha"]], [true, 120, ["alpha"]], [true, 3600, ["alpha", "beta"]], [false, 3600, ["alpha", "beta"]]]) {
    config.credentialProtection = { enabled, mappingTtlSeconds: seconds };
    for (const id of ["alpha", "beta"]) {
      const provider = config.virtualProviders[`cabletidy_${id}`];
      provider.credentialProtection = selected.includes(id);
    }
    const revision = config.revision;
    const response = await f.commit(config);
    assert.equal(response.status, 200);
    config = (await response.json()).config;
    assert.equal(config.revision, revision + 1);
    const disk = JSON.parse(await fs.readFile(f.paths.config, "utf8"));
    assert.deepEqual(disk.credentialProtection, config.credentialProtection);
    assert.deepEqual(disk.virtualProviders, config.virtualProviders);
    await checkRequests(enabled ? selected : []);
    await f.restart();
    assert.deepEqual((await f.get("config")).config, config);
    await checkRequests(enabled ? selected : []);
  }
  const before = config;
  const invalid = structuredClone(config);
  invalid.credentialProtection = { enabled: true, mappingTtlSeconds: 59 };
  invalid.virtualProviders.cabletidy_alpha.credentialProtection = true;
  const failed = await f.commit(invalid);
  assert.equal(failed.status, 422);
  assert.deepEqual((await f.get("config")).config, before);
  await checkRequests([]);
});

test("audit settings apply immediately, persist and survive restart in every limit combination", async t => {
  const f = await fixture(t);
  let { config } = await f.get("config");
  assert.deepEqual(config.audit, { retentionDays: 30, budgetBytes: 5 * 1024 ** 3 });
  for (const audit of [
    { retentionDays: 7, budgetBytes: 5 * 1024 ** 3 },
    { retentionDays: 7, budgetBytes: 64 * 1048576 },
    { retentionDays: null, budgetBytes: 256 * 1048576 },
    { retentionDays: 90, budgetBytes: null },
    { retentionDays: null, budgetBytes: null },
  ]) {
    config.audit = audit;
    const response = await f.commit(config);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    config = result.config;
    assert.deepEqual(config.audit, audit);
    assert.equal(result.runtime.security.storage.retentionDays, audit.retentionDays);
    assert.equal(result.runtime.security.storage.budgetBytes, audit.budgetBytes);
    assert.deepEqual(JSON.parse(await fs.readFile(f.paths.config, "utf8")).audit, audit);
    await f.restart();
    const storage = (await f.get("security/status")).storage;
    assert.equal(storage.retentionDays, audit.retentionDays);
    assert.equal(storage.budgetBytes, audit.budgetBytes);
    assert.deepEqual((await f.get("config")).config.audit, audit);
  }
});

test("temporary directory changes persist, take effect only after restart and reject unusable paths", async t => {
  const f = await fixture(t, { loadCodexCatalog: async () => catalogFixture() });
  const checkCatalog = async directory => {
    const result = await f.get("codex/models");
    assert.equal(result.models?.length, 2, JSON.stringify(result));
    assert.deepEqual(await fs.readdir(path.join(directory, "helpers")), [], "catalog helpers are removed after use");
  };
  let { config } = await f.get("config");
  const defaultDirectory = path.join(f.paths.home, "tmp");
  let active = (await f.get("runtime")).temporaryStorage;
  assert.equal(active.activeDirectory, await fs.realpath(defaultDirectory));
  assert.equal(active.restartRequired, false);
  for (const name of ["spool", "sqlite", "helpers"]) {
    assert.ok((await fs.stat(path.join(defaultDirectory, name))).isDirectory());
  }
  await checkCatalog(defaultDirectory);
  const custom = path.join(f.paths.home, "custom temporary files");
  config.temporaryDirectory = custom;
  let response = await f.commit(config);
  let result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  config = result.config;
  assert.equal(result.runtime.temporaryStorage.activeDirectory, await fs.realpath(defaultDirectory));
  assert.equal(result.runtime.temporaryStorage.restartRequired, true);
  assert.equal(JSON.parse(await fs.readFile(f.paths.config, "utf8")).temporaryDirectory, custom);
  const sentinel = path.join(defaultDirectory, "user-file");
  await fs.writeFile(sentinel, "keep");
  await f.restart();
  active = (await f.get("runtime")).temporaryStorage;
  assert.equal(active.activeDirectory, await fs.realpath(custom));
  assert.equal(active.restartRequired, false);
  assert.equal(await fs.readFile(sentinel, "utf8"), "keep");
  await checkCatalog(custom);
  if (process.platform === "win32") {
    // Equivalent Windows spellings must not create a spurious restart warning.
    response = await f.commit({ ...config, temporaryDirectory: path.toNamespacedPath(custom) });
    result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.runtime.temporaryStorage.restartRequired, false);
    config = result.config;
    await f.restart();
    assert.equal((await f.get("runtime")).temporaryStorage.activeDirectory, await fs.realpath(custom));
    await checkCatalog(custom);
  }
  const blocked = path.join(f.paths.home, "blocked");
  await fs.writeFile(blocked, "keep");
  for (const directory of ["relative/path", blocked]) {
    response = await f.commit({ ...config, temporaryDirectory: directory });
    assert.equal(response.status, 422);
    assert.ok((await response.json()).errors.some(({ path }) => path === "temporaryDirectory"));
    assert.equal((await f.get("config")).config.temporaryDirectory, config.temporaryDirectory);
    assert.equal((await f.get("runtime")).temporaryStorage.restartRequired, false);
  }
  config.temporaryDirectory = null;
  response = await f.commit(config);
  result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.runtime.temporaryStorage.restartRequired, true);
  await f.restart();
  active = (await f.get("runtime")).temporaryStorage;
  assert.equal(active.activeDirectory, await fs.realpath(defaultDirectory));
  assert.equal(active.restartRequired, false);
});

test("invalid, conflicting and failed commits leave persisted and active audit settings unchanged", async t => {
  const f = await fixture(t);
  const { config } = await f.get("config");
  const unchanged = async () => {
    assert.deepEqual((await f.get("config")).config.audit, config.audit);
    const storage = (await f.get("security/status")).storage;
    assert.equal(storage.retentionDays, config.audit.retentionDays);
    assert.equal(storage.budgetBytes, config.audit.budgetBytes);
    assert.deepEqual(JSON.parse(await fs.readFile(f.paths.config, "utf8")).audit, config.audit);
  };
  let response = await f.commit({ ...config, audit: { retentionDays: 0, budgetBytes: null } });
  assert.equal(response.status, 422);
  assert.ok((await response.json()).errors.some(({ path }) => path === "audit.retentionDays"));
  await unchanged();
  response = await f.commit({ ...config, audit: { retentionDays: null, budgetBytes: null } }, config.revision + 1);
  assert.equal(response.status, 409);
  await unchanged();
  await fs.rm(f.paths.backups, { recursive: true });
  await fs.writeFile(f.paths.backups, "unavailable");
  response = await f.commit({ ...config, audit: { retentionDays: null, budgetBytes: null } });
  assert.equal(response.status, 500);
  await unchanged();
});
