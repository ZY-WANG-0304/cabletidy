import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { applyClaudeSettings, restoreClaudeSettings, claudeConfigHome } from "./helpers/native.mjs";
import { buildTargetArtifacts, prepareTargetArtifacts, publicTargetArtifacts } from "./helpers/native.mjs";
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
  const artifacts = () => buildTargetArtifacts(config, { cableId: "claude-main" });
  const read = async () => JSON.parse(await fs.readFile(file, "utf8"));
  return { home, file, options, config, artifacts, read };
}

test("Claude preview is read-only, uses public placeholders, and exports portable settings", async (t) => {
  const f = await fixture(t);
  const artifacts = await prepareTargetArtifacts(f.config, { ...f.options, cableId: "claude-main" });
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
  f.config.cables["claude-main"].defaultModel = "claude-sonnet-4-6";
  f.config.cables["claude-main"].claude = { discoverModels: true, models: { haiku: "claude-sonnet-4-6", fable: "claude-sonnet-4-6", subagent: "sonnet" } };
  const preview = await prepareTargetArtifacts(f.config, { ...f.options, cableId: "claude-main" });
  assert.doesNotMatch(JSON.stringify(preview), /old-secret|old-api-key|my-helper/);
  const report = await applyClaudeSettings(f.artifacts(), f.options);
  assert.deepEqual(JSON.parse(await fs.readFile(report.backup, "utf8")), original);
  const applied = await f.read();
  assert.equal(applied.env.ANTHROPIC_MODEL, "claude-sonnet-4-6");
  assert.equal(applied.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(applied.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-sonnet-4-6");
  assert.equal(applied.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "claude-sonnet-4-6");
  assert.equal(applied.model, original.model);
  assert.deepEqual(applied.permissions, original.permissions);
  applied.newPreference = true;
  applied.env.UNRELATED = "new";
  await fs.writeFile(f.file, JSON.stringify(applied));
  const second = f.artifacts();
  second.cableId = "another";
  second.environment.vars.ANTHROPIC_BASE_URL = "http://127.0.0.1:43100/another";
  delete second.environment.vars.ANTHROPIC_MODEL;
  delete second.environment.vars.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete second.environment.vars.ANTHROPIC_DEFAULT_FABLE_MODEL;
  await applyClaudeSettings(second, f.options);
  assert.equal((await f.read()).env.ANTHROPIC_MODEL, "old-model");
  assert.ok(!Object.hasOwn((await f.read()).env, "ANTHROPIC_DEFAULT_HAIKU_MODEL"));
  assert.ok(!Object.hasOwn((await f.read()).env, "ANTHROPIC_DEFAULT_FABLE_MODEL"));
  await assert.rejects(restoreClaudeSettings("claude-main", f.options), /another/);
  await restoreClaudeSettings("another", f.options);
  assert.deepEqual(await f.read(), { ...original, env: { ...original.env, UNRELATED: "new" }, newPreference: true });
  await assert.rejects(fs.stat(path.join(f.options.claudeHome, ".cabletidy-settings.json")), { code: "ENOENT" });
});

test("restore and reapply require confirmation for edited managed fields without exposing their values", async (t) => {
  const f = await fixture(t, { permissions: {} });
  await applyClaudeSettings(f.artifacts(), f.options);
  const changed = await f.read();
  changed.env.ANTHROPIC_AUTH_TOKEN = "manual-secret";
  await fs.writeFile(f.file, JSON.stringify(changed));
  const preview = await prepareTargetArtifacts(f.config, { ...f.options, cableId: "claude-main" });
  assert.equal(preview.canApply, false);
  assert.deepEqual(preview.conflicts, ["env.ANTHROPIC_AUTH_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(preview), /manual-secret/);
  for (const operation of [() => applyClaudeSettings(f.artifacts(), f.options), () => restoreClaudeSettings("claude-main", f.options)]) {
    await assert.rejects(operation(), (error) => /env.ANTHROPIC_AUTH_TOKEN/.test(error.message) && !error.message.includes("manual-secret"));
    assert.deepEqual(await f.read(), changed);
  }
});

test("confirmed reapply backs up edits and retains the first original settings for restore", async (t) => {
  const original = { env: { ANTHROPIC_AUTH_TOKEN: "original-secret" }, permissions: { allow: ["Read"] } };
  const f = await fixture(t, original);
  await applyClaudeSettings(f.artifacts(), f.options);
  const changed = await f.read();
  changed.env.ANTHROPIC_AUTH_TOKEN = "manual-secret";
  delete changed.env.ANTHROPIC_BASE_URL;
  changed.env.UNRELATED = "keep";
  changed.newPreference = true;
  await fs.writeFile(f.file, JSON.stringify(changed));
  let confirmationToken;
  await assert.rejects(applyClaudeSettings(f.artifacts(), f.options), error => {
    assert.equal(error.code, "claude_settings_conflict");
    assert.deepEqual(error.details.fields, ["env.ANTHROPIC_AUTH_TOKEN", "env.ANTHROPIC_BASE_URL"]);
    assert.doesNotMatch(JSON.stringify(error), /manual-secret|original-secret/);
    confirmationToken = error.details.confirmationToken;
    return true;
  });
  const report = await applyClaudeSettings(f.artifacts(), { ...f.options, confirmationToken });
  assert.deepEqual(JSON.parse(await fs.readFile(report.backup, "utf8")), changed);
  const applied = await f.read();
  assert.equal(applied.env.ANTHROPIC_AUTH_TOKEN, "cabletidy-local");
  assert.equal(applied.env.ANTHROPIC_BASE_URL, f.artifacts().environment.vars.ANTHROPIC_BASE_URL);
  assert.equal(applied.env.UNRELATED, "keep");
  assert.equal(applied.newPreference, true);
  await restoreClaudeSettings("claude-main", f.options);
  assert.deepEqual(await f.read(), { ...original, env: { ...original.env, UNRELATED: "keep" }, newPreference: true });
});

test("confirmed restore backs up edits and stale or mismatched confirmations do not write", async (t) => {
  const original = { env: { ANTHROPIC_AUTH_TOKEN: "original-secret" }, hooks: {} };
  const f = await fixture(t, original);
  await applyClaudeSettings(f.artifacts(), f.options);
  const changed = await f.read();
  changed.env.ANTHROPIC_AUTH_TOKEN = "first-manual-secret";
  await fs.writeFile(f.file, JSON.stringify(changed));
  const tokenFor = async operation => {
    let token;
    await assert.rejects(operation(), error => {
      assert.equal(error.code, "claude_settings_conflict");
      assert.doesNotMatch(JSON.stringify(error), /manual-secret|original-secret/);
      token = error.details.confirmationToken;
      return true;
    });
    return token;
  };
  const applyToken = await tokenFor(() => applyClaudeSettings(f.artifacts(), f.options));
  const restoreToken = await tokenFor(() => restoreClaudeSettings("claude-main", f.options));
  assert.notEqual(applyToken, restoreToken);
  await tokenFor(() => restoreClaudeSettings("claude-main", { ...f.options, confirmationToken: applyToken }));
  assert.deepEqual(await f.read(), changed);
  changed.env.ANTHROPIC_AUTH_TOKEN = "second-manual-secret";
  await fs.writeFile(f.file, JSON.stringify(changed));
  const currentToken = await tokenFor(() => restoreClaudeSettings("claude-main", { ...f.options, confirmationToken: restoreToken }));
  assert.notEqual(currentToken, restoreToken);
  assert.deepEqual(await f.read(), changed);
  const report = await restoreClaudeSettings("claude-main", { ...f.options, confirmationToken: currentToken });
  assert.deepEqual(JSON.parse(await fs.readFile(report.backup, "utf8")), changed);
  assert.deepEqual(await f.read(), original);
  await assert.rejects(fs.stat(path.join(f.options.claudeHome, ".cabletidy-settings.json")), { code: "ENOENT" });
});

test("apply confirmation cannot approve a different configuration", async (t) => {
  const f = await fixture(t, {});
  await applyClaudeSettings(f.artifacts(), f.options);
  const changed = await f.read();
  changed.env.ANTHROPIC_AUTH_TOKEN = "manual-secret";
  await fs.writeFile(f.file, JSON.stringify(changed));
  let confirmationToken;
  await assert.rejects(applyClaudeSettings(f.artifacts(), f.options), error => {
    confirmationToken = error.details.confirmationToken;
    return error.code === "claude_settings_conflict";
  });
  const different = f.artifacts();
  different.cableId = "another";
  await assert.rejects(applyClaudeSettings(different, { ...f.options, confirmationToken }), error => {
    assert.notEqual(error.details.confirmationToken, confirmationToken);
    return error.code === "claude_settings_conflict";
  });
  assert.deepEqual(await f.read(), changed);
});

test("Claude confirmation is rejected before dispatching a Codex write", async (t) => {
  const f = await fixture(t, {});
  const codexHome = path.join(f.home, "codex");
  await assert.rejects(applyClaudeSettings({ ...f.artifacts(), target: "codex" }, {
    ...f.options, codexHome, confirmationToken: "previous-claude-confirmation",
  }), /线路已被其他窗口修改，请刷新后重新应用/);
  await assert.rejects(fs.stat(codexHome), { code: "ENOENT" });
  assert.deepEqual(await f.read(), {});
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
test("ownership records written before cables were renamed can still be restored", async (t) => {
  const f = await fixture(t, { env: { ANTHROPIC_AUTH_TOKEN: "original" } });
  const before = await f.read();
  await applyClaudeSettings(f.artifacts(), f.options);
  const stateFile = path.join(f.options.claudeHome, ".cabletidy-settings.json");
  const { cableId, ...state } = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(state.version, 2);
  await fs.writeFile(stateFile, JSON.stringify({ ...state, version: 1, bindingId: cableId }));
  await assert.rejects(restoreClaudeSettings("another", f.options), /claude-main/);
  await restoreClaudeSettings("claude-main", f.options);
  assert.deepEqual(await f.read(), before);
});

for (const action of ["apply", "restore"]) {
  test(`legacy ownership records allow confirmed ${action} after an external edit`, async (t) => {
    const f = await fixture(t, { env: { ANTHROPIC_AUTH_TOKEN: "original-secret" } });
    const original = await f.read();
    await applyClaudeSettings(f.artifacts(), f.options);
    const stateFile = path.join(f.options.claudeHome, ".cabletidy-settings.json");
    const { cableId, ...state } = JSON.parse(await fs.readFile(stateFile, "utf8"));
    const legacy = JSON.stringify({ ...state, version: 1, bindingId: cableId });
    await fs.writeFile(stateFile, legacy);
    const edited = await f.read();
    edited.env.ANTHROPIC_AUTH_TOKEN = "manual-secret";
    await fs.writeFile(f.file, JSON.stringify(edited));
    const operation = options => action === "apply"
      ? applyClaudeSettings(f.artifacts(), options)
      : restoreClaudeSettings("claude-main", options);
    let confirmationToken;
    await assert.rejects(operation(f.options), error => {
      assert.equal(error.code, "claude_settings_conflict");
      assert.deepEqual(error.details.fields, ["env.ANTHROPIC_AUTH_TOKEN"]);
      confirmationToken = error.details.confirmationToken;
      return true;
    });
    assert.deepEqual(await f.read(), edited);
    assert.equal(await fs.readFile(stateFile, "utf8"), legacy);
    const report = await operation({ ...f.options, confirmationToken });
    assert.deepEqual(JSON.parse(await fs.readFile(report.backup, "utf8")), edited);
    if (action === "apply") {
      const migrated = JSON.parse(await fs.readFile(stateFile, "utf8"));
      assert.equal(migrated.version, 2);
      assert.equal(migrated.cableId, "claude-main");
      assert.equal(Object.hasOwn(migrated, "bindingId"), false);
      await restoreClaudeSettings("claude-main", f.options);
    }
    assert.deepEqual(await f.read(), original);
  });
}

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
