import test from "node:test";
import assert from "node:assert/strict";

import {
  applySecretPayload,
  computeConfigDiff,
  normalizeConfig,
  publicConfig,
} from "../src/config.mjs";
import { validateConfig } from "../src/validation.mjs";
import { codexConfigFixture } from "./helpers/codex-fixture.mjs";

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

test("renaming a configuration keeps its provider reference aligned", () => {
  const config = codexConfigFixture();
  config.bindings.relay.name = "Another Relay";
  const renamed = normalizeConfig(config);
  assert.deepEqual(Object.keys(renamed.bindings), ["another-relay"]);
  assert.deepEqual(Object.keys(renamed.virtualProviders), ["cabletidy_another-relay"]);
  assert.equal(renamed.bindings["another-relay"].virtualProvider, "cabletidy_another-relay");
  assert.equal(validateConfig(renamed).ok, true);
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

test("migrates prototype Codex fields into CableTidy fields and drops profile metadata", () => {
  const config = normalizeConfig({
    upstreams: {
      primary: {
        id: "primary",
        providerFormat: "codex.toml.v1",
        codexToml: { providerId: "primary", envKey: "PRIMARY_API_KEY" },
        protocol: "openai.responses",
        baseUrl: "https://primary.example/v1",
      },
    },
    models: {
      "logical-model": {
        id: "logical-model",
        aliases: ["logical"],
        targetOverrides: {
          codex: {
            profileFile: "../escape.toml",
            profileId: "prototype-profile",
            model: "logical",
            reasoningEffort: "high",
            modelContextWindow: 1000000,
            modelAutoCompactTokenLimit: 850000,
          },
        },
        upstreams: { primary: { upstreamModelId: "vendor-model" } },
      },
    },
    routes: {
      primary: {
        id: "primary",
        backends: [{ upstream: "primary", models: ["logical-model"] }],
      },
    },
    virtualProviders: {
      codex: {
        id: "codex",
        listenHost: "127.0.0.1",
        listenPort: 43101,
        ingressProtocol: "openai.responses",
        route: "primary",
        allowedModels: ["logical-model"],
        defaultModel: "logical",
      },
    },
    bindings: {
      codex: {
        id: "codex",
        target: "codex",
        virtualProvider: "codex",
        defaultModel: "logical",
        providerFormat: "codex.toml.v1",
        targetFormat: "codex.toml.v1",
        codex: {
          providerId: "cabletidy_primary",
          profileFiles: ["../escape.toml"],
        },
      },
    },
  });

  assert.equal(config.upstreams.primary.integration, "codex-native-provider");
  assert.equal(config.upstreams.primary.codexNative.envKey, "PRIMARY_API_KEY");
  assert.equal(config.upstreams.primary.envKey, "PRIMARY_API_KEY");
  assert.equal(config.upstreams.primary.providerFormat, undefined);
  assert.equal(config.models["logical-model"].clientModelId, "logical");
  assert.equal(config.models["logical-model"].contextWindow, 1000000);
  assert.equal(config.models["logical-model"].compact.tokenLimit, 850000);
  assert.equal(config.models["logical-model"].targetOverrides, undefined);
  assert.equal(config.models["logical-model"].legacyCodex, undefined);
  assert.equal(config.bindings.codex.integration, "codex-native-provider");
  assert.equal(config.bindings.codex.targetFormat, "codex.config.toml.v1");
  assert.equal(config.bindings.codex.codex.profileFiles, undefined);
  assert.equal(config.bindings.codex.legacyCodex, undefined);

  const result = validateConfig(config);
  assert.equal(result.ok, true);
  assert.equal(
    result.errors.some((item) => item.path === "models.logical-model.aliases"),
    false,
  );
  assert.equal(
    result.errors.some((item) => item.path.endsWith(".defaultModel")),
    false,
  );
});

test("normalization does not persist prototype profile IDs or files", () => {
  const config = normalizeConfig({
    models: {
      first: {
        id: "first",
        aliases: ["first"],
        targetOverrides: {
          codex: { profileFile: "shared.toml", profileId: "shared" },
        },
      },
      second: {
        id: "second",
        aliases: ["second"],
        targetOverrides: {
          codex: { profileFile: "shared.toml", profileId: "shared" },
        },
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(config), /shared\.toml|profileId|targetOverrides|legacyCodex/);
});

test("public config recursively removes credential material", () => {
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
  const result = publicConfig(config);
  assert.doesNotMatch(JSON.stringify(result), /upstream-token|nested-secret|legacy-api-key|access-token|refresh-token/);
  assert.equal(result.upstreams.relay.auth.header, "authorization");
  assert.equal(result.upstreams.relay.baseUrl, "https://relay.example/v1");
});

test("validation reports malformed graph nodes instead of throwing", () => {
  const result = validateConfig({
    upstreams: { broken: null },
    models: { broken: null },
    routes: { broken: { backends: [null] } },
    virtualProviders: {
      broken: {
        listenHost: "127.0.0.1",
        listenPort: 43101,
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

test("Web management listener must stay on loopback after removing management tokens", () => {
  const result = validateConfig({
    web: { listenHost: "0.0.0.0", port: 43100 },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === "web.listenHost"));
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
  const config = normalizeConfig({
    upstreams: { relay: { protocol: "openai.responses", baseUrl: "https://relay.example/v1" } },
    models: { model: { aliases: ["model"], upstreams: { relay: { upstreamModelId: "vendor" } } } },
    routes: { route: { backends: [{ upstream: "relay", models: ["model"] }] } },
    virtualProviders: {
      codex: {
        listenHost: "127.0.0.1", listenPort: 43101, ingressProtocol: "openai.responses",
        route: "route", allowedModels: ["model"],
      },
    },
  });
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    config.web.listenHost = host;
    const result = validateConfig(config);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.20"]) {
    config.web.listenHost = host;
    config.virtualProviders.cabletidy_codex.localAuth = { secretRef: "secret://virtual-providers/codex" };
    const result = validateConfig(config);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.path === "web.listenHost"));
  }
});
