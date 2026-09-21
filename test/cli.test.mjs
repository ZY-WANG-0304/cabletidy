import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = path.join(process.cwd(), "src", "cli.mjs");

test("help, version and invalid commands do not initialize user data", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-cli-help-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "unused");
  const options = { cwd: directory, env: { ...process.env, CABLETIDY_HOME: home } };
  const metadata = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const flag of ["--help", "-h", "help"]) {
    const result = await execFileAsync(process.execPath, [cli, flag], options);
    assert.match(result.stdout, /Usage: cabletidy/);
    assert.match(result.stdout, /start/);
  }
  for (const flag of ["--version", "-v"]) {
    const result = await execFileAsync(process.execPath, [cli, flag], options);
    assert.equal(result.stdout.trim(), metadata.version);
  }
  for (const args of [["unknown"], ["web", "unknown"], ["start", "--unknown"]]) {
    await assert.rejects(execFileAsync(process.execPath, [cli, ...args], options), error => {
      assert.equal(error.code, 1);
      assert.ok(error.stderr);
      return true;
    });
  }
  await assert.rejects(fs.access(home), { code: "ENOENT" });
});

test("status reports the management URL and offline state", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-cli-status-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const result = await execFileAsync(process.execPath, [cli, "status"], {
    cwd: directory,
    env: { ...process.env, CABLETIDY_HOME: path.join(directory, "data") },
  });
  const output = JSON.parse(result.stdout);
  assert.equal(output.runtime.status, "offline");
  assert.match(output.runtime.web.url, /^http:\/\/127\.0\.0\.1:/);
  assert.deepEqual(output.configurations, []);

  const home = path.join(directory, "data");
  const config = JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8"));
  config.bindings = {
    relay: { id: "relay", name: "My Relay", target: "codex", virtualProvider: "cabletidy_relay" },
  };
  config.virtualProviders = {
    cabletidy_relay: { id: "cabletidy_relay", enabled: true },
  };
  await fs.writeFile(path.join(home, "config.json"), JSON.stringify(config));
  const configured = JSON.parse((await execFileAsync(process.execPath, [cli, "status"], {
    cwd: directory,
    env: { ...process.env, CABLETIDY_HOME: home },
  })).stdout);
  assert.deepEqual(configured.configurations, [{
    id: "my-relay",
    name: "My Relay",
    target: "codex",
    url: "http://127.0.0.1:43100/my-relay/v1",
    enabled: true,
  }]);
});
