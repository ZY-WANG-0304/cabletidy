// Opt-in installed-client check. All model requests go to a local mock upstream.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createApplication } from "../test/helpers/native-app.mjs";
import { getPaths } from "../test/helpers/native.mjs";

const command = process.env.CABLETIDY_CODEX_COMMAND || "codex";
const version = execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
const catalog = JSON.parse(execFileSync(command, ["debug", "models", "--bundled"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
const native = catalog.models.find(model => model.slug.startsWith("gpt-")
  && model.supported_reasoning_levels?.some(level => level.effort === "high"));
assert.ok(native, "Installed Codex needs a complete native GPT definition with high reasoning");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-codex-inventory-"));
const requests = [];
let app, server;

function runCodex(codexHome, model) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["exec", "--skip-git-repo-check", "--json", "-m", model,
      "-c", 'model_reasoning_effort="high"', "Reply with Local fixture verified."], {
      cwd: home, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      try { assert.equal(code, 0, output); assert.match(output, /Local fixture verified\./); resolve(); }
      catch (error) { reject(error); }
    });
  });
}

try {
  server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ path: req.url, body });
      const item = { type: "message", id: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Local fixture verified.", annotations: [] }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "fixture", object: "response", model: body.model, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "fixture", object: "response", model: body.model, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  app = await createApplication({ paths: getPaths(path.join(home, "gateway")), loadCodexCatalog: async () => ({ version, catalog }) });
  let config = (await (await fetch(`${app.url}api/v1/config`)).json()).config;
  const post = async (endpoint, body) => {
    const response = await fetch(`${app.url}api/v1/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const commit = async operation => { config = (await post("config/commit", { baseRevision: config.revision, operation })).config; };
  await commit({ type: "supplier.save", supplierId: "fixture", data: { name: "Local fixture", interfaces: { responses: { protocol: "openai.responses", baseUrl: `http://127.0.0.1:${server.address().port}` } } } });
  for (const [modelId, identity] of [["wire-native", native.slug], ["wire-compatible", "DeepSeek-V4-Pro"]]) {
    await commit({ type: "supplier.model.save", supplierId: "fixture", data: { modelId, model: {
      identity, interfaces: ["responses"], capabilityStates: { tools: "supported", streaming: "supported", reasoning: "supported" },
      reasoning: { modes: ["effort"], efforts: ["high"] }, contextWindow: Math.min(128000, native.context_window), history: "stateless",
    } } });
  }
  await commit({ type: "cable.inventory.create", data: { name: "Smoke", suppliers: ["fixture"], defaultModel: "native", models: Object.fromEntries(["native", "compatible"].map(id => [id, { sources: [{ supplierId: "fixture", modelId: `wire-${id}`, interfaceId: "responses" }], promptStrategy: "default" }])) } });
  const bundle = (await post("targets/isolated", { cableId: "smoke" })).bundle;
  const codexHome = path.join(home, "isolated");
  await fs.mkdir(codexHome);
  for (const file of bundle.files) await fs.writeFile(path.join(codexHome, file.path), file.contents);
  for (const model of ["native", "compatible"]) {
    const before = requests.length;
    await runCodex(codexHome, model);
    assert.ok(requests.length > before, "Codex must call the gateway");
    for (const request of requests.slice(before)) {
      assert.equal(request.path, "/responses");
      assert.equal(request.body.model, `wire-${model}`);
      assert.equal(request.body.reasoning.effort, "high");
      assert.equal(request.body.store, false);
      assert.equal(request.body.parallel_tool_calls, false);
      if (model === "compatible") {
        assert.ok(request.body.tools.some(tool => tool.type === "custom" && tool.name === "apply_patch"));
        assert.ok(request.body.tools.every(tool => tool.type === "function" || tool.type === "custom"));
      }
    }
  }
  console.log(`${version}: native ${native.slug} and compatible Responses smoke checks passed (local mock only).`);
} finally {
  await app?.close();
  server?.closeAllConnections();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(home, { recursive: true, force: true });
}
