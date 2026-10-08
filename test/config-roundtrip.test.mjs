import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createApplication } from "./helpers/native-app.mjs";
import { getPaths } from "./helpers/native.mjs";
import { claudeConfigFixture } from "./helpers/claude-fixture.mjs";
import { namedCodexConfigFixture } from "./helpers/codex-fixture.mjs";

const credentialFields = [
  "secret", "apiKey", "api_key", "token", "accessToken", "access_token",
  "refreshToken", "refresh_token", "clientSecret", "client_secret", "password",
  "privateKey", "private_key",
];
const names = [...credentialFields, "secretConfigured"];
const providerId = "cabletidy_claude-main";

for (const sharedSecret of [false, true]) {
  test(`deleting a configuration persists and ${sharedSecret ? "preserves shared" : "removes unused"} credentials`, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-delete-config-"));
    let app;
    t.after(async () => { await app?.close(); await fs.rm(home, { recursive: true, force: true }); });
    const paths = getPaths(home);
    const initial = namedCodexConfigFixture({ first: "first", second: "second" });
    initial.web = { listenHost: "127.0.0.1", port: await freePort() };
    const firstRef = "secret://upstreams/first";
    const secondRef = sharedSecret ? firstRef : "secret://upstreams/second";
    initial.upstreams.first.secretRef = firstRef;
    initial.upstreams.second.secretRef = secondRef;
    initial.virtualProviders.cabletidy_first.models = {};
    initial.virtualProviders.cabletidy_second.models = {};
    const secrets = { [firstRef]: "first-key", [secondRef]: "second-key", unrelated: "preserved-key" };
    await fs.writeFile(paths.config, JSON.stringify(initial));
    await fs.writeFile(paths.secrets, JSON.stringify(secrets));
    app = await createApplication({ paths });
    const get = async (endpoint) => {
      const response = await fetch(`${app.url}${endpoint}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const commit = async (config, baseRevision, status = 200) => {
      const response = await fetch(`${app.url}api/v1/config/commit`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ config, baseRevision }),
      });
      const body = await response.json();
      assert.equal(response.status, status, JSON.stringify(body));
      return body;
    };
    const current = (await get("api/v1/config")).config;
    const invalid = structuredClone(current);
    delete invalid.upstreams.first;
    await commit(invalid, current.revision, 422);
    assert.deepEqual(JSON.parse(await fs.readFile(paths.secrets, "utf8")), secrets);
    assert.deepEqual((await get("api/v1/config")).config, current);

    const candidate = structuredClone(current);
    for (const key of ["bindings", "routes", "upstreams"]) delete candidate[key].first;
    delete candidate.virtualProviders.cabletidy_first;
    await commit(candidate, current.revision + 1, 409);
    assert.deepEqual(JSON.parse(await fs.readFile(paths.secrets, "utf8")), secrets);
    assert.deepEqual((await get("api/v1/config")).config, current);

    const deleted = await commit(candidate, current.revision);
    assert.equal(deleted.revision, current.revision + 1);
    assert.deepEqual(Object.keys(deleted.config.bindings), ["second"]);
    assert.deepEqual(deleted.config.upstreams.second, current.upstreams.second);
    assert.deepEqual(deleted.runtime.virtualProviders.map(({ id }) => id), ["cabletidy_second"]);
    assert.equal((await fetch(`${app.url}first/v1/models`)).status, 404);
    await get("second/v1/models");
    const saved = JSON.parse(await fs.readFile(paths.config, "utf8"));
    for (const key of ["bindings", "routes", "upstreams"]) assert.equal(saved[key].first, undefined);
    assert.equal(saved.virtualProviders.cabletidy_first, undefined);
    assert.deepEqual(JSON.parse(await fs.readFile(paths.secrets, "utf8")), {
      [secondRef]: "second-key", unrelated: "preserved-key",
    });

    const recreated = structuredClone(deleted.config);
    for (const key of ["bindings", "routes", "upstreams"]) recreated[key].first = initial[key].first;
    recreated.virtualProviders.cabletidy_first = initial.virtualProviders.cabletidy_first;
    const result = await commit(recreated, deleted.revision);
    assert.equal(result.config.upstreams.first.secretConfigured, sharedSecret);
    assert.equal(result.config.upstreams.second.secretConfigured, true);
  });
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

for (const format of ["v1 client names", "v1 dictionary keys", "v2 dictionary keys"]) {
  test(`${format}: model names survive GET, migration, commit and unrelated edits`, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-model-roundtrip-"));
    let app;
    t.after(async () => { await app?.close(); await fs.rm(home, { recursive: true, force: true }); });
    const paths = getPaths(home);
    const initial = claudeConfigFixture();
    initial.web.port = await freePort();
    const models = Object.fromEntries(names.map((name) => [name, {
      upstreamModelId: `vendor-${name}`,
      description: `Model ${name}`,
      ...Object.fromEntries(credentialFields.map((field) => [field, "credential-material"])),
      secretConfigured: true,
      metadata: [{ keep: true, apiKey: "nested-credential-material", secretConfigured: true,
        models: { token: "nested-credential-material" } }],
    }]));
    if (format.startsWith("v1")) {
      initial.version = 1;
      initial.models = Object.fromEntries(names.map((name, i) => {
        const { upstreamModelId, ...record } = models[name];
        return [format === "v1 client names" ? `internal-${i}` : name, {
          ...record, clientModelId: name, upstreams: { relay: { upstreamModelId } },
        }];
      }));
      initial.virtualProviders[providerId].allowedModels = Object.keys(initial.models);
      initial.routes.route.backends[0].models = Object.keys(initial.models);
      delete initial.virtualProviders[providerId].models;
    } else {
      initial.virtualProviders[providerId].models = models;
    }
    await fs.writeFile(paths.config, JSON.stringify(initial));
    app = await createApplication({ paths });
    const call = async (endpoint, body) => {
      const response = await fetch(`${app.url}api/v1/config${endpoint}`, body ? {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      } : {});
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.doesNotMatch(JSON.stringify(result), /credential-material|real-upstream-key/);
      return result;
    };
    const checkModels = (config, saved = false) => {
      assert.equal(config.version, 2);
      const actual = config.virtualProviders[providerId].models;
      assert.deepEqual(Object.keys(actual).sort(), [...names].sort());
      for (const name of names) {
        assert.equal(actual[name].upstreamModelId, `vendor-${name}`);
        assert.equal(actual[name].description, `Model ${name}`);
        for (const field of credentialFields) assert.equal(actual[name][field], undefined);
        assert.equal(actual[name].metadata[0].apiKey, undefined);
        assert.deepEqual(actual[name].metadata[0].models, {});
        if (saved) {
          assert.equal(actual[name].secretConfigured, undefined);
          assert.deepEqual(actual[name].metadata, [{ keep: true, models: {} }]);
        }
      }
    };
    const loaded = (await call("")).config;
    checkModels(loaded);
    initial.web = loaded.web;
    const committed = await call("/commit", {
      config: initial, baseRevision: loaded.revision, upstreamSecrets: { relay: "real-upstream-key" },
    });
    checkModels(committed.config, true);
    assert.equal(committed.config.upstreams.relay.secretConfigured, true);
    const edited = (await call("")).config;
    checkModels(edited, true);
    edited.upstreams.relay.name = "New upstream display name";
    checkModels((await call("/commit", { config: edited, baseRevision: edited.revision })).config, true);
    checkModels((await call("")).config, true);
    const disk = JSON.parse(await fs.readFile(paths.config, "utf8"));
    checkModels(disk, true);
    assert.equal(disk.upstreams.relay.secretRef, "secret://upstreams/relay");
    assert.equal(disk.upstreams.relay.secretConfigured, undefined);
    assert.doesNotMatch(JSON.stringify(disk), /credential-material|real-upstream-key/);
    assert.deepEqual(JSON.parse(await fs.readFile(paths.secrets, "utf8")), {
      "secret://upstreams/relay": "real-upstream-key",
    });
  });
}
