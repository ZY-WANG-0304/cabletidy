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
import { defaultConfig, nativeBinary } from "./helpers/native.mjs";
import { catalogFixture } from "./helpers/codex-fixture.mjs";
import { commandEnvironment, writeCodexCommand } from "./helpers/commands.mjs";

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
  let env = { ...process.env, CABLETIDY_HOME: directory, CODEX_HOME: path.join(directory, "client") };
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
    env = { ...commandEnvironment(`${bin}${path.delimiter}${process.env.PATH || process.env.Path || ""}`),
      CABLETIDY_HOME: directory, CODEX_HOME: path.join(directory, "client") };
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
  await assert.rejects(fs.access(path.join(app.directory, "daemon.lock")), { code: "ENOENT" });
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
