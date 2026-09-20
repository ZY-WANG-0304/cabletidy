import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApplication } from "../src/server.mjs";
import { getPaths, saveConfig, saveSecrets } from "../src/config.mjs";
import { catalogFixture } from "./helpers/codex-fixture.mjs";

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

  const config = {
    version: 1,
    revision: 1,
    web: { enabled: true, listenHost: "127.0.0.1", port: webPort },
    upstreams: {
      primary: {
        id: "primary",
        name: "Primary",
        integration: "codex-native-provider",
        protocol: "openai.responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        envKey: "PRIMARY_API_KEY",
        secretRef: "secret://upstreams/primary",
        enabled: true,
      },
    },
    models: {
      "codex-sol": {
        id: "codex-sol",
        aliases: ["sol"],
        clientModelId: "gpt-5.6-sol",
        family: "codex",
        capabilities: ["streaming", "tools", "reasoning"],
        upstreams: { primary: { upstreamModelId: "vendor-sol" } },
      },
    },
    routes: {
      primary: {
        id: "primary",
        strategy: "priority",
        backends: [{ upstream: "primary", priority: 10, models: ["codex-sol"], enabled: true }],
      },
    },
    virtualProviders: {
      codex: {
        id: "codex",
        name: "Codex",
        ingressProtocol: "openai.responses",
        route: "primary",
        allowedModels: ["codex-sol"],
        defaultModel: "codex-sol",
        localAuth: { secretRef: "secret://virtual-providers/codex" },
        enabled: true,
      },
    },
    bindings: {
      codex: {
        id: "codex",
        target: "codex",
        virtualProvider: "codex",
        integration: "codex-native-provider",
        targetFormat: "codex.config.toml.v1",
        mode: "config",
        defaultModel: "codex-sol",
        codex: {
          providerId: "cabletidy_primary",
        },
      },
    },
  };
  await saveConfig(config, paths);
  await saveSecrets({
    "secret://upstreams/primary": "upstream-key",
    "secret://virtual-providers/codex": "local-key",
  }, paths);

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
    assert.doesNotMatch(JSON.stringify(artifactPreview), /local-key/);

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
    multipleUpstreams.routes.primary.backends.push({
      ...multipleUpstreams.routes.primary.backends[0], enabled: false,
    });
    const rejectedCommit = await fetch(`http://127.0.0.1:${webPort}/api/v1/config/commit`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 2, config: multipleUpstreams }),
    });
    assert.equal(rejectedCommit.status, 422);
    assert.ok((await rejectedCommit.json()).errors.some((error) => error.path === "routes.primary.backends"));
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

  await saveConfig({
    version: 1,
    revision: 0,
    web: { enabled: true, listenHost: "127.0.0.1", port: webPort },
    upstreams: {},
    models: {},
    routes: {},
    virtualProviders: {},
    bindings: {},
  }, paths);
  await saveSecrets({}, paths);
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

test("Web configuration graph can be committed without external reference files", async () => {
  const upstreamPort = await freePort();
  const webPort = await freePort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-web-wizard-"));
  const paths = getPaths(home);
  let receivedBody;
  const fakeUpstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      object: "response",
      model: receivedBody.model,
      output: [],
    }));
  });
  await new Promise((resolve) => fakeUpstream.listen(upstreamPort, "127.0.0.1", resolve));

  const initialConfig = {
    version: 1,
    revision: 0,
    web: { enabled: true, listenHost: "127.0.0.1", port: webPort },
    upstreams: {},
    models: {},
    routes: {},
    virtualProviders: {},
    bindings: {},
  };
  await saveConfig(initialConfig, paths);
  await saveSecrets({}, paths);
  const app = await createApplication({ paths, loadCodexCatalog: async () => catalogFixture(), codexHome: path.join(home, "client") });

  try {
    const candidate = {
      ...initialConfig,
      upstreams: {
        primary: {
          id: "primary",
          name: "Primary relay",
          integration: "codex-native-provider",
          protocol: "openai.responses",
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          envKey: "PRIMARY_API_KEY",
          secretRef: "secret://upstreams/primary",
          enabled: true,
        },
      },
      models: {
        "gpt56-sol": {
          id: "gpt56-sol",
          name: "GPT-5.6 Sol",
          clientModelId: "gpt-5.6-sol",
          aliases: ["gpt-5.6-sol", "sol"],
          family: "codex",
          capabilities: ["streaming", "tools", "reasoning"],
          contextWindow: 1000000,
          reasoning: { effort: "high" },
          compact: { strategy: "auto", tokenLimit: 850000 },
          upstreams: {
            primary: { upstreamModelId: "vendor-sol" },
          },
        },
      },
      routes: {
        primary: {
          id: "primary",
          name: "Primary route",
          strategy: "priority",
          backends: [
            {
              upstream: "primary",
              priority: 10,
              models: ["gpt56-sol"],
              enabled: true,
            },
          ],
        },
      },
      virtualProviders: {
        "codex-main": {
          id: "codex-main",
          name: "Codex main",
          ingressProtocol: "openai.responses",
          route: "primary",
          allowedModels: ["gpt56-sol"],
          defaultModel: "gpt56-sol",
          enabled: true,
        },
      },
      bindings: {
        "codex-main": {
          id: "codex-main",
          target: "codex",
          integration: "codex-native-provider",
          targetFormat: "codex.config.toml.v1",
          mode: "config",
          virtualProvider: "codex-main",
          defaultModel: "gpt56-sol",
          codex: { providerId: "cabletidy_primary" },
        },
      },
    };
    const commitResponse = await fetch(`http://127.0.0.1:${webPort}/api/v1/config/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 0,
        config: candidate,
        upstreamSecrets: { primary: "upstream-key" },
      }),
    });
    const committed = await commitResponse.json();
    assert.equal(commitResponse.status, 200);
    assert.equal(committed.revision, 1);
    assert.equal(committed.runtime.counts.models, 1);
    assert.equal(committed.config.bindings["codex-main"].targetFormat, "codex.config.toml.v1");
    assert.equal(committed.config.virtualProviders["cabletidy_codex-main"].localAuth, undefined);
    assert.deepEqual(JSON.parse(await fs.readFile(paths.secrets, "utf8")), {
      "secret://upstreams/primary": "upstream-key",
    });

    const artifactResponse = await fetch(
      `http://127.0.0.1:${webPort}/api/v1/config/preview-target-artifacts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bindingId: "codex-main" }),
      },
    );
    const artifacts = await artifactResponse.json();
    assert.equal(artifactResponse.status, 200);
    assert.deepEqual(artifacts.artifacts.files.map((file) => file.path), ["config.toml"]);
    const configToml = artifacts.artifacts.files.find((file) => file.path === "config.toml").contents;
    assert.ok(configToml.includes(`127.0.0.1:${webPort}/codex-main/v1`));
    assert.equal(configToml.includes("upstream-key"), false);
    assert.equal(configToml.includes(`127.0.0.1:${upstreamPort}/v1`), false);
    assert.equal(configToml.includes("profiles."), false);

    const proxyResponse = await fetch(`http://127.0.0.1:${webPort}/codex-main/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
    });
    const proxied = await proxyResponse.json();
    assert.equal(proxyResponse.status, 200);
    assert.equal(receivedBody.model, "vendor-sol");
    assert.equal(proxied.model, "gpt-5.6-sol");
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
        'data: {"type":"message_stop","model":"vendor-sonnet"}\n\n',
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
    web: { enabled: true, listenHost: "127.0.0.1", port: webPort },
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
        strategy: "priority",
        backends: [{ upstream: "anthropic", priority: 10, models: ["claude-sonnet"] }],
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
        localAuth: { secretRef: "secret://virtual-providers/claude-main" },
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
  await saveSecrets({
    "secret://upstreams/anthropic": "upstream-key",
    "secret://virtual-providers/claude-main": "local-key",
  }, paths);

  const app = await createApplication({ paths });
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
    assert.doesNotMatch(JSON.stringify(preview), /local-key/);

    const applyResponse = await fetch(
      `http://127.0.0.1:${webPort}/api/v1/targets/apply`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bindingId: "claude-main" }),
      },
    );
    const applyBody = await applyResponse.json();
    assert.equal(applyResponse.status, 501);
    assert.equal(applyBody.error.code, "target_apply_not_supported");

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

  const config = {
    version: 1,
    revision: 1,
    web: { enabled: true, listenHost: "127.0.0.1", port: webPort },
    upstreams: {
      primary: {
        id: "primary",
        protocol: "openai.responses",
        baseUrl: `http://127.0.0.1:${primaryPort}/v1`,
      },
      backup: {
        id: "backup",
        protocol: "openai.responses",
        baseUrl: `http://127.0.0.1:${backupPort}/v1`,
      },
    },
    models: {
      "logical-coder": {
        id: "logical-coder",
        clientModelId: "coder",
        aliases: ["coder"],
        capabilities: ["streaming"],
        upstreams: {
          primary: { upstreamModelId: "vendor-primary" },
        },
      },
    },
    routes: {
      "priority-route": {
        id: "priority-route",
        strategy: "priority",
        backends: [
          { upstream: "primary", priority: 10, models: ["logical-coder"] },
        ],
      },
    },
    virtualProviders: {
      codex: {
        id: "codex",
        ingressProtocol: "openai.responses",
        route: "priority-route",
        allowedModels: ["logical-coder"],
        defaultModel: "logical-coder",
        localAuth: { secretRef: "secret://virtual-providers/codex" },
      },
    },
  };
  await saveConfig(config, paths);
  await saveSecrets({ "secret://virtual-providers/codex": "local-key" }, paths);
  const app = await createApplication({ paths });
  try {
    const response = await fetch(`http://127.0.0.1:${webPort}/codex/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer local-key",
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
  const proxyPort = await freePort();
  const blockedPort = await freePort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-atomic-reload-"));
  const paths = getPaths(home);
  const blocker = http.createServer((request, response) => {
    response.writeHead(503);
    response.end();
  });
  await new Promise((resolve) => blocker.listen(blockedPort, "127.0.0.1", resolve));

  const config = {
    version: 1,
    revision: 1,
    web: { enabled: true, listenHost: "127.0.0.1", port: webPort },
    upstreams: {
      primary: {
        id: "primary",
        protocol: "openai.responses",
        baseUrl: "https://relay.example/v1",
      },
    },
    models: {
      model: {
        id: "model",
        clientModelId: "model",
        aliases: ["model"],
        upstreams: { primary: { upstreamModelId: "vendor-model" } },
      },
    },
    routes: {
      route: {
        id: "route",
        strategy: "priority",
        backends: [{ upstream: "primary", models: ["model"] }],
      },
    },
    virtualProviders: {
      primary: {
        id: "primary",
        listenHost: "127.0.0.1",
        listenPort: proxyPort,
        ingressProtocol: "openai.responses",
        route: "route",
        allowedModels: ["model"],
        defaultModel: "model",
        localAuth: { secretRef: "secret://virtual-providers/primary" },
      },
    },
  };
  await saveConfig(config, paths);
  await saveSecrets({
    "secret://virtual-providers/primary": "local-key",
  }, paths);

  const app = await createApplication({ paths });
  try {
    const candidate = structuredClone(config);
    candidate.web.port = blockedPort;

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

    const modelsResponse = await fetch(`http://127.0.0.1:${webPort}/primary/v1/models`, {
      headers: { authorization: "Bearer local-key" },
    });
    assert.equal(modelsResponse.status, 200);
    assert.equal((await modelsResponse.json()).data[0].id, "model");
    assert.equal(app.state.config.revision, 1);
    assert.equal(app.state.webServer.listening, true);
  } finally {
    await app.close();
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("unsupported Virtual Provider ingress returns an explicit 501", async () => {
  const webPort = await freePort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-unsupported-ingress-"));
  const paths = getPaths(home);
  const config = {
    version: 1,
    revision: 1,
    web: { enabled: true, listenHost: "127.0.0.1", port: webPort },
    upstreams: {
      primary: {
        id: "primary",
        protocol: "openai.chat_completions",
        baseUrl: "https://relay.example/v1",
      },
    },
    models: {
      model: {
        id: "model",
        clientModelId: "model",
        aliases: ["model"],
        upstreams: { primary: { upstreamModelId: "vendor-model" } },
      },
    },
    routes: {
      route: {
        id: "route",
        strategy: "priority",
        backends: [{ upstream: "primary", models: ["model"] }],
      },
    },
    virtualProviders: {
      chat: {
        id: "chat",
        ingressProtocol: "openai.chat_completions",
        route: "route",
        allowedModels: ["model"],
        defaultModel: "model",
        localAuth: { secretRef: "secret://virtual-providers/chat" },
      },
    },
  };
  await saveConfig(config, paths);
  await saveSecrets({
    "secret://virtual-providers/chat": "local-key",
  }, paths);

  const app = await createApplication({ paths });
  try {
    const response = await fetch(`http://127.0.0.1:${webPort}/chat/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer local-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "model", messages: [] }),
    });
    const body = await response.json();
    assert.equal(response.status, 501);
    assert.equal(body.error.code, "unsupported_protocol");
  } finally {
    await app.close();
  }
});

test("startup failure on the shared listener does not create provider listeners", async () => {
  const webPort = await freePort();
  const proxyPort = await freePort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-startup-cleanup-"));
  const paths = getPaths(home);
  const blocker = http.createServer((request, response) => {
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve) => blocker.listen(webPort, "127.0.0.1", resolve));

  await saveConfig({
    version: 1,
    revision: 1,
    web: { enabled: true, listenHost: "127.0.0.1", port: webPort },
    upstreams: {
      relay: {
        id: "relay",
        protocol: "openai.responses",
        baseUrl: "https://relay.example/v1",
      },
    },
    models: {
      model: {
        id: "model",
        clientModelId: "model",
        aliases: ["model"],
        upstreams: { relay: { upstreamModelId: "vendor-model" } },
      },
    },
    routes: {
      route: {
        id: "route",
        strategy: "priority",
        backends: [{ upstream: "relay", models: ["model"] }],
      },
    },
    virtualProviders: {
      codex: {
        id: "codex",
        listenHost: "127.0.0.1",
        listenPort: proxyPort,
        ingressProtocol: "openai.responses",
        route: "route",
        allowedModels: ["model"],
        defaultModel: "model",
        localAuth: { secretRef: "secret://virtual-providers/codex" },
      },
    },
  }, paths);

  try {
    await assert.rejects(
      createApplication({ paths }),
      (error) => /EADDRINUSE|监听失败|address already in use/i.test(error.message),
    );
    await assert.rejects(
      fetch(`http://127.0.0.1:${proxyPort}/v1/models`),
      () => true,
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
