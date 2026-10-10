import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compareVersions, globalPrefix, parseArgs } from "../bin/update.mjs";

const execFileAsync = promisify(execFile);
const cli = path.join(process.cwd(), "bin", "cabletidy.mjs");

test("update arguments accept versions, tags and registries but reject npm install specs", () => {
  assert.deepEqual(parseArgs([]), { spec: "latest", explicit: false, check: false, registry: "https://registry.npmjs.org/" });
  assert.deepEqual(parseArgs(["0.5.0-rc.1", "--check", "--registry", "http://mirror.test/"]),
    { spec: "0.5.0-rc.1", explicit: true, check: true, registry: "http://mirror.test/" });
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
