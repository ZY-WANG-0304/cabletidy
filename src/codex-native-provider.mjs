import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  backupFile,
  resolveUpstreamSecret,
  secretRefForUpstream,
} from "./config.mjs";
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

// These markers are retained only so applyCodexArtifacts can safely update
// legacy/custom artifact objects. The MVP renderer never creates profile files.
const LEGACY_PROFILE_BEGIN = "# >>> CABLETIDY MANAGED PROFILES";
const LEGACY_PROFILE_END = "# <<< CABLETIDY MANAGED PROFILES";
const LEGACY_TUI_BEGIN = "# >>> CABLETIDY MANAGED TUI";
const LEGACY_TUI_END = "# <<< CABLETIDY MANAGED TUI";

function parseScalar(value) {
  const trimmed = value.trim().replace(/\s+#.*$/, "");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"');
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => parseScalar(item));
  }
  return trimmed;
}

function parseAssignment(line) {
  const match = line.match(/^\s*([a-zA-Z0-9_-]+)\s*=\s*(.+?)\s*$/);
  return match ? [match[1], parseScalar(match[2])] : null;
}

function safeId(value, fallback = "provider") {
  const id = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return id || fallback;
}

export function codexProviderIdForBinding(binding) {
  const fallback = safeId(binding?.id, "codex");
  return `cabletidy_${safeId(binding?.name, fallback)}`;
}

function profileSemantics(model) {
  const sourceModel = String(model || "").trim();
  const match = sourceModel.match(/^.*?gpt[- ]?(\d+(?:\.\d+)?)(?:[- ]([a-z]+))?$/i);
  if (match) {
    const version = match[1];
    const variant = match[2] ? match[2].toLowerCase() : "";
    const suffix = variant ? `-${variant}` : "";
    return {
      displayName: `GPT-${version}${variant ? ` ${capitalize(variant)}` : ""}`,
      clientModelId: `gpt-${version}${suffix}`,
      aliases: variant ? [variant] : [],
    };
  }

  return {
    displayName: sourceModel || "Codex model",
    clientModelId: safeId(sourceModel, "codex-model"),
    aliases: [],
  };
}

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function annotateProfileSemantics(result) {
  for (const profile of result.profiles) {
    profile.semantic = profileSemantics(profile.model);
  }
  for (const file of result.profileFiles) {
    for (const profile of file.profiles) {
      profile.semantic = profileSemantics(profile.model);
    }
  }
}

/**
 * Inspect a Codex-native instruction snippet for optional migration tooling.
 * This is intentionally an inspection operation, not the runtime config model.
 */
export function inspectCodexNativeInstructions(text) {
  const lines = String(text || "").split(/\r?\n/);
  const result = {
    integration: CODEX_NATIVE_PROVIDER_INTEGRATION,
    root: {},
    provider: {},
    profileFiles: [],
    profiles: [],
    warnings: [],
  };
  let currentSection = "root";
  let currentProfileFile = null;
  let currentProfile = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/创建文件\s*~\/\.codex\/[^\s]+/.test(line)) {
      currentProfileFile = {
        profiles: [],
        tui: {},
      };
      result.profileFiles.push(currentProfileFile);
      currentSection = "profile-file";
      currentProfile = null;
      continue;
    }

    const providerMatch = line.match(/^\[model_providers\.([^\]]+)\]$/);
    if (providerMatch) {
      currentSection = "provider";
      currentProfile = null;
      result.provider.id = providerMatch[1];
      continue;
    }

    const profileMatch = line.match(/^\[profiles\.[^\]]+\]$/);
    if (profileMatch) {
      if (!currentProfileFile) {
        currentProfileFile = {
          profiles: [],
          tui: {},
        };
        result.profileFiles.push(currentProfileFile);
      }
      currentSection = "profile";
      // The external Codex profile name is reference-only and is deliberately
      // discarded instead of becoming part of CableTidy's model graph.
      currentProfile = {};
      currentProfileFile.profiles.push(currentProfile);
      result.profiles.push({
        model: undefined,
      });
      continue;
    }

    if (line === "[tui]") {
      currentSection = "tui";
      currentProfile = null;
      if (!currentProfileFile) {
        currentProfileFile = {
          profiles: [],
          tui: {},
        };
        result.profileFiles.push(currentProfileFile);
      }
      continue;
    }

    const assignment = parseAssignment(rawLine);
    if (!assignment) continue;
    const [key, value] = assignment;
    if (currentSection === "provider") result.provider[key] = value;
    else if (currentSection === "profile" && currentProfile) {
      currentProfile[key] = value;
      const inspectedProfile = result.profiles.at(-1);
      if (inspectedProfile) inspectedProfile[key] = value;
    } else if (currentSection === "tui" && currentProfileFile) {
      currentProfileFile.tui[key] = value;
    } else {
      result.root[key] = value;
    }
  }

  if (result.root.model && result.provider.model && result.root.model !== result.provider.model) {
    result.warnings.push(
      `root model (${result.root.model}) 与 provider model (${result.provider.model}) 不一致，使用 root model`,
    );
  }
  if (!result.provider.id && result.root.model_provider) {
    result.provider.id = result.root.model_provider;
  }
  if (!result.provider.base_url) {
    result.warnings.push("没有找到 model_providers block 的 base_url");
  }
  if (!result.provider.env_key) {
    result.warnings.push("没有找到 env_key，上游密钥需要在 Web UI 中补充");
  }
  if (!result.profiles.length && result.root.model) {
    result.warnings.push("参考材料没有 profile 模型，使用 root model 作为单个 Model Profile");
  }
  annotateProfileSemantics(result);
  return result;
}

/**
 * Optional migration helper for an existing tutorial/config snippet.
 * The returned fragment is CableTidy's own graph; source profile IDs and files
 * are deliberately not copied into the runtime model or generated again.
 */
export function configFragmentFromCodexNativeInspection(parsed, options = {}) {
  // Do not reuse provider/profile names from the tutorial. They are source
  // material, not CableTidy identities.
  const providerId = safeId(options.upstreamId || "codex-upstream");
  const provider = parsed.provider || {};
  const integration = CODEX_NATIVE_PROVIDER_INTEGRATION;
  const upstream = {
    id: providerId,
    name: options.name || "Codex upstream",
    integration,
    protocol: options.protocol || "openai.responses",
    baseUrl: options.baseUrl || provider.base_url || "",
    secretRef: secretRefForUpstream(providerId),
    enabled: true,
  };

  const models = {};
  const profiles = parsed.profiles?.length
    ? parsed.profiles
    : parsed.root.model
      ? [{ id: "codex-default", model: parsed.root.model }]
      : [];
  for (const profile of profiles) {
    const model = String(profile.model || "").trim();
    if (!model) continue;
    const semantic = profile.semantic || profileSemantics(model);
    const clientModelId = semantic.clientModelId || safeId(model, "codex-model");
    const baseModelId = safeId(
      options.modelPrefix ? `${options.modelPrefix}-${clientModelId}` : `codex-${clientModelId}`,
    );
    let modelId = baseModelId;
    let suffix = 2;
    while (models[modelId]) {
      modelId = `${baseModelId}-${suffix}`;
      suffix += 1;
    }
    if (modelId !== baseModelId) {
      parsed.warnings.push(
        `模型 ${model} 规范化后 ID ${baseModelId} 重复，已使用 ${modelId}`,
      );
    }

    const contextWindow = Number(profile.model_context_window || 1000000);
    const compactTokenLimit = Number(profile.model_auto_compact_token_limit || 850000);
    models[modelId] = {
      id: modelId,
      name: semantic.displayName || clientModelId,
      aliases: [...new Set([clientModelId, ...(semantic.aliases || [])])],
      clientModelId,
      family: "codex",
      capabilities: ["streaming", "tools", "reasoning"],
      contextWindow,
      compact: {
        strategy: "auto",
        tokenLimit: compactTokenLimit,
      },
      upstreams: {
        [providerId]: {
          upstreamModelId: model,
        },
      },
    };
  }

  const modelIds = Object.keys(models);
  const routeId = safeId(options.routeId || `${providerId}-route`);
  const virtualProviderId = safeId(options.virtualProviderId || `${providerId}-codex`);
  const bindingId = safeId(options.bindingId || `${providerId}-codex`);
  const virtualPort = Number(options.listenPort || 43101);

  return {
    upstreams: { [providerId]: upstream },
    models,
    routes: {
      [routeId]: {
        id: routeId,
        name: `${upstream.name} route`,
        strategy: "priority",
        backends: [
          {
            upstream: providerId,
            priority: 10,
            models: modelIds,
            enabled: true,
          },
        ],
      },
    },
    virtualProviders: {
      [virtualProviderId]: {
        id: virtualProviderId,
        name: `Codex via ${upstream.name}`,
        listenHost: "127.0.0.1",
        listenPort: virtualPort,
        ingressProtocol: "openai.responses",
        route: routeId,
        allowedModels: modelIds,
        defaultModel: modelIds[0] || "",
        enabled: true,
      },
    },
    bindings: {
      [bindingId]: {
        id: bindingId,
        target: "codex",
        virtualProvider: virtualProviderId,
        targetFormat: "codex.config.toml.v1",
        mode: "config",
        defaultModel: modelIds[0] || "",
        codex: {},
      },
    },
    metadata: {
      integration,
      sourceKind: "instruction-snippet",
      warnings: [...(parsed.warnings || [])],
    },
  };
}

function quote(value) {
  return JSON.stringify(String(value ?? ""));
}

function providerForBinding(config, binding, virtualProvider) {
  const route = config.routes?.[virtualProvider?.route];
  const backend = route?.backends?.find((item) => item.enabled !== false);
  return config.upstreams?.[backend?.upstream] || Object.values(config.upstreams || {})[0];
}

function localBaseUrl(virtualProvider) {
  const host = String(virtualProvider.listenHost || "127.0.0.1");
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${virtualProvider.listenPort}/v1`;
}

function profilePolicy(profile) {
  return {
    contextWindow: Number(profile?.contextWindow || 0) || null,
    compact: profile?.compact || null,
  };
}

export function buildCodexArtifacts(config, options = {}, secrets = {}) {
  let bindingId = options.bindingId;
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
  if (binding.target !== "codex") {
    throw new Error(`binding ${bindingId} 不是 Codex target`);
  }
  const defaultModel = binding.defaultModel || virtualProvider.defaultModel;
  const modelResolution = resolveModelProfile(config, virtualProvider, defaultModel);

  const upstream = providerForBinding(config, binding, virtualProvider);
  if (!upstream) throw new Error("找不到 binding 对应的 upstream");
  const providerId = codexProviderIdForBinding(binding);
  const clientModel =
    modelResolution.profile.clientModelId ||
    modelResolution.profile.aliases?.[0] ||
    modelResolution.profile.id;
  const policy = profilePolicy(modelResolution.profile);
  const activeContents = [
    `${ACTIVE_BEGIN} ${providerId} -->`,
    `model_provider = ${quote(providerId)}`,
    `model = ${quote(clientModel)}`,
    `${ACTIVE_END} ${providerId} <--`,
    "",
  ].join("\n");
  const providerContents = [
    `${ROOT_BEGIN} ${providerId} -->`,
    `[model_providers.${providerId}]`,
    `name = ${quote(`CableTidy / ${upstream.name || upstream.id}`)}`,
    `base_url = ${quote(localBaseUrl(virtualProvider))}`,
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
  const snapshot = await (options.loadCatalog || loadCodexCatalog)();
  const provider = config.virtualProviders[config.bindings[artifacts.bindingId].virtualProvider];
  artifacts.catalogPlan = planCodexCatalog(config, provider, snapshot);
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
  const rootValues = { model_provider: artifacts.providerId, model: artifacts.clientModelId };
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

function replaceManagedBlock(existing, begin, end, replacement, id = "") {
  const start = id ? `${begin} ${id} -->` : begin;
  const finish = id ? `${end} ${id} <--` : end;
  const pattern = new RegExp(
    `${escapeRegExp(start)}[^\\n]*\\n[\\s\\S]*?${escapeRegExp(finish)}[^\\n]*\\n?`,
    "m",
  );
  if (pattern.test(existing)) return existing.replace(pattern, replacement);
  return `${existing.trimEnd()}\n\n${replacement}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  if (artifacts.activeContents && artifacts.providerContents && artifacts.providerId) {
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
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const paths = options.paths || {
    backups: path.join(os.homedir(), ".cabletidy", "backups"),
  };
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.backups, { recursive: true, mode: 0o700 });
  const applied = [];

  const rootFile = path.join(codexHome, "config.toml");
  let existingRoot = "";
  try {
    existingRoot = await fs.readFile(rootFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const root = replaceManagedBlock(existingRoot, ROOT_BEGIN, ROOT_END, artifacts.files[0].contents);
  await writeArtifact(rootFile, `${root.trimEnd()}\n`, paths, "codex-config.toml");
  applied.push(rootFile);

  // Compatibility for callers that provide additional custom artifacts. The
  // CableTidy MVP renderer never emits these profile files.
  for (const artifact of artifacts.files.slice(1)) {
    const file = path.join(codexHome, safeRelativePath(artifact.path));
    let existing = "";
    try {
      existing = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let merged;
    if (artifact.profileContents && artifact.tuiContents && artifacts.providerId) {
      merged = replaceManagedBlock(
        existing,
        LEGACY_PROFILE_BEGIN,
        LEGACY_PROFILE_END,
        artifact.profileContents,
        artifacts.providerId,
      );
      merged = replaceManagedBlock(merged, LEGACY_TUI_BEGIN, LEGACY_TUI_END, artifact.tuiContents);
    } else {
      merged = replaceManagedBlock(
        existing,
        LEGACY_PROFILE_BEGIN,
        LEGACY_PROFILE_END,
        artifact.contents,
        artifacts.providerId || "",
      );
    }
    await writeArtifact(
      file,
      `${merged.trimEnd()}\n`,
      paths,
      `codex-${artifact.path.replaceAll("/", "-")}`,
    );
    applied.push(file);
  }

  return { applied, environment: artifacts.environment, mode: artifacts.mode };
}

export function publicArtifacts(artifacts) {
  const { catalogPlan, catalogState, rootBefore, codexHome, ...publicValues } = artifacts;
  return {
    ...publicValues,
    localSecret: undefined,
    environment: {
      ...artifacts.environment,
      value: undefined,
      shell: artifacts.environment?.shell || "",
    },
  };
}
