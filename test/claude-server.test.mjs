import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createApplication } from "../src/server.mjs";
import { getPaths } from "../src/config.mjs";
import { claudeConfigFixture } from "./helpers/claude-fixture.mjs";

async function fixture(t, handler, configure = () => {}) {
  const calls = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    calls.push({ url: request.url, headers: request.headers, body });
    await handler(request, response, body);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-claude-api-"));
  const app = await createApplication({ paths: getPaths(home), claudeHome: path.join(home, "client") });
  t.after(async () => {
    upstream.closeAllConnections();
    await Promise.all([app.close(), new Promise((resolve) => upstream.close(resolve))]);
    await fs.rm(home, { recursive: true, force: true });
  });
  const config = claudeConfigFixture(`http://127.0.0.1:${upstream.address().port}/relay/v1?fixed=1`, Number(new URL(app.url).port));
  configure(config);
  const call = (route, body, headers = {}, method = body === undefined ? "GET" : "POST") => fetch(`${app.url}${route}`, {
    method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const commit = await call("api/v1/config/commit", { baseRevision: 0, config, upstreamSecrets: { relay: "real-upstream-secret" } });
  assert.equal(commit.status, 200, await commit.text());
  return { app, config, calls, call, home, upstream };
}

function message(response, body) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ id: "msg_test", type: "message", model: body.model, content: [{ type: "tool_use", name: "inspect", id: "tool_1", input: { model: body.model } }], stop_reason: "tool_use" }));
}

test("Messages preserves extension fields, headers and nested tool payloads while replacing only upstream auth and model", async (t) => {
  const f = await fixture(t, (req, res, body) => message(res, body));
  const request = {
    model: "claude-sonnet-4-6", max_tokens: 100, system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }] }],
    tools: [{ name: "inspect", input_schema: { type: "object", properties: { model: { type: "string" } } }, defer_loading: true }],
    thinking: { type: "adaptive" }, output_config: { effort: "high" }, context_management: { edits: [] }, future_field: { retained: true },
  };
  const response = await f.call("claude-main/v1/messages?beta=true", request, {
    authorization: "Bearer cabletidy-local", "x-api-key": "never-forward-this", "anthropic-version": "2023-06-01",
    "anthropic-beta": "future-feature-1,another-2", "anthropic-future-header": "future", "x-claude-code-session-id": "session",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls[0].body, { ...request, model: "vendor-sonnet" });
  assert.equal(f.calls[0].url, "/relay/v1/messages?fixed=1&beta=true");
  assert.equal(f.calls[0].headers["anthropic-future-header"], "future");
  assert.equal(f.calls[0].headers["anthropic-beta"], "future-feature-1,another-2");
  assert.equal(f.calls[0].headers["x-claude-code-session-id"], "session");
  assert.equal(f.calls[0].headers["x-api-key"], "real-upstream-secret");
  assert.equal(f.calls[0].headers.authorization, undefined);
  const body = await response.json();
  assert.equal(body.model, request.model);
  assert.equal(body.content[0].input.model, "vendor-sonnet");
  const direct = await f.call("claude-main/v1/messages", { model: "claude-not-in-list", messages: [] });
  assert.equal(direct.status, 200);
  assert.equal((await direct.json()).model, "claude-not-in-list");
});

test("token counting does not require inference parameters or capabilities and preserves unsupported errors", async (t) => {
  const errorText = '{ "type": "error", "error": { "type": "not_found_error", "message": "unsupported", "model": "vendor-sonnet" } }';
  const f = await fixture(t, (req, res, body) => {
    if (body.messages.length) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"input_tokens":42}');
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(errorText);
    }
  }, (config) => { config.models.sonnet.capabilities = []; });
  const payload = { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "Hi" }], tools: [{ name: "tool" }] };
  const result = await f.call("claude-main/v1/messages/count_tokens?beta=true", payload);
  assert.deepEqual(await result.json(), { input_tokens: 42 });
  assert.equal(f.calls[0].url, "/relay/v1/messages/count_tokens?fixed=1&beta=true");
  assert.deepEqual(f.calls[0].body, { ...payload, model: "vendor-sonnet" });
  const unsupported = await f.call("claude-main/v1/messages/count_tokens", { model: payload.model, messages: [] });
  assert.equal(unsupported.status, 404);
  assert.equal(await unsupported.text(), errorText);
});

test("model discovery and startup HEAD stay local and all four endpoints honor pause", async (t) => {
  const f = await fixture(t, () => assert.fail("Local-only endpoint contacted upstream"), (config) => {
    config.models.opus = { ...structuredClone(config.models.sonnet), id: "opus", clientModelId: "claude-opus-4-6", aliases: ["claude-opus-4-6"] };
    config.virtualProviders["cabletidy_claude-main"].allowedModels.push("opus");
    config.routes.route.backends[0].models.push("opus");
  });
  const models = await f.call("claude-main/v1/models?limit=1");
  assert.equal(models.status, 200);
  assert.deepEqual(await models.json(), { data: [{ id: "claude-sonnet-4-6", type: "model", display_name: "Sonnet via relay", description: "Coding model" }],
    has_more: true, first_id: "claude-sonnet-4-6", last_id: "claude-sonnet-4-6" });
  const next = await f.call("claude-main/v1/models?limit=1000&after_id=claude-sonnet-4-6");
  assert.equal((await next.json()).data[0].id, "claude-opus-4-6");
  assert.equal((await f.call("claude-main/v1/models?limit=0")).status, 400);
  const probe = await f.call("claude-main/api/hello", undefined, {}, "HEAD");
  assert.equal(probe.status, 204);
  assert.equal(await probe.text(), "");
  assert.equal(f.calls.length, 0);
  await f.call("api/v1/virtual-providers/cabletidy_claude-main/pause", {});
  for (const [route, body, method] of [["v1/messages", { model: "x" }, "POST"], ["v1/messages/count_tokens", { model: "x" }, "POST"], ["v1/models", undefined, "GET"], ["api/hello", undefined, "HEAD"]]) {
    assert.equal((await f.call(`claude-main/${route}`, body, {}, method)).status, 503);
  }
  assert.equal(f.calls.length, 0);
});

test("empty discovery does not block inference and one configuration never lists another's models", async (t) => {
  const f = await fixture(t, (req, res, body) => message(res, body), (config) => {
    config.virtualProviders["cabletidy_claude-main"].allowedModels = [];
    config.routes.route.backends[0].models = [];
  });
  assert.deepEqual((await (await f.call("claude-main/v1/models")).json()).data, []);
  const response = await f.call("claude-main/v1/messages", { model: "claude-sonnet-4-6", messages: [] });
  assert.equal((await response.json()).model, "claude-sonnet-4-6");
  assert.equal(f.calls[0].body.model, "claude-sonnet-4-6");
});

test("Bearer upstreams receive saved credentials and upstream errors retain exact bodies and retry headers", async (t) => {
  const errorText = '{ "type":"error", "error":{"type":"rate_limit_error","message":"wait","model":"vendor-sonnet"} }';
  const f = await fixture(t, (req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "7", "x-should-retry": "false",
      "request-id": "req_123", "anthropic-ratelimit-unified-status": "rejected" });
    res.end(errorText);
  }, (config) => { config.upstreams.relay.auth = { header: "authorization", scheme: "Bearer" }; });
  const response = await f.call("claude-main/v1/messages", { model: "claude-sonnet-4-6", messages: [] });
  assert.equal(response.status, 429);
  assert.equal(await response.text(), errorText);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal(response.headers.get("x-should-retry"), "false");
  assert.equal(response.headers.get("request-id"), "req_123");
  assert.equal(response.headers.get("anthropic-ratelimit-unified-status"), "rejected");
  assert.equal(f.calls[0].headers.authorization, "Bearer real-upstream-secret");
  assert.equal(f.calls[0].headers["x-api-key"], undefined);
});

test("SSE is delivered before completion, preserves ping, tool fragments and errors, and cancels upstream on disconnect", async (t) => {
  let finish;
  let disconnected;
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const tail = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"model\\":\\"vendor-sonnet\\"}"}}\n\n' +
    'event: error\ndata: { "type":"error", "error":{"type":"overloaded_error","message":"busy"} }\n\n';
  const f = await fixture(t, (req, res, body) => {
    res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-status": "allowed" });
    res.write(': keepalive\n\nevent: ping\ndata: {"type":"ping"}\n\n');
    if (body.cancel) {
      res.once("close", disconnected);
      return;
    }
    res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"vendor-sonnet","content":[]}}\n\n');
    finish = () => { for (const byte of Buffer.from(tail)) res.write(Buffer.from([byte])); res.end(); };
  });
  const response = await f.call("claude-main/v1/messages", { model: "claude-sonnet-4-6", stream: true, messages: [] });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(Buffer.from(first.value).toString(), /keepalive/);
  finish();
  let text = Buffer.from(first.value).toString();
  while (true) { const chunk = await reader.read(); if (chunk.done) break; text += Buffer.from(chunk.value).toString(); }
  assert.match(text, /"model":"claude-sonnet-4-6"/);
  assert.ok(text.endsWith(tail));
  const cancelled = await f.call("claude-main/v1/messages", { model: "claude-sonnet-4-6", stream: true, messages: [], cancel: true });
  await cancelled.body.cancel();
  await Promise.race([closed, delay(3000).then(() => assert.fail("Upstream did not close after cancellation"))]);
});

test("management applies and restores Claude settings without returning existing secrets", async (t) => {
  const f = await fixture(t, (req, res, body) => message(res, body));
  const file = path.join(f.home, "client", "settings.json");
  await fs.mkdir(path.dirname(file));
  const original = { env: { ANTHROPIC_AUTH_TOKEN: "old-client-secret" }, permissions: { allow: ["Read"] } };
  await fs.writeFile(file, JSON.stringify(original));
  const preview = await f.call("api/v1/config/preview-target-artifacts", { bindingId: "claude-main" });
  assert.doesNotMatch(await preview.text(), /old-client-secret|real-upstream-secret/);
  const result = await f.call("api/v1/targets/apply", { bindingId: "claude-main" });
  assert.equal(result.status, 200);
  assert.doesNotMatch(await result.text(), /old-client-secret|real-upstream-secret/);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).env.ANTHROPIC_AUTH_TOKEN, "cabletidy-local");
  const restore = await f.call("api/v1/targets/restore", { bindingId: "claude-main" });
  assert.equal(restore.status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), original);
});

test("Claude diagnostics checks Messages rather than mistaking a reachable HTTP page for success", async (t) => {
  const f = await fixture(t, (req, res, body) => {
    if (body.model === "bad-key") { res.writeHead(401); res.end("denied"); }
    else if (body.model === "html") res.end("<html>OK</html>");
    else if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('event: message_start\ndata: {"type":"message_start","message":{"model":"vendor-sonnet"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    } else message(res, body);
  });
  for (const stream of [false, true]) {
    const response = await f.call("api/v1/tests/upstream", { id: "relay", bindingId: "claude-main", model: "claude-sonnet-4-6", stream });
    const report = await response.json();
    assert.equal(report.ok, true);
    assert.equal(report.authenticated, true);
    assert.equal(report.modelAvailable, true);
    assert.equal(f.calls.at(-1).body.model, "vendor-sonnet");
    assert.equal(f.calls.at(-1).body.max_tokens, 16);
  }
  for (const model of ["bad-key", "html"]) {
    const report = await (await f.call("api/v1/tests/upstream", { id: "relay", model })).json();
    assert.equal(report.ok, false);
    assert.equal(report.connected, true);
    assert.equal(report.authenticated, model === "bad-key" ? false : null);
  }
});
