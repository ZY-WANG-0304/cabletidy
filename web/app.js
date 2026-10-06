import { configurationId, providerIdForConfiguration, normalizeConfigurationIdentities, configurationBaseUrl } from "./config-identity.js";
import { CLAUDE_MODEL_CATALOG, CLAUDE_MODEL_ALIASES } from "./claude-models.js";

const pageContent = document.querySelector("#page-content");
const pageTitle = document.querySelector("#page-title");
const railStatus = document.querySelector("#rail-status");
const versionLabel = document.querySelector("#version-label");
const toastRegion = document.querySelector("#toast-region");
const formBaselines = new WeakMap();
const formConflicts = new WeakSet();
const lockedControls = new WeakMap();
let modelHintSequence = 0;

// Explicit product guidance; catalog visibility does not indicate authorization.
const SECURITY_MODELS = new Map([
  ["gpt-daybreak-blue-latest", {
    label: "Daybreak Blue · 需授权",
    hint: "用于防御性安全工作，需确认上游支持并已获授权。",
  }],
  ["gpt-daybreak-red-latest", {
    label: "Daybreak Red · 需专项授权",
    hint: "用于专项授权安全研究，需单独获得 Red 授权并确认上游支持。",
  }],
]);

const PAGE_META = {
  overview: "配置套装",
  "suite-create": "新建配置",
  "suite-detail": "配置详情",
  models: "模型管理",
  diagnostics: "诊断",
  security: "安全",
  "security-detail": "审计详情",
};

const state = {
  page: "overview",
  config: null,
  candidate: null,
  runtime: null,
  events: [],
  codexCatalog: null,
  createTarget: "codex",
  busy: false,
  pendingSecrets: {
    upstreamSecrets: {},
  },
  selected: {
    model: null,
    virtualProvider: null,
    suite: null,
  },
  artifactPreview: null,
  resolveResult: null,
  security: { bodySelection: null, bodyPage: null, streamPage: null, streamLoading: false, streamError: null, detailSequence: 0, detailId: null, detailLoading: false, detailError: null, listScroll: { x: 0, y: 0 }, filters: { hours: "24" }, cursor: "", history: [], result: null, status: null, detail: null, loading: false, error: null, sequence: 0, updatedAt: null },
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
    const [configResult, runtime, events, codexCatalog] = await Promise.all([
      api("/config"),
      api("/runtime"),
      api("/events"),
      api("/codex/models"),
    ]);
    state.config = configResult.config;
    state.candidate = clone(state.config);
    state.runtime = runtime;
    state.codexCatalog = codexCatalog;
    state.events = events.events || [];
    state.selected.virtualProvider = firstKey(state.candidate.virtualProviders);
    state.selected.suite = firstKey(state.candidate.bindings);
    state.selected.model = selectedSuite()?.modelIds[0] || null;
    railStatus.textContent = "服务运行中";
    railStatus.parentElement.classList.remove("is-offline");
    render();
    if (window.location.hash.startsWith("#security")) await restoreSecurityNavigation();
  } catch (error) {
    renderUnavailable(error.message);
  }
}

function renderUnavailable(message) {
  railStatus.textContent = "无法连接";
  railStatus.parentElement.classList.add("is-offline");
  pageTitle.textContent = "无法连接到 CableTidy";
  pageContent.innerHTML = `
    <div class="notice warning" role="alert">
      <p>${esc(message || "服务不可用")}</p>
      <span>运行 <code>npm start</code> 后重试。</span>
      <button class="button" data-action="reconnect">重试连接</button>
    </div>
  `;
  pageContent.querySelector('[data-action="reconnect"]').addEventListener("click", bootstrap);
}

function render(preservedForms = []) {
  pageTitle.textContent = state.page === "suite-detail"
    ? selectedSuite()?.name || PAGE_META["suite-detail"]
    : pageMeta();
  versionLabel.textContent = state.runtime?.version ? `v${state.runtime.version}` : "版本未知";
  document.querySelectorAll(".nav-item").forEach((item) => {
    const active = item.dataset.page === (state.page.startsWith("security") ? "security" : state.page === "diagnostics" ? "diagnostics" : "overview");
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });

  const renderers = {
    overview: renderOverview,
    "suite-create": renderSuiteCreate,
    "suite-detail": renderSuiteDetail,
    models: renderModels,
    diagnostics: renderDiagnostics,
    security: renderSecurity,
    "security-detail": renderSecurityDetailPage,
  };
  pageContent.innerHTML = renderers[state.page]();
  for (const form of pageContent.querySelectorAll("form")) {
    formBaselines.set(form, formSnapshot(form));
  }
  for (const form of preservedForms) {
    const replacement = pageContent.querySelector(`#${CSS.escape(form.getAttribute("id"))}`);
    if (replacement) restoreFormChanges(form, replacement);
    else {
      formConflicts.add(form);
      pageContent.append(form);
      showFormError(form, new Error("配置项已在其他窗口删除。"));
    }
  }
}

function fieldSnapshot(control) {
  return [
    control.name || "", control.type, { ...control.dataset },
    control.closest("[data-suite-model]")?.dataset.modelId || "",
    ["checkbox", "radio"].includes(control.type) ? control.checked
      : control.multiple ? [...control.selectedOptions].map((option) => option.value)
        : control.value,
  ];
}

function formSnapshot(form) {
  const fields = [...form.querySelectorAll("input, select, textarea")].filter((control) => {
    // Official metadata is derived, not an editable configuration value.
    if ("suiteModelContext" in control.dataset || "codexVision" in control.dataset) {
      const mode = control.closest("[data-suite-model]")?.querySelector("[data-codex-metadata-mode]");
      if (mode?.value === "official") return false;
    }
    return !["submit", "button", "reset"].includes(control.type);
  });
  return JSON.stringify(fields.map(fieldSnapshot));
}

function fieldKey(field) {
  return JSON.stringify(field.slice(0, 4));
}

function mergeFormFields(base, local, remote) {
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const index = (fields) => new Map(fields.map((field) => [fieldKey(field), field]));
  const [before, ours, theirs] = [base, local, remote].map(index);
  // Repeated controls without stable row IDs cannot be merged safely.
  if ([base, local, remote].some((fields, i) => fields.length !== [before, ours, theirs][i].size)) return null;
  for (const field of base) {
    const key = fieldKey(field);
    if (field[0] === "id" && !same(field, theirs.get(key))) return null;
    if (!("suiteModelClient" in field[2] || "codexMetadataMode" in field[2])) continue;
    if (same(field, ours.get(key)) && same(field, theirs.get(key))) continue;
    const row = (fields) => fields.filter((item) => item[3] === field[3]);
    // A changed model or metadata mode changes the meaning of its other fields.
    if (!same(row(base), row(local)) && !same(row(base), row(remote)) && !same(row(local), row(remote))) return null;
  }
  const merged = [];
  for (const key of new Set([...before.keys(), ...ours.keys(), ...theirs.keys()])) {
    const original = before.get(key);
    const current = ours.get(key);
    const latest = theirs.get(key);
    if (same(current, original)) {
      if (latest) merged.push(latest);
    } else if (same(latest, original) || same(current, latest)) {
      if (current) merged.push(current);
    } else return null;
  }
  return merged;
}

function restoreFormChanges(form, replacement) {
  const baseline = formBaselines.get(form);
  const latest = formBaselines.get(replacement);
  const current = formSnapshot(form);
  const sameContext = form.getAttribute("data-suite-context") === replacement.getAttribute("data-suite-context");
  if (sameContext && current === latest) return;
  // Creation drafts have no remote record to merge, even after switching CLI.
  if (form.getAttribute("id") === "suite-create-form" || (sameContext && baseline === latest)) {
    if (formConflicts.has(form)) form.querySelector("[data-form-feedback]")?.remove();
    formConflicts.delete(form);
    replacement.replaceWith(form);
    return;
  }
  const suiteModels = form.getAttribute("id") === "suite-models-form";
  const savedFields = (snapshot) => JSON.parse(snapshot).filter((field) => !suiteModels || field[3]);
  const structure = (snapshot) => JSON.stringify(JSON.parse(snapshot).map(fieldKey));
  const sameStructure = baseline !== undefined && (suiteModels
    || structure(baseline) === structure(current) && structure(baseline) === structure(latest));
  const merged = sameContext && sameStructure
    ? mergeFormFields(savedFields(baseline), savedFields(current), savedFields(latest)) : null;
  const controls = new Map([...replacement.querySelectorAll("input, select, textarea")]
    .map((control) => [fieldKey(fieldSnapshot(control)), control]));
  if (!merged || merged.some((field) => !controls.has(fieldKey(field)))) {
    // Keep the old baseline and input; never bless a stale form with a new revision.
    formConflicts.add(form);
    replacement.replaceWith(form);
    showFormError(form, new Error("配置存在并发修改冲突。"));
    return;
  }
  for (const field of merged) {
    const control = controls.get(fieldKey(field));
    if (["checkbox", "radio"].includes(control.type)) control.checked = field[4];
    else if (control.multiple) {
      for (const option of control.options) option.selected = field[4].includes(option.value);
    } else control.value = field[4];
  }
  if (suiteModels) {
    const retained = new Set(merged.map((field) => field[3]));
    replacement.querySelectorAll("[data-suite-model]").forEach((row) => {
      if (!retained.has(row.dataset.modelId)) row.remove();
      else syncCodexMetadata(row);
    });
    const list = replacement.querySelector("#suite-model-list");
    form.querySelectorAll("[data-suite-model]").forEach((row) => {
      if (!row.dataset.modelId) {
        list.querySelector(".empty")?.remove();
        list.append(row);
      }
    });
  }
  replacement.querySelectorAll("[data-official-model]").forEach(updateOfficialModelHint);
}

function isFormEdited(form) {
  const baseline = formBaselines.get(form);
  return formConflicts.has(form) || baseline !== undefined && baseline !== formSnapshot(form);
}

function captureEditedForms(excludedForm) {
  return [...pageContent.querySelectorAll("form")].filter(
    (form) => form !== excludedForm && isFormEdited(form),
  );
}

function hasUnsavedChanges() {
  return captureEditedForms().some((form) => !["resolve-form", "security-filter-form"].includes(form.getAttribute("id")));
}

function confirmPageLeave() {
  return !hasUnsavedChanges() || window.confirm("有未保存的修改，确定放弃并离开？");
}

function navigatePage(page) {
  if (state.busy || !state.config || page === state.page || !confirmPageLeave()) return;
  if (page === "security" && state.page === "security-detail") { returnSecurityList(); return; }
  if (state.page === "security") saveSecurityList();
  if (page === "security" || state.page.startsWith("security")) {
    window.history.replaceState({ ...window.history.state, page: state.page }, "");
    window.history.pushState({ page, ...(page === "security" ? { list: securityListState() } : {}) }, "", page === "security" ? "#security" : window.location.pathname + window.location.search);
  }
  state.security.detailSequence++;
  state.security.bodySequence = (state.security.bodySequence || 0) + 1;
  state.page = page;
  render();
  if (page === "security") loadSecurity();
}

window.history.scrollRestoration = "manual";
window.addEventListener("popstate", () => state.config ? restoreSecurityNavigation() : undefined);

pageContent.addEventListener("click", (event) => {
  const element = event.target.closest("[data-action], [data-page]");
  if (!element || !pageContent.contains(element) || state.busy) return;
  if (element.dataset.action) handleAction(element.dataset.action, element);
  else navigatePage(element.dataset.page);
});

pageContent.addEventListener("submit", (event) => handleFormSubmit(event, event.target));
window.addEventListener("beforeunload", (event) => {
  if (!hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = "";
});

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

function suiteRouteBackend(route) {
  return route?.backends?.length === 1 ? route.backends[0] : null;
}

function configurationSuites(config) {
  return entries(config.bindings).map(([bindingId, binding]) => {
    const virtualProvider = config.virtualProviders?.[binding.virtualProvider] || {};
    const route = config.routes?.[virtualProvider.route] || {};
    const routeBackend = suiteRouteBackend(route);
    const upstreamId = routeBackend?.upstream || null;
    const upstream = upstreamId ? config.upstreams?.[upstreamId] || null : null;
    const modelIds = Object.keys(virtualProvider.models || {});
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
      models: modelIds.map((id) => ({ id, profile: virtualProvider.models[id] })),
    };
  });
}

function selectedSuite() {
  return configurationSuites(state.candidate || {}).find(
    (suite) => suite.id === state.selected.suite,
  ) || null;
}

function selectSuite(id) {
  const suite = configurationSuites(state.candidate || {}).find((item) => item.id === id);
  state.selected.suite = id || null;
  if (state.artifactPreview?.bindingId !== id) state.artifactPreview = null;
  if (!suite) return;
  state.selected.virtualProvider = suite.binding.virtualProvider;
  state.selected.model = suite.modelIds[0] || null;
}

function suiteProviderStatus(suite) {
  const runtimeProvider = state.runtime?.virtualProviders?.find(
    (item) => item.id === suite.binding.virtualProvider,
  );
  if (runtimeProvider?.status === "paused") {
    return { label: "已暂停", className: "warning" };
  }
  if (runtimeProvider?.status === "listening") {
    return { label: "已启动", className: "" };
  }
  return { label: "未启动", className: "neutral" };
}

function suiteEndpoint(suite) {
  return `${configurationBaseUrl(state.candidate, suite.bindingId)}${suite.target === "claude-code" ? "" : "/v1"}`;
}

function suiteRow(suite) {
  const providerStatus = suiteProviderStatus(suite);
  return `
    <tr>
      <th scope="row"><button class="suite-name" data-action="open-suite" data-id="${esc(suite.id)}">${esc(suite.name)}</button><span class="suite-upstream">${esc(suite.upstream?.name || suite.upstreamId || "未配置上游")}</span></th>
      <td data-label="CLI">${esc(targetLabel(suite.target))}</td>
      <td data-label="模型设置">${suite.modelIds.length ? `${suite.modelIds.length} 项设置` : "直接透传"}</td>
      <td data-label="本地地址" class="mono">${esc(suiteEndpoint(suite))}</td>
      <td data-label="本地服务"><span class="status-badge ${providerStatus.className}">${esc(providerStatus.label)}</span></td>
    </tr>
  `;
}

function renderOverview() {
  const suites = configurationSuites(state.candidate);
  return `
    <div class="suite-toolbar">
      <span class="muted">${suites.length} 套配置</span>
      <button class="button button-primary" data-action="create-suite">新建配置</button>
    </div>
    ${
      suites.length
        ? `<div class="suite-list"><table class="suite-table" aria-label="配置套装"><thead><tr><th scope="col">配置名称</th><th scope="col">CLI</th><th scope="col">模型设置</th><th scope="col">本地地址</th><th scope="col">本地服务</th></tr></thead><tbody>${suites.map(suiteRow).join("")}</tbody></table></div>`
        : `<div class="panel"><div class="empty">暂无配置</div></div>`
    }
  `;
}

function suiteModelEditor(suite, modelId, profile, upstreamId) {
  const model = profile || {};
  const isCodex = suite.target === "codex";
  const compact = model.compact || {};
  const expanded = model.codex?.metadataMode === "override" || Boolean(model.compact)
    || (isCodex && !model.codex && Boolean(model.contextWindow));
  return `
    <article class="suite-model-card" data-suite-model data-model-id="${esc(modelId)}">
      <div class="suite-model-mapping">
        ${isCodex
          ? officialModelSelect("data-suite-model-client", modelId || "")
          : suite.target === "claude-code"
            ? claudeModelInput("data-suite-model-client", modelId)
            : `<label class="field"><span>客户端模型 ID</span><input data-suite-model-client value="${esc(modelId)}" placeholder="客户端模型 ID" required /></label>`}
        <span class="suite-mapping-arrow" aria-hidden="true">&rarr;</span>
        ${upstreamId
          ? `<label class="field"><span>上游模型 ID（可选）</span><input data-suite-model-upstream="${esc(upstreamId)}" value="${esc(model.upstreamModelId || "")}" placeholder="留空使用请求中的模型名" /></label>`
          : `<div class="notice warning">请先配置上游连接</div>`}
        <button class="mini-button" type="button" data-action="remove-suite-model" aria-label="移除模型 ${esc(modelId || "映射")}">移除</button>
      </div>
      ${model.aliases?.length ? `<label class="field"><span>额外请求别名（可选）</span><input data-suite-model-aliases value="${esc(model.aliases.join(", "))}" placeholder="多个别名用逗号分隔" /></label>` : ""}
      ${suite.target === "claude-code" ? "" : `<details class="suite-model-settings" ${expanded ? "open" : ""}>
        <summary><span>模型能力与上下文</span><span class="field-hint" data-model-policy-summary>${isCodex ? model.codex?.metadataMode === "override" ? "覆盖上游限制" : "沿用官方定义" : "自定义设置"}</span></summary>
        <div class="form-grid suite-model-policy">
          ${isCodex ? codexMetadataFields(model, modelId) : `
          <label class="field full"><span>Capabilities</span><input data-suite-model-capabilities-common value="${esc((model.capabilities || ["streaming", "tools", "reasoning"]).join(", "))}" placeholder="streaming, tools, reasoning" /></label>
          <label class="field"><span>Context window</span><input type="number" data-suite-model-context value="${esc(model.contextWindow ?? 1000000)}" placeholder="tokens" /></label>
          <label class="field"><span>Compact strategy</span><select data-suite-model-compact>${optionList(["auto", "manual", "disabled"], compact.strategy || "auto")}</select></label>
          <label class="field"><span>Compact token limit</span><input type="number" data-suite-model-compact-limit value="${esc(compact.tokenLimit ?? 850000)}" placeholder="tokens" /></label>
          ${upstreamId ? `<label class="field"><span>上游能力覆盖</span><input data-suite-model-capabilities="${esc(upstreamId)}" value="${esc((model.capabilityOverrides || []).join(", "))}" placeholder="可留空" /></label>` : ""}
          `}
        </div>
      </details>`}
    </article>
  `;
}

function officialModel(id) {
  return state.codexCatalog?.models?.find((model) => model.id === id);
}

function officialModelOptions(selected) {
  const models = state.codexCatalog?.models || [];
  const unknown = selected && !officialModel(selected);
  const option = (model) => `<option value="${esc(model.id)}" ${selected === model.id ? "selected" : ""}>${esc(
    SECURITY_MODELS.get(model.id)?.label || `${model.name} (${model.id})`,
  )}</option>`;
  const securityModels = models.filter((model) => SECURITY_MODELS.has(model.id));
  return `
    <option value="">选择官方模型</option>
    ${unknown ? `<option value="${esc(selected)}" selected>${esc(SECURITY_MODELS.get(selected)?.label || selected)}（旧配置，待确认）</option>` : ""}
    ${models.filter((model) => !SECURITY_MODELS.has(model.id)).map(option).join("")}
    ${securityModels.length ? `<optgroup label="安全专项模型">${securityModels.map(option).join("")}</optgroup>` : ""}
  `;
}

function officialModelHint(selected) {
  return [
    SECURITY_MODELS.get(selected)?.hint,
    selected && !officialModel(selected) ? "未匹配本机官方目录" : "",
  ].filter(Boolean).join(" ");
}

function updateOfficialModelHint(select) {
  const hint = select.parentElement.querySelector("[data-official-model-hint]");
  hint.textContent = officialModelHint(select.value);
  hint.hidden = !hint.textContent;
}

function officialModelSelect(attributes, selected) {
  const hint = officialModelHint(selected);
  const hintId = `official-model-hint-${++modelHintSequence}`;
  return `<label class="field"><span>Codex 官方模型</span><select ${attributes} data-official-model aria-label="Codex 官方模型" aria-describedby="${hintId}" required>
    ${officialModelOptions(selected)}
    </select><span class="field-hint" id="${hintId}" data-official-model-hint aria-live="polite" ${hint ? "" : "hidden"}>${esc(hint)}</span></label>`;
}

function codexCatalogStatus() {
  return `<div class="catalog-status"><span>${esc(state.codexCatalog?.available
    ? `${state.codexCatalog.version} / ${state.codexCatalog.models.length} 个官方模型`
    : state.codexCatalog?.error?.message || "官方模型目录不可用")}</span>
    <button class="mini-button" type="button" data-action="refresh-codex-models">刷新模型列表</button></div>`;
}

function codexMetadataFields(model, modelId) {
  const definition = officialModel(modelId);
  const override = model.codex?.metadataMode === "override";
  const vision = override ? model.codex.inputModalities?.includes("image") ?? definition?.inputModalities.includes("image") : definition?.inputModalities.includes("image");
  return `
    <label class="field"><span>模型元数据</span><select data-codex-metadata-mode>
      <option value="official" ${!override ? "selected" : ""}>沿用官方定义</option>
      <option value="override" ${override ? "selected" : ""}>覆盖上游限制</option>
    </select></label>
    <label class="field"><span>上下文窗口</span><input data-suite-model-context type="number" min="1" max="${esc(definition?.maxContextWindow || "")}" value="${esc(override ? model.contextWindow ?? "" : definition?.contextWindow ?? "")}" placeholder="沿用官方" ${override ? "" : "disabled"} /></label>
    <label class="field checkbox-field"><span><input data-codex-vision type="checkbox" ${vision ? "checked" : ""} ${override && definition?.inputModalities.includes("image") ? "" : "disabled"} /> 图片输入</span></label>
    <div class="field"><label>基础提示词</label><span class="field-hint" data-codex-instructions>${esc(definition?.name || "待选择官方模型")} / 官方定义</span></div>
    ${!model.codex && (model.contextWindow || model.compact) ? `<div class="notice warning full">旧策略尚未同步：context window ${esc(model.contextWindow || "未设置")}；compact ${esc(model.compact?.strategy || "未设置")} ${esc(model.compact?.tokenLimit || "")}。Compact 仍由 Codex 管理。</div>` : model.compact ? `<div class="field full"><span class="field-hint">旧 Compact 策略已保留，未同步到 Codex</span></div>` : ""}
  `;
}

function syncCodexMetadata(row, resetOverrides = false) {
  if (!row || !row.querySelector("[data-codex-metadata-mode]")) return;
  const definition = officialModel(row.querySelector("[data-suite-model-client]").value);
  const override = row.querySelector("[data-codex-metadata-mode]").value === "override";
  const context = row.querySelector("[data-suite-model-context]");
  const vision = row.querySelector("[data-codex-vision]");
  if (resetOverrides || !override) {
    context.value = definition?.contextWindow || "";
    vision.checked = Boolean(definition?.inputModalities.includes("image"));
  }
  context.max = definition?.maxContextWindow || "";
  setControlDisabled(context, !override);
  setControlDisabled(vision, !override || !definition?.inputModalities.includes("image"));
  row.querySelector("[data-codex-instructions]").textContent = `${definition?.name || "待选择官方模型"} / 官方定义`;
  const summary = row.querySelector("[data-model-policy-summary]");
  if (summary) summary.textContent = override ? "覆盖上游限制" : "沿用官方定义";
}

pageContent.addEventListener("change", (event) => {
  if (event.target.matches('#suite-create-form [name="target"]')) {
    state.createTarget = event.target.value;
    const form = event.target.closest("form");
    form.querySelector(".catalog-status-wrapper").hidden = state.createTarget !== "codex";
    form.querySelector("[data-claude-create-auth]").hidden = state.createTarget !== "claude-code";
    form.querySelector("[data-claude-model-suggestions]").hidden = state.createTarget !== "claude-code";
    form.querySelectorAll("[data-claude-create-models]").forEach((section) => {
      section.hidden = state.createTarget !== "claude-code";
    });
    form.querySelectorAll("[data-create-model]").forEach((row) => {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = createModelRow({
        clientModelId: row.querySelector('[data-create-field="clientModelId"]').value,
        upstreamModelId: row.querySelector('[data-create-field="upstreamModelId"]').value,
      });
      row.replaceWith(wrapper.firstElementChild);
    });
    syncClaudeCreateModels(form);
  }
  const modelChanged = event.target.matches("[data-official-model]");
  if (modelChanged) updateOfficialModelHint(event.target);
  if (modelChanged || event.target.matches("[data-codex-metadata-mode]")) {
    syncCodexMetadata(event.target.closest("[data-suite-model]"), modelChanged);
  }
});

pageContent.addEventListener("toggle", (event) => {
  const panel = event.target;
  if (panel.matches("[data-security-snapshot]") && panel.open) {
    securityAction("security-body", { dataset: { id: panel.dataset.securitySnapshot } });
  }
});

pageContent.addEventListener("input", (event) => {
  if (event.target.matches('#suite-create-form [data-create-field="clientModelId"]')) {
    syncClaudeCreateModels(event.target.closest("form"));
  }
});

pageContent.addEventListener("invalid", (event) => {
  // Reveal invalid controls before the browser tries to focus them.
  const settings = event.target.closest(".suite-model-settings");
  if (settings) settings.open = true;
}, true);

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
        <div class="empty"><strong>配置不存在</strong><div class="form-actions"><button class="button" data-action="back-overview">返回列表</button></div></div>
      </div>
    `;
  }
  const providerStatus = suiteProviderStatus(suite);
  const upstreamId = suite.upstreamId || "";
  const upstream = upstreamId ? state.candidate.upstreams[upstreamId] : null;
  const binding = suite.binding;
  const provider = suite.virtualProvider;
  return `
    <div class="suite-toolbar">
      <button class="text-button" data-action="back-overview">返回列表</button>
      <div class="suite-status"><span>${esc(targetLabel(binding.target))} · ${suite.models.length ? `${suite.models.length} 项模型设置` : "模型名直接透传"}</span><span class="status-badge ${providerStatus.className}">${esc(providerStatus.label)}</span></div>
    </div>
    <div class="panel suite-editor">
      <section class="suite-section" aria-labelledby="suite-upstream-title">
        <div class="suite-section-heading">
          <h2 id="suite-upstream-title">上游连接</h2>
          <p>此配置的所有模型共用这一上游。</p>
        </div>
        ${upstream ? `
          <form id="suite-upstream-form">
            <input type="hidden" name="id" value="${esc(upstreamId)}" />
            <input type="hidden" name="protocol" value="${esc(upstream.protocol || "openai.responses")}" />
            <div class="form-grid suite-upstream-fields">
              ${field("上游名称", "name", upstream.name || upstreamId, "例如 Relay A")}
              ${field("上游地址", "baseUrl", upstream.baseUrl || "", "https://relay.example.com/v1", false, "url")}
              ${field(suite.target === "claude-code" ? "上游凭据" : "API Key", "secret", "", upstream.secretConfigured ? "已配置，留空保留现有密钥" : "粘贴上游凭据", false, "password")}
              ${suite.target === "claude-code" ? upstreamAuthField("authHeader", upstream.auth?.header || upstream.authHeader || "x-api-key") : ""}
            </div>
            <div class="suite-section-footer">
              <span class="field-hint">保存后生效，测试使用已保存的连接。</span>
              <div class="form-actions"><button class="button" type="submit">保存上游</button><button class="button" type="button" data-action="test-upstream" data-id="${esc(upstreamId)}">测试连通性</button></div>
            </div>
          </form>
        ` : `<div class="empty"><strong>未配置上游</strong></div>`}
      </section>
      <section class="suite-section" aria-labelledby="suite-models-title">
        <div class="suite-section-heading suite-models-heading">
          <div><h2 id="suite-models-title">模型设置（可选）</h2><p>${suite.target === "claude-code" ? "默认透传模型名；改名时填写 Claude Code 请求中的完整模型 ID。模型能力、上下文和压缩由客户端与上游决定。" : "默认透传请求中的模型名；需要改名或覆盖上下文等参数时再添加设置。"}</p></div>
          <button class="button" type="button" data-action="add-suite-model">添加模型设置</button>
        </div>
        ${suite.target === "codex" ? codexCatalogStatus() : ""}
        ${suite.target === "claude-code" ? claudeModelSuggestions() : ""}
        <form id="suite-models-form" data-suite-context="${esc(JSON.stringify([suite.bindingId, suite.target, binding.virtualProvider, suite.route?.id, upstreamId]))}">
          <div id="suite-model-list" class="suite-model-list">
            ${suite.models.length
              ? suite.models.map(({ id, profile }) => suiteModelEditor(suite, id, profile, upstreamId)).join("")
              : `<div class="empty">已启用模型名直接透传，无需添加模型设置。</div>`}
          </div>
          <div class="suite-section-footer">
            <span class="field-hint">${suite.target === "claude-code" ? "上游模型 ID 留空时原样透传。" : "按需展开模型能力与上下文设置。"}</span>
            <div class="form-actions">
              <button class="button" type="submit">保存模型设置</button>
              ${suite.target === "generic-env" ? `<button class="button" type="button" data-action="open-advanced-models">高级模型设置</button>` : ""}
            </div>
          </div>
        </form>
      </section>
      ${suite.target === "claude-code" ? claudeClientForm(suite) : ""}
    </div>
    <section class="panel suite-connection" aria-labelledby="suite-connection-title">
      <div class="panel-header">
        <h2 id="suite-connection-title">${esc(targetLabel(binding.target))} 接入</h2>
        <div class="suite-connection-actions">
          <button class="button button-quiet" type="button" data-action="toggle-vp" data-id="${esc(provider.id)}">${provider.enabled === false ? "启动服务" : "暂停服务"}</button>
          <button class="button" type="button" data-action="preview-artifacts">预览配置</button>
          ${["codex", "claude-code"].includes(binding.target) ? `<button class="button button-primary" type="button" data-action="apply-target">应用到 ${esc(targetLabel(binding.target))}</button>` : ""}
          ${binding.target === "claude-code" ? `<button class="button" type="button" data-action="restore-target">撤销接入</button>` : ""}
        </div>
      </div>
      <div class="panel-body">
        <dl class="suite-connection-facts">
          <div><dt>本地地址</dt><dd class="mono">${esc(suiteEndpoint(suite))}</dd></div>
          <div><dt>Virtual Provider ID</dt><dd class="mono">${esc(binding.virtualProvider)}</dd></div>
        </dl>
        ${state.artifactPreview ? artifactPanel(state.artifactPreview) : ""}
      </div>
    </section>
  `;
}

function upstreamAuthField(name, header = "x-api-key") {
  const options = [
    ["x-api-key", "API Key (x-api-key / ANTHROPIC_API_KEY)"],
    ["authorization", "Bearer Token (Authorization / ANTHROPIC_AUTH_TOKEN)"],
  ];
  if (!options.some(([value]) => value === header)) options.push([header, `保留现有认证 (${header})`]);
  return `<label class="field"><span>上游认证方式</span><select name="${esc(name)}">${options.map(([value, label]) => `<option value="${esc(value)}" ${value === header ? "selected" : ""}>${esc(label)}</option>`).join("")}</select><span class="field-hint">环境变量名用于对照 Claude 直连上游的配置；这里选择的是 CableTidy 访问上游的认证方式。</span></label>`;
}

function claudeDefaultModel(suite) {
  if (suite.binding.claude?.setModel === false) return "";
  return suite.binding.defaultModel || suite.virtualProvider.defaultModel || "";
}

function claudeModelInput(attributes, value) {
  return `<label class="field"><span>客户端模型 ID</span><input ${attributes} list="claude-model-suggestions" value="${esc(value)}" placeholder="搜索官方建议或手动填写" autocomplete="off" required /></label>`;
}

function claudeModelSuggestions() {
  return `<p class="field-hint">官方建议来自 <a href="${esc(CLAUDE_MODEL_CATALOG.sources[0])}" target="_blank" rel="noreferrer">Anthropic 文档</a>（${esc(CLAUDE_MODEL_CATALOG.updatedAt)}），随 CableTidy 发版更新，无需额外 API Key；可手动填写其他模型 ID。</p>
    <datalist id="claude-model-suggestions">${CLAUDE_MODEL_CATALOG.models.map((id) => `<option value="${esc(id)}"></option>`).join("")}</datalist>`;
}

function claudeAliasSelect(suite, family) {
  const selected = suite?.binding.claude?.models?.[family] || "";
  const ids = (suite?.models || []).map(({ id }) => id);
  return `<label class="field"><span>${family[0].toUpperCase() + family.slice(1)} 别名指向</span><select name="${family}">
    ${claudeAliasOptions(ids, selected)}
  </select></label>`;
}

function claudeAliasOptions(ids, selected = "") {
  return `<option value="" ${selected ? "" : "selected"}>由 Claude 默认决定</option>
    ${selected && !ids.includes(selected) ? `<option value="${esc(selected)}" selected disabled>${esc(selected)}（未配置，请重新选择）</option>` : ""}
    ${optionList(ids, selected)}`;
}

function claudeModelChoice(name, ids, value) {
  const selected = String(value || "").trim();
  return CLAUDE_MODEL_ALIASES[name].includes(selected) || ids.includes(selected) ? selected : "";
}

function claudeDefaultModelOptions(name, ids, value = "") {
  const selected = claudeModelChoice(name, ids, value);
  const aliases = CLAUDE_MODEL_ALIASES[name];
  const clientIds = [...new Set(ids)].filter((id) => !aliases.includes(id));
  return `<optgroup label="默认行为"><option value="" ${selected ? "" : "selected"}>${name === "defaultModel" ? "由 Claude 默认决定" : "沿用 Claude 默认行为"}</option></optgroup>
    <optgroup label="模型别名">${optionList(aliases, selected)}</optgroup>
    ${clientIds.length ? `<optgroup label="当前配置的客户端模型 ID">${optionList(clientIds, selected)}</optgroup>` : ""}`;
}

function claudeDefaultModelSelect(name, ids, value = "") {
  return `<label class="field"><span>${name === "defaultModel" ? "启动模型（可选）" : "子代理模型（可选）"}</span>
    <select name="${name}" data-claude-default-model>${claudeDefaultModelOptions(name, ids, value)}</select></label>`;
}

function syncClaudeCreateModels(form) {
  if (!form || state.createTarget !== "claude-code") return;
  const ids = [...new Set([...form.querySelectorAll('[data-create-field="clientModelId"]')]
    .map((input) => input.value.trim()).filter(Boolean))];
  for (const select of form.querySelectorAll("[data-claude-create-models] select")) {
    select.innerHTML = select.hasAttribute("data-claude-default-model")
      ? claudeDefaultModelOptions(select.name, ids, select.value)
      : claudeAliasOptions(ids, ids.includes(select.value) ? select.value : "");
  }
}

function claudeModelGroups(suite = null) {
  const ids = (suite?.models || []).map(({ id }) => id);
  return `<section class="subsection" aria-labelledby="claude-aliases-title">
        <div class="subsection-header"><h3 id="claude-aliases-title">模型别名</h3></div>
        <p class="field-hint">${suite ? "从当前配置已保存的" : "可选。从本次填写的"}客户端模型 ID 中选择，或由 Claude 默认决定。</p>
        <div class="form-grid">
          ${["opus", "sonnet", "fable", "haiku"].map((family) => claudeAliasSelect(suite, family)).join("")}
        </div>
      </section>
      <section class="subsection" aria-labelledby="claude-defaults-title">
        <div class="subsection-header"><h3 id="claude-defaults-title">默认模型</h3></div>
        <div class="form-grid">
          ${claudeDefaultModelSelect("defaultModel", ids, suite ? claudeDefaultModel(suite) : "")}
          ${claudeDefaultModelSelect("subagent", ids, suite?.binding.claude?.models?.subagent || "")}
        </div>
        <p class="field-hint">可选。选择适用的官方别名或当前配置的客户端模型 ID；默认行为不主动覆盖 Claude 的模型选择。</p>
      </section>`;
}

function claudeClientForm(suite) {
  const options = suite.binding.claude || {};
  return `<section class="suite-section">
    <div class="suite-section-heading"><h2>Claude Code 模型选择</h2><p>设置模型别名和默认模型。上游改名在模型设置中配置。</p></div>
    <form id="claude-client-form" data-suite-context="${esc(JSON.stringify([suite.bindingId, suite.models.map(({ id }) => id)]))}">
      ${claudeModelGroups(suite)}
      <div class="form-actions">
        ${checkboxField("在 /model 中发现此配置的模型", "discoverModels", options.discoverModels === true)}
      </div>
      <p class="field-hint">模型发现只列出已配置模型，不限制其他模型请求。Claude Code 可能过滤不含 claude 或 anthropic 的模型 ID。保存后需重新应用客户端配置。</p>
      <div class="form-actions"><button class="button" type="submit">保存客户端设置</button></div>
    </form>
  </section>`;
}

function renderSuiteCreate() {
  return `
    <button class="text-button" data-action="back-overview">返回列表</button>
    <form id="suite-create-form" class="config-form panel">
      <section class="config-section" aria-labelledby="config-basics">
        <h2 id="config-basics">基本信息</h2>
        <div class="form-grid">
          ${field("配置名称（可选）", "suiteName", "", "例如 my-relay；留空自动生成")}
          ${selectField("CLI", "target", state.createTarget, ["codex", "claude-code"])}
        </div>
      </section>
      <section class="config-section" aria-labelledby="config-upstream">
        <h2 id="config-upstream">上游连接</h2>
        <div class="form-grid">
          ${field("上游地址", "upstreamBaseUrl", "", "https://relay.example.com/v1", false, "url", false, true)}
          ${field("API Key", "upstreamSecret", "", "", false, "password", false, true)}
          <div data-claude-create-auth ${state.createTarget === "claude-code" ? "" : "hidden"}>${upstreamAuthField("upstreamAuth")}</div>
        </div>
      </section>
      <section class="config-section" aria-labelledby="config-models">
        <div class="subsection-header">
          <h2 id="config-models">模型设置（可选）</h2>
          <button class="mini-button" type="button" data-action="add-create-model">添加模型设置</button>
        </div>
        <p class="field-hint">默认透传请求中的模型名。需要改名时添加设置，客户端选项可在创建后调整。</p>
        <div ${state.createTarget === "codex" ? "" : "hidden"} class="catalog-status-wrapper">${codexCatalogStatus()}</div>
        <div data-claude-model-suggestions ${state.createTarget === "claude-code" ? "" : "hidden"}>${claudeModelSuggestions()}</div>
        <div id="create-model-list" class="create-model-list"></div>
      </section>
      <section class="config-section" data-claude-create-models aria-labelledby="config-claude-models" ${state.createTarget === "claude-code" ? "" : "hidden"}>
        <h2 id="config-claude-models">Claude Code 模型选择</h2>
        <p class="field-hint">以下两组均为可选；创建后需应用到 Claude Code 才会写入客户端配置。</p>
        <div>${claudeModelGroups()}</div>
      </section>
      <div class="config-form-footer">
        <button class="button" type="button" data-action="back-overview">取消</button>
        <button class="button button-primary" type="submit">创建配置</button>
      </div>
    </form>
  `;
}

function createModelRow(values = {}, target = state.createTarget) {
  const model = {
    clientModelId: values.clientModelId || "",
    upstreamModelId: values.upstreamModelId || "",
  };
  return `
    <div class="create-model-row" data-create-model>
      ${target === "claude-code" ? claudeModelInput('data-create-field="clientModelId"', model.clientModelId) : officialModelSelect('data-create-field="clientModelId"', model.clientModelId)}
      <label class="field"><span>上游模型 ID（可选）</span><input data-create-field="upstreamModelId" value="${esc(model.upstreamModelId)}" placeholder="留空使用请求中的模型名" /></label>
      <button class="mini-button" type="button" data-action="remove-create-model" aria-label="移除模型映射">移除</button>
    </div>
  `;
}

function suiteDefaults(target = "codex") {
  const upstreamId = nextConfigId(state.candidate?.upstreams, "relay-main");
  const bindingId = nextConfigId(state.candidate?.bindings, target === "claude-code" ? "claude-main" : "codex-main");
  const routeId = nextConfigId(state.candidate?.routes, `${upstreamId}-route`);
  return { upstreamId, bindingId, routeId };
}

function nextConfigId(record, base) {
  const source = record || {};
  if (!source[base]) return base;
  let suffix = 2;
  while (source[`${base}-${suffix}`]) suffix += 1;
  return `${base}-${suffix}`;
}

function upstreamDisplayName(baseUrl, fallback) {
  try {
    return new URL(baseUrl).hostname || fallback;
  } catch {
    return fallback;
  }
}

function renderModels() {
  const selectedId = state.selected.model;
  const suite = selectedSuite();
  if (!suite) return `<div class="empty">请先选择配置</div>`;
  const models = suite.virtualProvider.models || {};
  const selected = selectedId ? models[selectedId] : null;
  const compact = selected?.compact || {};
  const mapping = selected || {};
  return `
    <button class="text-button" data-action="back-overview">返回列表</button>
    <div class="form-layout">
      <div class="panel">
        <div class="panel-header">
          <h2>模型列表</h2>
          <button class="button button-primary" data-action="new-model">新增模型</button>
        </div>
        <div class="panel-body">
          ${
            Object.keys(models).length
              ? `<div class="list">${entries(models).map(([id, item]) => modelRow(id, item, id === selectedId)).join("")}</div>`
              : `<div class="empty">暂无模型</div>`
          }
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><h2>${selected ? esc(selectedId) : "新增模型"}</h2></div>
        <div class="panel-body">
          <form id="model-form" data-suite-context="${esc(JSON.stringify([suite.bindingId, selectedId, suite.upstreamId]))}">
            <div class="form-grid">
              ${field("Client model ID", "clientModelId", selectedId || "", "客户端请求里的 model")}
              ${field("Aliases", "aliases", (selected?.aliases || []).join(", "), "son, codex-default")}
              ${field("Family", "family", selected?.family || "codex", "codex")}
              ${field("Capabilities", "capabilities", (selected?.capabilities || ["streaming", "tools", "reasoning"]).join(", "), "streaming, tools, reasoning", true)}
              ${field("Context window", "contextWindow", selected?.contextWindow ?? 1000000, "tokens")}
              ${selectField("Compact strategy", "compactStrategy", compact.strategy || "auto", ["auto", "manual", "disabled"])}
              ${field("Compact token limit", "compactTokenLimit", compact.tokenLimit ?? 850000, "tokens")}
            </div>
            <div class="subsection">
              <div class="subsection-header"><h3>上游模型映射</h3></div>
              <div class="form-grid">
                <div class="field"><span>上游</span><span>${esc(suite.upstream?.name || suite.upstreamId)}</span></div>
                ${field("上游模型 ID（可选）", "upstreamModelId", mapping.upstreamModelId || "", "留空使用请求中的模型名")}
                ${field("能力覆盖", "capabilityOverrides", (mapping.capabilityOverrides || []).join(", "), "可留空")}
              </div>
            </div>
            <div class="form-actions"><button class="button button-primary" type="submit">保存</button>${selected ? `<button class="button button-danger" type="button" data-action="delete-model" data-id="${esc(selectedId)}">删除</button>` : ""}</div>
          </form>
        </div>
      </div>
    </div>
  `;
}

const SECURITY_LABELS = {
  severity: { informational: "信息", low: "低", medium: "中", high: "高", critical: "严重" },
  category: { sensitive_data: "敏感数据与凭据", destructive_action: "破坏性操作", permission_change: "权限与安全配置变更", external_execution: "外部代码执行", instruction_manipulation: "疑似指令操纵" },
  confidence: { low: "低置信度", medium: "中置信度", high: "高置信度" },
  stage: { request_content: "请求内容", tool_call_proposed: "本轮调用提议", tool_call_replayed: "历史调用", tool_result_reported: "客户端报告的工具结果", response_content: "模型返回内容" },
  inspection: { pending: "等待检测", running: "检测进行中", failed: "检测失败", complete: "已完成支持范围内检查", partial: "检测不完整", skipped: "仅操作审计" },
  outcome: { started: "请求已接收", streaming: "响应接收中", completed: "已完成", local_error: "本地处理失败", upstream_error: "上游返回错误", connection_error: "上游连接失败", stream_error: "响应流错误", interrupted: "请求中断", unknown: "结果未知" },
  kind: { request: "模型请求", management: "管理操作", system: "审计状态" },
  action: { "model.request": "模型请求", "tokens.count": "Token 计数", "config.commit": "配置提交", "target.apply": "应用客户端配置", "target.restore": "恢复客户端配置", "virtual_provider.start": "启动配置", "virtual_provider.pause": "暂停配置", "audit.gap": "审计记录缺口" },
  basis: { system_wide_damage_possible: "显式关闭根目录保护，可能造成系统范围的数据破坏", credential_exposure_possible: "凭据可能暴露在模型内容或联网操作中", working_data_loss_possible: "操作可能丢弃工作区数据或影响较大目录范围", broad_write_access_possible: "操作可能向所有用户开放写权限", unreviewed_remote_code_execution: "远程内容直接进入代码解释器", sensitive_goal_redirection_possible: "外部指令试图将原任务引向敏感操作", scoped_sensitive_operation: "涉及有限范围的数据修改、敏感读取或权限变更", known_credential_match: "内容与本地已知凭据匹配", credential_pattern_match: "仅匹配凭据格式，尚未验证其有效性", heuristic_keyword_combination: "命中指令覆盖与敏感动作的启发式组合", network_sensitive_file_reference: "联网命令引用敏感文件，未确认实际发送", recognized_literal_tool_arguments: "已识别的工具参数或字面量命令结构" },
  rule: { "SEC-SECRET-001": "内容中发现凭据特征", "SEC-READ-001": "读取敏感文件", "SEC-DELETE-001": "递归删除目录", "SEC-DELETE-002": "补丁删除文件", "SEC-VCS-001": "丢弃工作区修改", "SEC-CONFIG-001": "修改代理或安全配置", "SEC-PRIV-001": "请求提升执行权限", "SEC-PRIV-002": "授予所有用户写权限", "SEC-EXEC-001": "下载内容直接交给解释器执行", "SEC-EXEC-002": "动态代码执行", "SEC-EXPORT-001": "联网命令引用敏感文件", "SEC-INJECT-001": "外部内容要求改写目标并执行敏感操作" },
  reason: { header_storage_or_processing_failure: "请求或响应头保存失败", invalid_json_or_structure_budget: "JSON 不完整或超出解析栈预算，仅保留可安全脱敏的前缀", evidence_storage_unavailable: "检测快照写入失败", audit_metadata_budget: "审计元数据写入有缺口", redaction_buffer_budget: "脱敏工作区不足，或长 URL 认证区、令牌前缀无法确认，相关内容已隐藏", invalid_sse_event: "流式事件无法解析，内容已隐藏", shared_encrypted_spool_budget: "共享临时空间或内存不足，正文保留有缺口", shared_working_memory_budget: "共享内存不足，部分工具参数无法完整解析", shared_detection_budget: "共享检测资源不足，风险发现可能不完整", credential_redaction_budget: "凭据匹配资源不足，相关内容已隐藏", body_storage_or_processing_failure: "正文存储或处理失败", body_not_complete: "正文接收未完成", unstructured_content: "非结构化或无效 JSON，仅完成文本规则检查", non_text_or_reasoning_semantics: "非文本或推理内容的语义不在规则覆盖范围", inspection_worker_failed: "检测任务失败", incomplete_body_fragment: "不完整正文末尾已隐藏", incomplete_stream_fragment: "流式内容未结束，部分片段已隐藏", stream_item_metadata_missing: "流式条目缺少工具类型或名称", credential_catalog_limit: "部分本地凭据超出支持的数量或长度范围", concurrent_inspection_limit: "并发检查数量达到上限", request_inspection_limit: "请求内容检查达到上限", response_inspection_limit: "响应内容检查达到上限", sse_event_limit: "流式事件过大", tool_argument_limit: "工具参数过大", finding_limit: "单次请求风险数量达到上限", unsupported_tool: "工具语义暂不支持", unsupported_tool_arguments: "工具参数结构暂不支持", unsupported_shell_syntax: "命令包含暂不解析的展开或复合语法", unsupported_shell_wrapper: "命令包装方式暂不支持", shell_nesting_limit: "嵌套命令达到检查上限", external_script_not_inspected: "无法观察脚本文件内容", command_semantics_not_inspected: "命令语义未覆盖", dynamic_code_not_inspected: "动态代码内容未检查", non_text_content: "包含非文本内容", opaque_content: "包含不透明或加密内容", reasoning_content_not_inspected: "推理文本已做凭据检查，推理语义未覆盖", unsupported_response_event: "包含未知响应事件，无法安全复核的内容已隐藏", unsupported_response_item: "包含未知响应项", invalid_response_json: "响应无法解析为 JSON", invalid_event_json: "流式事件 JSON 无效", invalid_event_encoding: "流式事件编码无效", unterminated_sse_event: "流式事件未完整结束", missing_terminal_event: "未观察到协议结束事件", incomplete_response_item: "响应项尚未完整返回", missing_tool_start: "缺少工具调用开始事件", invalid_tool_arguments: "工具参数无法解析", response_item_limit: "响应项数量达到上限", text_item_limit: "文本项达到检查上限", response_not_complete: "响应未完整接收", request_not_inspected: "请求未进入内容检查", request_interrupted: "请求在响应前中断", daemon_restarted: "上次进程未记录请求结束", historical_context_not_visible: "引用的历史上下文未经过本次请求" },
};

function securityLabel(group, value) { return SECURITY_LABELS[group]?.[value] || value || "未知"; }
function securityTime(value) { return value ? new Date(value).toLocaleString(undefined, { hourCycle: "h23", timeZoneName: "short" }) : "尚无记录"; }
function securityInspectionLabel(record, state = record.inspectionStatus) {
  return state === "failed" && record.inspectionProgress?.active
    ? "部分步骤失败，仍在检测" : securityLabel("inspection", state);
}
function securityBadge(value) {
  const level = Object.hasOwn(SECURITY_LABELS.severity, value) ? value : "informational";
  return `<span class="security-badge severity-${level}">${esc(securityLabel("severity", value))}</span>`;
}
function securitySelect(label, name, choices) {
  const selected = state.security.filters[name] || "";
  return `<label class="field"><span>${esc(label)}</span><select name="${esc(name)}">${Object.entries(choices).map(([value, title]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(title)}</option>`).join("")}</select></label>`;
}

function securityListState() {
  const s = state.security;
  return { filters: { ...s.filters }, cursor: s.cursor, history: [...s.history], scroll: { ...s.listScroll } };
}

function saveSecurityList() {
  state.security.listScroll = { x: window.scrollX, y: window.scrollY };
  window.history.replaceState({ page: "security", list: securityListState() }, "", "#security");
}

async function showSecurityList(list = securityListState()) {
  const s = state.security;
  s.detailSequence++; s.bodySequence = (s.bodySequence || 0) + 1;
  s.detail = null; s.detailId = null; s.bodyPage = null; s.streamPage = null; s.streamError = null; s.bodySelection = null;
  s.filters = list.filters; s.cursor = list.cursor; s.history = list.history; s.listScroll = list.scroll;
  state.page = "security";
  const params = new URLSearchParams({ ...s.filters, ...(s.cursor ? { cursor: s.cursor } : {}) }).toString();
  render();
  if (!s.result || s.resultParams !== params) await loadSecurity();
  if (state.page === "security") window.scrollTo({ left: s.listScroll.x, top: s.listScroll.y, behavior: "instant" });
}

async function returnSecurityList() {
  if (window.history.state?.returnToSecurityList) { window.history.back(); return; }
  window.history.pushState({ page: "security", list: securityListState() }, "", "#security");
  await showSecurityList();
}

async function restoreSecurityNavigation() {
  const navigation = window.history.state;
  const match = window.location.hash.match(/^#security\/audit\/([^/]+)$/);
  if (navigation?.list) {
    const list = navigation.list;
    Object.assign(state.security, { filters: list.filters, cursor: list.cursor, history: list.history, listScroll: list.scroll });
  }
  if (match) { await loadSecurityDetail(decodeURIComponent(match[1])); return; }
  if (window.location.hash === "#security") { await showSecurityList(); return; }
  state.security.detailSequence++; state.security.bodySequence = (state.security.bodySequence || 0) + 1;
  state.page = PAGE_META[navigation?.page] && !navigation.page.startsWith("security") ? navigation.page : "overview";
  render();
}

async function loadSecurityDetail(id, reset = true) {
  const s = state.security;
  const sequence = ++s.detailSequence;
  s.sequence++; s.loading = false; s.detailId = id; s.detailLoading = true; s.detailError = null;
  s.bodySequence = (s.bodySequence || 0) + 1;
  const offset = reset ? 0 : s.bodyPage?.offset ?? s.bodySelection?.start ?? 0;
  if (reset) { s.detail = null; s.bodyPage = null; s.streamPage = null; s.streamError = null; s.bodySelection = { snapshotId: "request" }; }
  state.page = "security-detail";
  render();
  if (reset) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  try {
    const result = await api(`/security/audit/${encodeURIComponent(id)}`);
    if (sequence !== s.detailSequence || state.page !== "security-detail") return;
    s.detail = result.record;
  } catch (error) {
    if (sequence !== s.detailSequence || state.page !== "security-detail") return;
    s.detail = null; s.bodyPage = null; s.streamPage = null; s.detailError = error.message;
  }
  s.detailLoading = false;
  render();
  if (s.detail) await loadSecurityBody(offset);
}

function renderSecurityDetailPage() {
  const s = state.security;
  return `<nav class="security-detail-nav" aria-label="审计导航"><button class="button" data-action="security-back">返回审计日志</button><span class="muted">安全 / 审计详情</span><span class="status-badge">仅记录</span></nav>
    ${s.detailLoading ? `<p role="status">正在读取审计详情…</p>` : ""}
    ${s.detailError ? `<div class="notice warning" role="alert">${esc(s.detailError)}<p>可刷新重试，或返回审计日志。</p></div>` : ""}
    ${s.detail ? renderSecurityDetail(s.detail) : ""}`;
}

function renderSecurity() {
  const s = state.security;
  const storage = s.result?.storage || s.status?.storage || state.runtime?.security?.storage;
  const ready = storage?.state === "ready";
  const providers = [...new Set([...Object.keys(state.config?.virtualProviders || {}), ...(s.result?.providers || [])])];
  const count = s.result?.counts || {};
  return `
    <div class="security-heading"><div><span class="status-badge">仅记录</span><p class="muted">观察经过 CableTidy 的模型交互与本地管理操作。工具调用提议不代表真实执行。</p></div>

    </div>
    <div class="notice ${ready ? "" : "warning"}" role="status">
      ${ready ? "审计存储正常" : storage?.state === "degraded" ? "审计有记录缺口" : "审计存储尚未就绪或暂不可用"}
      <span class="muted">最近写入：${esc(securityTime(storage?.lastWrittenAt))} · 保留 ${esc(storage?.retentionDays || 30)} 天 · ${esc(((storage?.bytes || 0) / 1048576).toFixed(1))} MiB</span>
      ${(storage?.droppedWrites || storage?.failedWrites) ? `<p>本次运行丢弃 ${esc(storage.droppedWrites || 0)} 次写入，失败 ${esc(storage.failedWrites || 0)} 次；代理继续运行，记录可能不完整。</p>` : ""}
    </div>
    ${s.error ? `<div class="notice warning" role="alert">${esc(s.error)}<p class="muted">最近成功读取：${esc(securityTime(s.updatedAt))}</p></div>` : ""}
    <div class="panel"><div class="panel-body"><form id="security-filter-form"><div class="security-filters">
      ${securitySelect("时间范围", "hours", { "1": "最近 1 小时", "24": "最近 24 小时", "168": "最近 7 天", "720": "最近 30 天" })}
      ${securitySelect("配置入口", "provider", { "": "全部配置", ...Object.fromEntries(providers.map(id => [id, id.replace(/^cabletidy_/, "")])) })}
      ${securitySelect("最高严重程度", "severity", { "": "全部等级", ...SECURITY_LABELS.severity })}
      ${securitySelect("风险分类", "category", { "": "全部分类", ...SECURITY_LABELS.category })}
      ${securitySelect("置信度", "confidence", { "": "全部置信度", ...SECURITY_LABELS.confidence })}
      ${securitySelect("证据阶段", "stage", { "": "全部阶段", ...SECURITY_LABELS.stage })}
      ${securitySelect("操作类型", "kind", { "": "全部操作", ...SECURITY_LABELS.kind })}
      ${securitySelect("请求结果", "outcome", { "": "全部结果", ...SECURITY_LABELS.outcome })}
      ${securitySelect("检查状态", "inspection", { "": "全部状态", ...SECURITY_LABELS.inspection })}
    </div><div class="form-actions"><label class="security-risk-toggle"><input type="checkbox" name="hasRisk" value="true" ${s.filters.hasRisk === "true" ? "checked" : ""}> 仅看有风险</label><button class="button button-primary" type="submit" ${s.loading ? "disabled" : ""}>筛选</button><button class="button" type="button" data-action="security-reset">重置筛选</button></div></form></div></div>
    <div class="security-summary" aria-live="polite"><div><strong>${esc(s.result?.total ?? "—")}</strong><span>条审计记录</span></div><div><strong>${esc(s.result?.riskRecordCount ?? "—")}</strong><span>条有风险的记录</span></div><div><strong>${esc(s.result?.findingCount ?? "—")}</strong><span>项风险发现</span></div><div><strong>${esc(s.result ? (count.high || 0) + (count.critical || 0) : "—")}</strong><span>条高 / 严重记录</span></div></div>
    <p class="muted">统计覆盖全部筛选结果。严重程度按记录的最高等级筛选；风险发现数包含这些记录关联的全部风险。未命中规则不等于已证明安全。</p>
    <div class="panel"><div class="panel-header"><h2>审计日志</h2><span class="muted">${s.loading ? "读取中..." : `更新于 ${esc(securityTime(s.updatedAt))}`}</span></div>
      ${s.result?.items?.length ? `<div class="security-table-wrap"><table class="suite-table security-table"><thead><tr><th>配置 / 时间</th><th>操作 / 模型</th><th>最高风险</th><th>风险发现</th><th>结果 / 检查状态</th><th>详情</th></tr></thead><tbody>${s.result.items.map(item => securityRow(item)).join("")}</tbody></table></div>` : `<div class="empty">${s.loading ? "正在读取安全记录..." : s.error ? "暂时无法读取记录。" : "当前筛选范围内没有审计记录。通过此代理发起请求后可在这里查看。"}</div>`}
      <div class="panel-body security-pagination"><button class="button" data-action="security-prev" ${!s.history.length || s.loading ? "disabled" : ""}>上一页</button><span class="muted">第 ${s.history.length + 1} 页 · 每页 50 条</span><button class="button" data-action="security-next" ${!s.result?.nextCursor || s.loading ? "disabled" : ""}>下一页</button></div>
    </div>
    <p class="muted">检查范围：已知凭据特征、已支持工具的参数与字面量命令、外部内容中的指令操纵线索。动态脚本、未知工具和资源不足时未覆盖的内容会标记覆盖不足。${s.result?.oldestAtMs ? `最早保留记录：${esc(securityTime(s.result.oldestAtMs))}。` : ""}</p>
  `;
}

function securityRow(item) {
  return `<tr><td data-label="配置 / 时间"><div>${esc(item.providerId || "本地管理")}</div><span class="table-meta">${esc(securityTime(item.at))}</span></td>
    <td data-label="操作 / 模型"><div>${esc(securityLabel("action", item.action))}</div><span class="table-meta">${esc(item.clientModelId || securityLabel("kind", item.kind))}</span></td>
    <td data-label="最高风险">${securityBadge(item.severity)}</td><td data-label="风险发现"><span>${esc(item.findingCount || 0)} 项</span></td><td data-label="结果 / 检查"><div>${esc(securityLabel("outcome", item.outcome))}</div><span class="table-meta">${esc(securityInspectionLabel(item))}</span></td>
    <td data-label="详情"><button class="mini-button" data-action="security-detail" data-id="${esc(item.id)}">查看详情</button></td></tr>`;
}

// Ordinal paths remain stable when credential-bearing property names are redacted.
function securityBodyText(value, root, location, fieldOrder = {}) {
  const chunks = [];
  let length = 0;
  let range = null;
  const append = text => { chunks.push(text); length += text.length; };
  const select = (path, start, end) => {
    if (location && (location === path || location.startsWith(`${path}/`)) && (!range || path.length > range.path.length)) range = { start, end, path };
  };
  const walk = (item, path, depth) => {
    const start = length;
    if (item === null || typeof item !== "object") append(JSON.stringify(item) ?? "null");
    else {
      const list = Array.isArray(item);
      const pairs = (fieldOrder[path] || Object.keys(item)).map(key => [key, item[key]]);
      append(list ? "[" : "{");
      pairs.forEach(([key, child], i) => {
        append(`${i ? "," : ""}\n${"  ".repeat(depth + 1)}`);
        const childPath = list ? `${path}/${i}` : `${path}/field/${i}`;
        if (!list) { const keyStart = length; append(JSON.stringify(key)); select(`${childPath}/key`, keyStart, length); append(": "); }
        walk(child, childPath, depth + 1);
      });
      if (pairs.length) append(`\n${"  ".repeat(depth)}`);
      append(list ? "]" : "}");
    }
    select(path, start, length);
  };
  walk(value, root, 0);
  const text = chunks.join("");
  return { text, range };
}

function securityHighlighted(value, root, location, fieldOrder) {
  const { text, range } = securityBodyText(value, root, location, fieldOrder);
  return range ? `${esc(text.slice(0, range.start))}<mark class="security-body-hit" tabindex="-1">${esc(text.slice(range.start, range.end))}</mark>${esc(text.slice(range.end))}` : esc(text);
}

const SECURITY_BODY_LABELS = {
  source: { observed_headers: "请求 / 响应头", tool_inspection: "检测时的工具参数", inspection_range: "检测时的正文范围", client_request: "客户端请求正文", upstream_response: "上游响应正文", gateway_response: "网关本地响应", stream_inspection: "检测时的流式内容快照", response_inspection: "检测时的响应内容快照" },
  state: { complete: "已完整保留", receiving: "分段保存中", gap: "保留存在缺口", partial: "部分内容不可复核", truncated: "旧版截断记录", interrupted: "接收中断或未观察到协议结束", not_observed: "网关未读取正文", capture_unavailable: "正文保留不可用", redaction_unavailable: "凭据脱敏超限，内容已隐藏", pending: "仍在接收或等待保存" },
  redaction: { unsupported_stream_fragment: "无法安全重组的未知流式片段", credential_in_arguments: "工具参数中的凭据", credential_continuation: "跨段凭据续片", url_authority_uncertain: "无法确认的长 URL 认证区", credential_prefix_uncertain: "无法确认的长令牌前缀", redaction_buffer_budget: "脱敏工作区不足", cookie_header: "Cookie 头", credential_field: "凭据字段", known_credential: "已知凭据", credential_pattern: "凭据格式", credential_assignment: "凭据赋值", authorization: "认证值", private_key: "私钥", url_credentials: "URL 认证信息", url_credential_parameter: "URL 凭据参数", nested_json_credentials: "参数内嵌 JSON 凭据", incomplete_stream_fragment: "未完成的流式片段", incomplete_body_fragment: "截断文本末尾", unparsed_json_credentials: "含凭据的内嵌 JSON 无法解析", redaction_depth_limit: "脱敏深度上限", redaction_catalog_limit: "凭据字典上限" },
};

function securityPageText(page, selection) {
  if (page.legacySnapshot) {
    const snapshot = page.legacySnapshot;
    return securityHighlighted(snapshot.body, snapshot.root, selection.location, snapshot.fieldOrder);
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return (page.chunks || []).map(chunk => {
    if (selection.hitUnavailable) return esc(chunk.content);
    const bytes = encoder.encode(chunk.content);
    const start = Math.max(0, (selection.start ?? -1) - chunk.start);
    const end = Math.min(bytes.length, (selection.end ?? -1) - chunk.start);
    if (end <= start) return esc(chunk.content);
    return `${esc(decoder.decode(bytes.slice(0, start)))}<mark class="security-body-hit" tabindex="-1">${esc(decoder.decode(bytes.slice(start, end)))}</mark>${esc(decoder.decode(bytes.slice(end)))}`;
  }).join("");
}

function canonicalBodySnapshotId(id) {
  if (["request", "request/headers", "response", "response/headers"].includes(id)) return id;
  if (id?.startsWith("request")) return "request";
  if (id?.startsWith("response")) return "response";
  if (id?.startsWith("stream/")) return "response";
  return id;
}

function renderSecurityBody(record) {
  const s = state.security;
  const allSnapshots = record.bodySnapshots || [];
  const snapshots = ["request/headers", "request", "response/headers", "response"].map(id => allSnapshots.find(item => item.id === id) || { id, state: "not_observed" });
  const streamSnapshots = allSnapshots.filter(item => item.id.startsWith("stream/"));
  const selection = s.bodySelection || { snapshotId: "request" };
  const snapshot = allSnapshots.find(item => item.id === selection.snapshotId);
  const risk = record.findings?.find(item => item.id === selection.findingId);
  const page = s.bodyPage;
  const labelFor = (item, i) => item.id === "request" ? "请求正文" : item.id === "response" ? "响应正文" : item.id === "request/headers" ? "请求头" : item.id === "response/headers" ? "响应头" : `${item.id.startsWith("stream/") ? "流式内容" : "检测快照"} ${i + 1}`;
  const marks = page?.chunks?.flatMap(chunk => chunk.redactions || []) || page?.legacySnapshot?.redactions || [];
  const references = [...new Set((page?.chunks || []).flatMap(chunk => [...chunk.content.matchAll(/"contentSnapshotId":"([^"]+)"/g)].map(match => match[1])))].filter(id => snapshots.some(item => item.id === id));
  const content = snapshot && selection.snapshotId === snapshot.id ? `${risk ? `<p class="security-selected-risk">正在复核：${esc(securityLabel("rule", risk.ruleId))} · ${esc(securityLabel("stage", risk.evidenceStage))}</p>${selection.detectionSnapshotId ? `<p class="muted">证据来自检测时的流式内容快照，当前已定位到对应的${selection.snapshotId === "response" ? "响应" : "请求"}正文。</p>` : ""}` : ""}
    <p>${esc(SECURITY_BODY_LABELS.source[snapshot.source] || snapshot.source)} · ${esc(SECURITY_BODY_LABELS.state[snapshot.state] || snapshot.state)} · ${esc(securityTime(snapshot.capturedAt))}</p>
    <p class="muted">正文分段按需加载。凭据显示为 [REDACTED]；高亮位置对应脱敏后的内容。响应事件中的引用可通过“关联流式内容”打开重组快照。</p>
    ${s.bodyLoading ? `<p role="status">${s.bodyLocating ? "正在定位凭据命中点…" : "正在加载正文片段…"}</p>` : s.bodyError ? `<div class="notice warning">${esc(s.bodyError)}</div>` : page ? `
      ${page.legacySnapshot?.headers ? `<details><summary>旧记录请求 / 响应头</summary><pre class="code-preview security-body-content">${esc(JSON.stringify(page.legacySnapshot.headers, null, 2))}</pre></details>` : ""}
      ${page.gap ? `<div class="notice warning">此范围存在未保存的正文，不能视为完整证据。</div>` : ""}
      ${selection.hitUnavailable ? `<div class="notice warning">此检测范围未保留可定位的凭据命中点，仅展示正文上下文。</div>` : ""}
      <div class="security-pagination"><button class="mini-button" data-action="security-body-page" data-offset="${esc(page.previousOffset ?? "")}" ${page.previousOffset == null ? "disabled" : ""}>上一段上下文</button><span>${page.rangeStart > 0 ? "源正文" : ""}字节 ${esc(page.offset ?? 0)}–${esc(page.chunks?.at(-1)?.end ?? page.offset ?? 0)} · 本快照 ${esc(snapshot?.byteLength ?? 0)} 字节</span><button class="mini-button" data-action="security-body-page" data-offset="${esc(page.nextOffset ?? "")}" ${page.nextOffset == null ? "disabled" : ""}>下一段上下文</button></div>
      <pre class="code-preview security-body-content" aria-label="保留正文">${securityPageText(page, selection)}</pre>
      ${references.length ? `<div class="security-body-tabs" aria-label="关联流式内容">${references.map((id, i) => `<button class="mini-button" data-action="security-body" data-id="${esc(id)}">关联流式内容 ${i + 1} · ${esc(id.split("/").at(-1).slice(0, 8))}</button>`).join("")}</div>` : ""}
      ${selection.sourceSnapshotId && selection.sourceSnapshotId !== selection.snapshotId ? `<button class="mini-button" data-action="security-source" data-id="${esc(selection.sourceSnapshotId)}" data-offset="${esc(selection.sourceStart ?? selection.start ?? 0)}">查看完整正文上下文</button>` : ""}
      <details class="security-redactions"><summary>本页脱敏位置 · ${marks.length}</summary><ul>${marks.map(mark => `<li><button class="security-location" data-action="security-location" data-start="${esc(mark.start)}" data-end="${esc(mark.end)}" data-location="${esc(mark.location || "")}">${mark.start == null ? esc(mark.location) : `字节 ${esc(mark.start)}–${esc(mark.end)}`}</button> · ${esc(SECURITY_BODY_LABELS.redaction[mark.reason] || mark.reason)}</li>`).join("")}</ul></details>` : ""}` : `<p class="muted">展开后加载该内容。</p>`;
  const panels = snapshots.map((item, i) => `<details class="security-body-review" data-security-snapshot="${esc(item.id)}" ${item.id === selection.snapshotId ? "open" : ""}><summary>${esc(labelFor(item, i))}${item.byteLength != null ? ` · ${esc(item.byteLength)} 字节` : ""}</summary>${item.id === selection.snapshotId && allSnapshots.some(snapshot => snapshot.id === item.id) ? content : `<p class="muted">${allSnapshots.some(snapshot => snapshot.id === item.id) ? "展开后加载该内容。" : "此内容未被网关观察或保留。"}</p>`}</details>`).join("");
  const streamPage = s.streamPage;
  const streamContent = streamPage?.chunks?.map(chunk => chunk.content).join("") || "";
  const timeline = streamSnapshots.length ? `<section class="security-event-timeline" aria-label="流式事件时间线"><h4>流式事件时间线</h4><p class="muted">流式检测证据按事件顺序保留；局部快照可能不完整，风险定位仍以响应正文为准。</p>${streamSnapshots.map((item, i) => {
    const active = selection.detectionSnapshotId === item.id;
    const previous = streamSnapshots[i - 1]?.id;
    const next = streamSnapshots[i + 1]?.id;
    const navigation = active ? `<nav class="security-event-nav" aria-label="流式事件导航"><button class="mini-button" data-action="security-event" data-id="${esc(previous || "")}" ${previous ? "" : "disabled"}>上一事件</button><button class="mini-button" data-action="security-event" data-id="${esc(next || "")}" ${next ? "" : "disabled"}>下一事件</button></nav>` : "";
    return `<details class="security-event" ${active ? "open" : ""}><summary><span>${esc(item.eventType || item.type || `流式事件 ${i + 1}`)}</span>${item.state ? ` · ${esc(SECURITY_BODY_LABELS.state[item.state] || item.state)}` : ""}</summary>${active && streamPage ? `${navigation}<pre class="code-preview security-body-content">${esc(streamContent)}</pre>` : `${navigation}<p class="muted">${active && s.streamError ? esc(s.streamError) : active && s.streamLoading ? "正在加载检测证据…" : "点击风险定位后加载该事件证据。"}</p>`}</details>`;
  }).join("")}</section>` : "";
  return `<section aria-label="正文复核"><h3>正文复核</h3>${panels || `<p class="muted">当前记录没有可展示的请求或响应内容。</p>`}${timeline}</section>`;
}

async function loadSecurityBody(offset = 0, locateCredential = false) {
  const s = state.security;
  const sequence = s.bodySequence = (s.bodySequence || 0) + 1;
  const recordId = s.detail?.id;
  const snapshotId = s.bodySelection?.snapshotId;
  const selection = s.bodySelection;
  const current = () => sequence === s.bodySequence && s.detail?.id === recordId && s.bodySelection === selection && state.page === "security-detail";
  s.bodyPage = null; s.bodyError = null; s.bodyLoading = true; s.bodyLocating = locateCredential;
  if (state.page === "security-detail") render();
  if (!recordId || !snapshotId || !s.detail.bodySnapshots?.some(item => item.id === snapshotId)) { s.bodyLoading = false; if (state.page === "security-detail") render(); return false; }
  try {
    while (true) {
      const page = await api(`/security/audit/${encodeURIComponent(recordId)}/body?${new URLSearchParams({ snapshot: snapshotId, offset })}`);
      if (!current()) return false;
      s.bodyPage = page;
      if (!locateCredential || page.legacySnapshot) break;
      const mark = (page.chunks || []).flatMap(chunk => chunk.redactions || []).find(mark =>
        !["redaction_buffer_budget", "url_authority_uncertain", "credential_prefix_uncertain", "incomplete_body_fragment", "unsupported_stream_fragment"].includes(mark.reason)
        && mark.end > selection.start && mark.start < selection.end);
      if (mark) { selection.start = mark.start; selection.end = mark.end; selection.hitUnavailable = false; break; }
      // Older findings referenced a whole detection window. Search its annotations one page at a time.
      if (page.nextOffset == null || page.nextOffset <= offset || page.nextOffset >= selection.end) { selection.hitUnavailable = true; break; }
      offset = page.nextOffset;
    }
  } catch (error) { if (current()) s.bodyError = error.message; }
  if (!current()) return false;
  s.bodyLoading = false; s.bodyLocating = false; render();
  return !s.bodyError;
}

async function loadSecurityStream(snapshotId) {
  const s = state.security;
  const recordId = s.detail?.id;
  if (!recordId || !snapshotId) return false;
  s.streamLoading = true;
  s.streamError = null;
  if (state.page === "security-detail") render();
  try {
    s.streamPage = await api(`/security/audit/${encodeURIComponent(recordId)}/body?${new URLSearchParams({ snapshot: snapshotId, offset: 0 })}`);
  } catch (error) {
    s.streamError = error.message;
  }
  s.streamLoading = false;
  if (state.page === "security-detail") render();
  return !s.streamError;
}

function renderSecurityDetail(record) {
  const facts = [["记录 ID", record.id], ["操作", securityLabel("action", record.action)], ["配置入口", record.providerId || "本地管理"], ["发生时间", securityTime(record.at)], ["结束时间", record.finishedAt ? securityTime(record.finishedAt) : "未记录"], ["请求结果", securityLabel("outcome", record.outcome)], ["HTTP 状态", record.httpStatus ?? "未知"], ["配置修订", record.revision ?? "未知"], ["客户端模型", record.clientModelId || "—"], ["上游模型", record.upstreamModelId || "—"], ["响应头耗时", record.headersMs == null ? "—" : `${record.headersMs} ms`], ["完整记录耗时", record.durationMs == null ? "—" : `${record.durationMs} ms`]];
  if (record.kind === "management") {
    facts.push(["操作对象", record.bindingId || record.providerId || "本地配置"], ["操作后观察到的修订", record.resultRevision ?? "未知"]);
    if (record.credentialsSubmitted != null) facts.push(["包含凭据变更", record.credentialsSubmitted ? "是（凭据定向脱敏）" : "否"]);
  }
  return `<section class="panel security-detail" aria-label="审计详情"><div class="panel-header"><h2>请求与操作记录</h2>${securityBadge(record.severity)}</div><div class="panel-body">
    <dl class="security-facts">${facts.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>
    <p>${esc(securityInspectionLabel(record))}。${record.kind === "request" ? "工具真实执行状态：未知；工具结果来自客户端报告。" : "记录 CableTidy 观察到的本地操作结果。"}</p>
    ${record.inspectionProgress ? `<p role="status">检测进度：${esc(record.inspectionProgress.processedBytes || 0)} / ${esc(record.inspectionProgress.observedBytes || record.observedBytes || 0)} 字节 · ${esc(securityInspectionLabel(record, record.inspectionProgress.state))}${record.inspectionProgress.phase === "receiving" ? "（正文接收中）" : record.inspectionProgress.phase === "queued" ? "（等待检测资源）" : ""}</p>` : ""}
    ${record.coverageReasons?.length ? `<div class="notice warning">覆盖不足：${record.coverageReasons.map(reason => esc(securityLabel("reason", reason))).join("；")}</div>` : ""}
    ${record.coverageGaps?.length ? `<details><summary>正文缺口范围</summary><pre class="code-preview">${esc(JSON.stringify(record.coverageGaps, null, 2))}</pre></details>` : ""}
    ${record.lostWrites ? `<p>记录到 ${esc(record.lostWrites)} 次审计写入缺口。</p>` : ""}
    ${record.changedSections?.length ? `<p>涉及配置区段：${record.changedSections.map(esc).join("、")}</p>` : ""}
    ${record.usage && Object.keys(record.usage).length ? `<details><summary>上游报告的 Token 用量</summary><pre class="code-preview">${esc(JSON.stringify(record.usage, null, 2))}</pre></details>` : ""}
    <h3>关联风险 · ${record.findings?.length || 0}</h3>
    ${(record.findings || []).map(f => `<article class="security-finding ${state.security.bodySelection?.findingId === f.id ? "is-selected" : ""}"><div>${securityBadge(f.severity)} <button class="security-finding-link" data-action="security-finding" data-id="${esc(f.id)}" aria-pressed="${state.security.bodySelection?.findingId === f.id}">${esc(securityLabel("rule", f.ruleId))} <span>定位正文</span></button></div><p class="muted">${esc(securityLabel("category", f.category))} · ${esc(securityLabel("stage", f.evidenceStage))} · ${esc(securityLabel("confidence", f.confidence))} · 规则 ${esc(f.ruleId)} v${esc(f.ruleVersion)}</p>${f.severityReason ? `<p>分级依据：${esc(securityLabel("basis", f.severityReason))}。</p>` : ""}${f.confidenceReason ? `<p>判断依据：${esc(securityLabel("basis", f.confidenceReason))}。</p>` : ""}<p>证据仅表示在此阶段观察到了对应内容或操作结构，不确认实际执行或恶意意图。</p><details><summary>脱敏证据与标准映射</summary><pre class="code-preview">${esc(JSON.stringify({ evidence: f.evidence, frameworkMappings: f.frameworkMappings }, null, 2))}</pre></details></article>`).join("") || `<p class="muted">没有关联风险；请结合检查状态判断覆盖范围。</p>`}
    ${renderSecurityBody(record)}
  </div></section>`;
}

async function loadSecurity() {
  const s = state.security;
  const sequence = ++s.sequence;
  s.loading = true;
  s.error = null;
  if (state.page === "security") render();
  const params = new URLSearchParams({ ...s.filters, ...(s.cursor ? { cursor: s.cursor } : {}) });
  const [status, result] = await Promise.allSettled([api("/security/status"), api(`/security/audit?${params}`)]);
  if (sequence !== s.sequence) return;
  s.status = status.status === "fulfilled" ? status.value : { storage: { state: "unavailable" } };
  if (result.status === "fulfilled") { s.result = result.value; s.resultParams = params.toString(); s.updatedAt = new Date().toISOString(); }
  else { s.error = result.reason.message; s.result = null; }
  s.loading = false;
  if (state.page === "security") render();
}

async function securityAction(action, element) {
  const s = state.security;
  if (action === "security-detail") {
    const fromList = state.page === "security";
    if (fromList) saveSecurityList();
    window.history.pushState({ page: "security-detail", list: securityListState(), returnToSecurityList: fromList }, "", `#security/audit/${encodeURIComponent(element.dataset.id)}`);
    await loadSecurityDetail(element.dataset.id);
    return;
  }
  if (["security-finding", "security-body", "security-location", "security-source", "security-body-page", "security-event"].includes(action)) {
    if (!s.detail) return;
    if (action === "security-event") {
      if (!element.dataset.id) return;
      s.bodySelection = { ...s.bodySelection, detectionSnapshotId: element.dataset.id };
      await loadSecurityStream(element.dataset.id);
      return;
    }
    if (action === "security-finding") {
      const finding = s.detail.findings?.find(item => item.id === element.dataset.id);
      const ref = finding?.evidence?.bodyRef || { snapshotId: "unavailable" };
      const source = ref.sourceSnapshotId || ref.snapshotId;
      const snapshotId = canonicalBodySnapshotId(source);
      s.bodySelection = { ...ref, snapshotId, ...(snapshotId !== ref.snapshotId && ref.sourceStart != null ? { start: ref.sourceStart, end: ref.sourceEnd } : {}), ...(snapshotId !== ref.snapshotId ? { detectionSnapshotId: ref.snapshotId } : {}), findingId: finding?.id };
    } else if (action === "security-source") {
      const previous = s.bodySelection;
      const id = element.dataset.id;
      s.bodySelection = { snapshotId: canonicalBodySnapshotId(id), start: previous.sourceStart ?? previous.start, end: previous.sourceEnd ?? previous.end, findingId: previous.findingId };
    } else if (action === "security-body") {
      const id = element.dataset.id;
      s.bodySelection = { snapshotId: canonicalBodySnapshotId(id), start: Number(element.dataset.offset || 0) };
    }
    else if (action === "security-location") s.bodySelection = { ...s.bodySelection, hitUnavailable: false, ...(element.dataset.location ? { location: element.dataset.location } : { start: Number(element.dataset.start), end: Number(element.dataset.end) }) };
    const finding = s.detail.findings?.find(item => item.id === s.bodySelection.findingId);
    const locateCredential = ["security-finding", "security-source"].includes(action) && finding?.ruleId === "SEC-SECRET-001";
    const offset = action === "security-body-page" ? Number(element.dataset.offset) : Math.max(0, (s.bodySelection.start || 0) - 512);
    if (!await loadSecurityBody(offset, locateCredential)) return;
    if (s.bodySelection.detectionSnapshotId) await loadSecurityStream(s.bodySelection.detectionSnapshotId);
    const target = pageContent.querySelector(".security-body-hit") || pageContent.querySelector(".security-body-review");
    target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    target?.focus?.({ preventScroll: true });
    return;
  }
  if (action === "security-back") { await returnSecurityList(); return; }
  if (action === "security-reset") {
    s.detailSequence++; s.filters = { hours: "24" }; s.cursor = ""; s.history = []; s.detail = null; s.bodySelection = null; s.result = null;
  } else if (action === "security-next" && s.result?.nextCursor) {
    s.history.push(s.cursor); s.cursor = s.result.nextCursor;
  } else if (action === "security-prev" && s.history.length) { s.cursor = s.history.pop(); }
  await loadSecurity();
}

function renderDiagnostics() {
  const config = state.config;
  const resolveResult = state.resolveResult;
  return `
    <div class="panel">
      <div class="panel-header"><h2>模型解析测试</h2></div>
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
    <div class="panel">
      <div class="panel-header"><h2>事件记录</h2><button class="mini-button" data-action="refresh">刷新</button></div>
      <div class="panel-body">${state.events.length ? `<div class="list">${state.events.map(eventRow).join("")}</div>` : `<div class="empty">暂无事件</div>`}</div>
    </div>
  `;
}

function modelRow(id, item, active = false) {
  const context = item.contextWindow ? `${item.contextWindow.toLocaleString()} ctx` : "context unset";
  const compact = item.compact?.tokenLimit ? `${item.compact.tokenLimit.toLocaleString()} compact` : "compact unset";
  return `<button class="list-row ${active ? "is-selected" : ""}" data-action="select-model" data-id="${esc(id)}"><div><h3>${esc(id)}</h3><p>${esc(id)} · ${(item.capabilities || []).join(" · ")} · ${esc(context)} · ${esc(compact)}</p></div><span class="status-badge">当前配置</span></button>`;
}

function eventRow(event) {
  const details = [new Date(event.at).toLocaleString()];
  const target = event.data?.upstreamId || event.data?.virtualProviderId || event.data?.bindingId;
  if (target) details.push(target);
  if (event.data?.revision != null) details.push(`配置修订 ${event.data.revision}`);
  return `<div class="list-row"><div><h3>${esc(event.type)}</h3><p>${details.map(esc).join(" · ")}</p></div><span class="table-meta">${esc(event.id)}</span></div>`;
}

function field(label, name, value, placeholder = "", full = false, type = "text", readonly = false, required = false) {
  return `<label class="field ${full ? "full" : ""}"><span>${esc(label)}</span><input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${readonly ? "readonly" : ""} ${required ? "required" : ""} /></label>`;
}

function selectField(label, name, value, items) {
  return `<label class="field"><span>${esc(label)}</span><select name="${esc(name)}" aria-label="${esc(label)}" >${optionList(items, value)}</select></label>`;
}

function checkboxField(label, name, checked) {
  return `<label class="field checkbox-field"><span><input name="${esc(name)}" type="checkbox" ${checked ? "checked" : ""} /> ${esc(label)}</span></label>`;
}

function resolveResultPanel(result) {
  if (!result.ok) {
    return `<div class="subsection"><div class="notice warning">${esc(result.error?.message || "模型解析失败")}</div></div>`;
  }
  return `<div class="subsection"><h3>解析结果</h3><pre class="code-preview">${esc(
    `client model  : ${result.clientModelId}\nmatched model  : ${result.matchedModel || "透传"}\nroute          : ${result.routeId}\nupstream       : ${result.upstreamId}\nupstream model : ${result.upstreamModelId}\ncapabilities   : ${(result.capabilities || []).join(", ")}`,
  )}</pre></div>`;
}

function artifactPanel(artifacts) {
  const isClaude = artifacts.target === "claude-code";
  const title = isClaude
    ? "Claude Code settings.json 应用预览"
    : artifacts.target === "generic-env"
      ? "Generic environment preview"
      : "Codex local config.toml preview";
  const settingsPath = artifacts.settingsPath || (isClaude ? artifacts.applied?.[0] : null);
  const instructions = isClaude
    ? ["以下内容合并到 settings.json 的 env 中，保留其他设置；原值保存以便撤销接入。"]
    : artifacts.instructions || [];
  const files = isClaude
    ? [{ path: "settings.json", contents: JSON.stringify({ env: artifacts.environment?.vars || {} }, null, 2) }]
    : artifacts.files || [];
  const variables = !isClaude && Object.keys(artifacts.environment?.vars || {}).length
    ? `<div class="subsection"><div class="table-meta">ENVIRONMENT</div><pre class="code-preview">${esc(Object.entries(artifacts.environment.vars).map(([key, value]) => `${key}=${value}`).join("\n"))}</pre></div>`
    : "";
  return `
    <div class="subsection">
      <div class="subsection-header"><h3>${title}</h3>${isClaude ? "" : `<span class="field-hint">${esc(artifacts.mode || "managed_proxy")}</span>`}</div>
      ${artifacts.catalogSummary ? `<div class="field-hint">${esc(artifacts.catalogSummary.sourceVersion)} / ${artifacts.catalogSummary.mode === "managed" ? "生成模型目录" : "沿用当前 Codex 目录"}</div>` : ""}
      ${(artifacts.warnings || []).map((message) => `<div class="notice warning">${esc(message)}</div>`).join("")}
      ${settingsPath ? `<p>应用位置：<code>${esc(settingsPath)}</code>，仅合并管理字段。</p>` : ""}
      ${instructions.map((message) => `<p class="field-hint">${esc(message)}</p>`).join("")}
      ${artifacts.changes?.length ? `<p class="field-hint">修改字段：${esc(artifacts.changes.join(", "))}</p>` : ""}
      ${artifacts.conflicts?.length ? `<div class="notice warning">应用已阻止：这些字段在上次应用后被手工修改：${esc(artifacts.conflicts.join(", "))}</div>` : ""}
      ${files.map((file) => file.kind === "json"
        ? `<details class="subsection"><summary>${esc(file.path)}</summary><pre class="code-preview">${esc(file.contents)}</pre></details>`
        : `<div class="subsection"><div class="table-meta">${esc(file.path)}</div><pre class="code-preview">${esc(file.contents)}</pre></div>`).join("")}
      ${variables}
      ${!isClaude && artifacts.environment?.shell ? `<div class="subsection"><div class="table-meta">SETUP COMMAND</div><pre class="code-preview">${esc(artifacts.environment.shell)}</pre></div>` : ""}
      ${!isClaude && artifacts.environment?.powershell ? `<details class="subsection"><summary>PowerShell</summary><pre class="code-preview">${esc(artifacts.environment.powershell)}</pre></details>` : ""}
    </div>
  `;
}

async function handleAction(action, element) {
  if (state.busy) return;
  if (action.startsWith("security-")) {
    try { await securityAction(action, element); }
    catch (error) { toast(error.message, true); }
    return;
  }
  if ([
    "create-suite", "open-suite", "back-overview", "select-model",
    "new-model", "open-advanced-models",
  ].includes(action)) {
    if (!confirmPageLeave()) return;
  }
  const unlock = lockControls();
  try {
    if (action === "refresh") {
      await refresh();
    } else if (action === "refresh-codex-models") {
      state.codexCatalog = await api("/codex/models?refresh=1");
      // Refresh choices without discarding unsaved form inputs or secrets.
      pageContent.querySelectorAll("[data-official-model]").forEach((select) => {
        select.innerHTML = officialModelOptions(select.value);
        updateOfficialModelHint(select);
        syncCodexMetadata(select.closest("[data-suite-model]"));
      });
      pageContent.querySelectorAll(".catalog-status").forEach((status) => {
        status.querySelector("span").textContent = state.codexCatalog.available ? `${state.codexCatalog.version} / ${state.codexCatalog.models.length} 个官方模型` : state.codexCatalog.error.message;
      });
      toast(state.codexCatalog.available ? "模型列表已刷新。" : state.codexCatalog.error.message, !state.codexCatalog.available);
    } else if (action === "reload-form") {
      if (!window.confirm("放弃此表单的本地修改并加载最新配置？")) return;
      render(captureEditedForms(element.closest("form")));
    } else if (action === "create-suite") {
      state.createTarget = "codex";
      state.selected.suite = null;
      state.page = "suite-create";
      render();
    } else if (action === "open-suite") {
      selectSuite(element.dataset.id);
      state.page = "suite-detail";
      render();
    } else if (action === "back-overview") {
      state.page = "overview";
      render();
    } else if (action === "select-model") {
      state.selected.model = element.dataset.id;
      state.page = "models";
      render();
    } else if (action === "new-model") {
      state.selected.model = null;
      state.page = "models";
      render();
    } else if (action === "add-suite-model") {
      const list = pageContent.querySelector("#suite-model-list");
      if (!list) return;
      const wrapper = document.createElement("div");
      const suite = selectedSuite();
      const upstreamId = suite?.upstreamId || null;
      wrapper.innerHTML = suiteModelEditor(suite || {}, "", {
        ...(suite?.target === "codex" ? { codex: { metadataMode: "official" } } : suite?.target === "claude-code" ? {} : { capabilities: ["streaming", "tools", "reasoning"] }),
      }, upstreamId);
      const row = wrapper.firstElementChild;
      list.querySelector(".empty")?.remove();
      list.appendChild(row);
    } else if (action === "remove-suite-model") {
      element.closest("[data-suite-model]")?.remove();
    } else if (action === "add-create-model") {
      const list = pageContent.querySelector("#create-model-list");
      if (!list) return;
      const wrapper = document.createElement("div");
      wrapper.innerHTML = createModelRow();
      const row = wrapper.firstElementChild;
      list.appendChild(row);
    } else if (action === "remove-create-model") {
      const form = element.closest("form");
      element.closest("[data-create-model]")?.remove();
      syncClaudeCreateModels(form);
    } else if (action === "delete-model") {
      if (!window.confirm("删除此配置项？删除后立即生效。")) return;
      await saveChanges(() => removeModel(element.dataset.id), element.closest("form"));
    } else if (action === "test-upstream") {
      await testUpstream(element.dataset.id);
    } else if (action === "toggle-vp") {
      await toggleVirtualProvider(element.dataset.id);
    } else if (action === "preview-artifacts") {
      await previewArtifacts();
    } else if (action === "apply-target") {
      await applyTarget();
    } else if (action === "restore-target") {
      if (hasUnsavedChanges()) throw new Error("请先保存当前编辑，再撤销接入。");
      const suite = selectedSuite();
      if (suite?.target !== "claude-code") throw new Error("请选择 Claude Code 配置");
      await api("/targets/restore", { method: "POST", body: JSON.stringify({ bindingId: suite.bindingId }) });
      state.artifactPreview = null;
      toast("Claude Code 原接入配置已恢复，请重启客户端。");
      render();
    } else if (action === "open-advanced-models") {
      state.page = "models";
      state.selected.model = selectedSuite()?.modelIds?.[0] || null;
      render();
    }
  } catch (error) {
    const form = element?.closest("form");
    if (form) showFormError(form, error);
    else toast(error.message, true);
  } finally {
    unlock();
  }
}

function lockControls() {
  state.busy = true;
  const controls = [...document.querySelectorAll("button, input, select, textarea")];
  for (const control of controls) {
    lockedControls.set(control, control.disabled);
    control.disabled = true;
  }
  return () => {
    for (const control of controls) {
      control.disabled = lockedControls.get(control);
      lockedControls.delete(control);
    }
    state.busy = false;
  };
}

function setControlDisabled(control, disabled) {
  // Metadata may change while an async action temporarily locks all controls.
  if (lockedControls.has(control)) lockedControls.set(control, disabled);
  else control.disabled = disabled;
}

function showFormError(form, error) {
  form.querySelector("[data-form-feedback]")?.remove();
  const feedback = document.createElement("div");
  feedback.className = "notice warning form-feedback";
  feedback.dataset.formFeedback = "";
  feedback.setAttribute("role", "alert");
  feedback.tabIndex = -1;
  const conflict = formConflicts.has(form);
  const message = conflict
    ? "此表单与其他窗口的修改冲突，已暂停保存并保留当前输入。请先复制需要保留的内容，再加载最新配置后重新编辑。"
    : error.status === 409
    ? "配置已在其他窗口变更。点击页面顶部的“刷新”合并最新配置后重试；无法自动合并的修改会提示处理。"
    : error.message || "保存失败，请重试。";
  const errors = error.body?.errors || [];
  feedback.innerHTML = esc(message) + (errors.length
    ? "<ul>" + errors.map((item) => "<li>" + esc(item.path || "") + ": " + esc(item.message) + "</li>").join("") + "</ul>"
    : "") + (conflict ? '<div class="form-actions"><button class="button" type="button" data-action="reload-form">加载最新配置</button></div>' : "");
  form.prepend(feedback);
  feedback.focus({ preventScroll: true });
  feedback.scrollIntoView({ block: "nearest" });
}

async function handleFormSubmit(event, form) {
  event.preventDefault();
  if (state.busy) return;
  if (formConflicts.has(form)) {
    showFormError(form, new Error("请先处理并发修改冲突。"));
    return;
  }
  // Read FormData before disabling controls; disabled inputs are omitted.
  const data = new FormData(form);
  const unlock = lockControls();
  const submitButton = form.querySelector('[type="submit"]');
  const buttonLabel = submitButton?.textContent;
  form.setAttribute("aria-busy", "true");
  form.querySelector("[data-form-feedback]")?.remove();
  try {
    // Inputs named "id" shadow the form.id property in the browser.
    const formId = form.getAttribute("id");
    if (formId === "security-filter-form") {
      state.security.filters = Object.fromEntries([...data.entries()].filter(([, value]) => value));
      state.security.cursor = "";
      state.security.history = [];
      state.security.detail = null;
      state.security.detailSequence++;
      state.security.bodySelection = null;
      state.security.result = null;
      await loadSecurity();
      return;
    }
    if (formId === "resolve-form") {
      if (submitButton) submitButton.textContent = "解析中...";
      await resolveModel(data);
      render([form]);
      toast("模型解析已完成。");
      return;
    }
    if (submitButton) submitButton.textContent = "保存中...";
    const handlers = {
      "suite-create-form": () => saveSuiteCreate(data, form),
      "suite-upstream-form": () => saveSuiteUpstream(data),
      "suite-models-form": () => saveSuiteModels(form),
      "claude-client-form": () => saveClaudeClient(data),
      "model-form": () => saveModel(data, form),
    };
    if (!handlers[formId]) throw new Error("无法保存此表单，请刷新页面后重试。");
    await saveChanges(handlers[formId], form);
  } catch (error) {
    showFormError(form, error);
  } finally {
    if (submitButton) submitButton.textContent = buttonLabel;
    form.removeAttribute("aria-busy");
    unlock();
  }
}

function syncModelSelections(suite, renames, nextModels) {
  const sync = (value, nativeAliases = []) => {
    if (nativeAliases.includes(value)) return value;
    if (renames.has(value)) return renames.get(value);
    if (Object.hasOwn(nextModels, value)) return value;
    if (suite.target === "claude-code" || Object.hasOwn(suite.virtualProvider.models || {}, value)) return undefined;
    return value;
  };
  const defaults = suite.target === "claude-code" ? CLAUDE_MODEL_ALIASES.defaultModel : [];
  const defaultModel = suite.target === "claude-code" ? sync(claudeDefaultModel(suite), defaults) : undefined;
  suite.virtualProvider.defaultModel = suite.target === "claude-code" ? defaultModel : sync(suite.virtualProvider.defaultModel);
  suite.binding.defaultModel = suite.target === "claude-code" ? defaultModel : sync(suite.binding.defaultModel);
  if (suite.target === "claude-code" && suite.binding.claude) {
    for (const [family, value] of entries(suite.binding.claude.models)) {
      suite.binding.claude.models[family] = sync(value, family === "subagent" ? CLAUDE_MODEL_ALIASES.subagent : []);
    }
    suite.binding.claude.setModel = Boolean(suite.binding.defaultModel || suite.virtualProvider.defaultModel);
  }
}

function removeModel(id) {
  const suite = selectedSuite();
  const models = { ...suite.virtualProvider.models };
  delete models[id];
  syncModelSelections(suite, new Map(), models);
  suite.virtualProvider.models = models;
  state.selected.model = firstKey(models);
}

function saveSuiteModels(form) {
  const suite = selectedSuite();
  if (!suite) throw new Error("找不到当前配置套装");
  const modelRows = [...form.querySelectorAll("[data-suite-model]")];

  const upstreamId = suite.upstreamId;
  if (!upstreamId || !state.candidate.upstreams[upstreamId]) {
    throw new Error("当前配置套装没有可用的上游");
  }

  const clientModelIds = modelRows.map(
    (row) => row.querySelector("[data-suite-model-client]")?.value.trim() || "",
  );
  if (clientModelIds.some((id) => !id)) throw new Error("每个模型都必须填写客户端模型 ID");
  if (new Set(clientModelIds).size !== clientModelIds.length) {
    throw new Error("客户端模型 ID 不能重复");
  }

  const renames = new Map();
  const nextModels = Object.create(null);
  for (const row of modelRows) {
    const oldId = row.dataset.modelId || "";
    const existing = suite.virtualProvider.models?.[oldId] || {};
    const clientModelId = row.querySelector("[data-suite-model-client]").value.trim();
    if (oldId) renames.set(oldId, clientModelId);

    const upstreamInput = row.querySelector(
      `[data-suite-model-upstream="${CSS.escape(upstreamId)}"]`,
    );
    const capabilityInput = row.querySelector(
      `[data-suite-model-capabilities="${CSS.escape(upstreamId)}"]`,
    );
    const upstreamModelId = upstreamInput?.value.trim() || "";
    const capabilityOverrides = capabilityInput ? commaList(capabilityInput.value) : existing.capabilityOverrides || [];
    const capabilities = commaList(
      row.querySelector("[data-suite-model-capabilities-common]")?.value,
    );
    const aliasInput = row.querySelector("[data-suite-model-aliases]");
    nextModels[clientModelId] = {
      ...existing,
      ...(aliasInput ? { aliases: commaList(aliasInput.value) } : {}),
      family: existing.family || (suite.target === "claude-code" ? "claude" : "codex"),
      ...(suite.target === "claude-code" ? {
        description: undefined,
      } : { capabilities: capabilities.length ? capabilities : ["streaming", "tools", "reasoning"] }),
      ...(suite.target === "codex" ? codexModelFields(clientModelId, existing, row) : suite.target === "claude-code" ? {} : {
        contextWindow: Number(row.querySelector("[data-suite-model-context]")?.value || 1000000),
        compact: {
        strategy: row.querySelector("[data-suite-model-compact]")?.value || "auto",
        tokenLimit: Number(
          row.querySelector("[data-suite-model-compact-limit]")?.value || 850000,
        ),
        },
      }),
      upstreamModelId: upstreamModelId || undefined,
      capabilityOverrides: capabilityOverrides.length ? capabilityOverrides : undefined,
    };
  }

  syncModelSelections(suite, renames, nextModels);
  suite.virtualProvider.models = nextModels;
  selectSuite(suite.bindingId);

}

function saveClaudeClient(data) {
  const suite = selectedSuite();
  if (suite?.target !== "claude-code") throw new Error("请选择 Claude Code 配置");
  const clientIds = suite.models.map(({ id }) => id);
  const defaultModel = claudeModelChoice("defaultModel", clientIds, data.get("defaultModel"));
  const models = Object.fromEntries(["opus", "sonnet", "fable", "haiku", "subagent"].map((family) =>
    [family, String(data.get(family) || "").trim()]).filter(([, value]) => value));
  const subagent = claudeModelChoice("subagent", clientIds, models.subagent);
  if (subagent) models.subagent = subagent;
  else delete models.subagent;
  const ids = new Set(clientIds);
  for (const family of ["opus", "sonnet", "fable", "haiku"]) {
    const previous = suite.binding.claude?.models?.[family];
    if (data.get(family) == null && previous && !ids.has(previous)) throw new Error(`${family} 别名指向未配置的模型，请重新选择`);
    if (models[family] && !ids.has(models[family])) throw new Error(`${family} 别名请选择当前配置中已保存的客户端模型 ID`);
  }
  suite.binding.defaultModel = defaultModel || undefined;
  suite.virtualProvider.defaultModel = defaultModel || undefined;
  suite.binding.claude = { ...suite.binding.claude, setModel: Boolean(defaultModel), models, discoverModels: data.get("discoverModels") === "on" };
}

function saveSuiteCreate(data, form) {
  const upstreamBaseUrl = String(data.get("upstreamBaseUrl") || "").trim();
  const upstreamSecret = String(data.get("upstreamSecret") || "").trim();
  const target = String(data.get("target") || "codex").trim();
  if (!["codex", "claude-code"].includes(target)) throw new Error("请选择 Codex 或 Claude Code");
  const defaults = suiteDefaults(target);
  const isClaude = target === "claude-code";
  const protocol = isClaude ? "anthropic.messages" : "openai.responses";
  const suiteName = String(data.get("suiteName") || "").trim();
  const modelEntries = [...form.querySelectorAll("[data-create-model]")].map((row) => {
    const read = (key) =>
      row.querySelector(`[data-create-field="${CSS.escape(key)}"]`)?.value.trim() || "";
    return {
      clientModelId: read("clientModelId"),
      upstreamModelId: read("upstreamModelId"),
    };
  });
  if (!upstreamBaseUrl || !upstreamSecret) {
    throw new Error("请填写上游地址和上游 API Key");
  }
  const missingModelField = modelEntries.find(
    (model) => !model.clientModelId,
  );
  if (missingModelField) {
    throw new Error("添加模型设置时请选择客户端模型");
  }
  const clientModelIds = modelEntries.map((model) => model.clientModelId);
  if (new Set(clientModelIds).size !== clientModelIds.length) {
    throw new Error("Client model ID 不能重复");
  }
  const defaultModel = isClaude ? claudeModelChoice("defaultModel", clientModelIds, data.get("defaultModel")) : "";
  const claudeModels = isClaude ? Object.fromEntries(["opus", "sonnet", "fable", "haiku", "subagent"]
    .map((family) => [family, String(data.get(family) || "").trim()]).filter(([, value]) => value)) : {};
  const subagent = claudeModelChoice("subagent", clientModelIds, claudeModels.subagent);
  if (subagent) claudeModels.subagent = subagent;
  else delete claudeModels.subagent;
  for (const family of ["opus", "sonnet", "fable", "haiku"]) {
    if (claudeModels[family] && !clientModelIds.includes(claudeModels[family])) {
      throw new Error(`${family} 别名请选择本次填写的客户端模型 ID`);
    }
  }

  const upstreamId = defaults.upstreamId;
  const upstreamName = upstreamDisplayName(upstreamBaseUrl, upstreamId);
  const routeId = defaults.routeId;
  const name = suiteName || `${targetLabel(target)} / ${upstreamName}`;
  const bindingId = configurationId(name, defaults.bindingId);
  const virtualProviderId = providerIdForConfiguration(bindingId);
  if (Object.hasOwn(state.candidate.bindings, bindingId) || Object.hasOwn(state.candidate.virtualProviders, virtualProviderId)) {
    throw new Error(`配置名称对应的 ID 已存在: ${bindingId}，请使用不同的配置名称`);
  }
  const models = Object.fromEntries(modelEntries.map((model) => [model.clientModelId, {
    family: isClaude ? "claude" : "codex",
    ...(isClaude ? {} : codexModelFields(model.clientModelId)),
    ...(model.upstreamModelId ? { upstreamModelId: model.upstreamModelId } : {}),
  }]));
  const modelIds = Object.keys(models);

  state.candidate.upstreams[upstreamId] = {
    id: upstreamId,
    name: upstreamName,
    ...(isClaude ? { auth: { header: data.get("upstreamAuth") || "x-api-key" } } : { integration: "codex-native-provider" }),
    protocol,
    baseUrl: upstreamBaseUrl,
    secretRef: `secret://upstreams/${upstreamId}`,
    enabled: true,
  };
  state.candidate.routes[routeId] = {
    id: routeId,
    name: `${upstreamName} route`,
    backends: [
      {
        upstream: upstreamId,
        enabled: true,
      },
    ],
  };
  state.candidate.virtualProviders[virtualProviderId] = {
    id: virtualProviderId,
    name: `${targetLabel(target)} via ${upstreamName}`,
    ingressProtocol: protocol,
    route: routeId,
    models,
    ...(defaultModel ? { defaultModel } : {}),
    enabled: true,
  };
  state.candidate.bindings[bindingId] = {
    id: bindingId,
    name,
    target,
    ...(isClaude ? {} : { integration: "codex-native-provider" }),
    targetFormat: isClaude ? "claude.settings.json.v1" : "codex.config.toml.v1",
    mode: "config",
    virtualProvider: virtualProviderId,
    ...(isClaude ? {
      ...(defaultModel ? { defaultModel } : {}),
      claude: {
        ...(defaultModel ? { setModel: true } : {}),
        ...(Object.keys(claudeModels).length ? { models: claudeModels } : {}),
      },
    } : { codex: {} }),
  };

  state.pendingSecrets.upstreamSecrets[upstreamId] = upstreamSecret;

  state.selected.model = modelIds[0] || null;
  state.selected.virtualProvider = virtualProviderId;
  state.selected.suite = bindingId;
  state.page = "suite-detail";

}

function saveSuiteUpstream(data) {
  const id = String(data.get("id") || "").trim();
  if (!id) throw new Error("upstream ID 不能为空");
  const existing = state.candidate.upstreams[id] || {};
  state.candidate.upstreams[id] = {
    ...existing,
    id,
    name: String(data.get("name") || id).trim(),
    ...(data.get("protocol") === "openai.responses"
      ? { integration: "codex-native-provider" }
      : {}),
    protocol: data.get("protocol"),
    baseUrl: String(data.get("baseUrl") || "").trim(),
    secretRef: existing.secretRef || `secret://upstreams/${id}`,
    enabled: existing.enabled !== false,
  };
  if (data.get("protocol") !== "openai.responses") {
    delete state.candidate.upstreams[id].integration;
  }
  if (data.get("protocol") === "anthropic.messages" && data.get("authHeader")) {
    const header = String(data.get("authHeader"));
    const previous = existing.auth?.header || existing.authHeader || "x-api-key";
    if (header !== previous) {
      state.candidate.upstreams[id].auth = { header, ...(header === "authorization" ? { scheme: "Bearer" } : {}) };
      delete state.candidate.upstreams[id].authHeader;
    }
  }
  const secret = String(data.get("secret") || "").trim();
  if (secret) {
    state.pendingSecrets.upstreamSecrets[id] = secret;
  }
  state.page = "suite-detail";
}

function saveModel(data, form) {
  const suite = selectedSuite();
  if (!suite) throw new Error("找不到当前配置");
  const oldName = state.selected.model;
  const name = String(data.get("clientModelId") || "").trim();
  if (!name) throw new Error("客户端模型 ID 不能为空");
  const models = { ...suite.virtualProvider.models };
  if (name !== oldName && Object.hasOwn(models, name)) throw new Error("客户端模型 ID 不能重复");
  const existing = oldName && Object.hasOwn(models, oldName) ? models[oldName] : {};
  if (oldName) delete models[oldName];
  Object.defineProperty(models, name, { enumerable: true, configurable: true, writable: true, value: {
    ...existing,
    aliases: commaList(data.get("aliases")),
    family: String(data.get("family") || "codex").trim(),
    capabilities: commaList(data.get("capabilities")),
    contextWindow: Number(data.get("contextWindow") || 1000000),
    compact: {
      strategy: String(data.get("compactStrategy") || "auto").trim(),
      tokenLimit: Number(data.get("compactTokenLimit") || 850000),
    },
    upstreamModelId: String(data.get("upstreamModelId") || "").trim() || undefined,
    capabilityOverrides: commaList(data.get("capabilityOverrides")),
  } });
  syncModelSelections(suite, new Map(oldName ? [[oldName, name]] : []), models);
  suite.virtualProvider.models = models;
  state.selected.model = name;
}

async function testUpstream(id) {
  const result = await api("/tests/upstream", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  toast(`${id}: ${result.message}，${result.latencyMs}ms${result.secretConfigured ? "" : "，未找到 API key"}`, !result.ok);
  await refresh(false);
}

async function toggleVirtualProvider(id) {
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


async function resolveModel(data) {
  try {
    state.resolveResult = await api("/tests/model-resolve", {
      method: "POST",
      body: JSON.stringify({
        config: state.config,
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
  const preservedForms = captureEditedForms();
  const result = await api("/config/preview-target-artifacts", {
    method: "POST",
    body: JSON.stringify({
      config: state.config,
      bindingId: state.selected.suite,
    }),
  });
  state.artifactPreview = result.artifacts;
  const target = result.artifacts?.target;
  toast(target === "codex" ? "已生成 Codex 本地 config.toml 预览。" : target === "claude-code" ? "已生成 Claude Code 配置预览；预览不会写入文件。" : "已生成环境配置预览；请将这些变量注入对应客户端。");
  render(preservedForms);
}

async function applyTarget() {
  if (hasUnsavedChanges()) {
    throw new Error("请先保存当前编辑，再应用到 CLI。");
  }
  const suite = selectedSuite();
  if (!suite) throw new Error("请先选择一个配置套装。");
  const binding = suite.binding;
  if (!["codex", "claude-code"].includes(binding?.target)) {
    await previewArtifacts();
    return;
  }
  const result = await api("/targets/apply", {
    method: "POST",
    body: JSON.stringify({ bindingId: suite.bindingId }),
  });
  state.artifactPreview = result.report ? {
    ...result.report,
    target: result.target,
    bindingId: suite.bindingId,
    mode: result.report.mode || "managed_proxy",
  } : null;
  toast(`${targetLabel(binding.target)} 配置已应用，请重启客户端。`);
  render();
}

async function saveChanges(update, form) {
  const previous = {
    page: state.page,
    selected: clone(state.selected),
  };
  const preservedForms = captureEditedForms(form);
  state.candidate = clone(state.config);
  state.pendingSecrets = { upstreamSecrets: {} };
  try {
    update();
    const identities = normalizeConfigurationIdentities(state.candidate);
    state.selected.suite = identities.bindingIds.get(state.selected.suite) ?? state.selected.suite;
    state.selected.virtualProvider = identities.providerIds.get(state.selected.virtualProvider) ?? state.selected.virtualProvider;
    // The commit endpoint validates and applies the change atomically.
    const result = await api("/config/commit", {
      method: "POST",
      body: JSON.stringify({
        baseRevision: state.config.revision,
        config: state.candidate,
        upstreamSecrets: state.pendingSecrets.upstreamSecrets,
      }),
    });
    state.config = result.config;
    state.runtime = result.runtime;
    state.artifactPreview = null;
    state.resolveResult = null;
    state.events.unshift({
      id: "local-" + Date.now(),
      type: "config.commit",
      at: new Date().toISOString(),
      data: { revision: result.revision },
    });
  } catch (error) {
    Object.assign(state, previous);
    throw error;
  } finally {
    state.candidate = clone(state.config);
    state.pendingSecrets = { upstreamSecrets: {} };
  }
  render(state.page === previous.page ? preservedForms : []);
  toast("配置已保存并生效。");
}

async function refresh(showToast = true) {
  if (state.page === "security-detail") { await loadSecurityDetail(state.security.detailId, false); return; }
  if (state.page === "security") { await loadSecurity(); return; }
  const preservedForms = captureEditedForms();
  const [configResult, runtime, events] = await Promise.all([
    api("/config"),
    api("/runtime"),
    api("/events"),
  ]);
  state.config = configResult.config;
  state.candidate = clone(state.config);
  state.pendingSecrets = { upstreamSecrets: {} };
  state.runtime = runtime;
  state.events = events.events || [];
  if (showToast) toast("状态已刷新。");
  render(preservedForms);
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
  item.addEventListener("click", () => navigatePage(item.dataset.page));
});

document.querySelector("#refresh-button").addEventListener("click", () => {
  if (state.busy) return;
  if (!state.config) bootstrap();
  else handleAction("refresh");
});

bootstrap();
