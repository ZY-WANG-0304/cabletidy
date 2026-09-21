import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultConfig } from "../src/config.mjs";

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

test("status and the default command do not initialize an unused store or invent a URL", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-cli-status-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "data");
  for (const args of [["status"], []]) {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      cwd: directory,
      env: { ...process.env, CABLETIDY_HOME: home },
    });
    const output = JSON.parse(result.stdout);
    assert.equal(output.runtime.status, "offline");
    assert.match(output.runtime.liveness, /cabletidy start/);
    assert.equal(output.runtime.web, undefined);
    assert.equal(output.configRevision, undefined);
    assert.equal(output.configurations, undefined);
    await assert.rejects(fs.access(home), { code: "ENOENT" });
  }
  await fs.mkdir(home);
  await execFileAsync(process.execPath, [cli, "status"], {
    env: { ...process.env, CABLETIDY_HOME: home },
  });
  assert.deepEqual(await fs.readdir(home), []);
});

test("status reads existing configuration without creating secrets, backups or runtime files", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-cli-configured-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "data");
  await fs.mkdir(home);
  const config = defaultConfig();
  config.web.port = 43210;
  config.bindings = {
    relay: { id: "relay", name: "My Relay", target: "codex", virtualProvider: "cabletidy_relay" },
  };
  config.virtualProviders = {
    cabletidy_relay: { id: "cabletidy_relay", enabled: true },
  };
  const contents = JSON.stringify(config);
  await fs.writeFile(path.join(home, "config.json"), contents);
  const configured = JSON.parse((await execFileAsync(process.execPath, [cli, "status"], {
    cwd: directory,
    env: { ...process.env, CABLETIDY_HOME: home },
  })).stdout);
  assert.equal(configured.runtime.status, "offline");
  assert.equal(configured.runtime.web.url, "http://127.0.0.1:43210/");
  assert.deepEqual(configured.configurations, [{
    id: "my-relay",
    name: "My Relay",
    target: "codex",
    url: "http://127.0.0.1:43210/my-relay/v1",
    enabled: true,
  }]);
  assert.deepEqual(await fs.readdir(home), ["config.json"]);
  assert.equal(await fs.readFile(path.join(home, "config.json"), "utf8"), contents);
});

test("status reports malformed configuration without overwriting it", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-cli-invalid-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.writeFile(path.join(home, "config.json"), "{");
  await assert.rejects(execFileAsync(process.execPath, [cli, "status"], {
    env: { ...process.env, CABLETIDY_HOME: home },
  }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /SyntaxError/);
    return true;
  });
  assert.deepEqual(await fs.readdir(home), ["config.json"]);
  assert.equal(await fs.readFile(path.join(home, "config.json"), "utf8"), "{");
});
