import {
  buildCodexArtifacts,
  prepareCodexArtifacts,
  publicArtifacts as publicCodexArtifacts,
} from "./codex-native-provider.mjs";
import { clientModelIdForProfile, resolveModelProfile } from "./model-resolver.mjs";
import { normalizeConfig } from "./config.mjs";
import { configurationId, providerIdForConfiguration, configurationBaseUrl } from "../web/config-identity.js";

export async function prepareTargetArtifacts(config, options = {}, secrets = {}) {
  const requested = findBinding(config, options.bindingId);
  config = normalizeConfig(config);
  const binding = requested && findBinding(config, configurationId(requested.name, requested.id));
  if (!binding) throw new Error("找不到 Target binding");
  if (binding.target === "codex") {
    return prepareCodexArtifacts(config, { ...options, bindingId: binding.id }, secrets);
  }
  return buildTargetArtifacts(config, { ...options, bindingId: binding.id }, secrets);
}

export function buildTargetArtifacts(config, options = {}, secrets = {}) {
  const requested = findBinding(config, options.bindingId);
  config = normalizeConfig(config);
  const binding = requested && findBinding(config, configurationId(requested.name, requested.id));
  if (!binding) throw new Error("找不到 Target binding");

  if (binding.target === "codex") {
    return buildCodexArtifacts(
      config,
      { bindingId: binding.id },
      secrets,
    );
  }
  if (binding.target === "claude-code") {
    return buildClaudeArtifacts(config, binding);
  }
  if (binding.target === "generic-env") {
    return buildGenericEnvArtifacts(config, binding);
  }
  throw new Error(`不支持的 target: ${binding.target}`);
}

export function publicTargetArtifacts(artifacts) {
  if (artifacts?.target === "codex") return publicCodexArtifacts(artifacts);
  return {
    ...artifacts,
    localSecret: undefined,
    environment: publicEnvironment(artifacts.environment),
  };
}

function findBinding(config, bindingId) {
  const entry = bindingId && Object.hasOwn(config.bindings || {}, bindingId)
    ? [bindingId, config.bindings[bindingId]]
    : Object.entries(config.bindings || {}).find(
      ([id, item]) => item?.enabled !== false && (!bindingId || id === bindingId || item?.id === bindingId),
    );
  if (!entry?.[1]) return null;
  const [id, binding] = entry;
  const nameId = configurationId(binding.name, id);
  if (Object.entries(config.bindings).filter(([id, item]) =>
    configurationId(item?.name, id) === nameId).length > 1) {
    throw new Error(`配置名称规范化后重复: ${nameId}`);
  }
  return { ...binding, id };
}

function buildClaudeArtifacts(config, binding) {
  const virtualProvider = getVirtualProvider(config, binding);
  if (virtualProvider.ingressProtocol !== "anthropic.messages") {
    throw new Error("Claude Code binding 必须连接 anthropic.messages Virtual Provider");
  }
  const { profile, clientModelId: clientModel } = defaultProfile(
    config,
    binding,
    virtualProvider,
  );
  const baseUrl = configurationBaseUrl(config, binding.id);
  const vars = {
    ANTHROPIC_BASE_URL: baseUrl,
    // Satisfy Claude Code's client-side credential check; the local service
    // ignores this public placeholder and authenticates only to the upstream.
    ANTHROPIC_AUTH_TOKEN: "cabletidy-local",
    ...(binding.claude?.setModel === false ? {} : { ANTHROPIC_MODEL: clientModel }),
  };

  return {
    format: "claude.env.v1",
    target: "claude-code",
    mode: "managed_proxy",
    bindingId: binding.id,
    virtualProviderId: virtualProvider.id,
    clientModelId: clientModel,
    files: [],
    environment: {
      vars,
      shell: shellExports(vars),
    },
    instructions: [
      "将以下环境变量注入 Claude Code 进程即可，不需要修改上游 provider 配置。",
      `ANTHROPIC_BASE_URL 指向本地 Virtual Provider: ${baseUrl}`,
      `Claude 客户端模型名: ${clientModel}`,
    ],
  };
}

function buildGenericEnvArtifacts(config, binding) {
  const virtualProvider = getVirtualProvider(config, binding);
  const { profile, clientModelId: clientModel } = defaultProfile(
    config,
    binding,
    virtualProvider,
  );
  const baseUrl = configurationBaseUrl(config, binding.id);
  const keyPrefix = binding.env?.prefix || "CABLETIDY";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(keyPrefix)) {
    throw new Error(`generic env prefix 不合法: ${keyPrefix}`);
  }
  const vars = {
    [`${keyPrefix}_BASE_URL`]: baseUrl,
    [`${keyPrefix}_MODEL`]: clientModel,
  };
  return {
    format: "generic.env.v1",
    target: "generic-env",
    mode: "managed_proxy",
    bindingId: binding.id,
    virtualProviderId: virtualProvider.id,
    clientModelId: clientModel,
    files: [],
    environment: {
      vars,
      shell: shellExports(vars),
    },
  };
}

function getVirtualProvider(config, binding) {
  const virtualProvider = config.virtualProviders?.[binding.virtualProvider];
  if (!virtualProvider) {
    throw new Error("Binding 引用的 Virtual Provider 不存在");
  }
  if (virtualProvider.id !== providerIdForConfiguration(binding.id) ||
      Object.values(config.bindings).filter((item) => item?.virtualProvider === virtualProvider.id).length !== 1) {
    throw new Error("配置与 Virtual Provider 必须一对一，Virtual Provider ID 必须为 cabletidy_<配置ID>");
  }
  return virtualProvider;
}

function defaultProfile(config, binding, virtualProvider) {
  const requested = binding.defaultModel || virtualProvider.defaultModel;
  const resolved = resolveModelProfile(config, virtualProvider, requested);
  return {
    profileId: resolved.profileId,
    profile: resolved.profile,
    clientModelId: clientModelIdForProfile(resolved.profileId, resolved.profile),
  };
}

function shellExports(vars) {
  return Object.entries(vars)
    .map(([key, value]) => `export ${key}=${quoteShell(value)}`)
    .join("\n");
}

function quoteShell(value) {
  return `'${String(value ?? "").replaceAll("'", "'\\''")}'`;
}

function publicEnvironment(environment = {}) {
  return {
    ...environment,
    value: undefined,
    vars: environment.vars || {},
    shell: environment.shell || "",
  };
}
