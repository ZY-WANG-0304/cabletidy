import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApplication } from "./helpers/native-app.mjs";
import { getPaths, normalizeConfig, saveConfig, saveSecrets } from "./helpers/native.mjs";
import { catalogFixture, namedCodexConfigFixture } from "./helpers/codex-fixture.mjs";

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("web control API and Codex Responses proxy form one working MVP slice", async () => {
  const upstreamPort = await freePort();
  const webPort = await freePort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-server-"));
  const paths = getPaths(home);
  let receivedBody;
  let receivedAuthorization;

  const fakeUpstream = http.createServer(async (request, response) => {
    receivedAuthorization = request.headers.authorization;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (receivedBody.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      response.write('data: {"model":"vendor');
      await new Promise((resolve) => setTimeout(resolve, 5));
      response.write('-sol","output":[]}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_test",
      object: "response",
      model: receivedBody.model,
      output: [],
    }));
  });
  await new Promise((resolve) => fakeUpstream.listen(upstreamPort, "127.0.0.1", resolve));

  const config = normalizeConfig({
    ...namedCodexConfigFixture({ codex: "codex" }),
    revision: 1,
    web: { listenHost: "127.0.0.1", port: webPort },
  });
  config.upstreams.codex.baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
  config.upstreams.codex.secretRef = "secret://upstreams/codex";
  config.models.codex.clientModelId = "gpt-5.6-sol";
  config.models.codex.aliases = ["sol"];
  config.models.codex.upstreams.codex.upstreamModelId = "vendor-sol";
  await saveConfig(config, paths);
  await saveSecrets({ "secret://upstreams/codex": "upstream-key" }, paths);

  const app = await createApplication({ paths, loadCodexCatalog: async () => catalogFixture(), codexHome: path.join(home, "client") });
  try {
    assert.equal(new URL(app.url).search, "");
    const runtimeInfo = JSON.parse(await fs.readFile(paths.runtime, "utf8"));
    assert.equal(runtimeInfo.web.url, app.url);
    assert.equal(runtimeInfo.bootstrapUrl, undefined);
    const catalogResponse = await fetch(`http://127.0.0.1:${webPort}/api/v1/catalog`, {
      headers: {},
    });
    const catalog = await catalogResponse.json();
    assert.equal(catalogResponse.status, 200);
    assert.deepEqual(
      catalog.requiredEndpoints["codex-native-provider"].map(({ method, path }) => `${method} ${path}`),
      ["GET /v1/models", "POST /v1/responses"],
    );
    const integrationsResponse = await fetch(`http://127.0.0.1:${webPort}/api/v1/integrations`, {
      headers: {},
    });
    const integrations = await integrationsResponse.json();
    assert.deepEqual(
      integrations.integrations[0].requiredEndpoints.map(({ method, path }) => `${method} ${path}`),
      ["GET /v1/models", "POST /v1/responses"],
    );
    const runtimeResponse = await fetch(`http://127.0.0.1:${webPort}/api/v1/runtime`, {
      headers: {},
    });
    const runtime = await runtimeResponse.json();
    assert.equal(runtime.counts.models, 1);
    assert.equal(runtime.virtualProviders[0].id, "cabletidy_codex");

    const artifactResponse = await fetch(
      `http://127.0.0.1:${webPort}/api/v1/config/preview-target-artifacts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bindingId: "codex" }),
      },
    );
    const artifactPreview = await artifactResponse.json();
    assert.equal(artifactResponse.status, 200);
    assert.equal(artifactPreview.artifacts.target, "codex");
    assert.equal(artifactPreview.artifacts.providerId, runtime.virtualProviders[0].id);
    assert.equal(artifactPreview.artifacts.virtualProviderId, runtime.virtualProviders[0].id);
    assert.doesNotMatch(JSON.stringify(artifactPreview), /upstream-key/);

    const modelsResponse = await fetch(`http://127.0.0.1:${webPort}/codex/v1/models`);
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual((await modelsResponse.json()).data.map((model) => model.id), ["gpt-5.6-sol"]);

    const validateResponse = await fetch(`http://127.0.0.1:${webPort}/api/v1/config/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          ...config,
          web: { ...config.web },
        },
      }),
    });
    const validation = await validateResponse.json();
    assert.equal(validation.ok, true);
    assert.equal(validation.diff.total, 0);

    const commitResponse = await fetch(`http://127.0.0.1:${webPort}/api/v1/config/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: config.revision,
        config: {
          ...config,
          web: { ...config.web },
        },
      }),
    });
    const committed = await commitResponse.json();
    assert.equal(commitResponse.status, 200);
    assert.equal(committed.revision, 2);
    assert.equal(committed.runtime.revision, 2);
    const backups = await fs.readdir(paths.backups);
    assert.ok(backups.some((file) => file.includes("config-2.json")));
    assert.ok(backups.some((file) => file.includes("secrets-2.json")));

    const multipleUpstreams = structuredClone(committed.config);
    multipleUpstreams.routes.codex.backends.push({
      ...multipleUpstreams.routes.codex.backends[0], enabled: false,
    });
    const rejectedCommit = await fetch(`http://127.0.0.1:${webPort}/api/v1/config/commit`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 2, config: multipleUpstreams }),
    });
    assert.equal(rejectedCommit.status, 422);
    assert.ok((await rejectedCommit.json()).errors.some((error) => error.path === "routes.codex.backends"));
    assert.equal(app.state.config.revision, 2);

    const pauseResponse = await fetch(
      `http://127.0.0.1:${webPort}/api/v1/virtual-providers/cabletidy_codex/pause`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    const paused = await pauseResponse.json();
    assert.equal(pauseResponse.status, 200);
    assert.equal(paused.enabled, false);
    assert.equal(paused.runtime.virtualProviders[0].status, "paused");

    const startResponse = await fetch(
      `http://127.0.0.1:${webPort}/api/v1/virtual-providers/cabletidy_codex/start`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    const started = await startResponse.json();
    assert.equal(startResponse.status, 200);
    assert.equal(started.enabled, true);
    assert.equal(started.runtime.virtualProviders[0].status, "listening");

    const resolveResponse = await fetch(`http://127.0.0.1:${webPort}/api/v1/tests/model-resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ virtualProviderId: "cabletidy_codex", model: "sol", stream: true }),
    });
    const resolved = await resolveResponse.json();
    assert.equal(resolved.upstreamModelId, "vendor-sol");

    const proxyResponse = await fetch(`http://127.0.0.1:${webPort}/codex/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "sol", input: "hello" }),
    });
    assert.equal(proxyResponse.status, 200);
    const proxied = await proxyResponse.json();
    assert.equal(receivedBody.model, "vendor-sol");
    assert.equal(receivedAuthorization, "Bearer upstream-key");
    assert.equal(proxied.model, "sol");

    const streamResponse = await fetch(`http://127.0.0.1:${webPort}/codex/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "sol", stream: true, input: "hello" }),
    });
    assert.equal(streamResponse.status, 200);
    assert.equal(
      await streamResponse.text(),
      'data: {"model":"sol","output":[]}\n\ndata: [DONE]\n\n',
    );
    assert.equal(receivedAuthorization, "Bearer upstream-key");
    const ignoredKeyResponse = await fetch(`http://127.0.0.1:${webPort}/codex/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ignored-client-key" },
      body: JSON.stringify({ model: "sol", input: "hello" }),
    });
    assert.equal(ignoredKeyResponse.status, 200);
    await ignoredKeyResponse.json();
    assert.equal(receivedAuthorization, "Bearer upstream-key");

    const legacySessionResponse = await fetch(`http://127.0.0.1:${webPort}/api/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-used" }),
    });
    assert.equal(legacySessionResponse.status, 404);
  } finally {
    await app.close();
    await new Promise((resolve) => fakeUpstream.close(resolve));
  }
});

test("upstream connectivity test can use an API key from the unsaved draft", async () => {
  const upstreamPort = await freePort();
  const webPort = await freePort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-draft-secret-"));
  const paths = getPaths(home);
  let receivedAuthorization;
  const fakeUpstream = http.createServer((request, response) => {
    receivedAuthorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => fakeUpstream.listen(upstreamPort, "127.0.0.1", resolve));

  await saveConfig(normalizeConfig({ web: { port: webPort } }), paths);
  const app = await createApplication({ paths });

  try {
    const response = await fetch(`http://127.0.0.1:${webPort}/api/v1/tests/upstream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "draft-relay",
        config: {
          upstreams: {
            "draft-relay": {
              id: "draft-relay",
              protocol: "openai.responses",
              baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
              secretRef: "secret://upstreams/draft-relay",
            },
          },
        },
        upstreamSecrets: { "draft-relay": "draft-key" },
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.secretConfigured, true);
    assert.equal(result.ok, true);
    assert.equal(receivedAuthorization, "Bearer draft-key");
  } finally {
    await app.close();
    await new Promise((resolve) => fakeUpstream.close(resolve));
  }
});

test("Anthropic Messages Virtual Provider keeps native wire format and maps models", async () => {
  const upstreamPort = await freePort();
  const webPort = await freePort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-anthropic-"));
  const paths = getPaths(home);
  let receivedBody;
  let receivedHeaders;

  const fakeUpstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedHeaders = request.headers;
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (receivedBody.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'event: message_start\n' +
        'data: {"type":"message_start","message":{"model":"vendor-sonnet","id":"msg_1"}}\n\n',
      );
      response.end(
        'event: message_stop\n' +
        'data: {"type":"message_stop"}\n\n',
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "msg_1",
      type: "message",
      model: receivedBody.model,
      role: "assistant",
      content: [],
      stop_reason: "end_turn",
    }));
  });
  await new Promise((resolve) => fakeUpstream.listen(upstreamPort, "127.0.0.1", resolve));

  const config = {
    version: 1,
    revision: 1,
    web: { listenHost: "127.0.0.1", port: webPort },
    upstreams: {
      anthropic: {
        id: "anthropic",
        name: "Anthropic Relay",
        protocol: "anthropic.messages",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        auth: { header: "x-api-key" },
        secretRef: "secret://upstreams/anthropic",
      },
    },
    models: {
      "claude-sonnet": {
        id: "claude-sonnet",
        aliases: ["sonnet"],
        clientModelId: "sonnet",
        family: "claude",
        capabilities: ["streaming", "tools", "vision", "reasoning"],
        upstreams: { anthropic: { upstreamModelId: "vendor-sonnet" } },
      },
    },
    routes: {
      "claude-route": {
        id: "claude-route",
        backends: [{ upstream: "anthropic", models: ["claude-sonnet"] }],
      },
    },
    virtualProviders: {
      "claude-main": {
        id: "claude-main",
        name: "Claude Main",
        ingressProtocol: "anthropic.messages",
        route: "claude-route",
        allowedModels: ["claude-sonnet"],
        defaultModel: "claude-sonnet",
      },
    },
    bindings: {
      "claude-main": {
        id: "claude-main",
        target: "claude-code",
        targetFormat: "claude.env.v1",
        virtualProvider: "claude-main",
        mode: "env",
        defaultModel: "claude-sonnet",
      },
    },
  };
  await saveConfig(config, paths);
  await saveSecrets({ "secret://upstreams/anthropic": "upstream-key" }, paths);

  const app = await createApplication({ paths, claudeHome: path.join(home, "claude") });
  try {
    const previewResponse = await fetch(
      `http://127.0.0.1:${webPort}/api/v1/config/preview-target-artifacts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bindingId: "claude-main" }),
      },
    );
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200);
    assert.equal(preview.artifacts.target, "claude-code");
    assert.doesNotMatch(JSON.stringify(preview), /upstream-key/);

    const applyResponse = await fetch(
      `http://127.0.0.1:${webPort}/api/v1/targets/apply`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bindingId: "claude-main" }),
      },
    );
    const applyBody = await applyResponse.json();
    assert.equal(applyResponse.status, 200);
    assert.equal(applyBody.target, "claude-code");
    const settings = JSON.parse(await fs.readFile(path.join(home, "claude", "settings.json"), "utf8"));
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "cabletidy-local");

    const response = await fetch(`http://127.0.0.1:${webPort}/claude-main/v1/messages`, {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "sonnet",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(receivedBody.model, "vendor-sonnet");
    assert.equal(receivedHeaders["x-api-key"], "upstream-key");
    assert.equal(receivedHeaders["anthropic-version"], "2023-06-01");
    assert.equal(body.model, "sonnet");

    const streamResponse = await fetch(`http://127.0.0.1:${webPort}/claude-main/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "sonnet",
        max_tokens: 32,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(streamResponse.status, 200);
    const streamText = await streamResponse.text();
    assert.match(streamText, /"model":"sonnet"/g);
    assert.doesNotMatch(streamText, /vendor-sonnet/);

    const ignoredKeyResponse = await fetch(`http://127.0.0.1:${webPort}/claude-main/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "ignored-client-key" },
      body: JSON.stringify({ model: "sonnet", messages: [] }),
    });
    assert.equal(ignoredKeyResponse.status, 200);
    assert.equal((await ignoredKeyResponse.json()).model, "sonnet");
    assert.equal(receivedHeaders["x-api-key"], "upstream-key");
  } finally {
    await app.close();
    await new Promise((resolve) => fakeUpstream.close(resolve));
  }
});

test("upstream errors are returned without contacting another configured upstream", async () => {
  const primaryPort = await freePort();
  const backupPort = await freePort();
  const webPort = await freePort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-single-upstream-"));
  const paths = getPaths(home);
  const calls = [];

  const primary = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ server: "primary", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "busy" }));
  });
  const backup = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ server: "backup", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "response", model: calls.at(-1).body.model, output: [] }));
  });
  await Promise.all([
    new Promise((resolve) => primary.listen(primaryPort, "127.0.0.1", resolve)),
    new Promise((resolve) => backup.listen(backupPort, "127.0.0.1", resolve)),
  ]);

  const config = normalizeConfig({
    ...namedCodexConfigFixture({ codex: "codex" }),
    revision: 1,
    web: { listenHost: "127.0.0.1", port: webPort },
    bindings: {},
  });
  config.upstreams.codex.baseUrl = `http://127.0.0.1:${primaryPort}/v1`;
  config.upstreams.backup = {
    id: "backup", protocol: "openai.responses", baseUrl: `http://127.0.0.1:${backupPort}/v1`,
  };
  config.models.codex.clientModelId = "coder";
  config.models.codex.aliases = ["coder"];
  config.models.codex.upstreams.codex.upstreamModelId = "vendor-primary";
  await saveConfig(config, paths);
  const app = await createApplication({ paths });
  try {
    const response = await fetch(`http://127.0.0.1:${webPort}/codex/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "coder", input: "hello" }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(calls.map((item) => item.server), ["primary"]);
    assert.equal(calls[0].body.model, "vendor-primary");
    assert.equal(body.error, "busy");
  } finally {
    await app.close();
    await Promise.all([
      new Promise((resolve) => primary.close(resolve)),
      new Promise((resolve) => backup.close(resolve)),
    ]);
  }
});

test("changing the shared listener requires restart and preserves the running configuration", async () => {
  const webPort = await freePort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-atomic-reload-"));
  const paths = getPaths(home);

  const config = normalizeConfig({
    ...namedCodexConfigFixture({ primary: "primary" }),
    revision: 1,
    web: { listenHost: "127.0.0.1", port: webPort },
    bindings: {},
  });
  await saveConfig(config, paths);

  const app = await createApplication({ paths });
  try {
    const candidate = structuredClone(config);
    candidate.web.port = webPort === 65535 ? 65534 : webPort + 1;

    const commitResponse = await fetch(`http://127.0.0.1:${webPort}/api/v1/config/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: config.revision,
        config: candidate,
      }),
    });
    const commitBody = await commitResponse.json();
    assert.equal(commitResponse.status, 422);
    assert.equal(commitBody.error.code, "web_listener_restart_required");

    const modelsResponse = await fetch(`http://127.0.0.1:${webPort}/primary/v1/models`);
    assert.equal(modelsResponse.status, 200);
    assert.equal((await modelsResponse.json()).data[0].id, "gpt-5.5");
    assert.equal(app.state.config.revision, 1);
    assert.equal(app.state.webServer.listening, true);
  } finally {
    await app.close();
  }
});

test("unsupported Virtual Provider ingress returns an explicit 501", async () => {
  const webPort = await freePort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-unsupported-ingress-"));
  const paths = getPaths(home);
  const config = normalizeConfig({
    ...namedCodexConfigFixture({ chat: "chat" }),
    revision: 1,
    web: { listenHost: "127.0.0.1", port: webPort },
    bindings: {},
  });
  config.upstreams.chat.protocol = "openai.chat_completions";
  config.virtualProviders.cabletidy_chat.ingressProtocol = "openai.chat_completions";
  await saveConfig(config, paths);

  const app = await createApplication({ paths });
  try {
    const response = await fetch(`http://127.0.0.1:${webPort}/chat/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.5", messages: [] }),
    });
    const body = await response.json();
    assert.equal(response.status, 501);
    assert.equal(body.error.code, "unsupported_protocol");
  } finally {
    await app.close();
  }
});
