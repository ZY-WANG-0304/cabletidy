import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { targets } from "./build-native.mjs";

const root = new URL("../", import.meta.url);
const version = JSON.parse(await fs.readFile(new URL("package.json", root), "utf8")).version;
const cargo = await fs.readFile(new URL("Cargo.toml", root), "utf8");
if (!cargo.includes(`version = "${version}"`)) throw new Error("Cargo and npm versions must match");
const platforms = [...new Set(Object.values(targets))];
for (const platform of platforms) {
  const directory = new URL(`native/${platform}/`, root);
  const build = JSON.parse(await fs.readFile(new URL("build.json", directory), "utf8"));
  const name = platform.startsWith("win32-") ? "cabletidy.exe" : "cabletidy";
  const digest = createHash("sha256").update(await fs.readFile(new URL(name, directory))).digest("hex");
  if (build.version !== version || build.platform !== platform || build.sha256 !== digest) {
    throw new Error(`Invalid release binary: ${path.basename(directory.pathname)} (${platform})`);
  }
}
console.log(`Validated CableTidy ${version} binaries for ${platforms.join(", ")}`);
