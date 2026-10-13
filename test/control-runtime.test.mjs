import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createApplication } from "./helpers/native-app.mjs";
import { getPaths, nativeBinary } from "./helpers/native.mjs";
import { controlAddress } from "./helpers/control.mjs";

const execute = promisify(execFile);
const unix = { skip: process.platform === "win32" };

async function fixture(t, runtimeDirectory) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ct-home-"));
  const paths = getPaths(home);
  let app;
  t.after(async () => {
    await app?.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  app = await createApplication({ paths, env: { XDG_RUNTIME_DIR: runtimeDirectory } });
  const runtime = JSON.parse(await fs.readFile(paths.runtime, "utf8"));
  const cli = (command, xdg = undefined) => execute(nativeBinary, [command], {
    env: { ...process.env, CABLETIDY_HOME: home, XDG_RUNTIME_DIR: xdg ?? "" }, timeout: 5000,
  });
  return { app, home, paths, runtime, cli };
}

test("XDG control sockets isolate instances, persist across saves and work from another environment", unix, async t => {
  // A short root exercises the portable macOS socket path limit too.
  const root = await fs.mkdtemp("/tmp/ct-xdg-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o700);
  const f = await fixture(t, root);
  const peer = await fixture(t, root);
  const canonical = await fs.realpath(root);
  const socket = f.runtime.controlAddress;
  assert.ok(socket.startsWith(path.join(canonical, "cabletidy") + path.sep));
  assert.ok(Buffer.byteLength(socket) < 104);
  assert.ok((await fs.stat(socket)).isSocket());
  assert.notEqual(path.dirname(socket), path.dirname(peer.runtime.controlAddress));
  assert.equal((await fs.stat(path.dirname(socket))).mode & 0o777, 0o700);
  for (const xdg of [undefined, "/missing-other-session", peer.home]) {
    assert.equal(JSON.parse((await f.cli("status", xdg)).stdout).runtime.status, "online");
  }
  const { config } = await (await fetch(`${f.app.url}api/v1/config`)).json();
  const response = await fetch(`${f.app.url}api/v1/config/commit`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: config.revision, config: { ...config, audit: { ...config.audit, retentionDays: 7 } } }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(JSON.parse(await fs.readFile(f.paths.runtime, "utf8")).controlAddress, socket);
  assert.equal(JSON.parse((await f.cli("status")).stdout).runtime.status, "online");
  assert.match((await f.cli("stop", "/different-session")).stdout, /CableTidy stopped/);
  await f.app.close();
  await assert.rejects(fs.access(socket), { code: "ENOENT" });
  assert.equal(JSON.parse((await peer.cli("status")).stdout).runtime.status, "online");
  await peer.app.close();
});

test("invalid XDG runtime directories fall back without modifying the supplied paths", unix, async t => {
  const root = await fs.mkdtemp("/tmp/ct-invalid-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o700);
  const missing = path.join(root, "missing");
  const file = path.join(root, "file");
  await fs.writeFile(file, "keep");
  const shared = path.join(root, "shared");
  await fs.mkdir(shared, { mode: 0o755 });
  await fs.chmod(shared, 0o755);
  const link = path.join(root, "link");
  await fs.symlink(root, link);
  const long = path.join(root, "long-runtime-".repeat(10));
  await fs.mkdir(long, { mode: 0o700 });
  const blocked = path.join(root, "blocked");
  await fs.mkdir(blocked, { mode: 0o700 });
  await fs.writeFile(path.join(blocked, "cabletidy"), "keep");
  for (const xdg of [undefined, "", "relative/path", missing, file, shared, link, long, blocked]) {
    const f = await fixture(t, xdg);
    const expected = controlAddress(f.home, f.runtime.controlId);
    assert.equal(f.runtime.controlAddress, expected);
    assert.equal(JSON.parse((await f.cli("status", root)).stdout).runtime.status, "online");
    await f.app.close();
    await fs.rmdir(path.dirname(expected));
  }
  await assert.rejects(fs.access(missing), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(long, "cabletidy")), { code: "ENOENT" });
  assert.equal(await fs.readFile(file, "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(blocked, "cabletidy"), "utf8"), "keep");
  assert.equal((await fs.stat(shared)).mode & 0o777, 0o755);
  assert.ok((await fs.lstat(link)).isSymbolicLink());
});

test("legacy runtime files retain /tmp discovery and invalid saved addresses never retarget a stop", unix, async t => {
  const f = await fixture(t, undefined);
  const legacy = { ...f.runtime };
  delete legacy.controlAddress;
  await fs.writeFile(f.paths.runtime, JSON.stringify(legacy));
  assert.equal(JSON.parse((await f.cli("status", f.home)).stdout).runtime.status, "online");
  for (const invalid of [null, "relative.sock", "/tmp/invalid\u0000.sock", 7]) {
    await fs.writeFile(f.paths.runtime, JSON.stringify({ ...f.runtime, controlAddress: invalid }));
    assert.equal(JSON.parse((await f.cli("status")).stdout).runtime.status, "unresponsive");
    await assert.rejects(f.cli("stop"), /Invalid daemon controlAddress/);
  }
  await fs.writeFile(f.paths.runtime, JSON.stringify(legacy));
  assert.match((await f.cli("stop", f.home)).stdout, /CableTidy stopped/);
  await f.app.close();
  await assert.rejects(fs.access(f.runtime.controlAddress), { code: "ENOENT" });
  await fs.rmdir(path.dirname(f.runtime.controlAddress));
});

test("restart discovers the saved socket and selects the new runtime directory", unix, async t => {
  const roots = await Promise.all([fs.mkdtemp("/tmp/ct-r1-"), fs.mkdtemp("/tmp/ct-r2-")]);
  t.after(() => Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true }))));
  for (const root of roots) await fs.chmod(root, 0o700);
  const f = await fixture(t, roots[0]);
  let previous = f.runtime;
  const beforeConfig = await fs.readFile(f.paths.config, "utf8");
  for (const xdg of [roots[1], ""]) {
    const child = spawn(nativeBinary, ["restart"], {
      env: { ...process.env, CABLETIDY_HOME: f.home, XDG_RUNTIME_DIR: xdg, CABLETIDY_MANAGED_STDIN: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const closed = new Promise(resolve => child.once("close", code => resolve(code)));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    });
    let current;
    for (let i = 0; i < 500; i++) {
      assert.equal(child.exitCode, null, output);
      current = JSON.parse(await fs.readFile(f.paths.runtime, "utf8").catch(error => {
        if (error.code === "ENOENT") return "null";
        throw error;
      }));
      if (current?.pid === child.pid && output.includes("Ctrl+C")) break;
      await delay(20);
    }
    assert.equal(current?.pid, child.pid, output);
    assert.notEqual(current.controlId, previous.controlId);
    assert.match(output, /CableTidy stopped/);
    await assert.rejects(fs.access(previous.controlAddress), { code: "ENOENT" });
    if (xdg) {
      assert.ok(current.controlAddress.startsWith(path.join(await fs.realpath(xdg), "cabletidy") + path.sep));
    } else {
      assert.equal(current.controlAddress, controlAddress(f.home, current.controlId));
    }
    assert.equal(await fs.readFile(f.paths.config, "utf8"), beforeConfig);
    assert.equal(JSON.parse((await f.cli("status", roots[0])).stdout).runtime.status, "online");
    previous = current;
    if (!xdg) {
      await f.cli("stop", roots[0]);
      assert.equal(await closed, 0, output);
      await fs.rmdir(path.dirname(current.controlAddress));
    }
  }
  await f.app.close();
});
