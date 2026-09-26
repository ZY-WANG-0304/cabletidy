import { normalizeConfig } from "./native.mjs";

export function claudeConfigFixture(baseUrl = "https://example.invalid/v1", port = 43100) {
  return normalizeConfig({
    web: { listenHost: "127.0.0.1", port },
    upstreams: { relay: { id: "relay", protocol: "anthropic.messages", baseUrl, secretRef: "secret://upstreams/relay" } },
    models: { sonnet: {
      id: "sonnet", clientModelId: "claude-sonnet-4-6", aliases: ["claude-sonnet-4-6"],
      name: "Sonnet via relay", description: "Coding model", family: "claude",
      upstreams: { relay: { upstreamModelId: "vendor-sonnet" } },
    } },
    routes: { route: { id: "route", backends: [{ upstream: "relay", models: ["sonnet"] }] } },
    virtualProviders: { "claude-main": { id: "claude-main", ingressProtocol: "anthropic.messages", route: "route", allowedModels: ["sonnet"] } },
    bindings: { "claude-main": { id: "claude-main", target: "claude-code", virtualProvider: "claude-main", targetFormat: "claude.settings.json.v1", claude: {} } },
  });
}
