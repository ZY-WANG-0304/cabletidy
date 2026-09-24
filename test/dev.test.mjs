import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApplication } from "../src/server.mjs";
import { getPaths, loadConfig, readRuntimeInfo } from "../src/config.mjs";
import { readCodexConfig } from "../src/codex-config-file.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

async function waitFor(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail("Timed out waiting for development instance");
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy dev-"));
  const children = [];
  const cleanups = [];
  t.after(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    for (const cleanup of cleanups.reverse()) await cleanup();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    cleanup: callback => cleanups.push(callback),
    async checkout(name, overrides = {}) {
      const repository = path.join(directory, name);
      const entry = path.join(repository, "scripts", "dev.mjs");
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.copyFile(path.join(root, "scripts", "dev.mjs"), entry);
      // Reuse real modules while testing checkout-relative defaults from another cwd.
      await fs.symlink(path.join(root, "src"), path.join(repository, "src"),
        process.platform === "win32" ? "junction" : "dir");
      const env = {
        ...process.env,
        CABLETIDY_HOME: path.join(directory, "production"),
        CODEX_HOME: path.join(directory, "production-codex"),
        CLAUDE_CONFIG_DIR: path.join(directory, "production-claude"),
        CABLETIDY_DEV_HOME: "",
        ...overrides,
      };
      const paths = getPaths(env.CABLETIDY_DEV_HOME || path.join(repository, ".cabletidy-debug"));
      const options = { cwd: directory, env, timeout: 15000 };
      return {
        entry, paths, env,
        status: async () => JSON.parse((await execute(process.execPath, [entry, "status"], options)).stdout),
        run: () => execute(process.execPath, [entry], options),
        async start({ watch = false } = {}) {
          const windows = process.platform === "win32";
          const args = windows ? ["--input-type=module", "-e", `
            process.argv = [process.execPath, ${JSON.stringify(entry)}];
            process.on("message", signal => process.emit(signal, signal));
            process.channel.unref();
            await import(${JSON.stringify(pathToFileURL(entry).href)});
          `] : [...(watch ? ["--watch"] : []), entry];
          const child = spawn(process.execPath, args, {
            cwd: directory, env, stdio: windows ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", chunk => { output += chunk; });
          child.stderr.on("data", chunk => { output += chunk; });
          const closed = new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => resolve({ code, signal }));
          });
          children.push({ child, closed });
          await waitFor(() => {
            assert.equal(child.exitCode, null, output);
            return output.includes("Ctrl+C");
          });
          const runtime = await readRuntimeInfo(paths);
          return {
            child, runtime, output: () => output,
            async stop() {
              if (windows) child.send("SIGTERM");
              else child.kill("SIGTERM");
              await waitFor(() => child.exitCode !== null || child.signalCode !== null);
              const result = await closed;
              assert.ok(result.code === 0 || (watch && result.signal === "SIGTERM"), output);
              await assert.rejects(fs.access(paths.runtime), { code: "ENOENT" });
              await assert.rejects(fs.access(paths.lock), { code: "ENOENT" });
            },
          };
        },
      };
    },
  };
}

async function post(url, endpoint, body) {
  const response = await fetch(`${url}api/v1/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

test("development checkouts run alongside production and apply only to their test clients", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const dev = await f.checkout("checkout-a");
  const productionPaths = getPaths(dev.env.CABLETIDY_HOME);
  const production = await createApplication({ paths: productionPaths });
  f.cleanup(() => production.close());
  const productionConfig = await fs.readFile(productionPaths.config, "utf8");
  const sentinelFiles = [
    [path.join(dev.env.CODEX_HOME, "config.toml"), 'model_provider = "daily"\n'],
    [path.join(dev.env.CLAUDE_CONFIG_DIR, "settings.json"), '{"env":{"ANTHROPIC_BASE_URL":"https://daily.invalid"}}\n'],
  ];
  for (const [file, contents] of sentinelFiles) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  assert.equal((await dev.status()).runtime.status, "offline");
  await assert.rejects(fs.access(dev.paths.home), { code: "ENOENT" });

  const app = await dev.start();
  const url = app.runtime.web.url;
  assert.notEqual(url, production.url);
  assert.equal((await dev.status()).runtime.web.url, url);
  for (const directory of [dev.paths.home, path.join(dev.paths.home, "codex"), path.join(dev.paths.home, "claude")]) {
    assert.ok(app.output().includes(directory), app.output());
  }
  const other = await f.checkout("checkout-b");
  const otherApp = await other.start();
  assert.notEqual(otherApp.runtime.web.url, url);
  assert.notEqual(otherApp.runtime.web.url, production.url);

  const config = await loadConfig(dev.paths);
  for (const [id, target, protocol] of [["codex", "codex", "openai.responses"], ["claude", "claude-code", "anthropic.messages"]]) {
    config.upstreams[id] = { id, protocol, baseUrl: "https://example.invalid/v1" };
    config.routes[id] = { id, backends: [{ upstream: id }] };
    config.virtualProviders[`cabletidy_${id}`] = { id: `cabletidy_${id}`, route: id, ingressProtocol: protocol };
    config.bindings[id] = { id, target, virtualProvider: `cabletidy_${id}` };
  }
  await post(url, "config/commit", { baseRevision: config.revision, config, upstreamSecrets: { codex: "dev-key" } });
  for (const bindingId of ["codex", "claude"]) {
    await post(url, "config/preview-target-artifacts", { bindingId });
    await post(url, "targets/apply", { bindingId });
  }
  const codex = readCodexConfig(await fs.readFile(path.join(dev.paths.home, "codex", "config.toml"), "utf8"));
  assert.equal(codex.model_providers.cabletidy_codex.base_url, `${url}codex/v1`);
  const claudeFile = path.join(dev.paths.home, "claude", "settings.json");
  assert.equal(JSON.parse(await fs.readFile(claudeFile, "utf8")).env.ANTHROPIC_BASE_URL, `${url}claude`);
  await post(url, "targets/restore", { bindingId: "claude" });
  assert.equal(JSON.parse(await fs.readFile(claudeFile, "utf8")).env?.ANTHROPIC_BASE_URL, undefined);
  for (const [file, contents] of sentinelFiles) assert.equal(await fs.readFile(file, "utf8"), contents);
  assert.equal(await fs.readFile(productionPaths.config, "utf8"), productionConfig);
  assert.deepEqual(JSON.parse(await fs.readFile(productionPaths.secrets, "utf8")), {});
  assert.equal(JSON.parse(await fs.readFile(dev.paths.secrets, "utf8"))["secret://upstreams/codex"], "dev-key");
  assert.deepEqual((await loadConfig(other.paths)).bindings, {});
  assert.equal((await fetch(production.url)).status, 200);
  await otherApp.stop();
  await app.stop();
  const restarted = await dev.start();
  assert.equal(restarted.runtime.web.url, url);
  await restarted.stop();

  const saved = await fs.readFile(dev.paths.config, "utf8");
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(app.runtime.web.port, "127.0.0.1", resolve));
  f.cleanup(() => new Promise(resolve => blocker.close(resolve)));
  await assert.rejects(dev.run(), error => error.code === 1 && /EADDRINUSE/.test(error.stderr));
  assert.equal(await fs.readFile(dev.paths.config, "utf8"), saved);
  await assert.rejects(fs.access(dev.paths.lock), { code: "ENOENT" });
  await production.close();
});

test("development home override is shared by startup and read-only status", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const customHome = path.join(f.directory, "custom data");
  const dev = await f.checkout("checkout", { CABLETIDY_DEV_HOME: customHome });
  assert.equal((await dev.status()).runtime.status, "offline");
  await assert.rejects(fs.access(customHome), { code: "ENOENT" });
  const app = await dev.start();
  assert.equal((await dev.status()).runtime.web.url, app.runtime.web.url);
  assert.ok(app.output().includes(path.join(customHome, "codex")));
  assert.ok(app.output().includes(path.join(customHome, "claude")));
  await assert.rejects(fs.access(path.join(f.directory, "checkout", ".cabletidy-debug")), { code: "ENOENT" });
  await assert.rejects(fs.access(dev.env.CABLETIDY_HOME), { code: "ENOENT" });
  await app.stop();
});

test("watch restart releases the development lock and preserves the endpoint", {
  skip: process.platform === "win32", timeout: 30000,
}, async t => {
  const f = await fixture(t);
  const dev = await f.checkout("watch-checkout");
  const app = await dev.start({ watch: true });
  try {
    await fs.appendFile(dev.entry, "\n");
    await waitFor(async () => {
      const runtime = await readRuntimeInfo(dev.paths);
      return runtime && runtime.pid !== app.runtime.pid;
    });
    assert.equal((await dev.status()).runtime.web.url, app.runtime.web.url);
    assert.equal((await fetch(app.runtime.web.url)).status, 200);
  } finally {
    await app.stop();
  }
});
