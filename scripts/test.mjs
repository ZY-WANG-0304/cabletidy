import fs from "node:fs/promises";
import { build, run } from "./build-native.mjs";

await build({ test: true });
await run("cargo", ["test", "--locked", "--all-targets", "--features", "test-support"]);
const files = (await fs.readdir(new URL("../test/", import.meta.url)))
  .filter(file => file.endsWith(".test.mjs")).sort().map(file => `test/${file}`);
const serialFiles = ["test/startup.test.mjs", "test/dev.test.mjs"];
// Windows catalog queries start PowerShell; isolate import coverage from concurrent fixture processes.
if (process.platform === "win32") serialFiles.push("test/cable-transfer.test.mjs");
await run(process.execPath, ["--test", ...files.filter(file => !serialFiles.includes(file))]);
// Default production/development ports and Windows import catalog queries run independently.
for (const file of serialFiles) await run(process.execPath, ["--test", file]);
