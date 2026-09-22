import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createApplication } from "../src/server.mjs";
import { processStartTime } from "../src/process-identity.mjs";
import { defaultConfig, getPaths, loadConfig, readRuntimeInfo, saveConfig } from "../src/config.mjs";
import { catalogFixture, codexConfigFixture } from "./helpers/codex-fixture.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-startup-"));
  const apps = [];
  const servers = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    paths: (name = "data") => getPaths(path.join(directory, name)),
    async start(paths) {
      const app = await createApplication({ paths, loadCodexCatalog: async () => catalogFixture() });
      apps.push(app);
      return app;
    },
    async block(port = 0) {
      const server = net.createServer(socket => socket.destroy());
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      servers.push(server);
      return server;
    },
    async blockDefault() {
      try {
        return await this.block(43100);
      } catch (error) {
        if (error.code !== "EADDRINUSE") throw error;
        t.diagnostic("Default port is already occupied; exercising fallback against that listener");
        return null;
      }
    },
  };
}

async function status(paths) {
  return JSON.parse((await execute(process.execPath, [cli, "status"], {
    env: { ...process.env, CABLETIDY_HOME: paths.home },
    timeout: 5000,
  })).stdout);
}

async function post(app, endpoint, body) {
  const response = await fetch(`${app.url}api/v1/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

test("first startup persists the listening address when the preferred bind succeeds", async t => {
  const f = await fixture(t);
  const listen = net.Server.prototype.listen;
  const attempts = [];
  // Redirect the preferred bind so this success path works on shared CI hosts too.
  t.mock.method(net.Server.prototype, "listen", function (port, ...args) {
    attempts.push(port);
    return listen.call(this, port === 43100 ? 0 : port, ...args);
  });
  const paths = f.paths();
  const app = await f.start(paths);
  assert.deepEqual(attempts, [43100]);
  const port = app.state.webServer.address().port;
  assert.equal(app.url, `http://127.0.0.1:${port}/`);
  assert.equal((await loadConfig(paths)).web.port, port);
});

test("new stores allocate distinct ports while status stays read-only and restart keeps client URLs", async t => {
  const f = await fixture(t);
  await f.blockDefault();
  const paths = f.paths();
  assert.equal((await status(paths)).runtime.web, undefined);
  await assert.rejects(fs.access(paths.home), { code: "ENOENT" });
  const [app, other] = await Promise.all([f.start(paths), f.start(f.paths("other"))]);
  const port = app.state.config.web.port;
  assert.ok(Number.isInteger(port) && port > 0);
  assert.notEqual(port, 43100);
  assert.notEqual(app.url, other.url);
  for (const instance of [app, other]) {
    const saved = await loadConfig(instance.state.paths);
    const runtime = await readRuntimeInfo(instance.state.paths);
    assert.equal(saved.web.port, instance.state.webServer.address().port);
    assert.equal(runtime.web.port, saved.web.port);
    assert.equal(runtime.web.url, instance.url);
    assert.equal((await fetch(instance.url)).status, 200);
  }

  await post(app, "config/commit", {
    baseRevision: app.state.config.revision,
    config: { ...app.state.config, ...codexConfigFixture() },
  });
  const output = await status(paths);
  assert.equal(output.runtime.status, "online");
  assert.equal(output.runtime.web.url, app.url);
  assert.equal(output.configurations[0].url, `${app.url}relay/v1`);
  const preview = await post(app, "config/preview-target-artifacts", { bindingId: "relay" });
  const toml = preview.artifacts.files.find(file => file.path === "config.toml").contents;
  assert.ok(toml.includes(`base_url = "${app.url}relay/v1"`));
  assert.equal((await fetch(`${app.url}relay/v1/models`)).status, 200);

  const saved = await fs.readFile(paths.config, "utf8");
  await app.close();
  await assert.rejects(fs.access(paths.lock), { code: "ENOENT" });
  await assert.rejects(fs.access(paths.runtime), { code: "ENOENT" });
  const restarted = await f.start(paths);
  assert.equal(restarted.url, app.url);
  assert.equal(await fs.readFile(paths.config, "utf8"), saved);
  assert.equal((await status(paths)).configurations[0].url, `${app.url}relay/v1`);
});

test("an explicit occupied port fails without changing configuration and releases the startup lock", async t => {
  const f = await fixture(t);
  const blocker = await f.block();
  const paths = f.paths();
  const config = defaultConfig();
  config.web.port = blocker.address().port;
  await saveConfig(config, paths);
  const saved = await fs.readFile(paths.config, "utf8");
  await assert.rejects(f.start(paths), error => {
    assert.equal(error.code, "EADDRINUSE");
    assert.ok(error.message.includes(paths.config));
    assert.match(error.message, /web\.port/);
    return true;
  });
  assert.equal(await fs.readFile(paths.config, "utf8"), saved);
  await assert.rejects(fs.access(paths.lock), { code: "ENOENT" });
  await assert.rejects(fs.access(paths.runtime), { code: "ENOENT" });
  await new Promise(resolve => blocker.close(resolve));
  const app = await f.start(paths);
  assert.equal(app.state.config.web.port, config.web.port);
});

test("a previously allocated port is never silently replaced on restart", async t => {
  const f = await fixture(t);
  await f.blockDefault();
  const paths = f.paths();
  const app = await f.start(paths);
  const saved = await fs.readFile(paths.config, "utf8");
  await app.close();
  const blocker = await f.block(app.state.config.web.port);
  await assert.rejects(f.start(paths), { code: "EADDRINUSE" });
  assert.equal(await fs.readFile(paths.config, "utf8"), saved);
  await new Promise(resolve => blocker.close(resolve));
  assert.equal((await f.start(paths)).url, app.url);
});

test("concurrent starts of the same store create one instance and do not overwrite runtime", async t => {
  const f = await fixture(t);
  const paths = f.paths();
  const results = await Promise.allSettled([f.start(paths), f.start(paths)]);
  const started = results.filter(result => result.status === "fulfilled");
  const failed = results.filter(result => result.status === "rejected");
  assert.equal(started.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, "ELOCKED");
  const runtime = await fs.readFile(paths.runtime, "utf8");
  const saved = await fs.readFile(paths.config, "utf8");
  await assert.rejects(execute(process.execPath, [cli, "start"], {
    env: { ...process.env, CABLETIDY_HOME: paths.home }, timeout: 5000,
  }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /ELOCKED/);
    return true;
  });
  assert.equal(await fs.readFile(paths.runtime, "utf8"), runtime);
  assert.equal(await fs.readFile(paths.config, "utf8"), saved);
  assert.equal((await status(paths)).runtime.status, "online");
});

test("legacy locks without reliable identity give actionable recovery instructions", async t => {
  const f = await fixture(t);
  const paths = f.paths();
  await fs.mkdir(paths.lock, { recursive: true });
  await fs.writeFile(paths.runtime, JSON.stringify({ pid: process.pid }));
  const stale = new Date(Date.now() - 60000);
  await fs.utimes(paths.lock, stale, stale);
  for (const owner of [undefined, { pid: process.pid, startTime: null }]) {
    if (owner) {
      await fs.writeFile(path.join(paths.lock, "owner.json"), JSON.stringify(owner));
      await fs.utimes(paths.lock, stale, stale);
    }
    await assert.rejects(f.start(paths), error => {
      assert.equal(error.code, "ELOCKUNKNOWN");
      assert.ok(error.message.includes(paths.lock));
      assert.match(error.message, /确认实例已退出/);
      return true;
    });
    await assert.rejects(fs.access(paths.config), { code: "ENOENT" });
  }
  // Simulate the documented recovery after the operator verifies no daemon owns this store.
  await fs.rm(paths.lock, { recursive: true });
  const app = await f.start(paths);
  assert.equal((await status(paths)).runtime.web.url, app.url);
});

test("a stale lock is recovered when its PID belongs to a different process generation", async t => {
  const f = await fixture(t);
  const paths = f.paths();
  await fs.mkdir(paths.lock, { recursive: true });
  const current = await processStartTime(process.pid);
  const previous = current.replace(/\d$/, digit => String((Number(digit) + 1) % 10));
  assert.notEqual(previous, current);
  await fs.writeFile(path.join(paths.lock, "owner.json"), JSON.stringify({ pid: process.pid, startTime: previous }));
  const stale = new Date(Date.now() - 60000);
  await fs.utimes(paths.lock, stale, stale);
  const app = await f.start(paths);
  assert.equal((await status(paths)).runtime.web.url, app.url);
});

async function startChild(t, paths) {
  const child = spawn(process.execPath, [cli, "start"], {
    env: { ...process.env, CABLETIDY_HOME: paths.home },
    stdio: "ignore",
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const runtime = await readRuntimeInfo(paths);
      if (runtime?.pid === child.pid) break;
    } catch {
      // The daemon may be between its atomic runtime writes.
    }
    await delay(25);
  }
  assert.equal((await readRuntimeInfo(paths))?.pid, child.pid);
  return { child, closed };
}

test("concurrent stale-lock reclaimers preserve the new owner after a killed daemon", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const paths = f.paths();
  const { child, closed } = await startChild(t, paths);
  child.kill("SIGKILL");
  await closed;
  const stale = new Date(Date.now() - 60000);
  await fs.utimes(paths.lock, stale, stale);
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => f.start(paths)));
  const started = results.filter(result => result.status === "fulfilled");
  assert.equal(started.length, 1);
  for (const result of results.filter(result => result.status === "rejected")) assert.equal(result.reason.code, "ELOCKED");
  await delay(2500);
  assert.equal((await status(paths)).runtime.web.url, started[0].value.url);
  assert.equal((await fetch(started[0].value.url)).status, 200);
});

test("a stale lock held by a paused live instance survives resume and subsequent heartbeats", {
  skip: process.platform === "win32", timeout: 30000,
}, async t => {
  const f = await fixture(t);
  const paths = f.paths();
  const { child, closed } = await startChild(t, paths);
  const runtime = await readRuntimeInfo(paths);
  process.kill(child.pid, "SIGSTOP");
  await delay(11500);

  await assert.rejects(f.start(paths), error => {
    assert.equal(error.code, "ELOCKED");
    return true;
  });
  process.kill(child.pid, "SIGCONT");
  await delay(2500);
  assert.equal((await fetch(runtime.web.url, { signal: AbortSignal.timeout(3000) })).status, 200);
  process.kill(child.pid, "SIGTERM");
  assert.deepEqual(await closed, { code: 0, signal: null });
});

test("invalid configuration releases the lock and is preserved", async t => {
  const f = await fixture(t);
  const paths = f.paths();
  await saveConfig({ web: { port: -1 } }, paths);
  const saved = await fs.readFile(paths.config, "utf8");
  await assert.rejects(f.start(paths), /web\.port/);
  await assert.rejects(fs.access(paths.lock), { code: "ENOENT" });
  assert.equal(await fs.readFile(paths.config, "utf8"), saved);
  await assert.rejects(fs.access(paths.runtime), { code: "ENOENT" });
});
