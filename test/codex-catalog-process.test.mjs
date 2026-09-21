import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { catalogFixture } from "./helpers/codex-fixture.mjs";

const execute = promisify(execFile);
const catalogUrl = new URL("../src/codex-catalog.mjs", import.meta.url).href;
const script = `
  import { loadCodexCatalog } from ${JSON.stringify(catalogUrl)};
  try {
    await loadCodexCatalog();
    process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ cause: error.cause?.message, code: error.cause?.code }));
  }
`;

for (const [name, body, expected] of [
  ["missing executable", null, /ENOENT/],
  ["nonzero exit", "process.exit(7);", /exited with 7/],
  ["invalid catalog", 'console.log("invalid-json");', /JSON/],
  ["excessive output", 'process.stdout.write("x".repeat(17 * 1024 * 1024));', /16 MiB/],
]) {
  test(`catalog handles ${name} without leaving subprocess work alive`, {
    skip: process.platform === "win32",
  }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-catalog-process-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    if (body) {
      await fs.writeFile(path.join(directory, "codex"), `#!${process.execPath}\n${body}`, { mode: 0o700 });
    }
    const result = await execute(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PATH: directory },
      timeout: 5000,
    });
    assert.match(result.stdout, expected);
  });
}

for (const [name, exitCode, expected] of [
  ["timeout", null, /TimeoutError/],
  ["successful launcher exit before timeout", 0, /TimeoutError/],
  ["nonzero launcher exit", 7, /exited with 7/],
]) {
  test(`catalog ${name} terminates descendants holding pipes and allows retry`, {
    skip: process.platform === "win32",
    timeout: 25000,
  }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-catalog-pipes-"));
    const pidFile = path.join(directory, "launcher-pid");
    const retryFile = path.join(directory, "retry");
    const connections = new Set();
    const monitor = net.createServer(socket => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
    });
    t.after(async () => {
      try {
        const pid = Number(await fs.readFile(pidFile, "utf8"));
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
      }
      for (const socket of connections) socket.destroy();
      await new Promise(resolve => monitor.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    });
    await new Promise(resolve => monitor.listen(0, "127.0.0.1", resolve));
    const worker = `
      const socket = require("node:net").connect(${monitor.address().port}, "127.0.0.1", () => process.send("ready"));
      socket.on("error", () => process.exit(1));
    `;
    await fs.writeFile(path.join(directory, "codex"), `#!${process.execPath}
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(retryFile)})) {
        console.log(process.argv.includes("--version") ? "codex-cli test" : ${JSON.stringify(JSON.stringify(catalogFixture().catalog))});
      } else {
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], {
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
        child.once("message", () => { ${exitCode === null ? "" : `process.exit(${exitCode});`} });
      }
    `, { mode: 0o700 });
    const retryScript = `
      import fs from "node:fs/promises";
      import assert from "node:assert/strict";
      import { loadCodexCatalog } from ${JSON.stringify(catalogUrl)};
      const started = Date.now();
      const results = await Promise.allSettled([loadCodexCatalog(), loadCodexCatalog()]);
      assert.ok(results.every(result => result.status === "rejected"));
      const elapsed = Date.now() - started;
      assert.ok(elapsed < ${exitCode === 7 ? 4000 : 18000});
      const cause = results[0].reason.cause;
      await fs.writeFile(${JSON.stringify(retryFile)}, "ready");
      const snapshot = await loadCodexCatalog();
      assert.equal(snapshot.version, "codex-cli test");
      assert.ok(snapshot.catalog.models.length);
      console.log(JSON.stringify({ cause: cause.name + ": " + cause.message, elapsed, retry: "ok" }));
    `;
    const result = await execute(process.execPath, ["--input-type=module", "-e", retryScript], {
      env: { ...process.env, PATH: directory },
      timeout: exitCode === 7 ? 5000 : 20000,
    });
    assert.match(result.stdout, expected);
    assert.equal(JSON.parse(result.stdout).retry, "ok");
    const deadline = Date.now() + 2000;
    while (connections.size && Date.now() < deadline) await delay(20);
    assert.equal(connections.size, 0, "catalog descendants must exit before cleanup finishes");
  });
}
