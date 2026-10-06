import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApplication } from "./helpers/native-app.mjs";
import { getPaths, nativeBinary } from "./helpers/native.mjs";

const execute = promisify(execFile);

async function fixture(t, { proxyKey, noProxyKey, https = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-upstream-proxy-"));
  const paths = getPaths(home);
  const calls = { direct: [], proxy: [], connect: [] };
  const servers = [];
  let app;
  t.after(async () => {
    await app?.close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await fs.rm(home, { recursive: true, force: true });
  });
  const listen = async via => {
    const server = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      calls[via].push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ via, model: body?.model, output: [], content: [], input_tokens: 42 }));
    });
    // Reject the tunnel locally so HTTPS proxy selection needs no external host or test CA.
    server.on("connect", (request, socket) => {
      calls.connect.push(request.url);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
  };
  const upstream = await listen("direct");
  const proxy = await listen("proxy");
  const env = Object.fromEntries([
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy", "REQUEST_METHOD",
  ].map(key => [key, undefined]));
  if (proxyKey) env[proxyKey] = proxy;
  if (noProxyKey) env[noProxyKey] = "localhost,127.0.0.1,::1";
  app = await createApplication({ paths, env });
  const config = app.state.config;
  const base = https ? "https://upstream.invalid" : upstream;
  for (const [id, protocol, target] of [
    ["responses", "openai.responses", "codex"],
    ["messages", "anthropic.messages", "claude-code"],
  ]) {
    config.upstreams[id] = { id, protocol, baseUrl: `${base}/${id}/v1` };
    config.routes[id] = { id, backends: [{ upstream: id }] };
    config.virtualProviders[`cabletidy_${id}`] = { id: `cabletidy_${id}`, ingressProtocol: protocol, route: id };
    config.bindings[id] = { id, name: id, target, virtualProvider: `cabletidy_${id}` };
  }
  const post = (route, body) => fetch(`${app.url}${route}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const saved = await post("api/v1/config/commit", {
    baseRevision: 0, config, upstreamSecrets: { responses: "responses-key", messages: "messages-key" },
  });
  assert.equal(saved.status, 200, await saved.text());
  return { app, paths, env, calls, post, base };
}

async function checkRequests(f, via) {
  const requests = [
    ["responses/v1/responses", { model: "test-model", input: "Hello" }],
    ["messages/v1/messages", { model: "test-model", max_tokens: 10, messages: [{ role: "user", content: "Hello" }] }],
    ["messages/v1/messages/count_tokens", { model: "test-model", messages: [] }],
  ];
  for (const [route, body] of requests) {
    const response = await f.post(route, body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).via, via);
  }
  for (const id of ["responses", "messages"]) {
    const response = await f.post("api/v1/tests/upstream", { id });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
  }
  const prefix = via === "proxy" ? f.base : "";
  assert.deepEqual(f.calls[via].map(({ method, url }) => [method, url]), [
    ["POST", `${prefix}/responses/v1/responses`],
    ["POST", `${prefix}/messages/v1/messages`],
    ["POST", `${prefix}/messages/v1/messages/count_tokens`],
    ["GET", `${prefix}/responses/v1`],
    ["GET", `${prefix}/messages/v1`],
  ]);
  assert.deepEqual(f.calls[via].slice(0, 3).map(call => call.body), requests.map(([, body]) => body));
  assert.equal(f.calls[via][0].headers.authorization, "Bearer responses-key");
  assert.equal(f.calls[via][1].headers["x-api-key"], "messages-key");
  assert.equal(f.calls[via === "proxy" ? "direct" : "proxy"].length, 0);
}

for (const proxyKey of ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
  test(`${proxyKey} routes Responses, Messages, token counts and probes through the proxy`, async t => {
    await checkRequests(await fixture(t, { proxyKey }), "proxy");
  });
}

for (const noProxyKey of ["NO_PROXY", "no_proxy"]) {
  test(`${noProxyKey} bypasses the upstream proxy for loopback addresses`, async t => {
    await checkRequests(await fixture(t, { proxyKey: "HTTP_PROXY", noProxyKey }), "direct");
  });
}

test("upstream requests stay direct when proxy variables are unset", async t => {
  await checkRequests(await fixture(t), "direct");
});

for (const proxyKey of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY"]) {
  test(`${proxyKey} uses CONNECT for HTTPS upstreams and reports tunnel failures`, async t => {
    const f = await fixture(t, { proxyKey, https: true });
    for (const [route, body] of [
      ["responses/v1/responses", { model: "test-model", input: "Hello" }],
      ["messages/v1/messages", { model: "test-model", max_tokens: 10, messages: [] }],
    ]) {
      assert.equal((await f.post(route, body)).status, 502);
    }
    const probe = await f.post("api/v1/tests/upstream", { id: "responses" });
    assert.equal(probe.status, 200);
    assert.equal((await probe.json()).ok, false);
    assert.deepEqual(f.calls.connect, Array(3).fill("upstream.invalid:443"));
    assert.equal(f.calls.direct.length, 0);
    assert.equal(f.calls.proxy.length, 0);
  });
}

test("daemon status bypasses the proxy even without NO_PROXY", async t => {
  const f = await fixture(t, { proxyKey: "HTTP_PROXY" });
  const { stdout } = await execute(nativeBinary, ["status"], {
    env: { ...process.env, ...f.env, CABLETIDY_HOME: f.paths.home }, timeout: 5000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.runtime.status, "online");
  assert.equal(result.runtime.pid, f.app.child.pid);
  assert.equal(f.calls.proxy.length, 0);
});
