import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { backupFile, writeJsonAtomic } from "./config.mjs";

const STATE_FILE = ".cabletidy-settings.json";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (value) => crypto.createHash("sha256").update(value ?? "<absent>").digest("hex");
const snapshot = (env, key) => Object.hasOwn(env, key) ? { present: true, value: env[key] } : { present: false };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function parseSettings(text, file) {
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON in ${file}; the file was left unchanged.`); }
}

export function claudeConfigHome(options = {}) {
  return path.resolve(options.claudeHome || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
}

async function readOptional(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`);
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readState(home) {
  const file = path.join(home, "settings.json");
  const text = await readOptional(file);
  const settings = text === null ? {} : parseSettings(text, file);
  if (!record(settings) || (settings.env !== undefined && !record(settings.env))) {
    throw new Error(`Invalid Claude settings object: ${file}`);
  }
  const stateText = await readOptional(path.join(home, STATE_FILE));
  let state = stateText === null ? null : parseSettings(stateText, path.join(home, STATE_FILE));
  if (state?.pending) {
    // Recover either side of an interrupted atomic settings replacement.
    if (digest(text) === state.pending.before) state = state.pending.previous;
    else if (digest(text) === state.pending.after) delete state.pending;
    else throw new Error("Claude settings changed during an interrupted apply; restore from backup before retrying.");
  }
  if (state !== null && (state.version !== 1 || !record(state.fields) || typeof state.bindingId !== "string")) {
    throw new Error(`Invalid CableTidy ownership record: ${path.join(home, STATE_FILE)}`);
  }
  for (const [key, field] of Object.entries(state?.fields || {})) {
    if (!key.startsWith("ANTHROPIC_") && !key.startsWith("CLAUDE_CODE_")) throw new Error("Invalid managed environment key");
    if (!record(field) || !record(field.before) || typeof field.applied !== "string") throw new Error("Invalid managed environment record");
  }
  return { file, text, settings, state, stateText };
}

function plan(snapshotData, vars, bindingId) {
  const { settings, state } = snapshotData;
  const next = structuredClone(settings);
  const env = next.env || {};
  const fields = {};
  const conflicts = [];
  const changed = [];
  for (const [key, field] of Object.entries(state?.fields || {})) {
    if (!same(snapshot(env, key), { present: true, value: field.applied })) conflicts.push(`env.${key}`);
  }
  for (const key of new Set([...Object.keys(state?.fields || {}), ...Object.keys(vars)])) {
    const current = snapshot(env, key);
    const old = state?.fields[key];
    if (Object.hasOwn(vars, key)) {
      fields[key] = { before: old?.before || current, applied: vars[key] };
      env[key] = vars[key];
    } else if (old.before.present) env[key] = old.before.value;
    else delete env[key];
    if (!same(current, snapshot(env, key))) changed.push(`env.${key}`);
  }
  if (Object.keys(env).length || (state?.hadEnv ?? Object.hasOwn(settings, "env"))) next.env = env;
  else delete next.env;
  return {
    next, conflicts, changed,
    state: {
      version: 1, bindingId, fields,
      hadEnv: state?.hadEnv ?? Object.hasOwn(settings, "env"),
    },
  };
}

function diagnostics(settings, vars) {
  const warnings = [];
  const env = settings.env || {};
  for (const key of Object.keys(vars)) {
    if (Object.hasOwn(env, key) && env[key] !== vars[key]) warnings.push(`Will replace env.${key}; its original value is retained for restore.`);
  }
  if (settings.apiKeyHelper) warnings.push("An existing apiKeyHelper is preserved. Verify the active credential source with /status.");
  if (settings.forceLoginMethod) warnings.push("An existing forceLoginMethod may require a different login method.");
  warnings.push("Project settings, --settings and managed policies can override user settings. Restart Claude Code and check /status after applying.");
  return warnings;
}

export async function prepareClaudeSettings(artifacts, options = {}) {
  const home = claudeConfigHome(options);
  const current = await readState(home);
  const staged = plan(current, artifacts.environment.vars, artifacts.bindingId);
  return {
    ...artifacts,
    settingsPath: current.file,
    changes: staged.changed,
    canApply: staged.conflicts.length === 0,
    canRestore: current.state?.bindingId === artifacts.bindingId,
    conflicts: staged.conflicts,
    warnings: [...(artifacts.warnings || []), ...diagnostics(current.settings, artifacts.environment.vars)],
  };
}

async function withSettingsLock(options, operation) {
  const home = claudeConfigHome(options);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(home, { realpath: true, retries: { retries: 20, minTimeout: 25, maxTimeout: 100 } });
  try { return await operation(home); }
  finally { await release(); }
}

async function commit(home, current, staged, options, restoring) {
  if (staged.conflicts.length) {
    throw new Error(`Claude settings were edited after applying CableTidy: ${staged.conflicts.join(", ")}. Preserve your edits before retrying.`);
  }
  const backups = options.paths?.backups || path.join(os.homedir(), ".cabletidy", "backups");
  await fs.mkdir(backups, { recursive: true, mode: 0o700 });
  const stateFile = path.join(home, STATE_FILE);
  const backup = await backupFile(current.file, backups, "claude-settings.json");
  await backupFile(stateFile, backups, "claude-settings-state.json");
  if (await readOptional(current.file) !== current.text || await readOptional(stateFile) !== current.stateText) {
    throw new Error("Claude settings changed during apply; preview and retry.");
  }
  const contents = `${JSON.stringify(staged.next, null, 2)}\n`;
  await writeJsonAtomic(stateFile, {
    ...staged.state,
    pending: { before: digest(current.text), after: digest(contents), previous: current.state },
  });
  try {
    if (await readOptional(current.file) !== current.text) throw new Error("Claude settings changed during apply; preview and retry.");
    await writeJsonAtomic(current.file, staged.next);
  } catch (error) {
    if (current.stateText !== null) await writeJsonAtomic(stateFile, JSON.parse(current.stateText));
    else await fs.unlink(stateFile);
    throw error;
  }
  // A pending record remains recoverable if finalizing the ledger fails.
  if (restoring) await fs.unlink(stateFile);
  else await writeJsonAtomic(stateFile, staged.state);
  return { applied: [current.file], backup, changes: staged.changed, mode: restoring ? "restored" : "managed_proxy" };
}

export function applyClaudeSettings(artifacts, options = {}) {
  return withSettingsLock(options, async (home) => {
    const current = await readState(home);
    const staged = plan(current, artifacts.environment.vars, artifacts.bindingId);
    const result = await commit(home, current, staged, options, false);
    return { ...result, environment: artifacts.environment, warnings: diagnostics(current.settings, artifacts.environment.vars) };
  });
}

export function restoreClaudeSettings(bindingId, options = {}) {
  return withSettingsLock(options, async (home) => {
    const current = await readState(home);
    if (!current.state) throw new Error("No Claude settings are managed by CableTidy.");
    if (current.state.bindingId !== bindingId) throw new Error(`Claude Code currently uses another CableTidy configuration: ${current.state.bindingId}`);
    return commit(home, current, plan(current, {}, bindingId), options, true);
  });
}
