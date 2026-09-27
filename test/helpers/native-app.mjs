import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { writeCodexCommand } from "./commands.mjs";
import { normalizeConfig } from "./native.mjs";

const executable = fileURLToPath(new URL(`../../target/debug/cabletidy-test-daemon${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));

export async function createApplication(options = {}) {
  const paths = options.paths;
  const env = { ...process.env, ...options.env, CABLETIDY_HOME: paths.home,
    CODEX_HOME: options.codexHome || path.join(paths.home, "codex-client"),
    CLAUDE_CONFIG_DIR: options.claudeHome || path.join(paths.home, "claude-client"),
    CABLETIDY_PREFERRED_PORT: String(options.preferredPort || 43100),
  };
  let loader = options.loadCodexCatalog;
  let catalogServer;
  if (loader) {
    catalogServer = http.createServer(async (req, res) => {
      try {
        const value = await loader();
        res.end(req.url === "/version" ? value.version : JSON.stringify(value.catalog));
      } catch { res.writeHead(503); res.end("catalog unavailable"); }
    });
    await new Promise(resolve => catalogServer.listen(0, "127.0.0.1", resolve));
    const commands = path.join(paths.home, "test-commands");
    await fs.mkdir(commands, { recursive: true });
    await writeCodexCommand(commands, `fetch("http://127.0.0.1:${catalogServer.address().port}/" + (process.argv.includes("--version") ? "version" : "models")).then(async r => { if (!r.ok) process.exit(1); process.stdout.write(await r.text()); }).catch(() => process.exit(1));`);
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") || "PATH";
    env[pathKey] = `${commands}${path.delimiter}${env[pathKey] || ""}`;
  }
  const child = spawn(executable, [], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  closed.catch(() => {});
  let runtime;
  try {
    for (let i = 0; i < 500; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
      try {
        const info = JSON.parse(await fs.readFile(paths.runtime, "utf8"));
        if (info.pid === child.pid && output.includes("CableTidy Web")) { runtime = info; break; }
      } catch {}
      await delay(20);
    }
    if (!runtime) throw new Error(`Native daemon did not start: ${output}`);
  } catch (error) {
    child.kill();
    await closed.catch(() => {});
    catalogServer?.closeAllConnections();
    if (catalogServer) await new Promise(resolve => catalogServer.close(resolve));
    const code = output.match(/ELOCKUNKNOWN|ELOCKED|EADDRINUSE/)?.[0];
    if (code) error.code = code;
    throw error;
  }
  let closing;
  const state = {
    paths,
    get config() { return normalizeConfig(JSON.parse(readFileSync(paths.config, "utf8"))); },
    get loadCodexCatalog() { return loader; },
    set loadCodexCatalog(value) { loader = value; },
    webServer: { address: () => ({ port: runtime.web.port }), get listening() { return child.exitCode === null; } },
  };
  return {
    url: runtime.web.url, state, child,
    close() {
      return closing ||= (async () => {
        child.stdin.end("stop\n");
        await closed;
        catalogServer?.closeAllConnections();
        if (catalogServer) await new Promise(resolve => catalogServer.close(resolve));
      })();
    },
  };
}
