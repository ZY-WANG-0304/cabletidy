import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import spawn from "cross-spawn";
import { createApplication } from "../test/helpers/native-app.mjs";
import { getPaths, buildTargetArtifacts } from "../test/helpers/native.mjs";
import { claudeConfigFixture } from "../test/helpers/claude-fixture.mjs";

function runClaude(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CABLETIDY_CLAUDE_BIN || "claude", args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Claude smoke test timed out")); }, 45_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

test("installed Claude CLI uses applied and standalone CableTidy settings with a simulated upstream", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-claude-smoke-"));
  const claudeHome = path.join(home, "client");
  const calls = [];
  const text = "CableTidy Claude smoke OK";
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: request.url, body, headers: request.headers });
    if (request.url.includes("count_tokens")) { response.end('{"input_tokens":10}'); return; }
    const message = { id: "msg_smoke", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...message, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 8 } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      { type: "message_start", message },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ];
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const app = await createApplication({ paths: getPaths(path.join(home, "daemon")), claudeHome });
  t.after(async () => {
    upstream.closeAllConnections();
    await Promise.all([app.close(), new Promise((resolve) => upstream.close(resolve))]);
    await fs.rm(home, { recursive: true, force: true });
  });
  const config = claudeConfigFixture(`http://127.0.0.1:${upstream.address().port}/v1`, Number(new URL(app.url).port));
  config.virtualProviders["cabletidy_claude-main"].models["claude-custom-sonnet"] = {
    ...config.virtualProviders["cabletidy_claude-main"].models["claude-sonnet-4-6"], upstreamModelId: "vendor-custom-sonnet",
  };
  config.bindings["claude-main"].defaultModel = "sonnet";
  config.bindings["claude-main"].claude = { setModel: true, models: { sonnet: "claude-custom-sonnet" } };
  const post = async (route, body) => {
    const response = await fetch(`${app.url}api/v1/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  };
  await post("config/commit", { baseRevision: 0, config, upstreamSecrets: { relay: "smoke-upstream-key" } });
  await post("targets/apply", { bindingId: "claude-main" });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC_|CLAUDE|AWS_|GOOGLE_|VERTEX_|CLOUD_ML_)/i.test(key)));
  Object.assign(env, { CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_USE_BEDROCK: "1", NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" });
  const version = await runClaude(["--version"], { env, cwd: home });
  assert.equal(version.code, 0, version.stderr);
  t.diagnostic(version.stdout.trim());
  const args = ["-p", "Return a short acknowledgement.", "--output-format", "json",
    "--no-session-persistence", "--setting-sources", "user", "--tools", "", "--strict-mcp-config"];
  for (const mode of ["applied", "standalone"]) {
    const extra = [];
    if (mode === "standalone") {
      await post("targets/restore", { bindingId: "claude-main" });
      const file = path.join(home, "standalone.json");
      await fs.writeFile(file, buildTargetArtifacts(config, { bindingId: "claude-main" }).files[0].contents);
      extra.push("--settings", file);
    }
    for (const selection of ["explicit", "startup-alias"]) {
      const before = calls.length;
      const selected = selection === "explicit" ? ["--model", "claude-sonnet-4-6"] : [];
      const result = await runClaude([...args, ...extra, ...selected], { env, cwd: home });
      assert.equal(result.code, 0, `${mode}/${selection}: ${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /CableTidy Claude smoke OK/);
      assert.ok(calls.length > before);
      for (const call of calls.slice(before)) {
        assert.equal(call.body.model, selection === "explicit" ? "vendor-sonnet" : "vendor-custom-sonnet");
      }
      t.diagnostic(`${mode}/${selection}: CLI received the simulated stream with the expected model`);
    }
  }
  assert.ok(calls.length >= 2);
  for (const call of calls) {
    assert.equal(call.headers["x-api-key"], "smoke-upstream-key");
    assert.equal(call.headers.authorization, undefined);
  }
});
