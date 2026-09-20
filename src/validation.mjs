import { normalizeConfig } from "./config.mjs";
import { findModelProfile } from "./model-resolver.mjs";
import { configurationId, providerIdForConfiguration } from "../web/config-identity.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PROTOCOLS = new Set([
  "openai.responses",
  "openai.chat_completions",
  "anthropic.messages",
  "gemini.generate_content",
]);
const INTEGRATIONS = new Set(["codex-native-provider"]);
const TARGET_FORMATS = new Set(["codex.config.toml.v1", "claude.env.v1", "generic.env.v1"]);
const TARGETS = new Set(["codex", "claude-code", "generic-env"]);
const ROUTE_STRATEGIES = new Set(["priority"]);
const COMPACT_STRATEGIES = new Set(["auto", "manual", "disabled"]);
const IMPLEMENTED_INGRESS_PROTOCOLS = new Set([
  "openai.responses",
  "anthropic.messages",
]);

function add(errors, path, message) {
  errors.push({ path, message });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isInteger(value) {
  return isNumber(value) && Number.isInteger(value);
}

function canonicalHost(value) {
  const host = String(value || "").trim().toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return "loopback";
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return "*";
  if (host === "127.0.0.1") return "loopback";
  return host;
}

export function validateConfig(input) {
  const config = normalizeConfig(input);
  const errors = [];
  const warnings = [];

  if (config.version !== 1) add(errors, "version", "当前 MVP 只支持 version = 1");
  if (!isInteger(config.web.port) || config.web.port < 1 || config.web.port > 65535) {
    add(errors, "web.port", "Web 端口必须是 1 到 65535 之间的整数");
  }
  if (!config.web.listenHost) add(errors, "web.listenHost", "Web listenHost 不能为空");
  else if (!isLoopback(config.web.listenHost)) {
    add(
      errors,
      "web.listenHost",
      "Web 管理台必须监听 127.0.0.1、localhost 或 ::1；本地管理台不支持远程监听",
    );
  }

  for (const [id, rawUpstream] of Object.entries(config.upstreams)) {
    const upstream = isRecord(rawUpstream) ? rawUpstream : {};
    if (!isRecord(rawUpstream)) add(errors, `upstreams.${id}`, "upstream 必须是 object");
    if (!hasId(id)) add(errors, `upstreams.${id}`, "upstream ID 包含非法字符");
    if (!upstream.baseUrl || !isUrl(upstream.baseUrl)) {
      add(errors, `upstreams.${id}.baseUrl`, "必须是 http 或 https URL");
    }
    if (!PROTOCOLS.has(upstream.protocol)) {
      add(errors, `upstreams.${id}.protocol`, `不支持的协议: ${upstream.protocol || "(empty)"}`);
    }
    if (upstream.integration && !INTEGRATIONS.has(upstream.integration)) {
      add(errors, `upstreams.${id}.integration`, "未注册的上游接入方式");
    }
    const envKey = upstream.envKey || upstream.codexNative?.envKey;
    if (envKey && !ENV_PATTERN.test(envKey)) {
      add(errors, `upstreams.${id}.envKey`, "env_key 必须是大写环境变量名");
    }
    const authHeader = upstream.auth?.header || upstream.authHeader;
    if (authHeader && !HEADER_PATTERN.test(authHeader)) {
      add(errors, `upstreams.${id}.auth.header`, "认证 header 名称不合法");
    }
    for (const field of ["requestMaxRetries", "streamMaxRetries", "streamIdleTimeoutMs"]) {
      if (upstream[field] !== undefined && !isInteger(upstream[field])) {
        add(errors, `upstreams.${id}.${field}`, "必须是非负整数");
      }
    }
  }

  for (const [id, rawModel] of Object.entries(config.models)) {
    const model = isRecord(rawModel) ? rawModel : {};
    if (!isRecord(rawModel)) add(errors, `models.${id}`, "Model Profile 必须是 object");
    if (!hasId(id)) add(errors, `models.${id}`, "Model Profile ID 包含非法字符");
    if (!Array.isArray(model.aliases)) {
      add(errors, `models.${id}.aliases`, "aliases 必须是数组");
    }
    if (
      model.clientModelId !== undefined &&
      (typeof model.clientModelId !== "string" || !model.clientModelId.trim())
    ) {
      add(errors, `models.${id}.clientModelId`, "clientModelId 必须是非空字符串");
    }
    if (model.capabilities !== undefined && !Array.isArray(model.capabilities)) {
      add(errors, `models.${id}.capabilities`, "capabilities 必须是数组");
    }
    if (
      Array.isArray(model.capabilities) &&
      model.capabilities.some((item) => typeof item !== "string" || !item.trim())
    ) {
      add(errors, `models.${id}.capabilities`, "capabilities 必须是非空字符串数组");
    }
    if (
      model.contextWindow !== undefined &&
      (!isInteger(model.contextWindow) || model.contextWindow < 1)
    ) {
      add(errors, `models.${id}.contextWindow`, "contextWindow 必须是正整数");
    }
    if (model.codex !== undefined) {
      if (!isRecord(model.codex) || !["official", "override"].includes(model.codex.metadataMode)) {
        add(errors, `models.${id}.codex`, "Codex metadataMode 必须为 official 或 override");
      } else if (model.codex.inputModalities !== undefined &&
          (!Array.isArray(model.codex.inputModalities) || !model.codex.inputModalities.includes("text") ||
           model.codex.inputModalities.some((item) => !["text", "image"].includes(item)))) {
        add(errors, `models.${id}.codex.inputModalities`, "输入类型必须包含 text，且只能包含 text 或 image");
      }
    }
    if (
      model.compact !== undefined &&
      (!isRecord(model.compact) ||
        (model.compact.tokenLimit !== undefined &&
          (!isInteger(model.compact.tokenLimit) || model.compact.tokenLimit < 1)))
    ) {
      add(errors, `models.${id}.compact`, "compact 必须包含合法的 tokenLimit");
    }
    if (
      isRecord(model.compact) &&
      model.compact.strategy !== undefined &&
      !COMPACT_STRATEGIES.has(model.compact.strategy)
    ) {
      add(errors, `models.${id}.compact.strategy`, "不支持的 compact strategy");
    }
    if (
      model.capabilityOverrides !== undefined &&
      (!Array.isArray(model.capabilityOverrides) ||
        model.capabilityOverrides.some((item) => typeof item !== "string" || !item.trim()))
    ) {
      add(errors, `models.${id}.capabilityOverrides`, "capabilityOverrides 必须是非空字符串数组");
    }
    const aliases = new Set([
      id,
      ...(model.clientModelId ? [model.clientModelId] : []),
      ...(Array.isArray(model.aliases) ? model.aliases : []),
    ]);
    for (const alias of aliases) {
      if (typeof alias !== "string" || !alias.trim()) {
        add(errors, `models.${id}.aliases`, "模型 alias 不能为空");
        continue;
      }
    }
    if (!isRecord(model.upstreams)) {
      add(errors, `models.${id}.upstreams`, "必须提供唯一的 upstream 模型映射");
    }
    if (isRecord(model.upstreams)) {
      if (Object.keys(model.upstreams).length !== 1) {
        add(errors, `models.${id}.upstreams`, "每个 Model Profile 必须且只能映射一个 upstream");
      }
      for (const [upstreamId, binding] of Object.entries(model.upstreams)) {
        if (!config.upstreams[upstreamId]) {
          add(errors, `models.${id}.upstreams.${upstreamId}`, "引用的 upstream 不存在");
        }
        if (!binding?.upstreamModelId) {
          add(errors, `models.${id}.upstreams.${upstreamId}.upstreamModelId`, "不能为空");
        }
        if (
          binding?.capabilityOverrides !== undefined &&
          (!Array.isArray(binding.capabilityOverrides) ||
            binding.capabilityOverrides.some(
              (item) => typeof item !== "string" || !item.trim(),
            ))
        ) {
          add(
            errors,
            `models.${id}.upstreams.${upstreamId}.capabilityOverrides`,
            "capabilityOverrides 必须是非空字符串数组",
          );
        }
      }
    }
  }

  for (const [id, rawRoute] of Object.entries(config.routes)) {
    const route = isRecord(rawRoute) ? rawRoute : {};
    if (!isRecord(rawRoute)) add(errors, `routes.${id}`, "route 必须是 object");
    if (!hasId(id)) add(errors, `routes.${id}`, "route ID 包含非法字符");
    if (route.strategy && !ROUTE_STRATEGIES.has(route.strategy)) {
      add(errors, `routes.${id}.strategy`, `不支持的 route strategy: ${route.strategy}`);
    }
    if (!Array.isArray(route.backends) || route.backends.length === 0) {
      add(errors, `routes.${id}.backends`, "每份配置必须且只能连接一个 upstream（一个 backend）");
      continue;
    }
    if (route.backends.length !== 1) {
      add(errors, `routes.${id}.backends`, "每份配置必须且只能连接一个 upstream（一个 backend）");
    }
    for (const [index, rawBackend] of route.backends.entries()) {
      const backend = isRecord(rawBackend) ? rawBackend : {};
      const base = `routes.${id}.backends.${index}`;
      if (!isRecord(rawBackend)) add(errors, base, "backend 必须是 object");
      if (!config.upstreams[backend.upstream]) add(errors, `${base}.upstream`, "upstream 不存在");
      if (!Array.isArray(backend.models) || backend.models.length === 0) {
        add(errors, `${base}.models`, "backend 至少需要绑定一个 Model Profile");
      }
      for (const modelId of backend.models || []) {
        if (typeof modelId !== "string" || !modelId.trim()) {
          add(errors, `${base}.models`, "模型 ID 必须是非空字符串");
          continue;
        }
        if (!config.models[modelId]) add(errors, `${base}.models`, `模型不存在: ${modelId}`);
        if (config.models[modelId] && !config.models[modelId].upstreams?.[backend.upstream]) {
          add(
            errors,
            `${base}.models`,
            `Model Profile ${modelId} 没有 upstream ${backend.upstream} 的模型映射`,
          );
        }
      }
      if (backend.priority !== undefined && !isInteger(backend.priority)) {
        add(errors, `${base}.priority`, "priority 必须是非负整数");
      }
      if (backend.weight !== undefined && !isNumber(backend.weight)) {
        add(errors, `${base}.weight`, "weight 必须是非负数字");
      }
    }
  }

  for (const [id, rawProvider] of Object.entries(config.virtualProviders)) {
    const provider = isRecord(rawProvider) ? rawProvider : {};
    if (!isRecord(rawProvider)) add(errors, `virtualProviders.${id}`, "Virtual Provider 必须是 object");
    if (!hasId(id)) add(errors, `virtualProviders.${id}`, "Virtual Provider ID 包含非法字符");
    if (!id.startsWith("cabletidy_")) {
      add(errors, `virtualProviders.${id}.id`, "Virtual Provider ID 应为 cabletidy_<配置ID>，请检查名称或 ID 冲突");
    }
    if (id === providerIdForConfiguration("api")) {
      add(errors, `virtualProviders.${id}.id`, "配置 ID api 是管理接口保留路径，请使用其他配置名称");
    }
    if (!PROTOCOLS.has(provider.ingressProtocol)) {
      add(errors, `virtualProviders.${id}.ingressProtocol`, "未注册的 ingress protocol");
    } else if (!IMPLEMENTED_INGRESS_PROTOCOLS.has(provider.ingressProtocol)) {
      warnings.push({
        path: `virtualProviders.${id}.ingressProtocol`,
        message: `当前数据面尚未实现 ${provider.ingressProtocol}，请求会返回 501`,
      });
    }
    if (!config.routes[provider.route]) add(errors, `virtualProviders.${id}.route`, "route 不存在");
    if (!Array.isArray(provider.allowedModels) || provider.allowedModels.length === 0) {
      add(errors, `virtualProviders.${id}.allowedModels`, "至少需要一个 allowed model");
    } else {
      const aliasOwners = new Map();
      for (const modelId of provider.allowedModels) {
        if (typeof modelId !== "string" || !modelId.trim()) {
          add(errors, `virtualProviders.${id}.allowedModels`, "模型 ID 必须是非空字符串");
          continue;
        }
        if (!config.models[modelId]) add(errors, `virtualProviders.${id}.allowedModels`, `模型不存在: ${modelId}`);
        const model = config.models[modelId];
        if (model) {
          const backend = config.routes[provider.route]?.backends?.[0];
          if (backend && (!backend.models?.includes(modelId) || !model.upstreams?.[backend.upstream])) {
            add(errors, `virtualProviders.${id}.allowedModels`, `模型 ${modelId} 必须映射到当前配置的 upstream ${backend.upstream}`);
          }
          for (const alias of new Set([modelId, model.clientModelId, ...(Array.isArray(model.aliases) ? model.aliases : [])].filter(Boolean))) {
            const owner = aliasOwners.get(alias);
            if (owner && owner !== modelId) add(errors, `virtualProviders.${id}.allowedModels`, `模型名或 alias "${alias}" 在当前 Virtual Provider 内重复`);
            aliasOwners.set(alias, modelId);
          }
        }
      }
    }
    if (provider.defaultModel) {
      const match = findModelProfile(config, provider.defaultModel, provider.allowedModels);
      if (!match) {
        add(errors, `virtualProviders.${id}.defaultModel`, "defaultModel 对应的模型不存在");
      } else if (
        provider.allowedModels?.length &&
        !provider.allowedModels.includes(match.profileId)
      ) {
        add(errors, `virtualProviders.${id}.defaultModel`, "defaultModel 必须属于 allowedModels");
      }
    }
  }

  const configurationNames = new Map();
  const providerOwners = new Map();
  for (const [id, rawBinding] of Object.entries(config.bindings)) {
    const binding = isRecord(rawBinding) ? rawBinding : {};
    if (!isRecord(rawBinding)) add(errors, `bindings.${id}`, "Binding 必须是 object");
    if (!hasId(id)) add(errors, `bindings.${id}`, "Binding ID 包含非法字符");
    const nameId = configurationId(binding.name, id);
    if (nameId === "api") add(errors, `bindings.${id}.name`, "配置 ID api 是管理接口保留路径，请使用其他配置名称");
    if (configurationNames.has(nameId)) {
      add(errors, `bindings.${id}.name`, `配置名称规范化后与 ${configurationNames.get(nameId)} 重复: ${nameId}`);
    }
    configurationNames.set(nameId, id);
    if (id !== nameId) add(errors, `bindings.${id}.id`, `配置 ID 应为 ${nameId}，请检查名称或 ID 冲突`);
    if (binding.virtualProvider) {
      if (providerOwners.has(binding.virtualProvider)) {
        add(errors, `bindings.${id}.virtualProvider`, `Virtual Provider 已被配置 ${providerOwners.get(binding.virtualProvider)} 使用；配置与 Virtual Provider 必须一对一`);
      }
      providerOwners.set(binding.virtualProvider, id);
      if (binding.virtualProvider !== providerIdForConfiguration(id)) {
        add(errors, `bindings.${id}.virtualProvider`, `Virtual Provider ID 应为 ${providerIdForConfiguration(id)}`);
      }
    }
    if (!TARGETS.has(binding.target)) {
      add(errors, `bindings.${id}.target`, `不支持的 target: ${binding.target || "(empty)"}`);
    }
    if (!config.virtualProviders[binding.virtualProvider]) {
      add(errors, `bindings.${id}.virtualProvider`, "Virtual Provider 不存在");
    } else {
      const virtualProvider = config.virtualProviders[binding.virtualProvider];
      if (
        binding.target === "codex" &&
        virtualProvider.ingressProtocol !== "openai.responses"
      ) {
        add(
          errors,
          `bindings.${id}.virtualProvider`,
          "Codex binding 必须连接 openai.responses Virtual Provider",
        );
      }
      if (
        binding.target === "claude-code" &&
        virtualProvider.ingressProtocol !== "anthropic.messages"
      ) {
        add(
          errors,
          `bindings.${id}.virtualProvider`,
          "Claude Code binding 必须连接 anthropic.messages Virtual Provider",
        );
      }
    }
    let bindingProfileId;
    if (binding.defaultModel) {
      const match = findModelProfile(config, binding.defaultModel, config.virtualProviders[binding.virtualProvider]?.allowedModels);
      if (!match) {
        add(errors, `bindings.${id}.defaultModel`, "defaultModel 对应的模型不存在");
      } else {
        bindingProfileId = match.profileId;
      }
    }
    const boundVirtualProvider = config.virtualProviders[binding.virtualProvider];
    if (
      bindingProfileId &&
      boundVirtualProvider?.allowedModels?.length &&
      !boundVirtualProvider.allowedModels.includes(bindingProfileId)
    ) {
      add(
        errors,
        `bindings.${id}.defaultModel`,
        "binding defaultModel 必须属于其 Virtual Provider 的 allowedModels",
      );
    }
    if (binding.integration && !INTEGRATIONS.has(binding.integration)) {
      add(errors, `bindings.${id}.integration`, "未注册的上游接入方式");
    }
    if (binding.targetFormat && !TARGET_FORMATS.has(binding.targetFormat)) {
      add(errors, `bindings.${id}.targetFormat`, "未注册的 target format");
    }
    if (
      binding.target === "codex" &&
      binding.targetFormat &&
      binding.targetFormat !== "codex.config.toml.v1"
    ) {
      add(errors, `bindings.${id}.targetFormat`, "Codex binding 必须使用本地 config.toml 接入");
    }
    if (binding.target === "claude-code" && binding.targetFormat && binding.targetFormat !== "claude.env.v1") {
      add(errors, `bindings.${id}.targetFormat`, "Claude Code binding 必须使用 claude.env.v1");
    }
    if (
      binding.target === "generic-env" &&
      binding.env?.prefix &&
      !ENV_PATTERN.test(binding.env.prefix)
    ) {
      add(errors, `bindings.${id}.env.prefix`, "generic env prefix 必须是大写环境变量名");
    }
  }

  if (Object.keys(config.upstreams).length === 0) {
    warnings.push({ path: "upstreams", message: "还没有配置 upstream" });
  }
  if (Object.keys(config.models).length === 0) {
    warnings.push({ path: "models", message: "还没有配置 Model Profile" });
  }
  if (Object.keys(config.virtualProviders).length === 0) {
    warnings.push({ path: "virtualProviders", message: "还没有配置本地 Virtual Provider" });
  }

  return { ok: errors.length === 0, errors, warnings, config };
}

function isLoopback(host) {
  const canonical = canonicalHost(host);
  return canonical === "loopback";
}

function isUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
