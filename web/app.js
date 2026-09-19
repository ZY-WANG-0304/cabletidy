const pageContent = document.querySelector("#page-content");
const pageTitle = document.querySelector("#page-title");
const pageEyebrow = document.querySelector("#page-eyebrow");
const railStatus = document.querySelector("#rail-status");
const revisionLabel = document.querySelector("#revision-label");
const toastRegion = document.querySelector("#toast-region");

const PAGE_META = {
  overview: ["CONFIGURATION SETS", "把一套可用接入方案放在一起管理"],
  "suite-create": ["NEW CONFIGURATION SET", "创建一套 CLI 接入方案"],
  "suite-detail": ["CONFIGURATION SET", "编辑这套接入方案"],
  upstreams: ["CONTROL / UPSTREAMS", "先把上游接进来"],
  models: ["CONTROL / MODEL REGISTRY", "客户端看到的名字，由你定义"],
  routes: ["CONTROL / ROUTING", "把稳定性写进路径"],
  targets: ["CONTROL / TARGETS", "生成 CLI 真正要用的配置"],
  diagnostics: ["OBSERVABILITY / DIAGNOSTICS", "在请求发出前看清楚它会去哪"],
};

const state = {
  page: "overview",
  config: null,
  draft: null,
  runtime: null,
  events: [],
  catalog: null,
  codexCatalog: null,
  dirty: false,
  showWizard: false,
  suiteView: "overview",
  secretDraft: {
    upstreamSecrets: {},
  },
  selected: {
    upstream: null,
    model: null,
    route: null,
    virtualProvider: null,
    binding: null,
    suite: null,
  },
  routeDraftBackends: null,
  artifactPreview: null,
  validation: null,
  resolveResult: null,
};

function clone(value) {
  return structuredClone(value);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function values(record) {
  return Object.values(record || {});
}

function entries(record) {
  return Object.entries(record || {});
}

function commaList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeProviderId(value, fallback = "codex") {
  const id = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return id || fallback;
}

function selectOptions(record, selected, emptyLabel = "选择") {
  const options = [`<option value="">${esc(emptyLabel)}</option>`];
  for (const [id, item] of entries(record)) {
    options.push(
      `<option value="${esc(id)}" ${id === selected ? "selected" : ""}>${esc(
        item.name || item.displayName || id,
      )} (${esc(id)})</option>`,
    );
  }
  return options.join("");
}

function optionList(items, selected) {
  return items
    .map((item) => `<option value="${esc(item)}" ${item === selected ? "selected" : ""}>${esc(item)}</option>`)
    .join("");
}

async function api(path, options = {}) {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error?.message || body.message || `请求失败 (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function bootstrap() {
  try {
    const [configResult, runtime, catalog, events, codexCatalog] = await Promise.all([
      api("/config"),
      api("/runtime"),
      api("/catalog"),
      api("/events"),
      api("/codex/models"),
    ]);
    state.config = configResult.config;
    state.draft = clone(state.config);
    state.runtime = runtime;
    state.catalog = catalog;
    state.codexCatalog = codexCatalog;
    state.events = events.events || [];
    state.selected.upstream = firstKey(state.draft.upstreams);
    state.selected.model = firstKey(state.draft.models);
    state.selected.route = firstKey(state.draft.routes);
    state.selected.virtualProvider = firstKey(state.draft.virtualProviders);
    state.selected.binding = firstKey(state.draft.bindings);
    state.selected.suite = firstKey(state.draft.bindings);
    railStatus.textContent = "DAEMON ONLINE";
    render();
  } catch (error) {
    renderUnavailable(error.message);
  }
}

function renderUnavailable(message) {
  railStatus.textContent = "无法连接";
  pageTitle.textContent = "无法连接到 CableTidy";
  pageEyebrow.textContent = "LOCAL ACCESS / DAEMON";
  pageContent.innerHTML = `
    <div class="hero-strip">
      <div>
        <p class="eyebrow">LOCAL DAEMON</p>
        <h2>请确认 CableTidy daemon 正在运行</h2>
        <p>管理台只绑定本机回环地址，不需要访问 token 或 session。请先运行 <span class="mono">npm start</span>，然后直接打开 <span class="mono">cabletidy web print-url</span> 输出的地址。</p>
      </div>
      <div class="hero-aside">
        <span class="hero-aside-label">RESPONSE</span>
        <span class="hero-aside-value">${esc(message || "unauthorized")}</span>
      </div>
    </div>
  `;
}

function render() {
  const [eyebrow, title] = pageMeta();
  pageEyebrow.textContent = eyebrow;
  pageTitle.textContent = title;
  revisionLabel.textContent = `REV ${state.draft?.revision ?? 0}${state.dirty ? " / DRAFT" : ""}`;
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle(
      "is-active",
      item.dataset.page === (state.page === "suite-detail" || state.page === "suite-create"
        ? "overview"
        : state.page),
    );
  });

  const renderers = {
    overview: renderOverview,
    "suite-create": renderSetupWizard,
    "suite-detail": renderSuiteDetail,
    upstreams: renderUpstreams,
    models: renderModels,
    routes: renderRoutes,
    targets: renderTargets,
    diagnostics: renderDiagnostics,
  };
  pageContent.innerHTML = renderers[state.page]();
  pageContent.querySelectorAll("[data-page]").forEach((item) => {
    item.addEventListener("click", () => {
      state.page = item.dataset.page;
      render();
    });
  });
  pageContent.querySelectorAll("[data-action]").forEach((item) => {
    item.addEventListener("click", () => handleAction(item.dataset.action, item));
  });
  pageContent.querySelectorAll("form").forEach((form) => {
    form.addEventListener("submit", (event) => handleFormSubmit(event, form));
  });
}

function pageMeta() {
  return PAGE_META[state.page] || PAGE_META.overview;
}

function targetLabel(target) {
  return {
    codex: "Codex",
    "claude-code": "Claude Code",
    "generic-env": "Generic CLI",
  }[target] || target || "CLI";
}

function sortedRouteBackends(route) {
  return (route?.backends || [])
    .map((backend, index) => ({ backend, index }))
    .sort((left, right) => {
      const leftPriority = Number.isFinite(Number(left.backend.priority))
        ? Number(left.backend.priority)
        : 100;
      const rightPriority = Number.isFinite(Number(right.backend.priority))
        ? Number(right.backend.priority)
        : 100;
      return leftPriority - rightPriority || left.index - right.index;
    })
    .map(({ backend }) => backend);
}

function suiteRouteBackend(route) {
  return (
    sortedRouteBackends(route).find((backend) => backend.enabled !== false) ||
    sortedRouteBackends(route)[0] ||
    null
  );
}

function configurationSuites(config) {
  return entries(config.bindings).map(([bindingId, binding]) => {
    const virtualProvider = config.virtualProviders?.[binding.virtualProvider] || {};
    const route = config.routes?.[virtualProvider.route] || {};
    const routeBackend = suiteRouteBackend(route);
    const upstreamId = routeBackend?.upstream || null;
    const upstream = upstreamId ? config.upstreams?.[upstreamId] || null : null;
    const modelIdSet = new Set(virtualProvider.allowedModels || []);
    for (const modelId of routeBackend?.models || []) {
      modelIdSet.add(modelId);
    }
    if (!modelIdSet.size) {
      for (const modelId of Object.keys(config.models || {})) modelIdSet.add(modelId);
    }
    const modelIds = [...modelIdSet].filter((id) => config.models?.[id]);
    const name =
      binding.name ||
      virtualProvider.name ||
      `${targetLabel(binding.target)} / ${upstream?.name || upstreamId || "未配置上游"}`;
    return {
      id: bindingId,
      bindingId,
      name,
      target: binding.target,
      binding,
      virtualProvider,
      route,
      routeBackend,
      upstreamId,
      upstream,
      modelIds,
      models: modelIds.map((id) => ({ id, profile: config.models[id] })),
    };
  });
}

function selectedSuite() {
  return configurationSuites(state.draft || {}).find(
    (suite) => suite.id === state.selected.suite,
  ) || null;
}

function selectSuite(id) {
  const suite = configurationSuites(state.draft || {}).find((item) => item.id === id);
  state.selected.suite = id || null;
  if (!suite) return;
  state.selected.binding = suite.bindingId;
  state.selected.virtualProvider = suite.binding.virtualProvider;
  state.selected.route = suite.virtualProvider.route;
  state.selected.upstream = suite.upstreamId;
  state.selected.model = suite.modelIds[0] || null;
}

function suiteHealth(suite) {
  if (suite.virtualProvider?.enabled === false) {
    return { label: "paused", className: "warning" };
  }
  const runtimeProvider = state.runtime?.virtualProviders?.find(
    (item) => item.id === suite.virtualProvider?.id,
  );
  if (runtimeProvider?.status === "not_listening") {
    return { label: "not listening", className: "danger" };
  }
  const health = suite.upstreamId ? state.runtime?.health?.[suite.upstreamId] : null;
  if (health?.outcome === "failure") return { label: "unhealthy", className: "danger" };
  if (health?.outcome === "success") return { label: "healthy", className: "" };
  if (!suite.upstream) return { label: "incomplete", className: "warning" };
  if (!upstreamSecretConfigured(suite.upstreamId, suite.upstream)) {
    return { label: "needs key", className: "warning" };
  }
  return { label: "ready", className: "" };
}

function suiteEndpoint(suite) {
  const provider = suite.virtualProvider;
  if (!provider?.listenPort) return "尚未创建本地 endpoint";
  return `http://${provider.listenHost || "127.0.0.1"}:${provider.listenPort}/v1`;
}

function suiteRow(suite) {
  const health = suiteHealth(suite);
  const pendingSecret = hasPendingUpstreamSecret(suite.upstreamId);
  const healthLabel = pendingSecret && health.label === "ready" ? "key staged" : health.label;
  return `
    <button class="suite-row" data-action="open-suite" data-id="${esc(suite.id)}">
      <div class="suite-row-main">
        <div class="suite-row-kicker">${esc(targetLabel(suite.target))} · ${esc(suite.upstream?.name || suite.upstreamId || "未配置上游")}</div>
        <h3>${esc(suite.name)}</h3>
        <p>${suite.modelIds.length} 个客户端模型 · 单上游本地接入</p>
      </div>
      <div class="suite-row-side">
        <span class="suite-endpoint mono">${esc(suiteEndpoint(suite))}</span>
        <span class="status-badge ${health.className}">${esc(healthLabel)}</span>
      </div>
    </button>
  `;
}

function renderOverview() {
  const config = state.draft;
  const runtime = state.runtime || {};
  const counts = runtime.counts || {};
  const suites = configurationSuites(config);
  const events = state.events.slice(0, 5);
  const displayCounts = state.dirty
    ? {
        models: Object.keys(config.models || {}).length,
        upstreams: Object.keys(config.upstreams || {}).length,
        virtualProviders: Object.keys(config.virtualProviders || {}).length,
      }
    : counts;
  return `
    <div class="hero-strip">
      <div>
        <p class="eyebrow">LOCAL CONFIGURATION SETS</p>
        <h2>一套配置，负责一条 CLI 接入链路。</h2>
        <p>把一个上游、一组客户端模型映射和一个本地 CLI 接入放在一起管理。CableTidy 吸收上游地址、模型名和能力差异，客户端只连接本地 endpoint。</p>
      </div>
      <div class="hero-aside">
        <span class="hero-aside-label">ACTIVE REVISION</span>
        <span class="hero-aside-value">${esc(config.revision)}</span>
        <span class="status-badge">${suites.length} 套配置</span>
      </div>
    </div>
    <div class="suite-toolbar">
      <div>
        <div class="panel-title-label">CONFIGURATION SETS</div>
        <h2>我的接入套装</h2>
        <p>模型映射和路由属于同一套接入方案；底层 Route 由 CableTidy 自动维护。</p>
      </div>
      <button class="button button-primary" data-action="create-suite">创建配置套装</button>
    </div>
    ${
      suites.length
        ? `<div class="suite-list">${suites.map(suiteRow).join("")}</div>`
        : `<div class="panel empty-state-panel"><div class="empty"><strong>还没有配置套装</strong><span>从一个上游、一组客户端模型映射和一个 CLI 接入开始。</span><div class="form-actions"><button class="button button-primary" data-action="create-suite">开始创建</button></div></div></div>`
    }
    <div class="stat-grid">
      ${stat("配置套装", suites.length)}
      ${stat("客户端模型", displayCounts.models ?? Object.keys(config.models).length)}
      ${stat("上游", displayCounts.upstreams ?? Object.keys(config.upstreams).length)}
      ${stat("本地服务", displayCounts.virtualProviders ?? Object.keys(config.virtualProviders).length)}
      ${stat("运行版本", config.revision)}
    </div>
    <div class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title-label">RECENT EVENTS</div>
          <h2>最近活动</h2>
        </div>
        <button class="mini-button" data-page="diagnostics">打开诊断</button>
      </div>
      <div class="panel-body">
        ${
          events.length
            ? `<div class="list">${events.map(eventRow).join("")}</div>`
            : `<div class="empty"><strong>还没有事件</strong><span>提交配置或测试上游后，运行轨迹会出现在这里。</span></div>`
        }
      </div>
    </div>
  `;
}

function suiteModelEditor(suite, modelId, profile, upstreamId) {
  const model = profile || {};
  const isCodex = suite.target === "codex";
  const compact = model.compact || {};
  const upstream = state.draft.upstreams?.[upstreamId] || {};
  const binding = model.upstreams?.[upstreamId] || {};
  const mappingRows = upstreamId
    ? `
        <div class="suite-binding-row" data-suite-model-binding="${esc(upstreamId)}">
          <div class="suite-binding-name">
            <span class="route-rank">上游</span>
            <span><strong>${esc(upstream.name || upstreamId || "未选择上游")}</strong><small>${esc(upstreamId || "upstream")}</small></span>
          </div>
          <input data-suite-model-upstream="${esc(upstreamId)}" value="${esc(binding.upstreamModelId || "")}" placeholder="上游模型 ID" />
          ${isCodex ? "" : `<input data-suite-model-capabilities="${esc(upstreamId)}" value="${esc((binding.capabilityOverrides || []).join(", "))}" placeholder="能力覆盖，可留空" />`}
        </div>
      `
    : `<div class="empty">还没有配置上游</div>`;
  return `
    <article class="suite-model-card" data-suite-model data-model-id="${esc(modelId)}">
      <div class="suite-model-card-header">
        <div>
          <span class="panel-title-label">MODEL PROFILE</span>
          ${isCodex
            ? officialModelSelect("data-suite-model-client", model.clientModelId || model.aliases?.[0] || "")
            : `<input class="suite-model-client-input" data-suite-model-client value="${esc(model.clientModelId || model.aliases?.[0] || modelId)}" placeholder="客户端模型 ID" />`}
        </div>
        <button class="mini-button" type="button" data-action="remove-suite-model">移除</button>
      </div>
      <div class="form-grid suite-model-policy">
        ${isCodex ? codexMetadataFields(model) : `
        <div class="field full"><label>Capabilities</label><input data-suite-model-capabilities-common value="${esc((model.capabilities || ["streaming", "tools", "reasoning"]).join(", "))}" placeholder="streaming, tools, reasoning" /></div>
        <div class="field"><label>Context window</label><input type="number" data-suite-model-context value="${esc(model.contextWindow ?? 1000000)}" placeholder="tokens" /></div>
        <div class="field"><label>Compact strategy</label><select data-suite-model-compact>${optionList(["auto", "manual", "disabled"], compact.strategy || "auto")}</select></div>
        <div class="field"><label>Compact token limit</label><input type="number" data-suite-model-compact-limit value="${esc(compact.tokenLimit ?? 850000)}" placeholder="tokens" /></div>
        `}
      </div>
      <div class="suite-binding-section">
        <div class="subsection-header"><h3>上游模型映射</h3><span class="field-hint">当前套装只连接一个上游</span></div>
        <div class="suite-binding-list">${mappingRows}</div>
      </div>
    </article>
  `;
}

function officialModel(id) {
  return state.codexCatalog?.models?.find((model) => model.id === id);
}

function officialModelSelect(attributes, selected) {
  const models = state.codexCatalog?.models || [];
  const unknown = selected && !officialModel(selected);
  return `<div class="field"><label>Codex 官方模型</label><select ${attributes} data-official-model required>
    <option value="">选择官方模型</option>
    ${unknown ? `<option value="${esc(selected)}" selected>${esc(selected)}（旧配置，待确认）</option>` : ""}
    ${models.map((model) => `<option value="${esc(model.id)}" ${selected === model.id ? "selected" : ""}>${esc(model.name)} (${esc(model.id)})</option>`).join("")}
    </select>${unknown ? `<span class="field-hint">未匹配本机官方目录</span>` : ""}</div>`;
}

function codexCatalogStatus() {
  return `<div class="catalog-status"><span>${esc(state.codexCatalog?.available
    ? `${state.codexCatalog.version} / ${state.codexCatalog.models.length} 个官方模型`
    : state.codexCatalog?.error?.message || "官方模型目录不可用")}</span>
    <button class="mini-button" type="button" data-action="refresh-codex-models">刷新目录</button></div>`;
}

function codexMetadataFields(model) {
  const definition = officialModel(model.clientModelId);
  const override = model.codex?.metadataMode === "override";
  const vision = override ? model.codex.inputModalities?.includes("image") ?? definition?.inputModalities.includes("image") : definition?.inputModalities.includes("image");
  return `
    <div class="field"><label>模型元数据</label><select data-codex-metadata-mode>
      <option value="official" ${!override ? "selected" : ""}>沿用官方定义</option>
      <option value="override" ${override ? "selected" : ""}>覆盖上游限制</option>
    </select></div>
    <div class="field"><label>Context window</label><input data-suite-model-context type="number" min="1" max="${esc(definition?.maxContextWindow || "")}" value="${esc(override ? model.contextWindow ?? "" : definition?.contextWindow ?? "")}" placeholder="沿用官方" ${override ? "" : "disabled"} /></div>
    <label class="field checkbox-field"><span><input data-codex-vision type="checkbox" ${vision ? "checked" : ""} ${override && definition?.inputModalities.includes("image") ? "" : "disabled"} /> 图片输入</span></label>
    <div class="field"><label>基础提示词</label><span class="field-hint" data-codex-instructions>${esc(definition?.name || "待选择官方模型")} / 官方定义</span></div>
    ${!model.codex && (model.contextWindow || model.compact) ? `<div class="notice warning full">旧策略尚未同步：context window ${esc(model.contextWindow || "未设置")}；compact ${esc(model.compact?.strategy || "未设置")} ${esc(model.compact?.tokenLimit || "")}。Compact 仍由 Codex 管理。</div>` : model.compact ? `<div class="field full"><span class="field-hint">旧 Compact 策略已保留，未同步到 Codex</span></div>` : ""}
  `;
}

pageContent.addEventListener("change", (event) => {
  const row = event.target.closest("[data-suite-model]");
  if (!row || !row.querySelector("[data-codex-metadata-mode]")) return;
  if (!event.target.matches("[data-official-model], [data-codex-metadata-mode]")) return;
  const definition = officialModel(row.querySelector("[data-suite-model-client]").value);
  const override = row.querySelector("[data-codex-metadata-mode]").value === "override";
  const context = row.querySelector("[data-suite-model-context]");
  const vision = row.querySelector("[data-codex-vision]");
  if (event.target.matches("[data-official-model]") || !override) {
    context.value = definition?.contextWindow || "";
    vision.checked = Boolean(definition?.inputModalities.includes("image"));
  }
  context.max = definition?.maxContextWindow || "";
  context.disabled = !override;
  vision.disabled = !override || !definition?.inputModalities.includes("image");
  row.querySelector("[data-codex-instructions]").textContent = `${definition?.name || "待选择官方模型"} / 官方定义`;
});

function codexModelFields(clientModelId, existing = {}, row) {
  const definition = officialModel(clientModelId);
  if (!definition) throw new Error("请选择本机 Codex 目录中的官方 GPT 模型；旧模型需要先确认对应关系。");
  const mode = row?.querySelector("[data-codex-metadata-mode]")?.value || "official";
  const codex = { metadataMode: mode };
  const capabilities = [...definition.capabilities];
  let contextWindow = existing.contextWindow;
  if (mode === "override") {
    const value = row.querySelector("[data-suite-model-context]").value.trim();
    contextWindow = value ? Number(value) : undefined;
    if (value && (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || contextWindow > definition.maxContextWindow)) {
      throw new Error(`${clientModelId} 的上下文窗口必须在 1 到 ${definition.maxContextWindow} 之间`);
    }
    const vision = row.querySelector("[data-codex-vision]").checked && definition.inputModalities.includes("image");
    codex.inputModalities = vision ? ["text", "image"] : ["text"];
    if (!vision && capabilities.includes("vision")) capabilities.splice(capabilities.indexOf("vision"), 1);
  }
  return { codex, capabilities, contextWindow };
}

function renderSuiteDetail() {
  const suite = selectedSuite();
  if (!suite) {
    return `
      <div class="panel empty-state-panel">
        <div class="empty"><strong>找不到这套配置</strong><span>它可能已被删除，返回配置套装列表重新选择。</span><div class="form-actions"><button class="button button-primary" data-action="back-overview">返回配置套装</button></div></div>
      </div>
    `;
  }
  const health = suiteHealth(suite);
  const upstreamId = suite.upstreamId || "";
  const upstream = upstreamId ? state.draft.upstreams[upstreamId] : null;
  const binding = suite.binding;
  const provider = suite.virtualProvider;
  return `
    <div class="suite-detail-head">
      <button class="text-button" data-action="back-overview">← 配置套装</button>
      <div class="suite-detail-title">
        <div>
          <p class="eyebrow">${esc(targetLabel(suite.target))} / CONFIGURATION SET</p>
          <h2>${esc(suite.name)}</h2>
          <p>${esc(upstream?.name || upstreamId || "尚未配置上游")} · ${suite.modelIds.length} 个客户端模型</p>
        </div>
        <div class="suite-detail-status">
          <span class="status-badge ${health.className}">${esc(health.label)}</span>
          <span class="mono">${esc(suiteEndpoint(suite))}</span>
        </div>
      </div>
    </div>
    ${suite.target === "codex" ? codexCatalogStatus() : ""}
    <div class="suite-layout">
      <div class="panel suite-main-panel">
        <div class="panel-header">
          <div><div class="panel-title-label">MODEL MAPPING</div><h2>模型映射</h2><p>保留客户端模型展示、上游模型名称、能力和策略配置。</p></div>
          <button class="button button-primary" type="button" data-action="add-suite-model">添加模型</button>
        </div>
        <div class="panel-body">
          <form id="suite-models-form">
            <div id="suite-model-list" class="suite-model-list">
              ${
                suite.models.length
                  ? suite.models.map(({ id, profile }) => suiteModelEditor(suite, id, profile, upstreamId)).join("")
                  : `<div class="empty"><strong>还没有模型</strong><span>添加至少一个客户端模型，再填写它对应的上游模型 ID。</span></div>`
              }
            </div>
            <div class="form-actions">
              <button class="button button-primary" type="submit">保存模型映射</button>
              ${suite.target === "codex" ? "" : `<button class="button" type="button" data-action="open-advanced-models">高级模型设置</button>`}
            </div>
          </form>
        </div>
      </div>
      <div class="suite-side">
        <div class="panel">
          <div class="panel-header"><div><div class="panel-title-label">UPSTREAM</div><h2>上游连接</h2><p>地址和上游 API Key 由 CableTidy 保存，不会出现在 Codex 配置中。</p></div></div>
          <div class="panel-body">
            ${
              upstream
                ? `
                  <form id="suite-upstream-form">
                    <input type="hidden" name="id" value="${esc(upstreamId)}" />
                    <input type="hidden" name="protocol" value="${esc(upstream.protocol || "openai.responses")}" />
                    <input type="hidden" name="authHeader" value="${esc(upstream.auth?.header || "authorization")}" />
                    <div class="form-grid">
                      ${field("显示名称", "name", upstream.name || upstreamId, "例如 Relay A", true)}
                      ${field("真实上游地址", "baseUrl", upstream.baseUrl || "", "https://relay.example.com/v1", true)}
                      ${field("上游 API Key", "secret", "", upstreamSecretConfigured(upstreamId, upstream) ? "已配置，留空表示不修改" : "粘贴上游 API Key", false, "password")}
                      ${field("上游 env key（可选）", "envKey", upstream.envKey || "", "仅在 daemon 从环境变量读取时填写", false)}
                    </div>
                    <div class="form-actions"><button class="button button-primary" type="submit">保存上游</button><button class="button" type="button" data-action="test-upstream" data-id="${esc(upstreamId)}">测试连通性</button></div>
                  </form>
                `
                : `<div class="empty"><strong>还没有上游</strong><span>请先添加一个上游，模型映射才能生效。</span><div class="form-actions"><button class="button button-primary" data-action="new-upstream">添加上游</button></div></div>`
            }
          </div>
        </div>
        <div class="panel">
          <div class="panel-header"><div><div class="panel-title-label">CLI ACCESS</div><h2>${esc(targetLabel(binding.target))} 接入</h2><p>客户端只看到本地 Virtual Provider 和 CableTidy 定义的模型名。</p></div></div>
          <div class="panel-body">
            <div class="suite-facts">
              <div><span>Local endpoint</span><strong class="mono">${esc(suiteEndpoint(suite))}</strong></div>
              <div><span>Provider ID</span><strong class="mono">${esc(`cabletidy_${safeProviderId(binding.name, safeProviderId(binding.id))}`)}</strong></div>
              <div><span>本地认证</span><strong>无需 API Key</strong></div>
              <div><span>Models endpoint</span><strong class="mono">GET /v1/models</strong></div>
            </div>
            <div class="form-actions"><button class="button ${provider.enabled === false ? "button-primary" : ""}" type="button" data-action="toggle-vp" data-id="${esc(provider.id)}">${provider.enabled === false ? "启动 Virtual Provider" : "暂停 Virtual Provider"}</button><button class="button" type="button" data-action="preview-artifacts">预览 CLI 配置</button>${binding.target === "codex" ? `<button class="button button-primary" type="button" data-action="apply-target">应用 Codex 配置</button>` : ""}</div>
            ${state.artifactPreview ? artifactPanel(state.artifactPreview) : ""}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSetupWizard() {
  const defaults = wizardDefaults();
  return `
    <button class="text-button" data-action="back-overview">← 返回配置套装</button>
    <div class="wizard-intro">
      <div>
        <p class="eyebrow">FIRST RUN / CABLETIDY CONFIGURATION</p>
        <h2>把上游接入 CableTidy，而不是把复杂度交给 Codex。</h2>
        <p>Codex 官方 GPT 模型接入</p>
      </div>
      <div class="wizard-callout">
        <span class="wizard-callout-label">REFERENCE ONLY</span>
        <strong>Codex Native Provider Integration</strong>
        <span>是上游提供的使用教程，不需要导入，也不会成为 CableTidy 的配置文件。</span>
      </div>
    </div>
    <form id="wizard-form" class="wizard">
      <section class="wizard-step">
        <div class="wizard-step-marker">01</div>
        <div class="wizard-step-content">
          <div class="wizard-step-heading"><div><span class="panel-title-label">CONFIGURATION SET</span><h2>先给这套接入起个名字</h2><p>套装名称只用于管理台展示。一个套装包含一个 CLI、一个上游、一组模型映射和一条由 CableTidy 自动维护的本地接入链路。</p></div><span class="wizard-status">optional</span></div>
          <div class="form-grid">
            ${field("套装名称", "suiteName", "", "例如 Codex / Relay A", true)}
            ${selectField("CLI 类型", "target", "codex", ["codex"])}
          </div>
          <div class="wizard-step-heading wizard-substep-heading"><div><span class="panel-title-label">UPSTREAM CONNECTION</span><h2>连接上游</h2><p>只需要填写真实地址和 API Key。当前 Codex Native Provider 固定使用 OpenAI Responses 接入方式，认证 header、env key 和重试策略由 CableTidy 自动处理。</p></div><span class="wizard-status">2 fields</span></div>
          <div class="form-grid">
            ${field("真实上游地址", "upstreamBaseUrl", "", "https://relay.example.com/v1", true)}
            ${field("上游 API Key", "upstreamSecret", "", "粘贴上游密钥", false, "password")}
          </div>
          <div class="notice">API Key 由 CableTidy 保存在本地 secrets store，并由 daemon 出站请求使用；不需要再填写或配置上游 env key。</div>
        </div>
      </section>
      <section class="wizard-step">
        <div class="wizard-step-marker">02</div>
        <div class="wizard-step-content">
          <div class="wizard-step-heading"><div><span class="panel-title-label">MODEL PROFILES</span><h2>模型映射</h2></div></div>
          ${codexCatalogStatus()}
          <div class="subsection wizard-model-section">
            <div class="subsection-header">
              <div><h3>客户端模型列表</h3><span class="field-hint">例如 <span class="mono">gpt-5.6-sol</span> → <span class="mono">XXX-GPT-5.6-Sol</span>，可按需添加多个模型</span></div>
              <button class="mini-button" type="button" data-action="add-wizard-model">添加模型</button>
            </div>
            <div id="wizard-model-list" class="wizard-model-list">
              ${wizardModelRow()}
            </div>
          </div>
        </div>
      </section>
      <section class="wizard-step">
        <div class="wizard-step-marker">03</div>
        <div class="wizard-step-content">
          <div class="wizard-step-heading"><div><span class="panel-title-label">LOCAL CODEX SERVICE</span><h2>本地服务自动创建</h2><p>这一步不需要填写。CableTidy 会自动创建 loopback Virtual Provider、模型列表、单上游 Route 和 Codex Binding。</p></div><span class="wizard-status">automatic</span></div>
          <div class="wizard-auto-config">
            <div><span>Virtual Provider</span><strong>${esc(defaults.virtualProviderId)}</strong></div>
            <div><span>Local endpoint</span><strong>http://127.0.0.1:${esc(defaults.listenPort)}/v1</strong></div>
            <div><span>Codex provider</span><strong>${esc(`cabletidy_${safeProviderId(suite.binding?.name, safeProviderId(suite.bindingId))}`)}</strong></div>
          </div>
        </div>
      </section>
      <div class="wizard-footer">
        <div><strong>完成后会创建一张配置图</strong><span>Upstream → Model Profiles → 单上游 Route → Virtual Provider → Codex Binding</span></div>
        <button class="button button-primary button-large" type="submit">创建 CableTidy 配置</button>
      </div>
    </form>
  `;
}

function wizardModelRow(values = {}) {
  const model = {
    clientModelId: values.clientModelId || "",
    upstreamModelId: values.upstreamModelId || "",
  };
  return `
    <div class="wizard-model-row" data-wizard-model>
      <div class="wizard-model-row-header">
        <strong>MODEL</strong>
        <button class="mini-button" type="button" data-action="remove-wizard-model">移除</button>
      </div>
      <div class="form-grid">
        ${officialModelSelect('data-wizard-field="clientModelId"', model.clientModelId)}
        ${wizardField("上游模型 ID", "upstreamModelId", model.upstreamModelId, "发送给上游的真实模型名")}
      </div>
    </div>
  `;
}

function wizardField(label, key, value, placeholder = "", full = false) {
  return `<div class="field ${full ? "full" : ""}"><label>${esc(label)}</label><input data-wizard-field="${esc(key)}" value="${esc(value)}" placeholder="${esc(placeholder)}" /></div>`;
}

function wizardDefaults() {
  const upstreamId = nextWizardId(state.draft?.upstreams, "relay-main");
  const virtualProviderId = nextWizardId(state.draft?.virtualProviders, "codex-main");
  const routeId = nextWizardId(state.draft?.routes, `${upstreamId}-route`);
  const usedPorts = new Set([
    Number(state.draft?.web?.port),
    ...values(state.draft?.virtualProviders).map((item) => Number(item.listenPort)),
  ]);
  let listenPort = Number(state.draft?.daemon?.proxyPortRange?.split("-")[0]) || 43101;
  while (usedPorts.has(listenPort)) listenPort += 1;
  return { upstreamId, virtualProviderId, routeId, listenPort };
}

function nextWizardId(record, base) {
  const source = record || {};
  if (!source[base]) return base;
  let suffix = 2;
  while (source[`${base}-${suffix}`]) suffix += 1;
  return `${base}-${suffix}`;
}

function modelProfileId(clientModelId, existingModels, reservedIds) {
  const normalized = String(clientModelId || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 56) || "model";
  const occupiedIds = new Set([...Object.keys(existingModels || {}), ...reservedIds]);
  let id = normalized;
  let suffix = 2;
  while (occupiedIds.has(id)) id = `${normalized}-${suffix++}`;
  reservedIds.add(id);
  return id;
}

function wizardUpstreamName(baseUrl, fallback) {
  try {
    return new URL(baseUrl).hostname || fallback;
  } catch {
    return fallback;
  }
}

function renderUpstreams() {
  const config = state.draft;
  const selectedId = state.selected.upstream;
  const selected = selectedId ? config.upstreams[selectedId] : null;
  const integrationLabel = selected?.integration === "codex-native-provider"
    ? "Codex Native Provider Integration"
    : "Native upstream connection";
  return `
    <div class="notice">MVP 支持 <strong>Codex Native Provider Integration</strong>，当前配置由本页面直接写入 CableTidy。</div>
    <div class="form-layout">
      <div class="panel">
        <div class="panel-header">
          <div><div class="panel-title-label">UPSTREAM REGISTRY</div><h2>已接入的上游</h2><p>每一个 key 或账号都可以独立统计健康状态，并由内部 Route 连接到对应的本地服务。</p></div>
          <button class="button button-primary" data-action="new-upstream">新增 upstream</button>
        </div>
        <div class="panel-body">
          ${
            Object.keys(config.upstreams).length
              ? `<div class="list">${entries(config.upstreams).map(([id, item]) => upstreamRow(id, item, id === selectedId)).join("")}</div>`
              : `<div class="empty"><strong>还没有 upstream</strong><span>直接填写 CableTidy 的上游地址、认证和 wire protocol。</span><div class="form-actions"><button class="button button-primary" data-action="start-wizard">开始配置向导</button></div></div>`
          }
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <div><div class="panel-title-label">${selected ? "EDIT UPSTREAM" : "NEW UPSTREAM"}</div><h2>${selected ? esc(selected.name || selectedId) : "添加上游"}</h2><p>密钥只提交给 daemon，不会在配置 GET 或模型页面中回显。</p></div>
        </div>
        <div class="panel-body">
          <form id="upstream-form">
            <div class="form-grid">
              ${field("Upstream ID", "id", selectedId || "", "例如 relay-main", false, "text", Boolean(selectedId))}
              ${field("显示名称", "name", selected?.name || "", "例如 xxx")}
              <div class="field"><label>上游接入方式</label><div class="static-field"><strong>${integrationLabel}</strong><span>由 CableTidy 直接填写和管理</span></div></div>
              ${selectField("上游协议", "protocol", selected?.protocol || "openai.responses", ["openai.responses", "openai.chat_completions", "anthropic.messages"])}
              ${field("真实 base URL", "baseUrl", selected?.baseUrl || "", "https://relay.example.com/v1", true)}
              ${field("API key", "secret", "", upstreamSecretConfigured(selectedId, selected) ? "已配置，留空表示不修改" : "粘贴上游 API key", false, "password")}
              ${field("上游 env_key（可选）", "envKey", selected?.envKey || "", "仅在 daemon 从环境变量读取时填写")}
              ${field("上游认证 header", "authHeader", selected?.auth?.header || selected?.authHeader || (selected?.protocol === "anthropic.messages" ? "x-api-key" : "authorization"), "authorization 或 x-api-key")}
              ${field("request retries", "requestMaxRetries", selected?.requestMaxRetries ?? 5, "5")}
              ${field("stream retries", "streamMaxRetries", selected?.streamMaxRetries ?? 5, "5")}
              ${field("stream idle timeout (ms)", "streamIdleTimeoutMs", selected?.streamIdleTimeoutMs ?? 300000, "300000")}
              ${checkboxField("requires_openai_auth", "requiresOpenaiAuth", Boolean(selected?.requiresOpenaiAuth))}
              ${checkboxField("supports_websockets", "supportsWebsockets", Boolean(selected?.supportsWebsockets))}
            </div>
            <div class="notice">基础转发只需要 base URL、API key、协议和模型映射。env key、认证 header、重试、超时和 WebSocket 选项属于高级运行策略，通常不需要修改。</div>
            <div class="form-actions"><button class="button button-primary" type="submit">保存到草稿</button>${selected ? `<button class="button" type="button" data-action="test-upstream" data-id="${esc(selectedId)}">测试连通性</button><button class="button button-danger" type="button" data-action="delete-upstream" data-id="${esc(selectedId)}">删除</button>` : ""}</div>
          </form>
        </div>
      </div>
    </div>
  `;
}

function renderModels() {
  const config = state.draft;
  const selectedId = state.selected.model;
  const selected = selectedId ? config.models[selectedId] : null;
  const compact = selected?.compact || {};
  const mappings = entries(config.upstreams)
    .map(([id]) => {
      const mapping = selected?.upstreams?.[id];
      return `<div class="mapping-row"><div class="field"><label>UPSTREAM</label><span class="mono">${esc(id)}</span></div><div class="field"><label>UPSTREAM MODEL ID</label><input data-model-upstream="${esc(id)}" value="${esc(mapping?.upstreamModelId || "")}" placeholder="真实上游模型名" /><input class="mapping-capabilities" data-model-upstream-capabilities="${esc(id)}" value="${esc((mapping?.capabilities || []).join(", "))}" placeholder="能力覆盖，可留空" /></div><button class="mini-button" type="button" data-action="focus-upstream" data-id="${esc(id)}">查看</button></div>`;
    })
    .join("");
  return `
    <div class="notice">Client model ID、aliases、能力和 upstream model ID 参与模型解析与转发；context window 和 compact 是 CableTidy 的策略元数据。reasoning effort 由 CLI 请求自行选择。</div>
    <div class="form-layout">
      <div class="panel">
        <div class="panel-header">
          <div><div class="panel-title-label">MODEL REGISTRY</div><h2>逻辑模型</h2><p>alias、能力和 upstream binding 都在 CableTidy 管理。</p></div>
          <button class="button button-primary" data-action="new-model">新增模型</button>
        </div>
        <div class="panel-body">
          ${
            Object.keys(config.models).length
              ? `<div class="list">${entries(config.models).map(([id, item]) => modelRow(id, item, id === selectedId)).join("")}</div>`
              : `<div class="empty"><strong>还没有 Model Profile</strong><span>先添加 upstream，再给客户端定义一个稳定的模型名称。</span></div>`
          }
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><div><div class="panel-title-label">${selected ? "EDIT MODEL PROFILE" : "NEW MODEL PROFILE"}</div><h2>${selected ? esc(selected.name || selectedId) : "建立模型身份"}</h2><p>左边是客户端看到的名字，右边是每个 upstream 的真实名字。</p></div></div>
        <div class="panel-body">
          <form id="model-form">
            <div class="form-grid">
              ${field("CableTidy Model ID", "id", selectedId || "", "例如 gpt56-sol", false, "text", Boolean(selectedId))}
              ${field("Client model ID", "clientModelId", selected?.clientModelId || selected?.aliases?.[0] || "", "Codex 请求里的 model")}
              ${field("Aliases", "aliases", (selected?.aliases || []).join(", "), "son, codex-default")}
              ${field("Family", "family", selected?.family || "codex", "codex")}
              ${field("Capabilities", "capabilities", (selected?.capabilities || ["streaming", "tools", "reasoning"]).join(", "), "streaming, tools, reasoning", true)}
              ${field("Context window", "contextWindow", selected?.contextWindow ?? 1000000, "tokens")}
              ${selectField("Compact strategy", "compactStrategy", compact.strategy || "auto", ["auto", "manual", "disabled"])}
              ${field("Compact token limit", "compactTokenLimit", compact.tokenLimit ?? 850000, "tokens")}
            </div>
            <div class="subsection">
              <div class="subsection-header"><h3>Upstream Model Bindings</h3><span class="field-hint">每个 upstream 可以有不同的真实模型名</span></div>
              <div class="mapping-list">${mappings || `<div class="empty">先添加 upstream</div>`}</div>
            </div>
            <div class="form-actions"><button class="button button-primary" type="submit">保存到草稿</button>${selected ? `<button class="button button-danger" type="button" data-action="delete-model" data-id="${esc(selectedId)}">删除</button>` : ""}</div>
          </form>
        </div>
      </div>
    </div>
  `;
}

function renderRoutes() {
  const config = state.draft;
  const selectedId = state.selected.route;
  const selected = selectedId ? config.routes[selectedId] : null;
  if (state.routeDraftBackends === null || state.routeDraftBackends.routeId !== selectedId) {
    state.routeDraftBackends = { routeId: selectedId, items: clone(selected?.backends || []) };
  }
  const backendRows = state.routeDraftBackends.items
    .map(
      (backend, index) => `
        <div class="backend-row" data-backend-index="${index}">
          <div class="field"><label>UPSTREAM</label><select data-backend-upstream>${selectOptions(config.upstreams, backend.upstream, "选择 upstream")}</select></div>
          <div class="field"><label>MODEL PROFILES</label><input data-backend-models value="${esc((backend.models || []).join(", "))}" placeholder="codex-gpt56-sol" /></div>
          <div class="field"><label>PRIORITY</label><input data-backend-priority type="number" value="${esc(backend.priority ?? 10)}" /></div>
          <button class="mini-button" type="button" data-action="remove-backend" data-index="${index}">移除</button>
        </div>
      `,
    )
    .join("");
  return `
    <div class="notice">MVP 先实现 priority 主备。只有在首字节之前失败时才会切换 upstream；流开始之后，响应会固定在已选中的 backend。</div>
    <div class="form-layout">
      <div class="panel">
        <div class="panel-header"><div><div class="panel-title-label">ROUTE TABLE</div><h2>路由策略</h2><p>一个 route 可以复用多个 upstream，也可以同时承载多个 Model Profile。</p></div><button class="button button-primary" data-action="new-route">新增 route</button></div>
        <div class="panel-body">
          ${
            Object.keys(config.routes).length
              ? `<div class="list">${entries(config.routes).map(([id, item]) => routeRow(id, item, id === selectedId)).join("")}</div>`
              : `<div class="empty"><strong>还没有 route</strong><span>route 是 Virtual Provider 和 upstream 之间的选择策略。</span></div>`
          }
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><div><div class="panel-title-label">${selected ? "EDIT ROUTE" : "NEW ROUTE"}</div><h2>${selected ? esc(selected.name || selectedId) : "建立一条路径"}</h2><p>模型映射会在 route 选择前参与过滤。</p></div></div>
        <div class="panel-body">
          <form id="route-form">
            <div class="form-grid">
              ${field("Route ID", "id", selectedId || "", "例如 codex-default", false, "text", Boolean(selectedId))}
              ${field("显示名称", "name", selected?.name || "", "Codex default")}
              ${selectField("Strategy", "strategy", selected?.strategy || "priority", ["priority"])}
            </div>
            <div class="subsection">
              <div class="subsection-header"><h3>Backends</h3><button class="mini-button" type="button" data-action="add-backend">添加 backend</button></div>
              <div class="backend-list">${backendRows || `<div class="empty">至少添加一个 backend</div>`}</div>
            </div>
            <div class="form-actions"><button class="button button-primary" type="submit">保存到草稿</button>${selected ? `<button class="button button-danger" type="button" data-action="delete-route" data-id="${esc(selectedId)}">删除</button>` : ""}</div>
          </form>
        </div>
      </div>
    </div>
  `;
}

function renderTargets() {
  const config = state.draft;
  const vpId = state.selected.virtualProvider;
  const vp = vpId ? config.virtualProviders[vpId] : null;
  const bindingId = state.selected.binding;
  const binding = bindingId ? config.bindings[bindingId] : null;
  const boundVpId = binding?.virtualProvider || vpId;
  const boundVp = boundVpId ? config.virtualProviders[boundVpId] : null;
  const bindingTarget = binding?.target || "codex";
  const modelOptions = optionList(
    Object.keys(config.models),
    binding?.defaultModel || boundVp?.defaultModel,
  );
  return `
    <div class="notice">Managed Proxy 模式下，Codex 只需要本地 <span class="mono">model_provider</span>、client model 和 Virtual Provider 的 <span class="mono">base_url</span>。上游真实 URL、API Key、模型映射和能力差异都留在 CableTidy。</div>
    <div class="content-grid">
      <div class="panel">
        <div class="panel-header"><div><div class="panel-title-label">LOCAL VIRTUAL PROVIDERS</div><h2>本地服务</h2><p>每个协议使用自己的 listener。Codex MVP 必须提供 <span class="mono">GET /v1/models</span> 和 <span class="mono">POST /v1/responses</span>。</p></div><button class="button button-primary" data-action="new-vp">新增服务</button></div>
        <div class="panel-body">
          ${
            Object.keys(config.virtualProviders).length
              ? `<div class="list">${entries(config.virtualProviders).map(([id, item]) => virtualProviderRow(id, item, id === vpId)).join("")}</div>`
              : `<div class="empty"><strong>还没有本地服务</strong><span>创建它之后，Codex 才会有一个指向 CableTidy 的本地 base URL。</span></div>`
          }
          <div class="subsection">
            <form id="vp-form">
              <div class="subsection-header"><h3>${vp ? "编辑 Virtual Provider" : "新建 Virtual Provider"}</h3><span class="field-hint">${vp ? esc(vpId) : "local endpoint"}</span></div>
              <div class="form-grid">
                ${field("Provider ID", "id", vpId || "", "例如 codex-main", false, "text", Boolean(vpId))}
                ${field("显示名称", "name", vp?.name || "", "Codex main")}
                ${field("Listen host", "listenHost", vp?.listenHost || "127.0.0.1", "127.0.0.1")}
                ${field("Listen port", "listenPort", vp?.listenPort ?? 43101, "43101")}
                ${selectField("Ingress protocol", "ingressProtocol", vp?.ingressProtocol || "openai.responses", ["openai.responses", "anthropic.messages"])}
                ${selectField("Route", "route", vp?.route || "", Object.keys(config.routes))}
                <div class="field full"><label>Allowed Model Profiles</label><input name="allowedModels" value="${esc((vp?.allowedModels || []).join(", "))}" placeholder="codex-gpt56-sol, codex-gpt55" /></div>
                <div class="field full"><label>Default Model Profile</label><select name="defaultModel"><option value="">选择默认模型</option>${modelOptions}</select></div>
              </div>
              <div class="form-actions"><button class="button button-primary" type="submit">保存到草稿</button>${vp ? `<button class="button" type="button" data-action="toggle-vp" data-id="${esc(vpId)}">${vp.enabled === false ? "启动 Virtual Provider" : "暂停 Virtual Provider"}</button><button class="button button-danger" type="button" data-action="delete-vp" data-id="${esc(vpId)}">删除</button>` : ""}</div>
            </form>
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><div><div class="panel-title-label">TARGET BINDINGS</div><h2>CLI 配置生成</h2><p>Binding 决定目标 CLI 使用哪个本地 Virtual Provider，以及如何生成它的原生配置。</p></div><button class="button button-primary" data-action="new-binding">新增 binding</button></div>
        <div class="panel-body">
          ${
            Object.keys(config.bindings).length
              ? `<div class="list">${entries(config.bindings).map(([id, item]) => bindingRow(id, item, id === bindingId)).join("")}</div>`
              : `<div class="empty"><strong>还没有 binding</strong><span>创建一个 Target Binding，生成 Codex 需要的本地 config.toml 接入片段。</span></div>`
          }
          <div class="subsection">
            <form id="binding-form">
              <div class="subsection-header"><h3>${binding ? "编辑 Binding" : "新建 Binding"}</h3><span class="field-hint">${binding ? esc(bindingId) : "native client config"}</span></div>
              <div class="form-grid">
                ${field("Binding ID", "id", bindingId || "", "例如 codex-main", false, "text", Boolean(bindingId))}
                ${selectField("Target", "target", bindingTarget, ["codex", "claude-code", "generic-env"], "binding-target")}
                ${selectField("Virtual Provider", "virtualProvider", boundVpId || "", Object.keys(config.virtualProviders))}
                ${selectField("Mode", "mode", binding?.mode || "config", ["config", "run", "env"])}
                ${selectField("Default Model", "defaultModel", binding?.defaultModel || vp?.defaultModel || "", Object.keys(config.models))}
                ${bindingTarget === "codex" ? `<div class="field-hint full">Codex provider 将使用 cabletidy_ 加配置名称自动生成。</div>` : ""}
                ${bindingTarget === "claude-code" ? checkboxField("设置 ANTHROPIC_MODEL", "claudeSetModel", binding?.claude?.setModel !== false) : ""}
                ${bindingTarget === "generic-env" ? field("Generic env prefix", "envPrefix", binding?.env?.prefix || "CABLETIDY", "CABLETIDY") : ""}
              </div>
              <div class="form-actions"><button class="button button-primary" type="submit">保存到草稿</button>${binding ? `<button class="button" type="button" data-action="preview-artifacts">预览 Target 配置</button><button class="button" type="button" data-action="apply-target">${bindingTarget === "codex" ? "应用到 Codex" : "生成环境配置"}</button><button class="button button-danger" type="button" data-action="delete-binding" data-id="${esc(bindingId)}">删除</button>` : ""}</div>
            </form>
          </div>
          ${state.artifactPreview ? artifactPanel(state.artifactPreview) : ""}
        </div>
      </div>
    </div>
  `;
}

function renderDiagnostics() {
  const config = state.draft;
  const validation = state.validation;
  const resolveResult = state.resolveResult;
  return `
    <div class="content-grid">
      <div class="panel">
        <div class="panel-header"><div><div class="panel-title-label">SERVER-SIDE CHECKS</div><h2>配置诊断</h2><p>在 commit 前验证引用、端口、模型映射和 capability 约束。</p></div><button class="button button-primary" data-action="validate">验证当前草稿</button></div>
        <div class="panel-body">
          ${
            validation
              ? validationResult(validation)
              : `<div class="empty"><strong>还没有验证结果</strong><span>点击验证，查看当前草稿是否可以原子提交。</span></div>`
          }
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><div><div class="panel-title-label">MODEL RESOLVER</div><h2>模型解析测试</h2><p>模拟一个客户端模型名，检查它会被送到哪个 upstream。</p></div></div>
        <div class="panel-body">
          <form id="resolve-form">
            <div class="form-grid">
              ${selectField("Virtual Provider", "virtualProviderId", state.selected.virtualProvider || "", Object.keys(config.virtualProviders))}
              ${field("Client model ID", "model", "", "sonnet 或 codex-gpt56-sol")}
              ${checkboxField("stream", "stream", true)}
              ${checkboxField("reasoning", "reasoning", false)}
            </div>
            <div class="form-actions"><button class="button button-primary" type="submit">解析路径</button></div>
          </form>
          ${resolveResult ? resolveResultPanel(resolveResult) : ""}
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-header"><div><div class="panel-title-label">EVENT STREAM</div><h2>脱敏事件</h2><p>只记录路由和配置元数据，不记录 prompt、完整响应或任何 secret。</p></div><button class="mini-button" data-action="refresh">刷新</button></div>
      <div class="panel-body">${state.events.length ? `<div class="list">${state.events.map(eventRow).join("")}</div>` : `<div class="empty"><strong>暂无事件</strong><span>提交配置、测试 upstream 或执行一次本地请求后再回来查看。</span></div>`}</div>
    </div>
  `;
}

function stat(label, value) {
  return `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${esc(value)}</div></div>`;
}

function step(index, title, description) {
  return `<div class="step"><span class="step-index">${index}</span><div><h3>${title}</h3><p>${description}</p></div></div>`;
}

function upstreamRow(id, item, active = false) {
  const health = state.runtime?.health?.[id];
  const healthClass = health?.outcome === "failure" ? "danger" : health ? "" : "warning";
  const pendingSecret = hasPendingUpstreamSecret(id);
  const status = health?.outcome || (
    upstreamSecretConfigured(id, item)
      ? pendingSecret ? "key staged" : "ready"
      : "needs key"
  );
  return `<button class="list-row ${active ? "is-selected" : ""}" data-action="select-upstream" data-id="${esc(id)}"><div><h3>${esc(item.name || id)}</h3><p>${esc(item.protocol || "protocol")} · ${esc(item.baseUrl || "未设置")}</p></div><span class="status-badge ${healthClass}">${status}</span></button>`;
}

function hasPendingUpstreamSecret(id) {
  const value = state.secretDraft.upstreamSecrets?.[id];
  return typeof value === "string" && Boolean(value.trim());
}

function upstreamSecretConfigured(id, item) {
  return Boolean(item?.secretConfigured || hasPendingUpstreamSecret(id));
}

function modelRow(id, item, active = false) {
  const context = item.contextWindow ? `${item.contextWindow.toLocaleString()} ctx` : "context unset";
  const compact = item.compact?.tokenLimit ? `${item.compact.tokenLimit.toLocaleString()} compact` : "compact unset";
  return `<button class="list-row ${active ? "is-selected" : ""}" data-action="select-model" data-id="${esc(id)}"><div><h3>${esc(item.clientModelId || item.aliases?.[0] || id)}</h3><p>${esc(id)} · ${(item.capabilities || []).join(" · ")} · ${esc(context)} · ${esc(compact)}</p></div><span class="status-badge">${Object.keys(item.upstreams || {}).length} bindings</span></button>`;
}

function routeRow(id, item, active = false) {
  return `<button class="list-row ${active ? "is-selected" : ""}" data-action="select-route" data-id="${esc(id)}"><div><h3>${esc(item.name || id)}</h3><p>${esc(item.strategy || "priority")} · ${(item.backends || []).length} backends</p></div><span class="status-badge">${(item.backends || []).filter((backend) => backend.enabled !== false).length} active</span></button>`;
}

function virtualProviderRow(id, item, active = false) {
  const runtime = state.runtime?.virtualProviders?.find((entry) => entry.id === id);
  const status = item.enabled === false ? "paused" : runtime?.status || "not listening";
  const statusClass = status === "paused" || status === "not_listening" ? "warning" : "";
  return `<button class="list-row ${active ? "is-selected" : ""}" data-action="select-vp" data-id="${esc(id)}"><div><h3>${esc(item.name || id)}</h3><p>${esc(item.listenHost)}:${esc(item.listenPort)} · ${esc(item.ingressProtocol)}</p></div><span class="status-badge ${statusClass}">${esc(status)}</span></button>`;
}

function bindingRow(id, item, active = false) {
  const integration = item.integration === "codex-native-provider"
    ? "Codex Native Provider Integration"
    : item.target === "codex"
      ? "Codex local config"
      : "native target";
  return `<button class="list-row ${active ? "is-selected" : ""}" data-action="select-binding" data-id="${esc(id)}"><div><h3>${esc(id)}</h3><p>${esc(item.target)} · ${esc(integration)} · ${esc(item.virtualProvider || "no provider")}</p></div><span class="status-badge">${esc(item.mode || "config")}</span></button>`;
}

function eventRow(event) {
  return `<div class="list-row"><div><h3>${esc(event.type)}</h3><p>${esc(new Date(event.at).toLocaleString())} · ${esc(event.data?.upstreamId || event.data?.revision || "control")}</p></div><span class="table-meta">${esc(event.id)}</span></div>`;
}

function field(label, name, value, placeholder = "", full = false, type = "text", readonly = false) {
  return `<div class="field ${full ? "full" : ""}"><label>${esc(label)}</label><input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${readonly ? "readonly" : ""} /></div>`;
}

function selectField(label, name, value, items, dataClass = "") {
  return `<div class="field"><label>${esc(label)}</label><select name="${esc(name)}" ${dataClass ? `data-${esc(dataClass)}="true"` : ""}>${optionList(items, value)}</select></div>`;
}

function checkboxField(label, name, checked) {
  return `<label class="field checkbox-field"><span><input name="${esc(name)}" type="checkbox" ${checked ? "checked" : ""} /> ${esc(label)}</span></label>`;
}

function validationResult(result) {
  const errors = result.errors || [];
  const warnings = result.warnings || [];
  const diff = result.diff || {};
  const diffItems = [
    ...(diff.added || []).map((item) => `+ ${item.path}`),
    ...(diff.removed || []).map((item) => `- ${item.path}`),
    ...(diff.changed || []).map((item) => `~ ${item.path}`),
  ];
  return `
    <div class="notice ${result.ok ? "" : "warning"}">${result.ok ? "当前草稿可以提交。" : "当前草稿还不能提交。"}</div>
    ${errors.length ? `<div class="subsection"><h3>Errors</h3><ul class="error-list">${errors.map((item) => `<li><span class="mono">${esc(item.path)}</span> ${esc(item.message)}</li>`).join("")}</ul></div>` : ""}
    ${warnings.length ? `<div class="subsection"><h3>Warnings</h3><ul class="error-list">${warnings.map((item) => `<li><span class="mono">${esc(item.path)}</span> ${esc(item.message)}</li>`).join("")}</ul></div>` : ""}
    ${
      diffItems.length
        ? `<div class="subsection"><h3>Effective diff</h3><p class="field-hint">影响：${esc((diff.affected || []).join(", ") || "runtime")}</p><ul class="error-list diff-list">${diffItems.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>`
        : `<div class="subsection"><h3>Effective diff</h3><p class="field-hint">没有行为配置变化。</p></div>`
    }
  `;
}

function resolveResultPanel(result) {
  if (!result.ok) {
    return `<div class="subsection"><div class="notice warning">${esc(result.error?.message || "模型解析失败")}</div></div>`;
  }
  return `<div class="subsection"><div class="panel-title-label">RESOLVED PATH</div><pre class="code-preview">${esc(
    `client model  : ${result.clientModelId}\nprofile        : ${result.profileId}\nroute          : ${result.routeId}\nupstream       : ${result.upstreamId}\nupstream model : ${result.upstreamModelId}\ncapabilities   : ${(result.capabilities || []).join(", ")}`,
  )}</pre></div>`;
}

function artifactPanel(artifacts) {
  const title = artifacts.target === "claude-code"
    ? "Claude Code environment preview"
    : artifacts.target === "generic-env"
      ? "Generic environment preview"
      : "Codex local config.toml preview";
  const variables = Object.keys(artifacts.environment?.vars || {}).length
    ? `<div class="subsection"><div class="table-meta">ENVIRONMENT</div><pre class="code-preview">${esc(Object.entries(artifacts.environment.vars).map(([key, value]) => `${key}=${value}`).join("\n"))}</pre></div>`
    : "";
  return `
    <div class="subsection">
      <div class="subsection-header"><h3>${title}</h3><span class="field-hint">${esc(artifacts.mode || "managed_proxy")}</span></div>
      <div class="notice">Codex 只连接本地 Virtual Provider：<span class="mono">${esc(artifacts.virtualProviderId || "")}</span>。CableTidy 自己保存真实上游地址、API Key、模型映射、能力和路由策略。</div>
      ${artifacts.catalogSummary ? `<div class="field-hint">${esc(artifacts.catalogSummary.sourceVersion)} / ${artifacts.catalogSummary.mode === "managed" ? "生成模型目录" : "沿用当前 Codex 目录"}</div>` : ""}
      ${(artifacts.warnings || []).map((message) => `<div class="notice warning">${esc(message)}</div>`).join("")}
      ${(artifacts.files || []).map((file) => file.kind === "json"
        ? `<details class="subsection"><summary>${esc(file.path)}</summary><pre class="code-preview">${esc(file.contents)}</pre></details>`
        : `<div class="subsection"><div class="table-meta">${esc(file.path)}</div><pre class="code-preview">${esc(file.contents)}</pre></div>`).join("")}
      ${variables}
      ${artifacts.environment?.shell ? `<div class="subsection"><div class="table-meta">SETUP COMMAND</div><pre class="code-preview">${esc(artifacts.environment.shell)}</pre></div>` : ""}
    </div>
  `;
}

async function handleAction(action, element) {
  try {
    if (action === "refresh") {
      await refresh();
    } else if (action === "refresh-codex-models") {
      state.codexCatalog = await api("/codex/models?refresh=1");
      // Refresh choices without discarding unsaved form inputs or secrets.
      pageContent.querySelectorAll("[data-official-model]").forEach((select) => {
        const selected = select.value;
        const wrapper = document.createElement("div");
        wrapper.innerHTML = officialModelSelect("", selected);
        select.innerHTML = wrapper.querySelector("select").innerHTML;
      });
      pageContent.querySelectorAll(".catalog-status").forEach((status) => {
        status.querySelector("span").textContent = state.codexCatalog.available ? `${state.codexCatalog.version} / ${state.codexCatalog.models.length} 个官方模型` : state.codexCatalog.error.message;
      });
      toast(state.codexCatalog.available ? "模型目录已刷新。" : state.codexCatalog.error.message, !state.codexCatalog.available);
    } else if (action === "create-suite" || action === "start-wizard") {
      state.selected.suite = null;
      state.showWizard = false;
      state.page = "suite-create";
      render();
    } else if (action === "open-suite") {
      selectSuite(element.dataset.id);
      state.page = "suite-detail";
      render();
    } else if (action === "back-overview") {
      state.page = "overview";
      render();
    } else if (action === "select-upstream") {
      state.selected.upstream = element.dataset.id;
      state.page = "upstreams";
      render();
    } else if (action === "select-model") {
      state.selected.model = element.dataset.id;
      state.page = "models";
      render();
    } else if (action === "select-route") {
      state.selected.route = element.dataset.id;
      state.routeDraftBackends = null;
      state.page = "routes";
      render();
    } else if (action === "select-vp") {
      state.selected.virtualProvider = element.dataset.id;
      state.page = "targets";
      render();
    } else if (action === "select-binding") {
      state.selected.binding = element.dataset.id;
      state.page = "targets";
      render();
    } else if (action === "new-upstream") {
      state.selected.upstream = null;
      state.page = "upstreams";
      render();
    } else if (action === "new-model") {
      state.selected.model = null;
      state.page = "models";
      render();
    } else if (action === "new-route") {
      state.selected.route = null;
      state.routeDraftBackends = { routeId: null, items: [] };
      state.page = "routes";
      render();
    } else if (action === "new-vp") {
      state.selected.virtualProvider = null;
      state.page = "targets";
      render();
    } else if (action === "new-binding") {
      state.selected.binding = null;
      state.page = "targets";
      render();
    } else if (action === "add-suite-model") {
      const list = pageContent.querySelector("#suite-model-list");
      if (!list) return;
      const wrapper = document.createElement("div");
      const suite = selectedSuite();
      const upstreamId = suite?.upstreamId || null;
      wrapper.innerHTML = suiteModelEditor(suite || {}, "", {
        clientModelId: "",
        ...(suite?.target === "codex" ? { codex: { metadataMode: "official" } } : { capabilities: ["streaming", "tools", "reasoning"] }),
        upstreams: {},
      }, upstreamId);
      const row = wrapper.firstElementChild;
      list.querySelector(".empty")?.remove();
      list.appendChild(row);
      row.querySelectorAll("[data-action]").forEach((item) => {
        item.addEventListener("click", () => handleAction(item.dataset.action, item));
      });
    } else if (action === "remove-suite-model") {
      const list = pageContent.querySelector("#suite-model-list");
      const rows = list?.querySelectorAll("[data-suite-model]") || [];
      if (rows.length <= 1) {
        throw new Error("至少保留一个客户端模型");
      }
      element.closest("[data-suite-model]")?.remove();
    } else if (action === "add-backend") {
      state.routeDraftBackends ||= { routeId: state.selected.route, items: [] };
      state.routeDraftBackends.items.push({
        upstream: firstKey(state.draft.upstreams) || "",
        priority: (state.routeDraftBackends.items.length + 1) * 10,
        models: [],
        enabled: true,
      });
      render();
    } else if (action === "add-wizard-model") {
      const list = pageContent.querySelector("#wizard-model-list");
      if (!list) return;
      const wrapper = document.createElement("div");
      wrapper.innerHTML = wizardModelRow();
      const row = wrapper.firstElementChild;
      list.appendChild(row);
      row.querySelectorAll("[data-action]").forEach((item) => {
        item.addEventListener("click", () => handleAction(item.dataset.action, item));
      });
    } else if (action === "remove-backend") {
      state.routeDraftBackends.items.splice(Number(element.dataset.index), 1);
      render();
    } else if (action === "remove-wizard-model") {
      const rows = pageContent.querySelectorAll("[data-wizard-model]");
      if (rows.length <= 1) {
        throw new Error("至少保留一个 Model Profile");
      }
      element.closest("[data-wizard-model]")?.remove();
    } else if (action === "delete-upstream") {
      delete state.draft.upstreams[element.dataset.id];
      for (const model of values(state.draft.models)) delete model.upstreams?.[element.dataset.id];
      state.selected.upstream = firstKey(state.draft.upstreams);
      state.dirty = true;
      render();
    } else if (action === "delete-model") {
      delete state.draft.models[element.dataset.id];
      for (const provider of values(state.draft.virtualProviders)) {
        provider.allowedModels = (provider.allowedModels || []).filter((id) => id !== element.dataset.id);
        if (provider.defaultModel === element.dataset.id) provider.defaultModel = provider.allowedModels[0] || "";
      }
      state.selected.model = firstKey(state.draft.models);
      state.dirty = true;
      render();
    } else if (action === "delete-route") {
      delete state.draft.routes[element.dataset.id];
      for (const provider of values(state.draft.virtualProviders)) {
        if (provider.route === element.dataset.id) provider.route = "";
      }
      state.selected.route = firstKey(state.draft.routes);
      state.routeDraftBackends = null;
      state.dirty = true;
      render();
    } else if (action === "delete-vp") {
      delete state.draft.virtualProviders[element.dataset.id];
      for (const binding of values(state.draft.bindings)) {
        if (binding.virtualProvider === element.dataset.id) binding.virtualProvider = "";
      }
      state.selected.virtualProvider = firstKey(state.draft.virtualProviders);
      state.dirty = true;
      render();
    } else if (action === "delete-binding") {
      delete state.draft.bindings[element.dataset.id];
      state.selected.binding = firstKey(state.draft.bindings);
      state.dirty = true;
      render();
    } else if (action === "test-upstream") {
      await testUpstream(element.dataset.id);
    } else if (action === "toggle-vp") {
      await toggleVirtualProvider(element.dataset.id);
    } else if (action === "validate") {
      await validateDraft();
    } else if (action === "preview-artifacts") {
      await previewArtifacts();
    } else if (action === "apply-target") {
      await applyTarget();
    } else if (action === "focus-upstream") {
      state.page = "upstreams";
      state.selected.upstream = element.dataset.id;
      render();
    } else if (action === "open-advanced-models") {
      state.page = "models";
      state.selected.model = selectedSuite()?.modelIds?.[0] || firstKey(state.draft.models);
      render();
    }
  } catch (error) {
    toast(error.message, true);
  }
}

async function handleFormSubmit(event, form) {
  event.preventDefault();
  try {
    const data = new FormData(form);
    let savedDraft = true;
    if (form.id === "wizard-form") saveWizard(data, form);
    else if (form.id === "upstream-form") saveUpstream(data);
    else if (form.id === "suite-upstream-form") saveSuiteUpstream(data);
    else if (form.id === "suite-models-form") saveSuiteModels(form);
    else if (form.id === "model-form") saveModel(data, form);
    else if (form.id === "route-form") saveRoute(data, form);
    else if (form.id === "vp-form") saveVirtualProvider(data);
    else if (form.id === "binding-form") saveBinding(data);
    else if (form.id === "resolve-form") {
      savedDraft = false;
      await resolveModel(data);
    }
    render();
    toast(savedDraft ? "已保存到草稿，点击右上角提交运行时变更。" : "模型解析已完成。");
  } catch (error) {
    toast(error.message, true);
  }
}

function saveSuiteUpstream(data) {
  saveUpstream(data);
  state.page = "suite-detail";
}

function saveSuiteModels(form) {
  const suite = selectedSuite();
  if (!suite) throw new Error("找不到当前配置套装");
  const modelRows = [...form.querySelectorAll("[data-suite-model]")];
  if (!modelRows.length) throw new Error("至少添加一个客户端模型");

  const upstreamId = suite.upstreamId;
  if (!upstreamId || !state.draft.upstreams[upstreamId]) {
    throw new Error("当前配置套装没有可用的上游");
  }

  const clientModelIds = modelRows.map(
    (row) => row.querySelector("[data-suite-model-client]")?.value.trim() || "",
  );
  if (clientModelIds.some((id) => !id)) throw new Error("每个模型都必须填写客户端模型 ID");
  if (new Set(clientModelIds).size !== clientModelIds.length) {
    throw new Error("客户端模型 ID 不能重复");
  }

  const reservedIds = new Set();
  const nextModels = {};
  for (const row of modelRows) {
    const oldId = row.dataset.modelId || "";
    const existing = state.draft.models[oldId] || {};
    const clientModelId = row.querySelector("[data-suite-model-client]").value.trim();
    const profileId = oldId || modelProfileId(clientModelId, state.draft.models, reservedIds);
    if (nextModels[profileId]) throw new Error(`模型 ID 冲突: ${profileId}`);

    const upstreams = {};
    const upstreamInput = row.querySelector(
      `[data-suite-model-upstream="${CSS.escape(upstreamId)}"]`,
    );
    const capabilityInput = row.querySelector(
      `[data-suite-model-capabilities="${CSS.escape(upstreamId)}"]`,
    );
    const upstreamModelId = upstreamInput?.value.trim() || "";
    if (upstreamModelId) {
      const capabilityOverrides = capabilityInput ? commaList(capabilityInput.value) : existing.upstreams?.[upstreamId]?.capabilityOverrides || [];
      upstreams[upstreamId] = {
        ...(existing.upstreams?.[upstreamId] || {}),
        upstreamModelId,
        ...(capabilityOverrides.length ? { capabilityOverrides } : {}),
      };
      if (!capabilityOverrides.length) {
        delete upstreams[upstreamId].capabilityOverrides;
      }
    }
    if (!Object.keys(upstreams).length) {
      throw new Error(`模型 ${clientModelId} 至少需要一个上游模型映射`);
    }

    const aliases = [...new Set([
      ...(existing.aliases || []).filter((alias) => alias !== existing.clientModelId),
      clientModelId,
    ])];
    const capabilities = commaList(
      row.querySelector("[data-suite-model-capabilities-common]")?.value,
    );
    nextModels[profileId] = {
      ...existing,
      id: profileId,
      name: clientModelId,
      clientModelId,
      aliases,
      family: existing.family || "codex",
      capabilities: capabilities.length ? capabilities : ["streaming", "tools", "reasoning"],
      ...(suite.target === "codex" ? codexModelFields(clientModelId, existing, row) : {
        contextWindow: Number(row.querySelector("[data-suite-model-context]")?.value || 1000000),
        compact: {
        strategy: row.querySelector("[data-suite-model-compact]")?.value || "auto",
        tokenLimit: Number(
          row.querySelector("[data-suite-model-compact-limit]")?.value || 850000,
        ),
        },
      }),
      upstreams,
    };
  }

  const routeId = suite.route?.id;
  if (!routeId) throw new Error("当前配置套装没有可编辑的 Route");
  const existingRouteBackend = suite.routeBackend || {};
  const nextRouteBackend = {
    ...existingRouteBackend,
    upstream: upstreamId,
    models: Object.keys(nextModels),
    enabled: true,
  };

  const oldModelIds = new Set(suite.modelIds);
  const nextModelIds = new Set(Object.keys(nextModels));
  for (const oldModelId of oldModelIds) {
    if (nextModelIds.has(oldModelId)) continue;
    const usedByOtherProvider = values(state.draft.virtualProviders).some(
      (provider) =>
        provider !== suite.virtualProvider &&
        (provider.allowedModels || []).includes(oldModelId),
    );
    const usedByOtherRoute = entries(state.draft.routes).some(
      ([id, route]) =>
        id !== routeId &&
        (route.backends || []).some((backend) => (backend.models || []).includes(oldModelId)),
    );
    if (!usedByOtherProvider && !usedByOtherRoute) delete state.draft.models[oldModelId];
  }
  Object.assign(state.draft.models, nextModels);
  state.draft.routes[routeId] = {
    ...state.draft.routes[routeId],
    strategy: "priority",
    backends: [nextRouteBackend],
  };
  state.draft.virtualProviders[suite.binding.virtualProvider] = {
    ...state.draft.virtualProviders[suite.binding.virtualProvider],
    allowedModels: Object.keys(nextModels),
    defaultModel: Object.keys(nextModels).includes(suite.virtualProvider.defaultModel)
      ? suite.virtualProvider.defaultModel
      : Object.keys(nextModels)[0],
  };
  state.draft.bindings[suite.bindingId] = {
    ...state.draft.bindings[suite.bindingId],
    defaultModel: Object.keys(nextModels).includes(suite.binding.defaultModel)
      ? suite.binding.defaultModel
      : Object.keys(nextModels)[0],
  };
  state.routeDraftBackends = { routeId, items: [clone(nextRouteBackend)] };
  selectSuite(suite.bindingId);
  state.dirty = true;
}

function saveWizard(data, form) {
  const defaults = wizardDefaults();
  const upstreamBaseUrl = String(data.get("upstreamBaseUrl") || "").trim();
  const upstreamSecret = String(data.get("upstreamSecret") || "").trim();
  const target = String(data.get("target") || "codex").trim();
  const suiteName = String(data.get("suiteName") || "").trim();
  const modelEntries = [...form.querySelectorAll("[data-wizard-model]")].map((row) => {
    const read = (key) =>
      row.querySelector(`[data-wizard-field="${CSS.escape(key)}"]`)?.value.trim() || "";
    return {
      clientModelId: read("clientModelId"),
      upstreamModelId: read("upstreamModelId"),
    };
  });
  if (!upstreamBaseUrl || !upstreamSecret || !modelEntries.length) {
    throw new Error("请填写上游地址、上游 API Key，并至少添加一个模型");
  }
  const missingModelField = modelEntries.find(
    (model) => !model.clientModelId || !model.upstreamModelId,
  );
  if (missingModelField) {
    throw new Error("每个模型都必须填写 client model ID 和上游模型 ID");
  }
  const clientModelIds = modelEntries.map((model) => model.clientModelId);
  if (new Set(clientModelIds).size !== clientModelIds.length) {
    throw new Error("Client model ID 不能重复");
  }

  const upstreamId = defaults.upstreamId;
  const upstreamName = wizardUpstreamName(upstreamBaseUrl, upstreamId);
  const routeId = defaults.routeId;
  const virtualProviderId = defaults.virtualProviderId;
  const bindingId = virtualProviderId;
  const listenPort = defaults.listenPort;
  const reservedModelIds = new Set();
  const models = Object.fromEntries(
    modelEntries.map((model) => {
      const profileId = modelProfileId(
        model.clientModelId,
        state.draft.models,
        reservedModelIds,
      );
      return [
        profileId,
        {
          id: profileId,
          name: model.clientModelId,
          clientModelId: model.clientModelId,
          aliases: [model.clientModelId],
          family: "codex",
          ...codexModelFields(model.clientModelId),
          upstreams: {
            [upstreamId]: {
              upstreamModelId: model.upstreamModelId,
            },
          },
        },
      ];
    }),
  );
  const modelIds = Object.keys(models);
  const defaultModel = modelIds[0];

  state.draft.upstreams[upstreamId] = {
    id: upstreamId,
    name: upstreamName,
    integration: "codex-native-provider",
    protocol: "openai.responses",
    baseUrl: upstreamBaseUrl,
    secretRef: `secret://upstreams/${upstreamId}`,
    enabled: true,
  };
  for (const modelId of modelIds) delete state.draft.models[modelId];
  Object.assign(state.draft.models, models);
  state.draft.routes[routeId] = {
    id: routeId,
    name: `${upstreamName} route`,
    strategy: "priority",
    backends: [
      {
        upstream: upstreamId,
        priority: 10,
        models: modelIds,
        enabled: true,
      },
    ],
  };
  state.draft.virtualProviders[virtualProviderId] = {
    id: virtualProviderId,
    name: `Codex via ${upstreamName}`,
    listenHost: "127.0.0.1",
    listenPort,
    ingressProtocol: "openai.responses",
    route: routeId,
    allowedModels: modelIds,
    defaultModel,
    enabled: true,
  };
  state.draft.bindings[bindingId] = {
    id: bindingId,
    name: suiteName || `Codex / ${upstreamName}`,
    target,
    integration: "codex-native-provider",
    targetFormat: "codex.config.toml.v1",
    mode: "config",
    virtualProvider: virtualProviderId,
    defaultModel,
    codex: {},
  };

  state.secretDraft.upstreamSecrets[upstreamId] = upstreamSecret;

  state.selected.upstream = upstreamId;
  state.selected.model = defaultModel;
  state.selected.route = routeId;
  state.selected.virtualProvider = virtualProviderId;
  state.selected.binding = bindingId;
  state.selected.suite = bindingId;
  state.showWizard = false;
  state.page = "suite-detail";
  state.dirty = true;
}

function saveUpstream(data) {
  const id = String(data.get("id") || "").trim();
  if (!id) throw new Error("upstream ID 不能为空");
  const existing = state.draft.upstreams[id] || {};
  state.draft.upstreams[id] = {
    ...existing,
    id,
    name: String(data.get("name") || id).trim(),
    ...(data.get("protocol") === "openai.responses"
      ? { integration: "codex-native-provider" }
      : {}),
    protocol: data.get("protocol"),
    baseUrl: String(data.get("baseUrl") || "").trim(),
    envKey: String(data.get("envKey") || "").trim(),
    auth: {
      ...(existing.auth || {}),
      header: String(data.get("authHeader") || "").trim().toLowerCase() || undefined,
    },
    secretRef: existing.secretRef || `secret://upstreams/${id}`,
    requestMaxRetries: Number(data.get("requestMaxRetries") || 0),
    streamMaxRetries: Number(data.get("streamMaxRetries") || 0),
    streamIdleTimeoutMs: Number(data.get("streamIdleTimeoutMs") || 0),
    requiresOpenaiAuth: data.get("requiresOpenaiAuth") === "on",
    supportsWebsockets: data.get("supportsWebsockets") === "on",
    enabled: true,
  };
  delete state.draft.upstreams[id].codexNative;
  if (data.get("protocol") !== "openai.responses") {
    delete state.draft.upstreams[id].integration;
    delete state.draft.upstreams[id].codexNative;
  }
  const secret = String(data.get("secret") || "").trim();
  if (secret) {
    state.secretDraft.upstreamSecrets[id] = secret;
  }
  state.selected.upstream = id;
  state.dirty = true;
}

function saveModel(data, form) {
  const id = String(data.get("id") || "").trim();
  if (!id) throw new Error("CableTidy Model ID 不能为空");
  const existing = state.draft.models[id] || {};
  const upstreams = {};
  form.querySelectorAll("[data-model-upstream]").forEach((input) => {
    const upstreamId = input.dataset.modelUpstream;
    const upstreamModelId = input.value.trim();
    const capabilitiesInput = form.querySelector(
      `[data-model-upstream-capabilities="${CSS.escape(upstreamId)}"]`,
    );
    if (upstreamModelId) {
      const capabilityOverrides = commaList(capabilitiesInput?.value);
      upstreams[upstreamId] = {
        ...(existing.upstreams?.[upstreamId] || {}),
        upstreamModelId,
        ...(capabilityOverrides.length ? { capabilityOverrides } : {}),
      };
    }
  });
  const clientModelId = String(data.get("clientModelId") || "").trim();
  state.draft.models[id] = {
    ...existing,
    id,
    clientModelId: clientModelId || id,
    aliases: commaList(data.get("aliases")),
    family: String(data.get("family") || "codex").trim(),
    capabilities: commaList(data.get("capabilities")),
    contextWindow: Number(data.get("contextWindow") || 1000000),
    compact: {
      strategy: String(data.get("compactStrategy") || "auto").trim(),
      tokenLimit: Number(data.get("compactTokenLimit") || 850000),
    },
    upstreams,
  };
  state.selected.model = id;
  state.dirty = true;
}

function saveRoute(data, form) {
  const id = String(data.get("id") || "").trim();
  if (!id) throw new Error("Route ID 不能为空");
  const backends = [...form.querySelectorAll("[data-backend-index]")].map((row) => ({
    upstream: row.querySelector("[data-backend-upstream]").value,
    models: commaList(row.querySelector("[data-backend-models]").value),
    priority: Number(row.querySelector("[data-backend-priority]").value || 10),
    enabled: true,
  }));
  state.draft.routes[id] = {
    ...(state.draft.routes[id] || {}),
    id,
    name: String(data.get("name") || id).trim(),
    strategy: data.get("strategy") || "priority",
    backends,
  };
  state.selected.route = id;
  state.routeDraftBackends = { routeId: id, items: clone(backends) };
  state.dirty = true;
}

function saveVirtualProvider(data) {
  const id = String(data.get("id") || "").trim();
  if (!id) throw new Error("Virtual Provider ID 不能为空");
  const existing = state.draft.virtualProviders[id] || {};
  state.draft.virtualProviders[id] = {
    ...existing,
    id,
    name: String(data.get("name") || id).trim(),
    listenHost: String(data.get("listenHost") || "127.0.0.1").trim(),
    listenPort: Number(data.get("listenPort") || 43101),
    ingressProtocol: data.get("ingressProtocol") || "openai.responses",
    route: data.get("route") || "",
    allowedModels: commaList(data.get("allowedModels")),
    defaultModel: String(data.get("defaultModel") || "").trim(),
    enabled: existing.enabled !== false,
  };
  state.selected.virtualProvider = id;
  state.dirty = true;
}

function saveBinding(data) {
  const id = String(data.get("id") || "").trim();
  if (!id) throw new Error("Binding ID 不能为空");
  const existing = state.draft.bindings[id] || {};
  const target = data.get("target") || "codex";
  const targetFormat =
    target === "codex"
      ? "codex.config.toml.v1"
      : target === "claude-code"
        ? "claude.env.v1"
        : "generic.env.v1";
  const nextBinding = {
    ...existing,
    id,
    target,
    ...(target === "codex" ? { integration: "codex-native-provider" } : {}),
    targetFormat,
    virtualProvider: data.get("virtualProvider") || "",
    mode: data.get("mode") || "config",
    defaultModel: data.get("defaultModel") || "",
  };
  if (target === "codex") {
    nextBinding.codex = {
      ...(existing.codex || {}),
    };
    delete nextBinding.codex.providerId;
    delete nextBinding.claude;
    delete nextBinding.env;
    nextBinding.integration = "codex-native-provider";
  } else if (target === "claude-code") {
    nextBinding.claude = {
      ...(existing.claude || {}),
      setModel: data.get("claudeSetModel") === "on",
    };
    delete nextBinding.codex;
    delete nextBinding.env;
    delete nextBinding.integration;
  } else {
    nextBinding.env = {
      ...(existing.env || {}),
      prefix: String(data.get("envPrefix") || existing.env?.prefix || "CABLETIDY").trim(),
    };
    delete nextBinding.codex;
    delete nextBinding.claude;
    delete nextBinding.integration;
  }
  state.draft.bindings[id] = nextBinding;
  state.selected.binding = id;
  state.dirty = true;
}

async function testUpstream(id) {
  const result = await api("/tests/upstream", {
    method: "POST",
    body: JSON.stringify({
      id,
      ...(state.dirty
        ? {
            config: state.draft,
            upstreamSecrets: state.secretDraft.upstreamSecrets,
          }
        : {}),
    }),
  });
  toast(`${id}: ${result.message}，${result.latencyMs}ms${result.secretConfigured ? "" : "，未找到 API key"}`, !result.ok);
  await refresh(false);
}

async function toggleVirtualProvider(id) {
  if (state.dirty) {
    throw new Error("请先提交当前草稿，再启动或暂停 Virtual Provider。");
  }
  const provider = state.config.virtualProviders?.[id];
  if (!provider) throw new Error("Virtual Provider 不存在");
  const enabled = provider.enabled === false;
  await api(`/virtual-providers/${encodeURIComponent(id)}/${enabled ? "start" : "pause"}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  await refresh(false);
  toast(enabled ? "Virtual Provider 已启动。" : "Virtual Provider 已暂停。");
}

async function validateDraft() {
  try {
    state.validation = await api("/config/validate", {
      method: "POST",
      body: JSON.stringify({ config: state.draft }),
    });
  } catch (error) {
    state.validation = error.body || { ok: false, errors: [{ path: "server", message: error.message }] };
  }
  state.page = "diagnostics";
  render();
}

async function resolveModel(data) {
  try {
    state.resolveResult = await api("/tests/model-resolve", {
      method: "POST",
      body: JSON.stringify({
        config: state.draft,
        virtualProviderId: data.get("virtualProviderId"),
        model: String(data.get("model") || "").trim(),
        stream: data.get("stream") === "on",
        reasoning: data.get("reasoning") === "on",
      }),
    });
  } catch (error) {
    state.resolveResult = error.body || {
      ok: false,
      error: { message: error.message },
    };
  }
}

async function previewArtifacts() {
  const result = await api("/config/preview-target-artifacts", {
    method: "POST",
    body: JSON.stringify({
      config: state.draft,
      bindingId: state.selected.binding,
      upstreamSecrets: state.secretDraft.upstreamSecrets,
    }),
  });
  state.artifactPreview = result.artifacts;
  const target = result.artifacts?.target;
  toast(target === "codex" ? "已生成 Codex 本地 config.toml 预览。" : "已生成环境配置预览；实际注入请使用 cabletidy target env。");
  render();
}

async function applyTarget() {
  if (state.dirty) {
    throw new Error("请先提交当前草稿，再生成或应用 Target 配置。");
  }
  if (!state.selected.binding) throw new Error("请先选择一个 Target binding。");
  const binding = state.draft.bindings[state.selected.binding];
  if (binding?.target !== "codex") {
    await previewArtifacts();
    return;
  }
  const result = await api("/targets/apply", {
    method: "POST",
    body: JSON.stringify({ bindingId: state.selected.binding }),
  });
  state.artifactPreview = result.report ? {
    ...result.report,
    target: result.target,
    bindingId: state.selected.binding,
    mode: result.report.mode || "managed_proxy",
  } : null;
  toast("Codex 配置已应用。");
  render();
}

async function commit() {
  if (!state.dirty) {
    toast("当前没有待提交的变更。");
    return;
  }
  let validation;
  try {
    validation = await api("/config/validate", {
      method: "POST",
      body: JSON.stringify({ config: state.draft }),
    });
  } catch (error) {
    state.validation = error.body || {
      ok: false,
      errors: [{ path: "server", message: error.message }],
    };
    state.page = "diagnostics";
    render();
    return;
  }
  state.validation = validation;
  if (!validation.ok) {
    state.page = "diagnostics";
    render();
    toast("配置校验失败，请先修复错误。", true);
    return;
  }
  if (validation.diff?.total && !window.confirm(`即将提交 ${validation.diff.total} 项配置变化，影响：${(validation.diff.affected || []).join(", ") || "runtime"}。继续？`)) {
    state.page = "diagnostics";
    render();
    return;
  }
  const result = await api("/config/commit", {
    method: "POST",
    body: JSON.stringify({
      baseRevision: state.config.revision,
      config: state.draft,
      upstreamSecrets: state.secretDraft.upstreamSecrets,
    }),
  });
  state.config = result.config;
  state.draft = clone(result.config);
  state.runtime = result.runtime;
  state.dirty = false;
  state.showWizard = false;
  state.secretDraft = { upstreamSecrets: {} };
  state.validation = null;
  state.artifactPreview = null;
  state.events.unshift({
    id: `local-${Date.now()}`,
    type: "config.commit",
    at: new Date().toISOString(),
    data: { revision: result.revision },
  });
  toast(`配置已提交，runtime revision ${result.revision} 已生效。`);
  render();
}

async function refresh(showToast = true) {
  const [configResult, runtime, events] = await Promise.all([
    api("/config"),
    api("/runtime"),
    api("/events"),
  ]);
  state.config = configResult.config;
  if (!state.dirty) {
    state.draft = clone(state.config);
    state.secretDraft = { upstreamSecrets: {} };
  }
  state.runtime = runtime;
  state.events = events.events || [];
  if (showToast) toast("状态已刷新。");
  render();
}

function firstKey(record, excluded = new Set()) {
  return Object.keys(record || {}).find((key) => !excluded.has(key)) || null;
}

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast ${error ? "error" : ""}`;
  node.textContent = message;
  toastRegion.append(node);
  setTimeout(() => node.remove(), 4200);
}

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    state.page = item.dataset.page;
    render();
  });
});

document.querySelector("#refresh-button").addEventListener("click", () => refresh());
document.querySelector("#save-button").addEventListener("click", () => {
  commit().catch((error) => toast(error.message, true));
});

bootstrap();
