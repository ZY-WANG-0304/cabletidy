import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
const watchSessionPrefix = ".dev-watch-session-";
const watchStopPrefix = ".dev-watch-stop-";

function requestWatchStop() {
  let files;
  try { files = fs.readdirSync(home); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const file of files) {
    if (!file.startsWith(watchSessionPrefix)) continue;
    const session = file.slice(watchSessionPrefix.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(session)) continue;
    try {
      if (fs.readFileSync(path.join(home, file), "utf8") === session) {
        fs.writeFileSync(path.join(home, `${watchStopPrefix}${session}`), session, { mode: 0o600 });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function removeWatchFile(file, session) {
  try {
    if (fs.readFileSync(file, "utf8") === session) fs.rmSync(file, { force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

try {
  if (args.filter(arg => arg !== "--watch").length > 1 || !["start", "status", "stop"].includes(command) || (watch && command !== "start")) {
    throw new Error("Usage: node scripts/dev.mjs [start|status|stop] [--watch]");
  }
  if (command === "start") {
    console.log(`CableTidy development instance\nCodex: ${env.CODEX_HOME}\nClaude: ${env.CLAUDE_CONFIG_DIR}`);
  }
  if (!watch) {
    try {
      process.exitCode = await launch([command], { env }).closed;
    } finally {
      if (command === "stop") requestWatchStop();
    }
  } else {
    const watchSession = randomUUID();
    const watchSessionPath = path.join(home, `${watchSessionPrefix}${watchSession}`);
    const watchStopPath = path.join(home, `${watchStopPrefix}${watchSession}`);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(watchSessionPath, watchSession, { mode: 0o600, flag: "wx" });
    let current;
    let replacing;
    let stopping = false;
    let restarting = Promise.resolve();
    let timer;
    let needsBuild = false;
    const watchers = [];
    let finish;
    const finished = new Promise((resolve, reject) => {
      finish = (code, error) => {
        stopping = true;
        closeWatchers();
        if (error) reject(error);
        else {
          process.exitCode = code;
          resolve();
        }
      };
    });
    const closeWatchers = () => {
      clearTimeout(timer);
      watchers.forEach(watcher => watcher.close());
    };
    const stopRequested = () => {
      try { return fs.readFileSync(watchStopPath, "utf8") === watchSession; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    };
    const start = () => {
      const instance = launch(["start"], { env, signals: false });
      current = instance;
      // Planned restarts wait for the old process themselves; other exits end watch mode.
      instance.closed.then(code => {
        if (!stopping && instance !== replacing) finish(code);
      }, error => {
        if (!stopping && instance !== replacing) finish(1, error);
      });
    };
    const changed = rebuild => {
      needsBuild ||= rebuild;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const compile = needsBuild;
        needsBuild = false;
        restarting = restarting.then(async () => {
          if (stopping) return;
          replacing = current;
          current.stop("SIGTERM");
          await current.closed;
          if (compile) await build();
          if (stopRequested()) {
            stopping = true;
            closeWatchers();
            finish(await current.closed);
            return;
          }
          if (!stopping) start();
        }).catch(error => console.error(error.message));
      }, 200);
    };
    const stop = async signal => {
      if (stopping) return;
      stopping = true;
      current?.stop(signal);
      closeWatchers();
      try {
        await restarting;
        finish(await current.closed);
      } catch (error) {
        finish(1, error);
      }
    };
    const interrupt = () => { void stop("SIGINT"); };
    const terminate = () => { void stop("SIGTERM"); };
    try {
      const watchNames = ["src", "web", "Cargo.toml", "Cargo.lock", "scripts/dev.mjs"];
      try {
        for (const name of watchNames) {
          const file = path.join(root, name);
          if (fs.existsSync(file)) watchers.push(fs.watch(file, { recursive: fs.statSync(file).isDirectory() }, () => changed(name !== "scripts/dev.mjs")));
        }
      } catch (error) {
        if (!["ENOSPC", "EMFILE"].includes(error.code)) throw error;
        closeWatchers();
        watchers.length = 0;
        console.warn("File watcher limit reached; polling development files every second.");
        const snapshot = name => {
          const entries = [];
          const visit = file => {
            let stat;
            try { stat = fs.statSync(file); }
            catch (error) { if (error.code === "ENOENT") return; throw error; }
            if (stat.isDirectory()) {
              for (const child of fs.readdirSync(file).sort()) visit(path.join(file, child));
            } else entries.push([file, stat.mtimeMs, stat.ctimeMs, stat.size]);
          };
          visit(path.join(root, name));
          return JSON.stringify(entries);
        };
        const snapshots = new Map(watchNames.map(name => [name, snapshot(name)]));
        const interval = setInterval(() => {
          try {
            for (const name of watchNames) {
              const next = snapshot(name);
              if (next !== snapshots.get(name)) {
                snapshots.set(name, next);
                changed(name !== "scripts/dev.mjs");
              }
            }
          } catch (error) { console.error(error.message); }
        }, 1000);
        watchers.push({ close: () => clearInterval(interval) });
      }
      const stopPoll = setInterval(() => {
        try {
          if (stopRequested()) void stop("SIGTERM");
        } catch (error) {
          if (error.code !== "ENOENT") console.error(error.message);
        }
      }, 50);
      watchers.push({ close: () => clearInterval(stopPoll) });
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      start();
      await finished;
    } finally {
      closeWatchers();
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      removeWatchFile(watchSessionPath, watchSession);
      removeWatchFile(watchStopPath, watchSession);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
