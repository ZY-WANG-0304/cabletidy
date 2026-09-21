import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTargetArtifacts,
  publicTargetArtifacts,
} from "../src/target-artifacts.mjs";
import { normalizeConfig } from "../src/config.mjs";

function claudeConfig() {
  return normalizeConfig({
    upstreams: {
      anthropic: {
        id: "anthropic",
        protocol: "anthropic.messages",
        baseUrl: "https://relay.example/v1",
      },
    },
    models: {
      "claude-sonnet": {
        id: "claude-sonnet",
        clientModelId: "sonnet",
        aliases: ["sonnet"],
        upstreams: {
          anthropic: { upstreamModelId: "vendor-sonnet" },
        },
      },
    },
    routes: {
      "claude-route": {
        id: "claude-route",
        strategy: "priority",
        backends: [{ upstream: "anthropic", models: ["claude-sonnet"] }],
      },
    },
    virtualProviders: {
      "claude-main": {
        id: "claude-main",
        listenHost: "127.0.0.1",
        listenPort: 43102,
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
        defaultModel: "claude-sonnet",
        claude: { authEnv: "ANTHROPIC_AUTH_TOKEN", setModel: true },
      },
    },
  });
}

test("Claude Code uses a public client placeholder instead of a local secret", () => {
  const artifacts = buildTargetArtifacts(
    claudeConfig(),
    { bindingId: "claude-main" },
    { "secret://virtual-providers/claude-main": "local-secret-value" },
  );
  assert.equal(artifacts.environment.vars.ANTHROPIC_BASE_URL, "http://127.0.0.1:43100/claude-main");
  assert.equal(artifacts.environment.vars.ANTHROPIC_MODEL, "sonnet");
  assert.doesNotMatch(JSON.stringify(artifacts), /local-secret-value/);

  const publicView = publicTargetArtifacts(artifacts);
  assert.doesNotMatch(JSON.stringify(publicView), /local-secret-value/);
  assert.equal(Object.hasOwn(publicView, "localSecret"), false);
  assert.equal(Object.hasOwn(publicView.environment, "value"), false);
  assert.equal(publicView.environment.vars.ANTHROPIC_AUTH_TOKEN, "cabletidy-local");
  assert.match(publicView.environment.shell, /ANTHROPIC_AUTH_TOKEN='cabletidy-local'/);
});

test("generic CLI environments need only a local URL and model", () => {
  const config = claudeConfig();
  config.bindings["claude-main"].target = "generic-env";
  const artifacts = buildTargetArtifacts(config, { bindingId: "claude-main" }, {
    "secret://virtual-providers/claude-main": "legacy-local-key",
  });
  assert.deepEqual(artifacts.environment.vars, {
    CABLETIDY_BASE_URL: "http://127.0.0.1:43100/claude-main",
    CABLETIDY_MODEL: "sonnet",
  });
  assert.doesNotMatch(JSON.stringify(artifacts), /API_KEY|legacy-local-key/);
  assert.deepEqual(publicTargetArtifacts(artifacts).environment.vars, artifacts.environment.vars);
});

test("passthrough leaves Claude and generic CLI model selection to the client", () => {
  for (const target of ["claude-code", "generic-env"]) {
    const config = claudeConfig();
    config.models = {};
    config.routes["claude-route"].backends[0].models = [];
    config.virtualProviders["cabletidy_claude-main"].allowedModels = [];
    delete config.virtualProviders["cabletidy_claude-main"].defaultModel;
    delete config.bindings["claude-main"].defaultModel;
    config.bindings["claude-main"].target = target;
    const artifacts = buildTargetArtifacts(config, { bindingId: "claude-main" });
    assert.equal(artifacts.clientModelId, null);
    assert.equal(Object.keys(artifacts.environment.vars).some(key => key.endsWith("_MODEL")), false);
    config.bindings["claude-main"].defaultModel = "unconfigured-model";
    assert.equal(buildTargetArtifacts(config, { bindingId: "claude-main" }).clientModelId, "unconfigured-model");
  }
});
