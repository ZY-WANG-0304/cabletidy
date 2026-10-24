export function catalogFixture() {
  return {
    version: "codex-cli test",
    catalog: {
      models: ["gpt-5.5", "gpt-5.6-sol"].map((slug) => ({
        slug, display_name: slug, visibility: "list", supported_in_api: true,
        context_window: 272000, max_context_window: 1000000,
        effective_context_window_percent: 95,
        input_modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "medium", description: "Medium" }, { effort: "high", description: "High" }],
        default_reasoning_level: "medium",
        base_instructions: `Official base for ${slug}`,
        model_messages: { instructions_template: `Official template for ${slug}`, instructions_variables: { personality_default: "original" } },
        shell_type: "unified_exec", apply_patch_tool_type: "freeform",
        future_metadata: { retained: true },
      })),
    },
  };
}

export function daybreakCatalogFixture() {
  const snapshot = catalogFixture();
  const base = snapshot.catalog.models[0];
  snapshot.catalog.models.unshift(...["blue", "red"].map(color => ({
    ...structuredClone(base), slug: `gpt-daybreak-${color}-latest`,
    display_name: `Daybreak ${color}`, visibility: "hide",
    base_instructions: `Daybreak ${color} instructions`,
    model_messages: { instructions_template: `Daybreak ${color} template` },
  })));
  snapshot.catalog.models.push({ ...structuredClone(base), slug: "gpt-hidden-general", visibility: "hide" });
  return snapshot;
}

export function codexConfigFixture() {
  return {
    version: 3,
    upstreams: { relay: { id: "relay", name: "Relay", protocol: "openai.responses", baseUrl: "https://example.invalid/v1" } },
    routes: { route: { id: "route", backends: [{ upstream: "relay" }] } },
    virtualProviders: { cabletidy_relay: {
      id: "cabletidy_relay", ingressProtocol: "openai.responses", route: "route", defaultModel: "gpt-5.5",
      models: { "gpt-5.5": {
        capabilities: ["streaming", "tools", "reasoning", "vision", "parallel_tool_calls"],
        codex: { metadataMode: "official" }, upstreamModelId: "VENDOR-GPT",
      } },
    } },
    cables: { relay: { id: "relay", name: "relay", target: "codex", virtualProvider: "cabletidy_relay", defaultModel: "gpt-5.5", codex: {} } },
  };
}

export function namedCodexConfigFixture(names) {
  const template = codexConfigFixture();
  const config = { version: 3, upstreams: {}, routes: {}, virtualProviders: {}, cables: {} };
  for (const [id, name] of Object.entries(names)) {
    config.upstreams[id] = {
      ...template.upstreams.relay, id, name: `Upstream ${id}`, baseUrl: `https://${id}.example.invalid/v1`,
    };
    config.routes[id] = { id, backends: [{ upstream: id }] };
    config.virtualProviders[`cabletidy_${id}`] = {
      ...template.virtualProviders.cabletidy_relay, id: `cabletidy_${id}`, route: id,
      models: { "gpt-5.5": { ...structuredClone(template.virtualProviders.cabletidy_relay.models["gpt-5.5"]), upstreamModelId: `VENDOR-${id}` } },
    };
    config.cables[id] = {
      ...template.cables.relay, id, name, virtualProvider: `cabletidy_${id}`,
    };
  }
  return config;
}
