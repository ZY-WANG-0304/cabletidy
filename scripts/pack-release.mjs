import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import "./check-release.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(root, "dist-release");
const { stdout: commit } = await execute("git", ["rev-parse", "HEAD"], { cwd: root });
await fs.mkdir(destination, { recursive: true });
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run with npm run pack:release");
const { stdout } = await execute(process.execPath, [npm, "pack", "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: root });
const [packed] = JSON.parse(stdout);
const bytes = await fs.readFile(path.join(destination, packed.filename));
const sha256 = createHash("sha256").update(bytes).digest("hex");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
if (integrity !== packed.integrity) throw new Error("npm tarball integrity mismatch");
await fs.rename(path.join(destination, packed.filename), path.join(destination, "package.tgz"));
await fs.writeFile(path.join(destination, "SHA256SUMS"), `${sha256}  package.tgz\n`);
await fs.writeFile(path.join(destination, "release.json"), `${JSON.stringify({
  name: packed.name,
  version: packed.version,
  commit: commit.trim(),
  ref: process.env.GITHUB_REF || null,
  runId: process.env.GITHUB_RUN_ID || null,
  file: "package.tgz",
  sha256,
  integrity,
}, null, 2)}\n`);
console.log(`Prepared ${packed.name}@${packed.version} in ${destination}`);
