import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
