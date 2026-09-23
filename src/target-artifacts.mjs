import {
  buildCodexArtifacts,
  prepareCodexArtifacts,
  publicArtifacts as publicCodexArtifacts,
} from "./codex-native-provider.mjs";
import { clientModelIdForProfile, resolveModelProfile } from "./model-resolver.mjs";
import { normalizeConfig } from "./config.mjs";
import { configurationId, providerIdForConfiguration, configurationBaseUrl } from "../web/config-identity.js";
import { prepareClaudeSettings } from "./claude-config-file.mjs";

export const CLAUDE_TARGET_FORMAT = "claude.settings.json.v1";
export const CLAUDE_ENDPOINTS = [
  { method: "POST", path: "/v1/messages", purpose: "messages", required: true },
  { method: "POST", path: "/v1/messages/count_tokens", purpose: "token_counting", required: false },
  { method: "GET", path: "/v1/models", purpose: "model_discovery", required: false },
  { method: "HEAD", path: "/api/hello", purpose: "connection_probe", required: false },
];

export async function prepareTargetArtifacts(config, options = {}, secrets = {}) {
  const requested = findBinding(config, options.bindingId);
  config = normalizeConfig(config);
  const binding = requested && findBinding(config, configurationId(requested.name, requested.id));
  if (!binding) throw new Error("找不到 Target binding");
  if (binding.target === "codex") {
    return prepareCodexArtifacts(config, { ...options, bindingId: binding.id }, secrets);
  }
  if (binding.target === "claude-code") {
    return prepareClaudeSettings(buildClaudeArtifacts(config, binding), options);
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
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_CUSTOM_HEADERS: "",
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_CODE_USE_FOUNDRY: "0",
    CLAUDE_CODE_USE_ANTHROPIC_AWS: "0",
    CLAUDE_CODE_USE_MANTLE: "0",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: binding.claude?.discoverModels ? "1" : "0",
    ...(binding.claude?.setModel === false || !clientModel ? {} : { ANTHROPIC_MODEL: clientModel }),
  };
  for (const family of ["opus", "sonnet", "fable", "haiku"]) {
    const model = binding.claude?.models?.[family];
    if (model) vars[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`] = model;
  }
  if (binding.claude?.models?.subagent) vars.CLAUDE_CODE_SUBAGENT_MODEL = binding.claude.models.subagent;
  const contents = `${JSON.stringify({ env: vars }, null, 2)}\n`;

  return {
    format: CLAUDE_TARGET_FORMAT,
    target: "claude-code",
    mode: "managed_proxy",
    bindingId: binding.id,
    virtualProviderId: virtualProvider.id,
    clientModelId: clientModel,
    files: [{ path: "cabletidy-claude.settings.json", kind: "json", contents }],
    requiredEndpoints: CLAUDE_ENDPOINTS,
    environment: {
      vars,
      shell: shellExports(vars),
      powershell: Object.entries(vars).map(([key, value]) => `$env:${key} = '${String(value).replaceAll("'", "''")}'`).join("\n"),
    },
    instructions: [
      "应用时只合并到用户 settings.json 的 env，保留其他设置；原值保存以便撤销接入。",
      "预览文件也可另存为独立文件，通过 claude --settings cabletidy-claude.settings.json 临时接入。",
      "本地入口无需 Key；cabletidy-local 仅满足客户端认证检查，真实凭据只由 CableTidy 发给上游。",
      `ANTHROPIC_BASE_URL 指向本地 Virtual Provider: ${baseUrl}`,
      clientModel ? `Claude 客户端模型名: ${clientModel}` : "模型由 Claude Code 选择，默认透传请求中的模型名。",
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
    ...(clientModel ? { [`${keyPrefix}_MODEL`]: clientModel } : {}),
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
  if (!requested) return { profileId: null, profile: null, clientModelId: null };
  const resolved = resolveModelProfile(config, virtualProvider, requested);
  return {
    profileId: resolved.profileId,
    profile: resolved.profile,
    clientModelId: resolved.profile
      ? clientModelIdForProfile(resolved.profileId, resolved.profile)
      : resolved.clientModelId,
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
    vars: environment.vars || {},
    shell: environment.shell || "",
    ...(environment.powershell ? { powershell: environment.powershell } : {}),
  };
}
