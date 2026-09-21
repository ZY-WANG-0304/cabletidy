import { spawn } from "node:child_process";
import { clientModelIdForProfile, effectiveCapabilities } from "./model-resolver.mjs";

let cached;
let pending;
let activeCommand;

async function executeCodex(args) {
  const command = spawn("codex", args, {
    signal: AbortSignal.timeout(15_000),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    // Keep npm launcher descendants in a group we can stop on forced daemon exit.
    detached: process.platform !== "win32",
  });
  activeCommand = command;
  let spawnError;
  command.once("error", error => { spawnError = error; });
  const closed = new Promise(resolve => {
    command.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    const [result, stdout] = await Promise.all([
      closed,
      readCommandOutput(command.stdout),
      readCommandOutput(command.stderr),
    ]);
    if (spawnError) throw spawnError;
    if (result.code !== 0) throw new Error(`codex exited with ${result.signal || result.code}`);
    return { stdout };
  } catch (error) {
    forceStopCodexCatalog();
    await closed;
    throw error;
  } finally {
    activeCommand = undefined;
  }
}

async function readCommandOutput(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error("codex output exceeded 16 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function forceStopCodexCatalog() {
  if (!activeCommand?.pid) return;
  try {
    if (process.platform === "win32") activeCommand.kill("SIGKILL");
    else process.kill(-activeCommand.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export function validateCatalog(value) {
  if (!value || !Array.isArray(value.models) || !value.models.length) {
    throw new Error("Codex 模型目录为空或格式不受支持，请更新 Codex 后重试");
  }
  const names = new Set();
  for (const model of value.models) {
    if (!model || typeof model.slug !== "string" || !model.slug || names.has(model.slug)) {
      throw new Error("Codex 模型目录包含无效或重复的模型 ID");
    }
    names.add(model.slug);
  }
  return value;
}

export async function loadCodexCatalog({ refresh = false } = {}) {
  if (!refresh && cached && Date.now() - cached.loadedAt < 60_000) return structuredClone(cached);
  if (!pending) {
    pending = (async () => {
      try {
        const version = (await executeCodex(["--version"])).stdout.trim();
        // Bundled metadata is independent of the user's catalog and never
        // needs their upstream credentials or a remote model request.
        const result = await executeCodex(["debug", "models", "--bundled"]);
        const catalog = validateCatalog(JSON.parse(result.stdout));
        cached = { version, catalog, loadedAt: Date.now() };
        return cached;
      } catch (error) {
        const reason = error.code === "ENOENT" ? "找不到 codex 命令" : "当前版本无法导出有效目录";
        throw new Error(`无法读取本机 Codex 官方模型目录：${reason}。请安装或更新 Codex，并确认 daemon 的 PATH 包含 codex。`, { cause: error });
      }
    })().finally(() => { pending = null; });
  }
  return structuredClone(await pending);
}

export function officialModels(snapshot) {
  return validateCatalog(snapshot.catalog).models.filter((model) =>
    /^gpt-/i.test(model.slug) && model.supported_in_api === true,
  );
}

export function defaultCapabilities(model) {
  return [
    "streaming", "tools", "parallel_tool_calls",
    ...(model.supported_reasoning_levels?.length ? ["reasoning"] : []),
    ...(model.input_modalities?.includes("image") ? ["vision"] : []),
  ];
}

export function publicCodexCatalog(snapshot) {
  return {
    available: true,
    version: snapshot.version,
    models: officialModels(snapshot).map((model) => ({
      id: model.slug,
      name: model.display_name || model.slug,
      hidden: model.visibility === "hide",
      contextWindow: model.context_window ?? null,
      maxContextWindow: model.max_context_window ?? model.context_window ?? null,
      inputModalities: model.input_modalities || ["text"],
      capabilities: defaultCapabilities(model),
    })),
  };
}

export function codexModelIds(config) {
  const ids = new Set();
  for (const binding of Object.values(config.bindings || {})) {
    if (binding?.target !== "codex") continue;
    for (const id of config.virtualProviders?.[binding.virtualProvider]?.allowedModels || []) ids.add(id);
  }
  return ids;
}

export function catalogEntryForProfile(snapshot, id, profile) {
  const name = clientModelIdForProfile(id, profile);
  const official = officialModels(snapshot).find((model) => model.slug === name);
  if (!official) {
    throw new Error(`模型 ${name} 未匹配本机 Codex 官方 GPT 目录。请选择对应的官方模型；若本机目录过旧，请更新 Codex。当前不支持非对应模型。`);
  }
  if (!official.base_instructions && !official.model_messages?.instructions_template) {
    throw new Error(`官方模型 ${name} 缺少指令定义，不能生成替代提示词`);
  }
  const entry = structuredClone(official);
  if (profile.codex?.metadataMode === "override") {
    if (profile.contextWindow !== undefined) {
      const maximum = official.max_context_window ?? official.context_window;
      if (!Number.isSafeInteger(profile.contextWindow) || profile.contextWindow < 1 ||
          !Number.isSafeInteger(maximum) || profile.contextWindow > maximum) {
        throw new Error(`${name} 的 context window 必须为 1 到 ${maximum || "官方已知上限"} 之间的整数`);
      }
      entry.context_window = profile.contextWindow;
      entry.max_context_window = profile.contextWindow;
    }
    if (profile.codex.inputModalities !== undefined) {
      const modalities = profile.codex.inputModalities;
      if (!Array.isArray(modalities) || !modalities.includes("text") ||
          new Set(modalities).size !== modalities.length ||
          modalities.some((item) => !["text", "image"].includes(item) || !official.input_modalities?.includes(item))) {
        throw new Error(`${name} 的输入类型只能是官方已支持类型的子集，且必须保留 text`);
      }
      entry.input_modalities = [...modalities];
    }
  }
  return { official, entry };
}

export function planCodexCatalog(config, provider, snapshot) {
  const catalog = structuredClone(validateCatalog(snapshot.catalog));
  const overrides = [];
  const warnings = [];
  const models = [];
  const route = config.routes?.[provider.route];
  if (route?.backends?.length !== 1) throw new Error("每份配置必须且只能连接一个 upstream");
  for (const id of provider.allowedModels || []) {
    const profile = config.models[id];
    if (!profile) throw new Error(`模型不存在: ${id}`);
    const { official, entry } = catalogEntryForProfile(snapshot, id, profile);
    const backends = (config.routes?.[provider.route]?.backends || []).filter((backend) =>
      backend.enabled !== false && config.upstreams?.[backend.upstream] && config.upstreams[backend.upstream].enabled !== false &&
      (!backend.models?.length || backend.models.includes(id)),
    );
    if (backends.length !== 1) throw new Error(`${entry.slug} 的 Codex MVP 接入必须对应一个有效上游`);
    if (config.upstreams[backends[0].upstream].protocol !== "openai.responses") {
      throw new Error(`${entry.slug} 的 Codex MVP 上游必须使用 Responses 协议，暂不支持跨协议转换`);
    }
    const binding = profile.upstreams?.[backends[0].upstream];
    if (Object.keys(profile.upstreams || {}).length !== 1) throw new Error(`${entry.slug} 必须且只能映射一个 upstream`);
    if (!binding) throw new Error(`${entry.slug} 缺少上游模型设置`);
    if (profile.codex && !effectiveCapabilities(profile, binding).has("vision") && entry.input_modalities?.includes("image")) {
      entry.input_modalities = entry.input_modalities.filter((item) => item !== "image");
      warnings.push(`${entry.slug} 的上游 vision 能力未启用，生成目录将禁用图片输入。`);
    }
    models.push(entry.slug);
    if (JSON.stringify(entry) !== JSON.stringify(official)) {
      catalog.models[catalog.models.findIndex((model) => model.slug === entry.slug)] = entry;
      overrides.push(entry.slug);
    }
    if (!profile.codex && (profile.contextWindow || profile.compact)) {
      warnings.push(`${entry.slug} 的旧 context window / compact 配置未同步；请在模型映射中确认元数据设置。`);
    }
    if (profile.compact) warnings.push(`${entry.slug} 的 compact 策略仍由 Codex 管理，CableTidy 未同步逐模型压缩配置。`);
  }
  return { sourceVersion: snapshot.version, catalog: overrides.length ? catalog : null, models, overrides, warnings };
}

export async function validateCodexChanges(config, previous, loadCatalog = loadCodexCatalog) {
  const oldIds = codexModelIds(previous);
  const changed = [...codexModelIds(config)].filter((id) =>
    !oldIds.has(id) || JSON.stringify(config.models[id]) !== JSON.stringify(previous.models?.[id]),
  );
  if (!changed.length) return [];
  let snapshot;
  try { snapshot = await loadCatalog(); }
  catch (error) { return [{ path: "models", message: error.message }]; }
  const errors = [];
  for (const id of changed) {
    try { catalogEntryForProfile(snapshot, id, config.models[id]); }
    catch (error) { errors.push({ path: `models.${id}`, message: error.message }); }
  }
  return errors;
}
