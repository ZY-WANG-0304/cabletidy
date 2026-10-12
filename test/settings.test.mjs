import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "./helpers/native-app.mjs";
import { getPaths } from "./helpers/native.mjs";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-settings-"));
  const paths = getPaths(home);
  let app = await createApplication({ paths });
  t.after(async () => { await app.close(); await fs.rm(home, { recursive: true, force: true }); });
  return {
    paths,
    async get(route) { return (await fetch(`${app.url}api/v1/${route}`)).json(); },
    commit(config, baseRevision = config.revision) {
      return fetch(`${app.url}api/v1/config/commit`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ config, baseRevision }),
      });
    },
    async restart() { await app.close(); app = await createApplication({ paths }); },
  };
}

test("audit settings apply immediately, persist and survive restart in every limit combination", async t => {
  const f = await fixture(t);
  let { config } = await f.get("config");
  assert.deepEqual(config.audit, { retentionDays: 30, budgetBytes: 128 * 1048576 });
  for (const audit of [
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
