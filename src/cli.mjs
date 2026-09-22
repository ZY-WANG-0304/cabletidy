import fs from "node:fs/promises";

import {
  getPaths,
  loadConfig,
  readRuntimeInfo,
} from "./config.mjs";
import { configurationBaseUrl } from "../web/config-identity.js";

const [, , command = "status", ...args] = process.argv;

async function main() {
  if (["--help", "-h", "help"].includes(command)) {
    printHelp();
    return;
  }

  if (["--version", "-v"].includes(command)) {
    const metadata = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(metadata.version);
    return;
  }

  if (command === "start") {
    if (args.length) throw new Error("用法: cabletidy start");
    const { startDaemon } = await import("./server.mjs");
    await startDaemon();
    return;
  }

  const paths = getPaths();

  if (command === "status") {
    const config = await loadConfig(paths);
    if (!config) {
      print({ runtime: { status: "offline", liveness: "尚未启动，未找到配置；请执行 cabletidy start" } });
      return;
    }
    const runtime = await readRuntimeInfo(paths);
    const daemon = runtime ? await probeDaemon(runtime) : { online: false, reason: "runtime.json 不存在" };
    const web = runtime?.web || {
      host: config.web.listenHost,
      port: config.web.port,
    };
    print({
      configRevision: config.revision,
      runtime: runtime
        ? { ...runtime, web: { ...web, url: web.url || webUrl(web) }, status: daemon.online ? "online" : "offline", liveness: daemon.reason }
        : { web: { ...web, url: webUrl(web) }, status: "offline", liveness: daemon.reason },
      configurations: Object.entries(config.bindings).map(([id, binding]) => {
        const provider = config.virtualProviders[binding.virtualProvider];
        return {
          id,
          name: binding.name || id,
          target: binding.target,
          url: `${configurationBaseUrl(config, id)}/v1`,
          enabled: binding.enabled !== false && provider?.enabled !== false,
        };
      }),
    });
    return;
  }

  console.error(`未知命令: ${[command, ...args].join(" ")}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp() {
  console.log(`CableTidy CLI

Usage: cabletidy <command>

Commands:
  start                       Start the daemon in the foreground
  --help, -h                  Show this help
  --version, -v               Print the installed version
  status                      Show daemon status and management URL

Data: CABLETIDY_HOME or ~/.cabletidy
No command: show status
`);
}

async function probeDaemon(runtime) {
  const pid = Number(runtime.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { online: false, reason: "CableTidy runtime.json 无有效 daemon PID，请重新执行 cabletidy start" };
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
    return { online: false, reason: "CableTidy runtime.json 无有效 Web 端口，请重新执行 cabletidy start" };
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
      return { online: false, reason: "CableTidy daemon Web 管理台无响应，请重新执行 cabletidy start" };
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

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
