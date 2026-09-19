import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { randomBytes } from "node:crypto";

import {
  applySecretPayload,
  backupFile,
  computeConfigDiff,
  ensureGeneratedSecrets,
  getPaths,
  loadConfig,
  loadSecrets,
  normalizeConfig,
  publicConfig,
  readRuntimeInfo,
  resolveUpstreamSecret,
  saveConfig,
  saveSecrets,
  secretRefForUpstream,
  stripSecretFields,
  writeRuntimeInfo,
} from "./config.mjs";
import {
  applyCodexArtifacts,
  prepareCodexArtifacts,
  publicArtifacts,
  CODEX_NATIVE_PROVIDER_INTEGRATION,
  CODEX_NATIVE_REQUIRED_ENDPOINTS,
  CODEX_TARGET_FORMAT,
} from "./codex-native-provider.mjs";
import {
  publicTargetArtifacts,
  prepareTargetArtifacts,
} from "./target-artifacts.mjs";
import {
  listClientModels,
  resolveModelProfile,
  resolveRequest,
  rewriteModelFields,
  selectBackend,
} from "./model-resolver.mjs";
import { validateConfig } from "./validation.mjs";
import { loadCodexCatalog, publicCodexCatalog, validateCodexChanges } from "./codex-catalog.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB_ROOT = path.join(PROJECT_ROOT, "web");
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const IMPLEMENTED_INGRESS_PROTOCOLS = new Set([
  "openai.responses",
  "anthropic.messages",
]);
const CODEX_NATIVE_MODEL_PATH = CODEX_NATIVE_REQUIRED_ENDPOINTS.find(
  (endpoint) => endpoint.purpose === "model_discovery",
).path;
const CODEX_NATIVE_RESPONSES_PATH = CODEX_NATIVE_REQUIRED_ENDPOINTS.find(
  (endpoint) => endpoint.purpose === "responses",
).path;

export async function createApplication(options = {}) {
  const paths = options.paths || getPaths();
  await fs.mkdir(paths.home, { recursive: true, mode: 0o700 });
  let config = await loadConfig(paths);
  let secrets = await loadSecrets(paths);
  secrets = ensureGeneratedSecrets(config, secrets);
  const startupValidation = validateConfig(config);
  if (!startupValidation.ok) {
    const details = startupValidation.errors
      .map((item) => `${item.path}: ${item.message}`)
      .join("; ");
    throw new Error(`配置校验失败，daemon 未启动: ${details}`);
  }

  const state = {
    paths,
    config,
    secrets,
    events: [],
    health: new Map(),
    startedAt: new Date().toISOString(),
    webServer: null,
    proxyManager: null,
    loadCodexCatalog: options.loadCodexCatalog || loadCodexCatalog,
    codexHome: options.codexHome,
  };

  const proxyManager = new ProxyManager(state);
  state.proxyManager = proxyManager;
  let webServer = null;
  const host = config.web.listenHost || "127.0.0.1";
  const port = Number(config.web.port || 43100);
  try {
    await proxyManager.reload(config, secrets);

    webServer = http.createServer((request, response) => {
      handleWebRequest(state, request, response).catch((error) => {
        if (!response.headersSent) {
          sendJson(response, 500, { error: { code: "internal_error", message: error.message } });
        } else {
          response.destroy(error);
        }
      });
    });
    state.webServer = webServer;
    await listen(webServer, host, port);

    await saveSecrets(secrets, paths);
    await persistRuntimeInfo(state, host, port);
  } catch (error) {
    await proxyManager.close().catch(() => {});
    if (webServer) await closeServer(webServer).catch(() => {});
    throw error;
  }

  function updateConfig(nextConfig, nextSecrets) {
    config = nextConfig;
    secrets = nextSecrets;
    state.config = config;
    state.secrets = secrets;
  }

  state.updateConfig = updateConfig;

  const close = async () => {
    await proxyManager.close();
    await closeServer(webServer);
    const runtime = await readRuntimeInfo(paths);
    if (runtime?.pid === process.pid) {
      await fs.unlink(paths.runtime).catch(() => {});
    }
  };

  return {
    state,
    close,
    url: formatWebUrl(host, port),
  };
}

class ProxyManager {
  constructor(state) {
    this.state = state;
    this.entries = new Map();
    this.servers = new Map();
    this.operation = Promise.resolve();
  }

  async reload(config, secrets = this.state.secrets) {
    const task = this.operation.then(() => this.reloadNow(config, secrets));
    this.operation = task.catch(() => {});
    return task;
  }

  async reloadNow(config, secrets) {
    const entries = Object.entries(config.virtualProviders || {}).filter(
      ([, provider]) => provider.enabled !== false,
    );
    const nextEntries = new Map();
    const createdServers = [];
    const claimedPrevious = new Set();
    let failedId = "";
    try {
      for (const [id, provider] of entries) {
        failedId = id;
        const host = provider.listenHost || "127.0.0.1";
        const port = Number(provider.listenPort);
        const runtime = { config, secrets, id, provider };
        const previous = findReusableEntry(this.entries, claimedPrevious, host, port);

        // Keep an unchanged listener during staging. A TCP listener cannot be
        // bound twice, but its request handler can switch atomically later.
        if (previous && sameListener(previous, host, port)) {
          claimedPrevious.add(previous);
          nextEntries.set(id, {
            ...previous,
            id,
            host,
            port,
            runtime,
          });
          continue;
        }

        const handlerState = { runtime };
        const server = this.createServer(handlerState);
        await listen(server, host, port);
        createdServers.push(server);
        nextEntries.set(id, {
          id,
          host,
          port,
          server,
          handlerState,
          runtime,
        });
      }
    } catch (error) {
      await Promise.all(createdServers.map((server) => closeServer(server)));
      throw new Error(`Virtual Provider ${failedId} 监听失败: ${error.message}`);
    }

    const previousEntries = this.entries;
    const retainedServers = new Set(
      [...nextEntries.values()].map((entry) => entry.server),
    );

    // Publish the staged set before closing listeners that are no longer
    // needed. If staging failed, the old set above was never touched.
    this.entries = nextEntries;
    this.servers = new Map(
      [...nextEntries.entries()].map(([id, entry]) => [id, entry.server]),
    );
    for (const entry of nextEntries.values()) {
      entry.handlerState.runtime = entry.runtime;
    }

    await Promise.all(
      [...previousEntries.values()]
        .filter((entry) => !retainedServers.has(entry.server))
        .map((entry) => closeServer(entry.server)),
    );
  }

  createServer(handlerState) {
    return http.createServer((request, response) => {
      const runtime = handlerState.runtime;
      handleProxyRequest(
        this.state,
        runtime.config,
        runtime.secrets,
        runtime.id,
        runtime.provider,
        request,
        response,
      ).catch((error) => {
        if (!response.headersSent) {
          sendProtocolError(
            response,
            runtime.provider.ingressProtocol,
            500,
            "internal_error",
            error.message,
          );
        } else {
          response.destroy(error);
        }
      });
    });
  }

  async close() {
    const task = this.operation.then(() => this.closeNow());
    this.operation = task.catch(() => {});
    return task;
  }

  async closeNow() {
    const servers = [...this.entries.values()].map((entry) => entry.server);
    this.entries.clear();
    this.servers.clear();
    await Promise.all(servers.map((server) => closeServer(server)));
  }

  status() {
    return Object.entries(this.state.config.virtualProviders || {}).map(([id, provider]) => {
      const entry = this.entries.get(id);
      return {
        id,
        listen: `${provider.listenHost || "127.0.0.1"}:${provider.listenPort}`,
        protocol: provider.ingressProtocol,
        route: provider.route,
        enabled: provider.enabled !== false,
        status: provider.enabled === false ? "paused" : entry ? "listening" : "not_listening",
      };
    });
  }
}

async function handleWebRequest(state, request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/api/")) {
    await handleApiRequest(state, request, response, url);
    return;
  }
  await serveStatic(url.pathname, response);
}

async function handleApiRequest(state, request, response, url) {
  if (!isAllowedWebRequest(state, request)) {
    sendJson(response, 403, {
      error: { code: "origin_not_allowed", message: "只允许来自当前本地管理台的请求" },
    });
    return;
  }

  if (request.method === "OPTIONS") {
    const origin = request.headers.origin;
    response.writeHead(204, {
      ...(origin ? { "access-control-allow-origin": origin } : {}),
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    });
    response.end();
    return;
  }

  const method = request.method;
  let body = {};
  if (method === "POST" || method === "PATCH") {
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, error.status || 400, {
        error: { code: error.code || "invalid_json", message: error.message },
      });
      return;
    }
  }

  if (url.pathname === "/api/v1/codex/models" && method === "GET") {
    try {
      sendJson(response, 200, publicCodexCatalog(await state.loadCodexCatalog({ refresh: url.searchParams.get("refresh") === "1" })));
    } catch (error) {
      sendJson(response, 200, { available: false, models: [], error: { message: error.message } });
    }
    return;
  }

  if (url.pathname === "/api/v1/catalog" && method === "GET") {
    sendJson(response, 200, {
      protocols: [
        "openai.responses",
        "openai.chat_completions",
        "anthropic.messages",
        "gemini.generate_content",
      ],
      implementedProtocols: [...IMPLEMENTED_INGRESS_PROTOCOLS],
      integrations: [CODEX_NATIVE_PROVIDER_INTEGRATION],
      requiredEndpoints: {
        [CODEX_NATIVE_PROVIDER_INTEGRATION]: CODEX_NATIVE_REQUIRED_ENDPOINTS,
      },
      targetFormats: [CODEX_TARGET_FORMAT, "claude.env.v1", "generic.env.v1"],
      targets: ["codex", "claude-code", "generic-env"],
      capabilities: [
        "streaming",
        "tools",
        "parallel_tool_calls",
        "vision",
        "reasoning",
        "prompt_cache",
      ],
    });
    return;
  }

  if (url.pathname === "/api/v1/config" && method === "GET") {
    sendJson(response, 200, { config: redactConfig(state.config, state.secrets) });
    return;
  }

  if (url.pathname === "/api/v1/runtime" && method === "GET") {
    sendJson(response, 200, runtimeStatus(state));
    return;
  }

  if (url.pathname === "/api/v1/events" && method === "GET") {
    sendJson(response, 200, { events: state.events.slice(-100).reverse() });
    return;
  }

  if (url.pathname === "/api/v1/integrations" && method === "GET") {
    sendJson(response, 200, {
      integrations: [
        {
          id: CODEX_NATIVE_PROVIDER_INTEGRATION,
          label: "Codex Native Provider Integration",
          capabilities: ["models", "responses", "streaming"],
          requiredEndpoints: CODEX_NATIVE_REQUIRED_ENDPOINTS,
          note: "CableTidy 直接管理上游连接、模型映射和本地 Virtual Provider",
        },
      ],
    });
    return;
  }

  if (url.pathname === "/api/v1/config/validate" && method === "POST") {
    const candidate = normalizeConfig(stripPresentationFields(body.config || state.config));
    const result = validateConfig(candidate);
    if (result.ok) result.errors.push(...await validateCodexChanges(candidate, state.config, state.loadCodexCatalog));
    result.ok = result.errors.length === 0;
    sendJson(response, result.ok ? 200 : 422, {
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      diff: computeConfigDiff(state.config, result.config),
      config: redactConfig(result.config, state.secrets),
    });
    return;
  }

  if (url.pathname === "/api/v1/config/commit" && method === "POST") {
    await commitConfig(state, body, response);
    return;
  }

  const virtualProviderAction = url.pathname.match(
    /^\/api\/v1\/virtual-providers\/([^/]+)\/(start|pause)$/,
  );
  if (virtualProviderAction && method === "POST") {
    await setVirtualProviderState(
      state,
      decodeURIComponent(virtualProviderAction[1]),
      virtualProviderAction[2] === "start",
      response,
    );
    return;
  }

  if (url.pathname === "/api/v1/tests/model-resolve" && method === "POST") {
    const config = normalizeConfig(body.config || state.config);
    const provider = config.virtualProviders?.[body.virtualProviderId];
    if (!provider) {
      sendJson(response, 404, { error: { code: "virtual_provider_not_found", message: "Virtual Provider 不存在" } });
      return;
    }
    try {
      const result = resolveRequest(config, provider, {
        model: body.model,
        stream: Boolean(body.stream),
        tools: body.tools || [],
        tool_choice: body.tool_choice,
        reasoning: Boolean(body.reasoning),
        thinking: body.thinking,
      });
      sendJson(response, 200, {
        ok: true,
        requestedModel: body.model || null,
        profileId: result.model.profileId,
        clientModelId: result.model.clientModelId,
        upstreamId: result.upstream.id,
        upstreamModelId: result.upstreamModelId,
        routeId: result.routeId,
        capabilities: result.capabilities,
        rejectedBackends: result.rejected,
      });
    } catch (error) {
      sendJson(response, 422, {
        ok: false,
        error: {
          code: error.code || "model_resolution_failed",
          message: error.message,
          details: error.details,
        },
      });
    }
    return;
  }

  if (url.pathname === "/api/v1/tests/upstream" && method === "POST") {
    await testUpstream(state, body, response);
    return;
  }

  if (
    (url.pathname === "/api/v1/config/preview-target-artifacts" ||
      url.pathname === "/api/v1/config/preview-codex-config") &&
    method === "POST"
  ) {
    await previewTargetArtifacts(state, body, response);
    return;
  }

  // Compatibility alias for clients built against the first prototype. It
  // previews target artifacts and does not inspect or import reference files.
  if (url.pathname === "/api/v1/config/preview-provider-artifacts" && method === "POST") {
    await previewTargetArtifacts(state, body, response);
    return;
  }

  if (url.pathname === "/api/v1/targets/codex/apply" && method === "POST") {
    await applyCodexTarget(state, body, response);
    return;
  }

  if (url.pathname === "/api/v1/targets/apply" && method === "POST") {
    await applyTarget(state, body, response);
    return;
  }

  sendJson(response, 404, { error: { code: "not_found", message: "API endpoint 不存在" } });
}

async function commitConfig(state, body, response) {
  const baseRevision = Number(body.baseRevision);
  if (baseRevision !== state.config.revision) {
    sendJson(response, 409, {
      error: {
        code: "revision_conflict",
        message: `配置已经变更，当前 revision 是 ${state.config.revision}`,
        currentRevision: state.config.revision,
      },
      diff: computeConfigDiff(state.config, stripPresentationFields(body.config || state.config)),
      config: redactConfig(state.config, state.secrets),
    });
    return;
  }

  const candidate = normalizeConfig(stripPresentationFields(body.config || {}));
  candidate.revision = state.config.revision + 1;
  const candidateSecrets = ensureGeneratedSecrets(
    candidate,
    applySecretPayload(candidate, state.secrets, body),
  );
  const validation = validateConfig(candidate);
  if (validation.ok) validation.errors.push(...await validateCodexChanges(candidate, state.config, state.loadCodexCatalog));
  validation.ok = validation.errors.length === 0;
  const diff = computeConfigDiff(state.config, candidate);
  if (!validation.ok) {
    sendJson(response, 422, {
      error: { code: "config_invalid", message: "配置校验失败" },
      errors: validation.errors,
      warnings: validation.warnings,
      diff,
    });
    return;
  }
  if (
    candidate.web.listenHost !== state.config.web.listenHost ||
    Number(candidate.web.port) !== Number(state.config.web.port)
  ) {
    sendJson(response, 422, {
      error: {
        code: "web_listener_restart_required",
        message: "Web 管理台监听地址或端口需要重启 daemon 后才能修改",
      },
      diff,
    });
    return;
  }

  const previousConfig = state.config;
  const previousSecrets = state.secrets;
  const activeWebHost = state.config.web.listenHost || "127.0.0.1";
  const activeWebPort = Number(state.config.web.port || 43100);
  let configWritten = false;
  let secretsWritten = false;

  try {
    await state.proxyManager.reload(candidate, candidateSecrets);
    await backupFile(state.paths.config, state.paths.backups, `config-${candidate.revision}.json`);
    await backupFile(state.paths.secrets, state.paths.backups, `secrets-${candidate.revision}.json`);
    await saveConfig(candidate, state.paths);
    configWritten = true;
    await saveSecrets(candidateSecrets, state.paths);
    secretsWritten = true;
    state.updateConfig(candidate, candidateSecrets);
    try {
      await persistRuntimeInfo(
        state,
        activeWebHost,
        activeWebPort,
      );
    } catch (error) {
      recordEvent(state, "runtime.persist_failed", { message: error.message });
    }
    recordEvent(state, "config.commit", {
      revision: candidate.revision,
      virtualProviders: Object.keys(candidate.virtualProviders),
      upstreams: Object.keys(candidate.upstreams),
    });
  } catch (error) {
    if (configWritten) await saveConfig(previousConfig, state.paths).catch(() => {});
    if (secretsWritten) await saveSecrets(previousSecrets, state.paths).catch(() => {});
    await state.proxyManager.reload(previousConfig, previousSecrets).catch(() => {});
    state.updateConfig(previousConfig, previousSecrets);
    sendJson(response, 500, {
      error: { code: "config_reload_failed", message: error.message },
    });
    return;
  }
  sendJson(response, 200, {
    ok: true,
    revision: candidate.revision,
    diff,
    config: redactConfig(candidate, candidateSecrets),
    runtime: runtimeStatus(state),
  });
}

async function setVirtualProviderState(state, id, enabled, response) {
  const currentProvider = state.config.virtualProviders?.[id];
  if (!currentProvider) {
    sendJson(response, 404, {
      error: { code: "virtual_provider_not_found", message: `Virtual Provider 不存在: ${id}` },
    });
    return;
  }

  const previousConfig = state.config;
  const previousSecrets = state.secrets;
  const candidate = normalizeConfig(state.config);
  candidate.virtualProviders[id] = {
    ...candidate.virtualProviders[id],
    enabled,
  };
  candidate.revision = state.config.revision + 1;
  const validation = validateConfig(candidate);
  if (!validation.ok) {
    sendJson(response, 422, {
      error: { code: "config_invalid", message: "配置校验失败" },
      errors: validation.errors,
      warnings: validation.warnings,
    });
    return;
  }

  try {
    await state.proxyManager.reload(candidate, state.secrets);
    await backupFile(state.paths.config, state.paths.backups, `config-${candidate.revision}.json`);
    await saveConfig(candidate, state.paths);
    state.updateConfig(candidate, state.secrets);
    await persistRuntimeInfo(
      state,
      state.config.web.listenHost || "127.0.0.1",
      Number(state.config.web.port || 43100),
    ).catch((error) => recordEvent(state, "runtime.persist_failed", { message: error.message }));
    recordEvent(state, enabled ? "virtual_provider.start" : "virtual_provider.pause", {
      virtualProviderId: id,
      revision: candidate.revision,
    });
    sendJson(response, 200, {
      ok: true,
      virtualProviderId: id,
      enabled,
      revision: candidate.revision,
      config: redactConfig(candidate, state.secrets),
      runtime: runtimeStatus(state),
    });
  } catch (error) {
    await state.proxyManager.reload(previousConfig, previousSecrets).catch(() => {});
    state.updateConfig(previousConfig, previousSecrets);
    sendJson(response, 500, {
      error: { code: "virtual_provider_state_failed", message: error.message },
    });
  }
}

async function testUpstream(state, body, response) {
  const id = body?.id;
  const config = body?.config
    ? normalizeConfig(stripPresentationFields(body.config))
    : state.config;
  const secrets = body?.config
    ? applySecretPayload(config, state.secrets, body)
    : state.secrets;
  const upstream = config.upstreams?.[id];
  if (!upstream) {
    sendJson(response, 404, { error: { code: "upstream_not_found", message: "upstream 不存在" } });
    return;
  }
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers = { accept: "application/json" };
    const secret = resolveUpstreamSecret(upstream, secrets);
    applyUpstreamAuth(headers, upstream, upstream.protocol, secret);
    const result = await fetch(upstream.baseUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const reachable = result.status < 500 || result.status === 501;
    await result.body?.cancel().catch(() => {});
    recordHealth(state, id, result.ok ? "success" : "response", result.status);
    sendJson(response, 200, {
      ok: reachable,
      status: result.status,
      latencyMs: Date.now() - started,
      secretConfigured: Boolean(secret),
      message: reachable ? "上游可连接" : "上游返回服务端错误",
    });
  } catch (error) {
    recordHealth(state, id, "failure", null);
    sendJson(response, 200, {
      ok: false,
      latencyMs: Date.now() - started,
      secretConfigured: Boolean(resolveUpstreamSecret(upstream, secrets)),
      message: error.name === "AbortError" ? "连接超时" : error.message,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function previewTargetArtifacts(state, body, response) {
  try {
    const config = normalizeConfig(body.config || state.config);
    const secrets = ensureGeneratedSecrets(
      config,
      applySecretPayload(config, state.secrets, body),
    );
    const artifacts = await prepareTargetArtifacts(config, {
      bindingId: body.bindingId,
      loadCatalog: state.loadCodexCatalog,
      codexHome: state.codexHome,
    }, secrets);
    sendJson(response, 200, {
      ok: true,
      artifacts: publicTargetArtifacts(artifacts),
    });
  } catch (error) {
    sendJson(response, 422, {
      error: { code: "target_artifact_preview_failed", message: error.message },
    });
  }
}

async function applyCodexTarget(state, body, response) {
  try {
    const artifacts = await prepareCodexArtifacts(state.config, {
      bindingId: body.bindingId,
      loadCatalog: state.loadCodexCatalog,
      codexHome: state.codexHome,
    }, state.secrets);
    const report = await applyCodexArtifacts(artifacts, { paths: state.paths, codexHome: state.codexHome });
    recordEvent(state, "target.codex.apply", { bindingId: body.bindingId || null, files: report.applied });
    sendJson(response, 200, {
      ok: true,
      report: {
        ...report,
        environment: publicArtifacts({ ...artifacts, ...report }).environment,
      },
    });
  } catch (error) {
    sendJson(response, 422, { error: { code: "codex_apply_failed", message: error.message } });
  }
}

async function applyTarget(state, body, response) {
  try {
    const artifacts = await prepareTargetArtifacts(state.config, {
      bindingId: body.bindingId,
      loadCatalog: state.loadCodexCatalog,
      codexHome: state.codexHome,
    }, state.secrets);
    if (artifacts.target !== "codex") {
      sendJson(response, 501, {
        error: {
          code: "target_apply_not_supported",
          message: `${artifacts.target} 当前没有可持久化写入的客户端配置；请使用预览或 cabletidy target env 生成进程环境`,
        },
        target: artifacts.target,
        bindingId: artifacts.bindingId,
        artifacts: publicTargetArtifacts(artifacts),
      });
      return;
    }
    let report = { applied: [], mode: artifacts.mode };
    report = await applyCodexArtifacts(artifacts, { paths: state.paths, codexHome: state.codexHome });
    recordEvent(state, "target.apply", {
      bindingId: artifacts.bindingId,
      target: artifacts.target,
      files: report.applied,
    });
    sendJson(response, 200, {
      ok: true,
      target: artifacts.target,
      report: {
        ...report,
        environment: publicTargetArtifacts({ ...artifacts, ...report }).environment,
      },
    });
  } catch (error) {
    sendJson(response, 422, {
      error: { code: "target_apply_failed", message: error.message },
    });
  }
}

async function handleProxyRequest(state, config, secrets, virtualProviderId, provider, request, response) {
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const protocol = provider.ingressProtocol;

  if (!IMPLEMENTED_INGRESS_PROTOCOLS.has(protocol)) {
    sendProtocolError(
      response,
      protocol,
      501,
      "unsupported_protocol",
      `当前 MVP 尚未实现 ingress protocol: ${protocol}`,
    );
    return;
  }

  const url = new URL(request.url, "http://127.0.0.1");
  if (
    protocol === "openai.responses" &&
    request.method === "GET" &&
    (url.pathname === CODEX_NATIVE_MODEL_PATH || url.pathname === "/models")
  ) {
    const models = listClientModels(config, provider);
    sendJson(response, 200, { object: "list", data: models });
    return;
  }
  const supportedPaths = protocol === "anthropic.messages"
    ? ["/v1/messages", "/messages"]
    : [CODEX_NATIVE_RESPONSES_PATH, "/responses"];
  if (request.method !== "POST" || !supportedPaths.includes(url.pathname)) {
    sendProtocolError(
      response,
      protocol,
      404,
      "not_found",
      protocol === "anthropic.messages"
        ? "只支持 POST /v1/messages"
        : "只支持 POST /v1/responses 和 GET /v1/models",
    );
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    sendProtocolError(
      response,
      protocol,
      error.status || 400,
      error.code || "invalid_request_error",
      error.message,
    );
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendProtocolError(response, protocol, 400, "invalid_request_error", "请求 body 必须是 JSON object");
    return;
  }
  let resolution;
  try {
    resolution = resolveModelProfile(config, provider, body.model);
  } catch (error) {
    sendProtocolError(response, protocol, 400, error.code || "invalid_request_error", error.message);
    return;
  }

  const skipped = new Set();
  const maxAttempts = Math.max(1, Number(config.routes?.[provider.route]?.backends?.length || 1));
  const upstreamAbort = new AbortController();
  const abortUpstream = () => upstreamAbort.abort();
  request.once("aborted", abortUpstream);
  response.once("close", () => {
    if (!response.writableFinished) upstreamAbort.abort();
  });
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let selected;
    try {
      selected = selectBackend(
        config,
        provider,
        resolution,
        body,
        { skipUpstreams: skipped },
      );
    } catch (error) {
      sendProtocolError(response, protocol, 503, error.code || "upstream_unavailable", error.message);
      return;
    }
    skipped.add(selected.upstream.id);
    if (protocol !== selected.upstream.protocol) {
      sendProtocolError(response, protocol, 501, "unsupported_transform", "MVP 暂不执行跨协议数据面转换");
      return;
    }

    const outgoing = structuredClone(body);
    // Model metadata is a client-side artifact. Preserve the instructions,
    // tools and per-request reasoning effort constructed by Codex.
    outgoing.model = selected.upstreamModelId;
    const upstreamUrl = joinUpstreamUrl(selected.upstream.baseUrl, url.pathname, url.search);
    const upstreamHeaders = {
      "content-type": "application/json",
      accept: request.headers.accept || "text/event-stream, application/json",
    };
    copyProtocolHeaders(request, upstreamHeaders, protocol);
    const secret = resolveUpstreamSecret(selected.upstream, secrets);
    applyUpstreamAuth(upstreamHeaders, selected.upstream, protocol, secret);
    const started = Date.now();
    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(outgoing),
        signal: upstreamAbort.signal,
      });
      const retryable = [408, 429, 500, 502, 503, 504].includes(upstreamResponse.status);
      if (retryable && attempt + 1 < maxAttempts && !upstreamResponse.bodyUsed) {
        await upstreamResponse.body?.cancel().catch(() => {});
        recordHealth(state, selected.upstream.id, "retryable_response", upstreamResponse.status);
        continue;
      }
      recordHealth(
        state,
        selected.upstream.id,
        upstreamResponse.ok ? "success" : "failure",
        upstreamResponse.status,
      );
      recordEvent(state, "proxy.request", {
        virtualProviderId,
        upstreamId: selected.upstream.id,
        clientModelId: resolution.clientModelId,
        upstreamModelId: selected.upstreamModelId,
        status: upstreamResponse.status,
        latencyMs: Date.now() - started,
        attempt: attempt + 1,
      });
      await relayResponse(
        response,
        upstreamResponse,
        resolution.clientModelId,
        selected.upstreamModelId,
      );
      return;
    } catch (error) {
      recordHealth(state, selected.upstream.id, "failure", null);
      if (upstreamAbort.signal.aborted) return;
      if (response.headersSent || response.writableEnded) {
        if (!response.destroyed) response.destroy(error);
        return;
      }
      if (attempt + 1 >= maxAttempts) {
        sendProtocolError(response, protocol, 502, "upstream_unavailable", error.message);
        return;
      }
    }
  }
}

async function relayResponse(response, upstreamResponse, clientModelId, upstreamModelId) {
  const contentType = upstreamResponse.headers.get("content-type") || "application/json";
  const isEventStream = contentType.includes("text/event-stream");
  const headers = {
    "content-type": contentType,
    "cache-control": upstreamResponse.headers.get("cache-control") || "no-cache",
  };
  const requestId = upstreamResponse.headers.get("x-request-id");
  if (requestId) headers["x-request-id"] = requestId;
  response.writeHead(upstreamResponse.status, headers);

  if (!upstreamResponse.body) {
    response.end();
    return;
  }

  if (!isEventStream) {
    const text = await upstreamResponse.text();
    if (!text) {
      response.end();
      return;
    }
    try {
      const body = rewriteModelFields(JSON.parse(text), clientModelId, upstreamModelId);
      response.end(JSON.stringify(body));
    } catch {
      response.end(text);
    }
    return;
  }

  await pipeline(
    Readable.fromWeb(upstreamResponse.body),
    createSseRewriteTransform(clientModelId, upstreamModelId),
    response,
  );
}

function createSseRewriteTransform(clientModelId, upstreamModelId) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        buffer += Buffer.isBuffer(chunk)
          ? decoder.write(chunk)
          : String(chunk, encoding);
        const drained = drainSseBuffer(buffer, clientModelId, upstreamModelId);
        buffer = drained.remaining;
        callback(null, drained.output || undefined);
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        buffer += decoder.end();
        callback(
          null,
          buffer
            ? rewriteSseEvent(buffer, clientModelId, upstreamModelId)
            : undefined,
        );
      } catch (error) {
        callback(error);
      }
    },
  });
}

function drainSseBuffer(buffer, clientModelId, upstreamModelId) {
  let remaining = buffer;
  let output = "";
  while (true) {
    const delimiter = remaining.match(/\r?\n\r?\n/);
    if (!delimiter || delimiter.index === undefined) break;
    const event = remaining.slice(0, delimiter.index);
    output += rewriteSseEvent(event, clientModelId, upstreamModelId);
    output += delimiter[0];
    remaining = remaining.slice(delimiter.index + delimiter[0].length);
  }
  return { output, remaining };
}

function rewriteSseEvent(event, clientModelId, upstreamModelId) {
  const separator = event.includes("\r\n") ? "\r\n" : "\n";
  const lines = event.split(/\r?\n/);
  const dataLines = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^data:(?: ?)(.*)$/);
    if (match) dataLines.push({ index, value: match[1] });
  }
  if (!dataLines.length) return event;

  const payload = dataLines.map((line) => line.value).join("\n").trim();
  if (!payload || payload === "[DONE]") return event;
  try {
    const parsed = JSON.parse(payload);
    const rewritten = rewriteModelFields(parsed, clientModelId, upstreamModelId);
    const first = dataLines[0];
    const prefix = lines[first.index].match(/^data:/)?.[0] || "data:";
    lines[first.index] = `${prefix} ${JSON.stringify(rewritten)}`;
    for (const line of dataLines.slice(1).reverse()) lines.splice(line.index, 1);
    return lines.join(separator);
  } catch {
    return event;
  }
}

function copyProtocolHeaders(request, target, protocol) {
  const names = protocol === "anthropic.messages"
    ? ["anthropic-version", "anthropic-beta"]
    : ["openai-beta", "openai-organization", "openai-project"];
  for (const name of names) {
    const value = request.headers[name];
    if (value) target[name] = value;
  }
}

function applyUpstreamAuth(headers, upstream, protocol, secret) {
  if (!secret) return;
  const configuredHeader = upstream.auth?.header || upstream.authHeader;
  const header = String(
    configuredHeader ||
      (protocol === "anthropic.messages" ? "x-api-key" : "authorization"),
  ).toLowerCase();
  if (header === "authorization") {
    const scheme = upstream.auth?.scheme || "Bearer";
    headers.authorization = `${scheme} ${secret}`;
  } else {
    headers[header] = secret;
  }
}

function joinUpstreamUrl(base, incomingPath, search) {
  const target = new URL(base);
  const basePath = target.pathname.replace(/\/+$/, "");
  let requestPath = incomingPath || "/";
  if (basePath.endsWith("/v1") && requestPath.startsWith("/v1/")) {
    requestPath = requestPath.slice(3);
  }
  target.pathname = `${basePath}/${requestPath.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  if (search) {
    const incoming = new URLSearchParams(search);
    for (const [key, value] of incoming) target.searchParams.set(key, value);
  }
  return target.toString();
}

function redactConfig(config, secrets) {
  const copy = publicConfig(config);
  for (const [id, upstream] of Object.entries(copy.upstreams || {})) {
    upstream.secretRef ||= secretRefForUpstream(id);
    upstream.secretConfigured = Boolean(resolveUpstreamSecret(config.upstreams[id], secrets));
  }
  return copy;
}

function stripPresentationFields(value) {
  const copy = stripSecretFields(value || {});
  stripFields(copy);
  return copy;
}

function stripFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) stripFields(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  delete value.secretConfigured;
  for (const item of Object.values(value)) stripFields(item);
}

function runtimeStatus(state) {
  const health = {};
  for (const [id, item] of state.health.entries()) health[id] = item;
  return {
    pid: process.pid,
    startedAt: state.startedAt,
    revision: state.config.revision,
    web: {
      host: state.config.web.listenHost,
      port: state.config.web.port,
      status: "listening",
    },
    virtualProviders: state.proxyManager.status(),
    health,
    counts: {
      upstreams: Object.keys(state.config.upstreams || {}).length,
      models: Object.keys(state.config.models || {}).length,
      routes: Object.keys(state.config.routes || {}).length,
      virtualProviders: Object.keys(state.config.virtualProviders || {}).length,
      bindings: Object.keys(state.config.bindings || {}).length,
    },
  };
}

async function persistRuntimeInfo(state, host, port) {
  await writeRuntimeInfo(
    {
      pid: process.pid,
      startedAt: state.startedAt,
      web: {
        host,
        port,
        url: formatWebUrl(host, port),
      },
      revision: state.config.revision,
    },
    state.paths,
  );
}

function recordHealth(state, id, outcome, status) {
  const previous = state.health.get(id) || { failures: 0 };
  const failures = outcome === "success" ? 0 : previous.failures + 1;
  state.health.set(id, {
    outcome,
    status,
    failures,
    lastCheckedAt: new Date().toISOString(),
  });
}

function recordEvent(state, type, data) {
  state.events.push({
    id: randomBytes(8).toString("hex"),
    type,
    at: new Date().toISOString(),
    data,
  });
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
}

function isAllowedWebRequest(state, request) {
  const configuredHost = String(state.config.web.listenHost || "127.0.0.1").toLowerCase();
  const hostHeader = request.headers.host;
  if (hostHeader) {
    let requestHost;
    let requestPort;
    try {
      const parsed = new URL(`http://${hostHeader}`);
      requestHost = parsed.hostname.toLowerCase();
      requestPort = Number(parsed.port || state.config.web.port);
    } catch {
      return false;
    }
    const expectedPort = Number(state.config.web.port);
    if (requestPort !== expectedPort) return false;
    if (!isAllowedHost(configuredHost, requestHost)) return false;
  }

  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const originPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    if (originPort !== Number(state.config.web.port)) return false;
    return isAllowedHost(configuredHost, parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isAllowedHost(configuredHost, requestHost) {
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (configuredHost === "0.0.0.0" || configuredHost === "::" || configuredHost === "[::]") {
    return true;
  }
  if (loopbackHosts.has(configuredHost) || configuredHost === "[::1]") {
    return loopbackHosts.has(requestHost);
  }
  return requestHost === configuredHost.replace(/^\[|\]$/g, "");
}

async function serveStatic(requestPath, response) {
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const file = path.resolve(WEB_ROOT, relative);
  if (!file.startsWith(`${WEB_ROOT}${path.sep}`) && file !== path.join(WEB_ROOT, "index.html")) {
    sendJson(response, 403, { error: { code: "forbidden", message: "forbidden" } });
    return;
  }
  try {
    const content = await fs.readFile(file);
    response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-cache" });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(response, 404, { error: { code: "not_found", message: "静态资源不存在" } });
    } else {
      throw error;
    }
  }
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

async function readJson(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("request body too large");
      error.code = "payload_too_large";
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("请求 body 不是合法 JSON");
    error.code = "invalid_json";
    error.status = 400;
    throw error;
  }
}

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-cabletidy": "cabletidy",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function sendOpenAIError(response, status, code, message) {
  sendJson(response, status, {
    error: {
      type: "invalid_request_error",
      code,
      message,
    },
  });
}

function sendProtocolError(response, protocol, status, code, message) {
  if (protocol === "anthropic.messages") {
    const errorType = code === "authentication_error"
      ? "authentication_error"
      : code === "rate_limit_error"
        ? "rate_limit_error"
        : code === "overloaded_error"
          ? "overloaded_error"
          : code === "not_found"
            ? "not_found_error"
            : "invalid_request_error";
    sendJson(response, status, {
      type: "error",
      error: {
        type: errorType,
        message,
      },
    });
    return;
  }
  sendOpenAIError(response, status, code, message);
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function sameListener(entry, host, port) {
  return (
    normalizeListenerHost(entry.host) === normalizeListenerHost(host) &&
    Number(entry.port) === Number(port)
  );
}

function findReusableEntry(entries, claimed, host, port) {
  return [...entries.values()].find(
    (entry) => !claimed.has(entry) && sameListener(entry, host, port),
  ) || null;
}

function normalizeListenerHost(host) {
  const value = String(host || "127.0.0.1").trim().toLowerCase();
  if (value === "localhost") return "127.0.0.1";
  if (value === "[::1]") return "::1";
  if (value === "[::]") return "::";
  return value;
}

function formatWebUrl(host, port) {
  const value = String(host || "127.0.0.1");
  const formattedHost = value.includes(":") && !value.startsWith("[")
    ? `[${value}]`
    : value;
  return `http://${formattedHost}:${port}/`;
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function nextVirtualProviderPort(config, extraUsedPorts = []) {
  const used = new Set(
    Object.values(config.virtualProviders || {}).map((item) => Number(item.listenPort)),
  );
  used.add(Number(config.web?.port));
  for (const port of Array.isArray(extraUsedPorts) ? extraUsedPorts : []) {
    used.add(Number(port));
  }
  const [rangeStart, rangeEnd] = parsePortRange(config.daemon?.proxyPortRange);
  let port = rangeStart;
  while (port <= rangeEnd && used.has(port)) port += 1;
  if (port > rangeEnd) {
    throw new Error(`没有可用的 Virtual Provider 端口（范围 ${rangeStart}-${rangeEnd}）`);
  }
  return port;
}

function parsePortRange(value) {
  const match = String(value || "").match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!match) return [43101, 43199];
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end > 65535 ||
    start > end
  ) {
    return [43101, 43199];
  }
  return [start, end];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApplication()
    .then(({ url }) => {
      console.log(`CableTidy Web 管理台: ${url}`);
      console.log("按 Ctrl+C 停止 daemon");
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}
