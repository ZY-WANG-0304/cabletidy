import test from "node:test";
import assert from "node:assert/strict";

import {
  applySecretPayload,
  computeConfigDiff,
  defaultConfig,
  normalizeConfig,
  publicConfig,
  resolveUpstreamSecret,
} from "../src/config.mjs";
import { validateConfig } from "../src/validation.mjs";
import { resolveRequest } from "../src/model-resolver.mjs";
import { codexConfigFixture } from "./helpers/codex-fixture.mjs";
import { claudeConfigFixture } from "./helpers/claude-fixture.mjs";

test("Claude family options support Fable and preserve existing custom values without an official whitelist", () => {
  const config = claudeConfigFixture();
  const binding = config.bindings["claude-main"];
  for (const family of ["opus", "sonnet", "fable", "haiku"]) {
    binding.claude.models = { [family]: "custom-client-model" };
    assert.equal(validateConfig(config).ok, true);
    binding.claude.models = { [family]: "" };
    assert.ok(validateConfig(config).errors.some(({ path }) => path === `bindings.claude-main.claude.models.${family}`));
  }
  binding.claude.models = { subagent: "sonnet" };
  assert.equal(validateConfig(config).ok, true);
  binding.claude.models = {};
  config.models = {};
  config.routes.route.backends[0].models = [];
  config.virtualProviders["cabletidy_claude-main"].allowedModels = [];
  assert.equal(validateConfig(config).ok, true);
});

test("upstream-only configurations allow empty or omitted model settings and optional defaults", () => {
  const config = codexConfigFixture();
  config.models = {};
  config.routes.route.backends[0].models = [];
  config.virtualProviders.cabletidy_relay.allowedModels = [];
  delete config.virtualProviders.cabletidy_relay.defaultModel;
  delete config.bindings.relay.defaultModel;
  assert.equal(validateConfig(config).ok, true);
  assert.deepEqual(validateConfig(config).warnings, []);
  delete config.routes.route.backends[0].models;
  delete config.virtualProviders.cabletidy_relay.allowedModels;
  config.bindings.relay.defaultModel = "unconfigured-model";
  config.virtualProviders.cabletidy_relay.defaultModel = "unconfigured-model";
  assert.equal(validateConfig(config).ok, true);
});

test("unused upstream policy fields are removed during normalization", () => {
  const config = normalizeConfig({
    upstreams: {
      relay: {
        requestMaxRetries: 7,
        streamMaxRetries: 4,
        streamIdleTimeoutMs: 123000,
        requiresOpenaiAuth: true,
        supportsWebsockets: true,
      },
    },
  });
  for (const field of ["requestMaxRetries", "streamMaxRetries", "streamIdleTimeoutMs", "requiresOpenaiAuth", "supportsWebsockets"]) {
    assert.equal(config.upstreams.relay[field], undefined, field);
  }
});

test("obsolete configuration fields round-trip without affecting routing or provider state", () => {
  assert.equal(Object.hasOwn(defaultConfig().web, "enabled"), false);
  const config = normalizeConfig(codexConfigFixture());
  config.web.enabled = false;
  config.routes.route.strategy = "obsolete-strategy";
  config.routes.route.backends[0].priority = "obsolete-priority";
  config.routes.route.backends[0].weight = "obsolete-weight";
  config.models.model.capabilityOverrides = ["-vision"];
  config.virtualProviders.cabletidy_relay.enabled = false;
  const result = validateConfig(config);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(JSON.parse(JSON.stringify(result.config)), config);
  assert.equal(result.config.virtualProviders.cabletidy_relay.enabled, false);
  assert.equal(resolveRequest(result.config, result.config.virtualProviders.cabletidy_relay, {
    model: "gpt-5.5", images: true,
  }).upstreamModelId, "VENDOR-GPT");

  config.models.model.upstreams.relay.capabilityOverrides = ["-vision"];
  assert.throws(() => resolveRequest(config, config.virtualProviders.cabletidy_relay, {
    model: "gpt-5.5", images: true,
  }), (error) => error.details.rejected[0].reason === "capability_missing");
  config.models.model.upstreams.relay.capabilityOverrides = "invalid";
  assert.ok(validateConfig(config).errors.some(({ path }) => path === "models.model.upstreams.relay.capabilityOverrides"));
});

test("normalization discards upstream envKey and Codex auth metadata", () => {
  for (const metadata of [
    { envKey: "no longer a valid env name" },
    { codexToml: { providerId: "relay", envKey: "LEGACY_KEY" } },
    { codexNative: { providerId: "relay", envKey: "LEGACY_KEY" } },
  ]) {
    const original = codexConfigFixture();
    Object.assign(original.upstreams.relay, metadata, { secretRef: "secret://upstreams/relay" });
    const result = validateConfig(original);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const upstream = result.config.upstreams.relay;
    for (const field of ["envKey", "codexToml", "codexNative"]) {
      assert.equal(Object.hasOwn(upstream, field), false, field);
    }
    assert.equal(upstream.secretRef, "secret://upstreams/relay");
    assert.deepEqual(normalizeConfig(result.config), result.config);
    for (const [field, value] of Object.entries(metadata)) {
      assert.deepEqual(original.upstreams.relay[field], value);
    }
  }
});

test("upstream credentials come only from the secrets store even when env references exist", (t) => {
  const envKey = "CABLETIDY_TEST_UPSTREAM_API_KEY";
  const previous = process.env[envKey];
  t.after(() => {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  });
  process.env[envKey] = "stale-environment-key";
  const secretRef = "secret://upstreams/relay";
  const upstream = { envKey, secretRef };
  const secrets = { [secretRef]: "saved-key" };
  assert.equal(resolveUpstreamSecret(upstream, secrets), "saved-key");
  assert.equal(resolveUpstreamSecret(upstream), "");
  assert.equal(resolveUpstreamSecret({ envKey }), "");
  for (const reference of [envKey, `env://${envKey}`]) {
    assert.equal(resolveUpstreamSecret({ secretRef: reference }), "");
    const config = { upstreams: { relay: { secretRef: reference } } };
    const updated = applySecretPayload(config, {}, { upstreamSecrets: { relay: "new-key" } });
    assert.equal(resolveUpstreamSecret(config.upstreams.relay, updated), "new-key");
  }
});

test("metadata settings do not require a rename but reject invalid upstream model IDs", () => {
  const config = codexConfigFixture();
  delete config.models.model.upstreams.relay.upstreamModelId;
  assert.equal(validateConfig(config).ok, true);
  for (const upstreamModelId of [null, "", " ", 123, {}]) {
    config.models.model.upstreams.relay.upstreamModelId = upstreamModelId;
    assert.ok(validateConfig(config).errors.some((error) => error.path.endsWith("upstreamModelId")));
  }
});

test("legacy names and provider ports migrate to the shared listener without changing models", () => {
  const original = codexConfigFixture();
  original.daemon = { proxyPortRange: "43101-43199" };
  original.virtualProviders.cabletidy_relay.listenHost = "127.0.0.1";
  original.virtualProviders.cabletidy_relay.listenPort = 43101;
  original.bindings = { "codex-main": { ...original.bindings.relay, id: "codex-main", name: "My Relay", virtualProvider: "codex-main" } };
  original.virtualProviders = { "codex-main": { ...original.virtualProviders.cabletidy_relay, id: "codex-main" } };
  const config = normalizeConfig(original);
  assert.deepEqual(Object.keys(config.bindings), ["my-relay"]);
  assert.deepEqual(Object.keys(config.virtualProviders), ["cabletidy_my-relay"]);
  assert.equal(config.bindings["my-relay"].id, "my-relay");
  assert.equal(config.bindings["my-relay"].virtualProvider, "cabletidy_my-relay");
  assert.equal(config.virtualProviders["cabletidy_my-relay"].id, "cabletidy_my-relay");
  assert.equal(config.virtualProviders["cabletidy_my-relay"].listenPort, undefined);
  assert.equal(config.virtualProviders["cabletidy_my-relay"].listenHost, undefined);
  assert.equal(config.web.port, 43100);
  assert.equal(config.daemon.proxyPortRange, undefined);
  assert.deepEqual(config.models, original.models);
  assert.deepEqual(config.upstreams, original.upstreams);
  assert.deepEqual(normalizeConfig(config), config);
  assert.equal(original.bindings["codex-main"].virtualProvider, "codex-main");
  assert.equal(validateConfig(config).ok, true);
});

test("configuration names that normalize to the same ID are rejected without losing records", () => {
  const config = codexConfigFixture();
  config.bindings.relay.name = "My Relay";
  config.virtualProviders.cabletidy_relay.name = "First provider";
  config.bindings.second = { ...config.bindings.relay, id: "second", name: "my-relay", virtualProvider: "second" };
  config.virtualProviders.second = { ...config.virtualProviders.cabletidy_relay, id: "second", name: "Second provider" };
  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /配置名称规范化后.*重复/.test(error.message)));
  assert.equal(Object.keys(result.config.bindings).length, 2);
  assert.equal(Object.keys(result.config.virtualProviders).length, 2);
  assert.equal(result.config.virtualProviders[result.config.bindings.relay.virtualProvider].name, "First provider");
  assert.equal(result.config.virtualProviders[result.config.bindings.second.virtualProvider].name, "Second provider");
  assert.deepEqual(normalizeConfig(result.config), result.config);
});

test("multiple bindings cannot share a Virtual Provider", () => {
  const config = codexConfigFixture();
  config.bindings.second = { ...config.bindings.relay, id: "second", name: "Second" };
  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /配置与 Virtual Provider 必须一对一/.test(error.message)));
  assert.equal(Object.keys(result.config.virtualProviders).length, 1);
  assert.deepEqual(normalizeConfig(result.config), result.config);
});

test("identity migration can swap keys without overwriting either provider", () => {
  const config = codexConfigFixture();
  config.bindings.relay.name = "Second";
  config.virtualProviders.cabletidy_relay.name = "First provider";
  config.bindings.second = { ...config.bindings.relay, id: "second", name: "Relay", virtualProvider: "cabletidy_second" };
  config.virtualProviders.cabletidy_second = { ...config.virtualProviders.cabletidy_relay, id: "cabletidy_second", name: "Second provider" };
  const result = validateConfig(config);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.config.virtualProviders.cabletidy_second.name, "First provider");
  assert.equal(result.config.virtualProviders.cabletidy_relay.name, "Second provider");
  assert.deepEqual(normalizeConfig(result.config), result.config);
});

test("non-ASCII configuration names retain a stable fallback ID", () => {
  const config = codexConfigFixture();
  config.bindings.relay.name = "开发配置";
  const normalized = normalizeConfig(config);
  assert.equal(normalized.bindings.relay.name, "开发配置");
  assert.equal(normalized.bindings.relay.virtualProvider, "cabletidy_relay");
  assert.deepEqual(normalizeConfig(normalized), normalized);
  assert.equal(validateConfig(normalized).ok, true);
});

test("configuration paths cannot shadow the management API namespace", () => {
  const config = codexConfigFixture();
  config.bindings.relay.name = "API";
  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.path === "bindings.api.name" && /保留路径/.test(error.message)));
});

test("a provider cannot expose models mapped to another configuration's upstream", () => {
  const config = codexConfigFixture();
  config.upstreams.other = { ...config.upstreams.relay, id: "other" };
  config.models.other = {
    ...config.models.model, id: "other", clientModelId: "gpt-5.6-sol", aliases: ["gpt-5.6-sol"],
    upstreams: { other: { upstreamModelId: "other-vendor-model" } },
  };
  config.virtualProviders.cabletidy_relay.allowedModels.push("other");
  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === "virtualProviders.cabletidy_relay.allowedModels" && /当前配置的 upstream/.test(error.message)));
});

test("computes an effective config diff without counting revision metadata", () => {
  const before = normalizeConfig({
    revision: 4,
    web: { sessionTtlSeconds: 1800 },
    upstreams: { primary: { name: "Primary" } },
  });
  const after = normalizeConfig({
    revision: 5,
    web: { sessionTtlSeconds: 2400 },
    upstreams: {
      primary: { name: "Primary Relay" },
      backup: { name: "Backup" },
    },
  });

  const diff = computeConfigDiff(before, after);
  assert.equal(diff.changed.some((item) => item.path === "revision"), false);
  assert.equal(before.web.sessionTtlSeconds, undefined);
  assert.equal(after.web.sessionTtlSeconds, undefined);
  assert.equal(diff.added.some((item) => item.path === "upstreams.backup"), true);
  assert.deepEqual(diff.affected, ["upstreams"]);
});

test("prototype Codex fields are discarded without migration and old target formats are rejected", () => {
  const legacy = {
    model: "legacy-model",
    modelContextWindow: 1000000,
    modelAutoCompactTokenLimit: 850000,
    personality: "friendly",
    profileFile: "../escape.toml",
    profileId: "prototype-profile",
  };
  for (const metadata of [{ targetOverrides: { codex: legacy } }, { legacyCodex: legacy }]) {
    const original = codexConfigFixture();
    delete original.models.model.clientModelId;
    Object.assign(original.models.model, metadata);
    original.upstreams.relay.providerFormat = "codex.toml.v1";
    Object.assign(original.bindings.relay, {
      providerFormat: "codex.toml.v1",
      targetFormat: "codex.toml.v1",
      codex: { profileFiles: ["../escape.toml"], sourceUpstream: "relay", sourceProviderId: "legacy" },
      legacyCodex: legacy,
    });

    const { config, ok, errors } = validateConfig(original);
    assert.equal(config.upstreams.relay.integration, undefined);
    assert.equal(config.bindings.relay.integration, undefined);
    for (const field of ["clientModelId", "contextWindow", "compact", "personality"]) {
      assert.equal(config.models.model[field], undefined, field);
    }
    assert.deepEqual(config.bindings.relay.codex, {});
    assert.doesNotMatch(JSON.stringify(config), /profileFile|profileId|targetOverrides|legacyCodex|providerFormat/);
    assert.equal(config.bindings.relay.targetFormat, "codex.toml.v1");
    assert.equal(ok, false);
    assert.ok(errors.some((error) => error.path === "bindings.relay.targetFormat"));
    config.bindings.relay.targetFormat = "codex.config.toml.v1";
    assert.equal(validateConfig(config).ok, true);
  }
});

test("public config recursively removes credential material without changing the input", () => {
  const config = normalizeConfig({
    upstreams: {
      relay: {
        id: "relay",
        protocol: "openai.responses",
        baseUrl: "https://relay.example/v1",
        auth: {
          header: "authorization",
          token: "upstream-token",
          nested: { clientSecret: "nested-secret" },
        },
        apiKey: "legacy-api-key",
      },
    },
    metadata: {
      access_token: "access-token",
      refreshToken: "refresh-token",
    },
  });
  const original = structuredClone(config);
  const result = publicConfig(config);
  assert.doesNotMatch(JSON.stringify(result), /upstream-token|nested-secret|legacy-api-key|access-token|refresh-token/);
  assert.equal(result.upstreams.relay.auth.header, "authorization");
  assert.equal(result.upstreams.relay.baseUrl, "https://relay.example/v1");
  assert.deepEqual(config, original);
});

test("validation reports malformed graph nodes instead of throwing", () => {
  const result = validateConfig({
    upstreams: { broken: null },
    models: { broken: null },
    routes: { broken: { backends: [null] } },
    virtualProviders: {
      broken: {
        ingressProtocol: "gemini.generate_content",
        route: "missing",
        allowedModels: ["missing"],
      },
    },
    bindings: { broken: null },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === "upstreams.broken"));
  assert.ok(result.errors.some((item) => item.path === "models.broken"));
  assert.ok(result.errors.some((item) => item.path === "routes.broken.backends.0"));
  assert.ok(result.warnings.some((item) => item.path === "virtualProviders.cabletidy_broken.ingressProtocol"));
});

test("legacy local auth is discarded without changing upstream secrets or generating keys", () => {
  const legacy = {
    upstreams: { relay: { secretRef: "secret://upstreams/relay" } },
    virtualProviders: {
      codex: { listenHost: "127.0.0.1", localAuth: { secretRef: "secret://virtual-providers/codex" } },
      fresh: { listenHost: "127.0.0.1" },
    },
    bindings: { codex: { codex: { localEnvKey: "LEGACY_KEY", providerId: "cabletidy_relay" } } },
  };
  const config = normalizeConfig(legacy);
  assert.equal(config.virtualProviders.cabletidy_codex.localAuth, undefined);
  assert.equal(config.bindings.codex.codex.localEnvKey, undefined);
  assert.equal(config.bindings.codex.codex.providerId, undefined);
  assert.ok(legacy.virtualProviders.codex.localAuth);
  const secrets = {
    "secret://upstreams/relay": "upstream-key",
    "secret://virtual-providers/codex": "legacy-local-key",
  };
  assert.equal(config.virtualProviders.cabletidy_fresh.localAuth, undefined);
  const updated = applySecretPayload(config, secrets, {
    localSecrets: { fresh: "ignored", codex: "ignored" },
    upstreamSecrets: { relay: "new-upstream-key" },
  });
  assert.deepEqual(updated, { ...secrets, "secret://upstreams/relay": "new-upstream-key" });
  assert.equal(config.virtualProviders.cabletidy_fresh.localAuth, undefined);
});

test("the shared listener accepts loopback hosts and rejects public listeners", () => {
  const config = normalizeConfig(codexConfigFixture());
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    config.web.listenHost = host;
    const result = validateConfig(config);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.20"]) {
    config.web.listenHost = host;
    const result = validateConfig(config);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.path === "web.listenHost"));
  }
});
