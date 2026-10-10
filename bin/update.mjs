import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { promisify } from "node:util";
import { executable, root } from "./native.mjs";

const execFileAsync = promisify(execFile);
const packageName = "cabletidy";
const usage = "Usage: cabletidy update [<version|tag>] [--check] [--registry <url>]";

export function parseArgs(args) {
  let spec;
  let check = false;
  let registry = "https://registry.npmjs.org/";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--check") check = true;
    else if (arg === "--registry" && index + 1 < args.length) registry = args[++index];
    else if (arg.startsWith("--registry=")) registry = arg.slice("--registry=".length);
    // Only versions and dist-tags; npm would also accept paths, URLs and git specs.
    else if (spec === undefined && /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(arg)) spec = arg;
    else throw new Error(usage);
  }
  if (!/^https?:$/.test(URL.parse(registry)?.protocol ?? "")) throw new Error(`Invalid registry: ${registry}`);
  return { spec: spec ?? "latest", explicit: spec !== undefined, check, registry };
}

export function compareVersions(left, right) {
  const parse = version => {
    const [core, pre] = version.split("+")[0].split(/-(.*)/s);
    return [core.split(".").map(Number), pre ? pre.split(".") : []];
  };
  const [leftCore, leftPre] = parse(left);
  const [rightCore, rightPre] = parse(right);
  for (let index = 0; index < 3; index++) {
    if (leftCore[index] !== rightCore[index]) return Math.sign(leftCore[index] - rightCore[index]);
  }
  // A release sorts after its prereleases.
  if (!leftPre.length || !rightPre.length) return Math.sign(rightPre.length - leftPre.length);
  for (let index = 0; index < Math.min(leftPre.length, rightPre.length); index++) {
    const [a, b] = [leftPre[index], rightPre[index]];
    if (a === b) continue;
    const [numericA, numericB] = [/^\d+$/.test(a), /^\d+$/.test(b)];
    if (numericA && numericB) return Math.sign(Number(a) - Number(b));
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return Math.sign(leftPre.length - rightPre.length);
}

// The prefix that owns this package, or null when it is not a global npm install (local dependency, npx cache).
// Updating that exact prefix keeps nvm and custom npm prefixes from installing somewhere else.
export function globalPrefix(packageDir) {
  const windows = process.platform === "win32";
  const modules = path.dirname(packageDir);
  if (path.basename(modules) !== "node_modules") return null;
  const parent = path.dirname(modules);
  if (!windows && path.basename(parent) !== "lib") return null;
  const prefix = windows ? parent : path.dirname(parent);
  const shim = windows ? path.join(prefix, `${packageName}.cmd`) : path.join(prefix, "bin", packageName);
  return existsSync(shim) ? prefix : null;
}

// Prefer the npm bundled with the running node over whichever npm is first on PATH.
function npm() {
  const directory = path.dirname(process.execPath);
  const cli = process.platform === "win32"
    ? path.join(directory, "node_modules", "npm", "bin", "npm-cli.js")
    : path.join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(cli)) return [process.execPath, [cli]];
  if (process.platform === "win32") return null;
  return ["npm", []];
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
}

async function confirm(question) {
  if (!process.stdin.isTTY) {
    console.log(`${question} [y/N] (no terminal; assuming no)`);
    return false;
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

async function daemonRunning(binary) {
  const { stdout } = await execFileAsync(binary, ["status"], { windowsHide: true });
  return JSON.parse(stdout).runtime?.status !== "offline";
}

export async function update(args) {
  const options = parseArgs(args);
  if (existsSync(path.join(root, "Cargo.toml"))) {
    throw new Error("CableTidy is running from a source checkout; update it with git pull and npm run build.");
  }
  const current = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const registry = `--registry=${options.registry}`;
  const manual = `npm install -g ${packageName}@${options.spec} ${registry}`;
  const [npmCommand, npmArgs] = npm() ?? [];
  if (!npmCommand) throw new Error(`Cannot find the npm bundled with ${process.execPath}; update manually:\n  ${manual}`);

  const { stdout } = await execFileAsync(npmCommand, [...npmArgs, "view", `${packageName}@${options.spec}`, "version", "--json", registry], { windowsHide: true });
  const published = stdout.trim() ? JSON.parse(stdout) : null;
  const target = Array.isArray(published) ? published.at(-1) : published;
  if (!target) throw new Error(`No published ${packageName} version matches ${options.spec}`);
  const order = compareVersions(target, current);
  if (order === 0) {
    console.log(`CableTidy ${current} is up to date`);
    return 0;
  }
  if (order < 0 && !options.explicit) {
    console.log(`CableTidy ${current} is newer than ${options.spec} (${target}); pass a version to change it`);
    return 0;
  }
  if (options.check) {
    console.log(`CableTidy ${current} -> ${target} available; run: cabletidy update${options.explicit ? ` ${options.spec}` : ""}`);
    return 0;
  }

  const prefix = globalPrefix(path.resolve(root));
  if (!prefix) throw new Error(`CableTidy was not installed with npm install -g; update it the way it was installed, e.g.\n  ${manual}`);
  const windows = process.platform === "win32";
  const launcher = path.join(root, "bin", "cabletidy.mjs");
  const running = await daemonRunning(executable());
  if (running && windows) {
    // Windows locks the running executable, so npm cannot replace the package until the daemon exits.
    if (!await confirm("The running CableTidy daemon must be stopped before updating. Stop it now?")) {
      console.log("Update cancelled");
      return 1;
    }
    const stopped = await run(process.execPath, [launcher, "stop"]);
    if (stopped !== 0) return stopped;
  }
  console.log(`Updating CableTidy ${current} -> ${target} in ${prefix}`);
  const installed = await run(npmCommand, [...npmArgs, "install", "-g", `--prefix=${prefix}`, registry, `${packageName}@${target}`]);
  if (installed !== 0) {
    console.error(`npm install failed${running && windows ? "; CableTidy is stopped, run cabletidy start to resume" : ""}`);
    return installed;
  }
  if (!running) return 0;
  const command = windows ? "start" : "restart";
  if (!await confirm(windows ? "Start CableTidy again?" : `Restart CableTidy now? The daemon is still running ${current}.`)) {
    console.log(`Run cabletidy ${command} when ready`);
    return 0;
  }
  // A fresh process loads the newly installed launcher and executable.
  return run(process.execPath, [launcher, command]);
}
