import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createApplication } from "./helpers/native-app.mjs";
import { getPaths, nativeBinary } from "./helpers/native.mjs";
import { fixtureEnvironment } from "./helpers/commands.mjs";

const execute = promisify(execFile);
const daemon = fileURLToPath(new URL("../target/debug/cabletidy-test-daemon", import.meta.url));
const unix = { skip: process.platform === "win32", timeout: 30000 };

async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-temp-limits-")));
  let app;
  t.after(async () => { await app?.close(); await fs.rm(home, { recursive: true, force: true }); });
  return { home, async start() { return app = await createApplication({ paths: getPaths(home) }); } };
}

async function directoryWithSqliteBytes(home, name, bytes, unicode = false) {
  let directory = path.join(home, name);
  const rootBytes = bytes - Buffer.byteLength("/sqlite");
  while (rootBytes - Buffer.byteLength(directory) > 100) {
    directory = path.join(directory, "a".repeat(80));
  }
  const remaining = rootBytes - Buffer.byteLength(directory) - 1;
  const suffix = unicode ? "中".repeat(Math.floor(remaining / 3)) + "b".repeat(remaining % 3) : "b".repeat(remaining);
  directory = path.join(directory, suffix);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  assert.equal(Buffer.byteLength(path.join(await fs.realpath(directory), "sqlite")), bytes);
  // The generic filesystem accepts the directory and can create files in it.
  const probe = path.join(directory, "generic-file-probe");
  await fs.writeFile(probe, "writable");
  await fs.rm(probe);
  return directory;
}

test("SQLite rejects writable overlong directories at commit and startup without changing active settings", unix, async t => {
  const f = await fixture(t);
  const { home } = f;
  const paths = getPaths(home);
  const app = await f.start();
  const { config } = await (await fetch(`${app.url}api/v1/config`)).json();
  const active = (await (await fetch(`${app.url}api/v1/runtime`)).json()).temporaryStorage;
  for (const [name, bytes, unicode, alias] of [["boundary", 487, false], ["long", 606, false], ["unicode", 487, true], ["canonical-parent", 606, false, true]]) {
    let temporaryDirectory = await directoryWithSqliteBytes(home, name, bytes, unicode);
    if (alias) {
      const link = path.join(home, "parent-alias");
      await fs.symlink(path.dirname(temporaryDirectory), link);
      temporaryDirectory = path.join(link, path.basename(temporaryDirectory));
      assert.ok(Buffer.byteLength(temporaryDirectory) < 486, "the supplied spelling is short but resolves to an overlong directory");
    }
    const candidate = { ...config, temporaryDirectory };
    const response = await fetch(`${app.url}api/v1/config/commit`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: candidate, baseRevision: config.revision }),
    });
    const result = await response.json();
    assert.equal(response.status, 422, JSON.stringify(result));
    assert.equal(result.error.code, "temporary_directory_invalid");
    assert.ok(result.errors.some(error => error.path === "temporaryDirectory" && error.message.includes("486")));
    assert.deepEqual((await (await fetch(`${app.url}api/v1/config`)).json()).config, config);
    assert.deepEqual(JSON.parse(await fs.readFile(paths.config, "utf8")), config);
    assert.deepEqual((await (await fetch(`${app.url}api/v1/runtime`)).json()).temporaryStorage, active);

    const startupHome = path.join(home, `${name}-startup`);
    await fs.mkdir(startupHome);
    await fs.writeFile(path.join(startupHome, "config.json"), JSON.stringify(candidate));
    await assert.rejects(execute(nativeBinary, ["start"], {
      env: fixtureEnvironment({ CABLETIDY_HOME: startupHome }), timeout: 5000,
    }), error => error.code === 1 && /SQLite 临时目录路径过长/.test(error.stderr));
    await assert.rejects(fs.access(path.join(startupHome, "runtime.json")), { code: "ENOENT" });
  }
});

test("accepted SQLite directory boundaries support real disk-backed sorts with ASCII and UTF-8 paths", unix, async t => {
  const { home } = await fixture(t);
  for (const [name, bytes, unicode] of [["short", 160, false], ["boundary", 486, false], ["unicode", 486, true]]) {
    const temporaryDirectory = await directoryWithSqliteBytes(home, name, bytes, unicode);
    const startupHome = path.join(home, `${name}-startup`);
    await fs.mkdir(startupHome);
    await fs.writeFile(path.join(startupHome, "config.json"), JSON.stringify({ temporaryDirectory }));
    const unusable = path.join(startupHome, "unusable-inherited-temp");
    await fs.writeFile(unusable, "not a directory");
    const result = await execute(daemon, ["--sqlite-temp-probe"], {
      env: fixtureEnvironment({ CABLETIDY_HOME: startupHome, SQLITE_TMPDIR: unusable, TMPDIR: unusable }),
      timeout: 15000,
    });
    const probe = JSON.parse(result.stdout);
    assert.equal(probe.maxPathname, 512, "the length guard must match bundled SQLite's Unix VFS");
    assert.equal(probe.count, 50000);
    assert.ok(probe.temporaryFiles > 0, "the sort opened real temporary files instead of staying in memory");
    assert.equal(path.dirname(probe.generatedTemporaryFilename), await fs.realpath(path.join(temporaryDirectory, "sqlite")),
      "SQLite uses the configured directory even when inherited temporary paths are unusable");
    assert.deepEqual(await fs.readdir(path.join(temporaryDirectory, "sqlite")), [], "SQLite removes its sort files");
  }
});
