import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mockCodexEnvironment, namedCodexConfigFixture } from "./helpers/codex-fixture.mjs";

const execFileAsync = promisify(execFile);
const cli = path.join(process.cwd(), "src", "cli.mjs");

test("codex artifacts rejects conflicting names instead of emitting another binding", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-cli-name-conflict-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = await mockCodexEnvironment(home);
  await writeStore(home, namedCodexConfigFixture({ a: "b", b: "a", c: "a" }), {});
  const stored = await fs.readFile(path.join(home, "config.json"), "utf8");
  for (const args of [["b"], []]) {
    await assert.rejects(execFileAsync(process.execPath, [cli, "codex", "artifacts", ...args], { env }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /配置名称规范化后重复: a/);
      assert.equal(error.stdout, "");
      return true;
    });
  }
  assert.equal(await fs.readFile(path.join(home, "config.json"), "utf8"), stored);
  await assert.rejects(fs.access(env.CODEX_HOME), { code: "ENOENT" });
});

test("run injects Claude Code environment without changing the parent environment", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-cli-claude-"));
  await writeStore(home, claudeConfig(), {
    "secret://virtual-providers/claude": "local-claude-key",
  });
  const runtimeServer = await startRuntimeProbe();

  try {
    await writeRuntime(home, runtimeServer.port);
    const result = await execFileAsync(
      process.execPath,
      [
        cli,
        "run",
        "--target",
        "claude-code",
        "--binding",
        "claude",
        "--",
        process.execPath,
        "-e",
        "console.log(process.env.ANTHROPIC_BASE_URL); console.log(process.env.ANTHROPIC_AUTH_TOKEN); console.log(process.env.ANTHROPIC_MODEL)",
      ],
      { env: { ...process.env, CABLETIDY_HOME: home } },
    );
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "http://127.0.0.1:43100/claude",
      "cabletidy-local",
      "sonnet",
    ]);
  } finally {
    await runtimeServer.close();
  }
});

test("run gives Codex an ephemeral CODEX_HOME", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-cli-codex-"));
  const env = await mockCodexEnvironment(home);
  await writeStore(home, codexConfig(), {
    "secret://virtual-providers/codex": "local-codex-key",
  });
  const runtimeServer = await startRuntimeProbe();

  try {
    await writeRuntime(home, runtimeServer.port);
    const result = await execFileAsync(
      process.execPath,
      [
        cli,
        "run",
        "--target",
        "codex",
        "--binding",
        "codex",
        "--",
        process.execPath,
        "--input-type=module",
        "-e",
        "import fs from 'node:fs'; import path from 'node:path'; const config = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8'); console.log(Boolean(process.env.CODEX_HOME)); console.log(/requires_openai_auth = false/.test(config)); console.log(/env_key/.test(config)); console.log(process.env.CABLETIDY_CODEX_RELAY_KEY)",
      ],
      { env: { ...env, CABLETIDY_CODEX_RELAY_KEY: undefined } },
    );
    assert.deepEqual(result.stdout.trim().split("\n"), ["true", "true", "false", "undefined"]);
    const envResult = await execFileAsync(process.execPath, [cli, "target", "env", "codex", "--json"], {
      env,
    });
    const environment = JSON.parse(envResult.stdout);
    assert.deepEqual(environment.vars, {});
    assert.equal(environment.shell, "");
    await assert.rejects(fs.access(path.join(home, ".codex")));
  } finally {
    await runtimeServer.close();
  }
});

test("run rejects a stale runtime file when the Web daemon is unreachable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-cli-stale-"));
  await writeStore(home, claudeConfig(), {
    "secret://virtual-providers/claude": "local-claude-key",
  });
  const runtimeServer = await startRuntimeProbe();
  await runtimeServer.close();
  await writeRuntime(home, runtimeServer.port);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        cli,
        "run",
        "--target",
        "claude-code",
        "--binding",
        "claude",
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { env: { ...process.env, CABLETIDY_HOME: home } },
    ),
    (error) => /Web 管理台不可达|无响应/.test(error.stderr || ""),
  );
});

test("run writes a generated catalog inside its temporary Codex home and removes it afterwards", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-cli-catalog-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = await mockCodexEnvironment(home);
  const config = codexConfig();
  config.models.model.codex = { metadataMode: "override", inputModalities: ["text"] };
  config.models.model.contextWindow = 128000;
  await writeStore(home, config, {});
  const server = await startRuntimeProbe();
  t.after(() => server.close());
  await writeRuntime(home, server.port);
  const script = `import fs from 'node:fs'; import path from 'node:path';
    const home=process.env.CODEX_HOME;
    const text=fs.readFileSync(path.join(home,'config.toml'),'utf8');
    const file=JSON.parse(text.match(/^model_catalog_json\\s*=\\s*(.+)$/m)[1]);
    const model=JSON.parse(fs.readFileSync(file,'utf8')).models.find(m=>m.slug==='gpt-5.5');
    console.log(JSON.stringify({home,file,window:model.context_window,instructions:model.base_instructions}));`;
  const result = await execFileAsync(process.execPath, [cli, "run", "--target", "codex", "--binding", "codex", "--", process.execPath, "--input-type=module", "-e", script], { env });
  const output = JSON.parse(result.stdout);
  assert.ok(output.file.startsWith(`${output.home}${path.sep}`));
  assert.equal(output.window, 128000);
  assert.match(output.instructions, /Official base/);
  await assert.rejects(fs.access(output.home));
  await assert.rejects(fs.access(path.join(env.CODEX_HOME, "config.toml")));
});

async function writeStore(home, config, secrets) {
  await fs.writeFile(path.join(home, "config.json"), JSON.stringify(config));
  await fs.writeFile(path.join(home, "secrets.json"), JSON.stringify(secrets));
}

async function writeRuntime(home, port) {
  await fs.writeFile(
    path.join(home, "runtime.json"),
    JSON.stringify({ pid: process.pid, web: { host: "127.0.0.1", port } }),
  );
}

async function startRuntimeProbe() {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/v1/runtime") {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-cabletidy": "cabletidy",
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function claudeConfig() {
  return {
    version: 1,
    revision: 1,
    web: { enabled: true, listenHost: "127.0.0.1", port: 43100 },
    upstreams: { relay: { id: "relay", protocol: "anthropic.messages", baseUrl: "https://relay.test/v1" } },
    models: {
      model: {
        id: "model",
        clientModelId: "sonnet",
        aliases: ["sonnet"],
        upstreams: { relay: { upstreamModelId: "vendor-sonnet" } },
      },
    },
    routes: { route: { id: "route", strategy: "priority", backends: [{ upstream: "relay", models: ["model"] }] } },
    virtualProviders: {
      claude: {
        id: "claude",
        listenHost: "127.0.0.1",
        listenPort: 43102,
        ingressProtocol: "anthropic.messages",
        route: "route",
        allowedModels: ["model"],
        defaultModel: "model",
        localAuth: { secretRef: "secret://virtual-providers/claude" },
      },
    },
    bindings: {
      claude: {
        id: "claude",
        target: "claude-code",
        targetFormat: "claude.env.v1",
        virtualProvider: "claude",
        defaultModel: "model",
      },
    },
  };
}

function codexConfig() {
  return {
    version: 1,
    revision: 1,
    web: { enabled: true, listenHost: "127.0.0.1", port: 43100 },
    upstreams: { relay: { id: "relay", protocol: "openai.responses", baseUrl: "https://relay.test/v1" } },
    models: {
      model: {
        id: "model",
        clientModelId: "gpt-5.5",
        aliases: ["gpt-5.5"],
        capabilities: ["streaming", "tools", "reasoning"],
        contextWindow: 1000000,
        reasoning: { effort: "high" },
        compact: { strategy: "auto", tokenLimit: 850000 },
        upstreams: { relay: { upstreamModelId: "vendor-model" } },
      },
    },
    routes: { route: { id: "route", strategy: "priority", backends: [{ upstream: "relay", models: ["model"] }] } },
    virtualProviders: {
      codex: {
        id: "codex",
        listenHost: "127.0.0.1",
        listenPort: 43101,
        ingressProtocol: "openai.responses",
        route: "route",
        allowedModels: ["model"],
        defaultModel: "model",
        localAuth: { secretRef: "secret://virtual-providers/codex" },
      },
    },
    bindings: {
      codex: {
        id: "codex",
        target: "codex",
        integration: "codex-native-provider",
        targetFormat: "codex.config.toml.v1",
        virtualProvider: "codex",
        defaultModel: "model",
        codex: { providerId: "cabletidy_relay" },
      },
    },
  };
}
