import fs from "node:fs/promises";
import { build, run } from "./build-native.mjs";

await build({ test: true });
await run("cargo", ["test", "--locked", "--all-targets", "--features", "test-support"]);
const files = (await fs.readdir(new URL("../test/", import.meta.url)))
  .filter(file => file.endsWith(".test.mjs")).sort().map(file => `test/${file}`);
const serialFiles = ["test/startup.test.mjs", "test/dev.test.mjs"];
// PowerShell compilation and audit fixtures compete for Windows runner CPU and
// disk, causing unrelated lock/read deadlines to expire. Run those suites serially.
const concurrency = process.platform === "win32" ? ["--test-concurrency=1"] : [];
if (process.platform === "win32") serialFiles.push("test/cable-transfer.test.mjs", "test/codex-catalog-process.test.mjs");
await run(process.execPath, ["--test", ...concurrency, ...files.filter(file => !serialFiles.includes(file))]);
// Default ports, Windows imports and process deadlines run independently.
for (const file of serialFiles) await run(process.execPath, ["--test", file]);
