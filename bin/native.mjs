import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const platform = `${process.platform}-${process.arch}`;
export const binaryName = process.platform === "win32" ? "cabletidy.exe" : "cabletidy";

export function executable() {
  const source = existsSync(path.join(root, "Cargo.toml"));
  if (source) {
    const debug = path.join(root, "target", "debug", binaryName);
    if (existsSync(debug)) return debug;
  }
  const packaged = path.join(root, "native", platform, binaryName);
  if (existsSync(packaged)) return packaged;
  throw new Error(source
    ? "Build the Rust executable first: npm run build:debug"
    : `This package has no CableTidy executable for ${platform}. Install a supported release or build from source.`);
}

export function launch(args, { env = process.env, binary = executable(), signals = true } = {}) {
  const child = spawn(binary, args, {
    env: { ...env, CABLETIDY_MANAGED_STDIN: "1" },
    stdio: ["pipe", "inherit", "inherit"],
    // The launcher receives terminal signals once and forwards them over its private pipe.
    detached: true,
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  const stop = signal => { if (!child.stdin.destroyed) child.stdin.write(`${signal}\n`); };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  if (signals) {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
  }
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      resolve(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
  return { child, stop, closed };
}

function home(env) {
  return env.CABLETIDY_HOME || path.join(os.homedir(), ".cabletidy");
}

async function runtimeInfo(env) {
  try {
    return JSON.parse(await fs.readFile(path.join(home(env), "runtime.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function startBackground({ env = process.env, binary = executable() } = {}) {
  const directory = path.resolve(home(env));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const logPath = path.join(directory, "daemon.log");
  const childEnv = { ...env, CABLETIDY_HOME: directory, CABLETIDY_BACKGROUND_LOG: "1" };
  delete childEnv.CABLETIDY_MANAGED_STDIN;
  let spawnError;
  let startupError = "";
  const child = spawn(binary, ["start"], {
    env: childEnv, stdio: ["ignore", "ignore", "pipe"], detached: true, windowsHide: true,
  });
  child.once("error", error => { spawnError = error; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { startupError = (startupError + chunk).slice(-16384); });
  const closed = new Promise(resolve => child.once("close", resolve));
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        await closed;
        throw new Error(startupError.trim() || "CableTidy daemon failed to start");
      }
      const runtime = await runtimeInfo(childEnv);
      if (runtime?.pid === child.pid) {
        try {
          const response = await fetch(`${runtime.web.url}api/v1/runtime`, { signal: AbortSignal.timeout(500) });
          const live = await response.json();
          if (response.ok && live.pid === child.pid && live.startedAt === runtime.startedAt) {
            child.stderr.destroy();
            child.unref();
            return { ...runtime, logPath };
          }
        } catch { /* The listener may still be entering its serving loop. */ }
      }
      await delay(50);
    }
    throw new Error(`Timed out waiting for CableTidy daemon; see ${logPath}`);
  } catch (error) {
    child.stderr.destroy();
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    child.unref();
    throw error;
  }
}
