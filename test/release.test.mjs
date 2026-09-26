import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = new URL("../", import.meta.url);
const releaseTargets = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};

async function releaseFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-release-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const metadata = JSON.parse(await fs.readFile(new URL("package.json", root), "utf8"));
  for (const file of ["Cargo.toml", "scripts/check-release.mjs", "scripts/build-native.mjs", "bin/cabletidy.mjs", "bin/native.mjs"]) {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await fs.copyFile(new URL(file, root), path.join(directory, file));
  }
  const files = [];
  for (const [platform, target] of Object.entries(releaseTargets)) {
    const native = path.join(directory, "native", platform);
    await fs.mkdir(native, { recursive: true });
    const binary = path.join(native, platform.startsWith("win32-") ? "cabletidy.exe" : "cabletidy");
    const bytes = Buffer.from(`preassembled ${target} binary`);
    const manifest = path.join(native, "build.json");
    await fs.writeFile(binary, bytes);
    await fs.writeFile(manifest, JSON.stringify({
      version: metadata.version, platform, target, sha256: createHash("sha256").update(bytes).digest("hex"),
    }));
    files.push(binary, manifest);
  }
  // Exercise npm's real lifecycle with prepared artifacts; compilation and CLI
  // execution are covered separately by the native and installation suites.
  await fs.writeFile(path.join(directory, "scripts/record-step.mjs"), `
    import fs from "node:fs";
    fs.appendFileSync("steps.log", process.argv[2] + "\\n");
    if (process.argv[2] === "build") throw new Error("Publishing must not rebuild staged binaries");
  `);
  metadata.scripts.test = "node scripts/record-step.mjs test";
  metadata.scripts.build = "node scripts/record-step.mjs build";
  metadata.scripts["test:package:built"] = "node scripts/record-step.mjs test:package:built";
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify(metadata));
  return { directory, files };
}

test("npm publish dry run tests assembled artifacts without rebuilding or replacing them", async t => {
  assert.ok(process.env.npm_execpath, "Run with npm test");
  const { directory, files } = await releaseFixture(t);
  const before = await Promise.all(files.map(file => fs.readFile(file)));
  await execute(process.execPath, [process.env.npm_execpath, "publish", "--dry-run", "--offline"], {
    cwd: directory,
    timeout: 30000,
    env: { ...process.env, npm_config_cache: path.join(directory, "cache"), npm_config_ignore_scripts: "false", npm_config_update_notifier: "false" },
  });
  assert.deepEqual((await fs.readFile(path.join(directory, "steps.log"), "utf8")).trim().split("\n"), ["test", "test:package:built"]);
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), before);
});

for (const target of ["x86_64-unknown-linux-gnu", null]) {
  test(`release validation rejects a Linux binary with target ${target}`, async t => {
    const { directory } = await releaseFixture(t);
    const file = path.join(directory, "native/linux-x64/build.json");
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...manifest, target }));
    await assert.rejects(execute(process.execPath, ["scripts/check-release.mjs"], { cwd: directory }), /Invalid release target.*musl/);
  });
}
