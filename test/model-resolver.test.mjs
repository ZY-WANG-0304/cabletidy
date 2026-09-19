import test from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig } from "../src/config.mjs";
import {
  ModelResolveError,
  listClientModels,
  resolveRequest,
  rewriteModelFields,
} from "../src/model-resolver.mjs";
import { validateConfig } from "../src/validation.mjs";

function sampleConfig() {
  return normalizeConfig({
    upstreams: {
      primary: {
        id: "primary",
        name: "Primary",
        protocol: "openai.responses",
        baseUrl: "https://primary.example/v1",
      },
      backup: {
        id: "backup",
        name: "Backup",
        protocol: "openai.responses",
        baseUrl: "https://backup.example/v1",
      },
    },
    models: {
      "codex-sol": {
        id: "codex-sol",
        clientModelId: "sol",
        aliases: ["sol", "codex-default"],
        family: "codex",
        capabilities: ["streaming", "tools", "reasoning"],
        upstreams: {
          primary: { upstreamModelId: "vendor-sol" },
          backup: { upstreamModelId: "vendor-sol-backup" },
        },
      },
    },
    routes: {
      "codex-route": {
        id: "codex-route",
        strategy: "priority",
        backends: [
          { upstream: "primary", priority: 10, models: ["codex-sol"], enabled: true },
          { upstream: "backup", priority: 20, models: ["codex-sol"], enabled: true },
        ],
      },
    },
    virtualProviders: {
      codex: {
        id: "codex",
        listenHost: "127.0.0.1",
        listenPort: 43101,
        ingressProtocol: "openai.responses",
        route: "codex-route",
        allowedModels: ["codex-sol"],
        defaultModel: "codex-sol",
      },
    },
  });
}

test("resolves a client alias to the first compatible upstream model", () => {
  const config = sampleConfig();
  const result = resolveRequest(config, config.virtualProviders.codex, {
    model: "codex-default",
    stream: true,
    tools: [{}],
  });

  assert.equal(result.model.profileId, "codex-sol");
  assert.equal(result.model.clientModelId, "codex-default");
  assert.equal(result.upstream.id, "primary");
  assert.equal(result.upstreamModelId, "vendor-sol");
});

test("lists every allowed CableTidy model for the Virtual Provider", () => {
  const config = sampleConfig();
  config.models["codex-terra"] = {
    id: "codex-terra",
    clientModelId: "gpt-5.6-terra",
    aliases: ["terra"],
    family: "codex",
    capabilities: ["streaming", "tools", "reasoning"],
    upstreams: { primary: { upstreamModelId: "vendor-terra" } },
  };
  config.virtualProviders.codex.allowedModels = ["codex-sol", "codex-terra"];

  assert.deepEqual(
    listClientModels(config, config.virtualProviders.codex).map((model) => model.id),
    ["sol", "gpt-5.6-terra"],
  );
});

test("resolves a profile clientModelId even when aliases are omitted", () => {
  const config = sampleConfig();
  config.models["codex-sol"].aliases = [];
  const result = resolveRequest(config, config.virtualProviders.codex, {
    model: "sol",
  });
  assert.equal(result.model.profileId, "codex-sol");
  assert.equal(result.upstreamModelId, "vendor-sol");
});

test("skips a backend without a model binding", () => {
  const config = sampleConfig();
  delete config.models["codex-sol"].upstreams.primary;
  const result = resolveRequest(config, config.virtualProviders.codex, { model: "sol" });
  assert.equal(result.upstream.id, "backup");
  assert.equal(result.upstreamModelId, "vendor-sol-backup");
});

test("rejects unknown models", () => {
  const config = sampleConfig();
  assert.throws(
    () => resolveRequest(config, config.virtualProviders.codex, { model: "not-real" }),
    (error) => error instanceof ModelResolveError && error.code === "unknown_model",
  );
});

test("rewrites nested response model fields back to the client model", () => {
  const response = {
    model: "vendor-sol",
    response: {
      model: "vendor-sol",
      output: [{ type: "message", model: "unrelated" }],
    },
  };
  assert.deepEqual(rewriteModelFields(response, "sol", "vendor-sol"), {
    model: "sol",
    response: {
      model: "sol",
      output: [{ type: "message", model: "unrelated" }],
    },
  });
});

test("validates the complete model to route graph", () => {
  const result = validateConfig(sampleConfig());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("identical official names resolve independently inside each Virtual Provider", () => {
  const config = sampleConfig();
  config.models["codex-sol"].clientModelId = "gpt-5.5";
  config.models["codex-sol"].aliases = ["gpt-5.5"];
  config.models["other-model"] = {
    ...structuredClone(config.models["codex-sol"]), id: "other-model",
    upstreams: { backup: { upstreamModelId: "different-vendor-name" } },
  };
  config.routes.other = { backends: [{ upstream: "backup", models: ["other-model"] }] };
  config.virtualProviders.other = {
    ...structuredClone(config.virtualProviders.codex), id: "other", listenPort: 43102,
    route: "other", allowedModels: ["other-model"], defaultModel: "gpt-5.5",
  };
  assert.equal(validateConfig(config).ok, true);
  assert.equal(resolveRequest(config, config.virtualProviders.codex, { model: "gpt-5.5" }).upstreamModelId, "vendor-sol");
  assert.equal(resolveRequest(config, config.virtualProviders.other, { model: "gpt-5.5" }).upstreamModelId, "different-vendor-name");
  config.virtualProviders.codex.allowedModels.push("other-model");
  assert.ok(validateConfig(config).errors.some((error) => /当前 Virtual Provider 内重复/.test(error.message)));
});

test("vision detection includes protocol-native nested image inputs", () => {
  const config = sampleConfig();
  for (const body of [
    { input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,test" }] }] },
    { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "test" } }] }] },
  ]) {
    assert.throws(() => resolveRequest(config, config.virtualProviders.codex, { model: "sol", ...body }),
      (error) => error.details.rejected.every((entry) => entry.missing.includes("vision")));
  }
});
