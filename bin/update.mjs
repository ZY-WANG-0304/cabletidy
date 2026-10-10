import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { promisify } from "node:util";
import { executable, root } from "./native.mjs";

const execFileAsync = promisify(execFile);
const packageName = "cabletidy";
const defaultRegistry = "https://registry.npmjs.org/";
const usage = "Usage: cabletidy update [<version|tag>] [--check] [--yes] [--registry <url>]";

export function parseArgs(args) {
  let spec;
  let check = false;
  let yes = false;
  let registry = defaultRegistry;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--check") check = true;
    else if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--registry" && index + 1 < args.length) registry = args[++index];
    else if (arg.startsWith("--registry=")) registry = arg.slice("--registry=".length);
    // Only versions and dist-tags; npm would also accept paths, URLs and git specs.
    else if (spec === undefined && /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(arg)) spec = arg;
    else throw new Error(usage);
  }
  if (!/^https?:$/.test(URL.parse(registry)?.protocol ?? "")) throw new Error(`Invalid registry: ${registry}`);
  return { spec: spec ?? "latest", explicit: spec !== undefined, check, yes, registry };
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

// Quote an argument for a command the user is told to run in their shell.
export function shellArg(value, platform = process.platform) {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  return platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", `'\\''`)}'`;
}

async function confirm(question, yes) {
  if (yes) {
    console.log(`${question} [y/N] y (--yes)`);
    return true;
  }
  if (!process.stdin.isTTY) {
    console.log(`${question} [y/N] (no terminal; assuming no, pass --yes to confirm)`);
    return false;
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

// Probes the instance lock and runtime.json without parsing config.json.
async function instance(binary) {
  try {
    return JSON.parse((await execFileAsync(binary, ["__instance"], { windowsHide: true })).stdout);
  } catch (error) {
    return { error: (error.stderr || error.message).trim() };
  }
}

export async function update(args) {
  const options = parseArgs(args);
  if (existsSync(path.join(root, "Cargo.toml"))) {
    throw new Error("CableTidy is running from a source checkout; update it with git pull and npm run build.");
  }
  const current = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const registry = `--registry=${options.registry}`;
  const manual = `npm install -g ${packageName}@${options.spec} ${shellArg(registry)}`;
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
    const command = ["cabletidy update", options.explicit && options.spec, options.registry !== defaultRegistry && shellArg(registry)];
    console.log(`CableTidy ${current} -> ${target} available; run: ${command.filter(Boolean).join(" ")}`);
    return 0;
  }

  const prefix = globalPrefix(path.resolve(root));
  if (!prefix) throw new Error(`CableTidy was not installed with npm install -g; update it the way it was installed, e.g.\n  ${manual}`);
  const windows = process.platform === "win32";
  const launcher = path.join(root, "bin", "cabletidy.mjs");
  const state = await instance(executable());
  if (state.error) {
    // Windows cannot replace the package while the daemon may still be using its executable.
    if (windows) throw new Error(`Cannot determine whether CableTidy is running: ${state.error}\nStop it manually, then run cabletidy update again.`);
    console.warn(`Cannot determine whether CableTidy is running: ${state.error}`);
  }
  if (state.running && windows) {
    if (!state.process) throw new Error("Cannot verify the running CableTidy process (it may be starting or shutting down); stop it manually, then run cabletidy update again.");
    // Windows locks the running executable, so npm cannot replace the package until the daemon exits.
    if (!await confirm("The running CableTidy daemon must be stopped before updating. Stop it now?", options.yes)) {
      console.log("Update cancelled");
      return 1;
    }
    const stopped = await run(process.execPath, [launcher, "stop"]);
    if (stopped !== 0) return stopped;
    // stop returns once shutdown completes; the process may still be closing other control connections.
    const exited = await run(executable(), ["__instance", "--wait-exit", JSON.stringify(state.process)]);
    if (exited !== 0) return exited;
  }
  console.log(`Updating CableTidy ${current} -> ${target} in ${prefix}`);
  const installed = await run(npmCommand, [...npmArgs, "install", "-g", `--prefix=${prefix}`, registry, `${packageName}@${target}`]);
  if (installed !== 0) {
    console.error(`npm install failed${state.running && windows ? "; CableTidy is stopped, run cabletidy start to resume" : ""}`);
    return installed;
  }
  // stop + start is supported by every version that has stop; restart is newer.
  const switchCommand = windows ? "cabletidy start" : "cabletidy stop && cabletidy start";
  if (state.error) console.log(`If CableTidy is running, run ${switchCommand} to use ${target}`);
  if (!state.running) return 0;
  if (!await confirm(windows ? "Start CableTidy again?" : `Restart CableTidy now? The daemon is still running ${current}.`, options.yes)) {
    console.log(`Run ${switchCommand} when ready`);
    return 0;
  }
  // Fresh processes load the newly installed launcher and executable.
  if (!windows) {
    const stopped = await run(process.execPath, [launcher, "stop"]);
    if (stopped !== 0) return stopped;
  }
  return run(process.execPath, [launcher, "start"]);
}
