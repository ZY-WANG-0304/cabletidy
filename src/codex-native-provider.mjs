import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  backupFile,
  normalizeConfig,
  resolveUpstreamSecret,
} from "./config.mjs";
import { configurationId, providerIdForConfiguration, configurationBaseUrl } from "../web/config-identity.js";
import { resolveModelProfile } from "./model-resolver.mjs";
import { loadCodexCatalog, planCodexCatalog, validateCatalog } from "./codex-catalog.mjs";
import { patchRootConfig, patchProviderConfig, readCodexConfig } from "./codex-config-file.mjs";

export const CODEX_NATIVE_PROVIDER_INTEGRATION = "codex-native-provider";
export const CODEX_TARGET_FORMAT = "codex.config.toml.v1";
export const CODEX_NATIVE_REQUIRED_ENDPOINTS = Object.freeze([
  Object.freeze({
    method: "GET",
    path: "/v1/models",
    purpose: "model_discovery",
  }),
  Object.freeze({
    method: "POST",
    path: "/v1/responses",
    purpose: "responses",
    supportsStreaming: true,
  }),
]);

const ROOT_BEGIN = "# >>> CABLETIDY MANAGED PROVIDER";
const ROOT_END = "# <<< CABLETIDY MANAGED PROVIDER";
const ACTIVE_BEGIN = "# >>> CABLETIDY MANAGED ACTIVE PROVIDER";
const ACTIVE_END = "# <<< CABLETIDY MANAGED ACTIVE PROVIDER";

function quote(value) {
  return JSON.stringify(String(value ?? ""));
}

function providerForBinding(config, binding, virtualProvider) {
  const route = config.routes?.[virtualProvider?.route];
  if (route?.backends?.length !== 1) throw new Error("每份配置必须且只能连接一个 upstream");
  return config.upstreams?.[route.backends[0]?.upstream];
}

function profilePolicy(profile) {
  return {
    contextWindow: Number(profile?.contextWindow || 0) || null,
    compact: profile?.compact || null,
  };
}

export function buildCodexArtifacts(config, options = {}, secrets = {}) {
  // Collisions can block a chain of renames, so reject them before looking up a new ID.
  const names = new Set();
  for (const [id, binding] of Object.entries(config.bindings || {})) {
    const nameId = configurationId(binding?.name, id);
    if (names.has(nameId)) throw new Error(`配置名称规范化后重复: ${nameId}`);
    names.add(nameId);
  }
  let bindingId = options.bindingId;
  const requestedBinding = config.bindings?.[bindingId];
  config = normalizeConfig(config);
  if (requestedBinding) bindingId = configurationId(requestedBinding.name, bindingId);
  if (!bindingId || !config.bindings?.[bindingId]) {
    bindingId = Object.entries(config.bindings || {}).find(
      ([id, item]) =>
        item.target === "codex" &&
        (!options.bindingId || id === options.bindingId || item.id === options.bindingId),
    )?.[0];
  }
  const binding = bindingId ? config.bindings?.[bindingId] : null;
  if (!binding) throw new Error("找不到 Codex binding");
  const virtualProvider = config.virtualProviders?.[binding.virtualProvider];
  if (!virtualProvider) throw new Error("Binding 引用的 Virtual Provider 不存在");
  if (virtualProvider.id !== providerIdForConfiguration(bindingId) ||
      Object.values(config.bindings).filter((item) => item?.virtualProvider === virtualProvider.id).length !== 1) {
    throw new Error("配置与 Virtual Provider 必须一对一，Virtual Provider ID 必须为 cabletidy_<配置ID>");
  }
  if (binding.target !== "codex") {
    throw new Error(`binding ${bindingId} 不是 Codex target`);
  }
  const defaultModel = binding.defaultModel || virtualProvider.defaultModel;
  const modelResolution = defaultModel ? resolveModelProfile(config, virtualProvider, defaultModel) : null;

  const upstream = providerForBinding(config, binding, virtualProvider);
  if (!upstream) throw new Error("找不到 binding 对应的 upstream");
  const providerId = virtualProvider.id;
  const clientModel =
    modelResolution?.profile?.clientModelId ||
    modelResolution?.profile?.aliases?.[0] ||
    modelResolution?.clientModelId || null;
  const policy = profilePolicy(modelResolution?.profile);
  const activeContents = [
    `${ACTIVE_BEGIN} ${providerId} -->`,
    `model_provider = ${quote(providerId)}`,
    ...(clientModel ? [`model = ${quote(clientModel)}`] : []),
    `${ACTIVE_END} ${providerId} <--`,
    "",
  ].join("\n");
  const providerContents = [
    `${ROOT_BEGIN} ${providerId} -->`,
    `[model_providers.${providerId}]`,
    `name = ${quote(`CableTidy / ${upstream.name || upstream.id}`)}`,
    `base_url = ${quote(`${configurationBaseUrl(config, bindingId)}/v1`)}`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    `${ROOT_END} ${providerId} <--`,
    "",
  ].join("\n");
  const rootContents = `${activeContents}\n${providerContents}`;

  return {
    integration: CODEX_NATIVE_PROVIDER_INTEGRATION,
    targetFormat: CODEX_TARGET_FORMAT,
    format: CODEX_TARGET_FORMAT,
    target: "codex",
    mode: "managed_proxy",
    bindingId,
    virtualProviderId: virtualProvider.id,
    providerId,
    activeContents,
    providerContents,
    clientModelId: clientModel,
    modelPolicy: policy,
    files: [{ path: "config.toml", contents: rootContents }],
    environment: { vars: {}, shell: "" },
    upstream: {
      id: upstream.id,
      baseUrl: upstream.baseUrl,
      envKey: upstream.envKey,
      secretConfigured: Boolean(resolveUpstreamSecret(upstream, secrets)),
    },
  };
}

export async function prepareCodexArtifacts(config, options = {}, secrets = {}) {
  const artifacts = buildCodexArtifacts(config, options, secrets);
  config = normalizeConfig(config);
  const provider = config.virtualProviders[config.bindings[artifacts.bindingId].virtualProvider];
  artifacts.catalogPlan = provider.allowedModels?.length
    ? planCodexCatalog(config, provider, await (options.loadCatalog || loadCodexCatalog)())
    : { catalog: null, models: [], overrides: [], warnings: [] };
  return stageCodexArtifacts(artifacts, options);
}

const CATALOG_STATE_FILE = ".cabletidy-model-catalog.json";

async function readOptional(file) {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

function codexHomeFor(options) {
  return path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

async function stageCodexArtifacts(artifacts, options = {}) {
  const codexHome = codexHomeFor(options);
  const existing = await readOptional(path.join(codexHome, "config.toml"));
  const current = readCodexConfig(existing);
  const warnings = [...(artifacts.catalogPlan?.warnings || [])];
  const stateText = await readOptional(path.join(codexHome, CATALOG_STATE_FILE));
  const saved = stateText ? JSON.parse(stateText) : null;
  const ownsCatalog = saved?.version === 1 && current.model_catalog_json === saved.managedPath;
  const previousCatalog = ownsCatalog ? saved.previousCatalog : current.model_catalog_json;
  const previousContext = ownsCatalog ? current.model_context_window ?? saved.previousContext : current.model_context_window;
  const rootValues = {
    model_provider: artifacts.providerId,
    ...(artifacts.clientModelId ? { model: artifacts.clientModelId } : {}),
  };
  const files = [];
  let catalogState;
  if (artifacts.catalogPlan?.catalog) {
    warnings.push("模型目录覆盖作用于当前 Codex 配置，不按 provider 隔离；切换到其他 provider 前需恢复官方定义或原目录。重新启动 Codex 后读取更新。");
    let catalog = structuredClone(artifacts.catalogPlan.catalog);
    if (previousCatalog) {
      if (typeof previousCatalog !== "string") throw new Error("现有 model_catalog_json 必须为路径字符串");
      const file = path.isAbsolute(previousCatalog) ? previousCatalog : path.resolve(codexHome, previousCatalog);
      const previous = validateCatalog(JSON.parse(await fs.readFile(file, "utf8")));
      const replacements = new Map(catalog.models.map((model) => [model.slug, model]));
      // Preserve foreign entries. Active model entries must keep their
      // official instructions rather than inheriting arbitrary user prompts.
      catalog = { ...previous, models: previous.models.map((model) =>
        artifacts.catalogPlan.models.includes(model.slug) ? replacements.get(model.slug) : model,
      ) };
      const present = new Set(catalog.models.map((model) => model.slug));
      for (const model of replacements.values()) if (!present.has(model.slug)) catalog.models.push(model);
      warnings.push("已保留原模型目录的其他条目；当前模型的覆盖在 Codex 配置中是全局的，不按 provider 隔离。");
    }
    const contents = `${JSON.stringify(catalog, null, 2)}\n`;
    const digest = createHash("sha256").update(contents).digest("hex").slice(0,24);
    const relative = `model-catalogs/cabletidy-${digest}.json`;
    rootValues.model_catalog_json = path.join(codexHome, relative);
    rootValues.model_context_window = undefined;
    catalogState = {
      version: 1,
      sourceVersion: artifacts.catalogPlan.sourceVersion,
      managedPath: rootValues.model_catalog_json,
      previousCatalog,
      previousContext,
    };
    files.push({ path: relative, contents, kind: "json" });
    if (current.model_context_window !== undefined) warnings.push("将暂时移除根级 model_context_window，使逐模型窗口生效；返回官方默认模式时恢复。");
  } else if (ownsCatalog) {
    rootValues.model_catalog_json = previousCatalog;
    // Do not discard a root override the user added after our last apply.
    if (current.model_context_window === undefined) rootValues.model_context_window = previousContext;
    catalogState = null;
  }
  for (const key of ["model_instructions_file", "model_auto_compact_token_limit", "model_supports_reasoning_summaries"]) {
    if (current[key] !== undefined) warnings.push(`保留现有 ${key}，该用户配置仍会影响 Codex 行为。`);
  }
  if (!artifacts.catalogPlan?.catalog && previousCatalog) warnings.push("保留现有 model_catalog_json；Codex 将继续使用用户的模型目录。");
  if (!artifacts.catalogPlan?.catalog && previousContext !== undefined) warnings.push("保留现有 model_context_window，它会覆盖模型目录中的上下文窗口。");
  let root = patchRootConfig(existing, rootValues);
  root = patchProviderConfig(root, artifacts.providerId, artifacts.providerContents);
  return {
    ...artifacts,
    codexHome,
    rootBefore: existing,
    catalogState,
    warnings: [...new Set(warnings)],
    catalogSummary: artifacts.catalogPlan ? {
      sourceVersion: artifacts.catalogPlan.sourceVersion,
      mode: artifacts.catalogPlan.catalog ? "managed" : "official",
      overrides: artifacts.catalogPlan.overrides,
    } : undefined,
    files: [{ path: "config.toml", contents: `${root.trimEnd()}\n` }, ...files],
  };
}

function safeRelativePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.includes("\0") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Codex artifact 文件路径不安全: ${value}`);
  }
  return normalized;
}

async function writeArtifact(file, contents, paths, label) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await backupFile(file, paths.backups, label);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, contents, { mode: 0o600 });
  await fs.rename(temporary, file);
}

let applyOperation = Promise.resolve();

export function applyCodexArtifacts(artifacts, options = {}) {
  const operation = applyOperation.then(() => applyCodexArtifactsNow(artifacts, options));
  applyOperation = operation.catch(() => {});
  return operation;
}

async function applyCodexArtifactsNow(artifacts, options = {}) {
  if (!artifacts?.activeContents || !artifacts.providerContents || !artifacts.providerId) {
    throw new Error("Unsupported Codex artifacts: expected a generated provider configuration");
  }
  const staged = await stageCodexArtifacts(artifacts, options);
  const paths = options.paths || { backups: path.join(os.homedir(), ".cabletidy", "backups") };
  await fs.mkdir(paths.backups, { recursive: true, mode: 0o700 });
  await fs.mkdir(staged.codexHome, { recursive: true, mode: 0o700 });
  const rootFile = path.join(staged.codexHome, "config.toml");
  const stateFile = path.join(staged.codexHome, CATALOG_STATE_FILE);
  const previousState = await readOptional(stateFile);
  const applied = [];
  // Content-addressed catalogs are written first, so a failed config write
  // never changes the catalog used by the previous configuration.
  for (const file of staged.files.slice(1)) {
    const target = path.join(staged.codexHome, safeRelativePath(file.path));
    await writeArtifact(target, file.contents, paths, "codex-model-catalog.json");
    applied.push(target);
  }
  if (await readOptional(rootFile) !== staged.rootBefore) {
    throw new Error("Codex 配置在应用期间已改变，请重新预览并重试");
  }
  try {
    if (staged.catalogState !== undefined) {
      await writeArtifact(stateFile, `${JSON.stringify(staged.catalogState)}\n`, paths, "codex-catalog-state.json");
    }
    await writeArtifact(rootFile, staged.files[0].contents, paths, "codex-config.toml");
  } catch (error) {
    if (staged.catalogState !== undefined) {
      if (previousState) await fs.writeFile(stateFile, previousState, { mode: 0o600 });
      else await fs.unlink(stateFile).catch(() => {});
    }
    throw error;
  }
  applied.unshift(rootFile);
  return { applied, environment: staged.environment, mode: staged.mode, warnings: staged.warnings, catalogSummary: staged.catalogSummary };
}

export function publicArtifacts(artifacts) {
  const { catalogPlan, catalogState, rootBefore, codexHome, ...publicValues } = artifacts;
  return {
    ...publicValues,
    environment: {
      vars: artifacts.environment?.vars || {},
      shell: artifacts.environment?.shell || "",
    },
  };
}
