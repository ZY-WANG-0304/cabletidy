export function configurationId(name, fallback = "codex") {
  const normalize = (value) => String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 54)
    .replace(/-+$/, "");
  return normalize(name) || normalize(fallback) || "codex";
}

export function providerIdForConfiguration(id) {
  return `cabletidy_${id}`;
}

export function configurationBaseUrl(config, id) {
  const host = String(config.web?.listenHost || "127.0.0.1");
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${address}:${config.web?.port || 43100}/${encodeURIComponent(id)}`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeConfigurationIdentities(config) {
  const bindings = Object.entries(config.bindings);
  const bindingIds = new Map(bindings.map(([id, binding]) => [
    id, isRecord(binding) ? configurationId(binding.name, id) : id,
  ]));
  const providerIds = new Map(Object.entries(config.virtualProviders).map(([id, provider]) => {
    if (!isRecord(provider)) return [id, id];
    const owners = bindings.filter(([, binding]) => binding?.virtualProvider === id);
    if (owners.length > 1) return [id, id];
    const owner = owners[0];
    const suffix = id.startsWith("cabletidy_") ? id.slice("cabletidy_".length) : id;
    return [id, providerIdForConfiguration(owner ? bindingIds.get(owner[0]) : configurationId(suffix))];
  }));

  // Leave colliding records intact so validation can report them without
  // losing either configuration or retargeting a reference to another one.
  const uniqueRenames = (ids) => {
    const counts = new Map();
    for (const id of ids.values()) counts.set(id, (counts.get(id) || 0) + 1);
    const result = new Map([...ids].map(([oldId, id]) => [oldId, counts.get(id) === 1 ? id : oldId]));
    let changed;
    do {
      changed = false;
      for (const [oldId, id] of result) {
        if (id !== oldId && result.has(id) && result.get(id) === id) {
          result.set(oldId, oldId);
          changed = true;
        }
      }
    } while (changed);
    return result;
  };
  const renamedBindings = uniqueRenames(bindingIds);
  const renamedProviders = uniqueRenames(providerIds);
  config.bindings = Object.fromEntries(bindings.map(([id, binding]) => [
    renamedBindings.get(id),
    isRecord(binding) ? {
      ...binding,
      id: renamedBindings.get(id),
      virtualProvider: renamedProviders.get(binding.virtualProvider) ?? binding.virtualProvider,
    } : binding,
  ]));
  config.virtualProviders = Object.fromEntries(Object.entries(config.virtualProviders).map(([id, provider]) => [
    renamedProviders.get(id),
    isRecord(provider) ? { ...provider, id: renamedProviders.get(id) } : provider,
  ]));
  return { bindingIds: renamedBindings, providerIds: renamedProviders };
}
