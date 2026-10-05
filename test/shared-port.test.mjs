import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "./helpers/native-app.mjs";
import { getPaths, saveSecrets } from "./helpers/native.mjs";
import { catalogFixture, codexConfigFixture } from "./helpers/codex-fixture.mjs";

async function fixture(t, configure = () => {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-shared-port-"));
  const paths = getPaths(home);
  const calls = [];
  const streams = [];
  let app;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({ url: request.url, authorization: request.headers.authorization, body });
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ model: body.model, delta: "first" })}\n\n`);
      streams.push(() => {
        if (!response.writableEnded) response.end(`data: ${JSON.stringify({ model: body.model, delta: "last" })}\n\n`);
      });
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: body.model, output: [] }));
    }
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    streams.forEach(finish => finish());
    await app?.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  });
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const webPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const upstreamPort = upstream.address().port;
  const config = { ...codexConfigFixture(), web: { listenHost: "127.0.0.1", port: webPort } };
  config.upstreams.relay.baseUrl = `http://127.0.0.1:${upstreamPort}/left/v1?fixed=1`;
  config.upstreams.relay.secretRef = "secret://upstreams/relay";
  config.upstreams.other = {
    ...config.upstreams.relay, id: "other", baseUrl: `http://127.0.0.1:${upstreamPort}/right/v1`,
    secretRef: "secret://upstreams/other",
  };
  config.routes.other = { id: "other", backends: [{ upstream: "other" }] };
  // An occupied legacy port must not cause the shared listener to bind again.
  config.virtualProviders.cabletidy_relay.listenPort = upstreamPort;
  config.virtualProviders.cabletidy_other = {
    ...config.virtualProviders.cabletidy_relay, id: "cabletidy_other", route: "other",
    models: { "gpt-5.5": { ...structuredClone(config.virtualProviders.cabletidy_relay.models["gpt-5.5"]), upstreamModelId: "OTHER-GPT" } }, defaultModel: "gpt-5.5",
  };
  config.bindings.other = {
    ...config.bindings.relay, id: "other", name: "Other", virtualProvider: "cabletidy_other", defaultModel: "gpt-5.5",
  };
  configure(config);
  await fs.writeFile(paths.config, JSON.stringify(config));
  await saveSecrets({ "secret://upstreams/relay": "left-key", "secret://upstreams/other": "right-key" }, paths);
  app = await createApplication({ paths, codexHome: path.join(home, "client"), loadCodexCatalog: async () => catalogFixture() });
  const call = async (url, body, headers = {}) => {
    const response = await fetch(`${app.url}${url}`, {
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      headers: { "content-type": "application/json", ...headers },
    });
    return { status: response.status, body: await response.json() };
  };
  const commit = config => call("api/v1/config/commit", { config, baseRevision: config.revision });
  return { app, paths, call, commit, calls, streams };
}

test("shared paths isolate models, credentials and pause state while keeping control APIs available", async (t) => {
  const { app, call, calls } = await fixture(t, config => { config.web.enabled = false; });
  assert.equal((await fetch(app.url)).status, 200);
  assert.equal((await fetch(`${app.url}config-identity.js`)).status, 200);
  const runtime = (await call("api/v1/runtime")).body;
  assert.deepEqual(runtime.virtualProviders.map(item => item.baseUrl), [
    `${app.url}relay/v1`, `${app.url}other/v1`,
  ]);
  assert.equal(new Set(runtime.virtualProviders.map(item => item.listen)).size, 1);
  for (const id of ["relay", "other"]) {
    const models = await call(`${id}/v1/models`);
    assert.equal(models.status, 200);
    assert.equal(models.body.data[0].id, "gpt-5.5");
    assert.equal((await call(`${id}/v1/responses?trace=hello%20world`, { model: "gpt-5.5" })).body.model, "gpt-5.5");
  }
  assert.deepEqual(calls.map(call => [call.url, call.authorization, call.body.model]), [
    ["/left/v1/responses?fixed=1&trace=hello+world", "Bearer left-key", "VENDOR-GPT"],
    ["/right/v1/responses?trace=hello+world", "Bearer right-key", "OTHER-GPT"],
  ]);
  for (const url of ["missing/v1/responses", "relay-extra/v1/responses", "cabletidy_relay/v1/responses", "v1/responses", "relay/api/v1/config"]) {
    assert.equal((await call(url, { model: "gpt-5.5" })).status, 404, url);
  }
  assert.equal(calls.length, 2);
  assert.equal((await call("relay/v1/models", undefined, { origin: "https://example.invalid" })).status, 403);
  assert.equal((await call("api/v1/config", undefined, { origin: "https://example.invalid" })).status, 403);
  assert.equal((await call("api/v1/virtual-providers/cabletidy_relay/pause", {})).status, 200);
  assert.equal((await call("relay/v1/models")).status, 503);
  assert.equal((await call("other/v1/models")).status, 200);
  assert.equal((await call("api/v1/runtime")).status, 200);
  assert.equal((await call("api/v1/virtual-providers/cabletidy_relay/start", {})).status, 200);
  assert.equal((await call("relay/v1/models")).status, 200);
});

test("saving an API key uses it on outbound requests despite legacy environment credentials", async (t) => {
  const envKey = "CABLETIDY_TEST_UPSTREAM_API_KEY";
  const previous = process.env[envKey];
  t.after(() => {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  });
  process.env[envKey] = "stale-environment-key";
  const { app, paths, call, calls } = await fixture(t, config => {
    config.upstreams.relay.envKey = envKey;
    config.upstreams.other.envKey = envKey;
    delete config.upstreams.other.secretRef;
  });

  const publicConfig = (await call("api/v1/config")).body.config;
  assert.equal(publicConfig.upstreams.relay.secretConfigured, true);
  assert.equal(publicConfig.upstreams.other.secretConfigured, false);
  assert.doesNotMatch(JSON.stringify(publicConfig), /envKey|stale-environment-key/);
  const preview = await call("api/v1/config/preview-target-artifacts", { bindingId: "other" });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.artifacts.upstream.secretConfigured, false);
  assert.equal(Object.hasOwn(preview.body.artifacts.upstream, "envKey"), false);
  assert.equal((await call("other/v1/responses", { model: "gpt-5.5" })).status, 200);
  assert.equal(calls.at(-1).authorization, undefined);

  const config = structuredClone(app.state.config);
  // A stale browser may still submit the removed fields when saving a new key.
  config.upstreams.relay.envKey = envKey;
  config.upstreams.relay.codexToml = { envKey };
  config.upstreams.relay.codexNative = { envKey };
  const saved = await call("api/v1/config/commit", {
    config, baseRevision: config.revision, upstreamSecrets: { relay: "new-saved-key" },
  });
  assert.equal(saved.status, 200);
  assert.doesNotMatch(JSON.stringify(saved.body.config), /envKey|codexToml|codexNative|new-saved-key/);
  const storedConfig = await fs.readFile(paths.config, "utf8");
  assert.doesNotMatch(storedConfig, /envKey|codexToml|codexNative/);
  const storedSecrets = JSON.parse(await fs.readFile(paths.secrets, "utf8"));
  assert.equal(storedSecrets["secret://upstreams/relay"], "new-saved-key");
  assert.equal((await call("relay/v1/responses", { model: "gpt-5.5" })).status, 200);
  assert.equal(calls.at(-1).authorization, "Bearer new-saved-key");
});

test("upstream-only configuration commits, previews and relays JSON and SSE without model registration", async (t) => {
  const { app, call, commit, calls, streams } = await fixture(t);
  const config = structuredClone(app.state.config);
  delete config.virtualProviders.cabletidy_relay.models["gpt-5.5"];
  delete config.routes.route.backends[0].models;
  delete config.virtualProviders.cabletidy_relay.models;
  delete config.virtualProviders.cabletidy_relay.defaultModel;
  delete config.bindings.relay.defaultModel;
  app.state.loadCodexCatalog = async () => { throw new Error("catalog unavailable"); };
  assert.equal((await commit(config)).status, 200);
  const preview = await call("api/v1/config/preview-target-artifacts", { bindingId: "relay" });
  assert.equal(preview.status, 200);
  assert.doesNotMatch(preview.body.artifacts.files[0].contents, /^model =/m);
  assert.deepEqual((await call("relay/v1/models")).body.data, []);
  const request = {
    model: "gpt-5.5", input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,test" }] }],
    instructions: "Client instructions", tools: [{ type: "function", name: "lookup", parameters: {} }],
    tool_choice: "auto", parallel_tool_calls: true, reasoning: { effort: "high" },
  };
  assert.equal((await call("relay/v1/responses", request)).body.model, "gpt-5.5");
  assert.deepEqual(calls.at(-1).body, request);
  assert.equal(calls.at(-1).authorization, "Bearer left-key");
  assert.equal((await call("other/v1/responses", { model: "gpt-5.5" })).body.model, "gpt-5.5");
  assert.equal(calls.at(-1).body.model, "OTHER-GPT");
  const unknown = { model: "new-upstream-model", input: "hello", stream: true };
  const response = await fetch(`${app.url}relay/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(unknown),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.at(-1).body, unknown);
  streams.forEach(finish => finish());
  assert.match(await response.text(), /"model":"new-upstream-model","delta":"last"/);
  const resolved = await call("api/v1/tests/model-resolve", { virtualProviderId: "cabletidy_relay", model: "new-upstream-model" });
  assert.deepEqual(resolved.body.rejectedBackends, []);
  assert.equal(resolved.body.matchedModel, null);
  assert.equal(resolved.body.upstreamModelId, "new-upstream-model");
  const count = calls.length;
  assert.equal((await call("relay/v1/responses", { input: "missing model" })).status, 400);
  assert.equal(calls.length, count);
});

test("renames and removals update shared paths without interrupting an existing stream", async (t) => {
  const { app, call, commit, streams } = await fixture(t);
  const response = await fetch(`${app.url}relay/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", stream: true }),
  });
  assert.equal(response.status, 200);
  const body = response.text();
  const candidate = structuredClone(app.state.config);
  candidate.bindings.relay.name = "Renamed Relay";
  assert.equal((await commit(candidate)).status, 200);
  assert.equal((await call("relay/v1/models")).status, 404);
  assert.equal((await call("renamed-relay/v1/models")).status, 200);
  assert.equal((await call("other/v1/models")).status, 200);
  const preview = await call("api/v1/config/preview-target-artifacts", { bindingId: "renamed-relay" });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.artifacts.files[0].contents.includes(`${app.url}renamed-relay/v1`));
  streams.forEach(finish => finish());
  const text = await body;
  assert.match(text, /"delta":"last"/);
  assert.doesNotMatch(text, /VENDOR-GPT/);
  assert.match(text, /"model":"gpt-5.5"/);
  const removed = structuredClone(app.state.config);
  delete removed.bindings["renamed-relay"];
  delete removed.virtualProviders["cabletidy_renamed-relay"];
  assert.equal((await commit(removed)).status, 200);
  assert.equal((await call("renamed-relay/v1/models")).status, 404);
  assert.equal((await call("other/v1/models")).status, 200);
});

test("failed saves preserve active paths and concurrent commits still compare revisions", async (t) => {
  const { app, paths, call, commit } = await fixture(t);
  const original = structuredClone(app.state.config);
  await fs.rmdir(paths.backups);
  const rejected = structuredClone(original);
  rejected.bindings.relay.name = "Unpublished";
  for (const blockedByFile of [false, true]) {
    if (blockedByFile) await fs.writeFile(paths.backups, "block backup directory creation");
    assert.equal((await commit(rejected)).status, 500);
    assert.equal(app.state.config.revision, original.revision);
    assert.equal((await call("relay/v1/models")).status, 200);
    assert.equal((await call("unpublished/v1/models")).status, 404);
  }
  await fs.unlink(paths.backups);
  await fs.mkdir(paths.backups);
  const left = structuredClone(original);
  const right = structuredClone(original);
  left.bindings.relay.name = "First Save";
  right.bindings.relay.name = "Second Save";
  const outcomes = await Promise.all([commit(left), commit(right)]);
  assert.deepEqual(outcomes.map(result => result.status).sort(), [200, 409]);
  const winner = outcomes[0].status === 200 ? "first-save" : "second-save";
  const loser = outcomes[0].status === 200 ? "second-save" : "first-save";
  assert.equal((await call(`${winner}/v1/models`)).status, 200);
  assert.equal((await call(`${loser}/v1/models`)).status, 404);
  assert.equal(app.state.config.revision, original.revision + 1);
});
