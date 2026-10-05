import { normalizeConfig } from "./native.mjs";

export function claudeConfigFixture(baseUrl = "https://example.invalid/v1", port = 43100) {
  return normalizeConfig({
    version: 2,
    web: { listenHost: "127.0.0.1", port },
    upstreams: { relay: { id: "relay", protocol: "anthropic.messages", baseUrl, secretRef: "secret://upstreams/relay" } },
    routes: { route: { id: "route", backends: [{ upstream: "relay" }] } },
    virtualProviders: { "claude-main": {
      id: "claude-main", ingressProtocol: "anthropic.messages", route: "route",
      models: { "claude-sonnet-4-6": { description: "Coding model", family: "claude", upstreamModelId: "vendor-sonnet" } },
    } },
    bindings: { "claude-main": { id: "claude-main", target: "claude-code", virtualProvider: "claude-main", targetFormat: "claude.settings.json.v1", claude: {} } },
  });
}
