import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import spawn from "cross-spawn";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("packed CLI installs, serves assets, shuts down and preserves data on uninstall", { timeout: 120000 }, async (t) => {
  assert.ok(process.env.npm_execpath, "Run with npm run test:package");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy package-"));
  const prefix = path.join(directory, "prefix");
  const home = path.join(directory, "data");
  const codexHome = path.join(directory, "codex");
  const cwd = path.join(directory, "unrelated");
  await fs.mkdir(cwd);
  const env = {
    ...process.env,
    CABLETIDY_HOME: home,
    CODEX_HOME: codexHome,
    npm_config_cache: path.join(directory, "cache"),
    // A publish dry run must still exercise a real temporary install.
    npm_config_dry_run: "false",
    npm_config_update_notifier: "false",
  };
  const options = { cwd, env, timeout: 90000 };
  const npm = (args, overrides = {}) => execute(process.execPath, [process.env.npm_execpath, ...args], { ...options, ...overrides });
  const suppliedTarball = process.env.CABLETIDY_PACKAGE_TARBALL;
  const packed = suppliedTarball ? null : JSON.parse((await npm([
    "pack", "--json", "--ignore-scripts", "--pack-destination", directory,
  ], { cwd: root })).stdout)[0];
  const files = packed?.files.map(file => file.path);
  if (files) {
    assert.ok(files.includes("bin/cabletidy.mjs"));
    assert.ok(files.includes(`native/${process.platform}-${process.arch}/cabletidy${process.platform === "win32" ? ".exe" : ""}`));
    assert.ok(files.every(file => /^(bin\/|native\/|package\.json$|README\.md$|LICENSE(?:\..*)?$)/.test(file)));
  }
  const tarball = suppliedTarball ? path.resolve(root, suppliedTarball) : path.join(directory, packed.filename);
  await npm(["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const packageRoot = process.platform === "win32"
    ? path.join(prefix, "node_modules", "cabletidy")
    : path.join(prefix, "lib", "node_modules", "cabletidy");
  const shim = path.join(prefix, process.platform === "win32" ? "cabletidy.cmd" : "bin/cabletidy");
  await fs.access(shim);
  const cli = args => new Promise((resolve, reject) => {
    const child = spawn(shim, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve({ stdout, stderr })
      : reject(Object.assign(new Error(stderr), { code, stderr, stdout })));
  });
  t.after(async () => {
    try { if (await fs.stat(shim).catch(() => null)) await cli(["stop"]); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(metadata.version, JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version);
  assert.equal((await cli(["--version"])).stdout.trim(), metadata.version);
  assert.match((await cli(["--help"])).stdout, /Usage: cabletidy/);
  await assert.rejects(fs.access(home), { code: "ENOENT" });
  assert.equal(JSON.parse((await cli(["status"])).stdout).runtime.status, "offline");
  await assert.rejects(fs.access(home), { code: "ENOENT" });

  const configFile = path.join(home, "config.json");
  let savedConfig;
  let url;

  assert.match((await cli(["stop"])).stdout, /not running/);
  await assert.rejects(fs.access(home), { code: "ENOENT" });

  for (let restart = 0; restart < 2; restart += 1) {
    if (restart) {
      // Upgrade from an unbounded logger: oversized existing files must also be capped.
      for (const suffix of ["", ".1", ".2", ".3"]) {
        const log = await fs.open(path.join(home, `daemon.log${suffix}`), "w");
        try { await log.truncate(10 * 1024 * 1024 + 64); }
        finally { await log.close(); }
      }
    }
    await assert.rejects(cli(["start", "--invalid"]));
    const started = await cli(["start"]);
    assert.match(started.stdout, /CableTidy started:/);
    assert.match(started.stdout, /daemon\.log/);
    const logs = (await fs.readdir(home)).filter(name => /^daemon\.log(?:\.\d+)?$/.test(name));
    assert.ok(logs.length <= 4);
    for (const name of logs) assert.ok((await fs.stat(path.join(home, name))).size <= 10 * 1024 * 1024);
    assert.match(await fs.readFile(path.join(home, "daemon.log"), "utf8"), /CableTidy Web/);
    const runtime = JSON.parse(await fs.readFile(path.join(home, "runtime.json"), "utf8"));
    if (url === undefined) {
      url = runtime.web.url;
      savedConfig = await fs.readFile(configFile, "utf8");
      assert.equal(JSON.parse(savedConfig).web.port, runtime.web.port);
      assert.ok(runtime.web.port > 0);
    } else {
      assert.equal(runtime.web.url, url);
      assert.equal(await fs.readFile(configFile, "utf8"), savedConfig);
    }
    for (const asset of ["", "app.js", "styles.css", "config-identity.js", "claude-models.js"]) {
      const response = await fetch(`${url}${asset}`, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.equal(body, await fs.readFile(path.join(root, "web", asset || "index.html"), "utf8"));
    }
    assert.equal(JSON.parse((await cli(["status"])).stdout).runtime.status, "online");
    assert.equal(JSON.parse((await cli(["status"])).stdout).runtime.web.url, url);
    await assert.rejects(cli(["start"]), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /ELOCKED/);
      return true;
    });
    await assert.rejects(cli(["restart", "--invalid"]));
    const restarted = await cli(["restart"]);
    assert.match(restarted.stdout, /CableTidy restarted:/);
    const afterRestart = JSON.parse(await fs.readFile(path.join(home, "runtime.json"), "utf8"));
    assert.notEqual(afterRestart.controlId, runtime.controlId);
    assert.equal(afterRestart.web.url, url);
    assert.equal(await fs.readFile(configFile, "utf8"), savedConfig);
    assert.equal((await fetch(url)).status, 200);
    assert.match((await cli(["stop"])).stdout, /CableTidy stopped/);
    await waitFor(async () => {
      try { await fs.access(path.join(home, "runtime.json")); return false; }
      catch (error) { if (error.code === "ENOENT") return true; throw error; }
    });
    assert.equal(JSON.parse((await cli(["status"])).stdout).runtime.status, "offline");
    assert.match((await cli(["stop"])).stdout, /not running/);
  }
  assert.equal(JSON.parse((await npm([
    "exec", "--yes", `--package=${tarball}`, "--", "cabletidy", "status",
  ])).stdout).runtime.status, "offline");
  await assert.rejects(fs.access(codexHome), { code: "ENOENT" });
  const savedSecrets = await fs.readFile(path.join(home, "secrets.json"), "utf8");
  await npm(["uninstall", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "cabletidy"]);
  await assert.rejects(fs.access(shim), { code: "ENOENT" });
  assert.equal(await fs.readFile(configFile, "utf8"), savedConfig);
  assert.equal(await fs.readFile(path.join(home, "secrets.json"), "utf8"), savedSecrets);
  t.diagnostic(packed ? `${packed.filename}: ${packed.entryCount} files, ${packed.size} packed bytes` : `Verified supplied tarball: ${tarball}`);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail("Timed out waiting for daemon lifecycle");
}
