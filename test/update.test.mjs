import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { compareVersions, globalPrefix, parseArgs, shellArg } from "../bin/update.mjs";
import { alive, holdControlConnection } from "./helpers/control.mjs";
import { nativeBinary } from "./helpers/native.mjs";

const execFileAsync = promisify(execFile);
const cli = path.join(process.cwd(), "bin", "cabletidy.mjs");

test("update arguments accept versions, tags and registries but reject npm install specs", () => {
  assert.deepEqual(parseArgs([]), { spec: "latest", explicit: false, check: false, yes: false, registry: "https://registry.npmjs.org/" });
  assert.deepEqual(parseArgs(["0.5.0-rc.1", "--check", "--registry", "http://mirror.test/"]),
    { spec: "0.5.0-rc.1", explicit: true, check: true, yes: false, registry: "http://mirror.test/" });
  assert.equal(parseArgs(["-y"]).yes, true);
  assert.equal(parseArgs(["--yes", "next"]).yes, true);
  assert.equal(parseArgs(["--registry=https://mirror.test/npm/", "next"]).registry, "https://mirror.test/npm/");
  for (const args of [["file:../x"], ["git+https://x"], ["../x"], ["1.0.0", "2.0.0"], ["--force"], ["--registry"], ["--registry=file:///tmp"]]) {
    assert.throws(() => parseArgs(args), args.join(" "));
  }
});

test("update orders releases after their prereleases", () => {
  const ordered = ["0.3.9", "0.4.0-rc.2", "0.4.0-rc.10", "0.4.0-rc.beta", "0.4.0", "0.4.1", "0.10.0", "1.0.0"];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.equal(compareVersions(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  assert.equal(compareVersions("0.4.0+build.1", "0.4.0"), 0);
});

test("update only targets the global npm prefix that owns the package", async (t) => {
  const prefix = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-update-prefix-"));
  t.after(() => fs.rm(prefix, { recursive: true, force: true }));
  const windows = process.platform === "win32";
  const modules = windows ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
  const packageDir = path.join(modules, "cabletidy");
  await fs.mkdir(packageDir, { recursive: true });
  // Without a command shim this looks like a project dependency or npx cache, not a global install.
  assert.equal(globalPrefix(packageDir), null);
  const shim = windows ? path.join(prefix, "cabletidy.cmd") : path.join(prefix, "bin", "cabletidy");
  await fs.mkdir(path.dirname(shim), { recursive: true });
  await fs.writeFile(shim, "");
  assert.equal(globalPrefix(packageDir), prefix);
  assert.equal(globalPrefix(path.join(prefix, "cabletidy")), null);
});

test("update refuses to replace a source checkout", async () => {
  for (const args of [["update"], ["update", "--check"]]) {
    await assert.rejects(execFileAsync(process.execPath, [cli, ...args]), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /source checkout/);
      return true;
    });
  }
  await assert.rejects(execFileAsync(process.execPath, [cli, "update", "file:x"]), /Usage: cabletidy update/);
});

test("update hints quote arguments for the user's shell", () => {
  assert.equal(shellArg("--registry=https://mirror.test/npm/"), "--registry=https://mirror.test/npm/");
  assert.equal(shellArg("--registry=https://mirror.test/?a=1&b=2", "linux"), "'--registry=https://mirror.test/?a=1&b=2'");
  assert.equal(shellArg("--registry=https://mirror.test/it's", "darwin"), "'--registry=https://mirror.test/it'\\''s'");
  assert.equal(shellArg("--registry=https://mirror.test/?a=1&b=2", "win32"), '"--registry=https://mirror.test/?a=1&b=2"');
});

test("instance probe ignores config.json and waits until a lingering daemon exits", { timeout: 60000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-update-instance-"));
  const env = { ...process.env, CABLETIDY_HOME: home, CABLETIDY_PREFERRED_PORT: "0" };
  delete env.CABLETIDY_MANAGED_STDIN;
  const probe = async (...args) => (await execFileAsync(nativeBinary, ["__instance", ...args], { env })).stdout;
  assert.deepEqual(JSON.parse(await probe()), { running: false, process: null });
  await assert.rejects(fs.access(path.join(home, "daemon.lock")), { code: "ENOENT" });

  const daemon = spawn(nativeBinary, ["start"], { env, stdio: "ignore" });
  const closed = new Promise(resolve => daemon.once("close", resolve));
  t.after(async () => {
    if (daemon.exitCode === null) { daemon.kill(); await closed; }
    await fs.rm(home, { recursive: true, force: true });
  });
  let runtime;
  for (let i = 0; i < 500 && runtime?.pid !== daemon.pid; i++) {
    runtime = JSON.parse(await fs.readFile(path.join(home, "runtime.json"), "utf8").catch(() => "null"));
    await delay(20);
  }
  assert.equal(runtime?.pid, daemon.pid);
  // status rejects a corrupt configuration; the updater probe must not.
  const config = await fs.readFile(path.join(home, "config.json"), "utf8");
  await fs.writeFile(path.join(home, "config.json"), "{");
  await assert.rejects(execFileAsync(nativeBinary, ["status"], { env }), /Invalid JSON/);
  const state = JSON.parse(await probe());
  assert.deepEqual(state, { running: true, process: { pid: daemon.pid, startTime: runtime.pidStartTime, hostname: runtime.hostname } });
  await fs.writeFile(path.join(home, "config.json"), config);

  const connection = await holdControlConnection(home, runtime);
  t.after(connection.close);
  assert.equal(connection.reply.state, "running");
  await execFileAsync(nativeBinary, ["stop"], { env });
  // A held control connection keeps the daemon alive for a while after stop reports success.
  const lingering = alive(daemon.pid);
  t.diagnostic(`daemon alive after stop: ${lingering}`);
  assert.ok(lingering);
  await probe("--wait-exit", JSON.stringify(state.process));
  assert.equal(alive(daemon.pid), false);
  await closed;
  assert.deepEqual(JSON.parse(await probe()), { running: false, process: null });
});
