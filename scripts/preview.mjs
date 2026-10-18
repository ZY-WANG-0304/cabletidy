import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { installPackage } from "../bin/update.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const usage = "Usage: npm run preview -- [--ref <git-ref>] [--pack-only] [--yes] [--prefix <directory>]";

export function parseArgs(args) {
  const options = { ref: null, packOnly: false, yes: false, prefix: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pack-only") options.packOnly = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (["--ref", "--prefix"].includes(arg) && args[i + 1] && !args[i + 1].startsWith("-")) {
      options[arg.slice(2)] = args[++i];
    } else throw new Error(usage);
  }
  return options;
}

export function previewVersion(version, commit, date = new Date()) {
  const core = version.match(/^(\d+\.\d+\.\d+)(?:[-+].*)?$/)?.[1];
  if (!core || !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid preview version or commit");
  const day = date.toISOString().slice(2, 10).replace(/-/g, "");
  return `${core}-preview.${day}.g${commit.slice(0, 7)}`;
}

export async function setVersion(directory, version) {
  for (const file of ["package.json", "package-lock.json"]) {
    const location = path.join(directory, file);
    const metadata = JSON.parse(await fs.readFile(location, "utf8"));
    metadata.version = version;
    if (file === "package-lock.json") metadata.packages[""].version = version;
    await fs.writeFile(location, `${JSON.stringify(metadata, null, 2)}\n`);
  }
  for (const [file, pattern] of [
    ["Cargo.toml", /(\[package\][^\[]*?\nversion\s*=\s*")[^"]+(")/],
    ["Cargo.lock", /(\[\[package\]\]\s*\nname\s*=\s*"cabletidy"\s*\nversion\s*=\s*")[^"]+(")/],
  ]) {
    const location = path.join(directory, file);
    const content = await fs.readFile(location, "utf8");
    if (!pattern.test(content)) throw new Error(`Cannot find CableTidy version in ${file}`);
    await fs.writeFile(location, content.replace(pattern, (_, before, after) => `${before}${version}${after}`));
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
}

export async function preview(args) {
  const options = parseArgs(args);
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("Run with npm run preview");
  const git = args => execute("git", args, { cwd: root });
  if (!options.ref) {
    console.log("Fetching latest main...");
    const code = await run("git", ["fetch", "origin"], { cwd: root });
    if (code !== 0) return code;
  }
  const ref = options.ref || "origin/main";
  const commit = (await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).stdout.trim();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-preview-"));
  try {
    const source = path.join(temporary, "source");
    await fs.mkdir(source);
    const archive = path.join(temporary, "source.tar");
    await git(["archive", "--format=tar", `--output=${archive}`, commit]);
    await execute("tar", ["-xf", archive, "-C", source]);
    const metadata = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
    const version = previewVersion(metadata.version, commit);
    console.log(`Building CableTidy ${version}\nSource: ${ref} (${commit})`);
    await setVersion(source, version);
    // Reuse dependency compilation between snapshots, without overwriting normal build artifacts.
    const buildEnv = { ...process.env, CARGO_TARGET_DIR: path.join(root, "target", "preview") };
    delete buildEnv.GITHUB_REF;
    let code = await run(process.execPath, [npm, "run", "check:version"], { cwd: source, env: buildEnv });
    if (code !== 0) return code;
    // Older refs stage from target/release; a directory link also works for those build scripts.
    await fs.mkdir(buildEnv.CARGO_TARGET_DIR, { recursive: true });
    await fs.symlink(buildEnv.CARGO_TARGET_DIR, path.join(source, "target"), process.platform === "win32" ? "junction" : "dir");
    code = await run(process.execPath, [npm, "run", "build"], { cwd: source, env: buildEnv });
    if (code !== 0) return code;
    const platform = `${process.platform}-${process.arch}`;
    const native = path.join(source, "native", platform);
    const binary = path.join(native, process.platform === "win32" ? "cabletidy.exe" : "cabletidy");
    const actual = (await execute(binary, ["--version"])).stdout.trim();
    if (actual !== version) throw new Error(`Built binary version ${actual} must match ${version}`);
    const buildFile = path.join(native, "build.json");
    const build = JSON.parse(await fs.readFile(buildFile, "utf8"));
    await fs.writeFile(buildFile, `${JSON.stringify({ ...build, commit, ref }, null, 2)}\n`);
    const destination = path.join(root, "dist-preview");
    await fs.mkdir(destination, { recursive: true });
    const packed = JSON.parse((await execute(process.execPath, [npm, "pack", "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: source })).stdout)[0];
    const tarball = path.join(destination, packed.filename);
    const bytes = await fs.readFile(tarball);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(`${tarball}.json`, `${JSON.stringify({ version, commit, ref, platform, sha256, integrity: packed.integrity }, null, 2)}\n`);
    console.log(`Preview package: ${tarball}`);
    if (options.packOnly) return 0;

    const prefix = options.prefix ? path.resolve(options.prefix)
      : (await execute(process.execPath, [npm, "prefix", "--global"], { cwd: root })).stdout.trim();
    const installedRoot = path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", metadata.name);
    const launcher = path.join(installedRoot, "bin", "cabletidy.mjs");
    let current = "not installed";
    try {
      current = JSON.parse(await fs.readFile(path.join(installedRoot, "package.json"), "utf8")).version;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Use the freshly built probe, not a stale debug binary from the working tree.
    return await installPackage({
      current, target: version, prefix, launcher, binary, yes: options.yes,
      install: () => run(process.execPath, [npm, "install", "--global", `--prefix=${prefix}`, "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: temporary }),
    });
  } finally {
    // fs.rm removes the link itself, preserving the persistent Cargo cache.
    await fs.rm(path.join(temporary, "source", "target"), { recursive: true, force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await preview(process.argv.slice(2)); }
  catch (error) { console.error(error.stderr?.trim() || error.message); process.exitCode = 1; }
}
