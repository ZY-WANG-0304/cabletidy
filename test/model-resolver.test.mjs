import test from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig } from "./helpers/native.mjs";
import {
  ModelResolveError,
  listClientModels,
  resolveRequest,
} from "./helpers/native.mjs";
import { validateConfig } from "./helpers/native.mjs";

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
        },
      },
    },
    routes: {
      "codex-route": {
        id: "codex-route",
        backends: [
          { upstream: "primary", models: ["codex-sol"], enabled: true },
        ],
      },
    },
    virtualProviders: {
      codex: {
        id: "codex",
        ingressProtocol: "openai.responses",
        route: "codex-route",
        allowedModels: ["codex-sol"],
        defaultModel: "codex-sol",
      },
    },
  });
}

test("resolves a client alias to the configuration upstream model", () => {
  const config = sampleConfig();
  const result = resolveRequest(config, config.virtualProviders.cabletidy_codex, {
    model: "codex-default",
    stream: true,
    tools: [{}],
  });

  assert.equal(result.model.matchedModel, "sol");
  assert.equal(result.model.clientModelId, "codex-default");
  assert.equal(result.upstream.id, "primary");
  assert.equal(result.upstreamModelId, "vendor-sol");
});

test("lists every allowed CableTidy model for the Virtual Provider", () => {
  const config = sampleConfig();
  config.virtualProviders.cabletidy_codex.models["gpt-5.6-terra"] = {
    aliases: ["terra"],
    family: "codex",
    capabilities: ["streaming", "tools", "reasoning"],
    upstreamModelId: "vendor-terra",
  };

  assert.deepEqual(
    listClientModels(config, config.virtualProviders.cabletidy_codex).map((model) => model.id),
    ["sol", "gpt-5.6-terra"],
  );
});

test("resolves a profile clientModelId even when aliases are omitted", () => {
  const config = sampleConfig();
  config.virtualProviders.cabletidy_codex.models.sol.aliases = [];
  const result = resolveRequest(config, config.virtualProviders.cabletidy_codex, {
    model: "sol",
  });
  assert.equal(result.model.matchedModel, "sol");
  assert.equal(result.upstreamModelId, "vendor-sol");
});

test("old internal IDs are ordinary unconfigured request names after migration", () => {
  const config = sampleConfig();
  const result = resolveRequest(config, config.virtualProviders.cabletidy_codex, { model: "codex-sol", images: true });
  assert.equal(result.model.matchedModel, null);
  assert.equal(result.upstreamModelId, "codex-sol");
});

test("rejects multiple route backends even when the second is disabled", () => {
  const config = sampleConfig();
  config.routes["codex-route"].backends.push({ upstream: "backup", models: ["codex-sol"], enabled: false });
  assert.equal(validateConfig(config).ok, false);
  assert.throws(() => resolveRequest(config, config.virtualProviders.cabletidy_codex, { model: "sol" }),
    (error) => error.code === "invalid_route");
});

test("unconfigured models pass through without inheriting another model's capability limits", () => {
  const config = sampleConfig();
  const request = {
    model: "unconfigured-model", stream: true, tools: [{}], parallel_tool_calls: true,
    reasoning: { effort: "high" },
    input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.invalid/image" }] }],
  };
  const result = resolveRequest(config, config.virtualProviders.cabletidy_codex, request);
  assert.equal(result.upstreamModelId, request.model);
  assert.equal(result.upstream.id, "primary");
  assert.equal(result.model.matchedModel, null);
});

test("an empty configuration model list never imports profiles from another configuration", () => {
  const config = sampleConfig();
  const provider = config.virtualProviders.cabletidy_codex;
  provider.models = {};
  delete provider.defaultModel;
  const result = resolveRequest(config, provider, { model: "sol" });
  assert.equal(result.upstreamModelId, "sol");
  assert.equal(result.model.profile, null);
  assert.deepEqual(listClientModels(config, provider), []);
  delete provider.models;
  assert.equal(resolveRequest(config, provider, { model: "sol" }).upstreamModelId, "sol");
  assert.deepEqual(listClientModels(config, provider), []);
  assert.throws(
    () => resolveRequest(config, provider, {}),
    (error) => error instanceof ModelResolveError && error.code === "model_required",
  );
});

test("metadata-only profiles keep the requested name and enforce their explicit limits", () => {
  const config = sampleConfig();
  const provider = config.virtualProviders.cabletidy_codex;
  delete config.virtualProviders.cabletidy_codex.models.sol.upstreamModelId;
  assert.equal(resolveRequest(config, provider, { model: "sol" }).upstreamModelId, "sol");
  assert.equal(resolveRequest(config, provider, {}).upstreamModelId, "sol");
  assert.throws(() => resolveRequest(config, provider, { model: "sol", parallel_tool_calls: true }),
    (error) => error.details.rejected[0].reason === "capability_missing");
});

test("passthrough still validates model names, upstream state and protocol", () => {
  const config = sampleConfig();
  const provider = config.virtualProviders.cabletidy_codex;
  for (const model of [null, "", " ", 42, [], {}]) {
    assert.throws(() => resolveRequest(config, provider, { model }), (error) => error.code === "invalid_model");
  }
  config.upstreams.primary.enabled = false;
  assert.throws(() => resolveRequest(config, provider, { model: "new-model" }),
    (error) => error.details.rejected[0].reason === "upstream_disabled_or_missing");
  config.upstreams.primary.enabled = true;
  config.upstreams.primary.protocol = "anthropic.messages";
  assert.throws(() => resolveRequest(config, provider, { model: "new-model" }),
    (error) => error.details.rejected[0].reason === "protocol_transform_missing");
});

test("identical client names and aliases resolve independently in each configuration", () => {
  const config = sampleConfig();
  config.routes.other = { backends: [{ upstream: "backup" }] };
  config.virtualProviders.cabletidy_other = {
    ...structuredClone(config.virtualProviders.cabletidy_codex), id: "cabletidy_other", route: "other",
    models: { sol: { ...config.virtualProviders.cabletidy_codex.models.sol, upstreamModelId: "different-vendor-name" } },
  };
  assert.equal(validateConfig(config).ok, true);
  for (const model of ["sol", "codex-default"]) {
    assert.equal(resolveRequest(config, config.virtualProviders.cabletidy_codex, { model }).upstreamModelId, "vendor-sol");
    assert.equal(resolveRequest(config, config.virtualProviders.cabletidy_other, { model }).upstreamModelId, "different-vendor-name");
  }
  config.virtualProviders.cabletidy_codex.models.other = { aliases: ["sol"] };
  assert.ok(validateConfig(config).errors.some(error => /冲突/.test(error.message)));
});

test("vision detection includes protocol-native nested image inputs", () => {
  const config = sampleConfig();
  for (const body of [
    { input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,test" }] }] },
    { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "test" } }] }] },
  ]) {
    assert.throws(() => resolveRequest(config, config.virtualProviders.cabletidy_codex, { model: "sol", ...body }),
      (error) => error.details.rejected.every((entry) => entry.missing.includes("vision")));
  }
});
