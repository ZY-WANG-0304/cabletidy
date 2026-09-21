import { configurationId, providerIdForConfiguration, normalizeConfigurationIdentities, configurationBaseUrl } from "./config-identity.js";

const pageContent = document.querySelector("#page-content");
const pageTitle = document.querySelector("#page-title");
const railStatus = document.querySelector("#rail-status");
const revisionLabel = document.querySelector("#revision-label");
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
  upstreams: "上游管理",
  models: "模型管理",
  diagnostics: "诊断",
};

const state = {
  page: "overview",
  config: null,
  candidate: null,
  runtime: null,
  events: [],
  codexCatalog: null,
  busy: false,
  pendingSecrets: {
    upstreamSecrets: {},
  },
  selected: {
    upstream: null,
    model: null,
    virtualProvider: null,
    binding: null,
    suite: null,
  },
  artifactPreview: null,
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
    state.selected.upstream = firstKey(state.candidate.upstreams);
    state.selected.model = firstKey(state.candidate.models);
    state.selected.virtualProvider = firstKey(state.candidate.virtualProviders);
    state.selected.binding = firstKey(state.candidate.bindings);
    state.selected.suite = firstKey(state.candidate.bindings);
    railStatus.textContent = "服务运行中";
    railStatus.parentElement.classList.remove("is-offline");
    render();
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
  revisionLabel.textContent = `版本 ${state.config?.revision ?? 0}`;
  document.querySelectorAll(".nav-item").forEach((item) => {
    const active = item.dataset.page === (state.page === "diagnostics" ? "diagnostics" : "overview");
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });

  const renderers = {
    overview: renderOverview,
    "suite-create": renderSuiteCreate,
    "suite-detail": renderSuiteDetail,
    upstreams: renderUpstreams,
    models: renderModels,
    diagnostics: renderDiagnostics,
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
  if (sameContext && baseline === latest) {
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
  return captureEditedForms().some((form) => form.getAttribute("id") !== "resolve-form");
}

function confirmPageLeave() {
  return !hasUnsavedChanges() || window.confirm("有未保存的修改，确定放弃并离开？");
}

function navigatePage(page) {
  if (state.busy || !state.config || page === state.page || !confirmPageLeave()) return;
  state.page = page;
  render();
}

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
    const modelIdSet = new Set(virtualProvider.allowedModels || []);
    for (const modelId of routeBackend?.models || []) {
      modelIdSet.add(modelId);
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
  return configurationSuites(state.candidate || {}).find(
    (suite) => suite.id === state.selected.suite,
  ) || null;
}

function selectSuite(id) {
  const suite = configurationSuites(state.candidate || {}).find((item) => item.id === id);
  state.selected.suite = id || null;
  if (!suite) return;
  state.selected.binding = suite.bindingId;
  state.selected.virtualProvider = suite.binding.virtualProvider;
  state.selected.upstream = suite.upstreamId;
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
  return `${configurationBaseUrl(state.candidate, suite.bindingId)}/v1`;
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
  const binding = model.upstreams?.[upstreamId] || {};
  const expanded = model.codex?.metadataMode === "override" || Boolean(model.compact)
    || (isCodex && !model.codex && Boolean(model.contextWindow));
  return `
    <article class="suite-model-card" data-suite-model data-model-id="${esc(modelId)}">
      <div class="suite-model-mapping">
        ${isCodex
          ? officialModelSelect("data-suite-model-client", model.clientModelId || model.aliases?.[0] || "")
          : `<label class="field"><span>客户端模型 ID</span><input data-suite-model-client value="${esc(model.clientModelId || model.aliases?.[0] || modelId)}" placeholder="客户端模型 ID" required /></label>`}
        <span class="suite-mapping-arrow" aria-hidden="true">&rarr;</span>
        ${upstreamId
          ? `<label class="field"><span>上游模型 ID（可选）</span><input data-suite-model-upstream="${esc(upstreamId)}" value="${esc(binding.upstreamModelId || "")}" placeholder="留空使用请求中的模型名" /></label>`
          : `<div class="notice warning">请先配置上游连接</div>`}
        <button class="mini-button" type="button" data-action="remove-suite-model" aria-label="移除模型 ${esc(model.clientModelId || modelId || "映射")}">移除</button>
      </div>
      <details class="suite-model-settings" ${expanded ? "open" : ""}>
        <summary><span>模型能力与上下文</span><span class="field-hint" data-model-policy-summary>${isCodex ? model.codex?.metadataMode === "override" ? "覆盖上游限制" : "沿用官方定义" : "自定义设置"}</span></summary>
        <div class="form-grid suite-model-policy">
          ${isCodex ? codexMetadataFields(model) : `
          <label class="field full"><span>Capabilities</span><input data-suite-model-capabilities-common value="${esc((model.capabilities || ["streaming", "tools", "reasoning"]).join(", "))}" placeholder="streaming, tools, reasoning" /></label>
          <label class="field"><span>Context window</span><input type="number" data-suite-model-context value="${esc(model.contextWindow ?? 1000000)}" placeholder="tokens" /></label>
          <label class="field"><span>Compact strategy</span><select data-suite-model-compact>${optionList(["auto", "manual", "disabled"], compact.strategy || "auto")}</select></label>
          <label class="field"><span>Compact token limit</span><input type="number" data-suite-model-compact-limit value="${esc(compact.tokenLimit ?? 850000)}" placeholder="tokens" /></label>
          ${upstreamId ? `<label class="field"><span>上游能力覆盖</span><input data-suite-model-capabilities="${esc(upstreamId)}" value="${esc((binding.capabilityOverrides || []).join(", "))}" placeholder="可留空" /></label>` : ""}
          `}
        </div>
      </details>
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

function codexMetadataFields(model) {
  const definition = officialModel(model.clientModelId);
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
  const modelChanged = event.target.matches("[data-official-model]");
  if (modelChanged) updateOfficialModelHint(event.target);
  if (modelChanged || event.target.matches("[data-codex-metadata-mode]")) {
    syncCodexMetadata(event.target.closest("[data-suite-model]"), modelChanged);
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
              ${field("API Key", "secret", "", upstreamSecretConfigured(upstreamId, upstream) ? "已配置，留空保留现有密钥" : "粘贴上游 API Key", false, "password")}
            </div>
            <div class="suite-section-footer">
              <span class="field-hint">保存后生效，测试使用已保存的连接。</span>
              <div class="form-actions"><button class="button" type="submit">保存上游</button><button class="button" type="button" data-action="test-upstream" data-id="${esc(upstreamId)}">测试连通性</button></div>
            </div>
          </form>
        ` : `<div class="empty"><strong>未配置上游</strong><div class="form-actions"><button class="button" data-action="new-upstream">添加上游</button></div></div>`}
      </section>
      <section class="suite-section" aria-labelledby="suite-models-title">
        <div class="suite-section-heading suite-models-heading">
          <div><h2 id="suite-models-title">模型设置（可选）</h2><p>默认透传请求中的模型名；需要改名或覆盖上下文等参数时再添加设置。</p></div>
          <button class="button" type="button" data-action="add-suite-model">添加模型设置</button>
        </div>
        ${suite.target === "codex" ? codexCatalogStatus() : ""}
        <form id="suite-models-form" data-suite-context="${esc(JSON.stringify([suite.bindingId, suite.target, binding.virtualProvider, suite.route?.id, upstreamId]))}">
          <div id="suite-model-list" class="suite-model-list">
            ${suite.models.length
              ? suite.models.map(({ id, profile }) => suiteModelEditor(suite, id, profile, upstreamId)).join("")
              : `<div class="empty">已启用模型名直接透传，无需添加模型设置。</div>`}
          </div>
          <div class="suite-section-footer">
            <span class="field-hint">按需展开模型能力与上下文设置。</span>
            <div class="form-actions">
              <button class="button" type="submit">保存模型设置</button>
              ${suite.target === "codex" ? "" : `<button class="button" type="button" data-action="open-advanced-models">高级模型设置</button>`}
            </div>
          </div>
        </form>
      </section>
    </div>
    <section class="panel suite-connection" aria-labelledby="suite-connection-title">
      <div class="panel-header">
        <h2 id="suite-connection-title">${esc(targetLabel(binding.target))} 接入</h2>
        <div class="suite-connection-actions">
          <button class="button button-quiet" type="button" data-action="toggle-vp" data-id="${esc(provider.id)}">${provider.enabled === false ? "启动服务" : "暂停服务"}</button>
          <button class="button" type="button" data-action="preview-artifacts">预览配置</button>
          ${binding.target === "codex" ? `<button class="button button-primary" type="button" data-action="apply-target">应用到 Codex</button>` : ""}
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

function renderSuiteCreate() {
  return `
    <button class="text-button" data-action="back-overview">返回列表</button>
    <form id="suite-create-form" class="config-form panel">
      <section class="config-section" aria-labelledby="config-basics">
        <h2 id="config-basics">基本信息</h2>
        <div class="form-grid">
          ${field("配置名称（可选）", "suiteName", "", "例如 my-relay；留空自动生成")}
          ${selectField("CLI", "target", "codex", ["codex"])}
        </div>
      </section>
      <section class="config-section" aria-labelledby="config-upstream">
        <h2 id="config-upstream">上游连接</h2>
        <div class="form-grid">
          ${field("上游地址", "upstreamBaseUrl", "", "https://relay.example.com/v1", false, "url", false, true)}
          ${field("API Key", "upstreamSecret", "", "", false, "password", false, true)}
        </div>
      </section>
      <section class="config-section" aria-labelledby="config-models">
        <div class="subsection-header">
          <h2 id="config-models">模型设置（可选）</h2>
          <button class="mini-button" type="button" data-action="add-create-model">添加模型设置</button>
        </div>
        <p class="field-hint">默认透传请求中的模型名。需要改名时添加设置，上下文等参数可在创建后调整。</p>
        ${codexCatalogStatus()}
        <div id="create-model-list" class="create-model-list"></div>
      </section>
      <div class="config-form-footer">
        <button class="button" type="button" data-action="back-overview">取消</button>
        <button class="button button-primary" type="submit">创建配置</button>
      </div>
    </form>
  `;
}

function createModelRow(values = {}) {
  const model = {
    clientModelId: values.clientModelId || "",
    upstreamModelId: values.upstreamModelId || "",
  };
  return `
    <div class="create-model-row" data-create-model>
      ${officialModelSelect('data-create-field="clientModelId"', model.clientModelId)}
      <label class="field"><span>上游模型 ID（可选）</span><input data-create-field="upstreamModelId" value="${esc(model.upstreamModelId)}" placeholder="留空使用请求中的模型名" /></label>
      <button class="mini-button" type="button" data-action="remove-create-model" aria-label="移除模型映射">移除</button>
    </div>
  `;
}

function suiteDefaults() {
  const upstreamId = nextConfigId(state.candidate?.upstreams, "relay-main");
  const bindingId = nextConfigId(state.candidate?.bindings, "codex-main");
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

function upstreamDisplayName(baseUrl, fallback) {
  try {
    return new URL(baseUrl).hostname || fallback;
  } catch {
    return fallback;
  }
}

function renderUpstreams() {
  const config = state.candidate;
  const selectedId = state.selected.upstream;
  const selected = selectedId ? config.upstreams[selectedId] : null;
  const integrationLabel = selected?.integration === "codex-native-provider"
    ? "Codex Native Provider Integration"
    : "Native upstream connection";
  return `
    <button class="text-button" data-action="back-overview">返回列表</button>
    <div class="form-layout">
      <div class="panel">
        <div class="panel-header">
          <h2>上游列表</h2>
          <button class="button" data-action="new-upstream">新增上游</button>
        </div>
        <div class="panel-body">
          ${
            Object.keys(config.upstreams).length
              ? `<div class="list">${entries(config.upstreams).map(([id, item]) => upstreamRow(id, item, id === selectedId)).join("")}</div>`
              : `<div class="empty">暂无上游</div>`
          }
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>${selected ? esc(selected.name || selectedId) : "添加上游"}</h2>
        </div>
        <div class="panel-body">
          <form id="upstream-form">
            <div class="form-grid">
              ${field("Upstream ID", "id", selectedId || "", "例如 relay-main", false, "text", Boolean(selectedId))}
              ${field("显示名称", "name", selected?.name || "", "例如 xxx")}
              <div class="field"><span>上游接入方式</span><div class="static-field">${integrationLabel}</div></div>
              ${selectField("上游协议", "protocol", selected?.protocol || "openai.responses", ["openai.responses", "openai.chat_completions", "anthropic.messages"])}
              ${field("真实 base URL", "baseUrl", selected?.baseUrl || "", "https://relay.example.com/v1", true)}
              ${field("API key", "secret", "", upstreamSecretConfigured(selectedId, selected) ? "已配置，留空表示不修改" : "粘贴上游 API key", false, "password")}
              ${field("上游认证 header", "authHeader", selected?.auth?.header || selected?.authHeader || (selected?.protocol === "anthropic.messages" ? "x-api-key" : "authorization"), "authorization 或 x-api-key")}
            </div>
            <div class="form-actions"><button class="button button-primary" type="submit">保存</button>${selected ? `<button class="button" type="button" data-action="test-upstream" data-id="${esc(selectedId)}">测试连通性</button><button class="button button-danger" type="button" data-action="delete-upstream" data-id="${esc(selectedId)}">删除</button>` : ""}</div>
          </form>
        </div>
      </div>
    </div>
  `;
}

function renderModels() {
  const config = state.candidate;
  const selectedId = state.selected.model;
  const selected = selectedId ? config.models[selectedId] : null;
  const compact = selected?.compact || {};
  const upstreamId = firstKey(selected?.upstreams) || firstKey(config.upstreams) || "";
  const mapping = selected?.upstreams?.[upstreamId] || {};
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
            Object.keys(config.models).length
              ? `<div class="list">${entries(config.models).map(([id, item]) => modelRow(id, item, id === selectedId)).join("")}</div>`
              : `<div class="empty">暂无模型</div>`
          }
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><h2>${selected ? esc(selected.name || selectedId) : "新增模型"}</h2></div>
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
              <div class="subsection-header"><h3>上游模型映射</h3></div>
              <div class="form-grid">
                ${selectField("Upstream", "upstreamId", upstreamId, Object.keys(config.upstreams))}
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

function upstreamRow(id, item, active = false) {
  const health = state.runtime?.health?.[id];
  const healthClass = health?.outcome === "failure" ? "danger" : health ? "" : "warning";
  const status = health?.outcome || (
    upstreamSecretConfigured(id, item)
      ? "ready"
      : "needs key"
  );
  return `<button class="list-row ${active ? "is-selected" : ""}" data-action="select-upstream" data-id="${esc(id)}"><div><h3>${esc(item.name || id)}</h3><p>${esc(item.protocol || "protocol")} · ${esc(item.baseUrl || "未设置")}</p></div><span class="status-badge ${healthClass}">${status}</span></button>`;
}

function upstreamSecretConfigured(id, item) {
  return Boolean(item?.secretConfigured);
}

function modelRow(id, item, active = false) {
  const context = item.contextWindow ? `${item.contextWindow.toLocaleString()} ctx` : "context unset";
  const compact = item.compact?.tokenLimit ? `${item.compact.tokenLimit.toLocaleString()} compact` : "compact unset";
  return `<button class="list-row ${active ? "is-selected" : ""}" data-action="select-model" data-id="${esc(id)}"><div><h3>${esc(item.clientModelId || item.aliases?.[0] || id)}</h3><p>${esc(id)} · ${(item.capabilities || []).join(" · ")} · ${esc(context)} · ${esc(compact)}</p></div><span class="status-badge">${Object.keys(item.upstreams || {}).length} bindings</span></button>`;
}

function eventRow(event) {
  return `<div class="list-row"><div><h3>${esc(event.type)}</h3><p>${esc(new Date(event.at).toLocaleString())} · ${esc(event.data?.upstreamId || event.data?.revision || "control")}</p></div><span class="table-meta">${esc(event.id)}</span></div>`;
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
  if (state.busy) return;
  if ([
    "create-suite", "open-suite", "back-overview", "select-upstream", "select-model",
    "new-upstream", "new-model", "focus-upstream", "open-advanced-models",
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
    } else if (action === "select-upstream") {
      state.selected.upstream = element.dataset.id;
      state.page = "upstreams";
      render();
    } else if (action === "select-model") {
      state.selected.model = element.dataset.id;
      state.page = "models";
      render();
    } else if (action === "new-upstream") {
      state.selected.upstream = null;
      state.page = "upstreams";
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
        clientModelId: "",
        ...(suite?.target === "codex" ? { codex: { metadataMode: "official" } } : { capabilities: ["streaming", "tools", "reasoning"] }),
        upstreams: {},
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
      element.closest("[data-create-model]")?.remove();
    } else if (["delete-upstream", "delete-model"].includes(action)) {
      if (!window.confirm("删除此配置项？删除后立即生效。")) return;
      await saveChanges(() => removeConfigItem(action, element.dataset.id), element.closest("form"));
    } else if (action === "test-upstream") {
      await testUpstream(element.dataset.id);
    } else if (action === "toggle-vp") {
      await toggleVirtualProvider(element.dataset.id);
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
      state.selected.model = selectedSuite()?.modelIds?.[0] || firstKey(state.candidate.models);
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
      "upstream-form": () => saveUpstream(data),
      "suite-upstream-form": () => saveSuiteUpstream(data),
      "suite-models-form": () => saveSuiteModels(form),
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

function removeConfigItem(action, id) {
  if (action === "delete-upstream") {
    delete state.candidate.upstreams[id];
    for (const model of values(state.candidate.models)) delete model.upstreams?.[id];
    state.selected.upstream = firstKey(state.candidate.upstreams);
  } else if (action === "delete-model") {
    delete state.candidate.models[id];
    for (const provider of values(state.candidate.virtualProviders)) {
      provider.allowedModels = (provider.allowedModels || []).filter((modelId) => modelId !== id);
      if (provider.defaultModel === id) delete provider.defaultModel;
    }
    for (const route of values(state.candidate.routes)) {
      for (const backend of route.backends || []) {
        backend.models = (backend.models || []).filter((modelId) => modelId !== id);
      }
    }
    for (const binding of values(state.candidate.bindings)) {
      if (binding.defaultModel === id) delete binding.defaultModel;
    }
    state.selected.model = firstKey(state.candidate.models);
  }
}

function saveSuiteUpstream(data) {
  saveUpstream(data, true);
  state.page = "suite-detail";
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

  const reservedIds = new Set();
  const nextModels = {};
  for (const row of modelRows) {
    const oldId = row.dataset.modelId || "";
    const existing = state.candidate.models[oldId] || {};
    const clientModelId = row.querySelector("[data-suite-model-client]").value.trim();
    const profileId = oldId || modelProfileId(clientModelId, state.candidate.models, reservedIds);
    if (nextModels[profileId]) throw new Error(`模型 ID 冲突: ${profileId}`);

    const upstreams = {};
    const upstreamInput = row.querySelector(
      `[data-suite-model-upstream="${CSS.escape(upstreamId)}"]`,
    );
    const capabilityInput = row.querySelector(
      `[data-suite-model-capabilities="${CSS.escape(upstreamId)}"]`,
    );
    const upstreamModelId = upstreamInput?.value.trim() || "";
    const capabilityOverrides = capabilityInput ? commaList(capabilityInput.value) : existing.upstreams?.[upstreamId]?.capabilityOverrides || [];
    upstreams[upstreamId] = { ...(existing.upstreams?.[upstreamId] || {}) };
    if (upstreamModelId) upstreams[upstreamId].upstreamModelId = upstreamModelId;
    else delete upstreams[upstreamId].upstreamModelId;
    if (capabilityOverrides.length) upstreams[upstreamId].capabilityOverrides = capabilityOverrides;
    else delete upstreams[upstreamId].capabilityOverrides;

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
    const usedByOtherProvider = values(state.candidate.virtualProviders).some(
      (provider) =>
        provider !== suite.virtualProvider &&
        (provider.allowedModels || []).includes(oldModelId),
    );
    const usedByOtherRoute = entries(state.candidate.routes).some(
      ([id, route]) =>
        id !== routeId &&
        (route.backends || []).some((backend) => (backend.models || []).includes(oldModelId)),
    );
    if (!usedByOtherProvider && !usedByOtherRoute) delete state.candidate.models[oldModelId];
  }
  Object.assign(state.candidate.models, nextModels);
  state.candidate.routes[routeId] = {
    ...state.candidate.routes[routeId],
    backends: [nextRouteBackend],
  };
  state.candidate.virtualProviders[suite.binding.virtualProvider] = {
    ...state.candidate.virtualProviders[suite.binding.virtualProvider],
    allowedModels: Object.keys(nextModels),
    defaultModel: oldModelIds.has(suite.virtualProvider.defaultModel) && !nextModelIds.has(suite.virtualProvider.defaultModel)
      ? undefined : suite.virtualProvider.defaultModel,
  };
  state.candidate.bindings[suite.bindingId] = {
    ...state.candidate.bindings[suite.bindingId],
    defaultModel: oldModelIds.has(suite.binding.defaultModel) && !nextModelIds.has(suite.binding.defaultModel)
      ? undefined : suite.binding.defaultModel,
  };
  selectSuite(suite.bindingId);

}

function saveSuiteCreate(data, form) {
  const defaults = suiteDefaults();
  const upstreamBaseUrl = String(data.get("upstreamBaseUrl") || "").trim();
  const upstreamSecret = String(data.get("upstreamSecret") || "").trim();
  const target = String(data.get("target") || "codex").trim();
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

  const upstreamId = defaults.upstreamId;
  const upstreamName = upstreamDisplayName(upstreamBaseUrl, upstreamId);
  const routeId = defaults.routeId;
  const name = suiteName || `Codex / ${upstreamName}`;
  const bindingId = configurationId(name, defaults.bindingId);
  const virtualProviderId = providerIdForConfiguration(bindingId);
  if (Object.hasOwn(state.candidate.bindings, bindingId) || Object.hasOwn(state.candidate.virtualProviders, virtualProviderId)) {
    throw new Error(`配置名称对应的 ID 已存在: ${bindingId}，请使用不同的配置名称`);
  }
  const reservedModelIds = new Set();
  const models = Object.fromEntries(
    modelEntries.map((model) => {
      const profileId = modelProfileId(
        model.clientModelId,
        state.candidate.models,
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
              ...(model.upstreamModelId ? { upstreamModelId: model.upstreamModelId } : {}),
            },
          },
        },
      ];
    }),
  );
  const modelIds = Object.keys(models);

  state.candidate.upstreams[upstreamId] = {
    id: upstreamId,
    name: upstreamName,
    integration: "codex-native-provider",
    protocol: "openai.responses",
    baseUrl: upstreamBaseUrl,
    secretRef: `secret://upstreams/${upstreamId}`,
    enabled: true,
  };
  for (const modelId of modelIds) delete state.candidate.models[modelId];
  Object.assign(state.candidate.models, models);
  state.candidate.routes[routeId] = {
    id: routeId,
    name: `${upstreamName} route`,
    backends: [
      {
        upstream: upstreamId,
        models: modelIds,
        enabled: true,
      },
    ],
  };
  state.candidate.virtualProviders[virtualProviderId] = {
    id: virtualProviderId,
    name: `Codex via ${upstreamName}`,
    ingressProtocol: "openai.responses",
    route: routeId,
    allowedModels: modelIds,
    enabled: true,
  };
  state.candidate.bindings[bindingId] = {
    id: bindingId,
    name,
    target,
    integration: "codex-native-provider",
    targetFormat: "codex.config.toml.v1",
    mode: "config",
    virtualProvider: virtualProviderId,
    codex: {},
  };

  state.pendingSecrets.upstreamSecrets[upstreamId] = upstreamSecret;

  state.selected.upstream = upstreamId;
  state.selected.model = modelIds[0] || null;
  state.selected.virtualProvider = virtualProviderId;
  state.selected.binding = bindingId;
  state.selected.suite = bindingId;
  state.page = "suite-detail";

}

function saveUpstream(data, connectionOnly = false) {
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
    ...(!connectionOnly ? {
      auth: {
        ...(existing.auth || {}),
        header: String(data.get("authHeader") || "").trim().toLowerCase() || undefined,
      },
    } : {}),
    enabled: existing.enabled !== false,
  };
  if (data.get("protocol") !== "openai.responses") {
    delete state.candidate.upstreams[id].integration;
  }
  const secret = String(data.get("secret") || "").trim();
  if (secret) {
    state.pendingSecrets.upstreamSecrets[id] = secret;
  }
  state.selected.upstream = id;

}

function saveModel(data, form) {
  const id = String(data.get("id") || "").trim();
  if (!id) throw new Error("CableTidy Model ID 不能为空");
  const existing = state.candidate.models[id] || {};
  const upstreamId = String(data.get("upstreamId") || "").trim();
  const upstreamModelId = String(data.get("upstreamModelId") || "").trim();
  if (!upstreamId) throw new Error("请选择一个 upstream");
  const upstreams = {
    [upstreamId]: {
      ...(existing.upstreams?.[upstreamId] || {}),
      ...(upstreamModelId ? { upstreamModelId } : {}),
      capabilityOverrides: commaList(data.get("capabilityOverrides")),
    },
  };
  if (!upstreamModelId) delete upstreams[upstreamId].upstreamModelId;
  const clientModelId = String(data.get("clientModelId") || "").trim();
  state.candidate.models[id] = {
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
      bindingId: state.selected.binding,
    }),
  });
  state.artifactPreview = result.artifacts;
  const target = result.artifacts?.target;
  toast(target === "codex" ? "已生成 Codex 本地 config.toml 预览。" : "已生成环境配置预览；请将这些变量注入对应客户端。");
  render(preservedForms);
}

async function applyTarget() {
  if (hasUnsavedChanges()) {
    throw new Error("请先保存当前编辑，再应用到 CLI。");
  }
  if (!state.selected.binding) throw new Error("请先选择一个 Target binding。");
  const binding = state.candidate.bindings[state.selected.binding];
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
    for (const field of ["binding", "suite"]) {
      state.selected[field] = identities.bindingIds.get(state.selected[field]) ?? state.selected[field];
    }
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
