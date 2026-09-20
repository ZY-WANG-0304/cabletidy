import fs from "node:fs/promises";
import path from "node:path";

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

export async function mockCodexEnvironment(home) {
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  const snapshot = catalogFixture();
  await fs.writeFile(path.join(bin, "codex"), `#!${process.execPath}\nconst args=process.argv.slice(2); console.log(args.includes('--version') ? ${JSON.stringify(snapshot.version)} : ${JSON.stringify(JSON.stringify(snapshot.catalog))});\n`, { mode: 0o700 });
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CABLETIDY_HOME: home, CODEX_HOME: path.join(home, "client") };
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
