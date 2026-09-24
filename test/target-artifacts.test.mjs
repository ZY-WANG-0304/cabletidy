import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTargetArtifacts,
  publicTargetArtifacts,
} from "../src/target-artifacts.mjs";
import { normalizeConfig } from "../src/config.mjs";
import { claudeConfigFixture } from "./helpers/claude-fixture.mjs";
import { validateConfig } from "../src/validation.mjs";

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
        backends: [{ upstream: "anthropic", models: ["claude-sonnet"] }],
      },
    },
    virtualProviders: {
      "claude-main": {
        id: "claude-main",
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
        defaultModel: "claude-sonnet",
        claude: { setModel: true },
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

test("Claude startup aliases remain literal when they collide with profile IDs or custom aliases", () => {
  for (const alias of ["best", "opus", "sonnet", "fable", "haiku", "opusplan"]) {
    for (const match of ["profileId", "customAlias"]) {
      const config = claudeConfigFixture();
      const profileId = match === "profileId" ? alias : "internal-model";
      config.models = {
        [profileId]: { ...config.models.sonnet, id: profileId, aliases: ["claude-sonnet-4-6", alias] },
        custom: { ...config.models.sonnet, id: "custom", clientModelId: "claude-custom-sonnet", aliases: ["claude-custom-sonnet"] },
      };
      config.routes.route.backends[0].models = [profileId, "custom"];
      const provider = config.virtualProviders["cabletidy_claude-main"];
      provider.allowedModels = [profileId, "custom"];
      provider.defaultModel = alias;
      config.bindings["claude-main"].claude.models = { sonnet: "claude-custom-sonnet", subagent: "sonnet" };
      assert.equal(validateConfig(config).ok, true);
      for (const bindingDefault of [undefined, alias]) {
        config.bindings["claude-main"].defaultModel = bindingDefault;
        const artifacts = buildTargetArtifacts(config, { bindingId: "claude-main" });
        assert.equal(artifacts.clientModelId, alias);
        assert.equal(artifacts.environment.vars.ANTHROPIC_MODEL, alias);
        assert.equal(artifacts.environment.vars.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-custom-sonnet");
        assert.equal(artifacts.environment.vars.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
        assert.equal(JSON.parse(artifacts.files[0].contents).env.ANTHROPIC_MODEL, alias);
      }
    }
  }
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
