import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../src/server.mjs";
import { getPaths, saveSecrets } from "../src/config.mjs";
import { catalogFixture, codexConfigFixture } from "./helpers/codex-fixture.mjs";

async function fixture(t) {
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
  config.models.other = {
    ...structuredClone(config.models.model), id: "other",
    upstreams: { other: { upstreamModelId: "OTHER-GPT" } },
  };
  config.routes.other = { id: "other", backends: [{ upstream: "other", models: ["other"] }] };
  // An occupied legacy port must not cause the shared listener to bind again.
  config.virtualProviders.cabletidy_relay.listenPort = upstreamPort;
  config.virtualProviders.cabletidy_other = {
    ...config.virtualProviders.cabletidy_relay, id: "cabletidy_other", route: "other",
    allowedModels: ["other"], defaultModel: "other",
  };
  config.bindings.other = {
    ...config.bindings.relay, id: "other", name: "Other", virtualProvider: "cabletidy_other", defaultModel: "other",
  };
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
  const { app, call, calls } = await fixture(t);
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
  await fs.writeFile(paths.backups, "block backup directory creation");
  const rejected = structuredClone(original);
  rejected.bindings.relay.name = "Unpublished";
  assert.equal((await commit(rejected)).status, 500);
  assert.equal(app.state.config.revision, original.revision);
  assert.equal((await call("relay/v1/models")).status, 200);
  assert.equal((await call("unpublished/v1/models")).status, 404);
  await fs.unlink(paths.backups);
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
