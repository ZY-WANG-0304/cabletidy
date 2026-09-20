export class ModelResolveError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ModelResolveError";
    this.code = code;
    this.details = details;
  }
}

export function findModelProfile(config, clientModelId, allowedModels) {
  if (!clientModelId) return null;
  const allowed = allowedModels?.length ? new Set(allowedModels) : null;
  if (config.models?.[clientModelId] && (!allowed || allowed.has(clientModelId))) {
    return { profileId: clientModelId, profile: config.models[clientModelId], matchedBy: "id" };
  }
  for (const [profileId, profile] of Object.entries(config.models || {})) {
    if (allowed && !allowed.has(profileId)) continue;
    if (
      profile.clientModelId === clientModelId ||
      (profile.aliases || []).includes(clientModelId)
    ) {
      return { profileId, profile, matchedBy: "alias" };
    }
  }
  return null;
}

export function clientModelIdForProfile(profileId, profile) {
  return profile?.clientModelId || profile?.aliases?.[0] || profileId;
}

export function listClientModels(config, virtualProvider) {
  const allowed = virtualProvider?.allowedModels?.length
    ? virtualProvider.allowedModels
    : Object.keys(config.models || {});
  return allowed
    .map((profileId) => {
      const profile = config.models?.[profileId];
      if (!profile) return null;
      return {
        id: clientModelIdForProfile(profileId, profile),
        profileId,
        aliases: profile.aliases || [],
        family: profile.family || "unknown",
        capabilities: profile.capabilities || [],
        object: "model",
        owned_by: "cabletidy",
      };
    })
    .filter(Boolean);
}

export function resolveModelProfile(config, virtualProvider, requestedModel) {
  const clientModelId =
    requestedModel ||
    virtualProvider?.defaultModel ||
    virtualProvider?.allowedModels?.[0] ||
    null;
  if (!clientModelId) {
    throw new ModelResolveError("model_required", "请求没有模型，Virtual Provider 也没有默认模型");
  }

  const match = findModelProfile(config, clientModelId, virtualProvider?.allowedModels);
  if (!match) {
    throw new ModelResolveError("unknown_model", `未知模型: ${clientModelId}`, {
      clientModelId,
    });
  }

  if (
    virtualProvider?.allowedModels?.length &&
    !virtualProvider.allowedModels.includes(match.profileId)
  ) {
    throw new ModelResolveError("model_not_allowed", `Virtual Provider 不允许模型: ${clientModelId}`, {
      clientModelId,
      profileId: match.profileId,
    });
  }

  return {
    clientModelId,
    profileId: match.profileId,
    profile: match.profile,
    matchedBy: match.matchedBy,
  };
}

export function effectiveCapabilities(profile, binding) {
  const capabilities = new Set(profile?.capabilities || []);
  for (const item of binding?.capabilityOverrides || []) {
    if (item.startsWith("-")) capabilities.delete(item.slice(1));
    else if (item.startsWith("+")) capabilities.add(item.slice(1));
    else capabilities.add(item);
  }
  if (profile.codex?.metadataMode === "override" &&
      profile.codex.inputModalities && !profile.codex.inputModalities.includes("image")) {
    capabilities.delete("vision");
  }
  return capabilities;
}

function requiredCapabilities(request = {}) {
  const required = new Set();
  if (request.stream) required.add("streaming");
  if (Array.isArray(request.tools) && request.tools.length) required.add("tools");
  if (request.tool_choice) required.add("tools");
  if (request.parallel_tool_calls) required.add("parallel_tool_calls");
  if (request.reasoning) required.add("reasoning");
  if (request.thinking && request.thinking.type !== "disabled") required.add("reasoning");
  if (request.images || request.image_input || containsImage(request.input) || containsImage(request.messages)) required.add("vision");
  return required;
}

function containsImage(value) {
  if (Array.isArray(value)) return value.some(containsImage);
  if (!value || typeof value !== "object") return false;
  if (["input_image", "image", "image_url"].includes(value.type)) return true;
  return containsImage(value.content);
}

function hasCapabilities(capabilities, required) {
  return [...required].every((item) => capabilities.has(item));
}

export function selectBackend(config, virtualProvider, modelResolution, request = {}) {
  const route = config.routes?.[virtualProvider.route];
  if (!route) {
    throw new ModelResolveError("route_not_found", `Route 不存在: ${virtualProvider.route}`);
  }
  if (!Array.isArray(route.backends) || route.backends.length !== 1) {
    throw new ModelResolveError("invalid_route", "每份配置必须且只能连接一个 upstream");
  }

  const backend = route.backends[0];
  const upstream = config.upstreams?.[backend?.upstream];
  const modelBindings = modelResolution.profile.upstreams || {};
  if (Object.keys(modelBindings).length > 1) {
    throw new ModelResolveError("invalid_model_binding", "每个 Model Profile 只能映射一个 upstream");
  }
  const modelBinding = modelBindings[backend?.upstream];
  const required = requiredCapabilities(request);
  const capabilities = effectiveCapabilities(modelResolution.profile, modelBinding);
  let reason;
  if (!backend || backend.enabled === false || !upstream || upstream.enabled === false) {
    reason = "upstream_disabled_or_missing";
  } else if (backend.models?.length && !backend.models.includes(modelResolution.profileId)) {
    reason = "model_not_in_route";
  } else if (!modelBinding?.upstreamModelId) {
    reason = "model_binding_missing";
  } else if (virtualProvider.ingressProtocol !== upstream.protocol) {
    reason = "protocol_transform_missing";
  } else if (!hasCapabilities(capabilities, required)) {
    reason = "capability_missing";
  }
  if (reason) {
    throw new ModelResolveError(
      "no_compatible_upstream",
      `当前配置的 upstream 无法处理模型 ${modelResolution.clientModelId}`,
      {
        profileId: modelResolution.profileId,
        rejected: [{ index: 0, reason, ...(reason === "capability_missing"
          ? { missing: [...required].filter((item) => !capabilities.has(item)) } : {}) }],
      },
    );
  }
  return {
    routeId: virtualProvider.route,
    backend,
    backendIndex: 0,
    upstream,
    upstreamModelId: modelBinding.upstreamModelId,
    capabilities: [...capabilities],
    rejected: [],
  };
}

export function resolveRequest(config, virtualProvider, requestBody = {}) {
  const model = resolveModelProfile(config, virtualProvider, requestBody.model);
  const backend = selectBackend(config, virtualProvider, model, requestBody);
  return { model, ...backend };
}

export function rewriteModelFields(value, clientModelId, upstreamModelId) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteModelFields(item, clientModelId, upstreamModelId));
  }
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "model" && item === upstreamModelId) {
      output[key] = clientModelId;
    } else {
      output[key] = rewriteModelFields(item, clientModelId, upstreamModelId);
    }
  }
  return output;
}
