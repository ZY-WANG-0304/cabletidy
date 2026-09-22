import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { applyClaudeSettings, restoreClaudeSettings, claudeConfigHome } from "../src/claude-config-file.mjs";
import { buildTargetArtifacts, prepareTargetArtifacts, publicTargetArtifacts } from "../src/target-artifacts.mjs";
import { claudeConfigFixture } from "./helpers/claude-fixture.mjs";

async function fixture(t, settings) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-claude-settings-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const claudeHome = path.join(home, "client");
  const file = path.join(claudeHome, "settings.json");
  if (settings !== undefined) {
    await fs.mkdir(claudeHome);
    await fs.writeFile(file, JSON.stringify(settings));
  }
  const options = { claudeHome, paths: { backups: path.join(home, "backups") } };
  const config = claudeConfigFixture();
  const artifacts = () => buildTargetArtifacts(config, { bindingId: "claude-main" });
  const read = async () => JSON.parse(await fs.readFile(file, "utf8"));
  return { home, file, options, config, artifacts, read };
}

test("Claude preview is read-only, uses public placeholders, and exports portable settings", async (t) => {
  const f = await fixture(t);
  const artifacts = await prepareTargetArtifacts(f.config, { ...f.options, bindingId: "claude-main" });
  await assert.rejects(fs.stat(f.options.claudeHome), { code: "ENOENT" });
  const view = publicTargetArtifacts(artifacts);
  assert.equal(view.settingsPath, f.file);
  assert.equal(view.canApply, true);
  assert.equal(view.canRestore, false);
  assert.equal(view.environment.vars.ANTHROPIC_AUTH_TOKEN, "cabletidy-local");
  assert.equal(view.environment.vars.CLAUDE_CODE_USE_BEDROCK, "0");
  assert.equal(view.environment.vars.ANTHROPIC_API_KEY, "");
  assert.ok(!Object.hasOwn(view.environment.vars, "ANTHROPIC_MODEL"));
  assert.deepEqual(JSON.parse(view.files[0].contents), { env: view.environment.vars });
  assert.match(view.environment.powershell, /\$env:ANTHROPIC_AUTH_TOKEN = 'cabletidy-local'/);
});

test("apply, switch and restore preserve existing secrets, unrelated edits and optional model choices", async (t) => {
  const original = { env: { ANTHROPIC_BASE_URL: "https://old.invalid", ANTHROPIC_AUTH_TOKEN: "old-secret",
    ANTHROPIC_API_KEY: "old-api-key", ANTHROPIC_MODEL: "old-model", CUSTOM_VALUE: "keep", CLAUDE_CODE_USE_BEDROCK: "1" },
    model: "user-choice", permissions: { allow: ["Read"] }, hooks: { Stop: [] }, apiKeyHelper: "my-helper" };
  const f = await fixture(t, original);
  f.config.bindings["claude-main"].defaultModel = "claude-sonnet-4-6";
  f.config.bindings["claude-main"].claude = { discoverModels: true, models: { haiku: "claude-haiku-custom", subagent: "sonnet" } };
  const preview = await prepareTargetArtifacts(f.config, { ...f.options, bindingId: "claude-main" });
  assert.doesNotMatch(JSON.stringify(preview), /old-secret|old-api-key|my-helper/);
  const report = await applyClaudeSettings(f.artifacts(), f.options);
  assert.deepEqual(JSON.parse(await fs.readFile(report.backup, "utf8")), original);
  const applied = await f.read();
  assert.equal(applied.env.ANTHROPIC_MODEL, "claude-sonnet-4-6");
  assert.equal(applied.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(applied.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-haiku-custom");
  assert.equal(applied.model, original.model);
  assert.deepEqual(applied.permissions, original.permissions);
  applied.newPreference = true;
  applied.env.UNRELATED = "new";
  await fs.writeFile(f.file, JSON.stringify(applied));
  const second = f.artifacts();
  second.bindingId = "another";
  second.environment.vars.ANTHROPIC_BASE_URL = "http://127.0.0.1:43100/another";
  delete second.environment.vars.ANTHROPIC_MODEL;
  delete second.environment.vars.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  await applyClaudeSettings(second, f.options);
  assert.equal((await f.read()).env.ANTHROPIC_MODEL, "old-model");
  assert.ok(!Object.hasOwn((await f.read()).env, "ANTHROPIC_DEFAULT_HAIKU_MODEL"));
  await assert.rejects(restoreClaudeSettings("claude-main", f.options), /another/);
  await restoreClaudeSettings("another", f.options);
  assert.deepEqual(await f.read(), { ...original, env: { ...original.env, UNRELATED: "new" }, newPreference: true });
  await assert.rejects(fs.stat(path.join(f.options.claudeHome, ".cabletidy-settings.json")), { code: "ENOENT" });
});

test("restore and reapply reject hand-edited managed fields without exposing their values", async (t) => {
  const f = await fixture(t, { permissions: {} });
  await applyClaudeSettings(f.artifacts(), f.options);
  const changed = await f.read();
  changed.env.ANTHROPIC_AUTH_TOKEN = "manual-secret";
  await fs.writeFile(f.file, JSON.stringify(changed));
  const preview = await prepareTargetArtifacts(f.config, { ...f.options, bindingId: "claude-main" });
  assert.equal(preview.canApply, false);
  assert.deepEqual(preview.conflicts, ["env.ANTHROPIC_AUTH_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(preview), /manual-secret/);
  for (const operation of [() => applyClaudeSettings(f.artifacts(), f.options), () => restoreClaudeSettings("claude-main", f.options)]) {
    await assert.rejects(operation(), (error) => /env.ANTHROPIC_AUTH_TOKEN/.test(error.message) && !error.message.includes("manual-secret"));
    assert.deepEqual(await f.read(), changed);
  }
});

test("concurrent applies retain the first original settings and can be fully restored", async (t) => {
  const f = await fixture(t, { env: {}, permissions: { deny: ["Bash(rm *)"] } });
  await Promise.all(Array.from({ length: 4 }, () => applyClaudeSettings(f.artifacts(), f.options)));
  await restoreClaudeSettings("claude-main", f.options);
  assert.deepEqual(await f.read(), { env: {}, permissions: { deny: ["Bash(rm *)"] } });
  const fresh = await fixture(t, {});
  await applyClaudeSettings(fresh.artifacts(), fresh.options);
  await restoreClaudeSettings("claude-main", fresh.options);
  assert.deepEqual(await fresh.read(), {});
});

test("invalid settings are never replaced", async (t) => {
  const f = await fixture(t, {});
  for (const invalid of ['{"broken":', '[]', '{"env":[]}']) {
    await fs.writeFile(f.file, invalid);
    await assert.rejects(applyClaudeSettings(f.artifacts(), f.options));
    assert.equal(await fs.readFile(f.file, "utf8"), invalid);
  }
});

test("an interrupted ledger write recovers either side of the settings replacement", async (t) => {
  for (const completed of [false, true]) {
    const f = await fixture(t, { env: { ANTHROPIC_AUTH_TOKEN: "original" } });
    const before = await fs.readFile(f.file, "utf8");
    await applyClaudeSettings(f.artifacts(), f.options);
    const after = await fs.readFile(f.file, "utf8");
    const stateFile = path.join(f.options.claudeHome, ".cabletidy-settings.json");
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
    state.pending = { before: hash(before), after: hash(after), previous: null };
    await fs.writeFile(stateFile, JSON.stringify(state));
    if (!completed) await fs.writeFile(f.file, before);
    await applyClaudeSettings(f.artifacts(), f.options);
    await restoreClaudeSettings("claude-main", f.options);
    assert.deepEqual(await f.read(), JSON.parse(before));
  }
});

test("Claude config directory honors the official environment variable and explicit test isolation", () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), "custom-claude");
    assert.equal(claudeConfigHome(), path.resolve(process.env.CLAUDE_CONFIG_DIR));
    assert.equal(claudeConfigHome({ claudeHome: "." }), path.resolve("."));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});
