import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeConfigurationIdentities } from "../web/config-identity.js";

const DEFAULT_HOME = process.env.CABLETIDY_HOME || path.join(os.homedir(), ".cabletidy");
const SECRET_FIELD_NAMES = new Set([
  "secret",
  "apiKey",
  "api_key",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "clientSecret",
  "client_secret",
  "password",
  "privateKey",
  "private_key",
]);

export function getPaths(home = DEFAULT_HOME) {
  return {
    home,
    config: path.join(home, "config.json"),
    secrets: path.join(home, "secrets.json"),
    runtime: path.join(home, "runtime.json"),
    backups: path.join(home, "backups"),
  };
}

export function defaultConfig() {
  return {
    version: 1,
    revision: 0,
    daemon: {},
    web: {
      enabled: true,
      listenHost: "127.0.0.1",
      port: 43100,
    },
    upstreams: {},
    models: {},
    routes: {},
    virtualProviders: {},
    bindings: {},
  };
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeRecord(base, value) {
  if (!isRecord(value)) return base;
  for (const [key, item] of Object.entries(value)) {
    if (isRecord(item) && isRecord(base[key])) {
      mergeRecord(base[key], item);
    } else {
      base[key] = item;
    }
  }
  return base;
}

export function normalizeConfig(input = {}) {
  const config = mergeRecord(defaultConfig(), structuredClone(input));
  config.version = Number(config.version) || 1;
  config.revision = Number(config.revision) || 0;
  for (const key of ["upstreams", "models", "routes", "virtualProviders", "bindings"]) {
    if (!isRecord(config[key])) config[key] = {};
  }
  // The Web console is a loopback-only local control surface; old session
  // lifetime settings are no longer part of the effective configuration.
  delete config.web.sessionTtlSeconds;
  if (isRecord(config.daemon)) delete config.daemon.proxyPortRange;
  migratePrototypeCodexFields(config);
  for (const provider of Object.values(config.virtualProviders)) {
    if (isRecord(provider)) {
      delete provider.localAuth;
      delete provider.listenHost;
      delete provider.listenPort;
    }
  }
  for (const binding of Object.values(config.bindings)) {
    if (isRecord(binding?.codex)) delete binding.codex.localEnvKey;
    if (isRecord(binding?.claude)) delete binding.claude.authEnv;
  }
  normalizeConfigurationIdentities(config);
  return config;
}

function migratePrototypeCodexFields(config) {
  // Read legacy prototype keys once, translate useful values, and discard
  // profile-file metadata before the config reaches runtime or disk.
  for (const upstream of Object.values(config.upstreams)) {
    if (!isRecord(upstream)) continue;
    // These policy placeholders never affected runtime behavior.
    for (const field of ["requestMaxRetries", "streamMaxRetries", "streamIdleTimeoutMs", "requiresOpenaiAuth", "supportsWebsockets"]) {
      delete upstream[field];
    }
    if (!upstream.integration && upstream.providerFormat === "codex.toml.v1") {
      upstream.integration = "codex-native-provider";
    }
    if (isRecord(upstream.codexToml)) {
      if (!upstream.codexNative) {
        upstream.codexNative = {
          providerId: upstream.codexToml.providerId,
          envKey: upstream.codexToml.envKey,
        };
      }
      if (upstream.envKey === undefined && upstream.codexToml.envKey) {
        upstream.envKey = upstream.codexToml.envKey;
      }
    }
    delete upstream.providerFormat;
    delete upstream.codexToml;
  }

  for (const model of Object.values(config.models)) {
    if (!isRecord(model)) continue;
    const legacy = isRecord(model.targetOverrides?.codex)
      ? model.targetOverrides.codex
      : isRecord(model.legacyCodex)
        ? model.legacyCodex
        : null;
    if (isRecord(legacy)) {
      if (model.clientModelId === undefined && legacy.model) {
        model.clientModelId = legacy.model;
      }
      if (model.contextWindow === undefined && legacy.modelContextWindow !== undefined) {
        model.contextWindow = legacy.modelContextWindow;
      }
      if (model.compact === undefined && legacy.modelAutoCompactTokenLimit !== undefined) {
        model.compact = {
          strategy: "auto",
          tokenLimit: legacy.modelAutoCompactTokenLimit,
        };
      }
      if (model.personality === undefined && legacy.personality) {
        model.personality = legacy.personality;
      }
    }
    // Profile IDs, profile file paths, and other target-only fields belonged
    // to the old prototype. They are migration input, not CableTidy state.
    delete model.legacyCodex;
    if (isRecord(model.targetOverrides)) {
      delete model.targetOverrides.codex;
      if (Object.keys(model.targetOverrides).length === 0) delete model.targetOverrides;
    }
    // Reasoning effort is selected by the CLI request, not fixed on a model.
    delete model.reasoning;
  }

  for (const binding of Object.values(config.bindings)) {
    if (!isRecord(binding)) continue;
    if (!binding.integration && binding.providerFormat === "codex.toml.v1") {
      binding.integration = "codex-native-provider";
    }
    if (binding.targetFormat === "codex.toml.v1") {
      binding.targetFormat = "codex.config.toml.v1";
    }
    delete binding.providerFormat;
    if (isRecord(binding.codex)) {
      for (const key of ["profileFiles", "sourceUpstream", "sourceProviderId"]) {
        delete binding.codex[key];
      }
      delete binding.codex.providerId;
    }
    delete binding.legacyCodex;
  }
}

export function publicConfig(config) {
  const copy = structuredClone(normalizeConfig(config));
  redactSecretFields(copy);
  return copy;
}

export function stripSecretFields(value) {
  const copy = structuredClone(value);
  redactSecretFields(copy);
  return copy;
}

export async function ensureStore(paths = getPaths()) {
  await fs.mkdir(paths.home, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.backups, { recursive: true, mode: 0o700 });
  try {
    await fs.access(paths.config);
  } catch {
    await writeJsonAtomic(paths.config, defaultConfig(), 0o600);
  }
  try {
    await fs.access(paths.secrets);
  } catch {
    await writeJsonAtomic(paths.secrets, {}, 0o600);
  }
}

export async function loadConfig(paths = getPaths()) {
  await ensureStore(paths);
  const raw = await fs.readFile(paths.config, "utf8");
  return normalizeConfig(JSON.parse(raw));
}

export async function loadSecrets(paths = getPaths()) {
  await ensureStore(paths);
  const raw = await fs.readFile(paths.secrets, "utf8");
  const parsed = JSON.parse(raw);
  return isRecord(parsed) ? parsed : {};
}

export async function writeJsonAtomic(file, value, mode = 0o600) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await fs.chmod(temporary, mode);
  await fs.rename(temporary, file);
}

export async function saveConfig(config, paths = getPaths()) {
  await writeJsonAtomic(paths.config, normalizeConfig(config), 0o600);
}

export async function saveSecrets(secrets, paths = getPaths()) {
  await writeJsonAtomic(paths.secrets, secrets, 0o600);
}

export async function backupFile(file, backupsDirectory, label) {
  try {
    const contents = await fs.readFile(file);
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const backup = path.join(backupsDirectory, `${stamp}-${label}`);
    await fs.writeFile(backup, contents, { mode: 0o600 });
    return backup;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function secretRefForUpstream(id) {
  return `secret://upstreams/${id}`;
}

export function resolveSecret(reference, secrets = {}) {
  if (typeof reference !== "string" || !reference) return "";
  if (reference.startsWith("env://")) {
    return process.env[reference.slice("env://".length)] || "";
  }
  if (reference.startsWith("secret://")) {
    return secrets[reference] || "";
  }
  return secrets[reference] || process.env[reference] || "";
}

export function resolveUpstreamSecret(upstream, secrets = {}) {
  const envKey = upstream?.envKey;
  return (
    (typeof envKey === "string" && process.env[envKey]) ||
    resolveSecret(upstream?.secretRef, secrets)
  );
}

export function applySecretPayload(config, secrets, payload = {}) {
  const nextSecrets = { ...secrets };
  const upstreamSecrets = isRecord(payload.upstreamSecrets) ? payload.upstreamSecrets : {};
  for (const [id, value] of Object.entries(upstreamSecrets)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const upstream = config.upstreams[id];
    if (!upstream) continue;
    upstream.secretRef ||= secretRefForUpstream(id);
    nextSecrets[upstream.secretRef] = value.trim();
  }
  return nextSecrets;
}

export async function writeRuntimeInfo(info, paths = getPaths()) {
  await writeJsonAtomic(paths.runtime, info, 0o600);
}

export async function readRuntimeInfo(paths = getPaths()) {
  try {
    return JSON.parse(await fs.readFile(paths.runtime, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Return a redacted, path-oriented view of the effective configuration change.
 * Secrets are not part of config, and revision is metadata rather than behavior.
 */
export function computeConfigDiff(beforeInput = {}, afterInput = {}) {
  const before = normalizeConfig(beforeInput);
  const after = normalizeConfig(afterInput);
  const added = [];
  const removed = [];
  const changed = [];

  diffValues(before, after, "", { added, removed, changed });

  const roots = new Set(
    [...added, ...removed, ...changed]
      .map((item) => item.path.split(".")[0])
      .filter(Boolean),
  );
  return {
    added,
    removed,
    changed,
    total: added.length + removed.length + changed.length,
    affected: [...roots],
  };
}

function diffValues(before, after, currentPath, output) {
  if (currentPath === "revision") return;

  if (before === undefined) {
    output.added.push({ path: currentPath, value: after });
    return;
  }
  if (after === undefined) {
    output.removed.push({ path: currentPath, value: before });
    return;
  }

  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      diffValues(
        before[key],
        after[key],
        currentPath ? `${currentPath}.${key}` : key,
        output,
      );
    }
    return;
  }

  if (!sameValue(before, after)) {
    output.changed.push({ path: currentPath, before, after });
  }
}

function redactSecretFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) redactSecretFields(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      delete value[key];
      continue;
    }
    redactSecretFields(item);
  }
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => sameValue(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
  }
  return false;
}
