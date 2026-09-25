import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "../bin/native.mjs";
import { build } from "./build-native.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const watch = args.includes("--watch");
const command = args.filter(arg => arg !== "--watch")[0] || "start";
const home = path.resolve(process.env.CABLETIDY_DEV_HOME || path.join(root, ".cabletidy-debug"));
const env = { ...process.env, CABLETIDY_HOME: home, CODEX_HOME: path.join(home, "codex"),
  CLAUDE_CONFIG_DIR: path.join(home, "claude"), CABLETIDY_PREFERRED_PORT: "43101" };

try {
  if (args.filter(arg => arg !== "--watch").length > 1 || !["start", "status"].includes(command) || (watch && command !== "start")) {
    throw new Error("Usage: node scripts/dev.mjs [start|status] [--watch]");
  }
  if (command === "start") {
    console.log(`CableTidy development instance\nCodex: ${env.CODEX_HOME}\nClaude: ${env.CLAUDE_CONFIG_DIR}`);
  }
  if (!watch) {
    process.exitCode = await launch([command], { env }).closed;
  } else {
    let current = launch(["start"], { env, signals: false });
    let stopping = false;
    let restarting = Promise.resolve();
    let timer;
    let needsBuild = false;
    const watchers = [];
    const changed = rebuild => {
      needsBuild ||= rebuild;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const compile = needsBuild;
        needsBuild = false;
        restarting = restarting.then(async () => {
          if (stopping) return;
          current.stop("SIGTERM");
          await current.closed;
          if (compile) await build();
          if (!stopping) current = launch(["start"], { env, signals: false });
        }).catch(error => console.error(error.message));
      }, 200);
    };
    for (const name of ["src", "web", "Cargo.toml", "Cargo.lock", "scripts/dev.mjs"]) {
      const file = path.join(root, name);
      if (fs.existsSync(file)) watchers.push(fs.watch(file, { recursive: fs.statSync(file).isDirectory() }, () => changed(name !== "scripts/dev.mjs")));
    }
    await new Promise(resolve => {
      const stop = async signal => {
        stopping = true;
        clearTimeout(timer);
        watchers.forEach(watcher => watcher.close());
        current.stop(signal);
        await restarting;
        process.exitCode = await current.closed;
        resolve();
      };
      process.on("SIGINT", () => { void stop("SIGINT"); });
      process.on("SIGTERM", () => { void stop("SIGTERM"); });
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
