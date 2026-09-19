import test from "node:test";
import assert from "node:assert/strict";

import {
  applySecretPayload,
  computeConfigDiff,
  ensureGeneratedSecrets,
  localEnvKeyForProvider,
  normalizeConfig,
  publicConfig,
} from "../src/config.mjs";
import { validateConfig } from "../src/validation.mjs";

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

test("normalizes CableTidy generated Codex provider env keys", () => {
  assert.equal(
    localEnvKeyForProvider("cabletidy_xxx"),
    "CABLETIDY_CODEX_XXX_KEY",
  );
  assert.equal(
    localEnvKeyForProvider("codex-main"),
    "CABLETIDY_CODEX_CODEX_MAIN_KEY",
  );
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
  assert.ok(result.warnings.some((item) => item.path === "virtualProviders.broken.ingressProtocol"));
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
  assert.equal(config.virtualProviders.codex.localAuth, undefined);
  assert.equal(config.bindings.codex.codex.localEnvKey, undefined);
  assert.equal(config.bindings.codex.codex.providerId, undefined);
  assert.ok(legacy.virtualProviders.codex.localAuth);
  const secrets = {
    "secret://upstreams/relay": "upstream-key",
    "secret://virtual-providers/codex": "legacy-local-key",
  };
  assert.deepEqual(ensureGeneratedSecrets(config, secrets), secrets);
  assert.equal(config.virtualProviders.fresh.localAuth, undefined);
  const updated = applySecretPayload(config, secrets, {
    localSecrets: { fresh: "ignored", codex: "ignored" },
    upstreamSecrets: { relay: "new-upstream-key" },
  });
  assert.deepEqual(updated, { ...secrets, "secret://upstreams/relay": "new-upstream-key" });
  assert.equal(config.virtualProviders.fresh.localAuth, undefined);
});

test("keyless Virtual Providers accept loopback hosts and reject public listeners", () => {
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
    config.virtualProviders.codex.listenHost = host;
    const result = validateConfig(config);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.20"]) {
    config.virtualProviders.codex.listenHost = host;
    config.virtualProviders.codex.localAuth = { secretRef: "secret://virtual-providers/codex" };
    const result = validateConfig(config);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.path === "virtualProviders.codex.listenHost"));
  }
});
