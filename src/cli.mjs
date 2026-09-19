import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ensureGeneratedSecrets,
  getPaths,
  loadConfig,
  loadSecrets,
  publicConfig,
  readRuntimeInfo,
} from "./config.mjs";
import { prepareCodexArtifacts, publicArtifacts } from "./codex-native-provider.mjs";
import {
  buildTargetArtifacts,
  publicTargetArtifacts,
  prepareTargetArtifacts,
} from "./target-artifacts.mjs";
import { resolveRequest } from "./model-resolver.mjs";
import { validateConfig } from "./validation.mjs";

const [, , command = "status", ...args] = process.argv;

async function main() {
  const paths = getPaths();

  if (command === "status") {
    const [config, runtime] = await Promise.all([loadConfig(paths), readRuntimeInfo(paths)]);
    const daemon = runtime ? await probeDaemon(runtime) : { online: false, reason: "runtime.json 不存在" };
    print({
      configRevision: config.revision,
      runtime: runtime
        ? { ...runtime, status: daemon.online ? "online" : "offline", liveness: daemon.reason }
        : { status: "offline", liveness: daemon.reason },
      counts: {
        upstreams: Object.keys(config.upstreams).length,
        models: Object.keys(config.models).length,
        routes: Object.keys(config.routes).length,
        virtualProviders: Object.keys(config.virtualProviders).length,
        bindings: Object.keys(config.bindings).length,
      },
    });
    return;
  }

  if (command === "web" && ["print-url", "open", "status"].includes(args[0])) {
    const runtime = await readRuntimeInfo(paths);
    if (!runtime) {
      console.error("CableTidy daemon 尚未运行。先执行 npm start。");
      process.exitCode = 1;
      return;
    }
    const daemon = await probeDaemon(runtime);
    if (!daemon.online) {
      console.error(`CableTidy daemon 不在线：${daemon.reason}`);
      process.exitCode = 1;
      return;
    }
    if (args[0] === "status") print({ ...runtime, status: "online", liveness: daemon.reason });
    else console.log(runtime.web?.url || webUrl(runtime.web));
    return;
  }

  if (command === "config" && args[0] === "check") {
    const result = validateConfig(await loadConfig(paths));
    print({
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "model" && args[0] === "resolve") {
    const config = await loadConfig(paths);
    const provider = config.virtualProviders[args[1]];
    if (!provider) throw new Error(`Virtual Provider 不存在: ${args[1]}`);
    const result = resolveRequest(config, provider, { model: args[2], stream: true });
    print({
      clientModelId: result.model.clientModelId,
      profileId: result.model.profileId,
      routeId: result.routeId,
      upstreamId: result.upstream.id,
      upstreamModelId: result.upstreamModelId,
      capabilities: result.capabilities,
    });
    return;
  }

  if (command === "codex" && args[0] === "artifacts") {
    const config = await loadConfig(paths);
    const secrets = ensureGeneratedSecrets(config, await loadSecrets(paths));
    print(publicArtifacts(await prepareCodexArtifacts(config, { bindingId: args[1] }, secrets)));
    return;
  }

  if (command === "target" && args[0] === "env") {
    const config = await loadConfig(paths);
    const secrets = ensureGeneratedSecrets(config, await loadSecrets(paths));
    const artifacts = await prepareTargetArtifacts(config, { bindingId: args[1] }, secrets);
    if (args.includes("--json")) {
      print({
        bindingId: artifacts.bindingId,
        target: artifacts.target,
        envKey: artifacts.environment.name,
        shell: artifacts.environment.shell,
      });
    } else {
      console.log(artifacts.environment.shell || "# 此本地接入不需要设置认证环境变量。");
    }
    return;
  }

  if (command === "target" && args[0] === "artifacts") {
    const config = await loadConfig(paths);
    const secrets = ensureGeneratedSecrets(config, await loadSecrets(paths));
    print(publicTargetArtifacts(await prepareTargetArtifacts(config, { bindingId: args[1] }, secrets)));
    return;
  }

  if (command === "run") {
    await runTarget(args, paths);
    return;
  }

  console.log(`CableTidy CLI

Commands:
  status
  web print-url
  web status
  config check
  model resolve <virtual-provider-id> <client-model-id>
  codex artifacts [binding-id]
  target env [binding-id] [--json]
  target artifacts [binding-id]
  run --target <target> --binding <binding-id> -- <command> [args...]
`);
}

async function runTarget(args, paths) {
  const separator = args.indexOf("--");
  const optionArgs = separator >= 0 ? args.slice(0, separator) : args;
  const commandArgs = separator >= 0 ? args.slice(separator + 1) : [];
  const target = optionValue(optionArgs, "--target") || "codex";
  const bindingId = optionValue(optionArgs, "--binding");
  if (!commandArgs[0]) {
    throw new Error("run 需要在 -- 后提供目标命令");
  }

  const runtime = await readRuntimeInfo(paths);
  if (!runtime) {
    throw new Error("CableTidy daemon 尚未运行。先执行 npm start");
  }
  await assertDaemonAlive(runtime);

  const config = await loadConfig(paths);
  const secrets = ensureGeneratedSecrets(config, await loadSecrets(paths));
  const bindingEntry = Object.entries(config.bindings || {}).find(
    ([id, item]) => bindingId
      ? id === bindingId || item.id === bindingId
      : item.target === target && item.enabled !== false,
  );
  if (!bindingEntry) {
    throw new Error(`找不到 target=${target} 的 binding${bindingId ? `: ${bindingId}` : ""}`);
  }
  const [resolvedBindingId, binding] = bindingEntry;
  const artifacts = buildTargetArtifacts(config, { bindingId: resolvedBindingId }, secrets);
  if (artifacts.target !== target) {
    throw new Error(`binding ${resolvedBindingId} 的 target 是 ${artifacts.target}，不是 ${target}`);
  }

  const environment = { ...process.env };
  for (const [name, value] of Object.entries(artifacts.environment.vars || {})) {
    environment[name] = String(value ?? "");
  }

  let temporaryCodexHome;
  try {
    if (artifacts.target === "codex") {
      temporaryCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-codex-run-"));
      const prepared = await prepareTargetArtifacts(config, { bindingId: resolvedBindingId, codexHome: temporaryCodexHome }, secrets);
      for (const file of prepared.files) {
        const targetFile = path.join(temporaryCodexHome, file.path);
        await fs.mkdir(path.dirname(targetFile), { recursive: true });
        await fs.writeFile(targetFile, file.contents, { mode: 0o600 });
      }
      environment.CODEX_HOME = temporaryCodexHome;
      if (artifacts.environment.name) {
        environment[artifacts.environment.name] = String(artifacts.environment.value ?? "");
      }
    }

    const result = spawnSync(commandArgs[0], commandArgs.slice(1), {
      stdio: "inherit",
      env: environment,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    if (temporaryCodexHome) {
      await fs.rm(temporaryCodexHome, { recursive: true, force: true });
    }
  }
}

async function assertDaemonAlive(runtime) {
  const result = await probeDaemon(runtime);
  if (!result.online) throw new Error(result.reason);
}

async function probeDaemon(runtime) {
  const pid = Number(runtime.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { online: false, reason: "CableTidy runtime.json 无有效 daemon PID，请重启 npm start" };
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    return { online: false, reason: `CableTidy daemon 不在线（PID ${pid}）：${error.message}` };
  }

  const web = runtime.web || {};
  const host = web.host || "127.0.0.1";
  const port = Number(web.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { online: false, reason: "CableTidy runtime.json 无有效 Web 端口，请重启 npm start" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://${formatHostForUrl(host)}:${port}/api/v1/runtime`, {
      signal: controller.signal,
    });
    // The Web console is loopback-only and has no management session. A 200
    // response with the CableTidy marker proves the daemon is alive.
    if (response.status !== 200 || response.headers.get("x-cabletidy") !== "cabletidy") {
      return {
        online: false,
        reason: `CableTidy Web runtime probe 返回异常响应（HTTP ${response.status}）`,
      };
    }
    return { online: true, reason: `Web runtime probe 正常（PID ${pid}）` };
  } catch (error) {
    if (error.name === "AbortError") {
      return { online: false, reason: "CableTidy daemon Web 管理台无响应，请重启 npm start" };
    }
    return { online: false, reason: `CableTidy daemon Web 管理台不可达：${error.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

function formatHostForUrl(host) {
  const value = String(host || "127.0.0.1");
  if (value.includes(":") && !value.startsWith("[")) return `[${value}]`;
  return value;
}

function webUrl(web = {}) {
  const host = formatHostForUrl(web.host || "127.0.0.1");
  const port = Number(web.port || 43100);
  return `http://${host}:${port}/`;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
