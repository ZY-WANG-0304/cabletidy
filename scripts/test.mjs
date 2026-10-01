import fs from "node:fs/promises";
import { build, run } from "./build-native.mjs";

await build({ test: true });
await run("cargo", ["test", "--locked", "--all-targets", "--features", "test-support"]);
const files = (await fs.readdir(new URL("../test/", import.meta.url)))
  .filter(file => file.endsWith(".test.mjs")).sort().map(file => `test/${file}`);
const fixedPorts = ["test/startup.test.mjs", "test/dev.test.mjs"];
await run(process.execPath, ["--test", ...files.filter(file => !fixedPorts.includes(file))]);
// Default production/development port tests do not run alongside ordinary fixtures.
for (const file of fixedPorts) await run(process.execPath, ["--test", file]);
