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
  // Fixtures use local upstreams; only proxy tests should inherit proxy settings.
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(https?|all|no)_proxy$/i.test(key)));
  const env = { ...inherited, ...options.env, CABLETIDY_HOME: paths.home,
    CODEX_HOME: options.codexHome || path.join(paths.home, "codex-client"),
    CLAUDE_CONFIG_DIR: options.claudeHome || path.join(paths.home, "claude-client"),
    CABLETIDY_PREFERRED_PORT: String(options.preferredPort ?? 0),
  };
  // Remove unset overrides before Node deduplicates Windows environment keys.
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  let loader = options.loadCodexCatalog;
  let catalogServer;
  const catalogErrors = [];
  const commandErrors = path.join(paths.home, "catalog-command-errors.log");
  if (loader) {
    catalogServer = http.createServer(async (req, res) => {
      try {
        const value = await loader();
        res.end(req.url === "/version" ? value.version : JSON.stringify(value.catalog));
      } catch (error) { catalogErrors.push(String(error.stack || error)); res.writeHead(503); res.end("catalog unavailable"); }
    });
    await new Promise(resolve => catalogServer.listen(0, "127.0.0.1", resolve));
    const commands = path.join(paths.home, "test-commands");
    await fs.mkdir(commands, { recursive: true });
    await writeCodexCommand(commands, `
      fetch("http://127.0.0.1:${catalogServer.address().port}/" + (process.argv.includes("--version") ? "version" : "models"))
        .then(async r => {
          if (!r.ok) throw new Error("Catalog fixture HTTP " + r.status + ": " + await r.text());
          process.stdout.write(await r.text());
        }).catch(error => {
          const detail = String(error.stack || error) + (error.cause ? "\\nCause: " + String(error.cause.stack || error.cause) : "");
          console.error(detail);
          require("node:fs").appendFileSync(${JSON.stringify(commandErrors)}, detail + "\\n");
          process.exitCode = 1;
        });
    `);
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
    async diagnostics() {
      const command = await fs.readFile(commandErrors, "utf8").catch(error => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return { daemon: output, catalogErrors, commandErrors: command };
    },
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
