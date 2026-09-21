import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
