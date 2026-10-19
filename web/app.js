import { CLAUDE_MODEL_CATALOG } from "./claude-models.js";

const pageContent = document.querySelector("#page-content");
const pageTitle = document.querySelector("#page-title");
const railStatus = document.querySelector("#rail-status");
const versionLabel = document.querySelector("#version-label");
const toastRegion = document.querySelector("#toast-region");
const formBaselines = new WeakMap();
const formConflicts = new WeakSet();
const lockedControls = new WeakMap();
const protectionTtlUnits = new WeakMap();
let modelHintSequence = 0;
let renderedTraceId = null;
let renderedTraceDetailId = null;
let renderedTraceTab = null;
let renderedTraceScale = null;
let traceOverviewObserver = null;
let pendingTraceSelection = false;
let navigationIndex = window.history.state?.navigationIndex || 0;
let navigationUrl = window.location.href;
let restoringNavigation = false;

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
  suppliers: "供应商",
  "supplier-create": "新建供应商",
  "supplier-detail": "供应商详情",
  "inventory-create": "新建 Codex 线路",
  overview: "线路",
  "cable-create": "新建线路",
  "cable-import": "导入线路",
  "cable-export": "导出线路",
  "cable-detail": "线路详情",
  models: "模型管理",
  diagnostics: "诊断",
  settings: "设置",
  security: "审计记录",
  "security-detail": "审计详情",
  "security-session": "会话轨迹",
};

const CABLE_TRANSFER_NOTICE = "仅包含 CableTidy 线路。客户端文件、运行记录和管理台设置不包含在内。默认导出不含认证凭据。";

const state = {
  supplierId: null,
  supplierModelId: null,
  supplierEditor: null,
  supplierDraft: null,
  discoveredModels: [],
  page: "overview",
  config: null,
  candidate: null,
  runtime: null,
  events: [],
  codexCatalog: null,
  claudeAliases: { defaultModel: [], subagent: [], families: [] },
  createTarget: "codex",
  transfer: { bundle: null, preview: null },
  busy: false,
  selected: {
    model: null,
    virtualProvider: null,
    cable: null,
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
    const [configResult, runtime, events, codexCatalog, claudeModels] = await Promise.all([
      api("/config"),
      api("/runtime"),
      api("/events"),
      api("/codex/models"),
      api("/claude/models"),
    ]);
    state.config = configResult.config;
    state.candidate = clone(state.config);
    state.runtime = runtime;
    state.codexCatalog = codexCatalog;
    state.claudeAliases = claudeModels.aliases;
    state.events = events.events || [];
    state.selected.virtualProvider = firstKey(state.candidate.virtualProviders);
    state.selected.cable = firstKey(state.candidate.cables);
    state.selected.model = selectedCable()?.modelIds[0] || null;
    railStatus.textContent = "服务运行中";
    railStatus.parentElement.classList.remove("is-offline");
    if (window.location.hash === "#settings") state.page = "settings";
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
  pageTitle.textContent = state.page === "cable-detail"
    ? selectedCable()?.name || PAGE_META["cable-detail"]
    : state.page === "supplier-detail" ? state.config.suppliers?.[state.supplierId]?.name || PAGE_META["supplier-detail"]
    : pageMeta();
  versionLabel.textContent = state.runtime?.version ? `v${state.runtime.version}` : "版本未知";
  document.querySelectorAll(".nav-item").forEach((item) => {
    const active = item.dataset.page === (state.page.startsWith("security") ? "security" : state.page.startsWith("supplier") ? "suppliers" : ["diagnostics", "settings"].includes(state.page) ? state.page : "overview");
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });

  const renderers = {
    suppliers: renderSuppliers,
    "supplier-create": renderSupplierCreate,
    "supplier-detail": renderSupplierDetail,
    "inventory-create": () => renderInventoryCable(null),
    overview: renderOverview,
    "cable-create": renderCableCreate,
    "cable-import": renderCableImport,
    "cable-export": renderCableExport,
    "cable-detail": renderCableDetail,
    models: renderModels,
    diagnostics: renderDiagnostics,
    settings: renderSettings,
    security: renderSecurity,
    "security-detail": renderSecurityDetailPage,
    "security-session": renderSecuritySession,
  };
  const traceFocus = ["trace-event-list", "trace-map-viewport", "trace-scroll-control"]
    .find(name => document.activeElement?.classList?.contains(name));
  if (state.page !== "security-session") pendingTraceSelection = false;
  else if (renderedTraceId !== state.trace.id || renderedTraceDetailId !== state.security.detailId || renderedTraceScale !== state.trace.scale) pendingTraceSelection = true;
  const paneScroll = state.page === "security-session" && renderedTraceId === state.trace.id
    ? [...pageContent.querySelectorAll(".trace-event-list, .trace-inspector-body, .trace-map-viewport")].map(node => ({
      selector: node.classList.contains("trace-event-list") ? ".trace-event-list" : node.classList.contains("trace-map-viewport") ? ".trace-map-viewport" : ".trace-inspector-body",
      top: node.scrollTop,
      left: node.scrollLeft,
    })) : [];
  if (state.security.protectionSource && !protectionSourceCurrent(state.security.protectionSource)) closeProtectionSource();
  traceOverviewObserver?.disconnect();
  traceOverviewObserver = null;
  pageContent.innerHTML = renderers[state.page]();
  for (const pane of paneScroll) {
    if (pane.selector === ".trace-inspector-body" && (renderedTraceDetailId !== state.security.detailId || renderedTraceTab !== state.trace.tab)) continue;
    const node = pageContent.querySelector(pane.selector);
    if (node) { node.scrollTop = pane.top; node.scrollLeft = pane.left; }
  }
  if (state.page === "security-session") setupTraceOverview();
  if (traceFocus) pageContent.querySelector(`.${traceFocus}`)?.focus({ preventScroll: true });
  renderedTraceId = state.page === "security-session" ? state.trace.id : null;
  renderedTraceDetailId = state.security.detailId;
  renderedTraceTab = state.trace.tab;
  renderedTraceScale = state.trace.scale;
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
  pageContent.querySelectorAll("[data-token-length]").forEach(syncTokenLength);
  const settingsForm = pageContent.querySelector("#audit-settings-form");
  if (settingsForm) syncAuditSettingsForm(settingsForm);
  const protectionForm = pageContent.querySelector("#protection-settings-form");
  if (protectionForm) syncProtectionSettingsForm(protectionForm);
  const supplierDialog = pageContent.querySelector("#supplier-resource-dialog");
  if (supplierDialog) {
    supplierDialog.addEventListener("cancel", event => {
      event.preventDefault();
      if (!state.busy) closeSupplierEditor();
    });
    supplierDialog.showModal();
  }
}

function fieldSnapshot(control) {
  return [
    control.name || "", control.type, { ...control.dataset },
    control.closest("[data-cable-model]")?.dataset.modelId || "",
    ["checkbox", "radio"].includes(control.type) ? control.checked
      : control.multiple ? [...control.selectedOptions].map((option) => option.value)
        : control.value,
  ];
}

function formSnapshot(form) {
  const fields = [...form.querySelectorAll("input, select, textarea")].filter((control) => {
    // Select-all reflects the line choices; it is not an independent saved value.
    if ("protectionAll" in control.dataset) return false;
    // Official metadata is derived, not an editable configuration value.
    if ("cableModelContext" in control.dataset || "codexVision" in control.dataset) {
      const mode = control.closest("[data-cable-model]")?.querySelector("[data-codex-metadata-mode]");
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
    if (!("cableModelClient" in field[2] || "codexMetadataMode" in field[2])) continue;
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

function mergeAuditSettingsFields(base, local, remote) {
  const merged = [];
  for (const names of [["retentionDays", "retentionUnlimited"], ["budgetMiB", "storageUnlimited"]]) {
    const groups = [base, local, remote].map(fields => fields.filter(field => names.includes(field[0])));
    const value = fields => fields.find(field => field[0] === names[1])[4]
      ? null : Number(fields.find(field => field[0] === names[0])[4]);
    const [before, ours, theirs] = groups.map(value);
    // Each number and its unlimited checkbox represent one configuration value.
    if (Object.is(ours, before)) merged.push(...groups[2]);
    else if (Object.is(theirs, before) || Object.is(ours, theirs)) merged.push(...groups[1]);
    else return null;
  }
  return merged;
}

function mergeProtectionSettingsFields(base, local, remote) {
  const names = ["mappingTtlValue", "mappingTtlUnit"];
  const groups = [base, local, remote].map(fields => fields.filter(field => names.includes(field[0])));
  const seconds = fields => protectionTtlSeconds(fields.find(field => field[0] === names[0])[4], fields.find(field => field[0] === names[1])[4]);
  const [before, ours, theirs] = groups.map(seconds);
  const ttl = Object.is(ours, before) ? groups[2]
    : Object.is(theirs, before) || Object.is(ours, theirs) ? groups[1] : null;
  const other = mergeFormFields(...[base, local, remote].map(fields => fields.filter(field => !names.includes(field[0]))));
  return ttl && other ? [...other, ...ttl] : null;
}

function restoreFormChanges(form, replacement) {
  const baseline = formBaselines.get(form);
  const latest = formBaselines.get(replacement);
  const current = formSnapshot(form);
  const sameContext = form.getAttribute("data-cable-context") === replacement.getAttribute("data-cable-context");
  if (sameContext && current === latest) return;
  // Creation drafts have no remote record to merge, even after switching CLI.
  if (form.getAttribute("id") === "cable-create-form" || (sameContext && baseline === latest)) {
    if (formConflicts.has(form)) form.querySelector("[data-form-feedback]")?.remove();
    formConflicts.delete(form);
    replacement.replaceWith(form);
    return;
  }
  const cableModels = form.getAttribute("id") === "cable-models-form";
  const savedFields = (snapshot) => JSON.parse(snapshot).filter((field) => !cableModels || field[3]);
  const structure = (snapshot) => JSON.stringify(JSON.parse(snapshot).map(fieldKey));
  const sameStructure = baseline !== undefined && (cableModels
    || structure(baseline) === structure(current) && structure(baseline) === structure(latest));
  const merge = form.getAttribute("id") === "audit-settings-form" ? mergeAuditSettingsFields
    : form.getAttribute("id") === "protection-settings-form" ? mergeProtectionSettingsFields
      : form.getAttribute("id") === "supplier-model-form" ? mergeSupplierModelFields : mergeFormFields;
  const merged = sameContext && sameStructure
    ? merge(savedFields(baseline), savedFields(current), savedFields(latest)) : null;
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
  if (cableModels) {
    const retained = new Set(merged.map((field) => field[3]));
    replacement.querySelectorAll("[data-cable-model]").forEach((row) => {
      if (!retained.has(row.dataset.modelId)) row.remove();
      else syncCodexMetadata(row);
    });
    const list = replacement.querySelector("#cable-model-list");
    form.querySelectorAll("[data-cable-model]").forEach((row) => {
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
  // Supplier creation is held in state, including resources added outside its form.
  return [...pageContent.querySelectorAll("form")].filter(
    (form) => form !== excludedForm && form.getAttribute("id") !== "supplier-create-form" && isFormEdited(form),
  );
}

function hasUnsavedChanges() {
  if (state.page === "supplier-create" && state.supplierDraft && (state.supplierDraft.name || entries(state.supplierDraft.interfaces).length || entries(state.supplierDraft.models).length)) return true;
  return captureEditedForms().some((form) => !["resolve-form", "security-filter-form", "security-trace-search"].includes(form.getAttribute("id")));
}

function confirmPageLeave() {
  return !hasUnsavedChanges() || window.confirm("有未保存的修改，确定放弃并离开？");
}

function pushNavigation(navigation, url) {
  window.history.pushState({ ...navigation, navigationIndex: ++navigationIndex }, "", url);
  navigationUrl = window.location.href;
}

function navigatePage(page) {
  if (state.busy || !state.config || page === state.page || !confirmPageLeave()) return;
  if (page === "security" && state.page.startsWith("security-")) { returnSecurityList(); return; }
  if (state.page === "security") saveSecurityList();
  if (["security", "settings"].includes(page) || state.page.startsWith("security") || state.page === "settings") {
    window.history.replaceState({ ...window.history.state, page: state.page }, "");
    pushNavigation({ page, ...(page === "security" ? { list: securityListState() } : {}) }, ["security", "settings"].includes(page) ? `#${page}` : window.location.pathname + window.location.search);
  }
  state.security.detailSequence++;
  state.security.bodySequence = (state.security.bodySequence || 0) + 1;
  if (state.page === "cable-import") state.transfer = { bundle: null, preview: null };
  state.page = page;
  render();
  if (page === "security") loadSecurity();
}

window.history.scrollRestoration = "manual";
window.history.replaceState({ ...window.history.state, navigationIndex }, "");
window.addEventListener("popstate", event => {
  if (!state.config) return;
  if (restoringNavigation) { restoringNavigation = false; return; }
  const nextIndex = event.state?.navigationIndex || 0;
  if (state.busy || !confirmPageLeave()) {
    // popstate fires after the URL changes. Return to the current entry on cancel.
    const offset = navigationIndex - nextIndex;
    if (offset) {
      restoringNavigation = true;
      window.history.go(offset);
    } else {
      // Entries from an older app may lack an index; go(0) would reload the draft.
      pushNavigation({ page: state.page }, navigationUrl);
    }
    return;
  }
  navigationIndex = nextIndex;
  navigationUrl = window.location.href;
  return restoreSecurityNavigation();
});

pageContent.addEventListener("click", (event) => {
  const element = event.target.closest("[data-action], [data-page]");
  if (!element || !pageContent.contains(element) || state.busy) return;
  if (element.dataset.action === "security-content-source") event.preventDefault();
  if (element.dataset.action) handleAction(element.dataset.action, element);
  else navigatePage(element.dataset.page);
});

const protectionDialog = document.querySelector("#protection-source-dialog");
protectionDialog.addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (button) securityAction(button.dataset.action, button);
});
protectionDialog.addEventListener("close", () => { if (!protectionDialog.open) closeProtectionSource(); });

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

function cableRouteBackend(route) {
  return route?.backends?.length === 1 ? route.backends[0] : null;
}

function configurationCables(config) {
  return entries(config.cables).map(([cableId, record]) => {
    const virtualProvider = config.virtualProviders?.[record.virtualProvider] || {};
    const route = config.routes?.[virtualProvider.route] || {};
    const routeBackend = cableRouteBackend(route);
    const upstreamId = routeBackend?.upstream || null;
    const upstream = upstreamId ? config.upstreams?.[upstreamId] || null : null;
    const modelIds = Object.keys(virtualProvider.models || {});
    const name =
      record.name ||
      virtualProvider.name ||
      `${targetLabel(record.target)} / ${upstream?.name || upstreamId || "未配置上游"}`;
    return {
      id: cableId,
      name,
      target: record.target,
      record,
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

function selectedCable() {
  return configurationCables(state.candidate || {}).find(
    (cable) => cable.id === state.selected.cable,
  ) || null;
}

function selectCable(id) {
  const cable = configurationCables(state.candidate || {}).find((item) => item.id === id);
  state.selected.cable = id || null;
  if (state.artifactPreview?.cableId !== id) state.artifactPreview = null;
  if (!cable) return;
  state.selected.virtualProvider = cable.record.virtualProvider;
  state.selected.model = cable.modelIds[0] || null;
}

function cableProviderStatus(cable) {
  const runtimeProvider = state.runtime?.virtualProviders?.find(
    (item) => item.id === cable.record.virtualProvider,
  );
  if (runtimeProvider?.status === "paused") {
    return { label: "已暂停", className: "warning" };
  }
  if (runtimeProvider?.status === "listening") {
    return { label: "已启动", className: "" };
  }
  return { label: "未启动", className: "neutral" };
}

function cableEndpoint(cable) {
  return state.runtime?.virtualProviders?.find(provider => provider.id === cable.record.virtualProvider)?.baseUrl
    || "";
}

function cableRow(cable) {
  const providerStatus = cableProviderStatus(cable);
  return `
    <tr>
      <th scope="row"><button class="cable-name" data-action="open-cable" data-id="${esc(cable.id)}">${esc(cable.name)}</button><span class="cable-upstream">${esc(cable.record.managedModels ? `${(cable.record.suppliers || []).length} 家供应商 · ${(cable.record.suppliers || []).map(id => state.config.suppliers?.[id]?.name || id).join("、") || "未选择供应商"}` : cable.upstream?.name || cable.upstreamId || "未配置上游")}</span></th>
      <td data-label="CLI">${esc(targetLabel(cable.target))}</td>
      <td data-label="模型设置">${cable.modelIds.length ? `${cable.modelIds.length} 项设置` : cable.record.managedModels ? "未选择模型" : "直接透传"}</td>
      <td data-label="本地地址" class="mono">${esc(cableEndpoint(cable))}</td>
      <td data-label="本地服务"><span class="status-badge ${providerStatus.className}">${esc(providerStatus.label)}</span></td>
      <td data-label="操作"><button class="button button-danger" type="button" data-action="delete-cable" data-id="${esc(cable.id)}" aria-label="删除线路 ${esc(cable.name)}">删除</button></td>
    </tr>
  `;
}

function renderOverview() {
  const cables = configurationCables(state.candidate);
  return `
    <div class="cable-toolbar">
      <span class="muted">${cables.length} 条线路 · 每条线路把一个 CLI 接到一个或多个上游</span>
      <div class="cable-toolbar-actions">
        <button class="button" data-action="import-cables">导入线路</button>
        <button class="button" data-action="export-cables" ${cables.length ? "" : "disabled"}>导出线路</button>
        <button class="button" data-action="create-cable">旧接入 / Claude Code</button>
        <button class="button button-primary" data-action="create-inventory-cable">新建 Codex 线路</button>
      </div>
    </div>
    ${
      cables.length
        ? `<div class="cable-list"><table class="cable-table" aria-label="线路"><thead><tr><th scope="col">线路名称</th><th scope="col">CLI</th><th scope="col">模型设置</th><th scope="col">本地地址</th><th scope="col">本地服务</th><th scope="col">操作</th></tr></thead><tbody>${cables.map(cableRow).join("")}</tbody></table></div>`
        : `<div class="panel"><div class="empty">暂无线路</div></div>`
    }
  `;
}

function renderCableExport() {
  const cables = configurationCables(state.candidate);
  return `
    <button class="text-button" data-action="back-overview">返回列表</button>
    <form id="cable-export-form" class="config-form panel">
      <section class="config-section" aria-labelledby="cable-export-selection">
        <h2 id="cable-export-selection">选择线路</h2>
        <div class="transfer-fields">
          <p class="muted">${CABLE_TRANSFER_NOTICE}</p>
          <fieldset class="transfer-selection"><legend>选择要导出的线路</legend>
            ${cables.map(cable => `<label class="checkbox-field"><input type="checkbox" name="cableIds" value="${esc(cable.id)}" checked /><span>${esc(cable.name)} · ${esc(targetLabel(cable.target))}</span></label>`).join("")}
          </fieldset>
          <label class="checkbox-field"><input type="checkbox" name="includeCredentials" /><span>包含认证凭据（API Key、上游密钥及 URL 认证信息）</span></label>
          <p class="muted">勾选后文件包含明文凭据，请妥善保管，仅分享给可信接收方。</p>
        </div>
      </section>
      <div class="config-form-footer"><button class="button" type="button" data-action="back-overview">取消</button><button class="button button-primary" type="submit">下载线路文件</button></div>
    </form>`;
}

function renderCableImport() {
  const preview = state.transfer.preview;
  return `
    <button class="text-button" data-action="back-overview">返回列表</button>
    <form id="cable-import-form" class="config-form panel">
      <section class="config-section" aria-labelledby="cable-import-selection">
        <h2 id="cable-import-selection">${preview ? "确认线路" : "选择线路文件"}</h2>
        <div class="transfer-fields">
          <p class="muted">${CABLE_TRANSFER_NOTICE}</p>
          ${preview ? `<p>共 ${preview.cables.length} 条线路。同名线路请选择更新已有线路或创建新线路；未使用文件凭据时，更新保留已有密钥，新建线路需填写凭据。客户端文件需按需重新应用。</p>
        ${preview.hasCredentials ? `<label class="checkbox-field"><input type="checkbox" name="useImportedCredentials" checked /><span>使用线路文件中的认证凭据</span></label><p class="muted">勾选时文件中的凭据优先于已有凭据；取消勾选时忽略文件中的密钥和 URL 认证信息。</p>` : ""}
        <div class="transfer-selection">${preview.cables.map(cable => cable.conflict
          ? `<label class="field"><span>${esc(cable.sourceName)} · ${esc(targetLabel(cable.target))}（与「${esc(cable.existingName || cable.sourceName)}」同名）</span>
            <select name="choice:${esc(cable.sourceId)}" required><option value="">请选择处理方式</option><option value="update">更新已有线路</option><option value="create">创建新线路（${esc(cable.name)}）</option></select></label>`
          : `<p>${esc(cable.name)} · ${esc(targetLabel(cable.target))} · 新建线路</p>`).join("")}</div>
        ${(preview.warnings || []).map(w => `<p class="muted">${esc(w.message)}</p>`).join("")}`
      : `<label class="field"><span>线路文件（JSON）</span><input type="file" name="bundle" accept=".json,application/json" required /></label>`}
        </div>
      </section>
      <div class="config-form-footer">
        <button class="button" type="button" data-action="back-overview">取消</button>
        ${preview ? `<button class="button" type="button" data-action="import-cables">重新选择文件</button><button class="button button-primary" type="submit">确认导入</button>`
          : `<button class="button button-primary" type="submit">预览导入</button>`}
      </div>
    </form>`;
}

async function exportCables(data) {
  const cableIds = data.getAll("cableIds");
  if (!cableIds.length) throw new Error("请至少选择一条线路。");
  const includeCredentials = data.get("includeCredentials") === "on";
  const bundle = await api("/cables/export", { method: "POST", body: JSON.stringify({ cableIds, includeCredentials }) });
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2) + "\n"], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `cabletidy-cables-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已导出 ${cableIds.length} 条线路${includeCredentials ? "，包含明文认证凭据，请妥善保管。" : "，不包含认证凭据。"}`);
}

async function importCables(data) {
  if (!state.transfer.preview) {
    const file = data.get("bundle");
    if (!file?.size) throw new Error("请选择线路文件。");
    if (file.size > 8 * 1024 * 1024) throw new Error("线路文件不能超过 8 MiB。");
    let bundle;
    try { bundle = JSON.parse(await file.text()); }
    catch { throw new Error("线路文件不是有效的 JSON。"); }
    const preview = await api("/cables/import", { method: "POST", body: JSON.stringify({ bundle, preview: true }) });
    state.transfer.bundle = bundle;
    state.transfer.preview = preview;
    render();
    return;
  }
  const choices = {};
  for (const cable of state.transfer.preview.cables) {
    if (!cable.conflict) continue;
    const choice = data.get(`choice:${cable.sourceId}`);
    if (!["update", "create"].includes(choice)) throw new Error("请选择每条同名线路的处理方式。");
    choices[cable.sourceId] = choice;
  }
  const result = await api("/cables/import", { method: "POST", body: JSON.stringify({
    bundle: state.transfer.bundle, baseRevision: state.transfer.preview.baseRevision,
    choices,
    useImportedCredentials: state.transfer.preview.hasCredentials && data.get("useImportedCredentials") === "on",
  }) });
  state.config = result.config;
  state.candidate = clone(result.config);
  state.runtime = result.runtime;
  state.transfer = { bundle: null, preview: null };
  state.page = "overview";
  render();
  toast("配置已导入。请为未配置凭据的上游填写认证信息，再按需应用到客户端。");
}

function cableModelEditor(cable, modelId, profile, upstreamId) {
  const model = profile || {};
  const isCodex = cable.target === "codex";
  const expanded = isCodex && (model.codex?.metadataMode === "override" || Boolean(model.compact)
    || (!model.codex && Boolean(model.contextWindow)));
  return `
    <article class="cable-model-card" data-cable-model data-model-id="${esc(modelId)}">
      <div class="cable-model-mapping">
        ${isCodex
          ? officialModelSelect("data-cable-model-client", modelId || "")
          : cable.target === "claude-code"
            ? claudeModelInput("data-cable-model-client", modelId)
            : `<label class="field"><span>客户端模型 ID</span><input data-cable-model-client value="${esc(modelId)}" placeholder="客户端模型 ID" required /></label>`}
        <span class="cable-mapping-arrow" aria-hidden="true">&rarr;</span>
        ${upstreamId
          ? `<label class="field"><span>上游模型 ID（可选）</span><input data-cable-model-upstream="${esc(upstreamId)}" value="${esc(model.upstreamModelId || "")}" placeholder="留空使用请求中的模型名" /></label>`
          : `<div class="notice warning">请先配置上游连接</div>`}
        <button class="mini-button" type="button" data-action="remove-cable-model" aria-label="移除模型 ${esc(modelId || "映射")}">移除</button>
      </div>
      ${model.aliases?.length ? `<label class="field"><span>额外请求别名（可选）</span><input data-cable-model-aliases value="${esc(model.aliases.join(", "))}" placeholder="多个别名用逗号分隔" /></label>` : ""}
      ${cable.target === "claude-code" ? "" : `<details class="cable-model-settings" ${expanded ? "open" : ""}>
        <summary><span>${isCodex ? "模型能力与上下文" : "模型能力"}</span><span class="field-hint" data-model-policy-summary>${isCodex ? model.codex?.metadataMode === "override" ? "覆盖上游限制" : "沿用官方定义" : "自定义设置"}</span></summary>
        <div class="form-grid cable-model-policy">
          ${isCodex ? codexMetadataFields(model, modelId) : `
          <label class="field full"><span>Capabilities</span><input data-cable-model-capabilities-common value="${esc((model.capabilities || ["streaming", "tools", "reasoning"]).join(", "))}" placeholder="streaming, tools, reasoning" /></label>
          ${upstreamId ? `<label class="field"><span>上游能力覆盖</span><input data-cable-model-capabilities="${esc(upstreamId)}" value="${esc((model.capabilityOverrides || []).join(", "))}" placeholder="可留空" /></label>` : ""}
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
    <label class="field"><span>上下文窗口</span><input data-cable-model-context type="number" min="1" max="${esc(definition?.maxContextWindow || "")}" value="${esc(override ? model.contextWindow ?? "" : definition?.contextWindow ?? "")}" placeholder="沿用官方" ${override ? "" : "disabled"} /></label>
    <label class="field checkbox-field"><span><input data-codex-vision type="checkbox" ${vision ? "checked" : ""} ${override && definition?.inputModalities.includes("image") ? "" : "disabled"} /> 图片输入</span></label>
    <div class="field"><label>基础提示词</label><span class="field-hint" data-codex-instructions>${esc(definition?.name || "待选择官方模型")} / 官方定义</span></div>
    ${!model.codex && (model.contextWindow || model.compact) ? `<div class="notice warning full">旧策略尚未同步：context window ${esc(model.contextWindow || "未设置")}；compact ${esc(model.compact?.strategy || "未设置")} ${esc(model.compact?.tokenLimit || "")}。Compact 仍由 Codex 管理。</div>` : model.compact ? `<div class="field full"><span class="field-hint">旧 Compact 策略已保留，未同步到 Codex</span></div>` : ""}
  `;
}

function syncCodexMetadata(row, resetOverrides = false) {
  if (!row || !row.querySelector("[data-codex-metadata-mode]")) return;
  const definition = officialModel(row.querySelector("[data-cable-model-client]").value);
  const override = row.querySelector("[data-codex-metadata-mode]").value === "override";
  const context = row.querySelector("[data-cable-model-context]");
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
  if (event.target.matches('#audit-settings-form input[type="checkbox"]')) {
    syncAuditSettingsForm(event.target.closest("form"));
  }
  if (event.target.matches('#protection-settings-form input[type="checkbox"]')) {
    const form = event.target.closest("form");
    const lines = [...form.querySelectorAll("[data-protection-cable]")];
    if ("protectionAll" in event.target.dataset) {
      lines.forEach(input => { input.checked = event.target.checked; });
    } else if ("protectionCable" in event.target.dataset) {
      // Multiple cables can share one provider and therefore one protection setting.
      lines.filter(input => input.dataset.protectionProvider === event.target.dataset.protectionProvider)
        .forEach(input => { input.checked = event.target.checked; });
    }
    syncProtectionSettingsForm(form);
  }
  if (event.target.matches('#protection-settings-form [name="mappingTtlUnit"]')) {
    const unit = event.target;
    const form = unit.closest("form");
    const input = form.querySelector('[name="mappingTtlValue"]');
    const previous = protectionTtlUnits.get(unit) || "hours";
    if (input.value !== "") input.value = String(protectionTtlSeconds(input.value, previous) / PROTECTION_TTL_UNITS[unit.value]);
    syncProtectionSettingsForm(form);
  }
  if (event.target.matches('#cable-create-form [name="target"]')) {
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
    syncCodexMetadata(event.target.closest("[data-cable-model]"), modelChanged);
  }
});

pageContent.addEventListener("toggle", (event) => {
  const panel = event.target;
  if (!pageContent.contains(panel)) return;
  const record = state.security.detail;
  if (record && panel.matches("[data-content-index]")) {
    (record.contentOpen ||= {})[`${panel.dataset.contentResponse}:${panel.dataset.contentIndex}`] = panel.open;
  }
  if (record && panel.matches("[data-protection-history]")) record.protectionHistoryOpen = panel.open;
  if (record && panel.matches("[data-protection-mapping]")) (record.protectionOpen ||= {})[panel.dataset.protectionMapping] = panel.open;
  if (record && panel.matches("[data-history-risks]")) record.historyRisksOpen = panel.open;
  if (record && panel.matches("[data-history-start]")) {
    const range = (record.historyRanges ||= {})[panel.dataset.historyStart] ||= {};
    range.open = panel.open;
    if (panel.open && !range.page && !range.loading && !range.error) loadHistoryRange(Number(panel.dataset.historyStart), Number(panel.dataset.historyEnd));
  }
  if (!panel.open) return;
  // Rendering an already-selected panel also fires toggle; preserve its page and risk selection.
  if (panel.matches("[data-security-snapshot]") && panel.dataset.securitySnapshot !== state.security.bodySelection?.snapshotId) {
    securityAction("security-body", { dataset: { id: panel.dataset.securitySnapshot } });
  } else if (panel.matches("[data-security-event]")) {
    securityAction("security-event", { dataset: { id: panel.dataset.securityEvent } });
  }
}, true);

pageContent.addEventListener("input", (event) => {
  if (event.target.matches('#protection-settings-form [name="mappingTtlValue"]')) {
    syncProtectionTtlForm(event.target.closest("form"));
  }
  if (event.target.matches("#audit-settings-form input")) {
    syncAuditSettingsForm(event.target.closest("form"));
  }
  if (event.target.matches('#cable-create-form [data-create-field="clientModelId"]')) {
    syncClaudeCreateModels(event.target.closest("form"));
  }
});

pageContent.addEventListener("invalid", (event) => {
  // Reveal invalid controls before the browser tries to focus them.
  const settings = event.target.closest(".cable-model-settings");
  if (settings) settings.open = true;
}, true);

function modelPolicy(row) {
  const value = String(row?.querySelector("[data-cable-model-context]")?.value || "").trim();
  return {
    metadataMode: row?.querySelector("[data-codex-metadata-mode]")?.value || "official",
    contextWindow: value ? Number(value) : null,
    vision: row?.querySelector("[data-codex-vision]")?.checked === true,
  };
}

function renderCableDetail() {
  const cable = selectedCable();
  if (!cable) {
    return `
      <div class="panel empty-state-panel">
        <div class="empty"><strong>线路不存在</strong><div class="form-actions"><button class="button" data-action="back-overview">返回列表</button></div></div>
      </div>
    `;
  }
  const providerStatus = cableProviderStatus(cable);
  if (cable.record.managedModels) return renderInventoryCable(cable);
  const upstreamId = cable.upstreamId || "";
  const upstream = upstreamId ? state.candidate.upstreams[upstreamId] : null;
  const record = cable.record;
  const provider = cable.virtualProvider;
  return `
    <div class="cable-toolbar">
      <button class="text-button" data-action="back-overview">返回列表</button>
      <div class="cable-status"><span>${esc(targetLabel(record.target))} · ${cable.models.length ? `${cable.models.length} 项模型设置` : "模型名直接透传"}</span><span class="status-badge ${providerStatus.className}">${esc(providerStatus.label)}</span><button class="button button-danger" type="button" data-action="delete-cable" data-id="${esc(cable.id)}">删除线路</button></div>
    </div>
    <div class="panel cable-editor">
      <section class="cable-section" aria-labelledby="cable-upstream-title">
        <div class="cable-section-heading">
          <h2 id="cable-upstream-title">上游连接</h2>
          <p>此线路的所有模型共用这一上游。</p>
          ${cable.target === "codex" ? `<button class="button" type="button" data-action="migrate-cable" data-id="${esc(cable.id)}">迁移到供应商模型目录</button>` : ""}
        </div>
        ${upstream ? `
          <form id="cable-upstream-form">
            <input type="hidden" name="id" value="${esc(upstreamId)}" />
            <input type="hidden" name="protocol" value="${esc(upstream.protocol || "openai.responses")}" />
            <div class="form-grid cable-upstream-fields">
              ${field("上游名称", "name", upstream.name || upstreamId, "例如 Relay A")}
              ${field("上游地址", "baseUrl", upstream.baseUrl || "", "https://relay.example.com/v1", false, "url")}
              ${field(cable.target === "claude-code" ? "上游凭据" : "API Key", "secret", "", upstream.secretConfigured ? "已配置，留空保留现有密钥" : "粘贴上游凭据", false, "password")}
              ${cable.target === "claude-code" ? upstreamAuthField("authHeader", upstream.auth?.header || upstream.authHeader || "x-api-key") : ""}
            </div>
            <div class="cable-section-footer">
              <span class="field-hint">保存后生效，测试使用已保存的连接。</span>
              <div class="form-actions"><button class="button" type="submit">保存上游</button><button class="button" type="button" data-action="test-upstream" data-id="${esc(upstreamId)}">测试连通性</button></div>
            </div>
          </form>
        ` : `<div class="empty"><strong>未配置上游</strong></div>`}
      </section>
      <section class="cable-section" aria-labelledby="cable-models-title">
        <div class="cable-section-heading cable-models-heading">
          <div><h2 id="cable-models-title">模型设置（可选）</h2><p>${cable.target === "claude-code" ? "默认透传模型名；改名时填写 Claude Code 请求中的完整模型 ID。模型能力、上下文和压缩由客户端与上游决定。" : cable.target === "generic-env" ? "默认透传请求中的模型名；需要改名或限制能力时再添加设置。" : "默认透传请求中的模型名；需要改名或覆盖上下文等参数时再添加设置。"}</p></div>
          <button class="button" type="button" data-action="add-cable-model">添加模型设置</button>
        </div>
        ${cable.target === "codex" ? codexCatalogStatus() : ""}
        ${cable.target === "claude-code" ? claudeModelSuggestions() : ""}
        <form id="cable-models-form" data-cable-context="${esc(JSON.stringify([cable.id, cable.target, record.virtualProvider, cable.route?.id, upstreamId]))}">
          <div id="cable-model-list" class="cable-model-list">
            ${cable.models.length
              ? cable.models.map(({ id, profile }) => cableModelEditor(cable, id, profile, upstreamId)).join("")
              : `<div class="empty">已启用模型名直接透传，无需添加模型设置。</div>`}
          </div>
          <div class="cable-section-footer">
            <span class="field-hint">${cable.target === "claude-code" || cable.target === "generic-env" ? "上游模型 ID 留空时原样透传。" : "按需展开模型能力与上下文设置。"}</span>
            <div class="form-actions">
              <button class="button" type="submit">保存模型设置</button>
              ${cable.target === "generic-env" ? `<button class="button" type="button" data-action="open-advanced-models">高级模型设置</button>` : ""}
            </div>
          </div>
        </form>
      </section>
      ${cable.target === "claude-code" ? claudeClientForm(cable) : ""}
    </div>
    <section class="panel cable-connection" aria-labelledby="cable-connection-title">
      <div class="panel-header">
        <h2 id="cable-connection-title">${esc(targetLabel(record.target))} 接入</h2>
        <div class="cable-connection-actions">
          <button class="button button-quiet" type="button" data-action="toggle-vp" data-id="${esc(provider.id)}">${provider.enabled === false ? "启动服务" : "暂停服务"}</button>
          <button class="button" type="button" data-action="preview-artifacts">预览配置</button>
          ${["codex", "claude-code"].includes(record.target) ? `<button class="button button-primary" type="button" data-action="apply-target">应用到 ${esc(targetLabel(record.target))}</button>` : ""}
          ${record.target === "claude-code" ? `<button class="button" type="button" data-action="restore-target">撤销接入</button>` : ""}
        </div>
      </div>
      <div class="panel-body">
        <dl class="cable-connection-facts">
          <div><dt>本地地址</dt><dd class="mono">${esc(cableEndpoint(cable))}</dd></div>
          <div><dt>Virtual Provider ID</dt><dd class="mono">${esc(record.virtualProvider)}</dd></div>
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

function claudeDefaultModel(cable) {
  if (cable.record.claude?.setModel === false) return "";
  return cable.record.defaultModel || cable.virtualProvider.defaultModel || "";
}

function claudeModelInput(attributes, value) {
  return `<label class="field"><span>客户端模型 ID</span><input ${attributes} list="claude-model-suggestions" value="${esc(value)}" placeholder="搜索官方建议或手动填写" autocomplete="off" required /></label>`;
}

function claudeModelSuggestions() {
  return `<p class="field-hint">官方建议来自 <a href="${esc(CLAUDE_MODEL_CATALOG.sources[0])}" target="_blank" rel="noreferrer">Anthropic 文档</a>（${esc(CLAUDE_MODEL_CATALOG.updatedAt)}），随 CableTidy 发版更新，无需额外 API Key；可手动填写其他模型 ID。</p>
    <datalist id="claude-model-suggestions">${CLAUDE_MODEL_CATALOG.models.map((id) => `<option value="${esc(id)}"></option>`).join("")}</datalist>`;
}

function claudeAliasSelect(cable, family) {
  const selected = cable?.record.claude?.models?.[family] || "";
  const ids = (cable?.models || []).map(({ id }) => id);
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
  return state.claudeAliases[name].includes(selected) || ids.includes(selected) ? selected : "";
}

function claudeDefaultModelOptions(name, ids, value = "") {
  const selected = claudeModelChoice(name, ids, value);
  const aliases = state.claudeAliases[name];
  const clientIds = [...new Set(ids)].filter((id) => !aliases.includes(id));
  return `<optgroup label="默认行为"><option value="" ${selected ? "" : "selected"}>${name === "defaultModel" ? "由 Claude 默认决定" : "沿用 Claude 默认行为"}</option></optgroup>
    <optgroup label="模型别名">${optionList(aliases, selected)}</optgroup>
    ${clientIds.length ? `<optgroup label="当前线路的客户端模型 ID">${optionList(clientIds, selected)}</optgroup>` : ""}`;
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

function claudeModelGroups(cable = null) {
  const ids = (cable?.models || []).map(({ id }) => id);
  return `<section class="subsection" aria-labelledby="claude-aliases-title">
        <div class="subsection-header"><h3 id="claude-aliases-title">模型别名</h3></div>
        <p class="field-hint">${cable ? "从当前线路已保存的" : "可选。从本次填写的"}客户端模型 ID 中选择，或由 Claude 默认决定。</p>
        <div class="form-grid">
          ${state.claudeAliases.families.map((family) => claudeAliasSelect(cable, family)).join("")}
        </div>
      </section>
      <section class="subsection" aria-labelledby="claude-defaults-title">
        <div class="subsection-header"><h3 id="claude-defaults-title">默认模型</h3></div>
        <div class="form-grid">
          ${claudeDefaultModelSelect("defaultModel", ids, cable ? claudeDefaultModel(cable) : "")}
          ${claudeDefaultModelSelect("subagent", ids, cable?.record.claude?.models?.subagent || "")}
        </div>
        <p class="field-hint">可选。选择适用的官方别名或当前线路的客户端模型 ID；默认行为不主动覆盖 Claude 的模型选择。</p>
      </section>`;
}

function claudeClientForm(cable) {
  const options = cable.record.claude || {};
  return `<section class="cable-section">
    <div class="cable-section-heading"><h2>Claude Code 模型选择</h2><p>设置模型别名和默认模型。上游改名在模型设置中配置。</p></div>
    <form id="claude-client-form" data-cable-context="${esc(JSON.stringify([cable.id, cable.models.map(({ id }) => id)]))}">
      ${claudeModelGroups(cable)}
      <div class="form-actions">
        ${checkboxField("在 /model 中发现此线路的模型", "discoverModels", options.discoverModels === true)}
      </div>
      <p class="field-hint">模型发现只列出已配置模型，不限制其他模型请求。Claude Code 可能过滤不含 claude 或 anthropic 的模型 ID。保存后需重新应用客户端配置。</p>
      <div class="form-actions"><button class="button" type="submit">保存模型选择</button></div>
    </form>
  </section>`;
}

function renderCableCreate() {
  return `
    <button class="text-button" data-action="back-overview">返回列表</button>
    <form id="cable-create-form" class="config-form panel">
      <section class="config-section" aria-labelledby="config-basics">
        <h2 id="config-basics">基本信息</h2>
        <div class="form-grid">
          ${field("线路名称（可选）", "cableName", "", "例如 my-relay；留空自动生成")}
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
        <button class="button button-primary" type="submit">创建线路</button>
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

function renderModels() {
  const selectedId = state.selected.model;
  const cable = selectedCable();
  if (!cable) return `<div class="empty">请先选择配置</div>`;
  const models = cable.virtualProvider.models || {};
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
          <form id="model-form" data-cable-context="${esc(JSON.stringify([cable.id, selectedId, cable.upstreamId]))}">
            <div class="form-grid">
              ${field("Client model ID", "clientModelId", selectedId || "", "客户端请求里的 model")}
              ${field("Aliases", "aliases", (selected?.aliases || []).join(", "), "son, codex-default")}
              ${field("Family", "family", selected?.family || "codex", "codex")}
              ${field("Capabilities", "capabilities", (selected?.capabilities || ["streaming", "tools", "reasoning"]).join(", "), "streaming, tools, reasoning", true)}
            </div>
            <div class="subsection">
              <div class="subsection-header"><h3>上游模型映射</h3></div>
              <div class="form-grid">
                <div class="field"><span>上游</span><span>${esc(cable.upstream?.name || cable.upstreamId)}</span></div>
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
  inspection: { pending: "等待检测", running: "检测进行中", failed: "检测失败", complete: "已完成支持范围内检查", limited: "已检查（覆盖有限）", partial: "检测不完整", skipped: "仅操作审计" },
  outcome: { started: "请求已接收", streaming: "响应接收中", completed: "已完成", local_error: "本地处理失败", upstream_error: "上游返回错误", connection_error: "上游连接失败", stream_error: "响应流错误", interrupted: "请求中断", unknown: "结果未知" },
  kind: { request: "模型请求", system: "审计状态" },
  action: { "model.request": "模型请求", "tokens.count": "Token 计数", "audit.gap": "审计记录缺口" },
  basis: { system_wide_damage_possible: "显式关闭根目录保护，可能造成系统范围的数据破坏", credential_exposure_possible: "凭据可能暴露在模型内容或联网操作中", working_data_loss_possible: "操作可能丢弃工作区数据或影响较大目录范围", broad_write_access_possible: "操作可能向所有用户开放写权限", unreviewed_remote_code_execution: "远程内容直接进入代码解释器", sensitive_goal_redirection_possible: "外部指令试图将原任务引向敏感操作", scoped_sensitive_operation: "涉及有限范围的数据修改、敏感读取或权限变更", known_credential_match: "内容与本地已知凭据匹配", credential_pattern_match: "匹配凭据特征，尚未验证其有效性", credential_value_context: "值处于明确的认证字段或凭据字面量中，未验证其有效性", credential_format_evidence: "匹配已支持的凭据格式或私钥封装，未验证其有效性", credential_candidate_unverified: "仅发现疑似凭据，证据不足，尚未确认是凭据值", heuristic_keyword_combination: "命中指令覆盖与敏感动作的启发式组合", network_sensitive_file_reference: "联网命令引用敏感文件，未确认实际发送", recognized_literal_tool_arguments: "已识别的工具参数或字面量命令结构", internal_endpoint_pattern_match: "内容包含内网地址、端口或 URL 用户名", public_endpoint_pattern_match: "内容包含公网服务器地址,泄露后可被直接访问" },
  rule: { "SEC-SECRET-001": "内容中发现凭据特征", "SEC-READ-001": "读取敏感文件", "SEC-DELETE-001": "递归删除目录", "SEC-DELETE-002": "补丁删除文件", "SEC-VCS-001": "丢弃工作区修改", "SEC-CONFIG-001": "修改代理或安全配置", "SEC-PRIV-001": "请求提升执行权限", "SEC-PRIV-002": "授予所有用户写权限", "SEC-EXEC-001": "下载内容直接交给解释器执行", "SEC-EXEC-002": "动态代码执行", "SEC-EXPORT-001": "联网命令引用敏感文件", "SEC-INJECT-001": "外部内容要求改写目标并执行敏感操作", "SEC-INTERNAL-001": "内网地址或身份标识", "SEC-ENDPOINT-001": "公网服务器地址暴露" },
  reason: { inspection_coverage_unknown: "旧记录未保存检查覆盖依据", header_storage_or_processing_failure: "请求或响应头保存失败", invalid_json_or_structure_budget: "JSON 不完整或超出解析栈预算，仅保留已解析的前缀", evidence_storage_unavailable: "检测快照写入失败", audit_metadata_budget: "审计元数据写入有缺口", redaction_buffer_budget: "凭据检测工作区不足，或长 URL 认证区、令牌前缀无法确认", invalid_sse_event: "流式事件无法解析，仅按文本检查", shared_encrypted_spool_budget: "共享临时空间或内存不足，正文保留有缺口", shared_working_memory_budget: "共享内存不足，部分工具参数无法完整解析", shared_detection_budget: "共享检测资源不足，风险发现可能不完整", credential_redaction_budget: "凭据匹配资源不足，检测可能不完整", body_storage_or_processing_failure: "正文存储或处理失败", body_not_complete: "正文接收未完成", unstructured_content: "非结构化或无效 JSON，仅完成文本规则检查", non_text_or_reasoning_semantics: "非文本或推理内容的语义不在规则覆盖范围", inspection_worker_failed: "检测任务失败", incomplete_body_fragment: "正文末尾不完整", incomplete_stream_fragment: "流式内容未结束，部分片段无法完整检查", stream_item_metadata_missing: "流式条目缺少工具类型或名称", credential_catalog_limit: "部分本地凭据超出支持的数量或长度范围", concurrent_inspection_limit: "并发检查数量达到上限", request_inspection_limit: "请求内容检查达到上限", response_inspection_limit: "响应内容检查达到上限", sse_event_limit: "流式事件过大", tool_argument_limit: "工具参数过大", finding_limit: "单次请求风险数量达到上限", unsupported_tool: "工具语义暂不支持", unsupported_tool_arguments: "工具参数结构暂不支持", unsupported_shell_syntax: "命令包含暂不解析的展开或复合语法", unsupported_shell_wrapper: "命令包装方式暂不支持", shell_nesting_limit: "嵌套命令达到检查上限", external_script_not_inspected: "无法观察脚本文件内容", command_semantics_not_inspected: "命令语义未覆盖", dynamic_code_not_inspected: "动态代码内容未检查", non_text_content: "包含非文本内容", opaque_content: "包含不透明或加密内容", reasoning_content_not_inspected: "推理文本已做凭据检查，推理语义未覆盖", unsupported_response_event: "包含未知响应事件，部分语义未覆盖", unsupported_response_item: "包含未知响应项", invalid_response_json: "响应无法解析为 JSON", invalid_event_json: "流式事件 JSON 无效", invalid_event_encoding: "流式事件编码无效", unterminated_sse_event: "流式事件未完整结束", missing_terminal_event: "未观察到协议结束事件", incomplete_response_item: "响应项尚未完整返回", missing_tool_start: "缺少工具调用开始事件", invalid_tool_arguments: "工具参数无法解析", response_item_limit: "响应项数量达到上限", text_item_limit: "文本项达到检查上限", response_not_complete: "响应未完整接收", request_not_inspected: "请求未进入内容检查", request_interrupted: "请求在响应前中断", daemon_restarted: "上次进程未记录请求结束", historical_context_not_visible: "引用的历史上下文未经过本次请求" },
};

function securityLabel(group, value) { return SECURITY_LABELS[group]?.[value] || value || "未知"; }
function securityTime(value) { return value ? new Date(value).toLocaleString(undefined, { hourCycle: "h23", timeZoneName: "short" }) : "尚无记录"; }
function securityInspectionLabel(record, state = record.inspectionStatus) {
  return state === "failed" && record.inspectionProgress?.active
    ? "部分步骤失败，仍在检测" : securityLabel("inspection", state);
}
function renderSecurityCoverage(record) {
  const limits = record.coverageLimitations || (record.inspectionStatus === "limited" ? record.coverageReasons : []) || [];
  const issues = record.inspectionIssues || (record.inspectionStatus !== "limited" ? record.coverageReasons : []) || [];
  return `${issues.length ? `<p class="notice warning">检查缺口：${issues.map(reason => esc(securityLabel("reason", reason))).join("；")}</p>` : ""}
    ${limits.length ? `<p class="notice">覆盖范围限制：${limits.map(reason => esc(securityLabel("reason", reason))).join("；")}。这些限制不表示请求中断。</p>` : ""}`;
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
  window.history.replaceState({ ...window.history.state, page: "security", list: securityListState() }, "", "#security");
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
  pushNavigation({ page: "security", list: securityListState() }, "#security");
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
  state.page = window.location.hash === "#settings" ? "settings"
    : PAGE_META[navigation?.page] && !navigation.page.startsWith("security") ? navigation.page : "overview";
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
  const risks = securityRiskCounts(s.result || {});
  const storage = s.result?.storage || s.status?.storage || state.runtime?.security?.storage;
  const ready = storage?.state === "ready";
  const providers = [...new Set([...Object.keys(state.config?.virtualProviders || {}), ...(s.result?.providers || [])])];
  return `
    <div class="security-heading"><div><span class="status-badge">仅记录</span><p class="muted">按会话回看模型交互，沿轨迹定位风险与原文。工具调用提议不代表真实执行。</p></div>

    </div>
    <div class="notice ${ready ? "" : "warning"}" role="status">
      ${ready ? "审计存储正常" : storage?.state === "degraded" ? "审计有记录缺口" : "审计存储尚未就绪或暂不可用"}
      <span class="muted">最近写入：${esc(securityTime(storage?.lastWrittenAt))} · ${auditRetentionLabel(storage?.retentionDays === undefined ? state.config.audit.retentionDays : storage.retentionDays)} · 已用 ${esc(((storage?.bytes || 0) / 1048576).toFixed(1))} MiB · ${auditStorageLabel(storage?.budgetBytes === undefined ? state.config.audit.budgetBytes : storage.budgetBytes)}</span>
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
    <div class="security-summary" aria-live="polite"><div><strong>${esc(s.result?.total ?? "—")}</strong><span>个会话 / 独立记录</span></div><div><strong>${esc(s.result?.recordCount ?? "—")}</strong><span>条审计记录</span></div><div><strong>${esc(s.result?.riskSessionCount ?? "—")}</strong><span>个会话有风险</span></div><div><strong>${esc(s.result ? risks.new + risks.legacy : "—")}</strong><span>项${risks.legacy || !(risks.new || risks.historical) ? "" : "新增"}风险</span></div></div>
    <p class="muted">筛选命中会话后，统计与轨迹保留该会话的全部已保留记录。没有会话标识的 Agent 请求作为独立记录展示。</p>
    <section class="panel"><div class="panel-header"><h2>会话记录</h2><span class="muted">${s.loading ? "读取中…" : `更新于 ${esc(securityTime(s.updatedAt))}`}</span></div>
      ${s.result?.items?.length ? `<div class="security-sessions">${s.result.items.map(securitySessionRow).join("")}</div>` : `<div class="empty" role="status">${s.loading ? "正在读取会话…" : s.error ? "暂时无法读取记录。" : "当前筛选范围内没有审计记录。通过此代理发起请求后可在这里查看。"}</div>`}
      <div class="panel-body security-pagination"><button class="button" data-action="security-prev" ${!s.history.length || s.loading ? "disabled" : ""}>上一页</button><span class="muted">第 ${s.history.length + 1} 页 · 每页 50 个会话 / 独立记录</span><button class="button" data-action="security-next" ${!s.result?.nextCursor || s.loading ? "disabled" : ""}>下一页</button></div>
    </section>
    <p class="muted">检查范围：已知凭据特征、已支持工具的参数与字面量命令、外部内容中的指令操纵线索。动态脚本、未知工具等显示为覆盖范围限制；正文缺失或资源不足导致未完成检查时显示检测不完整。${s.result?.oldestAtMs ? `最早保留记录：${esc(securityTime(s.result.oldestAtMs))}。` : ""}</p>
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

function securityHasRiskHistory(item) {
  if (item.legacyFindingCount != null) return true;
  return item.schemaVersion != null ? item.schemaVersion >= 5 : item.newFindingCount != null || item.historicalFindingCount != null;
}

function securityRiskCounts(item) {
  if (!securityHasRiskHistory(item)) return { legacy: item.findingCount ?? 0, new: 0, historical: 0 };
  return { legacy: item.legacyFindingCount ?? 0, new: item.newFindingCount ?? item.findingCount ?? 0, historical: item.historicalFindingCount ?? 0 };
}

function securityRiskSummary(item, associations = false) {
  const counts = securityRiskCounts(item);
  const historical = associations ? `${counts.historical} 次历史关联` : `${counts.new || counts.legacy ? "" : "仅"}历史风险 ${counts.historical} 项`;
  return [
    counts.legacy ? `风险 ${counts.legacy} 项${counts.new || counts.historical ? "（旧记录）" : ""}` : "",
    counts.new ? `新增风险 ${counts.new} 项` : "",
    counts.historical ? historical : "",
  ].filter(Boolean).join(" · ") || "未发现风险";
}

function securitySessionRow(item) {
  return `<button class="security-session-row" data-action="security-session" data-id="${esc(item.id)}">
    <span class="security-session-main"><strong>${esc(securitySessionTitle(item))}</strong><span class="muted">${esc(item.providerId || "未记录配置")} · ${esc(item.target ? targetLabel(item.target) : securityLabel("kind", item.kind))} · ${item.identified ? "客户端会话" : "独立记录 · 无会话标识"}</span></span>
    <span class="security-session-count"><strong>${esc(item.requestCount || 1)} 条记录</strong><span class="muted">${item.activeCount ? `${esc(item.activeCount)} 条进行中` : item.errorCount ? `${esc(item.errorCount)} 条异常` : "已记录"}${item.incompleteCount ? ` · ${esc(item.incompleteCount)} 条待检查 / 不完整` : ""}${item.limitedCount ? ` · ${esc(item.limitedCount)} 条覆盖有限` : ""}</span></span>
    <span class="security-session-risk">${item.findingCount ? securityBadge(item.severity) : ""}<span class="muted">${esc(securityRiskSummary(item, true))}</span></span>
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

// Each request keeps its own ordinal and target in the horizontally scrollable overview.
function traceSegments(items) {
  return items.map((item, i) => {
    const risk = securityRiskCounts(item);
    return { id: item.id, order: i + 1, duration: item.durationMs || 0,
      legacyFindingCount: risk.legacy, newFindingCount: risk.new, historicalFindingCount: risk.historical, protection: item.protection,
      selected: item.id === state.security.detailId };
  });
}

function setupTraceOverview() {
  const viewport = pageContent.querySelector(".trace-map-viewport");
  if (!viewport) return;
  const rail = pageContent.querySelector(".trace-scroll-rail");
  const control = rail.querySelector(".trace-scroll-control");
  const syncScrollbar = () => {
    const maximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    rail.hidden = maximum === 0;
    control.max = maximum;
    control.value = viewport.scrollLeft;
    control.style.setProperty("--thumb-width", `${Math.max(24, rail.clientWidth * viewport.clientWidth / viewport.scrollWidth)}px`);
  };
  if (pendingTraceSelection) {
    const selected = viewport.querySelector(".trace-segment.is-selected");
    if (selected) {
      const bounds = viewport.getBoundingClientRect(), item = selected.getBoundingClientRect();
      if (item.left < bounds.left + 6) viewport.scrollLeft -= bounds.left + 6 - item.left;
      else if (item.right > bounds.right - 6) viewport.scrollLeft += item.right - bounds.right + 6;
      // Loading renders have no selected segment; consume the request only once it exists.
      pendingTraceSelection = false;
    }
  }
  control.addEventListener("input", () => { viewport.scrollLeft = Number(control.value); });
  viewport.addEventListener("scroll", syncScrollbar, { passive: true });
  traceOverviewObserver = new ResizeObserver(syncScrollbar);
  traceOverviewObserver.observe(viewport);
  syncScrollbar();
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
function retainedContentItems(record, response, visible = false) {
  const content = record[response ? "responseContent" : "requestContent"];
  const items = content?.items || [];
  if (response || !content?.nodes) return items;
  if (visible) return content.nodes.flatMap(node => node.kind === "history_range"
    ? record.historyRanges?.[node.startIndex]?.open ? (record.historyRanges[node.startIndex].page?.items || []).filter(item => item.index >= node.startIndex && item.index <= node.endIndex) : []
    : items.filter(item => item.index === node.index));
  const loaded = [...items, ...Object.values(record.historyRanges || {}).flatMap(range => range.page?.items || [])];
  return [...new Map(loaded.map(item => [item.index,item])).values()];
}
function retainedRiskText(item, field) {
  const text = item[field] || "", ranges = [...(item.riskRanges?.[field] || []), ...(item.protectionRanges?.[field] || []).map(r => ({ ...r, findingId: `protection:${r.mappingId}` }))];
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
      const protectedHit = [...active.keys()].some(id => id?.startsWith("protection:"));
      const riskHit = [...active.keys()].some(id => !id?.startsWith("protection:"));
      html += active.size ? `<mark class="${riskHit ? "security-risk-hit" : ""}${protectedHit ? " security-protection-hit" : ""}${hit ? " security-body-hit" : ""}"${hit ? ' data-security-content-anchor tabindex="-1"' : ""}>${content}</mark>` : content;
      at = event.at;
    }
    if (event.delta) {
      const count = (active.get(event.findingId) || 0) + event.delta;
      if (count) active.set(event.findingId, count); else active.delete(event.findingId);
    }
  }
  return html;
}

async function locateContentFinding(finding) {
  const s = state.security, record = s.detail, sequence = s.detailSequence;
  const response = finding.contentSide === "response";
  const tab = response ? "response" : "request", key = response ? "responseContent" : "requestContent";
  const operation = beginContentOperation(response);
  const navigation = s.contentNavigation = { findingId: finding.id };
  state.trace.tab = tab;
  const current = () => s.detail === record && s.detailSequence === sequence && s[operation.key] === operation.token && s.contentNavigation === navigation && state.trace.tab === tab && state.page === "security-session";
  render();
  let item = retainedContentItems(record, response, true).find(item => item.findingIds?.includes(finding.id));
  try {
    if (!item) {
      const content = await api(`/security/audit/${encodeURIComponent(record.id)}/${response ? "response-content" : "content"}?${new URLSearchParams({ offset: 0, finding: finding.id, ...(!response ? { view: "all" } : {}) })}`);
      if (!current()) return;
      record[key] = content;
      item = content.items?.find(item => item.findingIds?.includes(finding.id));
    }
  } catch (error) {
    if (current()) { s[response ? "responseContentError" : "contentError"] = error.message; render(); }
    return;
  }
  if (!current()) return;
  if (!item) { s[response ? "responseContentError" : "contentError"] = "此风险没有可定位的内容项，证据可在风险详情中复核。"; render(); return; }
  navigation.index = item.index;
  (record.contentOpen ||= {})[`${response}:${item.index}`] = true;
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
    return `<details class="trace-content-item" data-content-response="${response}" data-content-index="${item.index}" ${(record.contentOpen?.[`${response}:${item.index}`] ?? true) ? "open" : ""}>
      <summary><span class="trace-content-title"><span class="trace-content-order">${item.index + 1}</span><span class="trace-content-role">${esc(label)}</span>${!response && item.historyOf ? `<span class="muted">历史</span>` : ""}${item.name ? `<strong class="mono">${esc(item.name)}</strong>` : ""}</span><button class="mini-button trace-content-source" data-action="${action}-source" data-index="${item.index}">查看此项原文</button></summary>
      <div class="trace-content-detail">${item.preview ? `<pre>${retainedRiskText(item, "preview")}</pre>` : `<p class="muted">${item.opaque ? "仅保留加密或不透明内容，没有可读文本。" : "此项未包含可读文本。"}</p>`}
      ${item.structure && item.structure !== item.preview ? `<details class="trace-content-structure"><summary>完整内容结构</summary><pre>${retainedRiskText(item, "structure")}</pre></details>` : ""}
      ${item.riskVersions?.length ? `<details class="trace-content-risk-versions" open><summary>风险检测时的内容</summary><p class="trace-content-note">此风险来自较早的流式内容或检测参数，当前内容已变化；以下保留检测时的命中内容。</p>${item.riskVersions.map(version => `${version.toolArguments ? `<p class="trace-content-note">检测时的工具参数与当前参数不同，此记录不表示最终参数仍有风险。实际执行状态未知。</p>` : ""}<pre><mark class="security-risk-hit${state.security.contentNavigation?.findingId === version.findingId ? " security-body-hit" : ""}"${state.security.contentNavigation?.findingId === version.findingId ? ' data-security-content-anchor tabindex="-1"' : ""}>${esc(version.text)}</mark></pre>`).join("")}</details>` : ""}
      ${item.riskGaps?.length ? `<p class="notice warning">此项的部分风险证据未完整保留或超出定位预算，无法定位命中点；请在风险详情中复核。</p>` : ""}
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
  const rangeRow = node => {
    const range = record.historyRanges?.[node.startIndex] || {};
    const loaded = (range.page?.items || []).filter(item => item.index >= node.startIndex && item.index <= node.endIndex);
    return `<details class="trace-content-history" data-history-start="${node.startIndex}" data-history-end="${node.endIndex}" ${range.open ? "open" : ""}>
      <summary>第 ${node.startIndex + 1}–${node.endIndex + 1} 项 · 已有历史${node.findingCount ? ` · ${node.findingCount} 项风险` : ""}</summary>
      ${loaded.map(row).join("")}
      ${range.page ? `<div class="trace-content-pagination"><button class="mini-button" data-action="security-history-page" data-start="${node.startIndex}" data-end="${node.endIndex}" data-offset="${Math.max(node.startIndex, range.page.offset - 40)}" ${range.page.offset <= node.startIndex || range.loading ? "disabled" : ""}>上一组历史</button><span>${loaded[0]?.index + 1}–${loaded.at(-1)?.index + 1}</span><button class="mini-button" data-action="security-history-page" data-start="${node.startIndex}" data-end="${node.endIndex}" data-offset="${range.page.offset + 40}" ${range.page.offset + 40 > node.endIndex || range.loading ? "disabled" : ""}>下一组历史</button></div>` : ""}
      ${range.loading ? `<p class="muted" role="status">正在加载历史…</p>` : ""}${range.error ? `<p class="notice warning" role="alert">${esc(range.error)}</p><button class="mini-button" data-action="security-history-page" data-start="${node.startIndex}" data-end="${node.endIndex}" data-offset="${node.startIndex}">重试</button>` : ""}
    </details>`;
  };
  const nodes = content.nodes || items;
  const definitions = nodes.filter(item => item.kind === "tool_definition").map(item => items.find(loaded => loaded.index === item.index) || item);
  const messages = nodes.filter(item => item.kind !== "tool_definition");
  const timeline = messages.map(item => item.kind === "history_range" ? rangeRow(item) : row(items.find(loaded => loaded.index === item.index) || item)).join("");
  return `<section class="trace-request-content" aria-label="${title}"><h3>${title} <span>${content.total} 项</span></h3>
    ${!response && content.historicalCount ? `<div class="trace-content-controls"><span>新增 ${content.newCount} 项 · 历史 ${content.historicalCount} 项</span><div class="trace-content-actions"><button class="mini-button" data-action="security-content-view" data-view="${content.view === "all" ? "folded" : "all"}" ${loading ? "disabled" : ""}>${content.view === "all" ? "折叠历史" : "展开全部"}</button><button class="mini-button" data-action="security-content-new" ${content.firstNewIndex == null || loading ? "disabled" : ""}>跳到新增</button></div></div>${content.newCount === 0 ? `<p class="muted">本次请求内容与已记录历史一致。</p>` : ""}` : ""}
    ${response && content.status ? `<p class="trace-content-note">${claude ? "结束原因" : "响应状态"}：${esc(RESPONSE_STATUS_LABELS[content.status] || content.status)}</p>` : ""}
    ${claude && !response ? `<p class="trace-content-note">按消息内容块展示；工具结果属于工具上下文，消息角色为 user 也不会计为用户输入。</p>` : ""}
    <div class="trace-content-counts" aria-label="${title}组成">${Object.entries(labels).map(([kind, label]) => `<span>${label} <strong>${counts[kind] || 0}</strong></span>`).join("")}</div>
    ${content.state !== "complete" ? `<p class="notice warning">${content.state === "unavailable" ? `${response ? "响应" : "请求"}正文未保留，无法还原内容组成。` : `${response ? "响应" : "请求"}正文存在缺口或尚未解析完整，以下为已保留的内容。`}</p>` : content.total === 0 ? `<p class="muted">${response ? "本次响应未包含输出内容。" : "本次请求未包含提示词、输入或工具上下文。"}</p>` : ""}
    ${content.protectionState === "unavailable" ? '<p class="notice warning">保护高亮暂不可用，以下仍显示保留原文；映射可在凭据保护页复核。</p>' : ""}
    <div class="trace-content-timeline">${timeline}</div>
    ${definitions.length ? `<details class="trace-content-tools"><summary>可用工具定义 · 本页 ${definitions.length} 个</summary>${definitions.map(row).join("")}</details>` : ""}
    ${content.total ? `<div class="trace-content-pagination"><button class="mini-button" data-action="${action}-page" data-offset="${Math.max(0, content.offset - 40)}" ${!content.offset || loading ? "disabled" : ""}>上一组内容</button><span>${content.offset + 1}–${content.offset + nodes.length} / ${content.nodeTotal ?? content.total}</span><button class="mini-button" data-action="${action}-page" data-offset="${content.nextOffset ?? ""}" ${content.nextOffset == null || loading ? "disabled" : ""}>下一组内容</button></div>` : ""}
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
async function loadRetainedContent(offset, response, view) {
  const loadingKey = response ? "responseContentLoading" : "contentLoading";
  const errorKey = response ? "responseContentError" : "contentError";
  const s = state.security, record = s.detail, sequence = s.detailSequence;
  if (!record || s[loadingKey]) return;
  const operation = beginContentOperation(response);
  const current = () => record === s.detail && sequence === s.detailSequence && s[operation.key] === operation.token && securityDetailVisible();
  s[loadingKey] = true; s[errorKey] = null; render();
  try {
    const content = await api(`/security/audit/${encodeURIComponent(record.id)}/${response ? "response-content" : "content"}?${new URLSearchParams({ offset, ...(!response ? { view: view || record.requestContent?.view || "folded" } : {}) })}`);
    if (!current()) return;
    record[response ? "responseContent" : "requestContent"] = content;
  } catch (error) {
    if (!current()) return;
    s[errorKey] = error.message;
  }
  if (current()) { s[loadingKey] = false; render(); }
}


async function loadHistoryRange(start, end, offset = start) {
  const s = state.security, record = s.detail, sequence = s.detailSequence;
  const content = record?.requestContent;
  if (!content) return;
  const operation = { key: "requestContentOperation", token: s.requestContentOperation };
  const range = (record.historyRanges ||= {})[start] ||= {};
  if (range.loading && range.operation === operation.token) return;
  range.operation = operation.token;
  range.open = true; range.loading = true; range.error = null; render();
  const current = () => record === s.detail && sequence === s.detailSequence && record.requestContent === content
    && s[operation.key] === operation.token && record.historyRanges[start] === range && securityDetailVisible();
  try {
    const page = await api(`/security/audit/${encodeURIComponent(record.id)}/content?${new URLSearchParams({ offset, view: "all" })}`);
    if (!current()) return;
    range.page = page;
    const loaded = (page.items || []).filter(item => item.index >= start && item.index <= end);
    const byIndex = new Map((content.items || []).map(item => [item.index,item]));
    for (const item of loaded) byIndex.set(item.index,item);
    content.items = [...byIndex.values()];
  } catch (error) { if (current()) range.error = error.message; }
  finally { if (range.operation === operation.token) range.loading = false; }
  if (current()) render();
}

function protectionOccurred(record) { return (record.protection?.requestCount || 0) + (record.protection?.responseCount || 0) > 0; }
function protectionKeyIcon() { return '<svg class="protection-key" viewBox="0 0 14 24" aria-hidden="true"><circle cx="7" cy="5" r="3.5"/><path d="M7 8.5V22M7 15h4M7 19h4"/></svg>'; }
function protectionCredentials(report) {
  const grouped = new Map();
  for (const mapping of report?.mappings || []) {
    const existing = grouped.get(mapping.original);
    if (existing) {
      existing.requestCount += mapping.requestCount || 0;
      existing.responseCount += mapping.responseCount || 0;
      existing.reused &&= !!mapping.reused;
      existing.mappings.push(mapping);
    } else grouped.set(mapping.original, { ...mapping, requestCount: mapping.requestCount || 0, responseCount: mapping.responseCount || 0, mappings: [mapping] });
  }
  return [...grouped.values()];
}

const CREDENTIAL_LABELS = {
  source: {registered_catalog:"本地登记",trusted_catalog:"可信会话目录",json_field:"实际字段值",source_assignment:"源码字面量",environment_assignment:"环境变量赋值",authorization_field:"认证字段",authorization_header:"认证头值",authorization_scheme:"认证格式",cookie_pair:"Cookie 值",url_query:"URL 参数",url_userinfo:"URL 认证值",provider_format:"服务商格式",private_key_envelope:"私钥封装"},
  type: {password:"密码",api_key:"API Key",access_token:"访问令牌",session_token:"会话令牌",jwt:"JWT 候选",aws_access_id:"AWS 访问标识",private_key:"私钥",registered_secret:"登记凭据",authentication_secret:"认证值"},
  reason: {protection_disabled:"保护关闭",policy_not_selected:"当前策略未选择替换",protection_credential_in_protocol_structure:"结构中无法安全替换",protection_signed_or_opaque_content:"签名或不透明内容无法安全替换",protection_credential_in_key:"对象键中无法安全替换",protection_non_string_credential:"非字符串凭据无法安全替换",pending_execution:"尚未执行",execution_failed:"执行失败"},
};
function credentialStatus(candidate) {
  if(candidate.replacementStatus === "replaced") return "已替换";
  if(candidate.replacementStatus === "not_replaced") return `未替换 · ${CREDENTIAL_LABELS.reason[candidate.reason] || candidate.reason || "原因未记录"}`;
  return "替换结果未记录";
}
function credentialConfidence(candidate) {
  return {low:"低置信度",strong:"强证据"}[candidate.confidence] || "置信度未记录";
}
function credentialCandidates(record) {
  const snapshot = (record.credentialDetection || record.protection?.detection)?.snapshotId;
  const facts = record.protection?.decisions || (record.findings || []).flatMap(f=>f.evidence?.credentialCandidates || []).filter(c=>snapshot && c.snapshotId===snapshot);
  return [...new Map(facts.map(c=>[c.candidateId,c])).values()];
}
function renderCredentialDecisions(record) {
  const candidates=credentialCandidates(record), detection=record.credentialDetection || record.protection?.detection;
  if(!detection && !candidates.length) return "";
  const total=detection?.candidateCount ?? candidates.length;
  const unmodified=candidates.filter(c=>c.replacementStatus === "not_replaced");
  const unknown=candidates.filter(c=>!c.replacementStatus).length;
  return `<div class="credential-decisions"><p class="trace-content-note">检测候选 ${esc(total)} 处${detection?.lowConfidenceCount!=null?` · 低置信候选 ${esc(detection.lowConfidenceCount)} 处`:""}。替换状态依据实际执行记录。</p>${candidates.length<total || unknown?'<p class="muted">部分候选的替换结果未在此处记录，完整证据见原始内容中的检测记录。</p>':""}${unmodified.length?`<details><summary>未替换候选 · ${unmodified.length} 处</summary>${unmodified.slice(0,40).map(c=>`<p class="credential-decision">${esc(CREDENTIAL_LABELS.type[c.credentialType] || "凭据候选")} · ${esc(credentialConfidence(c))} · ${esc(CREDENTIAL_LABELS.source[c.source] || c.source || "来源未记录")}<br>${esc(credentialStatus(c))}<br><span class="muted">${esc(c.location)} · 原文字节 ${esc(c.rawStart)}–${esc(c.rawEnd)}</span></p>`).join("")}${unmodified.length>40?'<p class="muted">这里只展示前 40 处，完整记录见原始内容中的检测证据。</p>':""}</details>`:""}</div>`;
}
function renderCredentialFinding(f) {
  const facts=f.evidence?.credentialCandidates;
  if(!facts?.length) return "";
  return `<div class="credential-finding-facts">${f.auditDecision?`<p class="trace-content-note">${esc({credential_warning:"凭据告警",candidate_notice:"候选提示"}[f.auditDecision] || f.auditDecision)}</p>`:""}${facts.slice(0,8).map(c=>`<p class="trace-content-note">${esc(CREDENTIAL_LABELS.type[c.credentialType] || "凭据候选")} · ${esc(CREDENTIAL_LABELS.source[c.source] || c.source || "来源未记录")}${c.replacementStatus?` · ${esc(credentialStatus(c))}`:""}</p>`).join("")}${facts.length>8?'<p class="muted">完整候选事实见下方检测证据。</p>':""}</div>`;
}

function protectionMappingDetails(record, credential) {
  const open = record.protectionOpen?.[credential.id];
  return `<details class="protection-mapping-details" data-protection-mapping="${esc(credential.id)}" ${open ? "open" : ""}><summary>映射详情</summary>${credential.mappings.map(m => `<dl><dt>占位符 B</dt><dd><code>${esc(m.replacement)}</code></dd><dt>映射创建时间</dt><dd>${esc(securityTime(m.createdAtMs))}</dd><dt>本次续期到期时间</dt><dd>${esc(securityTime(m.expiresAtMs))}</dd></dl>`).join("")}</details>`;
}

function renderProtection(record) {
  const p = record.protection;
  const failed = p?.status === "failed", unavailable = p?.evidenceState === "unavailable" || p?.enabled && !Array.isArray(p.mappings);
  const credentials = protectionCredentials(p), used = credentials.filter(m => m.requestCount + m.responseCount > 0), history = credentials.filter(m => m.requestCount + m.responseCount === 0);
  const labels = { prepared: "已准备", protected: "请求已保护", completed: "已完成", failed: "保护失败" };
  const label = failed ? "保护失败" : unavailable ? "证据不可用" : p?.enabled ? labels[p.status] || "已启用" : "未启用";
  const empty = (title, note) => `<div class="protection-empty"><h4>${title}</h4><p>${note}</p></div>`;
  const heading = `<header class="protection-heading"><h3>${protectionKeyIcon()} 凭据保护</h3><span class="protection-state ${failed || unavailable ? "is-warning" : !p?.enabled ? "is-muted" : ""}">${label}</span></header>`;
  if (!p?.enabled) return `<section class="credential-protection">${heading}${empty("此请求未启用凭据保护", "本次没有执行凭据替换或响应还原。")}${renderCredentialDecisions(record)}</section>`;
  const summary = unavailable ? '<p class="protection-counts">凭据数量不可确认 · 请求替换 ' + esc(p.requestCount ?? "未知") + ' 次 · 响应还原 ' + esc(p.responseCount ?? "未知") + ' 次</p>'
    : `<p class="protection-counts">涉及 <b>${used.length}</b> 个凭据 · 请求替换 <b>${esc(p.requestCount || 0)}</b> 次 · 响应还原 <b>${esc(p.responseCount || 0)}</b> 次</p>`;
  const historyHtml = !unavailable ? `<details class="protection-history" data-protection-history ${record.protectionHistoryOpen ? "open" : ""}><summary>会话已有映射 · ${history.length} 条 <small>本次未使用</small></summary>${history.map(m => `<article class="protection-history-item"><pre>${esc(m.original)}</pre>${protectionMappingDetails(record, m)}</article>`).join("") || '<p class="muted">没有本次未使用的会话映射。</p>'}</details>` : "";
  const failure = failed ? `<div class="protection-failure" role="alert"><strong>${p.reason === "response_restore_failed" ? "响应还原未完成" : p.reason === "request_protection_failed" ? "请求保护未完成 · 请求未发送到上游" : "保护或还原未完成"}</strong><p>请结合请求结果复核，本次操作次数不代表保护完整完成。</p>${p.reason ? `<details><summary>失败详情</summary><p>${esc(p.reason)}</p></details>` : ""}</div>` : "";
  const rows = used.map((m, i) => `<article class="security-finding protection-mapping"><header class="protection-entry-heading">${protectionKeyIcon()}<strong>凭据 ${String(i + 1).padStart(2, "0")}</strong><span class="protection-reuse ${m.reused ? "" : "is-new"}">${m.reused ? "复用" : "新建"}</span><button class="protection-copy" data-action="security-protection-copy" data-id="${esc(m.id)}" aria-label="复制凭据 ${i + 1} 的原文 A">复制 A</button></header><div class="protection-value"><span>原文 A</span><code class="security-protection-hit" title="${esc(m.original)}">${esc(m.original)}</code></div><p class="protection-entry-counts">请求替换 ${m.requestCount} 次 · 响应还原 ${m.responseCount} 次</p><div class="protection-entry-actions">${["request", "response"].map(side => m[side + "Count"] ? `<button class="security-location" data-action="security-protection-source" data-side="${side}" data-id="${esc(m.id)}">${side === "request" ? "请求" : "响应"}原文（${m[side + "Count"]} 处）</button>` : "").join("")}</div>${protectionMappingDetails(record, m)}</article>`).join("");
  return `<section class="credential-protection">${heading}${summary}${renderCredentialDecisions(record)}<p class="protection-note">会话闲置 ${esc((p.mappingTtlSeconds || 3600) / 3600)} 小时后过期，每次新请求重置倒计时。下方显示本次操作。</p>${historyHtml}${failure}${unavailable ? empty("保护证据不可用", "未保留完整映射证据，无法列出或确认全部 A↔B。请结合请求结果复核。") : rows || (!failed ? empty("已启用，本次没有替换或还原", "本次保护操作为 0；会话已有映射可在上方展开查看。") : "")}<p class="protection-read-note">本地审计保留原文 A。映射详情中的到期时间是本次请求续期后的证据时间。完整内容可通过原有请求、响应和原始内容页签查看。</p></section>`;
}

function closeProtectionSource() {
  const source = state.security.protectionSource;
  state.security.protectionSource = null;
  source?.controller.abort();
  document.querySelector("#protection-source-dialog")?.close?.();
}

function protectionSourceCurrent(source) {
  return state.security.protectionSource === source && state.security.detail === source.record
    && state.security.detailSequence === source.sequence && state.page === "security-session" && state.trace.tab === "protection";
}

function protectionContextPage(pages, hit) {
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const chunks = pages.flatMap(page => page.chunks || []);
  const left = Math.max(0, hit.start - 600), right = hit.end + 600;
  const clipped = chunks.filter(c => c.start < right && c.end > left).map(chunk => {
    const bytes = encoder.encode(chunk.content);
    let from = Math.max(0, left - chunk.start), to = Math.min(bytes.length, right - chunk.start);
    while (from < to && (bytes[from] & 0xc0) === 0x80) from++;
    while (to > from && (bytes[to] & 0xc0) === 0x80) to--;
    return { ...chunk, start: chunk.start + from, end: chunk.start + to, content: decoder.decode(bytes.slice(from, to)) };
  });
  const unique = ranges => [...new Map(ranges.map(r => [JSON.stringify(r), r])).values()];
  return { chunks: clipped, protectionRanges: unique(pages.flatMap(p => p.protectionRanges || [])), riskRanges: unique(pages.flatMap(p => p.riskRanges || [])), gap: pages.some(p => p.gap) };
}

function renderProtectionSource() {
  const source = state.security.protectionSource;
  if (!source) return;
  const dialog = document.querySelector("#protection-source-dialog");
  const focus = dialog.contains?.(document.activeElement) ? document.activeElement.dataset : null;
  const hit = source.hits[source.at];
  const count = source.total ?? 0;
  const retained = source.expected !== count ? `<p class="protection-note">操作记录 ${source.expected} 次，已保留 ${count} 处可定位原文；未保留的位置无法在此展示。</p>` : "";
  const content = source.loading ? '<p role="status">正在读取命中上下文…</p>' : source.error ? `<p class="notice warning" role="alert">${esc(source.error)}</p><button class="mini-button" data-action="security-protection-retry">重试</button>` : hit ? `<p class="protection-source-location">${hit.snapshotId === "request" ? "请求正文" : hit.snapshotId === "response" ? "响应正文" : "响应流式内容"} · 字节 ${hit.start}–${hit.end}</p>${source.page?.gap ? '<p class="notice warning">此范围原文保留存在缺口，以下上下文可能不完整。</p>' : ""}<pre class="protection-source-snippet">${securityPageText(source.page, hit)}</pre>${retained}` : '<p class="notice warning">保护原文未保留或位置证据不可用，无法定位。完整内容仍可在原有页签复核。</p>';
  dialog.innerHTML = `<header class="protection-source-heading"><strong id="protection-source-title">${source.response ? "响应" : "请求"}原文 · 凭据 ${source.ordinal}</strong><button data-action="security-protection-close" aria-label="关闭定位弹出框">×</button></header><div class="protection-source-body"><div class="protection-source-controls"><button class="mini-button" data-action="security-protection-step" data-step="-1" ${source.loading || source.at <= 0 ? "disabled" : ""}>上一处</button><span role="status">${count ? source.at + 1 : 0} / ${count} 处</span><button class="mini-button" data-action="security-protection-step" data-step="1" ${source.loading || source.at + 1 >= count ? "disabled" : ""}>下一处</button></div>${content}<p class="protection-note">显示原文 A 和命中上下文。完整请求、响应仍通过原有页签查看。</p></div>`;
  if (focus) {
    const selector = `[data-action="${focus.action}"]${focus.step ? `[data-step="${focus.step}"]` : ""}`;
    const button = dialog.querySelector(selector);
    (button && !button.disabled ? button : dialog.querySelector('[data-action="security-protection-close"]'))?.focus({ preventScroll: true });
  }
}

async function loadProtectionSource(source) {
  source.loading = true; source.error = null; renderProtectionSource();
  const request = path => api(`/security/audit/${encodeURIComponent(source.record.id)}/${path}`, { signal: source.controller.signal });
  try {
    if (source.total == null) {
      source.hits = [];
      // Locations are small paged metadata; body content is fetched only for the
      // current occurrence, including non-message fields and reconstructed SSE.
      for (const mapping of source.credential.mappings) {
        let offset = 0;
        do {
          const page = await request(`protection-locations?${new URLSearchParams({ mapping: mapping.id, side: source.response ? "response" : "request", offset })}`);
          if (!protectionSourceCurrent(source)) return;
          source.hits.push(...(page.items || []));
          offset = page.nextOffset;
        } while (offset != null);
      }
      source.total = source.hits.length;
    }
    const hit = source.hits[source.at];
    if (hit) {
      const pages = [];
      let offset = Math.max(0, hit.start - 768);
      do {
        const page = await request(`body?${new URLSearchParams({ snapshot: hit.snapshotId, offset })}`);
        if (!protectionSourceCurrent(source)) return;
        pages.push(page);
        if (page.nextOffset == null || page.nextOffset <= offset || page.nextOffset >= hit.end + 600) break;
        offset = page.nextOffset;
      } while (true);
      source.page = protectionContextPage(pages, hit);
    }
  } catch (error) { if (protectionSourceCurrent(source)) source.error = error.message; }
  if (!protectionSourceCurrent(source)) return;
  source.loading = false; renderProtectionSource();
}

async function locateProtection(id, response) {
  const s = state.security, record = s.detail;
  const used = protectionCredentials(record?.protection).filter(m => m.requestCount + m.responseCount > 0);
  const credential = used.find(m => m.id === id);
  if (!credential) return;
  closeProtectionSource();
  const source = s.protectionSource = { record, sequence: s.detailSequence, credential, ordinal: used.indexOf(credential) + 1, response, expected: credential[response ? "responseCount" : "requestCount"], hits: [], at: 0, loading: true, controller: new AbortController() };
  renderProtectionSource();
  document.querySelector("#protection-source-dialog").showModal?.();
  await loadProtectionSource(source);
}

function renderTraceInspector() {
  const s = state.security, t = state.trace, r = s.detail;
  const tabs = `<div class="trace-tabs" aria-label="步骤详情"><button data-action="security-trace-tab" data-tab="overview" aria-pressed="${t.tab === "overview"}">概览</button><button data-action="security-trace-tab" data-tab="risks" aria-pressed="${t.tab === "risks"}">风险 ${r?.findingCount || 0}</button><button data-action="security-trace-tab" data-tab="protection" aria-pressed="${t.tab === "protection"}">凭据保护</button><button data-action="security-trace-tab" data-tab="request" aria-pressed="${t.tab === "request"}">请求内容</button><button data-action="security-trace-tab" data-tab="response" aria-pressed="${t.tab === "response"}">响应内容</button><button data-action="security-trace-tab" data-tab="body" aria-pressed="${t.tab === "body"}">原始内容</button></div>`;
  if (s.detailLoading) return `${tabs}<p class="empty" role="status">正在加载步骤详情…</p>`;
  if (s.detailError) return `${tabs}<p class="notice warning" role="alert">${esc(s.detailError)}</p>`;
  if (!r) return `${tabs}<p class="empty">选择一条请求查看详情。</p>`;
  let body;
  if (t.tab === "body") body = renderSecurityBody(r);
  else if (t.tab === "risks") body = `<p class="muted">工具真实执行状态未知；工具结果来自客户端报告。</p>${renderSecurityFindings(r)}`;
  else if (t.tab === "protection") body = renderProtection(r);
  else if (t.tab === "request") body = renderRequestContent(r);
  else if (t.tab === "response") body = renderResponseContent(r);
  else body = `<div class="trace-inspector-heading"><strong>${esc(securityLabel("outcome", r.outcome))}</strong>${r.findingCount ? securityBadge(r.severity) : ""}</div>
    <dl class="trace-facts">${[["模型", securityModelMapping(r)], ["开始", securityTime(r.at)], ["耗时", securityDuration(r.durationMs)], ["HTTP", r.httpStatus ?? "未知"], ["检查", securityInspectionLabel(r)], ["Token", r.usage ? `${r.usage.input_tokens ?? "—"} 输入 / ${r.usage.output_tokens ?? "—"} 输出` : "未报告"]].map(([k,v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${r.inspectionProgress?.active ? `<p role="status" class="muted">检测进度：${esc(r.inspectionProgress.processedBytes || 0)} / ${esc(r.inspectionProgress.observedBytes || r.observedBytes || 0)} 字节 · ${esc(securityInspectionLabel(r))}</p>` : ""}
    ${r.lostWrites ? `<p class="notice warning">记录到 ${esc(r.lostWrites)} 次审计写入缺口。</p>` : ""}
    ${renderSecurityCoverage(r)}
    <details class="trace-record-id"><summary>全部记录信息</summary><dl class="trace-facts">${securityRecordFacts(r).map(([k,v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${r.coverageGaps?.length ? `<p>正文缺口范围</p><pre class="code-preview">${esc(JSON.stringify(r.coverageGaps, null, 2))}</pre>` : ""}</details>`;
  return `${tabs}<div class="trace-inspector-body">${body}</div>`;
}

function renderSecuritySession() {
  const t = state.trace, s = state.security, summary = t.summary;
  const risks = securityRiskCounts(summary || {});
  const all = t.result?.items || [], items = traceItems();
  const hasLegacy = all.some(item => !securityHasRiskHistory(item)), hasModern = all.some(securityHasRiskHistory);
  const segments = traceSegments(all);
  const maxDuration = segments.reduce((max, item) => Math.max(max, item.duration), 1);
  const weights = segments.map(item => t.scale === "duration" ? Math.max(.2, item.duration / maxDuration * 10) : 1);
  const minimumWidth = weights.reduce((width, weight) => width + Math.max(12, weight * 12) + 2, 20);
  const minimap = segments.map((item, i) => {
    const label = `请求 ${item.order}`;
    return `<div class="trace-step" style="flex-grow:${weights[i]}">${item.order % 5 === 0 ? `<span class="trace-axis-tick" aria-hidden="true"><span>${item.order}</span></span>` : ""}<button class="trace-segment ${item.newFindingCount ? "has-new-risk" : item.legacyFindingCount ? "has-risk" : item.historicalFindingCount ? "has-history-risk" : ""} ${item.selected ? "is-selected" : ""}" data-action="security-trace-select" data-id="${esc(item.id)}" title="${label} · ${esc(securityDuration(item.duration))} · ${esc(securityRiskSummary(item))}${protectionOccurred(item) ? ` · 请求替换 ${item.protection?.requestCount || 0} 次，响应还原 ${item.protection?.responseCount || 0} 次` : ""}" aria-label="选择${label}" aria-pressed="${item.selected}"${protectionOccurred(item) ? ` data-credential-protected` : ""}>${protectionOccurred(item) ? protectionKeyIcon() : ""}</button></div>`;
  }).join("");
  const positions = new Map(all.map((item, i) => [item.id, i]));
  return `<nav class="security-detail-nav"><button class="button" data-action="security-back">返回审计记录</button><span class="muted">审计记录 / 会话轨迹</span><span class="status-badge">仅记录</span></nav>
    <header class="trace-heading"><div><h2>${esc(summary ? securitySessionTitle(summary) : "会话轨迹")}</h2><p class="muted">${esc(summary?.providerId || "未记录配置")} · ${summary?.identified ? "按客户端会话标识归组" : "独立记录 · 未获取会话标识"}${summary ? ` · ${esc(securityTime(summary.firstAtMs))}` : ""}</p></div>
    <div class="trace-totals"><span><strong>${esc(summary?.requestCount ?? "—")}</strong> 条记录</span><span>${summary?.findingCount === 0 ? "未发现风险" : `<strong>${esc(summary ? risks.new + risks.legacy : "—")}</strong> 项${risks.legacy ? "" : "新增"}风险${risks.legacy && risks.new ? `（含旧记录 ${esc(risks.legacy)} 项）` : ""}${risks.historical ? ` · ${esc(risks.historical)} 次历史关联` : ""}`}</span><span><strong>${esc(securityDuration(summary?.durationMs))}</strong> 请求累计耗时</span></div></header>
    ${t.error ? `<p class="notice warning" role="alert">${esc(t.error)}<button class="button" data-action="security-session-refresh">重试</button></p>` : ""}
    <section class="trace-workspace" aria-label="会话轨迹">
      <div class="trace-toolbar"><strong>轨迹</strong><span class="muted">按请求顺序 · 已加载 ${all.length} 条 / 共 ${esc(t.result?.total ?? "—")} 条</span><button class="mini-button" data-action="security-session-refresh" ${t.loading ? "disabled" : ""}>${t.loading ? "读取中…" : "刷新会话"}</button></div>
      <div class="trace-overview"><div class="trace-scale-row"><button class="mini-button trace-scale-toggle" data-action="security-trace-scale" aria-pressed="${t.scale === "duration"}" title="${t.scale === "duration" ? "当前按耗时分配宽度，点击恢复按请求数分配" : "点击按已记录的请求耗时分配宽度"}">耗时占比</button></div>
        <div class="trace-map-viewport" tabindex="0" aria-label="可横向滚动的请求导航，刻度为请求序号"><div class="trace-map-track" style="min-width:${minimumWidth}px"><div class="trace-minimap">${minimap}</div></div></div>
        <div class="trace-scroll-rail" hidden><input class="trace-scroll-control" type="range" min="0" max="0" step="1" value="0" aria-label="左右滚动请求轨迹"></div>
        <p class="trace-overview-caption"><strong>已加载轨迹概览</strong><span>每格对应一条请求</span><span class="trace-legend">${protectionKeyIcon()} 发生凭据替换 / 还原</span><span class="trace-legend"><i class="trace-legend-swatch trace-request-swatch" aria-hidden="true"></i>未发现风险</span><span class="trace-legend"><i class="trace-legend-swatch trace-risk-swatch" aria-hidden="true"></i>${hasLegacy ? hasModern ? "风险 / 新增风险" : "风险" : "新增风险"}</span>${hasModern ? `<span class="trace-legend"><i class="trace-legend-swatch trace-history-risk-swatch" aria-hidden="true"></i>仅历史风险</span>` : ""}${t.scale === "duration" ? "<span>宽度表示已记录的请求耗时（最小宽度便于点击），刻度为请求序号</span>" : ""}</p></div>
      <div class="trace-columns"><section class="trace-events" aria-label="请求列表"><form id="security-trace-search" class="trace-search"><input name="search" aria-label="搜索已加载轨迹" placeholder="搜索已加载输入、输出、工具或模型" value="${esc(t.search)}"><button class="mini-button" type="submit">搜索</button><button class="mini-button" type="button" data-action="security-trace-risk" aria-pressed="${t.riskOnly}">仅看风险</button></form>
        <div class="trace-event-list" tabindex="0" aria-label="可滚动请求列表" aria-busy="${t.loadingMore}">${items.map(item => { const i = positions.get(item.id), risk = securityRiskCounts(item); return `<button class="trace-event-row ${s.detailId === item.id ? "is-selected" : ""}" data-action="security-trace-select" data-id="${esc(item.id)}" aria-pressed="${s.detailId === item.id}"><span class="trace-order">${String(i + 1).padStart(2,"0")}</span><span class="trace-event-main"><span class="trace-event-meta"><span class="trace-event-models"><span>模型</span><strong title="${esc(securityModelMapping(item))}">${esc(securityModelMapping(item))}</strong></span><span>${esc(securityDuration(item.durationMs))}</span><span class="${risk.new || risk.legacy ? "trace-risk-count" : "muted"}">${esc(securityRiskSummary(item))}</span></span><span class="trace-event-preview"><span>输入</span>${esc(item.requestPreview || (item.kind === "request" ? "无文本摘要，查看原始内容" : securityLabel("action", item.action)))}</span><span class="trace-event-preview"><span>输出</span>${esc(item.responsePreview || securityLabel("outcome", item.outcome))}</span><span class="trace-event-status">${esc(securityLabel("outcome", item.outcome))} · ${esc(securityInspectionLabel(item))}</span></span></button>`; }).join("") || `<p class="empty" role="status">${t.loading ? "正在读取轨迹…" : all.length ? "已加载的轨迹中没有匹配的步骤。可继续向下加载，或清空搜索与筛选。" : "会话暂无记录，或已超出保留范围。"}</p>`}<div class="trace-load-status" role="status">${t.moreError ? `<span>${esc(t.moreError)}</span><button class="mini-button" data-action="security-trace-more">重试加载</button>` : t.loadingMore ? "正在加载更多请求…" : t.result?.nextCursor ? `<span>向下滚动加载更多请求</span><button class="mini-button" data-action="security-trace-more">继续加载</button>` : all.length ? "已显示全部请求" : ""}</div></div>
      </section><aside class="trace-inspector" aria-label="选中步骤详情">${renderTraceInspector()}</aside></div>
    </section>`;
}

// Ordinal paths remain stable when credential-bearing property names are redacted.
// An original-content link marks a scroll position, not a selected risk range.
function securitySourceAnchor(text) {
  return `<span data-security-body-anchor tabindex="-1">${esc(text)}</span>`;
}

const SECURITY_BODY_LABELS = {
  source: { observed_headers: "请求 / 响应头", tool_inspection: "检测时的工具参数", inspection_range: "检测时的正文范围", client_request: "客户端请求正文", upstream_response: "上游响应正文", client_response: "还原后客户端响应正文", gateway_response: "网关本地响应", stream_inspection: "检测时的流式内容快照", response_inspection: "检测时的响应内容快照" },
  state: { complete: "已完整保留", receiving: "分段保存中", gap: "保留存在缺口", partial: "部分内容不可复核", truncated: "旧版截断记录", interrupted: "接收中断或未观察到协议结束", not_observed: "网关未读取正文", capture_unavailable: "正文保留不可用", redaction_unavailable: "凭据脱敏超限，内容已隐藏", pending: "仍在接收或等待保存" },
  redaction: { unsupported_stream_fragment: "无法安全重组的未知流式片段", credential_in_arguments: "工具参数中的凭据", credential_continuation: "跨段凭据续片", url_authority_uncertain: "无法确认的长 URL 认证区", credential_prefix_uncertain: "无法确认的长令牌前缀", redaction_buffer_budget: "脱敏工作区不足", cookie_header: "Cookie 头", credential_field: "凭据字段", known_credential: "已知凭据", credential_pattern: "凭据格式", credential_assignment: "凭据赋值", credential_literal_unverified: "未确认的源码字面量", jwt_candidate: "无认证上下文的 JWT 候选", jwt_shape_unverified: "未确认的 JWT 外形", authorization: "认证值", private_key: "私钥", url_credentials: "URL 认证信息", url_credential_parameter: "URL 凭据参数", nested_json_credentials: "参数内嵌 JSON 凭据", incomplete_stream_fragment: "未完成的流式片段", incomplete_body_fragment: "截断文本末尾", unparsed_json_credentials: "含凭据的内嵌 JSON 无法解析", redaction_depth_limit: "脱敏深度上限", redaction_catalog_limit: "凭据字典上限", internal_host: "内网地址与端口", public_host: "公网服务器地址与端口", internal_identity: "URL 用户名" },
};

const ENDPOINT_REASONS = ["internal_host", "public_host", "internal_identity"];

function securityPageMarks(page) {
  const endpoints = chunk => (chunk.coverageRanges || []).filter(range => ENDPOINT_REASONS.includes(range.reason));
  const marks = page?.chunks?.flatMap(chunk => [...(chunk.sensitiveRanges || []), ...endpoints(chunk), ...(chunk.redactions || [])]) || page?.legacySnapshot?.redactions || [];
  return [...new Map(marks.map(mark => [JSON.stringify([mark.start, mark.end, mark.reason, mark.location]), mark])).values()];
}

function securityPageText(page, selection, riskRanges = page.riskRanges || []) {
  const location = path => page.locations?.filter(range => path === range.path || path?.startsWith(`${range.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  if (page.locations) {
    selection = { ...selection, ...(location(selection.location) || {}),
      ...(selection.navigation ? { navigation: { ...selection.navigation, ...(location(selection.navigation.location) || {}) } } : {}) };
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
    for (const range of page.protectionRanges || []) add(range, "protected");
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
    let at = 0, sensitive = 0, selected = 0, risk = 0, endpoint = 0, anchor = 0, protectedCount = 0, html = "";
    for (const event of events) {
      if (event.at > at) {
        const text = decoder.decode(bytes.slice(at, event.at));
        const content = anchor > 0 ? securitySourceAnchor(text) : esc(text);
        const classes = [protectedCount > 0 && "security-protection-hit", sensitive > 0 && "security-sensitive-hit", risk > 0 && "security-risk-hit", endpoint > 0 && "security-endpoint-hit", selected > 0 && "security-body-hit"].filter(Boolean).join(" ");
        html += classes ? `<mark class="${classes}"${selected > 0 ? ' tabindex="-1"' : ""}>${content}</mark>` : content;
        at = event.at;
      }
      sensitive += event.sensitive || 0;
      selected += event.selected || 0;
      risk += event.risk || 0;
      endpoint += event.endpoint || 0;
      anchor += event.anchor || 0;
      protectedCount += event.protected || 0;
    }
    return html;
  }).join("");
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
      <pre class="code-preview security-body-content" aria-label="保留正文">${securityPageText(page, selection, page.riskRanges || [])}</pre>
      ${references.length ? `<div class="security-body-tabs" aria-label="关联流式内容">${references.map((id, i) => `<button class="mini-button" data-action="security-body" data-id="${esc(id)}">关联流式内容 ${i + 1} · ${esc(id.split("/").at(-1).slice(0, 8))}</button>`).join("")}</div>` : ""}
      ${selection.sourceSnapshotId && selection.sourceSnapshotId !== selection.snapshotId && selection.sourceStart != null ? `<button class="mini-button" data-action="security-source" data-id="${esc(selection.sourceSnapshotId)}" data-offset="${esc(selection.sourceStart)}">查看完整正文上下文</button>` : ""}
      <details class="security-redactions"><summary>本页${original ? "敏感" : "脱敏"}位置 · ${marks.length}</summary><ul>${marks.map(mark => `<li><button class="security-location" data-action="security-location" data-start="${esc(mark.start)}" data-end="${esc(mark.end)}" data-location="${esc(mark.location || "")}">${mark.start == null ? esc(mark.location) : `字节 ${esc(mark.start)}–${esc(mark.end)}`}</button> · ${esc(SECURITY_BODY_LABELS.redaction[mark.reason] || mark.reason)}</li>`).join("")}</ul></details>` : ""}` : `<p class="muted">展开后加载该内容。</p>`;
  const panels = snapshots.map((item, i) => `<details class="security-body-review" data-security-snapshot="${esc(item.id)}" ${item.id === selection.snapshotId ? "open" : ""}><summary>${esc(labelFor(item, i))}${item.byteLength != null ? ` · ${esc(item.byteLength)} 字节` : ""}</summary>${item.id === selection.snapshotId && allSnapshots.some(snapshot => snapshot.id === item.id) ? content : `<p class="muted">${allSnapshots.some(snapshot => snapshot.id === item.id) ? "展开后加载该内容。" : "此内容未被网关观察或保留。"}</p>`}</details>`).join("");
  const streamPage = s.streamPageSnapshotId === selection.detectionSnapshotId ? s.streamPage : null;
  const streamContent = streamPage ? securityPageText(streamPage, { ...selection, hitUnavailable: false, start: selection.detectionStart, end: selection.detectionEnd }, streamPage.riskRanges || []) : "";
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
    const page = await api(`/security/audit/${encodeURIComponent(recordId)}/body?${new URLSearchParams({ snapshot: snapshotId, offset, ...(locateCredential && selection.findingId ? { finding: selection.findingId } : {}) })}`);
    if (!current()) return false;
    s.bodyPage = page;
    if (page.findingSelection) {
      const { detectionSnapshotId, detectionStart, detectionEnd, ...bodyLocation } = page.findingSelection;
      Object.assign(selection, bodyLocation);
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
  const findings = record.findings || [];
  const fresh = findings.filter(finding => !finding.historical), historical = findings.filter(finding => finding.historical);
  const row = f => `<article class="security-finding ${state.security.bodySelection?.findingId === f.id ? "is-selected" : ""}"><div>${securityBadge(f.severity)} <button class="security-finding-link" data-action="security-finding" data-id="${esc(f.id)}" aria-pressed="${state.security.bodySelection?.findingId === f.id}">${esc(securityLabel("rule", f.ruleId))} <span>定位正文</span></button></div>${f.reusedFrom ? `<p class="trace-content-note">复用已有检查结果 · ${esc(securityTime(f.reusedFrom.checkedAt))}</p>` : ""}<p class="muted">${esc(securityLabel("category", f.category))} · ${esc(securityLabel("stage", f.evidenceStage))} · ${esc(securityLabel("confidence", f.confidence))} · 规则 ${esc(f.ruleId)} v${esc(f.ruleVersion)}</p>${renderCredentialFinding(f)}${f.credentialProtection ? `<p class="trace-content-note">${f.credentialProtection.side === "request" ? "此凭据位置已在发送前替换，上游收到占位符。" : "此位置是响应中占位符还原后的原文。"}</p>` : ""}${f.severityReason ? `<p>分级依据：${esc(securityLabel("basis", f.severityReason))}。</p>` : ""}${f.confidenceReason ? `<p>判断依据：${esc(securityLabel("basis", f.confidenceReason))}。</p>` : ""}<p>证据仅表示在此阶段观察到了对应内容或操作结构，不确认实际执行或恶意意图。</p><details><summary>检测证据与标准映射</summary><pre class="code-preview">${esc(JSON.stringify({ evidence: f.evidence, frameworkMappings: f.frameworkMappings }, null, 2))}</pre></details></article>`;
  return `<h3>关联风险 · ${findings.length}</h3>${historical.length ? `<p class="muted">新增 ${fresh.length} 项 · 历史 ${historical.length} 项</p>` : ""}
    ${fresh.map(row).join("") || (!historical.length ? `<p class="muted">没有关联风险；请结合检查状态判断覆盖范围。</p>` : "")}
    ${historical.length ? `<details class="trace-content-history" data-history-risks ${record.historyRisksOpen ? "open" : ""}><summary>历史风险 · ${historical.length} 项</summary>${historical.map(row).join("")}</details>` : ""}`;
}

function securityRecordFacts(record) {
  const facts = [["记录 ID", record.id], ["操作", securityLabel("action", record.action)], ["配置入口", record.providerId || "本地管理"], ["发生时间", securityTime(record.at)], ["结束时间", record.finishedAt ? securityTime(record.finishedAt) : "未记录"], ["请求结果", securityLabel("outcome", record.outcome)], ["HTTP 状态", record.httpStatus ?? "未知"], ["配置修订", record.revision ?? "未知"], ["模型", securityModelMapping(record)], ["响应头耗时", record.headersMs == null ? "—" : `${record.headersMs} ms`], ["完整记录耗时", record.durationMs == null ? "—" : `${record.durationMs} ms`]];
  if (record.supplierId) facts.push(["供应商 / 接口", `${record.supplierId} / ${record.interfaceId}`], ["实际模型", `${record.actualModelIdentity || "未知"}${record.actualModelVersion ? ` / ${record.actualModelVersion}` : ""}`], ["适配实现", record.adapterVersion], ["提示词策略", `${record.promptStrategy || "default"} / ${record.nativeDefinitionVersion || record.promptVersion || "未记录"}`], ["供给验证", record.modelValidation || "未实测"]);
  if (record.reasoningControl) facts.push(["推理档位", `${record.reasoningControl.requestedEffort || "未设置"} → ${record.reasoningControl.appliedEffort || "未设置"}`]);
  if (record.adaptationError || record.selectionError) facts.push(["适配 / 来源错误", record.adaptationError || record.selectionError.message]);
  if (record.responseTerminalEvent) facts.push(["响应结束依据", record.responseTerminalEvent]);
  if (record.responseTransportState) facts.push(["响应接收", { complete: "连接完整结束", interrupted: record.responseTerminalEvent ? "收到结束事件后连接关闭" : "响应接收中断", error: "连接读取出错", not_observed: "未观察到响应" }[record.responseTransportState] || record.responseTransportState]);
  return facts;
}

function renderSecurityDetail(record) {
  const facts = securityRecordFacts(record);
  return `<section class="panel security-detail" aria-label="审计详情"><div class="panel-header"><h2>请求记录</h2>${securityBadge(record.severity)}</div><div class="panel-body">
    <dl class="security-facts">${facts.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>
    <p>${esc(securityInspectionLabel(record))}。${record.kind === "request" ? "工具真实执行状态：未知；工具结果来自客户端报告。" : "记录审计存储的完整性状态。"}</p>
    ${record.inspectionProgress ? `<p role="status">检测进度：${esc(record.inspectionProgress.processedBytes || 0)} / ${esc(record.inspectionProgress.observedBytes || record.observedBytes || 0)} 字节 · ${esc(securityInspectionLabel(record, record.inspectionProgress.state))}${record.inspectionProgress.phase === "receiving" ? "（正文接收中）" : record.inspectionProgress.phase === "queued" ? "（等待检测资源）" : ""}</p>` : ""}
    ${renderSecurityCoverage(record)}
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
    pushNavigation({ page: "security-session", list: securityListState(), returnToSecurityList: true }, `#security/session/${encodeURIComponent(element.dataset.id)}`);
    await loadSecuritySession(element.dataset.id); return;
  }
  if (action === "security-session-refresh") { await loadSecuritySession(t.id, false); return; }
  if (action === "security-trace-select") {
    pendingTraceSelection = true;
    await loadSecurityDetail(element.dataset.id, true, true);
    pageContent.querySelector(`.trace-event-row.is-selected`)?.scrollIntoView({ block: "nearest", behavior: "instant" });
    return;
  }
  if (action === "security-protection-copy") {
    const credential = protectionCredentials(s.detail?.protection).find(m => m.id === element.dataset.id);
    if (!credential) return;
    try { await navigator.clipboard.writeText(credential.original); toast("已复制原始凭据 A"); }
    catch { toast("复制失败，请从原文 A 预览中手动复制。", true); }
    return;
  }
  if (action === "security-protection-close") { closeProtectionSource(); return; }
  if (action === "security-protection-step" || action === "security-protection-retry") {
    const source = s.protectionSource;
    if (!source || source.loading || !protectionSourceCurrent(source)) return;
    if (action === "security-protection-step") source.at = Math.max(0, Math.min(source.total - 1, source.at + Number(element.dataset.step)));
    await loadProtectionSource(source); return;
  }
  if (action === "security-protection-source") {
    await locateProtection(element.dataset.id, element.dataset.side === "response");
    return;
  }
  if (action === "security-trace-tab") {
    s.contentNavigation = null;
    t.tab = element.dataset.tab; render();
    if (t.tab === "body" && !s.bodyPage) await loadSecurityBody();
    return;
  }
  if (action === "security-history-page") {
    await loadHistoryRange(Number(element.dataset.start), Number(element.dataset.end), Number(element.dataset.offset)); return;
  }
  if (action === "security-content-view") {
    if (element.dataset.view === "folded") s.detail.historyRanges = {};
    await loadRetainedContent(0, false, element.dataset.view); return;
  }
  if (action === "security-content-new") {
    const content = s.detail?.requestContent;
    if (content?.firstNewIndex == null) return;
    if (content.view !== "folded" || content.offset) await loadRetainedContent(0, false, "folded");
    const index = s.detail.requestContent.firstNewIndex;
    pageContent.querySelector(`[data-content-index="${index}"]`)?.scrollIntoView({ block: "start", behavior: "instant" }); return;
  }
  if (["security-content-page", "security-response-content-page"].includes(action)) {
    s.contentNavigation = null;
    await loadRetainedContent(Number(element.dataset.offset), action === "security-response-content-page"); return;
  }
  if (["security-content-source", "security-response-content-source"].includes(action)) {
    const response = action === "security-response-content-source";
    const item = s.detail && retainedContentItems(s.detail, response).find(item => item.index === Number(element.dataset.index));
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
    pushNavigation({ page: "security-detail", list: securityListState(), returnToSecurityList: fromList }, `#security/audit/${encodeURIComponent(element.dataset.id)}`);
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
      s.bodySelection = { ...finding.bodyLocation, findingId: finding.id };
    } else if (action === "security-source") {
      const previous = s.bodySelection;
      const id = element.dataset.id;
      s.bodySelection = { snapshotId: s.detail.bodySnapshots?.find(snapshot => snapshot.id === id)?.originalSnapshotId || id, start: previous.sourceStart ?? previous.start, end: previous.sourceEnd ?? previous.end, findingId: previous.findingId };
    } else if (action === "security-body") {
      const id = element.dataset.id;
      s.bodySelection = { snapshotId: s.detail.bodySnapshots?.find(snapshot => snapshot.id === id)?.originalSnapshotId || id, ...(id.startsWith("stream/") ? { detectionSnapshotId: id } : { start: Number(element.dataset.offset || 0) }) };
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

function auditRetentionLabel(days) {
  return days == null ? "保存周期不设上限" : `保留 ${esc(days)} 天`;
}

function auditStorageLabel(bytes) {
  return bytes == null ? "存储不设上限" : `存储上限 ${esc(bytes / 1048576)} MiB`;
}

const MIN_AUDIT_BUDGET_MIB = 16;
const PROTECTION_TTL_UNITS = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

function protectionTtlSeconds(value, unit) {
  const seconds = Number(value) * (PROTECTION_TTL_UNITS[unit] || NaN);
  const rounded = Math.round(seconds);
  return Math.abs(seconds - rounded) < 1e-7 ? rounded : seconds;
}

function protectionTtlDisplay(seconds) {
  const unit = ["days", "hours", "minutes"].find(unit => seconds % PROTECTION_TTL_UNITS[unit] === 0) || "seconds";
  return { value: seconds / PROTECTION_TTL_UNITS[unit], unit };
}

function renderSettings() {
  const audit = state.config.audit;
  const cables = configurationCables(state.config);
  const protectionEnabled = state.config.credentialProtection?.enabled === true;
  const ttl = protectionTtlDisplay(state.config.credentialProtection?.mappingTtlSeconds || 3600);
  const nameCounts = new Map();
  cables.forEach(cable => nameCounts.set(cable.name, (nameCounts.get(cable.name) || 0) + 1));
  const storage = state.runtime?.security?.storage;
  const temporary = state.runtime?.temporaryStorage;
  return `<div class="settings-page">
    <section class="panel" aria-labelledby="audit-settings-title">
      <div class="panel-header"><h2 id="audit-settings-title">审计记录</h2>${storage ? `<span class="muted">已用 ${esc(((storage.bytes || 0) / 1048576).toFixed(1))} MiB</span>` : ""}</div>
      <form id="audit-settings-form">
        <div class="settings-row">
          <label for="audit-retention">保存周期</label>
          <div class="settings-control">
            <div class="settings-value"><input id="audit-retention" name="retentionDays" aria-label="保存周期（天）" type="number" min="1" max="9007199254740991" step="1" value="${esc(audit.retentionDays ?? 30)}" ${audit.retentionDays == null ? "disabled" : "required"}><span>天</span></div>
            <label class="settings-unlimited"><input name="retentionUnlimited" aria-label="保存周期不设上限" type="checkbox" ${audit.retentionDays == null ? "checked" : ""}><span>不限</span></label>
          </div>
        </div>
        <div class="settings-row">
          <label for="audit-budget">存储上限</label>
          <div class="settings-control">
            <div class="settings-value"><input id="audit-budget" name="budgetMiB" aria-label="存储上限（MiB）" type="number" min="${MIN_AUDIT_BUDGET_MIB}" max="${Number.MAX_SAFE_INTEGER / 1048576}" step="any" value="${esc(audit.budgetBytes == null ? 5120 : audit.budgetBytes / 1048576)}" ${audit.budgetBytes == null ? "disabled" : "required"}><span>MiB</span></div>
            <label class="settings-unlimited"><input name="storageUnlimited" aria-label="存储不设上限" type="checkbox" ${audit.budgetBytes == null ? "checked" : ""}><span>不限</span></label>
          </div>
        </div>
        <p class="settings-cleanup" id="audit-settings-cleanup" aria-live="polite" hidden>调低限制后，超出范围的历史记录将被清理。</p>
        <div class="settings-footer"><span class="muted">保存后立即生效</span><button class="button button-primary" type="submit">保存设置</button></div>
      </form>
    </section>
    <section class="panel" aria-labelledby="protection-settings-title">
      <form id="protection-settings-form" data-cable-context="${esc(JSON.stringify(cables.map(cable => [cable.id, cable.record.virtualProvider]).sort()))}">
        <div class="panel-header protection-settings-heading"><h2 id="protection-settings-title">凭据保护</h2><label class="settings-checkbox"><input id="protection-enabled" name="enabled" type="checkbox" ${protectionEnabled ? "checked" : ""}><span>启用凭据保护</span></label><p class="muted">发送前替换模型上下文中的 Key、Token，响应返回时还原。</p></div>
        <div class="protection-master">
          <details class="protection-scope"><summary>保护范围说明</summary><p class="muted">仅替换模型上下文中识别到的凭据。连接上游的身份认证仍使用真实凭据，本地审计记录保留凭据原文。</p></details>
        </div>
        <div class="settings-row">
          <fieldset class="protection-cables">
            <legend><span>配置保护线路</span><span class="muted" data-protection-count aria-live="polite">已选 ${cables.filter(cable => cable.virtualProvider.credentialProtection !== false).length} / ${cables.length} 条</span></legend>
            ${cables.length ? `<label class="settings-checkbox protection-select-all"><input type="checkbox" data-protection-all ${protectionEnabled ? "" : "disabled"}><span>全选线路</span></label>` : ""}
            <div class="protection-cable-list">${cables.length ? cables.map(cable => `<label class="settings-checkbox protection-cable"><input type="checkbox" name="cableProtection:${esc(cable.id)}" data-protection-cable="${esc(cable.id)}" data-protection-provider="${esc(cable.record.virtualProvider)}" ${cable.virtualProvider.credentialProtection !== false ? "checked" : ""} ${protectionEnabled ? "" : "disabled"}><span>${esc(cable.name)}<small>${esc(targetLabel(cable.target))}${nameCounts.get(cable.name) > 1 ? ` · ${esc(cable.id)}` : ""}</small></span></label>`).join("") : '<p class="muted">暂无线路</p>'}</div>
          </fieldset>
        </div>
        <div class="settings-row protection-ttl-row">
          <label for="protection-ttl">会话闲置有效期</label>
          <div class="protection-ttl-controls"><div class="settings-value"><input id="protection-ttl" name="mappingTtlValue" aria-label="会话闲置有效期数值" aria-describedby="protection-ttl-help" type="number" min="${60 / PROTECTION_TTL_UNITS[ttl.unit]}" max="${2592000 / PROTECTION_TTL_UNITS[ttl.unit]}" step="any" required value="${ttl.value}"></div><select name="mappingTtlUnit" aria-label="会话闲置有效期单位">${entries({ seconds: "秒", minutes: "分钟", hours: "小时", days: "天" }).map(([unit, label]) => `<option value="${unit}" ${unit === ttl.unit ? "selected" : ""}>${label}</option>`).join("")}</select></div>
          <p class="muted settings-help" id="protection-ttl-help">每次新请求重新计时；到期后，后续请求会建立新的凭据映射。</p>
        </div>
        <div class="settings-footer"><span class="muted">保存后对新请求生效。</span><button class="button button-primary" type="submit">保存设置</button></div>
      </form>
    </section>
    <section class="panel" aria-labelledby="temporary-settings-title">
      <div class="panel-header"><h2 id="temporary-settings-title">临时目录</h2></div>
      <form id="temporary-settings-form">
        <div class="settings-directory">
          <label for="temporary-directory">服务器目录</label>
          <input id="temporary-directory" name="temporaryDirectory" type="text" autocomplete="off" spellcheck="false" value="${esc(state.config.temporaryDirectory || "")}" placeholder="${esc(temporary?.defaultDirectory || "留空使用数据目录下的 tmp")}" aria-describedby="temporary-directory-help temporary-directory-requirements">
          <p class="muted" id="temporary-directory-help">用于暂存请求、响应和数据库查询文件。留空使用默认目录（CableTidy 数据目录下的 tmp）。</p>
          <p class="muted" id="temporary-directory-requirements">填写运行 CableTidy 的服务器上的绝对路径。目录须可写且仅运行 CableTidy 的用户可访问（Linux / macOS 权限为 0700）；不存在时会自动创建。</p>
          ${temporary?.activeDirectory ? `<p class="settings-active-directory">当前使用：<span>${esc(temporary.activeDirectory)}</span></p>` : ""}
          ${temporary?.restartRequired ? `<p class="notice warning" role="status">已保存新的临时目录，重启 CableTidy 后生效。重启前继续使用当前目录。</p>` : ""}
        </div>
        <div class="settings-footer"><span class="muted">保存后需重启 CableTidy 才会切换目录</span><button class="button button-primary" type="submit">保存临时目录</button></div>
      </form>
    </section>
  </div>`;
}

function syncAuditSettingsForm(form) {
  let reducing = false;
  for (const [name, toggle, key, unit] of [["retentionDays", "retentionUnlimited", "retentionDays", 1], ["budgetMiB", "storageUnlimited", "budgetBytes", 1048576]]) {
    const input = form.querySelector(`[name="${name}"]`);
    const unlimited = form.querySelector(`[name="${toggle}"]`).checked;
    setControlDisabled(input, unlimited);
    input.required = !unlimited;
    const next = Number(input.value) * unit;
    const saved = state.config.audit[key];
    reducing ||= !unlimited && next > 0 && (saved == null || next < saved);
  }
  form.querySelector("#audit-settings-cleanup").hidden = !reducing;
}

function saveAuditSettings(data) {
  const days = data.has("retentionUnlimited") ? null : Number(data.get("retentionDays"));
  const bytes = data.has("storageUnlimited") ? null : Number(data.get("budgetMiB")) * 1048576;
  if (days !== null && (!Number.isSafeInteger(days) || days < 1)) {
    throw new Error("保存周期必须是正整数天数，或选择不设上限。");
  }
  if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < MIN_AUDIT_BUDGET_MIB * 1048576)) {
    throw new Error(`存储上限必须至少为 ${MIN_AUDIT_BUDGET_MIB} MiB，且换算后的字节数须为有效整数，或选择不设上限。`);
  }
  state.candidate.audit = { ...state.candidate.audit, retentionDays: days, budgetBytes: bytes };
}

function syncProtectionSettingsForm(form) {
  const enabled = form.querySelector('[name="enabled"]').checked;
  const lines = [...form.querySelectorAll("[data-protection-cable]")];
  const selected = lines.filter(input => input.checked).length;
  const count = form.querySelector("[data-protection-count]");
  if (count) count.textContent = `已选 ${selected} / ${lines.length} 条`;
  lines.forEach(input => setControlDisabled(input, !enabled));
  const all = form.querySelector("[data-protection-all]");
  if (all) {
    all.checked = lines.length > 0 && selected === lines.length;
    all.indeterminate = selected > 0 && selected < lines.length;
    setControlDisabled(all, !enabled || !lines.length);
  }
  syncProtectionTtlForm(form);
}

function syncProtectionTtlForm(form) {
  const input = form.querySelector('[name="mappingTtlValue"]');
  const unit = form.querySelector('[name="mappingTtlUnit"]');
  if (!input || !unit) return;
  protectionTtlUnits.set(unit, unit.value);
  input.min = 60 / PROTECTION_TTL_UNITS[unit.value];
  input.max = 2592000 / PROTECTION_TTL_UNITS[unit.value];
  const seconds = protectionTtlSeconds(input.value, unit.value);
  input.setCustomValidity(Number.isInteger(seconds) && seconds >= 60 && seconds <= 2592000 ? "" : "会话闲置有效期须为 60 秒至 30 天，且换算后为整数秒。");
}

function saveProtectionSettings(data) {
  const seconds = protectionTtlSeconds(data.get("mappingTtlValue"), data.get("mappingTtlUnit"));
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 2592000) throw new Error("映射有效期须为 60 秒到 30 天之间的整数秒数。");
  const enabled = data.has("enabled");
  const selections = new Map();
  for (const cable of configurationCables(state.candidate)) {
    const selected = data.has(`cableProtection:${cable.id}`);
    const providerId = cable.record.virtualProvider;
    if (selections.has(providerId) && selections.get(providerId) !== selected) throw new Error("共用同一入口的线路须选择相同的凭据保护状态。");
    selections.set(providerId, selected);
  }
  for (const [providerId, selected] of selections) {
    state.candidate.virtualProviders[providerId].credentialProtection = selected;
  }
  state.candidate.credentialProtection = { ...state.candidate.credentialProtection, enabled, mappingTtlSeconds: seconds };
}

function saveTemporarySettings(data) {
  const directory = String(data.get("temporaryDirectory") || "").trim();
  state.candidate.temporaryDirectory = directory || null;
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
  return `<button class="list-row ${active ? "is-selected" : ""}" data-action="select-model" data-id="${esc(id)}"><div><h3>${esc(id)}</h3><p>${esc(id)} · ${(item.capabilities || []).join(" · ")}</p></div><span class="status-badge">当前线路</span></button>`;
}

function eventRow(event) {
  const details = [new Date(event.at).toLocaleString()];
  const target = event.data?.upstreamId || event.data?.virtualProviderId || event.data?.cableId;
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
      ${artifacts.conflicts?.length ? `<div class="notice warning">需要确认：这些字段与 CableTidy 上次应用的记录不一致：${esc(artifacts.conflicts.join(", "))}。点击“应用到 Claude Code”或“撤销接入”时，可选择是否覆盖。</div>` : ""}
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
    "create-cable", "import-cables", "export-cables", "open-cable", "back-overview", "select-model",
    "new-model", "open-advanced-models", "create-inventory-cable", "open-supplier", "new-supplier",
    "back-suppliers",
  ].includes(action)) {
    if (!confirmPageLeave()) return;
  }
  const unlock = lockControls();
  try {
    if (await inventoryAction(action,element)) return;
    if (["import-cables", "export-cables"].includes(action)) {
      state.transfer = { bundle: null, preview: null };
      state.page = action === "import-cables" ? "cable-import" : "cable-export";
      render();
    } else if (action === "refresh") {
      await refresh();
    } else if (action === "refresh-codex-models") {
      state.codexCatalog = await api("/codex/models?refresh=1");
      // Refresh choices without discarding unsaved form inputs or secrets.
      pageContent.querySelectorAll("[data-official-model]").forEach((select) => {
        select.innerHTML = officialModelOptions(select.value);
        updateOfficialModelHint(select);
        syncCodexMetadata(select.closest("[data-cable-model]"));
      });
      pageContent.querySelectorAll(".catalog-status").forEach((status) => {
        status.querySelector("span").textContent = state.codexCatalog.available ? `${state.codexCatalog.version} / ${state.codexCatalog.models.length} 个官方模型` : state.codexCatalog.error.message;
      });
      toast(state.codexCatalog.available ? "模型列表已刷新。" : state.codexCatalog.error.message, !state.codexCatalog.available);
    } else if (action === "reload-form") {
      if (!window.confirm("放弃此表单的本地修改并加载最新配置？")) return;
      render(captureEditedForms(element.closest("form")));
    } else if (action === "create-cable") {
      state.createTarget = "codex";
      state.selected.cable = null;
      state.page = "cable-create";
      render();
    } else if (action === "open-cable") {
      selectCable(element.dataset.id);
      state.page = "cable-detail";
      render();
    } else if (action === "back-overview") {
      state.transfer = { bundle: null, preview: null };
      state.page = "overview";
      render();
    } else if (action === "delete-cable") {
      const cable = configurationCables(state.config).find((item) => item.id === element.dataset.id);
      if (!cable) throw new Error("线路不存在，请刷新列表。");
      const clientHint = cable.target === "claude-code"
        ? "如已应用到 Claude Code，请先撤销接入或切换其他线路；删除不会自动恢复客户端设置。"
        : "如客户端仍在使用此线路，请先切换其他线路；删除不会自动恢复客户端设置。";
      const unsavedHint = hasUnsavedChanges() ? "\n当前未保存的修改也会丢失。" : "";
      if (!window.confirm(`确定删除线路「${cable.name}」？删除后立即生效，该线路的本地地址将停止服务。\n${clientHint}${unsavedHint}`)) return;
      await saveChanges(() => removeCable(cable.id), undefined, "配置已删除并生效。");
    } else if (action === "select-model") {
      state.selected.model = element.dataset.id;
      state.page = "models";
      render();
    } else if (action === "new-model") {
      state.selected.model = null;
      state.page = "models";
      render();
    } else if (action === "add-cable-model") {
      const list = pageContent.querySelector("#cable-model-list");
      if (!list) return;
      const wrapper = document.createElement("div");
      const cable = selectedCable();
      const upstreamId = cable?.upstreamId || null;
      wrapper.innerHTML = cableModelEditor(cable || {}, "", {
        ...(cable?.target === "codex" ? { codex: { metadataMode: "official" } } : cable?.target === "claude-code" ? {} : { capabilities: ["streaming", "tools", "reasoning"] }),
      }, upstreamId);
      const row = wrapper.firstElementChild;
      list.querySelector(".empty")?.remove();
      list.appendChild(row);
    } else if (action === "remove-cable-model") {
      element.closest("[data-cable-model]")?.remove();
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
    } else if (action === "export-isolated") {
      if (hasUnsavedChanges()) throw new Error("请先保存当前编辑，再导出配置。");
      const result = await api("/targets/isolated", {method:"POST", body:JSON.stringify({cableId:selectedCable().id})});
      const blob = new Blob([JSON.stringify(result.bundle, null, 2)], {type:"application/json"});
      const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "cabletidy-isolated-codex.json"; link.click(); URL.revokeObjectURL(link.href);
      toast("隔离配置已导出；按文件中的说明写入独立目录后启动 Codex。");
    } else if (action === "apply-target") {
      await applyTarget();
    } else if (action === "restore-target") {
      if (hasUnsavedChanges()) throw new Error("请先保存当前编辑，再撤销接入。");
      const cable = selectedCable();
      if (!["codex", "claude-code"].includes(cable?.target)) throw new Error("请选择 Codex 或 Claude Code 配置");
      if (!await changeTargetSettings("restore", cable.id)) return;
      if (cable.record.managedModels) state.runtime = await api("/runtime");
      state.artifactPreview = null;
      toast(`${targetLabel(cable.target)} 原接入配置已恢复，请重启客户端。`);
      render();
    } else if (action === "open-advanced-models") {
      state.page = "models";
      state.selected.model = selectedCable()?.modelIds?.[0] || null;
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
  if (form.getAttribute("id") === "protection-settings-form") {
    // Disabled lines retain their selections when the master switch is off.
    for (const input of form.querySelectorAll("[data-protection-cable]")) {
      if (input.checked) data.set(input.name, "on");
    }
  }
  const unlock = lockControls();
  const submitButton = form.querySelector('[type="submit"]');
  const buttonLabel = submitButton?.textContent;
  form.setAttribute("aria-busy", "true");
  form.querySelector("[data-form-feedback]")?.remove();
  try {
    // Inputs named "id" shadow the form.id property in the browser.
    const formId = form.getAttribute("id");
    if (formId === "cable-export-form") { await exportCables(data); return; }
    if (formId === "cable-import-form") { await importCables(data); return; }
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
    if (state.page === "supplier-create" && ["supplier-interface-form", "supplier-model-form"].includes(formId)) {
      await saveSupplierDraftResource(data, form);
      return;
    }
    const handlers = {
      "supplier-form": () => saveSupplier(data, form),
      "supplier-create-form": () => saveSupplierCreate(data, form),
      "supplier-interface-form": () => saveSupplierInterface(data, form),
      "supplier-model-form": () => saveSupplierModel(data),
      "inventory-cable-form": () => saveInventoryCable(data, form),
      "audit-settings-form": () => saveAuditSettings(data),
      "temporary-settings-form": () => saveTemporarySettings(data),
      "protection-settings-form": () => saveProtectionSettings(data),
      "cable-create-form": () => saveCableCreate(data, form),
      "cable-upstream-form": () => saveCableUpstream(data),
      "cable-models-form": () => saveCableModels(form),
      "claude-client-form": () => saveClaudeClient(data),
      "model-form": () => saveModel(data, form),
    };
    if (!handlers[formId]) throw new Error("无法保存此表单，请刷新页面后重试。");
    const successAlert = formId === "claude-client-form"
      ? "模型选择已保存。请点击“应用到 Claude Code”，重新应用配置后才会生效。"
      : "";
    await saveChanges(handlers[formId], form,
      formId === "temporary-settings-form" ? "临时目录已保存，重启 CableTidy 后生效。" : undefined,
      successAlert);
  } catch (error) {
    showFormError(form, error);
  } finally {
    if (submitButton) submitButton.textContent = buttonLabel;
    form.removeAttribute("aria-busy");
    unlock();
  }
}

function removeCable(id) {
  return { type: "cable.delete", cableId: id };
}

function removeModel(id) {
  return { type: "model.delete", cableId: selectedCable()?.id, modelId: id };
}

function saveCableModels(form) {
  const cable = selectedCable();
  if (!cable) throw new Error("找不到当前线路");
  const models = [...form.querySelectorAll("[data-cable-model]")].map(row => {
    const read = selector => row.querySelector(selector)?.value.trim() || "";
    const overrides = row.querySelector(`[data-cable-model-capabilities="${CSS.escape(cable.upstreamId)}"]`);
    const aliases = row.querySelector("[data-cable-model-aliases]");
    return {
      oldId: row.dataset.modelId || "",
      clientModelId: read("[data-cable-model-client]"),
      upstreamModelId: read(`[data-cable-model-upstream="${CSS.escape(cable.upstreamId)}"]`),
      capabilities: read("[data-cable-model-capabilities-common]"),
      ...(overrides ? { capabilityOverrides: overrides.value } : {}),
      ...(aliases ? { aliases: aliases.value } : {}),
      policy: modelPolicy(row),
    };
  });
  return { type: "models.replace", cableId: cable.id, models };
}

function claudeInputs(data) {
  return { ...Object.fromEntries(data), discoverModels: data.get("discoverModels") === "on" };
}

function saveClaudeClient(data) {
  return { type: "claude.save", cableId: selectedCable()?.id, data: claudeInputs(data) };
}

function saveCableCreate(data, form) {
  if (!String(data.get("upstreamSecret") || "").trim()) throw new Error("请填写上游 API Key");
  const models = [...form.querySelectorAll("[data-create-model]")].map(row => ({
    clientModelId: row.querySelector('[data-create-field="clientModelId"]')?.value.trim() || "",
    upstreamModelId: row.querySelector('[data-create-field="upstreamModelId"]')?.value.trim() || "",
  }));
  return { type: "cable.create", data: claudeInputs(data), models };
}

function saveCableUpstream(data) {
  return { type: "cable.upstream", cableId: selectedCable()?.id, data: Object.fromEntries(data) };
}

function saveModel(data) {
  return { type: "model.save", cableId: selectedCable()?.id, data: {
    ...Object.fromEntries(data), oldId: state.selected.model || "",
  } };
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
      cableId: state.selected.cable,
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
  const cable = selectedCable();
  if (!cable) throw new Error("请先选择一条线路。");
  const record = cable.record;
  if (!["codex", "claude-code"].includes(record?.target)) {
    await previewArtifacts();
    return;
  }
  const result = await changeTargetSettings("apply", cable.id);
  if (!result) return;
  if (cable.record.managedModels) state.runtime = await api("/runtime");
  state.artifactPreview = result.report ? {
    ...result.report,
    target: result.target,
    cableId: cable.id,
    mode: result.report.mode || "managed_proxy",
  } : null;
  toast(`${targetLabel(record.target)} 配置已应用，请重启客户端。`);
  render();
}

async function changeTargetSettings(action, cableId) {
  let confirmationToken;
  while (true) {
    try {
      return await api(`/targets/${action}`, {
        method: "POST",
        body: JSON.stringify({ cableId, confirmationToken }),
      });
    } catch (error) {
      const conflict = error.body?.error;
      if (conflict?.code !== "claude_settings_conflict" || !conflict.details?.confirmationToken) throw error;
      const details = conflict.details;
      const effect = action === "restore"
        ? "继续撤销将把接管字段恢复为首次接入 CableTidy 前的值，覆盖现有修改。写入前会自动备份。"
        : "继续应用将使用当前选择的配置覆盖现有修改，写入前会自动备份。";
      const changedAgain = confirmationToken ? "确认期间配置再次发生变化，请重新确认。\n\n" : "";
      const message = `${changedAgain}检测到以下字段与 CableTidy 上次应用的记录不一致，可能被手工或其他工具修改：\n\n${details.settingsPath}\n${details.fields.join("\n")}\n\n${effect}\n\n选择“确定”继续${action === "restore" ? "撤销" : "应用"}，选择“取消”保留当前文件。`;
      if (!window.confirm(message)) return null;
      confirmationToken = details.confirmationToken;
    }
  }
}

async function saveChanges(update, form, successMessage = "配置已保存并生效。", successAlert = "") {
  const previous = {
    page: state.page,
    selected: clone(state.selected),
    artifactPreview: state.artifactPreview,
    supplierId: state.supplierId,
    supplierModelId: state.supplierModelId,
    supplierEditor: state.supplierEditor,
  };
  const preservedForms = captureEditedForms(form);
  state.candidate = clone(state.config);
  try {
    const operation = update();
    // The commit endpoint validates and applies the change atomically.
    const result = await api("/config/commit", {
      method: "POST",
      body: JSON.stringify({
        baseRevision: state.config.revision,
        ...(operation ? { operation } : { config: state.candidate }),
      }),
    });
    state.config = result.config;
    state.runtime = result.runtime;
    if (operation?.type === "supplier.create") state.supplierDraft = null;
    state.candidate = clone(state.config);
    if (operation) {
      if (operation.type === "supplier.model.save") state.supplierModelId = operation.data.modelId;
      if (operation.type === "supplier.delete") state.supplierId = null;
      if (operation.type === "supplier.model.delete") state.supplierModelId = null;
      if (result.selection) {
        if (operation.type.startsWith("supplier.")) {
          state.supplierId = result.selection.supplierId;
          if (["supplier.model.save", "supplier.interface.save", "supplier.delete"].includes(operation.type)) state.supplierEditor = null;
        } else {
          selectCable(result.selection.cableId);
          const name = operation.type === "model.save" ? operation.data.clientModelId : null;
          if (name) state.selected.model = name;
        }
      } else state.selected = { cable: null, virtualProvider: null, model: null };
      if (operation.type !== "model.save") state.page = result.page || state.page;
    }
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

// Supplier inventory: service facts are maintained independently of Cable selections.
const COMPATIBLE_IDENTITIES = ["GLM-5.3", "GLM-5.3-Flash", "Kimi K3", "DeepSeek-V4-Pro", "DeepSeek-V4.1-Flash", "MiniMax M3"];
const SUPPLIER_CAPABILITIES = ["reasoning", "vision", "parallel_tool_calls"];
const SUPPLIER_TOOL_FORMS = {function:"JSON 函数工具", custom:"custom 文本工具"};
const TOKEN_LENGTH_UNITS = {tokens:0, K:3, M:6};
const TOKEN_LENGTH_SHORTCUTS = {
  contextWindow:["64K", "128K", "256K", "512K", "1M"],
  maxOutputTokens:["4K", "8K", "16K", "32K", "64K", "128K"],
};
function parseTokenLength(value, unit = "tokens") {
  const raw = String(value ?? "").trim();
  if (!raw) return {value:"",unit,tokens:null,error:""};
  const match = raw.length <= 64 && raw.match(/^(\d+(?:\.\d*)?|\.\d+)\s*(K|M|tokens?)?$/i);
  if (!match) return {value:raw,unit,tokens:null,error:"请输入正数，例如 128K、1.5M 或准确的 token 数。"};
  const suffix = match[2];
  if (suffix) unit = /^tokens?$/i.test(suffix) ? "tokens" : suffix.toUpperCase();
  const scale = TOKEN_LENGTH_UNITS[unit];
  if (scale === undefined) return {value:match[1],unit,tokens:null,error:"请选择 tokens、K tokens 或 M tokens。"};
  const [whole, fraction = ""] = match[1].split(".");
  const amount = BigInt((whole || "0") + fraction) * 10n ** BigInt(scale);
  const divisor = 10n ** BigInt(fraction.length);
  if (amount % divisor !== 0n) return {value:match[1],unit,tokens:null,error:"换算结果必须为整数 token，请调整小数位；不会自动舍入。"};
  const tokens = amount / divisor;
  if (tokens < 1n || tokens > BigInt(Number.MAX_SAFE_INTEGER)) return {value:match[1],unit,tokens:null,error:"token 数必须为正整数，且不能超过 9,007,199,254,740,991。"};
  return {value:match[1],unit,tokens:Number(tokens),error:""};
}
function tokenLengthDisplay(tokens) {
  if (tokens == null) return {value:"",unit:"tokens"};
  if (!Number.isSafeInteger(tokens) || tokens < 1) return {value:String(tokens),unit:"tokens"};
  const unit = tokens >= 1000000 ? "M" : tokens >= 1000 ? "K" : "tokens";
  const scale = TOKEN_LENGTH_UNITS[unit];
  const amount = BigInt(tokens), divisor = 10n ** BigInt(scale);
  const fraction = (amount % divisor).toString().padStart(scale, "0").replace(/0+$/, "");
  return {value:`${amount / divisor}${fraction ? `.${fraction}` : ""}`,unit};
}
function tokenLengthField(label, name, tokens, kind, inherited = false) {
  const {value,unit} = tokenLengthDisplay(tokens);
  const id = `supplier-token-${name}`;
  const empty = inherited ? "留空继承模型长度" : "留空表示未提供限制信息";
  return `<div class="field token-length-field" data-token-length data-token-empty="${empty}"><label for="${esc(id)}">${esc(label)}</label>
    <div class="token-length-controls"><input id="${esc(id)}" name="${esc(name)}" type="text" inputmode="decimal" value="${esc(value)}" placeholder="例如 ${kind === "contextWindow" ? "128K 或 128000" : "8K 或 8192"}" maxlength="64" aria-describedby="${esc(id)}-conversion" data-token-value><select name="${esc(name)}:unit" aria-label="${esc(label)}单位" data-token-unit>${entries(TOKEN_LENGTH_UNITS).map(([u]) => `<option value="${u}" ${u === unit ? "selected" : ""}>${u}</option>`).join("")}</select><output id="${esc(id)}-conversion" class="field-hint token-length-conversion" aria-live="polite" data-token-conversion>${empty}</output></div>
    <div class="token-shortcuts" role="group" aria-label="${esc(label)}快捷值">${TOKEN_LENGTH_SHORTCUTS[kind].map(shortcut => `<button class="mini-button token-shortcut" type="button" data-action="select-token-length" data-token-shortcut="${shortcut}" aria-pressed="false">${shortcut}</button>`).join("")}</div>
  </div>`;
}
function syncTokenLength(field) {
  const input = field.querySelector("[data-token-value]");
  const unit = field.querySelector("[data-token-unit]");
  const result = parseTokenLength(input.value, unit.value);
  if (result.value !== input.value) input.value = result.value;
  if (result.unit !== unit.value) unit.value = result.unit;
  input.setCustomValidity(field.closest("[data-interface-facts]")?.hidden ? "" : result.error);
  input.setAttribute("aria-invalid", String(Boolean(result.error)));
  field.querySelector("[data-token-conversion]").textContent = result.error || (result.tokens == null ? field.dataset.tokenEmpty
    : result.unit === "tokens" ? `${result.tokens.toLocaleString("en-US")} tokens`
      : `${result.value}${result.unit} = ${result.tokens.toLocaleString("en-US")} tokens`);
  for (const button of field.querySelectorAll("[data-token-shortcut]")) {
    button.setAttribute("aria-pressed", String(!result.error && result.tokens === parseTokenLength(button.dataset.tokenShortcut).tokens));
  }
}
function readTokenLength(data, name, label) {
  const result = parseTokenLength(data.get(name), data.get(`${name}:unit`) || "tokens");
  if (result.error) throw new Error(`${label}：${result.error}`);
  return result.tokens;
}
function mergeSupplierModelFields(base, local, remote) {
  const names = new Set(base.filter(field => /^(?:diff:.*:)?(?:contextWindow|maxOutputTokens)$/.test(field[0])).map(field => field[0]));
  const merged = [];
  for (const name of names) {
    const groups = [base,local,remote].map(fields => fields.filter(field => field[0] === name || field[0] === `${name}:unit`));
    const value = fields => {
      const raw = fields.find(field => field[0] === name)?.[4];
      const unit = fields.find(field => field[0] === `${name}:unit`)?.[4];
      const result = parseTokenLength(raw, unit);
      return result.error ? JSON.stringify([raw,unit]) : result.tokens;
    };
    const [before,ours,theirs] = groups.map(value);
    if (Object.is(ours,before)) merged.push(...groups[2]);
    else if (Object.is(theirs,before) || Object.is(ours,theirs)) merged.push(...groups[1]);
    else return null;
  }
  const other = mergeFormFields(...[base,local,remote].map(fields => fields.filter(field => !names.has(field[0]) && !names.has(field[0].replace(/:unit$/, "")))));
  return other && [...other,...merged];
}
function inventoryIdentities() {
  return [...new Set([...(state.codexCatalog?.models || []).map(m => m.id), ...COMPATIBLE_IDENTITIES])];
}
function protocolOptions(value = "openai.responses") {
  return ["openai.responses", "openai.chat_completions", "anthropic.messages", "gemini.generate_content"].map(p => `<option value="${p}" ${p === value ? "selected" : ""}>${p}${p !== "openai.responses" ? " · 首期不适配" : ""}</option>`).join("");
}
const SUPPLIER_AUTH_METHODS = {
  "openai.responses": [["bearer", "API Key / Bearer Token"], ["api-key", "API Key（Azure 兼容）"], ["none", "无需认证"]],
  "openai.chat_completions": [["bearer", "API Key / Bearer Token"], ["api-key", "API Key（Azure 兼容）"], ["none", "无需认证"]],
  "anthropic.messages": [["api-key", "API Key"], ["bearer", "Bearer Token"], ["none", "无需认证"]],
  "gemini.generate_content": [["api-key", "Gemini API Key"], ["bearer", "OAuth Access Token"], ["none", "无需认证"]],
};
function supplierAuthMethod(value) {
  if (value.authMethod) return value.authMethod;
  if (value.auth?.method) return value.auth.method;
  const protocol = value.protocol || "openai.responses";
  const header = (value.auth?.header || value.authHeader || (protocol === "anthropic.messages" ? "x-api-key" : "authorization")).toLowerCase();
  if (header === "authorization" && (value.auth?.scheme ?? "Bearer") === "Bearer") return "bearer";
  if (header === ({"anthropic.messages":"x-api-key", "gemini.generate_content":"x-goog-api-key"}[protocol] || "api-key")) return "api-key";
  return "existing";
}
function supplierAuthLabel(value) {
  return (SUPPLIER_AUTH_METHODS[value.protocol] || []).find(([method]) => method === supplierAuthMethod(value))?.[1] || "现有认证";
}
function supplierCredentialFields(protocol, method, configured = false, secret = "") {
  if (method === "none") return `<p class="field-hint">访问此接口时不发送认证凭据。</p>`;
  const label = method === "bearer" ? protocol === "gemini.generate_content" ? "OAuth Access Token" : "API Key / Bearer Token" : method === "existing" ? "认证凭据" : "API Key";
  return field(label, "secret", secret, configured ? "已配置，留空保留现有凭据" : "粘贴认证凭据", false, "password", false, !configured);
}
function supplierInterfaceFields(value = {}, editing = false) {
  const protocol = value.protocol || "openai.responses";
  const method = editing ? supplierAuthMethod(value) : SUPPLIER_AUTH_METHODS[protocol][0][0];
  const methods = [...SUPPLIER_AUTH_METHODS[protocol]];
  if (method === "existing") methods.push(["existing", "保留现有认证"]);
  return `<div data-supplier-interface data-secret-configured="${value.secretConfigured ? "true" : "false"}">
    <div class="form-grid">
      ${field("接口名称（可选）", "interfaceName", value.name || "", "例如官方 Responses")}
      <label class="field"><span>协议</span><select name="protocol">${protocolOptions(protocol)}</select></label>
      ${field("接口地址", "baseUrl", value.baseUrl || "", "https://api.example.com/v1", false, "url", false, true)}
      <label class="field"><span>认证方式</span><select name="authMethod">${methods.map(([id,label]) => `<option value="${id}" ${id === method ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <div data-supplier-credentials>${supplierCredentialFields(protocol, method, value.secretConfigured, value.secret || "")}</div>
    </div>
    <section class="subsection" aria-labelledby="supplier-interface-capabilities-title"><div class="subsection-header"><h3 id="supplier-interface-capabilities-title">接口能力</h3></div><div class="form-grid">
      <label class="settings-checkbox"><input type="checkbox" name="supportsStreaming" ${value.supportsStreaming !== false ? "checked" : ""}><span>支持流式响应</span></label>
      <label class="settings-checkbox"><input type="checkbox" name="supportsResponseIdContinuation" ${value.supportsResponseIdContinuation === true ? "checked" : ""}><span>支持响应 ID 续接</span></label>
    </div></section>
    <p class="field-hint">填写协议端点之前的根地址；认证参数由所选方式生成。能力开关是供给声明，默认值不表示已实测；历史发送方式由客户端适配决定。</p>
  </div>`;
}
function readSupplierInterface(form) {
  const row = form.querySelector("[data-supplier-interface]");
  const read = name => row.querySelector(`[name="${name}"]`)?.value.trim() || "";
  return {name:read("interfaceName"),protocol:read("protocol"),baseUrl:read("baseUrl"),authMethod:read("authMethod"),secret:read("secret"),supportsStreaming:row.querySelector('[name="supportsStreaming"]').checked,supportsResponseIdContinuation:row.querySelector('[name="supportsResponseIdContinuation"]').checked};
}
function supplierInterfaceFacts(iid, model, name) {
  const d = model.interfaceCapabilities?.[iid] || {};
  return `<div data-interface-facts="${esc(iid)}" ${(model.interfaces || []).includes(iid) || state.discoveredInterface === iid ? "" : "hidden"}>
    <div class="subsection-header"><h4>${esc(name || iid)}</h4></div>
    <fieldset class="checkbox-group"><legend>支持的工具形式</legend><div class="form-grid">${entries(SUPPLIER_TOOL_FORMS).map(([form,label]) => `<label class="settings-checkbox"><input type="checkbox" name="toolForms:${esc(iid)}" value="${form}" ${(d.toolForms || []).includes(form) ? "checked" : ""}><span>${label}</span></label>`).join("")}</div></fieldset>
    <details><summary>能力与限制差异</summary><div class="form-grid">
      ${tokenLengthField("接口上下文长度", `diff:${iid}:contextWindow`, d.contextWindow, "contextWindow", true)}${tokenLengthField("接口最大输出长度", `diff:${iid}:maxOutputTokens`, d.maxOutputTokens, "maxOutputTokens", true)}
      <label class="field"><span>流式响应例外</span><select name="diff:${esc(iid)}:supportsStreaming">${["", "unknown", "true", "false"].map(v => `<option value="${v}" ${v === (Object.hasOwn(d, "supportsStreaming") ? String(d.supportsStreaming ?? "unknown") : "") ? "selected" : ""}>${{"":"继承接口",unknown:"未确认",true:"支持",false:"不支持"}[v]}</option>`).join("")}</select></label>
      ${field("接口推理档位", `diff:${iid}:efforts`, (d.reasoning?.efforts || []).join(", "), "继承模型事实")}
    </div><p class="field-hint">K = 1,000 tokens；M = 1,000,000 tokens。准确的 token 数可直接选择 tokens 填写；留空继承模型。</p><fieldset class="checkbox-group"><legend>能力确认</legend><div class="checkbox-options">${SUPPLIER_CAPABILITIES.map(cap => supplierCapabilityCheckbox(cap, `diff:${iid}:cap:${cap}`, supplierCapabilitySupported(Object.hasOwn(d.capabilityStates || {}, cap) ? d : model, cap))).join("")}</div></fieldset><p class="field-hint">勾选表示支持，未勾选表示不支持。与模型公共值一致时继承，不同时保存为此接口的供给差异；长度留空时继承模型。</p></details>
  </div>`;
}
const SUPPLIER_CAPABILITY_LABELS = {reasoning:"推理", vision:"图片输入", parallel_tool_calls:"并行工具调用"};
function supplierCapabilitySupported(facts, cap) {
  const value = facts.capabilityStates?.[cap];
  return value ? value === "supported" : facts.capabilities?.includes(cap) === true;
}
function supplierCapabilityCheckbox(cap, name, supported) {
  return `<label class="settings-checkbox"><input type="checkbox" name="${esc(name)}" value="supported" ${supported ? "checked" : ""}><span>${esc(SUPPLIER_CAPABILITY_LABELS[cap])}</span></label>`;
}
function renderSuppliers() {
  const suppliers = state.config.suppliers || {};
  return `<div class="cable-toolbar"><span class="muted">${Object.keys(suppliers).length} 家供应商</span><button class="button button-primary" data-action="new-supplier">新建供应商</button></div>
    ${entries(suppliers).length ? `<div class="cable-list"><table class="cable-table"><thead><tr><th>供应商名称</th><th>状态</th><th>接口</th><th>模型</th><th>操作</th></tr></thead><tbody>${entries(suppliers).map(([id,s]) => `<tr><th scope="row"><button class="cable-name" data-action="open-supplier" data-id="${esc(id)}">${esc(s.name || id)}</button></th><td data-label="状态"><span class="status-badge ${s.enabled === false ? "warning" : ""}">${s.enabled === false ? "已停用" : "已启用"}</span></td><td data-label="接口">${Object.keys(s.interfaces || {}).length} 个接口</td><td data-label="模型">${Object.keys(s.models || {}).length} 个模型</td><td data-label="操作"><button class="button button-danger" data-action="delete-supplier" data-id="${esc(id)}">删除</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="panel empty-state-panel"><div class="empty"><strong>还没有供应商</strong>配置服务接口与模型后，在 Cable 中选择要使用的模型。</div></div>`}`;
}
function currentSupplier() {
  return state.page === "supplier-create" ? state.supplierDraft : state.config.suppliers?.[state.supplierId];
}
function renderSupplierCreate() {
  const supplier = state.supplierDraft;
  return `<button class="text-button" data-action="back-suppliers">返回列表</button>
    <form id="supplier-create-form" class="config-form supplier-page">
      <section class="panel" aria-labelledby="supplier-basics-title"><div class="panel-header"><h2 id="supplier-basics-title">基本信息</h2></div><div class="panel-body"><div class="form-grid">${field("供应商名称", "name", supplier.name, "例如 DeepSeek 官方", false, "text", false, true)}</div></div></section>
      ${renderSupplierInterfacesPanel(supplier, true)}
      ${renderSupplierModelsPanel(supplier, true)}
      <div class="config-form-footer panel"><span class="field-hint">接口和模型随供应商一起创建。</span><button class="button" type="button" data-action="back-suppliers">取消</button><button class="button button-primary" type="submit">创建供应商</button></div>
    </form>${state.supplierEditor ? renderSupplierEditor(supplier) : ""}`;
}
function renderSupplierDetail() {
  const sid = state.supplierId;
  const supplier = currentSupplier();
  if (!supplier) return `<div class="panel empty-state-panel"><div class="empty"><strong>供应商不存在</strong><button class="button" data-action="back-suppliers">返回列表</button></div></div>`;
  return `<div class="cable-toolbar"><button class="text-button" data-action="back-suppliers">返回列表</button><div class="cable-status"><span class="status-badge ${supplier.enabled === false ? "warning" : ""}">${supplier.enabled === false ? "已停用" : "已启用"}</span><button class="button button-danger" data-action="delete-supplier" data-id="${esc(sid)}">删除供应商</button></div></div>
    <section class="panel" aria-labelledby="supplier-basics-title"><div class="panel-header"><h2 id="supplier-basics-title">基本信息</h2></div><form id="supplier-form"><div class="panel-body"><div class="form-grid">${field("供应商名称", "name", supplier.name, "", false, "text", false, true)}<label class="field"><span>状态</span><select name="enabled"><option value="true" ${supplier.enabled !== false ? "selected" : ""}>启用</option><option value="false" ${supplier.enabled === false ? "selected" : ""}>停用</option></select></label></div></div><div class="config-form-footer"><span class="field-hint">修改名称不影响 Cable 的已有选择。</span><button class="button" type="submit">保存供应商</button></div></form></section>
    ${renderSupplierInterfacesPanel(supplier)}
    ${renderSupplierModelsPanel(supplier)}
    ${state.supplierEditor ? renderSupplierEditor(supplier) : ""}`;
}
function renderSupplierInterfacesPanel(supplier, creating = false) {
  return `<section class="panel" aria-labelledby="supplier-interfaces-title"><div class="panel-header"><div><h2 id="supplier-interfaces-title">接口</h2><p class="field-hint">管理此供应商提供的协议入口及认证。</p></div><button class="button" type="button" data-action="new-supplier-interface">添加接口</button></div><div class="panel-body">
    ${entries(supplier.interfaces).length ? `<div class="cable-list"><table class="cable-table supplier-interface-table"><thead><tr><th>接口名称</th><th>协议</th><th>地址</th><th>认证</th><th>操作</th></tr></thead><tbody>${entries(supplier.interfaces).map(([iid,i]) => `<tr><th scope="row"><button class="cable-name" type="button" data-action="edit-supplier-interface" data-id="${esc(iid)}">${esc(i.name || iid)}</button></th><td data-label="协议">${esc(i.protocol)}</td><td data-label="地址" class="mono">${esc(i.baseUrl)}</td><td data-label="认证">${esc(supplierAuthLabel(i))}<span class="cable-upstream">${supplierAuthMethod(i) === "none" ? "无需凭据" : i.secretConfigured || i.secret ? "凭据已配置" : "凭据未配置"}</span></td><td data-label="操作"><div class="resource-actions">${!creating ? `<button class="mini-button" type="button" data-action="test-upstream" data-id="${esc(`supplier.${state.supplierId}.${iid}`)}">测试连接</button>${i.protocol === "openai.responses" ? `<button class="mini-button" type="button" data-action="discover-supplier-models" data-id="${esc(JSON.stringify([state.supplierId,iid]))}">发现模型</button>` : ""}` : ""}<button class="mini-button" type="button" data-action="delete-supplier-interface" data-id="${esc(iid)}">删除</button></div></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">尚未添加接口。点击“添加接口”配置协议、地址及认证。</div>`}
    </div></section>`;
}
function renderSupplierModelsPanel(supplier, creating = false) {
  return `<section class="panel" aria-labelledby="supplier-models-title"><div class="panel-header"><div><h2 id="supplier-models-title">模型</h2><p class="field-hint">实际身份、能力和限制属于供给事实。</p></div><button class="button" type="button" data-action="new-supplier-model" ${creating && !entries(supplier.interfaces).length ? "disabled" : ""}>添加模型</button></div><div class="panel-body">
    ${entries(supplier.models).length ? `<div class="cable-list"><table class="cable-table"><thead><tr><th>上游模型 ID</th><th>实际模型身份</th><th>可访问接口</th><th>操作</th></tr></thead><tbody>${entries(supplier.models).map(([mid,m]) => `<tr><th scope="row"><button class="cable-name" type="button" data-action="edit-supplier-model" data-id="${esc(mid)}">${esc(mid)}</button></th><td data-label="实际模型身份">${esc(m.identity || "未知")}${m.version ? `<span class="cable-upstream">${esc(m.version)}</span>` : ""}</td><td data-label="可访问接口">${esc((m.interfaces || []).map(iid => supplier.interfaces[iid]?.name || iid).join("、"))}</td><td data-label="操作"><div class="resource-actions"><button class="mini-button" type="button" data-action="delete-supplier-model" data-id="${esc(mid)}">删除</button></div></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${creating && !entries(supplier.interfaces).length ? "先添加接口，再录入该接口可访问的模型。" : "尚未添加模型。点击“添加模型”填写供给事实。"}</div>`}
    ${!creating && state.discoveredModels.length ? `<div class="subsection"><div class="subsection-header"><h3>发现的模型</h3></div><p class="field-hint">仅为候选，需要确认供给事实后保存，不会自动加入 Cable。</p><div class="resource-actions">${state.discoveredModels.map(m => `<button class="button" type="button" data-action="use-discovered-model" data-id="${esc(m.id)}">${esc(m.id)}</button>`).join("")}</div></div>` : ""}
    </div></section>`;
}
function renderSupplierEditor(supplier) {
  const editor = state.supplierEditor;
  const contents = editor.kind === "model" ? renderSupplierModelForm(supplier) : `<form id="supplier-interface-form" class="config-form supplier-modal-form"><div class="panel-header"><h2 id="supplier-resource-title">${editor.id ? "编辑接口" : "添加接口"}</h2><button class="mini-button" type="button" data-action="close-supplier-editor" aria-label="关闭表单">关闭</button></div><div class="supplier-modal-body"><input type="hidden" name="interfaceId" value="${esc(editor.id || "")}">${supplierInterfaceFields(supplier.interfaces[editor.id] || {}, Boolean(editor.id))}</div><div class="config-form-footer"><button class="button" type="button" data-action="close-supplier-editor">取消</button><button class="button button-primary" type="submit">保存接口</button></div></form>`;
  return `<dialog id="supplier-resource-dialog" class="supplier-resource-dialog" aria-labelledby="supplier-resource-title">${contents}</dialog>`;
}
function renderSupplierModelForm(supplier) {
  const mid = state.supplierEditor.id;
  const model = supplier.models?.[mid] || {};
  const capabilityFields = SUPPLIER_CAPABILITIES.map(cap => supplierCapabilityCheckbox(cap, `cap:${cap}`, supplierCapabilitySupported(model, cap))).join("");
  return `    <form id="supplier-model-form" class="config-form supplier-modal-form"><div class="panel-header"><h2 id="supplier-resource-title">${mid ? "编辑模型" : "添加模型"}</h2><button class="mini-button" type="button" data-action="close-supplier-editor" aria-label="关闭表单">关闭</button></div><div class="supplier-modal-body">
      <input type="hidden" name="oldModelId" value="${esc(mid || "")}">
      <div class="form-grid">${field("上游模型 ID", "modelId", mid || state.discoveredSelection || "", "请求上游时使用的标识", false, "text", false, true)}
        <label class="field"><span>实际模型身份</span><input name="identity" list="inventory-identities" value="${esc(model.identity || "")}" placeholder="留空为未知"><datalist id="inventory-identities">${inventoryIdentities().map(id => `<option value="${esc(id)}">`).join("")}</datalist></label>
        ${field("实际版本（可选）", "version", model.version || "", "")}${field("身份依据（可选）", "identitySource", model.identitySource || "", "官方文档或接口声明")}
      </div>
      <section class="subsection" aria-labelledby="supplier-model-interfaces-title"><div class="subsection-header"><h3 id="supplier-model-interfaces-title">可访问接口</h3></div>
        ${entries(supplier.interfaces || {}).length ? `<div class="cable-list"><table class="cable-table supplier-model-interface-table" aria-labelledby="supplier-model-interfaces-title"><thead><tr><th scope="col">选择</th><th scope="col">名称</th><th scope="col">协议类型</th><th scope="col">接口地址</th></tr></thead><tbody>${entries(supplier.interfaces).map(([id,i]) => `<tr><td data-label="选择"><label class="settings-checkbox"><input type="checkbox" name="interfaces" value="${esc(id)}" aria-label="选择接口 ${esc(i.name || id)}" ${(model.interfaces || []).includes(id) || state.discoveredInterface === id ? "checked" : ""}></label></td><th scope="row">${esc(i.name || id)}</th><td data-label="协议类型">${esc(i.protocol)}</td><td data-label="接口地址" class="mono">${esc(i.baseUrl)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="field-hint">尚未配置接口，请先在供应商中添加接口。</p>'}
      </section>
      <section class="subsection"><div class="subsection-header"><h3>能力与限制</h3></div><div class="form-grid">${tokenLengthField("上下文长度", "contextWindow", model.contextWindow, "contextWindow")}${tokenLengthField("最大输出长度", "maxOutputTokens", model.maxOutputTokens, "maxOutputTokens")}</div>
      <p class="field-hint">K = 1,000 tokens；M = 1,000,000 tokens。供应商给出准确 token 数时，可直接选择 tokens 填写。</p>
      <fieldset class="checkbox-group"><legend>能力确认</legend><div class="checkbox-options">${capabilityFields}</div></fieldset><p class="field-hint">勾选表示支持该能力，未勾选表示不支持。</p>
      </section><section class="subsection"><div class="subsection-header"><h3>推理控制事实</h3></div><fieldset class="checkbox-group"><legend>支持的控制方式</legend><div class="checkbox-options">${["effort","toggle","budget"].map(mode => `<label class="settings-checkbox"><input type="checkbox" name="reasoningModes" value="${mode}" ${(model.reasoning?.modes || []).includes(mode) ? "checked" : ""}><span>${{effort:"档位",toggle:"开关",budget:"预算"}[mode]}</span></label>`).join("")}</div></fieldset>
      <div class="form-grid">${field("Responses 接受的推理档位", "efforts", (model.reasoning?.efforts || []).join(", "), "none, low, high, max")}${field("默认档位", "defaultEffort", model.reasoning?.default || "", "未知可留空")}${field("预算单位", "budgetUnit", model.reasoning?.budget?.unit || "", "tokens")}${field("最小预算", "budgetMin", model.reasoning?.budget?.min || "", "", false, "number")}${field("最大预算", "budgetMax", model.reasoning?.budget?.max || "", "", false, "number")}</div>
      <div class="form-grid"><label class="field"><span>推理开关默认状态</span><select name="defaultToggle">${["unknown", "true", "false"].map(v => `<option value="${v}" ${v === String(model.reasoning?.toggle ?? "unknown") ? "selected" : ""}>${{unknown:"未确认",true:"开启",false:"关闭"}[v]}</option>`).join("")}</select></label>${field("默认预算", "budgetDefault", model.reasoning?.budget?.default ?? "", "未确认可留空", false, "number")}</div>
      <p class="field-hint">这里只维护供给事实。客户端仅开放代码已实现的推理控制方式。</p>
      </section><section class="subsection"><div class="subsection-header"><h3>接口供给能力</h3></div>
      <p class="field-hint">按所选接口分别声明工具形式；未勾选表示不支持工具调用，custom 不从普通工具能力推断。只在存在差异时填写其他例外。</p>
      <div class="cable-model-list">${entries(supplier.interfaces || {}).map(([iid,i]) => supplierInterfaceFacts(iid, model, i.name)).join("")}</div>
      </section><section class="subsection"><div class="subsection-header"><h3>供给验证</h3></div>
      <label class="field"><span>真实供给验证记录</span><select name="validation">${["unverified", "partial", "manual-pass"].map(v => `<option value="${v}" ${v === (model.validation || "unverified") ? "selected" : ""}>${{unverified:"未实测",partial:"部分通过", "manual-pass":"已手动验证"}[v]}</option>`).join("")}</select></label>
      </section></div><div class="config-form-footer"><button class="button" type="button" data-action="close-supplier-editor">取消</button><button class="button button-primary" type="submit">保存模型</button></div>
    </form>`;
}
function saveSupplier(data) {
  return {type:"supplier.metadata.save",supplierId:state.supplierId,data:{name:String(data.get("name") || "").trim(),enabled:data.get("enabled") === "true"}};
}
function saveSupplierCreate(data, form) {
  return {type:"supplier.create",data:{name:String(data.get("name") || "").trim(),interfaces:clone(state.supplierDraft.interfaces),models:clone(state.supplierDraft.models)}};
}
async function saveSupplierDraftResource(data, form) {
  const draft = clone(state.supplierDraft);
  if (form.getAttribute("id") === "supplier-interface-form") {
    const value = readSupplierInterface(form);
    const base = {"openai.responses":"responses", "openai.chat_completions":"chat", "anthropic.messages":"messages", "gemini.generate_content":"gemini"}[value.protocol];
    let iid = String(data.get("interfaceId") || base);
    if (!data.get("interfaceId")) {
      let suffix = 2;
      while (draft.interfaces[iid]) iid = `${base}-${suffix++}`;
    }
    draft.interfaces[iid] = value;
  } else {
    const operation = saveSupplierModel(data);
    const {modelId, oldModelId, model} = operation.data;
    if (!modelId || modelId !== oldModelId && draft.models[modelId]) throw new Error("上游模型 ID 不能为空或重复。");
    if (oldModelId && oldModelId !== modelId) delete draft.models[oldModelId];
    draft.models[modelId] = model;
  }
  // Validate supply facts without storing the supplier or its credentials.
  const candidate = clone(state.config);
  let sid = "supplier-draft";
  while (candidate.suppliers[sid]) sid += "-2";
  candidate.suppliers[sid] = {
    name:draft.name || "新建供应商",
    interfaces:Object.fromEntries(entries(draft.interfaces).map(([iid, value]) => [iid, {name:value.name,protocol:value.protocol,baseUrl:value.baseUrl,supportsStreaming:value.supportsStreaming,supportsResponseIdContinuation:value.supportsResponseIdContinuation}])),
    models:draft.models,
  };
  await api("/config/validate", {method:"POST",body:JSON.stringify({config:candidate})});
  state.supplierDraft = draft;
  state.supplierEditor = null;
  render(captureEditedForms(form));
}
function deleteSupplierDraftResource(kind, id) {
  if (kind === "interface" && values(state.supplierDraft.models).some(model => model.interfaces.includes(id))) {
    throw new Error("接口仍被模型使用，请先修改模型的可访问接口。");
  }
  delete state.supplierDraft[kind === "interface" ? "interfaces" : "models"][id];
  render(captureEditedForms());
}
pageContent.addEventListener("input", event => {
  if (state.page === "supplier-create" && event.target.closest("#supplier-create-form") && event.target.name === "name") state.supplierDraft.name = event.target.value;
});
function saveSupplierInterface(data, form) {
  return {type:"supplier.interface.save",supplierId:state.supplierId,data:{interfaceId:data.get("interfaceId"),interface:readSupplierInterface(form)}};
}
function closeSupplierEditor() {
  const form = pageContent.querySelector("#supplier-resource-dialog form");
  if (form && isFormEdited(form) && !window.confirm("有未保存的修改，确定放弃？")) return;
  state.supplierEditor = null;
  pageContent.querySelector("#supplier-resource-dialog")?.remove();
}
function saveSupplierModel(data) {
  const old = currentSupplier()?.models?.[data.get("oldModelId")] || {};
  const nextId = String(data.get("modelId") || "").trim();
  if (state.page !== "supplier-create" && data.get("oldModelId") && nextId !== data.get("oldModelId") && !window.confirm("修改上游模型 ID 将移除旧记录。旧 Cable 引用将报“来源不存在”，需要在 Cable 中重新配置。继续？")) throw new Error("已取消修改。");
  const number = name => data.get(name) ? Number(data.get(name)) : null;
  const capabilityStates = Object.fromEntries(SUPPLIER_CAPABILITIES.map(cap => [cap,data.has(`cap:${cap}`) ? "supported" : "unsupported"]));
  const model = { ...clone(old), identity:String(data.get("identity") || "").trim() || null,version:data.get("version") || null,identitySource:data.get("identitySource") || null,interfaces:data.getAll("interfaces"),capabilityStates,contextWindow:readTokenLength(data,"contextWindow","上下文长度"),maxOutputTokens:readTokenLength(data,"maxOutputTokens","最大输出长度"),inputModalities:capabilityStates.vision === "supported" ? ["text","image"] : ["text"],reasoning:{modes:data.getAll("reasoningModes"),efforts:String(data.get("efforts") || "").split(",").map(v => v.trim()).filter(Boolean),default:data.get("defaultEffort") || null,budget:{unit:data.get("budgetUnit") || null,min:number("budgetMin"),max:number("budgetMax")}} };
  delete model.history;
  delete model.capabilities;
  const differences = {};
  model.reasoning.toggle = data.get("defaultToggle") === "unknown" ? null : data.get("defaultToggle") === "true";
  model.reasoning.budget.default = number("budgetDefault");
  model.validation = data.get("validation") || "unverified";
  for (const iid of data.getAll("interfaces")) {
    const d = clone(old.interfaceCapabilities?.[iid] || {});
    delete d.history;
    delete d.capabilities;
    d.toolForms = data.getAll(`toolForms:${iid}`);
    const streaming = data.get(`diff:${iid}:supportsStreaming`);
    if (streaming) d.supportsStreaming = streaming === "unknown" ? null : streaming === "true"; else delete d.supportsStreaming;
    const states = Object.fromEntries(SUPPLIER_CAPABILITIES.map(cap => [cap, data.has(`diff:${iid}:cap:${cap}`) ? "supported" : "unsupported"]).filter(([cap,v]) => v !== capabilityStates[cap]));
    if (Object.keys(states).length) d.capabilityStates = states; else delete d.capabilityStates;
    for (const key of ["contextWindow", "maxOutputTokens"]) { const v = readTokenLength(data,`diff:${iid}:${key}`,key === "contextWindow" ? "接口上下文长度" : "接口最大输出长度"); if (v != null) d[key] = v; else delete d[key]; }
    const efforts = String(data.get(`diff:${iid}:efforts`) || "").split(",").map(v => v.trim()).filter(Boolean);
    if (efforts.length) d.reasoning = {...d.reasoning, modes:[...new Set([...(d.reasoning?.modes || []), "effort"])], efforts};
    else if (d.reasoning) {
      delete d.reasoning.efforts;
      if ((d.reasoning.modes || []).includes("effort")) {
        d.reasoning.modes = d.reasoning.modes.filter(mode => mode !== "effort");
        delete d.reasoning.default;
      }
      if (!d.reasoning.modes?.length && !d.reasoning.budget && d.reasoning.toggle == null) delete d.reasoning;
    }
    if (Object.keys(d).length) differences[iid] = d;
  }
  model.interfaceCapabilities = differences;
  return { type:"supplier.model.save",supplierId:state.supplierId,data:{oldModelId:data.get("oldModelId"),modelId:nextId,model} };
}
function inventorySourceLabel(source) {
  const supplier = state.config.suppliers?.[source.supplierId];
  return `${supplier?.name || source.supplierId} / ${source.modelId} / ${supplier?.interfaces?.[source.interfaceId]?.name || source.interfaceId}`;
}
function inventoryInterfaceOptions(sid, ids, selected) {
  return ids.map(id => `<option value="${esc(id)}" ${id === selected ? "selected" : ""}>${esc(state.config.suppliers?.[sid]?.interfaces?.[id]?.name || id)}</option>`).join("");
}
function inventoryBindingRow(name = "", binding = {}) {
  const profile = selectedCable()?.virtualProvider.models?.[name];
  const identity = state.config.suppliers?.[binding.sources?.[0]?.supplierId]?.models?.[binding.sources?.[0]?.modelId]?.identity;
  const policies = identity?.startsWith("gpt-") ? ["default", "native"] : COMPATIBLE_IDENTITIES.includes(identity) ? ["default", "compatible", "compatible-concise"] : ["default"];
  if (binding.promptStrategy && !policies.includes(binding.promptStrategy)) policies.push(binding.promptStrategy);
  return `<div class="subsection" data-inventory-binding data-old-id="${esc(name)}"><div class="form-grid">
    ${field("客户端模型 ID", "clientId", name, "例如 deepseek-pro")}${field("显示名称", "displayName", binding.name || "", "")}
    <label class="field"><span>提示词策略</span><select name="promptStrategy">${policies.map(v => `<option value="${v}" ${v === (binding.promptStrategy || "default") ? "selected" : ""}>${{default:"默认（按实际模型身份）",native:"客户端原生",compatible:"内置兼容", "compatible-concise":"内置兼容 · 简洁"}[v]}</option>`).join("")}</select></label>
    ${field("别名（逗号分隔）", "aliases", (binding.aliases || []).join(", "), "")}
    <label class="field"><span>手动使用来源</span><select name="activeSource">${(binding.sources || []).map((s,i) => `<option value="${i}" ${i === (binding.activeSource || 0) ? "selected" : ""}>${esc(inventorySourceLabel(s))}</option>`).join("")}</select></label>
  </div><p class="field-hint">${esc(profile?.sourceError || profile?.adaptationError || "默认策略按实际模型身份选择；兼容模板与工具约定配套，目录需重新应用后生效。")}</p>
  ${profile && !profile.sourceError ? `<p class="field-hint">实际身份：${esc(profile.identity || "未知")} · 访问协议：${esc(profile.interfaceProtocol)} · 上下文：${esc(profile.contextWindow || "未确认")} · 输出上限：${esc(profile.maxOutputTokens || "未确认")}<br>声明能力：${esc((profile.capabilities || []).map(cap => SUPPLIER_CAPABILITY_LABELS[cap] || {streaming:"流式响应",tools:"工具调用"}[cap] || cap).join("、") || "无")} · 工具形式：${esc((profile.toolForms || []).map(form => SUPPLIER_TOOL_FORMS[form]).join("、") || "无")} · 推理控制：${esc((profile.reasoning?.modes || []).join("、") || "未确认")} · 档位：${esc((profile.reasoning?.efforts || []).join("、") || "无")}<br>适配状态：${profile.sourceEnabled === false ? "来源已停用" : profile.adaptationError ? "暂不可用" : profile.identity?.startsWith("gpt-") ? "应用时校验本机原生定义" : "内置规则已实现"} · 真实供给验证：${esc(profile.validation || "未实测")}</p>` : ""}
  <div data-inventory-sources>${(binding.sources || []).map(s => inventorySourceRow(s)).join("")}</div>
  <div class="form-actions"><button class="button" type="button" data-action="add-binding-source">添加来源</button><button class="text-button" type="button" data-action="remove-binding">移除模型绑定</button></div></div>`;
}
function inventorySourceRow(source = {}, selected = null) {
  const allowed = selected || selectedCable()?.record.suppliers || [];
  const sid = source.supplierId || allowed[0] || "";
  const supplier = state.config.suppliers?.[sid];
  const mid = source.modelId || Object.keys(supplier?.models || {})[0] || "";
  const model = supplier?.models?.[mid];
  return `<div class="form-grid" data-inventory-source><label class="field"><span>供应商</span><select name="sourceSupplier">${[...new Set([sid,...allowed])].filter(Boolean).map(id => `<option value="${esc(id)}" ${id === sid ? "selected" : ""}>${esc(state.config.suppliers?.[id]?.name || id)}</option>`).join("")}</select></label>
    <label class="field"><span>上游模型 ID</span><select name="sourceModel">${optionList([...new Set([mid,...Object.keys(supplier?.models || {})])].filter(Boolean),mid)}</select></label>
    <label class="field"><span>访问接口</span><select name="sourceInterface">${inventoryInterfaceOptions(sid,[...new Set([source.interfaceId,...(model?.interfaces || [])])].filter(Boolean),source.interfaceId || model?.interfaces?.[0])}</select></label><button class="text-button" type="button" data-action="remove-binding-source">移除来源</button></div>`;
}
function renderInventoryCable(cable) {
  const record = cable?.record || {};
  const suppliers = state.config.suppliers || {};
  const selected = new Set(record.suppliers || []);
  const activation = state.runtime?.clientActivation?.codex;
  const activationText = cable && activation?.cableId === cable.id ? activation.status === "active" ? "当前激活的 Codex 配置" : "Codex 受管理字段已变化，请核对配置" : activation?.cableId ? `Codex 当前激活 Cable：${activation.cableId}` : "尚未激活到 Codex 配置";
  const sectionClass = cable ? "cable-section" : "config-section";
  return `<div class="cable-toolbar"><button class="text-button" data-action="back-overview">返回列表</button>${cable ? `<div class="cable-status"><span>Codex · ${Object.keys(record.models || {}).length} 个模型</span><span class="status-badge ${cable.virtualProvider.enabled === false ? "warning" : ""}">${cable.virtualProvider.enabled === false ? "已暂停" : "服务已启动"}</span><button class="button button-danger" type="button" data-action="delete-cable" data-id="${esc(cable.id)}">删除线路</button></div>` : ""}</div>
    <form id="inventory-cable-form" class="${cable ? "panel cable-editor" : "config-form panel"}" data-cable-id="${esc(cable?.id || "")}">
      ${!cable ? `<section class="config-section"><h2>基本信息</h2><div class="form-grid">${field("线路名称", "name", "", "codex-work")}<label class="field"><span>客户端</span><select disabled><option>Codex</option></select></label></div></section>` : ""}
      <section class="${sectionClass}"><div class="cable-section-heading"><h2>供应商</h2><p>同一客户端可创建多条线路。模型只在显式选择后加入。</p></div>
        <fieldset class="checkbox-group"><legend>选择供应商</legend><div class="checkbox-options">${entries(suppliers).map(([sid,s]) => `<label class="settings-checkbox"><input type="checkbox" name="suppliers" value="${esc(sid)}" ${selected.has(sid) ? "checked" : ""}><span>${esc(s.name || sid)}</span></label>`).join("") || `<p class="field-hint">请先在供应商页面配置接口与模型。</p>`}</div></fieldset>
      </section>
      <section class="${sectionClass}"><div class="cable-section-heading"><h2>选择模型</h2><p>发现和同步目录不会扩大此线路开放的模型。</p></div>
        <label class="field"><span>搜索模型</span><input type="search" data-inventory-filter placeholder="搜索模型 ID 或实际身份"></label>
        <div class="form-actions"><button class="button" type="button" data-action="select-inventory-filter">选择当前筛选结果</button><button class="button" type="button" data-action="clear-inventory-selection">清空勾选</button><button class="button" type="button" data-action="add-selected-inventory-models">将勾选模型加入绑定</button></div>
        <div class="cable-model-list" data-inventory-candidates>${entries(suppliers).map(([sid,s]) => `<section class="subsection" data-inventory-supplier="${esc(sid)}" aria-label="${esc(s.name || sid)}" ${selected.has(sid) ? "" : "hidden"}><div class="subsection-header"><h3>${esc(s.name || sid)}</h3></div><div class="cable-model-list">${entries(s.models || {}).map(([mid,m]) => `<div class="form-grid" data-inventory-candidate data-search="${esc(`${mid} ${m.identity || ""}`.toLowerCase())}"><label class="settings-checkbox"><input type="checkbox" name="candidate" value="${esc(JSON.stringify([sid,mid]))}"><span>${esc(mid)} · ${esc(m.identity || "身份未知")}</span></label><label class="field"><span>访问接口</span><select data-candidate-interface>${(m.interfaces || []).map(iid => `<option value="${esc(iid)}" ${s.interfaces?.[iid]?.protocol !== "openai.responses" ? "disabled" : ""}>${esc(s.interfaces?.[iid]?.name || iid)} · ${esc(s.interfaces?.[iid]?.protocol)}</option>`).join("")}</select></label></div>`).join("") || '<p class="field-hint">此供应商尚未配置模型。</p>'}</div></section>`).join("")}</div>
      </section>
      <section class="${sectionClass}"><div class="cable-section-heading"><h2>已开放模型与来源</h2><p>在模型绑定中设置客户端 ID、来源及内置提示词策略。</p></div><div id="inventory-binding-list" class="cable-model-list">${entries(record.models || {}).map(([name,b]) => inventoryBindingRow(name,b)).join("")}</div></section>
      <section class="${sectionClass}"><div class="cable-section-heading"><h2>默认模型</h2></div><div class="form-grid"><label class="field"><span>默认模型</span><select name="defaultModel"><option value="">未设置</option>${optionList(Object.keys(record.models || {}),record.defaultModel)}</select></label></div></section>
      <div class="config-form-footer"><span class="field-hint">保存配置后，可预览并应用到客户端。</span><button class="button" type="button" data-action="back-overview">取消</button><button class="button button-primary" type="submit">保存 Cable</button></div>
    </form>
    ${cable ? `<section class="panel"><div class="panel-header"><div><h2>客户端配置</h2><p class="field-hint">${esc(activationText)}</p></div><div class="resource-actions"><button class="button" data-action="preview-artifacts">预览客户端配置</button><button class="button button-primary" data-action="apply-target">应用到 Codex</button><button class="button" data-action="restore-target">撤销接入</button></div></div><div class="panel-body"><dl class="cable-connection-facts"><div><dt>本地接口地址</dt><dd class="mono">${esc(cableEndpoint(cable))}</dd></div><div><dt>提示词生效范围</dt><dd>按模型目录生效，更新目录后重启 Codex。</dd></div></dl><p class="field-hint">多来源首期仅支持手动选择；切换来源后使用新会话。</p><div class="form-actions"><button class="button" data-action="export-isolated">导出隔离启动配置</button><button class="button" data-action="toggle-vp" data-id="${esc(cable.record.virtualProvider)}">${cable.virtualProvider.enabled === false ? "启动服务" : "暂停服务"}</button></div></div></section>${state.artifactPreview ? artifactPanel(state.artifactPreview) : ""}` : ""}`;
}
function saveInventoryCable(data, form) {
  const models = {};
  for (const row of form.querySelectorAll("[data-inventory-binding]")) {
    const read = name => row.querySelector(`[name="${name}"]`)?.value.trim() || "";
    const name = read("clientId");
    if (!name || models[name]) throw new Error("客户端模型 ID 不能为空或重复。");
    const sources = [...row.querySelectorAll("[data-inventory-source]")].map(s => ({supplierId:s.querySelector('[name="sourceSupplier"]').value,modelId:s.querySelector('[name="sourceModel"]').value,interfaceId:s.querySelector('[name="sourceInterface"]').value}));
    const old = state.config.cables?.[form.dataset.cableId]?.models?.[row.dataset.oldId] || {};
    models[name] = {...clone(old),name:read("displayName"),sources:sources.map(s => ({...clone(old.sources?.find(previous => previous.supplierId === s.supplierId && previous.modelId === s.modelId && previous.interfaceId === s.interfaceId) || {}),...s})),aliases:read("aliases").split(",").map(s => s.trim()).filter(Boolean),promptStrategy:read("promptStrategy"),activeSource:Number(read("activeSource") || 0)};
  }
  return {type:form.dataset.cableId ? "cable.inventory.save" : "cable.inventory.create",cableId:form.dataset.cableId,data:{name:data.get("name"),suppliers:data.getAll("suppliers"),models,defaultModel:data.get("defaultModel")}};
}
function syncInventoryDefaults(form) {
  const select = form.querySelector('[name="defaultModel"]');
  const ids = [...form.querySelectorAll('[data-inventory-binding] [name="clientId"]')].map(n => n.value.trim()).filter(Boolean);
  if (select) select.innerHTML = `<option value="">未设置</option>${optionList(ids,select.value)}`;
  for (const row of form.querySelectorAll("[data-inventory-binding]")) {
    const choice = row.querySelector('[name="activeSource"]');
    const old = choice?.value;
    if (choice) choice.innerHTML = [...row.querySelectorAll("[data-inventory-source]")].map((s,i) => `<option value="${i}" ${String(i) === old ? "selected" : ""}>${esc([...s.querySelectorAll("select")].map(n => n.selectedOptions[0]?.textContent || n.value).join(" / "))}</option>`).join("");
  }
}
pageContent.addEventListener("change", event => {
  const row = event.target.closest("[data-supplier-interface]");
  if (!row || !["protocol", "authMethod"].includes(event.target.name)) return;
  const protocol = row.querySelector('[name="protocol"]').value;
  const auth = row.querySelector('[name="authMethod"]');
  const secret = row.querySelector('[name="secret"]')?.value || "";
  if (event.target.name === "protocol") auth.innerHTML = SUPPLIER_AUTH_METHODS[protocol].map(([id,label]) => `<option value="${id}">${label}</option>`).join("");
  row.querySelector("[data-supplier-credentials]").innerHTML = supplierCredentialFields(protocol, auth.value, row.dataset.secretConfigured === "true");
  const input = row.querySelector('[name="secret"]');
  if (input) input.value = secret;
});
pageContent.addEventListener("change", event => {
  const form = event.target.closest("#inventory-cable-form");
  if (!form || form.getAttribute?.("id") !== "inventory-cable-form") return;
  if (event.target.name === "suppliers") {
    const enabled = new Set([...form.querySelectorAll('[name="suppliers"]:checked')].map(n => n.value));
    for (const group of form.querySelectorAll("[data-inventory-supplier]")) group.hidden = !enabled.has(group.dataset.inventorySupplier);
  }
  const source = event.target.closest("[data-inventory-source]");
  if (source && ["sourceSupplier","sourceModel"].includes(event.target.name)) {
    const sid = source.querySelector('[name="sourceSupplier"]').value;
    const supplier = state.config.suppliers?.[sid];
    const modelSelect = source.querySelector('[name="sourceModel"]');
    if (event.target.name === "sourceSupplier") modelSelect.innerHTML = optionList(Object.keys(supplier?.models || {}),"");
    source.querySelector('[name="sourceInterface"]').innerHTML = inventoryInterfaceOptions(sid,supplier?.models?.[modelSelect.value]?.interfaces || [],"");
  }
  syncInventoryDefaults(form);
});
pageContent.addEventListener("input", event => {
  const form = event.target.closest("#inventory-cable-form");
  if (!form || form.getAttribute?.("id") !== "inventory-cable-form") return;
  if (event.target.matches("[data-inventory-filter]")) {
    const search = event.target.value.toLowerCase();
    for (const row of form.querySelectorAll("[data-inventory-candidate]")) row.hidden = !row.dataset.search.includes(search);
  }
  if (event.target.name === "clientId") syncInventoryDefaults(form);
});
async function inventoryAction(action, element) {
  if (action === "select-token-length") {
    const field = element.closest("[data-token-length]");
    const result = parseTokenLength(element.dataset.tokenShortcut);
    field.querySelector("[data-token-value]").value = result.value;
    field.querySelector("[data-token-unit]").value = result.unit;
    syncTokenLength(field);
  }
  else if (action === "create-inventory-cable") { state.selected.cable = null; state.page = "inventory-create"; render(); }
  else if (action === "new-supplier" || action === "open-supplier" || action === "back-suppliers") { state.supplierId = action === "open-supplier" ? element.dataset.id : null; state.supplierModelId = null; state.supplierEditor = null; state.supplierDraft = action === "new-supplier" ? {name:"",interfaces:{},models:{}} : null; state.discoveredModels = []; state.page = action === "new-supplier" ? "supplier-create" : action === "open-supplier" ? "supplier-detail" : "suppliers"; render(); }
  else if (action === "new-supplier-model" || action === "edit-supplier-model") { state.supplierModelId = action === "edit-supplier-model" ? element.dataset.id : null; state.supplierEditor = {kind:"model",id:state.supplierModelId}; state.discoveredSelection = null; state.discoveredInterface = null; render(captureEditedForms()); }
  else if (action === "new-supplier-interface" || action === "edit-supplier-interface") { state.supplierEditor = {kind:"interface",id:action === "edit-supplier-interface" ? element.dataset.id : null}; render(captureEditedForms()); }
  else if (action === "close-supplier-editor") closeSupplierEditor();
  else if (action === "delete-supplier-interface") {
    if (!window.confirm("删除此接口？模型引用需先在供应商模型中解除。")) return true;
    if (state.page === "supplier-create") deleteSupplierDraftResource("interface", element.dataset.id);
    else await saveChanges(() => ({type:"supplier.interface.delete",supplierId:state.supplierId,interfaceId:element.dataset.id}));
  }
  else if (action === "delete-supplier" || action === "delete-supplier-model") {
    if (!window.confirm(action === "delete-supplier-model" ? state.page === "supplier-create" ? "删除此模型草稿？" : "删除模型记录后，旧 Cable 引用会报“来源不存在”，需要在 Cable 中重新绑定。继续？" : "删除此供应商？")) return true;
    if (state.page === "supplier-create" && action === "delete-supplier-model") { deleteSupplierDraftResource("model", element.dataset.id); return true; }
    await saveChanges(() => ({type:action === "delete-supplier" ? "supplier.delete" : "supplier.model.delete",supplierId:action === "delete-supplier" ? element.dataset.id : state.supplierId,modelId:element.dataset.id}));
  } else if (action === "migrate-cable") {
    if (!window.confirm("迁移将分离供应商事实与客户端选择，并保留旧透传兜底。迁移后在供应商页面维护供给，在 Cable 中选择模型。继续？")) return;
    await saveChanges(() => ({type:"cable.inventory.migrate",cableId:element.dataset.id}));
  } else if (action === "discover-supplier-models") {
    const [sid,iid] = JSON.parse(element.dataset.id);
    const result = await api("/suppliers/discover",{method:"POST",body:JSON.stringify({supplierId:sid,interfaceId:iid})});
    state.discoveredModels = result.models; state.discoveredInterface = iid; render(captureEditedForms()); toast(`发现 ${result.models.length} 个模型，可在模型区域确认并添加。`);
  } else if (action === "use-discovered-model") { state.supplierModelId = null; state.supplierEditor = {kind:"model",id:null}; state.discoveredSelection = element.dataset.id; render(); }
  else if (["select-inventory-filter","clear-inventory-selection"].includes(action)) {
    for (const row of pageContent.querySelectorAll("[data-inventory-candidate]")) if (!row.hidden && !row.closest("[data-inventory-supplier]").hidden || action === "clear-inventory-selection") row.querySelector("input").checked = action !== "clear-inventory-selection";
  } else if (action === "add-selected-inventory-models") {
    const form = element.closest("form");
    const list = form.querySelector("#inventory-binding-list");
    const taken = new Set([...list.querySelectorAll('[name="clientId"]')].map(n => n.value));
    for (const row of form.querySelectorAll("[data-inventory-candidate]")) {
      if (!row.querySelector("input").checked || row.closest("[data-inventory-supplier]").hidden) continue;
      const [supplierId,modelId] = JSON.parse(row.querySelector("input").value);
      const interfaceId = row.querySelector("select").value;
      if (!interfaceId) throw new Error("模型没有首期支持的 Responses 接口。");
      let name = modelId, n = 2;
      while (taken.has(name)) name = `${modelId}-${n++}`;
      taken.add(name);
      const wrapper = document.createElement("div"); wrapper.innerHTML = inventoryBindingRow(name,{sources:[{supplierId,modelId,interfaceId}]}); list.append(wrapper.firstElementChild);
      row.querySelector("input").checked = false;
    }
    syncInventoryDefaults(form);
  } else if (action === "remove-binding") { const form = element.closest("form"); element.closest("[data-inventory-binding]").remove(); syncInventoryDefaults(form); }
  else if (action === "add-binding-source") { const form = element.closest("form"); const allowed = [...form.querySelectorAll('[name="suppliers"]:checked')].map(n => n.value); if (!allowed.length) throw new Error("请先为 Cable 选择供应商。"); const row = element.closest("[data-inventory-binding]"); const wrapper = document.createElement("div"); wrapper.innerHTML = inventorySourceRow({},allowed); row.querySelector("[data-inventory-sources]").append(wrapper.firstElementChild); syncInventoryDefaults(form); }
  else if (action === "remove-binding-source") { const form = element.closest("form"); element.closest("[data-inventory-source]").remove(); syncInventoryDefaults(form); }
  else return false;
  return true;
}

for (const type of ["input", "change"]) pageContent.addEventListener(type, event => {
  const field = event.target.closest("[data-token-length]");
  if (field && event.target.matches("[data-token-value], [data-token-unit]")) syncTokenLength(field);
});

pageContent.addEventListener("change", event => {
  const form = event.target.closest("#supplier-model-form");
  if (!form) return;
  const cap = SUPPLIER_CAPABILITIES.find(cap => event.target.name === `cap:${cap}`);
  if (cap) {
    for (const row of form.querySelectorAll("[data-interface-facts]")) {
      const checkbox = row.querySelector(`[name="diff:${CSS.escape(row.dataset.interfaceFacts)}:cap:${cap}"]`);
      checkbox.checked = event.target.checked;
    }
    return;
  }
  if (event.target.name !== "interfaces") return;
  for (const row of form.querySelectorAll("[data-interface-facts]")) {
    if (row.dataset.interfaceFacts === event.target.value) {
      row.hidden = !event.target.checked;
      row.querySelectorAll("[data-token-length]").forEach(syncTokenLength);
    }
  }
});
