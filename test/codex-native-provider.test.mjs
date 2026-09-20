import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyCodexArtifacts,
  buildCodexArtifacts,
  codexProviderIdForBinding,
} from "../src/codex-native-provider.mjs";
import { normalizeConfig } from "../src/config.mjs";

test("derives Codex provider ID from the configuration name", () => {
  assert.equal(codexProviderIdForBinding({ id: "codex-main", name: "My Relay" }), "cabletidy_my-relay");
  assert.equal(codexProviderIdForBinding({ id: "codex-main", name: "My Relay", codex: { providerId: "legacy_provider" } }), "cabletidy_my-relay");
});

function nativeConfig() {
  return normalizeConfig({
    upstreams: { relay: { id: "relay", name: "Relay", protocol: "openai.responses", baseUrl: "https://example.invalid/v1" } },
    models: { model: {
      id: "model", name: "gpt-5.5", clientModelId: "gpt-5.5", aliases: ["gpt-5.5"],
      family: "codex", capabilities: ["streaming", "tools", "reasoning"],
      upstreams: { relay: { upstreamModelId: "VENDOR-GPT55" } },
    } },
    routes: { route: { id: "route", backends: [{ upstream: "relay", models: ["model"] }] } },
    virtualProviders: { "relay-codex": { id: "relay-codex", listenHost: "127.0.0.1", listenPort: 43101, ingressProtocol: "openai.responses", route: "route", allowedModels: ["model"], defaultModel: "model" } },
    bindings: { "relay-codex": { id: "relay-codex", name: "Relay Codex", target: "codex", virtualProvider: "relay-codex", defaultModel: "model", codex: {} } },
  });
}

test("Codex renderer emits only a local config.toml provider block", async () => {
  const config = nativeConfig();
  const artifacts = buildCodexArtifacts(
    config,
    { bindingId: "relay-codex" },
    { "secret://virtual-providers/relay-codex": "local-key" },
  );
  assert.deepEqual(artifacts.files.map((file) => file.path), ["config.toml"]);
  assert.match(artifacts.files[0].contents, /base_url = "http:\/\/127\.0\.0\.1:43101\/v1"/);
  assert.match(artifacts.files[0].contents, /model = "gpt-5\.5"/);
  assert.doesNotMatch(artifacts.files[0].contents, /model_context_window|model_auto_compact_token_limit|profiles\./);
  assert.doesNotMatch(artifacts.files[0].contents, /abc\.abcdef\.abc|XXX_API_KEY/);
  assert.doesNotMatch(artifacts.files[0].contents, /env_key|local-key/);
  assert.match(artifacts.files[0].contents, /requires_openai_auth = false/);
  assert.deepEqual(artifacts.environment.vars, {});
});

test("applying native Codex artifacts writes only config.toml", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-native-codex-"));
  const config = nativeConfig();
  const artifacts = buildCodexArtifacts(config, { bindingId: "relay-codex" }, {
    "secret://virtual-providers/relay-codex": "local-key",
  });

  await fs.writeFile(path.join(home, "config.toml"), [
    'model_provider = "existing-provider"',
    'model = "existing-model"',
    "",
    "[model_providers.existing-provider]",
    'base_url = "https://existing.example/v1"',
    'env_key = "EXISTING_KEY"',
    "",
    "# >>> CABLETIDY MANAGED PROVIDER cabletidy_old -->",
    "[model_providers.cabletidy_old]",
    'base_url = "http://127.0.0.1:43101/v1"',
    'env_key = "LEGACY_LOCAL_KEY"',
    "# <<< CABLETIDY MANAGED PROVIDER cabletidy_old <--",
    "",
  ].join("\n"));

  const report = await applyCodexArtifacts(artifacts, {
    codexHome: home,
    paths: { backups: path.join(home, "backups") },
  });
  assert.deepEqual(report.applied, [path.join(home, "config.toml")]);
  assert.deepEqual((await fs.readdir(home)).sort(), ["backups", "config.toml"]);
  const merged = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.doesNotMatch(merged, /profiles\./);
  assert.match(merged, /\[model_providers\.existing-provider\][\s\S]*base_url = "https:\/\/existing\.example\/v1"/);
  assert.match(merged, /model_provider = "cabletidy_relay-codex"/);
  assert.equal((merged.match(/^model_provider\s*=/gm) || []).length, 1);
  assert.match(merged, /LEGACY_LOCAL_KEY/);
  assert.match(merged, /\[model_providers\.cabletidy_relay-codex\]/);
  assert.match(merged, /env_key = "EXISTING_KEY"/);
  await applyCodexArtifacts(artifacts, { codexHome: home, paths: { backups: path.join(home, "backups") } });
  assert.equal(await fs.readFile(path.join(home, "config.toml"), "utf8"), merged);
});

test("unsupported artifact file lists are rejected before changing client files", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-artifact-contract-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, "config.toml");
  const original = 'model = "existing-model"\n';
  await fs.writeFile(root, original);
  const options = { codexHome: home, paths: { backups: path.join(home, "backups") } };

  await assert.rejects(applyCodexArtifacts({
    files: [
      { path: "config.toml", contents: 'model = "replacement"\n' },
      { path: "profiles.toml", contents: '[profiles.custom]\nmodel = "replacement"\n' },
    ],
  }, options), /Unsupported Codex artifacts/);
  assert.equal(await fs.readFile(root, "utf8"), original);
  assert.deepEqual(await fs.readdir(home), ["config.toml"]);

  const artifacts = buildCodexArtifacts(nativeConfig(), { bindingId: "relay-codex" });
  const report = await applyCodexArtifacts(artifacts, options);
  assert.deepEqual(report.applied, [root]);
  assert.deepEqual((await fs.readdir(home)).sort(), ["backups", "config.toml"]);
});
