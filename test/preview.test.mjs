import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseArgs, previewVersion, setVersion } from "../scripts/preview.mjs";
import { nativeBinary } from "./helpers/native.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("preview identifies the commit and synchronizes isolated npm and Rust metadata", async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-preview-metadata-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const files = ["package.json", "package-lock.json", "Cargo.toml", "Cargo.lock"];
  const before = await Promise.all(files.map(file => fs.readFile(path.join(root, file))));
  await Promise.all(files.map((file, i) => fs.writeFile(path.join(temporary, file), before[i])));
  const commit = "abc123456789".padEnd(40, "0");
  const version = previewVersion("0.5.0-rc.2", commit, new Date("2026-10-18T09:30:00Z"));
  assert.equal(version, "0.5.0-preview.20261018093000.gabc123456789");
  await setVersion(temporary, version);
  // Compare against the original manifests so unrelated dependencies cannot silently change.
  const npm = JSON.parse(before[0]);
  const lock = JSON.parse(before[1]);
  npm.version = lock.version = lock.packages[""].version = version;
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temporary, files[0]))), npm);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temporary, files[1]))), lock);
  for (const i of [2, 3]) {
    const originalVersion = JSON.parse(before[0]).version;
    assert.equal(await fs.readFile(path.join(temporary, files[i]), "utf8"),
      before[i].toString().replace(`version = "${originalVersion}"`, `version = "${version}"`));
  }
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(path.join(root, file)))), before);
});

test("preview defaults to fetched main and accepts explicit commits and install options", () => {
  assert.deepEqual(parseArgs([]), { ref: null, packOnly: false, yes: false, prefix: null });
  assert.deepEqual(parseArgs(["--ref", "HEAD", "--pack-only", "--yes", "--prefix", "prefix with spaces"]),
    { ref: "HEAD", packOnly: true, yes: true, prefix: "prefix with spaces" });
  for (const args of [["--ref"], ["--ref", "--yes"], ["--prefix"], ["--publish"], ["main"]]) {
    assert.throws(() => parseArgs(args), /Usage:/);
  }
});

test("preview shares update confirmations and switches the daemon only after consent", { timeout: 90000 }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-preview-install-"));
  const packageRoot = path.join(temporary, "package");
  const launcher = path.join(packageRoot, "bin", "cabletidy.mjs");
  const binary = path.join(packageRoot, "native", `${process.platform}-${process.arch}`, process.platform === "win32" ? "cabletidy.exe" : "cabletidy");
  const home = path.join(temporary, "data");
  const env = { ...process.env, CABLETIDY_HOME: home, CABLETIDY_PREFERRED_PORT: "0" };
  delete env.CABLETIDY_MANAGED_STDIN;
  await fs.cp(path.join(root, "bin"), path.join(packageRoot, "bin"), { recursive: true });
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.copyFile(nativeBinary, binary);
  await fs.chmod(binary, 0o755);
  const cli = args => execute(process.execPath, [launcher, ...args], { env });
  t.after(async () => {
    try { await cli(["stop"]); }
    finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
  const script = path.join(temporary, "install.mjs");
  const marker = path.join(temporary, "installed");
  await fs.writeFile(script, `
    import fs from 'node:fs/promises';
    import { installPackage } from ${JSON.stringify(new URL("../bin/update.mjs", import.meta.url).href)};
    process.exitCode = await installPackage({
      current: 'old', target: 'preview', prefix: ${JSON.stringify(temporary)},
      launcher: ${JSON.stringify(launcher)}, binary: ${JSON.stringify(binary)},
      yes: process.argv.includes('--yes'),
      install: async () => { await fs.writeFile(${JSON.stringify(marker)}, 'installed'); return 0; },
    });
  `);
  await cli(["start"]);
  const before = JSON.parse(await fs.readFile(path.join(home, "runtime.json"), "utf8"));
  if (process.platform === "win32") {
    // Noninteractive Windows must not replace a locked executable without consent.
    await assert.rejects(execute(process.execPath, [script], { env }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /Update cancelled/);
      return true;
    });
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
  } else {
    const declined = await execute(process.execPath, [script], { env });
    assert.match(declined.stdout, /Restart now\?/);
    assert.match(declined.stdout, /assuming no/);
    await fs.access(marker);
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(home, "runtime.json"), "utf8")).controlId, before.controlId);
  const accepted = await execute(process.execPath, [script, "--yes"], { env });
  assert.match(accepted.stdout, /CableTidy stopped/);
  assert.match(accepted.stdout, /CableTidy started:/);
  await fs.access(marker);
  const after = JSON.parse(await fs.readFile(path.join(home, "runtime.json"), "utf8"));
  assert.notEqual(after.controlId, before.controlId);
  assert.equal(after.web.url, before.web.url);
});
