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

export function codexConfigFixture() {
  return {
    upstreams: { relay: { id: "relay", name: "Relay", protocol: "openai.responses", baseUrl: "https://example.invalid/v1" } },
    models: { model: {
      id: "model", clientModelId: "gpt-5.5", aliases: ["gpt-5.5"],
      capabilities: ["streaming", "tools", "reasoning", "vision", "parallel_tool_calls"],
      codex: { metadataMode: "official" },
      upstreams: { relay: { upstreamModelId: "VENDOR-GPT" } },
    } },
    routes: { route: { id: "route", backends: [{ upstream: "relay", models: ["model"] }] } },
    virtualProviders: { cabletidy_relay: { id: "cabletidy_relay", ingressProtocol: "openai.responses", route: "route", allowedModels: ["model"], defaultModel: "model" } },
    bindings: { relay: { id: "relay", name: "relay", target: "codex", virtualProvider: "cabletidy_relay", defaultModel: "model", codex: {} } },
  };
}

export function namedCodexConfigFixture(names) {
  const template = codexConfigFixture();
  const config = { upstreams: {}, models: {}, routes: {}, virtualProviders: {}, bindings: {} };
  for (const [id, name] of Object.entries(names)) {
    config.upstreams[id] = {
      ...template.upstreams.relay, id, name: `Upstream ${id}`, baseUrl: `https://${id}.example.invalid/v1`,
    };
    config.models[id] = {
      ...structuredClone(template.models.model), id,
      upstreams: { [id]: { upstreamModelId: `VENDOR-${id}` } },
    };
    config.routes[id] = { id, backends: [{ upstream: id, models: [id] }] };
    config.virtualProviders[`cabletidy_${id}`] = {
      ...template.virtualProviders.cabletidy_relay, id: `cabletidy_${id}`, route: id,
      allowedModels: [id], defaultModel: id,
    };
    config.bindings[id] = {
      ...template.bindings.relay, id, name, virtualProvider: `cabletidy_${id}`, defaultModel: id,
    };
  }
  return config;
}
