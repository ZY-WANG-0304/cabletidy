import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const targets = {
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
  "x86_64-unknown-linux-musl": "linux-x64",
  "aarch64-unknown-linux-musl": "linux-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-pc-windows-msvc": "win32-x64",
};
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
export async function build({ release = false, target, test = false } = {}) {
  await run("cargo", ["build", "--locked", ...(release ? ["--release"] : []), ...(target ? ["--target", target] : []), ...(test ? ["--features", "test-support"] : ["--bin", "cabletidy"])]);
}
export async function stage(target) {
  const platform = target ? targets[target] : `${process.platform}-${process.arch}`;
  if (!Object.values(targets).includes(platform)) throw new Error(`Unsupported release target: ${target || platform}`);
  const name = platform.startsWith("win32-") ? "cabletidy.exe" : "cabletidy";
  const source = path.join(root, "target", ...(target ? [target] : []), "release", name);
  const destination = path.join(root, "native", platform);
  await fs.mkdir(destination, { recursive: true });
  await fs.copyFile(source, path.join(destination, name));
  await fs.chmod(path.join(destination, name), 0o755);
  const version = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;
  const digest = createHash("sha256").update(await fs.readFile(source)).digest("hex");
  await fs.writeFile(path.join(destination, "build.json"), `${JSON.stringify({ version, platform, target: target || null, sha256: digest }, null, 2)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const target = args.includes("--target") ? args[args.indexOf("--target") + 1] : undefined;
    const release = !args.includes("--debug");
    await build({ release, target, test: args.includes("--test") });
    if (release) await stage(target);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
