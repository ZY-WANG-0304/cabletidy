import { execFile, spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const nativeBinary = fileURLToPath(new URL(`../../target/debug/cabletidy${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
export const bridgeBinary = fileURLToPath(new URL(`../../target/debug/cabletidy-test-bridge${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
export class ModelResolveError extends Error {}

export function decode(output) {
  const result = JSON.parse(output);
  if (result.error) {
    const error = new (result.error.name === "ModelResolveError" ? ModelResolveError : Error)(result.error.message);
    throw Object.assign(error, result.error);
  }
  return result.value;
}
export function native(command, ...args) {
  const result = spawnSync(bridgeBinary, [], { input: `${JSON.stringify({ command, args })}\n`, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return decode(result.stdout);
}
export function nativeAsync(command, ...args) {
  return new Promise((resolve, reject) => {
    const child = execFile(bridgeBinary, [], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(decode(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify({ command, args })}\n`);
  });
}

export const defaultConfig = () => native("config.defaults");
export const normalizeConfig = config => native("config.normalize", config);
export const validateConfig = config => native("config.validate", config);
export const publicConfig = (config, secrets = {}) => native("config.public", config, secrets);
export const computeConfigDiff = (before, after) => native("config.diff", before, after);
export const resolveUpstreamSecret = (upstream, secrets = {}) => native("config.secret", upstream, secrets);
export function applySecretPayload(config, secrets, payload) {
  const result = native("config.secrets", config, secrets, payload);
  Object.assign(config, result.config);
  return result.secrets;
}
export function getPaths(home = process.env.CABLETIDY_HOME || path.join(os.homedir(), ".cabletidy")) {
  return { home, config: path.join(home, "config.json"), secrets: path.join(home, "secrets.json"), runtime: path.join(home, "runtime.json"), lock: path.join(home, "daemon.lock"), backups: path.join(home, "backups") };
}
async function read(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export const writeJsonAtomic = (file, value) => nativeAsync("config.write", file, value);
export const saveConfig = (config, paths) => writeJsonAtomic(paths.config, normalizeConfig(config));
export const saveSecrets = (secrets, paths) => writeJsonAtomic(paths.secrets, secrets);
export const loadConfig = async paths => { const value = await read(paths.config); return value && normalizeConfig(value); };
export const readRuntimeInfo = paths => read(paths.runtime);
export const resolveRequest = (config, provider, request) => native("model.resolve", config, provider, request);
export const listClientModels = (config, provider) => native("model.models", config, provider);
export const publicCodexCatalog = snapshot => native("catalog.public", snapshot);
export const planCodexCatalog = (config, provider, snapshot) => native("catalog.plan", config, provider, snapshot);
export const catalogEntryForProfile = (snapshot, id, profile) => native("catalog.entry", snapshot, id, profile);
export async function validateCodexChanges(config, previous, load) {
  if (!native("catalog.changed", config, previous).length) return [];
  return nativeAsync("catalog.validateChanges", config, previous, await load());
}
export const buildTargetArtifacts = (config, options = {}, secrets = {}) => native("artifacts.build", config, options, secrets);
export const buildCodexArtifacts = buildTargetArtifacts;
export async function prepareTargetArtifacts(config, options = {}, secrets = {}) {
  const built = buildTargetArtifacts(config, options, secrets);
  const c = normalizeConfig(config);
  const needsCatalog = built.target === "codex" && c.virtualProviders[built.virtualProviderId]?.allowedModels?.length;
  const snapshot = needsCatalog && options.loadCatalog ? await options.loadCatalog() : null;
  return snapshot ? nativeAsync("artifacts.prepare", config, options, secrets, snapshot) : nativeAsync("artifacts.prepare", config, options, secrets);
}
export const prepareCodexArtifacts = prepareTargetArtifacts;
export const publicTargetArtifacts = artifacts => native("artifacts.public", artifacts);
export const publicArtifacts = publicTargetArtifacts;
export const applyCodexArtifacts = (artifacts, options = {}) => nativeAsync("codex.apply", artifacts, options);
export const applyClaudeSettings = (artifacts, options = {}) => nativeAsync("artifacts.apply", artifacts, options);
export const restoreClaudeSettings = (bindingId, options = {}) => nativeAsync("claude.restore", bindingId, options);
export const claudeConfigHome = (options = {}) => native("claude.home", options);
export const readCodexConfig = text => native("toml.read", text);
export const processStartTime = pid => nativeAsync("process.startTime", pid);
export const inspectProcess = identity => nativeAsync("process.inspect", identity);

export function createCatalogClient() {
  const child = spawn(bridgeBinary, [], { stdio: ["pipe", "pipe", "inherit"] });
  const waiting = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const pending = waiting.shift();
    try { pending.resolve(decode(line)); } catch (error) { pending.reject(error); }
  });
  child.on("error", error => waiting.splice(0).forEach(item => item.reject(error)));
  const closed = new Promise(resolve => child.once("close", resolve));
  function request(command, ...args) {
    return new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      child.stdin.write(`${JSON.stringify({ command, args })}\n`);
    });
  }
  return { load: () => request("catalog.load"), concurrent: () => request("catalog.concurrent"),
    async close() { child.stdin.end(); await closed; lines.close(); } };
}
