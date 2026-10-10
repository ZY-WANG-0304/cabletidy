import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { defaultConfig, nativeBinary, processStartTime, inspectProcess } from "./helpers/native.mjs";
import { catalogFixture } from "./helpers/codex-fixture.mjs";
import { commandEnvironment, fixtureEnvironment, writeCodexCommand } from "./helpers/commands.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const signalTest = { timeout: 30000 };

async function waitFor(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail("Timed out waiting for daemon lifecycle");
}

async function fixture(t, { direct = false, mockCatalog = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-lifecycle-"));
  const calls = [];
  const upstream = http.createServer((request, response) => {
    request.resume();
    calls.push({ request, response });
  });
  let child;
  let closed;
  let monitor;
  let catalogPid;
  const catalogConnections = new Set();
  t.after(async () => {
    if (catalogPid) {
      try { process.kill(process.platform === "win32" ? catalogPid : -catalogPid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    for (const socket of catalogConnections) socket.destroy();
    if (monitor) await new Promise(resolve => monitor.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const config = defaultConfig();
  config.web.port = port;
  config.upstreams.relay = { id: "relay", protocol: "openai.responses", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` };
  config.routes.relay = { id: "relay", backends: [{ upstream: "relay" }] };
  config.virtualProviders.cabletidy_relay = { id: "cabletidy_relay", ingressProtocol: "openai.responses", route: "relay" };
  config.bindings.relay = { id: "relay", target: "codex", virtualProvider: "cabletidy_relay" };
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(config));
  let env = fixtureEnvironment({ CABLETIDY_HOME: directory, CODEX_HOME: path.join(directory, "client") });
  const releaseCatalog = path.join(directory, "release-catalog");
  if (mockCatalog) {
    monitor = net.createServer(socket => {
      catalogConnections.add(socket);
      socket.on("error", error => assert.equal(error.code, "ECONNRESET"));
      socket.on("close", () => catalogConnections.delete(socket));
    });
    await new Promise(resolve => monitor.listen(0, "127.0.0.1", resolve));
    const bin = path.join(directory, "bin");
    await fs.mkdir(bin);
    const worker = `
      const fs = require("node:fs");
      const socket = require("node:net").connect(${monitor.address().port}, "127.0.0.1");
      const interval = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(releaseCatalog)})) return;
        clearInterval(interval);
        socket.end();
      }, 20);
    `;
    await writeCodexCommand(bin, `
      const fs = require("node:fs");
      if (process.argv.includes("--version")) {
        fs.writeFileSync(${JSON.stringify(path.join(directory, "catalog-pid"))}, String(process.pid));
        const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { stdio: "ignore" });
        child.once("exit", () => console.log("codex-cli test"));
      } else {
        console.log(${JSON.stringify(JSON.stringify(catalogFixture().catalog))});
      }
    `);
    env = commandEnvironment(`${bin}${path.delimiter}${env.PATH || env.Path || ""}`, env);
  }
  const entry = "bin/cabletidy.mjs";
  const windows = process.platform === "win32";
  // Windows kill(SIGINT) terminates the process. Exercise the same handlers via
  // IPC there; actual console Ctrl+C delivery remains an interactive check.
  const args = windows ? ["--input-type=module", "-e", `
    process.argv = [process.execPath, ${JSON.stringify(path.join(root, entry))}, "start"];
    process.on("message", signal => process.emit(signal, signal));
    process.channel.unref();
    await import(${JSON.stringify(new URL(`../${entry}`, import.meta.url).href)});
  `] : [entry, ...(direct ? [] : ["start"])];
  child = spawn(direct && !windows ? nativeBinary : process.execPath, direct && !windows ? ["start"] : args, {
    cwd: root, env, stdio: windows ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  const signalChild = signal => windows ? child.send(signal) : child.kill(signal);
  if (windows) t.diagnostic("Shutdown handlers exercised via IPC; this does not emulate Windows console events");
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await waitFor(() => {
    assert.equal(child.exitCode, null, output);
    return output.includes("Ctrl+C");
  });
  return {
    child, closed, calls, directory, signal: signalChild,
    url: `http://127.0.0.1:${port}/`,
    runtime: path.join(directory, "runtime.json"),
    catalogConnections,
    releaseCatalog: () => fs.writeFile(releaseCatalog, "ready"),
    async waitForCatalog() {
      await waitFor(() => catalogConnections.size === 1);
      catalogPid = Number(await fs.readFile(path.join(directory, "catalog-pid"), "utf8"));
    },
    async stop(signal) {
      signalChild(signal);
      await waitFor(() => output.includes("再次按 Ctrl+C"));
    },
    async expectExit(code) {
      await waitFor(() => child.exitCode !== null || child.signalCode !== null);
      assert.deepEqual(await closed, { code, signal: null }, output);
    },
  };
}

async function daemonStatus(app) {
  const result = await execute(nativeBinary, ["status"], {
    env: { ...process.env, CABLETIDY_HOME: app.directory }, timeout: 5000,
  });
  return JSON.parse(result.stdout);
}

async function startStream(app) {
  const response = fetch(`${app.url}relay/v1/responses`, {
    method: "POST",
    body: JSON.stringify({ model: "gpt-test", stream: true }),
  });
  await waitFor(() => app.calls.length === 1);
  const upstream = app.calls[0].response;
  upstream.writeHead(200, { "content-type": "text/event-stream" });
  upstream.write('data: {"delta":"first"}\n\n');
  const text = (await response).text();
  // A forced exit intentionally aborts the response body.
  text.catch(() => {});
  return { upstream, text };
}

for (const mockCatalog of [false, true]) {
  test(`lifecycle fixture ignores inherited proxies with mockCatalog=${mockCatalog}`, signalTest, async t => {
    const inherited = process.env;
    process.env = { ...inherited };
    t.after(() => { process.env = inherited; });
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
      process.env[key] = process.env[key.toLowerCase()] = "http://127.0.0.1:9";
    }
    process.env.NO_PROXY = process.env.no_proxy = "";
    const app = await fixture(t, { mockCatalog });
    const { upstream, text } = await startStream(app);
    upstream.end('data: {"delta":"last"}\n\n');
    assert.match(await text, /first[\s\S]*last/);
    await app.stop("SIGTERM");
    await app.expectExit(0);
  });
}

test("stop waits for streaming requests and releases the instance lock", signalTest, async t => {
  const app = await fixture(t);
  const { upstream, text } = await startStream(app);
  let done = false;
  const stopping = execute(process.execPath, ["bin/cabletidy.mjs", "stop"], {
    cwd: root, env: { ...process.env, CABLETIDY_HOME: app.directory }, timeout: 25000,
  }).then(result => { done = true; return result; });
  stopping.catch(() => {});
  await waitFor(async () => (await daemonStatus(app)).runtime.status === "stopping");
  await delay(10500);
  assert.equal(done, false, "stop must not time out while a request is active");
  upstream.end('data: {"delta":"last"}\n\n');
  assert.match(await text, /first[\s\S]*last/);
  assert.match((await stopping).stdout, /CableTidy stopped/);
  await app.expectExit(0);
  await assert.rejects(fs.access(app.runtime), { code: "ENOENT" });
  assert.ok((await fs.stat(path.join(app.directory, "daemon.lock"))).isFile());
});

async function stopClient(t, directory) {
  const client = spawn(process.execPath, ["--input-type=module", "-e", `
    import { launch } from ${JSON.stringify(new URL("../bin/native.mjs", import.meta.url).href)};
    process.on("message", signal => process.emit(signal));
    process.channel.unref();
    const running = launch(["stop"]);
    process.send({ pid: running.child.pid });
    process.exitCode = await running.closed;
  `], { env: { ...process.env, CABLETIDY_HOME: directory }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  client.stdout.on("data", chunk => { output += chunk; });
  client.stderr.on("data", chunk => { output += chunk; });
  const closed = new Promise((resolve, reject) => {
    client.once("error", reject);
    client.once("close", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (client.exitCode === null && client.signalCode === null) client.kill("SIGKILL");
    await closed;
  });
  const pid = await new Promise(resolve => client.once("message", message => resolve(message.pid)));
  const identity = { pid, startTime: await processStartTime(pid) };
  return {
    output: () => output,
    signal: signal => process.platform === "win32" ? client.send(signal) : client.kill(signal),
    async expectStopped() {
      assert.deepEqual(await closed, { code: 0, signal: null }, output);
      assert.match(output, /CableTidy stopped/);
    },
    async expectCancelled(code, submitted) {
      const exit = await Promise.race([closed, delay(5000).then(() => { throw new Error("stop client did not cancel"); })]);
      assert.deepEqual(exit, { code, signal: null }, output);
      assert.match(output, submitted ? /已取消等待，停止请求仍将继续执行/ : /未发送停止请求/);
      assert.equal(await inspectProcess(identity), "dead", "launcher must reap its Rust stop child");
    },
  };
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`${signal} cancels stop waiting without interrupting daemon draining`, signalTest, async t => {
    const app = await fixture(t);
    const { upstream, text } = await startStream(app);
    const client = await stopClient(t, app.directory);
    await waitFor(() => client.output().includes("Stopping CableTidy"));
    await waitFor(async () => {
      try { await fetch(`${app.url}api/v1/runtime`); return false; }
      catch { return true; }
    });
    client.signal(signal);
    await client.expectCancelled(code, true);
    assert.equal(app.child.exitCode, null);
    assert.equal((await daemonStatus(app)).runtime.status, "stopping");
    upstream.end('data: {"delta":"last"}\n\n');
    assert.match(await text, /first[\s\S]*last/);
    await app.expectExit(0);
  });

  test(`${signal} before submission cancels stop without sending a request`, {
    ...signalTest, skip: process.platform === "win32",
  }, async t => {
    const app = await fixture(t);
    const saved = `${app.runtime}.saved`;
    await fs.rename(app.runtime, saved);
    await execute("mkfifo", [app.runtime]);
    // Block the read-only preparation stage; cancellation must not publish a request later.
    const client = await stopClient(t, app.directory);
    client.signal(signal);
    await client.expectCancelled(code, false);
    await fs.rename(saved, app.runtime);
    assert.ok(!(await fs.readdir(app.directory)).some(name => name.startsWith("stop-")));
    assert.equal((await fetch(`${app.url}api/v1/runtime`)).status, 200);
    await app.stop("SIGTERM");
    await app.expectExit(0);
  });
}

test("repeated stop cancellations keep status and new stop waiters available during draining", {
  timeout: 120000,
}, async t => {
  const app = await fixture(t);
  const { upstream, text } = await startStream(app);
  for (let attempt = 0; attempt < 34; attempt += 1) {
    const client = await stopClient(t, app.directory);
    await waitFor(() => client.output().includes("Stopping CableTidy"));
    const [signal, code] = attempt % 2 ? ["SIGTERM", 143] : ["SIGINT", 130];
    client.signal(signal);
    await client.expectCancelled(code, true);
  }
  assert.equal(app.child.exitCode, null);
  assert.equal((await daemonStatus(app)).runtime.status, "stopping");
  const waiting = await stopClient(t, app.directory);
  await waitFor(() => waiting.output().includes("Stopping CableTidy"));
  upstream.end('data: {"delta":"last"}\n\n');
  assert.match(await text, /first[\s\S]*last/);
  await waiting.expectStopped();
  await app.expectExit(0);
});

test("cancelling stop before a paused daemon completes its handshake sends no request", {
  ...signalTest, skip: process.platform === "win32",
}, async t => {
  const app = await fixture(t, { direct: true });
  app.child.kill("SIGSTOP");
  t.after(() => { if (app.child.exitCode === null) app.child.kill("SIGCONT"); });
  const client = await stopClient(t, app.directory);
  client.signal("SIGINT");
  await client.expectCancelled(130, false);
  app.child.kill("SIGCONT");
  assert.equal((await fetch(app.url)).status, 200);
  assert.equal((await daemonStatus(app)).runtime.status, "online");
  await app.stop("SIGTERM");
  await app.expectExit(0);
});

test("stop and status use IPC despite changed hostname and invalid diagnostic PID fields", signalTest, async t => {
  const app = await fixture(t);
  const runtime = JSON.parse(await fs.readFile(app.runtime, "utf8"));
  await fs.writeFile(app.runtime, JSON.stringify({ ...runtime, hostname: "renamed-host", pid: -1, pidStartTime: null }));
  assert.equal((await daemonStatus(app)).runtime.status, "online");
  const result = await execute(nativeBinary, ["stop"], { env: { ...process.env, CABLETIDY_HOME: app.directory } });
  assert.match(result.stdout, /CableTidy stopped/);
  await app.expectExit(0);
  await assert.rejects(fs.access(app.runtime), { code: "ENOENT" });
});

test("a daemon crash during draining is not reported as a successful stop", {
  ...signalTest, skip: process.platform === "win32",
}, async t => {
  const app = await fixture(t, { direct: true });
  await startStream(app);
  const stopping = execute(nativeBinary, ["stop"], {
    env: { ...process.env, CABLETIDY_HOME: app.directory }, timeout: 10000,
  });
  stopping.catch(() => {});
  await waitFor(async () => (await daemonStatus(app)).runtime.status === "stopping");
  app.child.kill("SIGKILL");
  await app.closed;
  await assert.rejects(stopping, error => {
    assert.match(error.stderr, /closed before shutdown completed/);
    assert.doesNotMatch(error.stdout, /CableTidy stopped/);
    return true;
  });
  assert.equal((await daemonStatus(app)).runtime.status, "offline");
});

test("stale runtime generations cannot stop the current instance", signalTest, async t => {
  const app = await fixture(t);
  const runtime = JSON.parse(await fs.readFile(app.runtime, "utf8"));
  await fs.writeFile(app.runtime, JSON.stringify({ ...runtime, controlId: "00000000-0000-4000-8000-000000000001" }));
  await assert.rejects(execute(nativeBinary, ["stop"], { env: { ...process.env, CABLETIDY_HOME: app.directory } }), /control channel is unavailable/);
  assert.equal((await fetch(app.url)).status, 200);
  await fs.writeFile(app.runtime, JSON.stringify(runtime));
  assert.equal((await daemonStatus(app)).runtime.status, "online");
  await app.stop("SIGTERM");
  await app.expectExit(0);
});

test("an unlocked store ignores stale runtime PID metadata", signalTest, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-stop-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "runtime.json"), JSON.stringify({ pid: process.pid }));
  const result = await execute(nativeBinary, ["stop"], { env: { ...process.env, CABLETIDY_HOME: directory } });
  assert.match(result.stdout, /not running/);
  assert.deepEqual(await fs.readdir(directory), ["runtime.json"]);
});

test("disconnecting before upstream headers cancels the pending inference request", signalTest, async t => {
  const app = await fixture(t, { direct: true });
  const request = http.request(`${app.url}relay/v1/responses`, { method: "POST" });
  request.on("error", () => {});
  request.end(JSON.stringify({ model: "gpt-test", stream: true }));
  await waitFor(() => app.calls.length === 1);
  let cancelled = false;
  app.calls[0].response.on("close", () => { cancelled = true; });
  request.destroy();
  await waitFor(() => cancelled);
  await app.stop("SIGTERM");
  await app.expectExit(0);
});

test("SIGINT drains a stream beyond five seconds and cleans runtime after completion", signalTest, async t => {
  const app = await fixture(t);
  const { upstream, text } = await startStream(app);
  await app.stop("SIGINT");
  await assert.rejects(fetch(`${app.url}api/v1/runtime`), error => error.cause?.code === "ECONNREFUSED");
  await delay(5500);
  assert.equal(app.child.exitCode, null);
  assert.equal(app.child.signalCode, null);
  await fs.access(app.runtime);
  await assert.rejects(execute(process.execPath, ["bin/cabletidy.mjs", "start"], {
    cwd: root,
    env: { ...process.env, CABLETIDY_HOME: app.directory },
    timeout: 5000,
  }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /ELOCKED/);
    return true;
  });
  upstream.end('data: {"delta":"last"}\n\n');
  assert.match(await text, /first[\s\S]*last/);
  await app.expectExit(0);
  await assert.rejects(fs.access(app.runtime), { code: "ENOENT" });
  assert.ok((await fs.stat(path.join(app.directory, "daemon.lock"))).isFile());
});

test("direct startup waits for a probe after its client disconnects on SIGTERM", signalTest, async t => {
  const app = await fixture(t, { direct: true });
  const request = http.request(`${app.url}api/v1/tests/upstream`, { method: "POST" });
  request.on("error", () => {});
  request.end(JSON.stringify({ id: "relay" }));
  await waitFor(() => app.calls.length === 1);
  request.destroy();
  await app.stop("SIGTERM");
  await delay(100);
  assert.equal(app.child.exitCode, null);
  await fs.access(app.runtime);
  app.calls[0].response.end("ready");
  await app.expectExit(0);
  await assert.rejects(fs.access(app.runtime), { code: "ENOENT" });
});

test("a second Ctrl+C forces exit while a stream is still active", signalTest, async t => {
  const app = await fixture(t);
  const { upstream, text } = await startStream(app);
  await app.stop("SIGINT");
  app.signal("SIGINT");
  await app.expectExit(130);
  await assert.rejects(text);
  await waitFor(() => upstream.destroyed);
});

for (const force of [false, true]) {
  test(`disconnected catalog query ${force ? "and launcher descendants stop on a second interrupt" : "finishes before runtime cleanup"}`, signalTest, async t => {
    const app = await fixture(t, { direct: true, mockCatalog: true });
    const request = http.get(`${app.url}api/v1/codex/models`);
    request.on("error", () => {});
    await app.waitForCatalog();
    request.destroy();
    await app.stop("SIGTERM");
    await delay(100);
    await fs.access(app.runtime);
    assert.equal(app.catalogConnections.size, 1);
    if (force) {
      app.signal("SIGINT");
      await app.expectExit(130);
    } else {
      await app.releaseCatalog();
      await app.expectExit(0);
      await assert.rejects(fs.access(app.runtime), { code: "ENOENT" });
    }
    await waitFor(() => app.catalogConnections.size === 0);
  });
}

if (process.platform === "win32") {
  test("Windows catalog descendants exit after abrupt daemon termination", signalTest, async t => {
    const app = await fixture(t, { mockCatalog: true });
    const request = http.get(`${app.url}api/v1/codex/models`);
    request.on("error", () => {});
    await app.waitForCatalog();
    app.child.kill("SIGKILL");
    await app.closed;
    await waitFor(() => app.catalogConnections.size === 0);
  });
}

for (const direct of [false, true]) {
  test(`${direct ? "native" : "npm foreground"} restart drains requests and preserves configuration and address`, signalTest, async t => {
    const app = await fixture(t);
    const beforeRuntime = JSON.parse(await fs.readFile(app.runtime, "utf8"));
    const configFile = path.join(app.directory, "config.json");
    const secretsFile = path.join(app.directory, "secrets.json");
    const beforeConfig = await fs.readFile(configFile, "utf8");
    const beforeSecrets = await fs.readFile(secretsFile, "utf8");
    const { upstream, text } = await startStream(app);
    const child = spawn(direct ? nativeBinary : process.execPath,
      direct ? ["restart"] : ["bin/cabletidy.mjs", "restart", "--foreground"], {
        cwd: root, env: fixtureEnvironment({ CABLETIDY_HOME: app.directory, CODEX_HOME: path.join(app.directory, "client"), CABLETIDY_MANAGED_STDIN: "1" }),
        stdio: ["pipe", "pipe", "pipe"],
      });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    });
    await waitFor(async () => (await daemonStatus(app)).runtime.status === "stopping");
    assert.equal(JSON.parse(await fs.readFile(app.runtime, "utf8")).controlId, beforeRuntime.controlId);
    assert.doesNotMatch(output, /CableTidy stopped/);
    upstream.end("data: [DONE]\n\n");
    await text;
    await app.expectExit(0);
    await waitFor(async () => {
      const status = await daemonStatus(app);
      return status.runtime.status === "online" && status.runtime.controlId !== beforeRuntime.controlId;
    });
    assert.match(output, /CableTidy stopped/);
    assert.equal((await daemonStatus(app)).runtime.web.url, app.url);
    assert.equal(await fs.readFile(configFile, "utf8"), beforeConfig);
    assert.equal(await fs.readFile(secretsFile, "utf8"), beforeSecrets);
    assert.equal((await fetch(app.url)).status, 200);
    await execute(nativeBinary, ["stop"], { env: { ...process.env, CABLETIDY_HOME: app.directory } });
    assert.deepEqual(await closed, { code: 0, signal: null }, output);
  });
}

test("restart starts an offline daemon and responds to managed shutdown after startup", signalTest, async t => {
  const app = await fixture(t);
  await execute(nativeBinary, ["stop"], { env: { ...process.env, CABLETIDY_HOME: app.directory } });
  await app.expectExit(0);
  const child = spawn(nativeBinary, ["restart"], {
    env: fixtureEnvironment({ CABLETIDY_HOME: app.directory, CABLETIDY_MANAGED_STDIN: "1", CODEX_HOME: path.join(app.directory, "client") }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  await waitFor(() => output.includes("Ctrl+C"));
  assert.match(output, /not running/);
  assert.equal((await daemonStatus(app)).runtime.web.url, app.url);
  child.stdin.write("SIGTERM\n");
  await waitFor(() => child.exitCode !== null);
  assert.deepEqual(await closed, { code: 0, signal: null });
  await assert.rejects(fs.access(app.runtime), { code: "ENOENT" });
});

test("cancelling restart while draining does not launch a replacement daemon", signalTest, async t => {
  const app = await fixture(t);
  const { upstream, text } = await startStream(app);
  const child = spawn(nativeBinary, ["restart"], {
    env: fixtureEnvironment({ CABLETIDY_HOME: app.directory, CABLETIDY_MANAGED_STDIN: "1" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  await waitFor(() => output.includes("waiting for active requests"));
  child.stdin.write("SIGTERM\n");
  await waitFor(() => child.exitCode !== null);
  assert.deepEqual(await closed, { code: 143, signal: null }, output);
  assert.equal((await daemonStatus(app)).runtime.status, "stopping");
  upstream.end("data: [DONE]\n\n");
  await text;
  await app.expectExit(0);
  assert.equal((await daemonStatus(app)).runtime.status, "offline");
});
