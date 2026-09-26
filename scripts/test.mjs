import fs from "node:fs/promises";
import { build, run } from "./build-native.mjs";

await build({ test: true });
await run("cargo", ["test", "--locked", "--all-targets", "--features", "test-support"]);
const files = (await fs.readdir(new URL("../test/", import.meta.url)))
  .filter(file => file.endsWith(".test.mjs")).sort().map(file => `test/${file}`);
await run(process.execPath, ["--test", ...files]);
