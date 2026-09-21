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
        },
      },
    },
    routes: {
      "codex-route": {
        id: "codex-route",
        strategy: "priority",
        backends: [
          { upstream: "primary", priority: 10, models: ["codex-sol"], enabled: true },
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

test("resolves a client alias to the configuration upstream model", () => {
  const config = sampleConfig();
  const result = resolveRequest(config, config.virtualProviders.cabletidy_codex, {
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
  config.virtualProviders.cabletidy_codex.allowedModels = ["codex-sol", "codex-terra"];

  assert.deepEqual(
    listClientModels(config, config.virtualProviders.cabletidy_codex).map((model) => model.id),
    ["sol", "gpt-5.6-terra"],
  );
});

test("resolves a profile clientModelId even when aliases are omitted", () => {
  const config = sampleConfig();
  config.models["codex-sol"].aliases = [];
  const result = resolveRequest(config, config.virtualProviders.cabletidy_codex, {
    model: "sol",
  });
  assert.equal(result.model.profileId, "codex-sol");
  assert.equal(result.upstreamModelId, "vendor-sol");
});

test("rejects missing model mappings without selecting another upstream", () => {
  const config = sampleConfig();
  delete config.models["codex-sol"].upstreams.primary;
  assert.throws(() => resolveRequest(config, config.virtualProviders.cabletidy_codex, { model: "sol" }),
    (error) => error.code === "no_compatible_upstream" && error.details.rejected[0].reason === "model_binding_missing");
});

test("rejects multiple route backends even when the second is disabled", () => {
  const config = sampleConfig();
  config.routes["codex-route"].backends.push({ upstream: "backup", models: ["codex-sol"], enabled: false });
  assert.equal(validateConfig(config).ok, false);
  assert.throws(() => resolveRequest(config, config.virtualProviders.cabletidy_codex, { model: "sol" }),
    (error) => error.code === "invalid_route");
});

test("rejects multiple upstream mappings on one model", () => {
  const config = sampleConfig();
  config.models["codex-sol"].upstreams.backup = { upstreamModelId: "other-model" };
  assert.ok(validateConfig(config).errors.some((error) => error.path === "models.codex-sol.upstreams"));
  assert.throws(() => resolveRequest(config, config.virtualProviders.cabletidy_codex, { model: "sol" }),
    (error) => error.code === "invalid_model_binding");
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
  assert.equal(result.model.profileId, null);
  assert.equal(result.model.matchedBy, "passthrough");
});

test("an empty configuration model list never imports profiles from another configuration", () => {
  const config = sampleConfig();
  const provider = config.virtualProviders.cabletidy_codex;
  provider.allowedModels = [];
  config.routes[provider.route].backends[0].models = [];
  delete provider.defaultModel;
  const result = resolveRequest(config, provider, { model: "sol" });
  assert.equal(result.upstreamModelId, "sol");
  assert.equal(result.model.profile, null);
  assert.deepEqual(listClientModels(config, provider), []);
  delete provider.allowedModels;
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
  delete config.models["codex-sol"].upstreams.primary.upstreamModelId;
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
    ...structuredClone(config.virtualProviders.cabletidy_codex), id: "other", listenPort: 43102,
    route: "other", allowedModels: ["other-model"], defaultModel: "gpt-5.5",
  };
  assert.equal(validateConfig(config).ok, true);
  assert.equal(resolveRequest(config, config.virtualProviders.cabletidy_codex, { model: "gpt-5.5" }).upstreamModelId, "vendor-sol");
  assert.equal(resolveRequest(config, config.virtualProviders.other, { model: "gpt-5.5" }).upstreamModelId, "different-vendor-name");
  config.virtualProviders.cabletidy_codex.allowedModels.push("other-model");
  assert.ok(validateConfig(config).errors.some((error) => /当前 Virtual Provider 内重复/.test(error.message)));
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
