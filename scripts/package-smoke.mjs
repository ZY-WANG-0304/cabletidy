import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("packed CLI installs, serves assets, shuts down and preserves data on uninstall", { timeout: 120000 }, async (t) => {
  assert.ok(process.env.npm_execpath, "Run with npm run test:package");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-package-"));
  const prefix = path.join(directory, "prefix");
  const home = path.join(directory, "data");
  const codexHome = path.join(directory, "codex");
  const cwd = path.join(directory, "unrelated");
  await fs.mkdir(cwd);
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      child.process.kill("SIGKILL");
      await child.closed;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    CABLETIDY_HOME: home,
    CODEX_HOME: codexHome,
    npm_config_cache: path.join(directory, "cache"),
    npm_config_update_notifier: "false",
  };
  const options = { cwd, env, timeout: 90000 };
  const npm = (args, overrides = {}) => execute(process.execPath, [process.env.npm_execpath, ...args], { ...options, ...overrides });
  const packed = JSON.parse((await npm([
    "pack", "--json", "--ignore-scripts", "--pack-destination", directory,
  ], { cwd: root })).stdout)[0];
  const files = packed.files.map(file => file.path);
  assert.ok(files.includes("bin/cabletidy.mjs"));
  assert.ok(files.includes("web/config-identity.js"));
  assert.ok(files.every(file => /^(bin\/|src\/|web\/|package\.json$|README\.md$|LICENSE(?:\..*)?$)/.test(file)));
  const tarball = path.join(directory, packed.filename);
  await npm(["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const packageRoot = process.platform === "win32"
    ? path.join(prefix, "node_modules", "cabletidy")
    : path.join(prefix, "lib", "node_modules", "cabletidy");
  const shim = path.join(prefix, process.platform === "win32" ? "cabletidy.cmd" : "bin/cabletidy");
  await fs.access(shim);
  // Exercise npm's actual Unix executable; Windows entry loading is checked separately from its cmd shim.
  const executable = process.platform === "win32" ? process.execPath : shim;
  const entryArgs = process.platform === "win32" ? [path.join(packageRoot, "bin", "cabletidy.mjs")] : [];
  const cli = args => execute(executable, [...entryArgs, ...args], options);
  const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal((await cli(["--version"])).stdout.trim(), metadata.version);
  assert.match((await cli(["--help"])).stdout, /Usage: cabletidy/);
  await assert.rejects(fs.access(home), { code: "ENOENT" });
  assert.equal(JSON.parse((await cli(["status"])).stdout).runtime.status, "offline");

  const configFile = path.join(home, "config.json");
  const config = JSON.parse(await fs.readFile(configFile, "utf8"));
  const port = await availablePort();
  config.web.port = port;
  await fs.writeFile(configFile, JSON.stringify(config));
  const savedConfig = await fs.readFile(configFile, "utf8");
  const url = `http://127.0.0.1:${port}/`;

  for (const signal of process.platform === "win32" ? [] : ["SIGTERM", "SIGINT"]) {
    const processHandle = spawn(executable, [...entryArgs, "start"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    processHandle.stdout.on("data", chunk => { output += chunk; });
    processHandle.stderr.on("data", chunk => { output += chunk; });
    const child = {
      process: processHandle,
      closed: new Promise((resolve, reject) => {
        processHandle.once("error", reject);
        processHandle.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
      }),
    };
    children.add(child);
    await waitFor(async () => {
      assert.equal(processHandle.exitCode, null, output);
      try {
        const runtime = JSON.parse(await fs.readFile(path.join(home, "runtime.json"), "utf8"));
        return runtime.pid === processHandle.pid;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    });
    for (const asset of ["", "app.js", "styles.css", "config-identity.js"]) {
      const response = await fetch(`${url}${asset}`, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.equal(body, await fs.readFile(path.join(packageRoot, "web", asset || "index.html"), "utf8"));
    }
    assert.equal(JSON.parse((await cli(["status"])).stdout).runtime.status, "online");
    assert.equal(JSON.parse((await cli(["status"])).stdout).runtime.web.url, url);
    await assert.rejects(cli(["start"]), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /EADDRINUSE/);
      return true;
    });
    processHandle.kill(signal);
    await waitFor(() => processHandle.exitCode !== null);
    assert.deepEqual(await child.closed, { code: 0, signal: null }, output);
    children.delete(child);
    await assert.rejects(fs.access(path.join(home, "runtime.json")), { code: "ENOENT" });
    assert.equal(JSON.parse((await cli(["status"])).stdout).runtime.status, "offline");
  }
  if (process.platform === "win32") t.diagnostic("Windows signal lifecycle and cmd shim execution are not validated by this test");
  assert.equal(JSON.parse((await npm([
    "exec", "--yes", `--package=${tarball}`, "--", "cabletidy", "status",
  ])).stdout).runtime.status, "offline");
  await assert.rejects(fs.access(codexHome), { code: "ENOENT" });
  const savedSecrets = await fs.readFile(path.join(home, "secrets.json"), "utf8");
  await npm(["uninstall", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "cabletidy"]);
  await assert.rejects(fs.access(shim), { code: "ENOENT" });
  assert.equal(await fs.readFile(configFile, "utf8"), savedConfig);
  assert.equal(await fs.readFile(path.join(home, "secrets.json"), "utf8"), savedSecrets);
  t.diagnostic(`${packed.filename}: ${packed.entryCount} files, ${packed.size} packed bytes`);
});

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail("Timed out waiting for daemon lifecycle");
}
