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
let renderedTraceId = null;
let renderedTraceDetailId = null;
let renderedTraceTab = null;
const securityEvidenceCache = new WeakMap();

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
  security: "审计记录",
  "security-detail": "审计详情",
  "security-session": "会话轨迹",
};

const state = {
  page: "overview",
  config: null,
  candidate: null,
  runtime: null,
  events: [],
  codexCatalog: null,
  createTarget: "codex",
  transfer: { panel: null, bundle: null, preview: null },
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
  trace: { sequence: 0, id: null, summary: null, result: null, loadingMore: false, moreError: null, tab: "overview", search: "", riskOnly: false, scale: "order", loading: false, error: null },
  security: { bodySelection: null, bodyPage: null, streamPage: null, streamPageSnapshotId: null, streamSequence: 0, streamLoading: false, streamError: null, detailSequence: 0, detailId: null, detailLoading: false, detailError: null, listScroll: { x: 0, y: 0 }, filters: { hours: "24" }, cursor: "", history: [], result: null, status: null, detail: null, loading: false, error: null, sequence: 0, updatedAt: null },
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
    "security-session": renderSecuritySession,
  };
  const traceListFocused = document.activeElement?.classList?.contains("trace-event-list");
  const paneScroll = state.page === "security-session" && renderedTraceId === state.trace.id
    ? [...pageContent.querySelectorAll(".trace-event-list, .trace-inspector-body")].map(node => ({
      selector: node.classList.contains("trace-event-list") ? ".trace-event-list" : ".trace-inspector-body",
      top: node.scrollTop,
    })) : [];
  pageContent.innerHTML = renderers[state.page]();
  for (const pane of paneScroll) {
    if (pane.selector === ".trace-inspector-body" && (renderedTraceDetailId !== state.security.detailId || renderedTraceTab !== state.trace.tab)) continue;
    const node = pageContent.querySelector(pane.selector);
    if (node) node.scrollTop = pane.top;
  }
  if (traceListFocused) pageContent.querySelector(".trace-event-list")?.focus({ preventScroll: true });
  renderedTraceId = state.page === "security-session" ? state.trace.id : null;
  renderedTraceDetailId = state.security.detailId;
  renderedTraceTab = state.trace.tab;
  if (state.page === "security-session") {
    pageContent.querySelector(".trace-event-list")?.addEventListener("scroll", event => {
      const list = event.currentTarget;
      if (list.scrollHeight - list.scrollTop - list.clientHeight < 160 && !state.trace.moreError) loadMoreSecurityTrace();
    }, { passive: true });
  }
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
  return captureEditedForms().some((form) => !["resolve-form", "security-filter-form", "security-trace-search"].includes(form.getAttribute("id")));
}

function confirmPageLeave() {
  return !hasUnsavedChanges() || window.confirm("有未保存的修改，确定放弃并离开？");
}

function navigatePage(page) {
  if (state.busy || !state.config || page === state.page || !confirmPageLeave()) return;
  if (page === "security" && state.page.startsWith("security-")) { returnSecurityList(); return; }
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
  if (element.dataset.action === "security-content-source") event.preventDefault();
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
      <td data-label="操作"><button class="button button-danger" type="button" data-action="delete-suite" data-id="${esc(suite.id)}" aria-label="删除配置 ${esc(suite.name)}">删除</button></td>
    </tr>
  `;
}

function renderOverview() {
  const suites = configurationSuites(state.candidate);
  return `
    <div class="suite-toolbar">
      <span class="muted">${suites.length} 套配置</span>
      <div class="suite-toolbar-actions">
        <button class="button" data-action="import-suites">导入配置</button>
        <button class="button" data-action="export-suites" ${suites.length ? "" : "disabled"}>导出配置</button>
        <button class="button button-primary" data-action="create-suite">新建配置</button>
      </div>
    </div>
    ${renderTransfer(suites)}
    ${
      suites.length
        ? `<div class="suite-list"><table class="suite-table" aria-label="配置套装"><thead><tr><th scope="col">配置名称</th><th scope="col">CLI</th><th scope="col">模型设置</th><th scope="col">本地地址</th><th scope="col">本地服务</th><th scope="col">操作</th></tr></thead><tbody>${suites.map(suiteRow).join("")}</tbody></table></div>`
        : `<div class="panel"><div class="empty">暂无配置</div></div>`
    }
  `;
}

function renderTransfer(suites) {
  const close = '<button class="button button-quiet" type="button" data-action="close-transfer">取消</button>';
  const notice = '<p class="muted">仅包含 CableTidy 配置套装。客户端文件、运行记录和管理台设置不包含在内。默认导出不含认证凭据。</p>';
  if (state.transfer.panel === "export") return `
    <form id="suite-export-form" class="panel transfer-panel">
      <h2>导出配置</h2>${notice}
      <fieldset class="transfer-selection"><legend>选择要导出的配置套装</legend>
        ${suites.map(suite => `<label class="checkbox-field"><input type="checkbox" name="bindingIds" value="${esc(suite.id)}" checked /><span>${esc(suite.name)} · ${esc(targetLabel(suite.target))}</span></label>`).join("")}
      </fieldset>
      <label class="checkbox-field"><input type="checkbox" name="includeCredentials" /><span>包含认证凭据（API Key、上游密钥及 URL 认证信息）</span></label>
      <p class="muted">勾选后文件包含明文凭据，请妥善保管，仅分享给可信接收方。</p>
      <div class="form-actions">${close}<button class="button button-primary" type="submit">下载配置文件</button></div>
    </form>`;
  if (state.transfer.panel === "import") {
    const preview = state.transfer.preview;
    return `<form id="suite-import-form" class="panel transfer-panel">
      <h2>导入配置</h2>${notice}
      ${preview ? `<p>共 ${preview.suites.length} 套配置。同名配置请选择更新已有配置或创建新配置；未使用文件凭据时，更新保留已有密钥，新建配置需填写凭据。客户端文件需按需重新应用。</p>
        ${preview.hasCredentials ? `<label class="checkbox-field"><input type="checkbox" name="useImportedCredentials" checked /><span>使用导入配置中的认证凭据</span></label><p class="muted">勾选时文件中的凭据优先于已有凭据；取消勾选时忽略文件中的密钥和 URL 认证信息。</p>` : ""}
        <div class="transfer-selection">${preview.suites.map(suite => suite.conflict
          ? `<label class="field"><span>${esc(suite.sourceName)} · ${esc(targetLabel(suite.target))}（与「${esc(suite.existingName || suite.sourceName)}」同名）</span>
            <select name="choice:${esc(suite.sourceId)}" required><option value="">请选择处理方式</option><option value="update">更新已有配置</option><option value="create">创建新配置（${esc(suite.name)}）</option></select></label>`
          : `<p>${esc(suite.name)} · ${esc(targetLabel(suite.target))} · 新建配置</p>`).join("")}</div>
        ${(preview.warnings || []).map(w => `<p class="muted">${esc(w.message)}</p>`).join("")}
        <div class="form-actions">${close}<button class="button" type="button" data-action="import-suites">重新选择文件</button><button class="button button-primary" type="submit">确认导入</button></div>`
      : `<label class="field"><span>配置套装文件（JSON）</span><input type="file" name="bundle" accept=".json,application/json" required /></label>
        <div class="form-actions">${close}<button class="button button-primary" type="submit">预览导入</button></div>`}
    </form>`;
  }
  return "";
}

async function exportSuites(data) {
  const bindingIds = data.getAll("bindingIds");
  if (!bindingIds.length) throw new Error("请至少选择一套配置。");
  const includeCredentials = data.get("includeCredentials") === "on";
  const bundle = await api("/config/export", { method: "POST", body: JSON.stringify({ bindingIds, includeCredentials }) });
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2) + "\n"], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `cabletidy-configurations-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已导出 ${bindingIds.length} 套配置${includeCredentials ? "，包含明文认证凭据，请妥善保管。" : "，不包含认证凭据。"}`);
}

async function importSuites(data) {
  if (!state.transfer.preview) {
    const file = data.get("bundle");
    if (!file?.size) throw new Error("请选择配置套装文件。");
    if (file.size > 8 * 1024 * 1024) throw new Error("配置套装文件不能超过 8 MiB。");
    let bundle;
    try { bundle = JSON.parse(await file.text()); }
    catch { throw new Error("配置套装文件不是有效的 JSON。"); }
    const preview = await api("/config/import", { method: "POST", body: JSON.stringify({ bundle, preview: true }) });
    state.transfer.bundle = bundle;
    state.transfer.preview = preview;
    render();
    return;
  }
  const choices = {};
  for (const suite of state.transfer.preview.suites) {
    if (!suite.conflict) continue;
    const choice = data.get(`choice:${suite.sourceId}`);
    if (!["update", "create"].includes(choice)) throw new Error("请选择每套同名配置的处理方式。");
    choices[suite.sourceId] = choice;
  }
  const result = await api("/config/import", { method: "POST", body: JSON.stringify({
    bundle: state.transfer.bundle, baseRevision: state.transfer.preview.baseRevision,
    choices,
    useImportedCredentials: state.transfer.preview.hasCredentials && data.get("useImportedCredentials") === "on",
  }) });
  state.config = result.config;
  state.candidate = clone(result.config);
  state.runtime = result.runtime;
  state.transfer = { panel: null, bundle: null, preview: null };
  render();
  toast("配置已导入。请为未配置凭据的上游填写认证信息，再按需应用到客户端。");
}

function suiteModelEditor(suite, modelId, profile, upstreamId) {
  const model = profile || {};
  const isCodex = suite.target === "codex";
  const expanded = isCodex && (model.codex?.metadataMode === "override" || Boolean(model.compact)
    || (!model.codex && Boolean(model.contextWindow)));
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
        <summary><span>${isCodex ? "模型能力与上下文" : "模型能力"}</span><span class="field-hint" data-model-policy-summary>${isCodex ? model.codex?.metadataMode === "override" ? "覆盖上游限制" : "沿用官方定义" : "自定义设置"}</span></summary>
        <div class="form-grid suite-model-policy">
          ${isCodex ? codexMetadataFields(model, modelId) : `
          <label class="field full"><span>Capabilities</span><input data-suite-model-capabilities-common value="${esc((model.capabilities || ["streaming", "tools", "reasoning"]).join(", "))}" placeholder="streaming, tools, reasoning" /></label>
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
  if (!panel.open || !pageContent.contains(panel)) return;
  // Rendering an already-selected panel also fires toggle; preserve its page and risk selection.
  if (panel.matches("[data-security-snapshot]") && panel.dataset.securitySnapshot !== state.security.bodySelection?.snapshotId) {
    securityAction("security-body", { dataset: { id: panel.dataset.securitySnapshot } });
  } else if (panel.matches("[data-security-event]")) {
    securityAction("security-event", { dataset: { id: panel.dataset.securityEvent } });
  }
}, true);

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
      <div class="suite-status"><span>${esc(targetLabel(binding.target))} · ${suite.models.length ? `${suite.models.length} 项模型设置` : "模型名直接透传"}</span><span class="status-badge ${providerStatus.className}">${esc(providerStatus.label)}</span><button class="button button-danger" type="button" data-action="delete-suite" data-id="${esc(suite.id)}">删除配置</button></div>
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
          <div><h2 id="suite-models-title">模型设置（可选）</h2><p>${suite.target === "claude-code" ? "默认透传模型名；改名时填写 Claude Code 请求中的完整模型 ID。模型能力、上下文和压缩由客户端与上游决定。" : suite.target === "generic-env" ? "默认透传请求中的模型名；需要改名或限制能力时再添加设置。" : "默认透传请求中的模型名；需要改名或覆盖上下文等参数时再添加设置。"}</p></div>
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
            <span class="field-hint">${suite.target === "claude-code" || suite.target === "generic-env" ? "上游模型 ID 留空时原样透传。" : "按需展开模型能力与上下文设置。"}</span>
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
      <div class="form-actions"><button class="button" type="submit">保存模型选择</button></div>
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
  kind: { request: "模型请求", system: "审计状态" },
  action: { "model.request": "模型请求", "tokens.count": "Token 计数", "audit.gap": "审计记录缺口" },
  basis: { system_wide_damage_possible: "显式关闭根目录保护，可能造成系统范围的数据破坏", credential_exposure_possible: "凭据可能暴露在模型内容或联网操作中", working_data_loss_possible: "操作可能丢弃工作区数据或影响较大目录范围", broad_write_access_possible: "操作可能向所有用户开放写权限", unreviewed_remote_code_execution: "远程内容直接进入代码解释器", sensitive_goal_redirection_possible: "外部指令试图将原任务引向敏感操作", scoped_sensitive_operation: "涉及有限范围的数据修改、敏感读取或权限变更", known_credential_match: "内容与本地已知凭据匹配", credential_pattern_match: "仅匹配凭据格式，尚未验证其有效性", heuristic_keyword_combination: "命中指令覆盖与敏感动作的启发式组合", network_sensitive_file_reference: "联网命令引用敏感文件，未确认实际发送", recognized_literal_tool_arguments: "已识别的工具参数或字面量命令结构", internal_endpoint_pattern_match: "内容包含内网地址、端口或 URL 用户名", public_endpoint_pattern_match: "内容包含公网服务器地址,泄露后可被直接访问" },
  rule: { "SEC-SECRET-001": "内容中发现凭据特征", "SEC-READ-001": "读取敏感文件", "SEC-DELETE-001": "递归删除目录", "SEC-DELETE-002": "补丁删除文件", "SEC-VCS-001": "丢弃工作区修改", "SEC-CONFIG-001": "修改代理或安全配置", "SEC-PRIV-001": "请求提升执行权限", "SEC-PRIV-002": "授予所有用户写权限", "SEC-EXEC-001": "下载内容直接交给解释器执行", "SEC-EXEC-002": "动态代码执行", "SEC-EXPORT-001": "联网命令引用敏感文件", "SEC-INJECT-001": "外部内容要求改写目标并执行敏感操作", "SEC-INTERNAL-001": "内网地址或身份标识", "SEC-ENDPOINT-001": "公网服务器地址暴露" },
  reason: { header_storage_or_processing_failure: "请求或响应头保存失败", invalid_json_or_structure_budget: "JSON 不完整或超出解析栈预算，仅保留已解析的前缀", evidence_storage_unavailable: "检测快照写入失败", audit_metadata_budget: "审计元数据写入有缺口", redaction_buffer_budget: "凭据检测工作区不足，或长 URL 认证区、令牌前缀无法确认", invalid_sse_event: "流式事件无法解析，仅按文本检查", shared_encrypted_spool_budget: "共享临时空间或内存不足，正文保留有缺口", shared_working_memory_budget: "共享内存不足，部分工具参数无法完整解析", shared_detection_budget: "共享检测资源不足，风险发现可能不完整", credential_redaction_budget: "凭据匹配资源不足，检测可能不完整", body_storage_or_processing_failure: "正文存储或处理失败", body_not_complete: "正文接收未完成", unstructured_content: "非结构化或无效 JSON，仅完成文本规则检查", non_text_or_reasoning_semantics: "非文本或推理内容的语义不在规则覆盖范围", inspection_worker_failed: "检测任务失败", incomplete_body_fragment: "正文末尾不完整", incomplete_stream_fragment: "流式内容未结束，部分片段无法完整检查", stream_item_metadata_missing: "流式条目缺少工具类型或名称", credential_catalog_limit: "部分本地凭据超出支持的数量或长度范围", concurrent_inspection_limit: "并发检查数量达到上限", request_inspection_limit: "请求内容检查达到上限", response_inspection_limit: "响应内容检查达到上限", sse_event_limit: "流式事件过大", tool_argument_limit: "工具参数过大", finding_limit: "单次请求风险数量达到上限", unsupported_tool: "工具语义暂不支持", unsupported_tool_arguments: "工具参数结构暂不支持", unsupported_shell_syntax: "命令包含暂不解析的展开或复合语法", unsupported_shell_wrapper: "命令包装方式暂不支持", shell_nesting_limit: "嵌套命令达到检查上限", external_script_not_inspected: "无法观察脚本文件内容", command_semantics_not_inspected: "命令语义未覆盖", dynamic_code_not_inspected: "动态代码内容未检查", non_text_content: "包含非文本内容", opaque_content: "包含不透明或加密内容", reasoning_content_not_inspected: "推理文本已做凭据检查，推理语义未覆盖", unsupported_response_event: "包含未知响应事件，部分语义未覆盖", unsupported_response_item: "包含未知响应项", invalid_response_json: "响应无法解析为 JSON", invalid_event_json: "流式事件 JSON 无效", invalid_event_encoding: "流式事件编码无效", unterminated_sse_event: "流式事件未完整结束", missing_terminal_event: "未观察到协议结束事件", incomplete_response_item: "响应项尚未完整返回", missing_tool_start: "缺少工具调用开始事件", invalid_tool_arguments: "工具参数无法解析", response_item_limit: "响应项数量达到上限", text_item_limit: "文本项达到检查上限", response_not_complete: "响应未完整接收", request_not_inspected: "请求未进入内容检查", request_interrupted: "请求在响应前中断", daemon_restarted: "上次进程未记录请求结束", historical_context_not_visible: "引用的历史上下文未经过本次请求" },
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
  state.trace.sequence++;
  s.detailSequence++; s.bodySequence = (s.bodySequence || 0) + 1;
  s.detail = null; s.detailId = null; s.bodyPage = null; s.streamSequence = (s.streamSequence || 0) + 1; s.streamPage = null; s.streamPageSnapshotId = null; s.streamError = null; s.bodySelection = null;
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
  const sessionMatch = window.location.hash.match(/^#security\/session\/([^/]+)$/);
  if (sessionMatch) { await loadSecuritySession(decodeURIComponent(sessionMatch[1])); return; }
  state.trace.sequence++;
  if (match) { await loadSecurityDetail(decodeURIComponent(match[1])); return; }
  if (window.location.hash === "#security") { await showSecurityList(); return; }
  state.security.detailSequence++; state.security.bodySequence = (state.security.bodySequence || 0) + 1;
  state.page = PAGE_META[navigation?.page] && !navigation.page.startsWith("security") ? navigation.page : "overview";
  render();
}

function securityDetailVisible() { return ["security-detail", "security-session"].includes(state.page); }

async function loadSecurityDetail(id, reset = true, embedded = false, prefetched = null) {
  const s = state.security;
  const sequence = ++s.detailSequence;
  s.contentLoading = false; s.contentError = null; s.responseContentLoading = false; s.responseContentError = null;
  s.contentNavigation = null;
  s.sequence++; s.loading = false; s.detailId = id; s.detailLoading = true; s.detailError = null;
  s.bodySequence = (s.bodySequence || 0) + 1;
  const offset = reset ? 0 : s.bodyPage?.offset ?? s.bodySelection?.start ?? 0;
  if (reset) { s.detail = null; s.bodyPage = null; s.streamSequence = (s.streamSequence || 0) + 1; s.streamPage = null; s.streamPageSnapshotId = null; s.streamError = null; s.bodySelection = { snapshotId: "request" }; }
  if (!embedded) state.page = "security-detail";
  else window.history.replaceState({ ...window.history.state, sessionRequestId: id }, "");
  render();
  if (reset && !embedded) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  try {
    const result = prefetched || await api(`/security/audit/${encodeURIComponent(id)}`);
    if (sequence !== s.detailSequence || !securityDetailVisible()) return;
    s.detail = result.record;
  } catch (error) {
    if (sequence !== s.detailSequence || !securityDetailVisible()) return;
    s.detail = null; s.bodyPage = null; s.streamSequence = (s.streamSequence || 0) + 1; s.streamPage = null; s.streamPageSnapshotId = null; s.detailError = error.message;
  }
  s.detailLoading = false;
  render();
  if (s.detail && (!embedded || state.trace.tab === "body")) await loadSecurityBody(offset);
  else if (s.detail && ["request", "response"].includes(state.trace.tab)) await loadContentRiskMarks(state.trace.tab === "response");
}

function renderSecurityDetailPage() {
  const s = state.security;
  return `<nav class="security-detail-nav" aria-label="审计导航"><button class="button" data-action="security-back">返回审计记录</button><span class="muted">审计记录 / 审计详情</span><span class="status-badge">仅记录</span></nav>
    ${s.detailLoading ? `<p role="status">正在读取审计详情…</p>` : ""}
    ${s.detailError ? `<div class="notice warning" role="alert">${esc(s.detailError)}<p>可刷新重试，或返回审计记录。</p></div>` : ""}
    ${s.detail ? renderSecurityDetail(s.detail) : ""}`;
}

function renderSecurity() {
  const s = state.security;
  const storage = s.result?.storage || s.status?.storage || state.runtime?.security?.storage;
  const ready = storage?.state === "ready";
  const providers = [...new Set([...Object.keys(state.config?.virtualProviders || {}), ...(s.result?.providers || [])])];
  return `
    <div class="security-heading"><div><span class="status-badge">仅记录</span><p class="muted">按会话回看模型交互，沿轨迹定位风险与原文。工具调用提议不代表真实执行。</p></div>

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
      </div><details class="security-more-filters" ${Object.keys(s.filters).some(k => !["hours", "provider", "hasRisk"].includes(k)) ? "open" : ""}><summary>更多筛选</summary><div class="security-filters">${securitySelect("最高严重程度", "severity", { "": "全部等级", ...SECURITY_LABELS.severity })}
      ${securitySelect("风险分类", "category", { "": "全部分类", ...SECURITY_LABELS.category })}
      ${securitySelect("置信度", "confidence", { "": "全部置信度", ...SECURITY_LABELS.confidence })}
      ${securitySelect("证据阶段", "stage", { "": "全部阶段", ...SECURITY_LABELS.stage })}
      ${securitySelect("请求结果", "outcome", { "": "全部结果", ...SECURITY_LABELS.outcome })}
      ${securitySelect("检查状态", "inspection", { "": "全部状态", ...SECURITY_LABELS.inspection })}
    </div></details><div class="form-actions"><label class="security-risk-toggle"><input type="checkbox" name="hasRisk" value="true" ${s.filters.hasRisk === "true" ? "checked" : ""}> 仅看有风险</label><button class="button button-primary" type="submit" ${s.loading ? "disabled" : ""}>筛选</button><button class="button" type="button" data-action="security-reset">重置筛选</button></div></form></div></div>
    <div class="security-summary" aria-live="polite"><div><strong>${esc(s.result?.total ?? "—")}</strong><span>个会话 / 独立记录</span></div><div><strong>${esc(s.result?.recordCount ?? "—")}</strong><span>条审计记录</span></div><div><strong>${esc(s.result?.riskSessionCount ?? "—")}</strong><span>个会话有风险</span></div><div><strong>${esc(s.result?.findingCount ?? "—")}</strong><span>项风险发现</span></div></div>
    <p class="muted">筛选命中会话后，统计与轨迹保留该会话的全部已保留记录。没有会话标识的 Agent 请求作为独立记录展示。</p>
    <section class="panel"><div class="panel-header"><h2>会话记录</h2><span class="muted">${s.loading ? "读取中…" : `更新于 ${esc(securityTime(s.updatedAt))}`}</span></div>
      ${s.result?.items?.length ? `<div class="security-sessions">${s.result.items.map(securitySessionRow).join("")}</div>` : `<div class="empty" role="status">${s.loading ? "正在读取会话…" : s.error ? "暂时无法读取记录。" : "当前筛选范围内没有审计记录。通过此代理发起请求后可在这里查看。"}</div>`}
      <div class="panel-body security-pagination"><button class="button" data-action="security-prev" ${!s.history.length || s.loading ? "disabled" : ""}>上一页</button><span class="muted">第 ${s.history.length + 1} 页 · 每页 50 个会话 / 独立记录</span><button class="button" data-action="security-next" ${!s.result?.nextCursor || s.loading ? "disabled" : ""}>下一页</button></div>
    </section>
    <p class="muted">检查范围：已知凭据特征、已支持工具的参数与字面量命令、外部内容中的指令操纵线索。动态脚本、未知工具和资源不足时未覆盖的内容会标记覆盖不足。${s.result?.oldestAtMs ? `最早保留记录：${esc(securityTime(s.result.oldestAtMs))}。` : ""}</p>
  `;
}

function securityDuration(ms) {
  if (ms == null) return "耗时未知";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60000)} 分 ${Math.round(ms % 60000 / 1000)} 秒`;
}

function securitySessionTitle(item) {
  return item.sessionTitle || (item.kind === "request" ? "未命名模型会话" : securityLabel("action", item.action));
}

function securitySessionRow(item) {
  return `<button class="security-session-row" data-action="security-session" data-id="${esc(item.id)}">
    <span class="security-session-main"><strong>${esc(securitySessionTitle(item))}</strong><span class="muted">${esc(item.providerId || "未记录配置")} · ${esc(item.target ? targetLabel(item.target) : securityLabel("kind", item.kind))} · ${item.identified ? "客户端会话" : "独立记录 · 无会话标识"}</span></span>
    <span class="security-session-count"><strong>${esc(item.requestCount || 1)} 条记录</strong><span class="muted">${item.activeCount ? `${esc(item.activeCount)} 条进行中` : item.errorCount ? `${esc(item.errorCount)} 条异常` : "已记录"}${item.incompleteCount ? ` · ${esc(item.incompleteCount)} 条待检查 / 不完整` : ""}</span></span>
    <span class="security-session-risk">${item.findingCount ? securityBadge(item.severity) : `<span class="muted">未发现风险</span>`}<span class="muted">${esc(item.findingCount || 0)} 项发现</span></span>
    <span class="security-session-time muted">${esc(securityTime(item.lastAtMs))}<span>查看轨迹 →</span></span>
  </button>`;
}

async function loadSecuritySession(id, reset = true) {
  const t = state.trace, s = state.security;
  const sequence = ++t.sequence;
  const retainedCount = reset ? 50 : Math.max(50, t.result?.items.length || 0);
  const rememberedId = reset ? window.history.state?.sessionRequestId : s.detailId;
  s.sequence++; s.detailSequence++; s.bodySequence = (s.bodySequence || 0) + 1;
  const detailSequence = s.detailSequence;
  if (reset) { Object.assign(t, { id, tab: "overview", search: "", riskOnly: false, summary: null, result: null }); s.detail = null; }
  t.loading = true; t.error = null; t.loadingMore = false; t.moreError = null; state.page = "security-session"; render();
  const current = () => sequence === t.sequence && state.page === "security-session";
  const selectionCurrent = () => reset || detailSequence === s.detailSequence;
  try {
    let summary = await api(`/security/sessions?${new URLSearchParams({ session: id })}`);
    if (!current()) return;
    let sessionId = summary.sessionId || id;
    const result = await api(`/security/audit?${new URLSearchParams({ session: sessionId })}`);
    if (!current()) return;
    // Inspection can finish between the two reads. Use the request query's
    // resolved identity and reload the summary if it changed in that interval.
    if (result.sessionId && result.sessionId !== sessionId) {
      sessionId = result.sessionId;
      summary = await api(`/security/sessions?${new URLSearchParams({ session: sessionId })}`);
      if (!current()) return;
    }
    const preferredId = rememberedId || (sessionId !== id ? id : null);
    // Refresh the already-read portion without losing the selected request or scroll position.
    while (result.nextCursor && (!reset && result.items.length < retainedCount || preferredId && !result.items.some(item => item.id === preferredId))) {
      const page = await api(`/security/audit?${new URLSearchParams({ session: sessionId, cursor: result.nextCursor })}`);
      if (!current()) return;
      result.items.push(...page.items); result.nextCursor = page.nextCursor; result.total = page.total;
    }
    const selected = result.items.find(item => item.id === preferredId) || result.items[0];
    // Keep the prior view intact if any part of a refresh, including the
    // selected request's detail, fails before its replacement is ready.
    const detail = !reset && selected ? await api(`/security/audit/${encodeURIComponent(selected.id)}`) : null;
    if (!current()) return;
    // A newer selection owns the detail and history, even if the user has
    // switched back to the same request. Discard this obsolete refresh.
    if (!selectionCurrent()) { t.loading = false; render(); return; }
    const redirected = sessionId !== id;
    if (renderedTraceId === t.id) renderedTraceId = sessionId;
    t.id = sessionId;
    window.history.replaceState({ ...window.history.state, page: "security-session", sessionRequestId: selected?.id }, "", `#security/session/${encodeURIComponent(sessionId)}`);
    t.result = result; t.summary = summary.items[0] || null;
    t.loading = false; render();
    if (selected) await loadSecurityDetail(selected.id, reset || selected.id !== s.detailId, true, detail);
    else { s.detail = null; render(); }
    if (current() && selected && (redirected || reset && preferredId)) pageContent.querySelector(".trace-event-row.is-selected")?.scrollIntoView({ block: "nearest", behavior: "instant" });
  } catch (error) {
    if (!current()) return;
    if (selectionCurrent()) t.error = error.message;
    t.loading = false; render();
  }
}

async function loadMoreSecurityTrace() {
  const t = state.trace;
  if (state.page !== "security-session" || t.loading || t.loadingMore || !t.result?.nextCursor) return;
  const sequence = t.sequence, id = t.id, cursor = t.result.nextCursor;
  const current = () => sequence === t.sequence && id === t.id && state.page === "security-session";
  t.loadingMore = true; t.moreError = null; render();
  try {
    const page = await api(`/security/audit?${new URLSearchParams({ session: id, cursor })}`);
    if (!current()) return;
    const seen = new Set(t.result.items.map(item => item.id));
    t.result.items.push(...page.items.filter(item => !seen.has(item.id)));
    t.result.nextCursor = page.nextCursor; t.result.total = page.total;
  } catch (error) {
    if (!current()) return;
    t.moreError = error.message;
  }
  if (!current()) return;
  t.loadingMore = false; render();
}

// Keep the overview usable even after scrolling through thousands of requests.
function traceSegments(items) {
  const size = Math.max(1, Math.ceil(items.length / 60));
  const segments = [];
  for (let i = 0; i < items.length; i += size) {
    const group = items.slice(i, i + size);
    segments.push({ id: group[0].id, first: i + 1, last: i + group.length,
      duration: group.reduce((n, item) => n + (item.durationMs || 0), 0),
      findings: group.reduce((n, item) => n + (item.findingCount || 0), 0),
      selected: group.some(item => item.id === state.security.detailId) });
  }
  return segments;
}

function traceItems() {
  const t = state.trace;
  const search = t.search.trim().toLocaleLowerCase();
  return (t.result?.items || []).filter(item => (!t.riskOnly || item.findingCount > 0)
    && (!search || [item.requestPreview, item.responsePreview, item.clientModelId, item.upstreamModelId, item.id, ...(item.toolNames || [])].join(" ").toLocaleLowerCase().includes(search)));
}

function securityModelMapping(record) {
  return `${record.clientModelId || "未记录"} → ${record.upstreamModelId || "未记录"}`;
}

const REQUEST_CONTENT_LABELS = { system: "系统提示词", developer: "开发者指令", user: "用户输入", assistant: "历史模型消息", tool_call: "历史工具调用", tool_result: "工具结果", reasoning: "推理 / 压缩上下文", reference: "历史上下文引用", tool_definition: "可用工具定义", other: "其他内容" };
const REQUEST_PART_LABELS = { input_image: "图片", input_file: "文件", input_audio: "音频", input_video: "视频", refusal: "拒绝内容", image: "图片", document: "文档", search_result: "检索结果", tool_reference: "工具引用" };

const RESPONSE_STATUS_LABELS = { completed: "已完成", failed: "失败", incomplete: "模型输出未完成", in_progress: "生成中", end_turn: "本轮结束", tool_use: "请求调用工具", max_tokens: "达到输出上限", stop_sequence: "命中停止序列", pause_turn: "轮次暂停", refusal: "拒绝响应" };
const RESPONSE_CONTENT_LABELS = { assistant: "模型输出", reasoning: "推理 / 思考", tool_call: "本轮工具调用", tool_result: "服务端工具结果", refusal: "拒绝内容", error: "响应错误", other: "其他内容" };
function renderRequestContent(record) { return renderRetainedContent(record, false); }
function renderResponseContent(record) { return renderRetainedContent(record, true); }
function contentFindings(record, item, response) {
  return (record.findings || []).filter(finding => {
    const ref = finding.evidence?.bodyRef;
    if (!ref) return false;
    const source = ref.sourceSnapshotId || ref.snapshotId;
    if (response && item.contentSnapshotIds?.includes(source)) return true;
    if (source !== (response ? "response" : "request")) return false;
    const start = ref.sourceStart ?? ref.start, end = ref.sourceEnd ?? ref.end;
    return start < item.end && end > item.start;
  });
}

function retainedRiskText(item, field) {
  const text = item[field] || "", ranges = item.riskRanges?.[field] || [];
  const selected = state.security.contentNavigation;
  const events = [{ at: 0, delta: 0 }, { at: text.length, delta: 0 }];
  for (const range of ranges) {
    events.push({ at: range.start, delta: 1, findingId: range.findingId }, { at: range.end, delta: -1, findingId: range.findingId });
  }
  events.sort((a, b) => a.at - b.at);
  let at = 0, html = "";
  const active = new Map();
  for (const event of events) {
    if (event.at > at) {
      const hit = selected?.index === item.index && selected.field === field && active.has(selected.findingId);
      const content = esc(text.slice(at, event.at));
      html += active.size ? `<mark class="security-risk-hit${hit ? " security-body-hit" : ""}"${hit ? ' data-security-content-anchor tabindex="-1"' : ""}>${content}</mark>` : content;
      at = event.at;
    }
    if (event.delta) {
      const count = (active.get(event.findingId) || 0) + event.delta;
      if (count) active.set(event.findingId, count); else active.delete(event.findingId);
    }
  }
  return html;
}

async function findingText(record, finding) {
  let cache = securityEvidenceCache.get(record);
  if (!cache) { cache = new Map(); securityEvidenceCache.set(record, cache); }
  if (!cache.has(finding.id)) cache.set(finding.id, (async () => {
    const ref = finding.evidence.bodyRef;
    let offset = Math.max(0, (ref.start || 0) - 512), raw = "", next = ref.start;
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    while (true) {
      const page = await api(`/security/audit/${encodeURIComponent(record.id)}/body?${new URLSearchParams({ snapshot: ref.snapshotId, offset })}`);
      if (state.security.detail !== record || !securityDetailVisible()) { cache.delete(finding.id); return ""; }
      if (page.legacySnapshot) {
        const { text, range } = securityBodyText(page.legacySnapshot.body, page.legacySnapshot.root, ref.location || finding.evidence.location, page.legacySnapshot.fieldOrder);
        return range ? text.slice(range.start, range.end) : "";
      }
      if (finding.ruleId === "SEC-SECRET-001" && ref.matchKind !== "sensitive") {
        const marks = securityPageMarks(page).filter(mark => mark.start < ref.end && mark.end > ref.start
          && !["redaction_buffer_budget", "url_authority_uncertain", "credential_prefix_uncertain", "incomplete_body_fragment", "unsupported_stream_fragment"].includes(mark.reason));
        if (marks.length) return marks.map(mark => (page.chunks || []).map(chunk => decoder.decode(encoder.encode(chunk.content).slice(Math.max(0, mark.start - chunk.start), Math.max(0, Math.min(chunk.end, mark.end) - chunk.start)))).join(""));
      } else {
        for (const chunk of page.chunks || []) {
          const start = Math.max(next, chunk.start), end = Math.min(ref.end, chunk.end);
          if (end > start) { raw += decoder.decode(encoder.encode(chunk.content).slice(start - chunk.start, end - chunk.start)); next = end; }
        }
        if (next >= ref.end) return raw;
      }
      if (page.nextOffset == null || page.nextOffset <= offset || page.nextOffset >= ref.end) return "";
      offset = page.nextOffset;
    }
  })().catch(error => { cache.delete(finding.id); throw error; }));
  return cache.get(finding.id);
}

// Keep JSON value spans in the displayed text, including its original escaping.
function contentJsonNode(text) {
  JSON.parse(text); // Reject incomplete input before collecting any ranges.
  const tokens = text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g);
  let token = tokens.next().value;
  const take = () => { const current = token; token = tokens.next().value; return current; };
  const read = () => {
    const first = take(), start = first.index;
    if (first[0] === "{" || first[0] === "[") {
      const object = first[0] === "{", children = object ? new Map() : [];
      while (token[0] !== (object ? "}" : "]")) {
        if (object) {
          const key = JSON.parse(take()[0]);
          take(); // colon
          children.set(key, read());
        } else children.push(read());
        if (token[0] === ",") take(); else break;
      }
      const last = take();
      return { start, end: last.index + 1, children, object };
    }
    const value = JSON.parse(first[0]), string = typeof value === "string";
    return { start: start + (string ? 1 : 0), end: start + first[0].length - (string ? 1 : 0), value };
  };
  return read();
}

function toolContentRiskRanges(text, evidence, findingId) {
  const ranges = [];
  for (const raw of Array.isArray(evidence) ? evidence : [evidence]) {
    if (!raw) continue;
    let expected;
    try { expected = JSON.parse(raw); } catch { expected = raw; }
    // A custom tool's free-text input may itself look like JSON.
    if (typeof expected === "string" && text === expected) {
      ranges.push({ start: 0, end: text.length, findingId });
      continue;
    }
    try {
      let node = contentJsonNode(text), position = offset => offset;
      const type = node.object && node.children.get("type")?.value;
      if (["function_call", "custom_tool_call", "tool_use", "server_tool_use"].includes(type)) {
        node = node.children.get(type === "function_call" ? "arguments" : "input");
        if (!node) continue;
      }
      if (typeof node.value === "string" && (typeof expected !== "string" || type === "function_call")) {
        // Codex arguments are JSON inside a JSON string. Map decoded UTF-16
        // offsets back to the escaped string so only the matching value is marked.
        const offsets = [node.start];
        for (let at = node.start; at < node.end;) {
          at += text[at] === "\\" ? (text[at + 1] === "u" ? 6 : 2) : 1;
          offsets.push(at);
        }
        position = offset => offsets[offset];
        node = contentJsonNode(node.value);
      }
      const matches = (current, value, projection = false) => {
        if (value === null || typeof value !== "object") return !current.children && current.value === value;
        if (Array.isArray(value)) return Array.isArray(current.children) && current.children.length === value.length
          && value.every((child, index) => matches(current.children[index], child));
        const keys = Object.keys(value);
        return current.object && (projection || current.children.size === keys.length)
          && keys.every(key => current.children.has(key) && matches(current.children.get(key), value[key]));
      };
      // The backend retains only inspected fields. Require all of those fields
      // at their corresponding keys, while allowing unrelated argument fields.
      if (!matches(node, expected, true)) continue;
      const hits = expected && typeof expected === "object" && !Array.isArray(expected)
        ? Object.keys(expected).map(key => node.children.get(key)) : [node];
      for (const hit of hits) if (hit.end > hit.start) ranges.push({ start: position(hit.start), end: position(hit.end), findingId });
    } catch {}
  }
  return ranges;
}

function contentRiskRanges(text, evidence, findingId, structuredTool = false) {
  if (structuredTool) return toolContentRiskRanges(text, evidence, findingId);
  const candidates = new Set();
  const collect = value => {
    if (typeof value === "string" && value) candidates.add(value);
    else if (value && typeof value === "object") {
      candidates.add(JSON.stringify(value));
      candidates.add(JSON.stringify(value, null, 2));
      for (const child of Object.values(value)) collect(child);
    }
  };
  for (const raw of Array.isArray(evidence) ? evidence : [evidence]) {
    if (!raw) continue;
    candidates.add(raw);
    try { collect(JSON.parse(raw)); } catch {}
    try { collect(JSON.parse(`"${raw}"`)); } catch {}
  }
  const ranges = [];
  for (const candidate of [...candidates].sort((a, b) => b.length - a.length)) {
    let at = 0;
    while ((at = text.indexOf(candidate, at)) >= 0) {
      const end = at + candidate.length;
      if (!ranges.some(range => range.start <= at && range.end >= end)) ranges.push({ start: at, end, findingId });
      at = end;
    }
  }
  return ranges;
}

async function loadContentRiskMarks(response, operation) {
  const s = state.security, record = s.detail, sequence = s.detailSequence;
  const content = record?.[response ? "responseContent" : "requestContent"];
  if (!content) return;
  const current = () => record === s.detail && sequence === s.detailSequence && record[response ? "responseContent" : "requestContent"] === content
    && (!operation || s[operation.key] === operation.token) && securityDetailVisible();
  try {
    const items = (content.items || []).filter(item => !item.riskRanges);
    const findings = [...new Map(items.flatMap(item => contentFindings(record, item, response)).map(finding => [finding.id, finding])).values()];
    const evidence = new Map();
    // Body reads share the audit queue. Keep automatic highlighting bounded
    // even when a page contains many findings, and reuse immutable evidence.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, findings.length) }, async () => {
      while (next < findings.length && current()) {
        const finding = findings[next++];
        evidence.set(finding.id, await findingText(record, finding));
      }
    }));
    for (const item of items) {
      const findings = contentFindings(record, item, response);
      if (!current()) return;
      item.riskRanges = Object.fromEntries(["preview", "structure"].map(field => [field, findings.flatMap(finding => contentRiskRanges(item[field] || "", evidence.get(finding.id) || "", finding.id, item.kind === "tool_call" && finding.ruleId !== "SEC-SECRET-001"))]));
      item.riskVersions = findings.filter(finding => !Object.values(item.riskRanges).some(ranges => ranges.some(range => range.findingId === finding.id))).flatMap(finding => {
        const raw = evidence.get(finding.id);
        if (!raw || Array.isArray(raw) && !raw.length) return [];
        let text = Array.isArray(raw) ? raw.join("\n") : raw;
        try { const value = JSON.parse(text); text = typeof value === "string" ? value : JSON.stringify(value, null, 2); } catch {
          try { text = JSON.parse(`"${text}"`); } catch {}
        }
        return [{ findingId: finding.id, text, toolArguments: item.kind === "tool_call" && finding.ruleId !== "SEC-SECRET-001" }];
      });
    }
  } catch (error) {
    if (current()) s[response ? "responseContentError" : "contentError"] = `风险位置加载失败：${error.message}`;
  }
  if (current()) render();
}

async function locateContentFinding(finding) {
  const s = state.security, record = s.detail, sequence = s.detailSequence;
  const source = finding.evidence?.bodyRef?.sourceSnapshotId || finding.evidence?.bodyRef?.snapshotId;
  const response = canonicalBodySnapshotId(source)?.startsWith("response") || finding.evidenceStage?.startsWith("response") || finding.evidenceStage === "tool_call_proposed";
  const tab = response ? "response" : "request", key = response ? "responseContent" : "requestContent";
  const operation = beginContentOperation(response);
  const navigation = s.contentNavigation = { findingId: finding.id };
  state.trace.tab = tab;
  const current = () => s.detail === record && s.detailSequence === sequence && s[operation.key] === operation.token && s.contentNavigation === navigation && state.trace.tab === tab && state.page === "security-session";
  render();
  let content = record[key], item = content?.items?.find(item => contentFindings(record, item, response).some(f => f.id === finding.id));
  try {
    for (let offset = 0; !item && current(); offset = content.nextOffset) {
      if (offset == null) break;
      content = await api(`/security/audit/${encodeURIComponent(record.id)}/${response ? "response-content" : "content"}?${new URLSearchParams({ offset })}`);
      if (!current()) return;
      record[key] = content;
      item = content?.items?.find(item => contentFindings(record, item, response).some(f => f.id === finding.id));
      if (content.nextOffset != null && content.nextOffset <= offset) break;
    }
  } catch (error) {
    if (current()) { s[response ? "responseContentError" : "contentError"] = error.message; render(); }
    return;
  }
  if (!current()) return;
  if (!item) { s[response ? "responseContentError" : "contentError"] = "此风险没有可定位的内容项，证据可在风险详情中复核。"; render(); return; }
  navigation.index = item.index;
  await loadContentRiskMarks(response, operation);
  if (!current()) return;
  navigation.field = item.riskRanges?.preview?.some(range => range.findingId === finding.id) ? "preview" : "structure";
  render();
  const row = pageContent.querySelector(`[data-content-index="${item.index}"]`);
  for (let parent = row; parent; parent = parent.parentElement) if (parent.tagName === "DETAILS") parent.open = true;
  const target = row?.querySelector("[data-security-content-anchor]") || row;
  const structure = target?.closest?.("details.trace-content-structure");
  if (structure) structure.open = true;
  target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  target?.focus?.({ preventScroll: true });
}
function renderRetainedContent(record, response) {
  const content = response ? record.responseContent : record.requestContent;
  const title = response ? "响应内容" : "请求内容";
  const labels = response ? RESPONSE_CONTENT_LABELS : REQUEST_CONTENT_LABELS;
  const loading = response ? state.security.responseContentLoading : state.security.contentLoading;
  const error = response ? state.security.responseContentError : state.security.contentError;
  const action = response ? "security-response-content" : "security-content";
  if (!content) return `<section class="trace-preview"><h3>${response ? "本轮模型输出" : "最近用户输入"}</h3><p>${esc((response ? record.responsePreview : record.requestPreview) || "无可用文本摘要，可在原始内容中复核。")}</p></section>`;
  const items = content.items || [], counts = content.counts || {};
  const claude = record.protocol === "anthropic.messages";
  const row = item => {
    const label = labels[item.kind] || labels.other;
    const relation = response ? "" : item.relatedIndex != null ? `对应第 ${item.relatedIndex + 1} 项` : item.kind === "tool_result" ? "本次请求未找到对应调用" : item.kind === "tool_call" ? "本次请求未包含对应结果" : "";
    const related = `${relation}${item.ambiguousRelation ? "，标识重复，关联存在歧义" : ""}`;
    return `<details class="trace-content-item" data-content-index="${item.index}" open>
      <summary><span class="trace-content-title"><span class="trace-content-order">${item.index + 1}</span><span class="trace-content-role">${esc(label)}</span>${item.name ? `<strong class="mono">${esc(item.name)}</strong>` : ""}</span><button class="mini-button trace-content-source" data-action="${action}-source" data-index="${item.index}">查看此项原文</button></summary>
      <div class="trace-content-detail">${item.preview ? `<pre>${retainedRiskText(item, "preview")}</pre>` : `<p class="muted">${item.opaque ? "仅保留加密或不透明内容，没有可读文本。" : "此项未包含可读文本。"}</p>`}
      ${item.structure && item.structure !== item.preview ? `<details class="trace-content-structure"><summary>完整内容结构</summary><pre>${retainedRiskText(item, "structure")}</pre></details>` : ""}
      ${item.riskVersions?.length ? `<details class="trace-content-risk-versions" open><summary>风险检测时的内容</summary><p class="trace-content-note">此风险来自较早的流式内容或检测参数，当前内容已变化；以下保留检测时的命中内容。</p>${item.riskVersions.map(version => `${version.toolArguments ? `<p class="trace-content-note">检测时的工具参数与当前参数不同，此记录不表示最终参数仍有风险。实际执行状态未知。</p>` : ""}<pre><mark class="security-risk-hit${state.security.contentNavigation?.findingId === version.findingId ? " security-body-hit" : ""}"${state.security.contentNavigation?.findingId === version.findingId ? ' data-security-content-anchor tabindex="-1"' : ""}>${esc(version.text)}</mark></pre>`).join("")}</details>` : ""}
      ${item.parts?.length ? `<p class="trace-content-note">${item.parts.map(part => esc(REQUEST_PART_LABELS[part] || part)).join(" · ")} · 非文本内容见完整结构或原文</p>` : ""}
      ${item.opaque && item.preview ? `<p class="trace-content-note">同时包含加密或不透明内容。</p>` : ""}
      ${!response && item.kind === "reference" ? `<p class="trace-content-note">${item.type === "tool_reference" ? "工具引用指向可用工具，不表示已经调用。" : "引用的历史上下文未包含在本次请求正文中。"}</p>` : ""}
      ${item.messageIndex != null ? `<p class="trace-content-note">第 ${Number(item.messageIndex) + 1} 条消息${item.role ? ` · ${esc(item.role)}` : " · 角色未解析"}${item.type ? ` · ${esc(item.type)}` : ""}</p>` : ""}
      ${related ? `<p class="trace-content-note">${esc(related)}${item.kind === "tool_result" ? item.serverTool ? " · 服务端工具结果" : " · 客户端报告的结果" : " · 实际执行状态未知"}</p>` : ""}
      ${item.isError != null ? `<p class="trace-content-note">${item.isError ? "客户端报告工具错误" : "客户端未标记工具错误"}</p>` : ""}
      ${item.cacheControl ? `<p class="trace-content-note">缓存控制：${esc(item.cacheControl)}</p>` : ""}
      ${item.callId ? `<p class="trace-content-note mono">${esc(item.callId)}</p>` : ""}
      ${response && item.kind === "tool_call" ? `<p class="trace-content-note">${item.serverTool ? "服务端工具调用" : "模型提出的工具调用 · 实际执行状态未知"}</p>` : ""}
      ${response && item.state === "partial" ? `<p class="notice warning">${item.kind === "tool_call" ? "调用未完成或留存内容存在缺口，保留检测依据；实际执行状态未知。" : "此项尚未完整返回或留存内容存在缺口。"}</p>` : ""}
      ${response && item.status ? `<p class="trace-content-note">条目状态：${esc(RESPONSE_STATUS_LABELS[item.status] || item.status)}</p>` : ""}
      ${response && item.kind === "tool_result" && item.serverTool ? `<p class="trace-content-note">上游返回的服务端工具结果。</p>` : ""}
      </div></details>`;
  };
  const definitions = items.filter(item => item.kind === "tool_definition");
  const messages = items.filter(item => item.kind !== "tool_definition");
  return `<section class="trace-request-content" aria-label="${title}"><h3>${title} <span>${content.total} 项</span></h3>
    ${response && content.status ? `<p class="trace-content-note">${claude ? "结束原因" : "响应状态"}：${esc(RESPONSE_STATUS_LABELS[content.status] || content.status)}</p>` : ""}
    ${claude && !response ? `<p class="trace-content-note">按消息内容块展示；工具结果属于工具上下文，消息角色为 user 也不会计为用户输入。</p>` : ""}
    <div class="trace-content-counts" aria-label="${title}组成">${Object.entries(labels).map(([kind, label]) => `<span>${label} <strong>${counts[kind] || 0}</strong></span>`).join("")}</div>
    ${content.state !== "complete" ? `<p class="notice warning">${content.state === "unavailable" ? `${response ? "响应" : "请求"}正文未保留，无法还原内容组成。` : `${response ? "响应" : "请求"}正文存在缺口或尚未解析完整，以下为已保留的内容。`}</p>` : content.total === 0 ? `<p class="muted">${response ? "本次响应未包含输出内容。" : "本次请求未包含提示词、输入或工具上下文。"}</p>` : ""}
    <div class="trace-content-timeline">${messages.map(row).join("")}</div>
    ${definitions.length ? `<details class="trace-content-tools"><summary>可用工具定义 · 本页 ${definitions.length} 个</summary>${definitions.map(row).join("")}</details>` : ""}
    ${content.total ? `<div class="trace-content-pagination"><button class="mini-button" data-action="${action}-page" data-offset="${Math.max(0, content.offset - 40)}" ${!content.offset || loading ? "disabled" : ""}>上一组内容</button><span>${content.offset + 1}–${content.offset + items.length} / ${content.total}</span><button class="mini-button" data-action="${action}-page" data-offset="${content.nextOffset ?? ""}" ${content.nextOffset == null || loading ? "disabled" : ""}>下一组内容</button></div>` : ""}
    ${loading ? `<p class="muted" role="status">正在解析${title}…</p>` : ""}${error ? `<p class="notice warning" role="alert">${esc(error)}</p>` : ""}
  </section>`;
}

function beginContentOperation(response) {
  const s = state.security, key = response ? "responseContentOperation" : "requestContentOperation";
  const token = s[key] = (s[key] || 0) + 1;
  s[response ? "responseContentLoading" : "contentLoading"] = false;
  s[response ? "responseContentError" : "contentError"] = null;
  return { key, token };
}
async function loadRetainedContent(offset, response) {
  const loadingKey = response ? "responseContentLoading" : "contentLoading";
  const errorKey = response ? "responseContentError" : "contentError";
  const s = state.security, record = s.detail, sequence = s.detailSequence;
  if (!record || s[loadingKey]) return;
  const operation = beginContentOperation(response);
  const current = () => record === s.detail && sequence === s.detailSequence && s[operation.key] === operation.token && securityDetailVisible();
  s[loadingKey] = true; s[errorKey] = null; render();
  try {
    const content = await api(`/security/audit/${encodeURIComponent(record.id)}/${response ? "response-content" : "content"}?${new URLSearchParams({ offset })}`);
    if (!current()) return;
    record[response ? "responseContent" : "requestContent"] = content;
  } catch (error) {
    if (!current()) return;
    s[errorKey] = error.message;
  }
  if (current()) { s[loadingKey] = false; render(); }
  if (current()) await loadContentRiskMarks(response, operation);
}

function renderTraceInspector() {
  const s = state.security, t = state.trace, r = s.detail;
  const tabs = `<div class="trace-tabs" aria-label="步骤详情"><button data-action="security-trace-tab" data-tab="overview" aria-pressed="${t.tab === "overview"}">概览</button><button data-action="security-trace-tab" data-tab="risks" aria-pressed="${t.tab === "risks"}">风险 ${r?.findingCount || 0}</button><button data-action="security-trace-tab" data-tab="request" aria-pressed="${t.tab === "request"}">请求内容</button><button data-action="security-trace-tab" data-tab="response" aria-pressed="${t.tab === "response"}">响应内容</button><button data-action="security-trace-tab" data-tab="body" aria-pressed="${t.tab === "body"}">原始内容</button></div>`;
  if (s.detailLoading) return `${tabs}<p class="empty" role="status">正在加载步骤详情…</p>`;
  if (s.detailError) return `${tabs}<p class="notice warning" role="alert">${esc(s.detailError)}</p>`;
  if (!r) return `${tabs}<p class="empty">选择一条请求查看详情。</p>`;
  let body;
  if (t.tab === "body") body = renderSecurityBody(r);
  else if (t.tab === "risks") body = `<p class="muted">工具真实执行状态未知；工具结果来自客户端报告。</p>${renderSecurityFindings(r)}`;
  else if (t.tab === "request") body = renderRequestContent(r);
  else if (t.tab === "response") body = renderResponseContent(r);
  else body = `<div class="trace-inspector-heading"><strong>${esc(securityLabel("outcome", r.outcome))}</strong>${r.findingCount ? securityBadge(r.severity) : ""}</div>
    <dl class="trace-facts">${[["模型", securityModelMapping(r)], ["开始", securityTime(r.at)], ["耗时", securityDuration(r.durationMs)], ["HTTP", r.httpStatus ?? "未知"], ["检查", securityInspectionLabel(r)], ["Token", r.usage ? `${r.usage.input_tokens ?? "—"} 输入 / ${r.usage.output_tokens ?? "—"} 输出` : "未报告"]].map(([k,v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${r.inspectionProgress?.active ? `<p role="status" class="muted">检测进度：${esc(r.inspectionProgress.processedBytes || 0)} / ${esc(r.inspectionProgress.observedBytes || r.observedBytes || 0)} 字节 · ${esc(securityInspectionLabel(r))}</p>` : ""}
    ${r.lostWrites ? `<p class="notice warning">记录到 ${esc(r.lostWrites)} 次审计写入缺口。</p>` : ""}
    ${r.coverageReasons?.length ? `<p class="notice warning">覆盖不足：${r.coverageReasons.map(reason => esc(securityLabel("reason", reason))).join("；")}</p>` : ""}
    <details class="trace-record-id"><summary>全部记录信息</summary><dl class="trace-facts">${securityRecordFacts(r).map(([k,v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${r.coverageGaps?.length ? `<p>正文缺口范围</p><pre class="code-preview">${esc(JSON.stringify(r.coverageGaps, null, 2))}</pre>` : ""}</details>`;
  return `${tabs}<div class="trace-inspector-body">${body}</div>`;
}

function renderSecuritySession() {
  const t = state.trace, s = state.security, summary = t.summary;
  const all = t.result?.items || [], items = traceItems();
  const segments = traceSegments(all);
  const maxDuration = Math.max(1, ...segments.map(item => item.duration));
  const segmentDescription = all.length > 60
    ? "相邻请求合并显示，点击定位该组首条请求"
    : "每格对应一条请求";
  const positions = new Map(all.map((item, i) => [item.id, i]));
  return `<nav class="security-detail-nav"><button class="button" data-action="security-back">返回审计记录</button><span class="muted">审计记录 / 会话轨迹</span><span class="status-badge">仅记录</span></nav>
    <header class="trace-heading"><div><h2>${esc(summary ? securitySessionTitle(summary) : "会话轨迹")}</h2><p class="muted">${esc(summary?.providerId || "未记录配置")} · ${summary?.identified ? "按客户端会话标识归组" : "独立记录 · 未获取会话标识"}${summary ? ` · ${esc(securityTime(summary.firstAtMs))}` : ""}</p></div>
    <div class="trace-totals"><span><strong>${esc(summary?.requestCount ?? "—")}</strong> 条记录</span><span><strong>${esc(summary?.findingCount ?? "—")}</strong> 项风险</span><span><strong>${esc(securityDuration(summary?.durationMs))}</strong> 请求累计耗时</span></div></header>
    ${t.error ? `<p class="notice warning" role="alert">${esc(t.error)}<button class="button" data-action="security-session-refresh">重试</button></p>` : ""}
    <section class="trace-workspace" aria-label="会话轨迹">
      <div class="trace-toolbar"><strong>轨迹</strong><span class="muted">按请求顺序 · 已加载 ${all.length} 条 / 共 ${esc(t.result?.total ?? "—")} 条</span><button class="mini-button" data-action="security-session-refresh" ${t.loading ? "disabled" : ""}>${t.loading ? "读取中…" : "刷新会话"}</button></div>
      <div class="trace-overview"><div class="trace-scale-row"><button class="mini-button trace-scale-toggle" data-action="security-trace-scale" aria-pressed="${t.scale === "duration"}" title="${t.scale === "duration" ? "当前按耗时分配宽度，点击恢复按请求数分配" : "点击按已记录的请求耗时分配宽度"}">耗时占比</button></div><div class="trace-minimap" aria-label="请求导航">${segments.map(item => { const label = item.first === item.last ? `请求 ${item.first}` : `请求 ${item.first}–${item.last}`; return `<button class="trace-segment ${item.findings ? "has-risk" : ""} ${item.selected ? "is-selected" : ""}" style="flex-grow:${t.scale === "duration" ? Math.max(.2, item.duration / maxDuration * 10) : item.last - item.first + 1}" data-action="security-trace-select" data-id="${esc(item.id)}" title="${label} · ${esc(securityDuration(item.duration))} · ${item.findings} 项风险" aria-label="选择${label}" aria-pressed="${item.selected}"></button>`; }).join("")}</div><p class="trace-overview-caption"><strong>已加载轨迹概览</strong><span>${segmentDescription}</span><span class="trace-legend"><i class="trace-legend-swatch trace-request-swatch" aria-hidden="true"></i>请求</span><span class="trace-legend"><i class="trace-legend-swatch trace-risk-swatch" aria-hidden="true"></i>发现风险</span>${t.scale === "duration" ? "<span>宽度表示已记录的请求耗时（最小宽度便于点击）</span>" : ""}</p></div>
      <div class="trace-columns"><section class="trace-events" aria-label="请求列表"><form id="security-trace-search" class="trace-search"><input name="search" aria-label="搜索已加载轨迹" placeholder="搜索已加载输入、输出、工具或模型" value="${esc(t.search)}"><button class="mini-button" type="submit">搜索</button><button class="mini-button" type="button" data-action="security-trace-risk" aria-pressed="${t.riskOnly}">仅看风险</button></form>
        <div class="trace-event-list" tabindex="0" aria-label="可滚动请求列表" aria-busy="${t.loadingMore}">${items.map(item => { const i = positions.get(item.id); return `<button class="trace-event-row ${s.detailId === item.id ? "is-selected" : ""}" data-action="security-trace-select" data-id="${esc(item.id)}" aria-pressed="${s.detailId === item.id}"><span class="trace-order">${String(i + 1).padStart(2,"0")}</span><span class="trace-event-main"><span class="trace-event-meta"><span class="trace-event-models"><span>模型</span><strong title="${esc(securityModelMapping(item))}">${esc(securityModelMapping(item))}</strong></span><span>${esc(securityDuration(item.durationMs))}</span>${item.findingCount ? `<span class="trace-risk-count">${esc(item.findingCount)} 项风险</span>` : ""}</span><span class="trace-event-preview"><span>输入</span>${esc(item.requestPreview || (item.kind === "request" ? "无文本摘要，查看原始内容" : securityLabel("action", item.action)))}</span><span class="trace-event-preview"><span>输出</span>${esc(item.responsePreview || securityLabel("outcome", item.outcome))}</span><span class="trace-event-status">${esc(securityLabel("outcome", item.outcome))} · ${esc(securityInspectionLabel(item))}</span></span></button>`; }).join("") || `<p class="empty" role="status">${t.loading ? "正在读取轨迹…" : all.length ? "已加载的轨迹中没有匹配的步骤。可继续向下加载，或清空搜索与筛选。" : "会话暂无记录，或已超出保留范围。"}</p>`}<div class="trace-load-status" role="status">${t.moreError ? `<span>${esc(t.moreError)}</span><button class="mini-button" data-action="security-trace-more">重试加载</button>` : t.loadingMore ? "正在加载更多请求…" : t.result?.nextCursor ? `<span>向下滚动加载更多请求</span><button class="mini-button" data-action="security-trace-more">继续加载</button>` : all.length ? "已显示全部请求" : ""}</div></div>
      </section><aside class="trace-inspector" aria-label="选中步骤详情">${renderTraceInspector()}</aside></div>
    </section>`;
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

// An original-content link marks a scroll position, not a selected risk range.
function securitySourceAnchor(text) {
  return `<span data-security-body-anchor tabindex="-1">${esc(text)}</span>`;
}

const SECURITY_BODY_LABELS = {
  source: { observed_headers: "请求 / 响应头", tool_inspection: "检测时的工具参数", inspection_range: "检测时的正文范围", client_request: "客户端请求正文", upstream_response: "上游响应正文", gateway_response: "网关本地响应", stream_inspection: "检测时的流式内容快照", response_inspection: "检测时的响应内容快照" },
  state: { complete: "已完整保留", receiving: "分段保存中", gap: "保留存在缺口", partial: "部分内容不可复核", truncated: "旧版截断记录", interrupted: "接收中断或未观察到协议结束", not_observed: "网关未读取正文", capture_unavailable: "正文保留不可用", redaction_unavailable: "凭据脱敏超限，内容已隐藏", pending: "仍在接收或等待保存" },
  redaction: { unsupported_stream_fragment: "无法安全重组的未知流式片段", credential_in_arguments: "工具参数中的凭据", credential_continuation: "跨段凭据续片", url_authority_uncertain: "无法确认的长 URL 认证区", credential_prefix_uncertain: "无法确认的长令牌前缀", redaction_buffer_budget: "脱敏工作区不足", cookie_header: "Cookie 头", credential_field: "凭据字段", known_credential: "已知凭据", credential_pattern: "凭据格式", credential_assignment: "凭据赋值", authorization: "认证值", private_key: "私钥", url_credentials: "URL 认证信息", url_credential_parameter: "URL 凭据参数", nested_json_credentials: "参数内嵌 JSON 凭据", incomplete_stream_fragment: "未完成的流式片段", incomplete_body_fragment: "截断文本末尾", unparsed_json_credentials: "含凭据的内嵌 JSON 无法解析", redaction_depth_limit: "脱敏深度上限", redaction_catalog_limit: "凭据字典上限", internal_host: "内网地址与端口", public_host: "公网服务器地址与端口", internal_identity: "URL 用户名" },
};

const ENDPOINT_REASONS = ["internal_host", "public_host", "internal_identity"];

function securityPageMarks(page) {
  const endpoints = chunk => (chunk.coverageRanges || []).filter(range => ENDPOINT_REASONS.includes(range.reason));
  const marks = page?.chunks?.flatMap(chunk => [...(chunk.sensitiveRanges || []), ...endpoints(chunk), ...(chunk.redactions || [])]) || page?.legacySnapshot?.redactions || [];
  return [...new Map(marks.map(mark => [JSON.stringify([mark.start, mark.end, mark.reason, mark.location]), mark])).values()];
}

function securityRiskSelections(record, snapshotId) {
  return (record?.findings || []).flatMap(finding => {
    const ref = finding.evidence?.bodyRef;
    if (!ref) return [];
    let range;
    if (ref.snapshotId === snapshotId || ref.sourceSnapshotId === snapshotId && ref.sourceStart == null) range = ref;
    else if (ref.sourceSnapshotId === snapshotId && ref.sourceStart != null) range = { start: ref.sourceStart, end: ref.sourceEnd };
    else return [];
    // Historical credential findings cover detection windows; their stored
    // sensitive annotations, rather than the window, identify the real hit.
    if (finding.ruleId === "SEC-SECRET-001" && ref.matchKind !== "sensitive") return [];
    return [{ ...range, location: ref.location || finding.evidence.location }];
  });
}

function securityPageText(page, selection, riskRanges = []) {
  if (page.legacySnapshot) {
    const snapshot = page.legacySnapshot;
    const root = snapshot.root || "request";
    const { text } = securityBodyText(snapshot.body, root, null, snapshot.fieldOrder);
    const encoder = new TextEncoder();
    const position = location => {
      const { range } = securityBodyText(snapshot.body, root, location, snapshot.fieldOrder);
      return range && { start: encoder.encode(text.slice(0, range.start)).length, end: encoder.encode(text.slice(0, range.end)).length };
    };
    const sensitiveRanges = (snapshot.sensitiveRanges || snapshot.redactions || []).map(mark => position(mark.location)).filter(Boolean);
    const risks = riskRanges.map(range => position(range.location)).filter(Boolean);
    const selected = position(selection.location);
    const navigation = position(selection.navigation?.location);
    return securityPageText({ chunks: [{ start: 0, content: text, sensitiveRanges }] }, {
      hitUnavailable: selection.hitUnavailable, ...(selected || {}),
      ...(navigation ? { navigation: { start: navigation.start } } : {}),
    }, risks);
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return (page.chunks || []).map(chunk => {
    const bytes = encoder.encode(chunk.content);
    const events = [{ at: 0, sensitive: 0, selected: 0 }, { at: bytes.length, sensitive: 0, selected: 0 }];
    const add = (range, kind) => {
      const start = Math.max(0, (range.start ?? -1) - chunk.start);
      const end = Math.min(bytes.length, (range.end ?? -1) - chunk.start);
      if (end <= start) return;
      events.push({ at: start, [kind]: 1 }, { at: end, [kind]: -1 });
    };
    for (const range of chunk.sensitiveRanges || []) add(range, "sensitive");
    for (const range of riskRanges) add(range, "risk");
    // Endpoints are recorded, not hidden, so they read differently from credentials.
    for (const range of chunk.coverageRanges || []) if (ENDPOINT_REASONS.includes(range.reason)) add(range, "endpoint");
    if (!selection.hitUnavailable) add(selection, "selected");
    const position = selection.navigation?.start - chunk.start;
    if (position >= 0 && position < bytes.length) {
      // Wrap one complete code point so scrollIntoView has a real text box.
      // This leaves the original text and its existing sensitive marks intact.
      let start = position;
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      let end = start + 1;
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
      if (start < bytes.length) add({ start: chunk.start + start, end: chunk.start + end }, "anchor");
    }
    events.sort((a, b) => a.at - b.at);
    let at = 0, sensitive = 0, selected = 0, risk = 0, endpoint = 0, anchor = 0, html = "";
    for (const event of events) {
      if (event.at > at) {
        const text = decoder.decode(bytes.slice(at, event.at));
        const content = anchor > 0 ? securitySourceAnchor(text) : esc(text);
        const classes = [sensitive > 0 && "security-sensitive-hit", risk > 0 && "security-risk-hit", endpoint > 0 && "security-endpoint-hit", selected > 0 && "security-body-hit"].filter(Boolean).join(" ");
        html += classes ? `<mark class="${classes}"${selected > 0 ? ' tabindex="-1"' : ""}>${content}</mark>` : content;
        at = event.at;
      }
      sensitive += event.sensitive || 0;
      selected += event.selected || 0;
      risk += event.risk || 0;
      endpoint += event.endpoint || 0;
      anchor += event.anchor || 0;
    }
    return html;
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
  const detection = allSnapshots.find(item => item.id === selection.detectionSnapshotId);
  const risk = record.findings?.find(item => item.id === selection.findingId);
  const page = s.bodyPage;
  const labelFor = (item, i) => item.id === "request" ? "请求正文" : item.id === "response" ? "响应正文" : item.id === "request/headers" ? "请求头" : item.id === "response/headers" ? "响应头" : `${item.id.startsWith("stream/") ? "流式内容" : "检测快照"} ${i + 1}`;
  const marks = securityPageMarks(page);
  const original = snapshot?.contentMode === "original" || page?.chunks?.some(chunk => chunk.sensitiveRanges?.length);
  const references = [...new Set((page?.chunks || []).flatMap(chunk => [...chunk.content.matchAll(/"contentSnapshotId":"([^"]+)"/g)].map(match => match[1])))].filter(id => allSnapshots.some(item => item.id === id));
  const content = snapshot && selection.snapshotId === snapshot.id ? `${risk ? `<p class="security-selected-risk">正在复核：${esc(securityLabel("rule", risk.ruleId))} · ${esc(securityLabel("stage", risk.evidenceStage))}</p>${selection.detectionSnapshotId ? `<p class="muted">证据来自检测时的流式内容快照，当前已定位到对应的${selection.snapshotId === "response" ? "响应" : "请求"}正文。</p>` : ""}` : ""}
    <p>${esc(SECURITY_BODY_LABELS.source[snapshot.source] || snapshot.source)} · ${esc(SECURITY_BODY_LABELS.state[snapshot.state] || snapshot.state)} · ${esc(securityTime(snapshot.capturedAt))}</p>
    <p class="muted">正文分段按需加载。${original ? "敏感内容保留原文并高亮显示，点击位置可定位复核。" : "此旧记录保存的是脱敏内容，已替换的凭据无法恢复。"}响应事件中的引用可通过“关联流式内容”打开重组快照。</p>
    ${s.bodyLoading ? `<p role="status">${s.bodyLocating ? "正在定位凭据命中点…" : "正在加载正文片段…"}</p>` : s.bodyError ? `<div class="notice warning">${esc(s.bodyError)}</div>` : page ? `
      ${page.legacySnapshot?.headers ? `<details><summary>旧记录请求 / 响应头</summary><pre class="code-preview security-body-content">${esc(JSON.stringify(page.legacySnapshot.headers, null, 2))}</pre></details>` : ""}
      ${page.gap ? `<div class="notice warning">此范围存在未保存的正文，不能视为完整证据。</div>` : ""}
      ${selection.hitUnavailable ? detection ? `<p class="muted">命中原文保存在下方检测快照中，响应正文保留关联引用。</p>` : `<div class="notice warning">此检测范围未保留可定位的凭据命中点，仅展示正文上下文。</div>` : ""}
      <div class="security-pagination"><button class="mini-button" data-action="security-body-page" data-offset="${esc(page.previousOffset ?? "")}" ${page.previousOffset == null ? "disabled" : ""}>上一段上下文</button><span>${page.rangeStart > 0 ? "源正文" : ""}字节 ${esc(page.offset ?? 0)}–${esc(page.chunks?.at(-1)?.end ?? page.offset ?? 0)} · 本快照 ${esc(snapshot?.byteLength ?? 0)} 字节</span><button class="mini-button" data-action="security-body-page" data-offset="${esc(page.nextOffset ?? "")}" ${page.nextOffset == null ? "disabled" : ""}>下一段上下文</button></div>
      <pre class="code-preview security-body-content" aria-label="保留正文">${securityPageText(page, selection, securityRiskSelections(record, selection.snapshotId))}</pre>
      ${references.length ? `<div class="security-body-tabs" aria-label="关联流式内容">${references.map((id, i) => `<button class="mini-button" data-action="security-body" data-id="${esc(id)}">关联流式内容 ${i + 1} · ${esc(id.split("/").at(-1).slice(0, 8))}</button>`).join("")}</div>` : ""}
      ${selection.sourceSnapshotId && selection.sourceSnapshotId !== selection.snapshotId && selection.sourceStart != null ? `<button class="mini-button" data-action="security-source" data-id="${esc(selection.sourceSnapshotId)}" data-offset="${esc(selection.sourceStart)}">查看完整正文上下文</button>` : ""}
      <details class="security-redactions"><summary>本页${original ? "敏感" : "脱敏"}位置 · ${marks.length}</summary><ul>${marks.map(mark => `<li><button class="security-location" data-action="security-location" data-start="${esc(mark.start)}" data-end="${esc(mark.end)}" data-location="${esc(mark.location || "")}">${mark.start == null ? esc(mark.location) : `字节 ${esc(mark.start)}–${esc(mark.end)}`}</button> · ${esc(SECURITY_BODY_LABELS.redaction[mark.reason] || mark.reason)}</li>`).join("")}</ul></details>` : ""}` : `<p class="muted">展开后加载该内容。</p>`;
  const panels = snapshots.map((item, i) => `<details class="security-body-review" data-security-snapshot="${esc(item.id)}" ${item.id === selection.snapshotId ? "open" : ""}><summary>${esc(labelFor(item, i))}${item.byteLength != null ? ` · ${esc(item.byteLength)} 字节` : ""}</summary>${item.id === selection.snapshotId && allSnapshots.some(snapshot => snapshot.id === item.id) ? content : `<p class="muted">${allSnapshots.some(snapshot => snapshot.id === item.id) ? "展开后加载该内容。" : "此内容未被网关观察或保留。"}</p>`}</details>`).join("");
  const streamPage = s.streamPageSnapshotId === selection.detectionSnapshotId ? s.streamPage : null;
  const streamContent = streamPage ? securityPageText(streamPage, { ...selection, hitUnavailable: false, start: selection.detectionStart, end: selection.detectionEnd }, securityRiskSelections(record, selection.detectionSnapshotId)) : "";
  const timeline = streamSnapshots.length ? `<section class="security-event-timeline" aria-label="流式事件时间线"><h4>流式事件时间线</h4><p class="muted">流式检测证据按事件顺序保留；点击风险可查看检测快照中的命中原文，响应正文保留关联引用。</p>${streamSnapshots.map((item, i) => {
    const active = selection.detectionSnapshotId === item.id || detection?.sourceSnapshotId === item.id;
    const previous = streamSnapshots[i - 1]?.id;
    const next = streamSnapshots[i + 1]?.id;
    const navigation = active ? `<nav class="security-event-nav" aria-label="流式事件导航"><button class="mini-button" data-action="security-event" data-id="${esc(previous || "")}" ${previous ? "" : "disabled"}>上一事件</button><button class="mini-button" data-action="security-event" data-id="${esc(next || "")}" ${next ? "" : "disabled"}>下一事件</button></nav>` : "";
    return `<details class="security-event" ${active ? "open" : `data-security-event="${esc(item.id)}"`}><summary><span>${esc(item.eventType || item.type || `流式事件 ${i + 1}`)}</span>${item.state ? ` · ${esc(SECURITY_BODY_LABELS.state[item.state] || item.state)}` : ""}</summary>${active && streamPage ? `${navigation}<div class="security-pagination"><button class="mini-button" data-action="security-event-page" data-offset="${esc(streamPage.previousOffset ?? "")}" ${streamPage.previousOffset == null ? "disabled" : ""}>上一段上下文</button><button class="mini-button" data-action="security-event-page" data-offset="${esc(streamPage.nextOffset ?? "")}" ${streamPage.nextOffset == null ? "disabled" : ""}>下一段上下文</button></div><pre class="code-preview security-body-content" aria-label="检测快照">${streamContent}</pre>` : `${navigation}<p class="muted">${active && s.streamError ? esc(s.streamError) : active && s.streamLoading ? "正在加载检测证据…" : "展开后加载该事件证据。"}</p>`}</details>`;
  }).join("")}</section>` : "";
  return `<section aria-label="正文复核"><h3>正文复核</h3>${panels || `<p class="muted">当前记录没有可展示的请求或响应内容。</p>`}${timeline}</section>`;
}

async function loadSecurityBody(offset = 0, locateCredential = false) {
  const s = state.security;
  const sequence = s.bodySequence = (s.bodySequence || 0) + 1;
  const recordId = s.detail?.id;
  const snapshotId = s.bodySelection?.snapshotId;
  const selection = s.bodySelection;
  const current = () => sequence === s.bodySequence && s.detail?.id === recordId && s.bodySelection === selection && securityDetailVisible();
  s.bodyPage = null; s.bodyError = null; s.bodyLoading = true; s.bodyLocating = locateCredential;
  if (securityDetailVisible()) render();
  if (!recordId || !snapshotId || !s.detail.bodySnapshots?.some(item => item.id === snapshotId)) { s.bodyLoading = false; if (securityDetailVisible()) render(); return false; }
  try {
    while (true) {
      const page = await api(`/security/audit/${encodeURIComponent(recordId)}/body?${new URLSearchParams({ snapshot: snapshotId, offset })}`);
      if (!current()) return false;
      s.bodyPage = page;
      if (!locateCredential || page.legacySnapshot) break;
      const mark = securityPageMarks(page).find(mark =>
        !["redaction_buffer_budget", "url_authority_uncertain", "credential_prefix_uncertain", "incomplete_body_fragment", "unsupported_stream_fragment", "internal_host", "public_host", "internal_identity"].includes(mark.reason)
        && mark.end > selection.start && mark.start < selection.end);
      if (mark) { selection.start = mark.start; selection.end = mark.end; selection.hitUnavailable = false; break; }
      // Older findings referenced a whole detection window. Search its annotations one page at a time.
      if (page.nextOffset == null || page.nextOffset <= offset || page.nextOffset >= selection.end) { selection.hitUnavailable = true; break; }
      offset = page.nextOffset;
    }
  } catch (error) { if (current()) s.bodyError = error.message; }
  if (!current()) return false;
  s.bodyLoading = false; s.bodyLocating = false; render();
  if (!s.bodyError && selection.navigation) {
    const target = pageContent.querySelector("[data-security-body-anchor]");
    target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    target?.focus({ preventScroll: true });
  }
  return !s.bodyError;
}

async function loadSecurityStream(snapshotId, offset = Math.max(0, (state.security.bodySelection?.detectionStart || 0) - 512)) {
  const s = state.security;
  const recordId = s.detail?.id;
  if (!recordId || !snapshotId) return false;
  const sequence = s.streamSequence = (s.streamSequence || 0) + 1;
  const current = () => sequence === s.streamSequence && s.detail?.id === recordId && s.bodySelection?.detectionSnapshotId === snapshotId && securityDetailVisible();
  s.streamPage = null;
  s.streamPageSnapshotId = null;
  s.streamLoading = true;
  s.streamError = null;
  if (securityDetailVisible()) render();
  try {
    const page = await api(`/security/audit/${encodeURIComponent(recordId)}/body?${new URLSearchParams({ snapshot: snapshotId, offset })}`);
    if (current()) { s.streamPage = page; s.streamPageSnapshotId = snapshotId; }
  } catch (error) {
    if (current()) s.streamError = error.message;
  }
  if (!current()) return false;
  s.streamLoading = false;
  if (securityDetailVisible()) render();
  return !s.streamError;
}

function renderSecurityFindings(record) {
  return `    <h3>关联风险 · ${record.findings?.length || 0}</h3>
    ${(record.findings || []).map(f => `<article class="security-finding ${state.security.bodySelection?.findingId === f.id ? "is-selected" : ""}"><div>${securityBadge(f.severity)} <button class="security-finding-link" data-action="security-finding" data-id="${esc(f.id)}" aria-pressed="${state.security.bodySelection?.findingId === f.id}">${esc(securityLabel("rule", f.ruleId))} <span>定位正文</span></button></div><p class="muted">${esc(securityLabel("category", f.category))} · ${esc(securityLabel("stage", f.evidenceStage))} · ${esc(securityLabel("confidence", f.confidence))} · 规则 ${esc(f.ruleId)} v${esc(f.ruleVersion)}</p>${f.severityReason ? `<p>分级依据：${esc(securityLabel("basis", f.severityReason))}。</p>` : ""}${f.confidenceReason ? `<p>判断依据：${esc(securityLabel("basis", f.confidenceReason))}。</p>` : ""}<p>证据仅表示在此阶段观察到了对应内容或操作结构，不确认实际执行或恶意意图。</p><details><summary>检测证据与标准映射</summary><pre class="code-preview">${esc(JSON.stringify({ evidence: f.evidence, frameworkMappings: f.frameworkMappings }, null, 2))}</pre></details></article>`).join("") || `<p class="muted">没有关联风险；请结合检查状态判断覆盖范围。</p>`}
`;
}

function securityRecordFacts(record) {
  const facts = [["记录 ID", record.id], ["操作", securityLabel("action", record.action)], ["配置入口", record.providerId || "本地管理"], ["发生时间", securityTime(record.at)], ["结束时间", record.finishedAt ? securityTime(record.finishedAt) : "未记录"], ["请求结果", securityLabel("outcome", record.outcome)], ["HTTP 状态", record.httpStatus ?? "未知"], ["配置修订", record.revision ?? "未知"], ["模型", securityModelMapping(record)], ["响应头耗时", record.headersMs == null ? "—" : `${record.headersMs} ms`], ["完整记录耗时", record.durationMs == null ? "—" : `${record.durationMs} ms`]];
  return facts;
}

function renderSecurityDetail(record) {
  const facts = securityRecordFacts(record);
  return `<section class="panel security-detail" aria-label="审计详情"><div class="panel-header"><h2>请求记录</h2>${securityBadge(record.severity)}</div><div class="panel-body">
    <dl class="security-facts">${facts.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>
    <p>${esc(securityInspectionLabel(record))}。${record.kind === "request" ? "工具真实执行状态：未知；工具结果来自客户端报告。" : "记录审计存储的完整性状态。"}</p>
    ${record.inspectionProgress ? `<p role="status">检测进度：${esc(record.inspectionProgress.processedBytes || 0)} / ${esc(record.inspectionProgress.observedBytes || record.observedBytes || 0)} 字节 · ${esc(securityInspectionLabel(record, record.inspectionProgress.state))}${record.inspectionProgress.phase === "receiving" ? "（正文接收中）" : record.inspectionProgress.phase === "queued" ? "（等待检测资源）" : ""}</p>` : ""}
    ${record.coverageReasons?.length ? `<div class="notice warning">覆盖不足：${record.coverageReasons.map(reason => esc(securityLabel("reason", reason))).join("；")}</div>` : ""}
    ${record.coverageGaps?.length ? `<details><summary>正文缺口范围</summary><pre class="code-preview">${esc(JSON.stringify(record.coverageGaps, null, 2))}</pre></details>` : ""}
    ${record.lostWrites ? `<p>记录到 ${esc(record.lostWrites)} 次审计写入缺口。</p>` : ""}
    ${record.usage && Object.keys(record.usage).length ? `<details><summary>上游报告的 Token 用量</summary><pre class="code-preview">${esc(JSON.stringify(record.usage, null, 2))}</pre></details>` : ""}
    ${renderSecurityFindings(record)}
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
  const [status, result] = await Promise.allSettled([api("/security/status"), api(`/security/sessions?${params}`)]);
  if (sequence !== s.sequence) return;
  s.status = status.status === "fulfilled" ? status.value : { storage: { state: "unavailable" } };
  if (result.status === "fulfilled") { s.result = result.value; s.resultParams = params.toString(); s.updatedAt = new Date().toISOString(); }
  else { s.error = result.reason.message; s.result = null; }
  s.loading = false;
  if (state.page === "security") render();
}

async function securityAction(action, element) {
  const s = state.security;
  const t = state.trace;
  if (action === "security-session") {
    saveSecurityList();
    window.history.pushState({ page: "security-session", list: securityListState(), returnToSecurityList: true }, "", `#security/session/${encodeURIComponent(element.dataset.id)}`);
    await loadSecuritySession(element.dataset.id); return;
  }
  if (action === "security-session-refresh") { await loadSecuritySession(t.id, false); return; }
  if (action === "security-trace-select") {
    await loadSecurityDetail(element.dataset.id, true, true);
    pageContent.querySelector(`.trace-event-row.is-selected`)?.scrollIntoView({ block: "nearest", behavior: "instant" });
    return;
  }
  if (action === "security-trace-tab") {
    s.contentNavigation = null;
    t.tab = element.dataset.tab; render();
    if (t.tab === "body" && !s.bodyPage) await loadSecurityBody();
    else if (["request", "response"].includes(t.tab)) await loadContentRiskMarks(t.tab === "response");
    return;
  }
  if (["security-content-page", "security-response-content-page"].includes(action)) {
    s.contentNavigation = null;
    await loadRetainedContent(Number(element.dataset.offset), action === "security-response-content-page"); return;
  }
  if (["security-content-source", "security-response-content-source"].includes(action)) {
    const response = action === "security-response-content-source";
    const item = s.detail?.[response ? "responseContent" : "requestContent"]?.items?.find(item => item.index === Number(element.dataset.index));
    if (!item) return;
    s.contentNavigation = null;
    t.tab = "body";
    s.bodySelection = { snapshotId: response ? item.snapshotId || "response" : "request", navigation: { start: item.start, location: item.location } };
    render(); await loadSecurityBody(Math.max(0, item.start - 512)); return;
  }
  if (action === "security-trace-risk") { t.riskOnly = !t.riskOnly; render(); return; }
  if (action === "security-trace-scale") { t.scale = t.scale === "duration" ? "order" : "duration"; render(); return; }
  if (action === "security-trace-more") { await loadMoreSecurityTrace(); return; }
  if (action === "security-detail") {
    const fromList = state.page === "security";
    if (fromList) saveSecurityList();
    window.history.pushState({ page: "security-detail", list: securityListState(), returnToSecurityList: fromList }, "", `#security/audit/${encodeURIComponent(element.dataset.id)}`);
    await loadSecurityDetail(element.dataset.id);
    return;
  }
  if (["security-finding", "security-body", "security-location", "security-source", "security-body-page", "security-event", "security-event-page"].includes(action)) {
    if (!s.detail) return;
    if (action === "security-event-page") {
      if (element.dataset.offset !== "") await loadSecurityStream(s.bodySelection.detectionSnapshotId, Number(element.dataset.offset));
      return;
    }
    if (action === "security-event") {
      if (!element.dataset.id) return;
      // Stream navigation leaves the pending body selection and its request valid.
      s.bodySelection ||= {};
      s.bodySelection.detectionSnapshotId = element.dataset.id;
      delete s.bodySelection.detectionStart;
      delete s.bodySelection.detectionEnd;
      await loadSecurityStream(element.dataset.id);
      return;
    }
    if (action === "security-finding") {
      const finding = s.detail.findings?.find(item => item.id === element.dataset.id);
      if (!finding) return;
      if (state.page === "security-session") { await locateContentFinding(finding); return; }
      const ref = finding?.evidence?.bodyRef || { snapshotId: "unavailable" };
      const source = ref.sourceSnapshotId || ref.snapshotId;
      const snapshotId = canonicalBodySnapshotId(source);
      const mapped = snapshotId !== ref.snapshotId;
      const unrelatedOffsets = snapshotId !== source;
      s.bodySelection = { ...ref, snapshotId, ...(mapped ? { detectionSnapshotId: ref.snapshotId, detectionStart: ref.start, detectionEnd: ref.end } : {}), ...(mapped && ref.sourceStart != null ? { start: ref.sourceStart, end: ref.sourceEnd } : {}), ...(mapped && unrelatedOffsets && ref.sourceStart == null ? { hitUnavailable: true } : {}), findingId: finding?.id };
      if (mapped && unrelatedOffsets && ref.sourceStart == null) { delete s.bodySelection.start; delete s.bodySelection.end; }
    } else if (action === "security-source") {
      const previous = s.bodySelection;
      const id = element.dataset.id;
      s.bodySelection = { snapshotId: canonicalBodySnapshotId(id), start: previous.sourceStart ?? previous.start, end: previous.sourceEnd ?? previous.end, findingId: previous.findingId };
    } else if (action === "security-body") {
      const id = element.dataset.id;
      s.bodySelection = { snapshotId: canonicalBodySnapshotId(id), ...(id.startsWith("stream/") ? { detectionSnapshotId: id } : { start: Number(element.dataset.offset || 0) }) };
    }
    else if (action === "security-location") {
      const { navigation, ...selection } = s.bodySelection;
      s.bodySelection = { ...selection, hitUnavailable: false, ...(element.dataset.location ? { location: element.dataset.location } : { start: Number(element.dataset.start), end: Number(element.dataset.end) }) };
    }
    const finding = s.detail.findings?.find(item => item.id === s.bodySelection.findingId);
    const mappedStream = s.bodySelection.detectionSnapshotId != null;
    const locateCredential = ["security-finding", "security-source"].includes(action) && finding?.ruleId === "SEC-SECRET-001" && (!mappedStream || s.bodySelection.sourceStart != null || s.bodySelection.snapshotId === s.bodySelection.sourceSnapshotId);
    const offset = action === "security-body-page" ? Number(element.dataset.offset) : Math.max(0, (s.bodySelection.start || 0) - 512);
    const detectionSnapshotId = s.bodySelection.detectionSnapshotId;
    const streamSequence = s.streamSequence;
    if (!await loadSecurityBody(offset, locateCredential)) return;
    // A stream event opened during the body request owns its own load and pagination.
    if (detectionSnapshotId && s.streamSequence === streamSequence) await loadSecurityStream(detectionSnapshotId);
    const target = pageContent.querySelector(".security-body-hit") || pageContent.querySelector(".security-body-review");
    target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    target?.focus?.({ preventScroll: true });
    return;
  }
  if (action === "security-back") { await returnSecurityList(); return; }
  if (action === "security-reset") {
    s.detailSequence++; s.streamSequence = (s.streamSequence || 0) + 1; s.filters = { hours: "24" }; s.cursor = ""; s.history = []; s.detail = null; s.bodySelection = null; s.result = null;
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
  return `<button class="list-row ${active ? "is-selected" : ""}" data-action="select-model" data-id="${esc(id)}"><div><h3>${esc(id)}</h3><p>${esc(id)} · ${(item.capabilities || []).join(" · ")}</p></div><span class="status-badge">当前配置</span></button>`;
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
    if (["import-suites", "export-suites", "close-transfer"].includes(action)) {
      state.transfer = { panel: action === "import-suites" ? "import" : action === "export-suites" ? "export" : null, bundle: null, preview: null };
      render();
    } else if (action === "refresh") {
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
    } else if (action === "delete-suite") {
      const suite = configurationSuites(state.config).find((item) => item.id === element.dataset.id);
      if (!suite) throw new Error("配置不存在，请刷新列表。");
      const clientHint = suite.target === "claude-code"
        ? "如已应用到 Claude Code，请先撤销接入或切换其他配置；删除不会自动恢复客户端设置。"
        : "如客户端仍在使用此配置，请先切换其他配置；删除不会自动恢复客户端设置。";
      const unsavedHint = hasUnsavedChanges() ? "\n当前未保存的修改也会丢失。" : "";
      if (!window.confirm(`确定删除配置「${suite.name}」？删除后立即生效，该配置的本地地址将停止服务。\n${clientHint}${unsavedHint}`)) return;
      await saveChanges(() => removeSuite(suite.id), undefined, "配置已删除并生效。");
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
    if (formId === "suite-export-form") { await exportSuites(data); return; }
    if (formId === "suite-import-form") { await importSuites(data); return; }
    if (formId === "security-trace-search") {
      state.trace.search = String(data.get("search") || ""); render(); return;
    }
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
    const successAlert = formId === "claude-client-form"
      ? "模型选择已保存。请点击“应用到 Claude Code”，重新应用配置后才会生效。"
      : "";
    await saveChanges(handlers[formId], form, undefined, successAlert);
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

function removeSuite(id) {
  const config = state.candidate;
  if (!Object.hasOwn(config.bindings, id)) throw new Error("配置不存在，请刷新列表。");
  const providerId = config.bindings[id].virtualProvider;
  const routeId = config.virtualProviders[providerId]?.route;
  delete config.bindings[id];

  // Only remove this configuration's dependencies when no remaining record uses them.
  if (!values(config.bindings).some((binding) => binding.virtualProvider === providerId)) {
    delete config.virtualProviders[providerId];
    if (routeId && !values(config.virtualProviders).some((provider) => provider.route === routeId)) {
      const upstreamIds = (config.routes[routeId]?.backends || []).map((backend) => backend.upstream);
      delete config.routes[routeId];
      for (const upstreamId of upstreamIds) {
        if (!values(config.routes).some((route) => route.backends?.some((backend) => backend.upstream === upstreamId))) {
          delete config.upstreams[upstreamId];
        }
      }
    }
  }

  if (!state.selected.suite || !Object.hasOwn(config.bindings, state.selected.suite)) {
    state.selected = { suite: null, virtualProvider: null, model: null };
    selectSuite(firstKey(config.bindings));
  }
  state.page = "overview";
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
      ...(suite.target === "codex" ? codexModelFields(clientModelId, existing, row) : {}),
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

async function saveChanges(update, form, successMessage = "配置已保存并生效。", successAlert = "") {
  const previous = {
    page: state.page,
    selected: clone(state.selected),
    artifactPreview: state.artifactPreview,
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
  if (successAlert) window.alert?.(successAlert);
  else toast(successMessage);
}

async function refresh(showToast = true) {
  if (state.page === "security-session") { await loadSecuritySession(state.trace.id, false); return; }
  if (securityDetailVisible()) { await loadSecurityDetail(state.security.detailId, false); return; }
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
