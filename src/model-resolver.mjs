export class ModelResolveError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ModelResolveError";
    this.code = code;
    this.details = details;
  }
}

export function getModelProfile(config, modelId) {
  return config.models?.[modelId] || null;
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

function transformAllowed(virtualProvider, upstream, backend) {
  // MVP keeps the data plane same-protocol; explicit transform adapters come later.
  return virtualProvider.ingressProtocol === upstream.protocol;
}

export function selectBackend(config, virtualProvider, modelResolution, request = {}, options = {}) {
  const route = config.routes?.[virtualProvider.route];
  if (!route) {
    throw new ModelResolveError("route_not_found", `Route 不存在: ${virtualProvider.route}`);
  }

  const required = requiredCapabilities(request);
  const candidates = (route.backends || [])
    .map((backend, index) => ({ backend, index }))
    .filter(({ backend }) => backend.enabled !== false)
    .filter(({ backend }) => !options.skipUpstreams?.has(backend.upstream))
    .filter(({ backend }) => !backend.models?.length || backend.models.includes(modelResolution.profileId))
    .sort((a, b) => {
      const priorityA = Number.isFinite(a.backend.priority) ? a.backend.priority : 100;
      const priorityB = Number.isFinite(b.backend.priority) ? b.backend.priority : 100;
      return priorityA - priorityB || a.index - b.index;
    });

  const rejected = [];
  for (const { backend, index } of candidates) {
    const upstream = config.upstreams?.[backend.upstream];
    if (!upstream || upstream.enabled === false) {
      rejected.push({ index, reason: "upstream_disabled_or_missing" });
      continue;
    }
    const modelBinding = modelResolution.profile.upstreams?.[backend.upstream];
    if (!modelBinding?.upstreamModelId) {
      rejected.push({ index, reason: "model_binding_missing" });
      continue;
    }
    if (!transformAllowed(virtualProvider, upstream, backend)) {
      rejected.push({ index, reason: "protocol_transform_missing" });
      continue;
    }
    const capabilities = effectiveCapabilities(modelResolution.profile, modelBinding);
    if (!hasCapabilities(capabilities, required)) {
      rejected.push({
        index,
        reason: "capability_missing",
        missing: [...required].filter((item) => !capabilities.has(item)),
      });
      continue;
    }
    return {
      routeId: virtualProvider.route,
      backend,
      backendIndex: index,
      upstream,
      upstreamModelId: modelBinding.upstreamModelId,
      capabilities: [...capabilities],
      rejected,
    };
  }

  throw new ModelResolveError(
    "no_compatible_upstream",
    `没有可用于模型 ${modelResolution.clientModelId} 的 upstream`,
    { profileId: modelResolution.profileId, rejected },
  );
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
