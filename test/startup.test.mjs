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
import { createApplication } from "./helpers/native-app.mjs";
import { nativeBinary } from "./helpers/native.mjs";
import { getPaths, loadConfig, readRuntimeInfo, saveConfig } from "./helpers/native.mjs";
import { catalogFixture, codexConfigFixture } from "./helpers/codex-fixture.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/cabletidy.mjs", import.meta.url));

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
    async start(paths, options = {}) {
      const app = await createApplication({ ...options, paths, loadCodexCatalog: async () => catalogFixture() });
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

test("ordinary fixtures bind ephemeral ports and preserve their address across restart", async t => {
  const f = await fixture(t);
  const paths = f.paths();
  const app = await f.start(paths);
  const port = app.state.config.web.port;
  assert.ok(port > 0);
  const saved = await fs.readFile(paths.config, "utf8");
  await app.close();
  const peer = await f.start(f.paths("peer"));
  const restarted = await f.start(paths);
  assert.notEqual(peer.url, app.url);
  assert.equal(restarted.url, app.url);
  assert.equal(await fs.readFile(paths.config, "utf8"), saved);
  assert.equal((await fetch(restarted.url)).status, 200);
});

for (const preferredPort of [43100, 43101]) {
  test(`first startup persists the listening address with preferred port ${preferredPort ?? "default"}`, async t => {
    const f = await fixture(t);
    const paths = f.paths();
    const app = await f.start(paths, { preferredPort });
    const port = app.state.webServer.address().port;
    assert.equal(app.url, `http://127.0.0.1:${port}/`);
    assert.equal((await loadConfig(paths)).web.port, port);
  });
}

test("development port fallback is saved and takes precedence over the preferred port on restart", async t => {
  const f = await fixture(t);
  const blocker = await f.block();
  const preferredPort = blocker.address().port;
  const paths = f.paths();
  const app = await f.start(paths, { preferredPort });
  assert.notEqual(app.state.config.web.port, preferredPort);
  assert.equal((await loadConfig(paths)).web.port, app.state.config.web.port);
  await app.close();
  assert.equal((await f.start(paths, { preferredPort })).url, app.url);
});

test("a new store selects the preferred port when it is available", async t => {
  const f = await fixture(t);
  const reserved = await f.block();
  const preferredPort = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const app = await f.start(f.paths(), { preferredPort });
  assert.equal(app.state.config.web.port, preferredPort);
  assert.equal(new URL(app.url).port, String(preferredPort));
});

test("new stores allocate distinct ports while status stays read-only and restart keeps client URLs", async t => {
  const f = await fixture(t);
  const blocker = await f.block();
  const preferredPort = blocker.address().port;
  const paths = f.paths();
  assert.equal((await status(paths)).runtime.web, undefined);
  await assert.rejects(fs.access(paths.home), { code: "ENOENT" });
  const [app, other] = await Promise.all([
    f.start(paths, { preferredPort }),
    f.start(f.paths("other"), { preferredPort }),
  ]);
  const port = app.state.config.web.port;
  assert.ok(Number.isInteger(port) && port > 0);
  assert.notEqual(port, preferredPort);
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
  assert.ok((await fs.stat(paths.lock)).isFile());
  await assert.rejects(fs.access(paths.runtime), { code: "ENOENT" });
  const restarted = await f.start(paths);
  assert.equal(restarted.url, app.url);
  assert.equal(await fs.readFile(paths.config, "utf8"), saved);
  assert.equal((await status(paths)).configurations[0].url, `${app.url}relay/v1`);
});

test("an occupied saved port fails without changing configuration, releases the lock and allows retry", async t => {
  const f = await fixture(t);
  const paths = f.paths();
  const app = await f.start(paths);
  const saved = await fs.readFile(paths.config, "utf8");
  await app.close();
  const blocker = await f.block(app.state.config.web.port);
  await assert.rejects(f.start(paths), error => {
    assert.equal(error.code, "EADDRINUSE");
    assert.ok(error.message.includes(paths.config));
    assert.match(error.message, /web\.port/);
    return true;
  });
  assert.equal(await fs.readFile(paths.config, "utf8"), saved);
  assert.ok((await fs.stat(paths.lock)).isFile());
  await assert.rejects(fs.access(paths.runtime), { code: "ENOENT" });
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
      assert.equal(error.code, "ELOCKLEGACY");
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

test("legacy locks require manual migration even with a dead or mismatched PID", async t => {
  const f = await fixture(t);
  const paths = f.paths();
  await fs.mkdir(paths.lock, { recursive: true });
  const owner = JSON.stringify({ pid: 2147483647, startTime: "old", hostname: "another-host" });
  await fs.writeFile(path.join(paths.lock, "owner.json"), owner);
  await assert.rejects(f.start(paths), /ELOCKLEGACY/);
  await assert.rejects(execute(nativeBinary, ["stop"], {
    env: { ...process.env, CABLETIDY_HOME: paths.home },
  }), /ELOCKLEGACY/);
  assert.equal(await fs.readFile(path.join(paths.lock, "owner.json"), "utf8"), owner);
});

async function startChild(t, paths) {
  // Restart tests need a port that parallel fixtures will not claim as their default.
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const preferredPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(nativeBinary, ["start"], {
    env: { ...process.env, CABLETIDY_HOME: paths.home, CABLETIDY_PREFERRED_PORT: String(preferredPort) },
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

test("concurrent starts immediately after a killed daemon acquire exactly one kernel lock", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const paths = f.paths();
  const { child, closed } = await startChild(t, paths);
  child.kill("SIGKILL");
  await closed;
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => f.start(paths)));
  const started = results.filter(result => result.status === "fulfilled");
  assert.equal(started.length, 1, results.filter(result => result.status === "rejected").map(result => result.reason.stack).join("\n"));
  for (const result of results.filter(result => result.status === "rejected")) {
    assert.equal(result.reason.code, "ELOCKED", result.reason.stack);
  }
  await delay(2500);
  assert.equal((await status(paths)).runtime.web.url, started[0].value.url);
  assert.equal((await fetch(started[0].value.url)).status, 200);
});

test("a paused live instance retains its kernel lock regardless of file timestamps", {
  skip: process.platform === "win32", timeout: 30000,
}, async t => {
  const f = await fixture(t);
  const paths = f.paths();
  const { child, closed } = await startChild(t, paths);
  const runtime = await readRuntimeInfo(paths);
  process.kill(child.pid, "SIGSTOP");
  const stale = new Date(Date.now() - 60000);
  await fs.utimes(paths.lock, stale, stale);
  assert.equal((await status(paths)).runtime.status, "unresponsive");

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
  assert.ok((await fs.stat(paths.lock)).isFile());
  assert.equal(await fs.readFile(paths.config, "utf8"), saved);
  await assert.rejects(fs.access(paths.runtime), { code: "ENOENT" });
});
