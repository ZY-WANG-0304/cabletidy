import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { createApplication } from "../test/helpers/native-app.mjs";
import { getPaths, normalizeConfig } from "../test/helpers/native.mjs";
import { catalogFixture, codexConfigFixture } from "../test/helpers/codex-fixture.mjs";
import { claudeConfigFixture } from "../test/helpers/claude-fixture.mjs";
import { claudeRequestFixture } from "../test/helpers/claude-request-fixture.mjs";

const output = path.resolve(process.env.CABLETIDY_BROWSER_OUTPUT || ".cabletidy-debug/security-review");
await fs.mkdir(output, { recursive: true });
const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-security-browser-"));
const secret = "browser-review-credential-123456";
const fullItemText = "逐项完整内容：保留所有行、汉字和 emoji 🙂。\n".repeat(180) + "完整内容末尾 <script>literal</script>";
const context = "普通上下文：请复核网关实际观察到的内容。<script>literal</script>\n".repeat(24000);
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  if (req.url === "/v1/messages") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_browser_claude", type: "message", role: "assistant", model: body.model,
      content: body.responseBlocks || [{ type: "text", text: "已复核 Claude 请求内容。" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 8 } }));
    return;
  }
  const text = `${context}响应命中前 ${secret} 响应命中后；继续复核上下文。`;
  if (body.stream) {
    const item = { id: "msg_browser", type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] };
    const response = { id: "resp_browser", object: "response", status: "in_progress", model: body.model, output: [item] };
    const events = [
      { type: "response.created", response },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text },
      { type: "response.content_part.done", output_index: 0, content_index: 0, part: { type: "output_text", text } },
      { type: "response.output_item.done", output_index: 0, item: { ...item, content: [{ type: "output_text", text }] } },
      { type: "response.completed", response: { ...response, status: "completed", output: [{ ...item, content: [{ type: "output_text", text }] }] } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: body.model, output: body.responseBlocks || (body.reviewCase ? [{ type: "output_text", text }] : []) }));
});
await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
let app, browser, page, releaseRaceRefresh, releaseBodyExpansion;
const report = { viewport: { width: 1440, height: 1000 }, screenshots: [], hits: [], checks: [] };
try {
  app = await createApplication({ paths: getPaths(home), loadCodexCatalog: async () => catalogFixture() });
  const config = normalizeConfig(codexConfigFixture());
  config.web.port = Number(new URL(app.url).port);
  config.upstreams.relay.baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const claudeConfig = claudeConfigFixture(config.upstreams.relay.baseUrl);
  config.upstreams.claude = { ...claudeConfig.upstreams.relay, id: "claude", secretRef: "secret://upstreams/claude" };
  config.routes.claude = { id: "claude", backends: [{ upstream: "claude" }] };
  config.virtualProviders["cabletidy_claude-main"] = { ...claudeConfig.virtualProviders["cabletidy_claude-main"], route: "claude" };
  config.bindings["claude-main"] = claudeConfig.bindings["claude-main"];
  const post = async (route, body) => {
    const response = await fetch(`${app.url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
  };
  await post("api/v1/config/commit", { baseRevision: 0, config, upstreamSecrets: { relay: secret, claude: secret } });
  await post("relay/v1/responses", { model: "gpt-5.5", metadata: { session_id: "review-session" }, reviewCase: true, stream: true, input: `排查候选词提交后仍然高亮的问题。\n${context}请求命中前 ${secret} 请求命中后；继续复核上下文。` });
  const mixedInput = [
    { role: "developer", content: [{ type: "input_text", text: fullItemText }] },
    { role: "user", content: [{ type: "input_text", text: "排查候选词提交后仍然高亮的问题。" }] },
    { role: "assistant", content: [{ type: "output_text", text: "检查输入控制器的状态重置。" }] },
    { type: "function_call", name: "exec_command", call_id: "browser_call", arguments: '{"cmd":"rg markedRange src"}' },
    { type: "function_call_output", call_id: "browser_call", output: "InputController.swift:42 · markedRange 未清除" },
    { type: "custom_tool_call", name: "apply_patch", call_id: "browser_patch", input: "*** Begin Patch\n*** Update File: InputController.swift\n*** End Patch" },
    { type: "custom_tool_call_output", call_id: "browser_patch", output: "客户端报告：补丁已应用" },
    { type: "reasoning", summary: [], encrypted_content: "opaque-reasoning" },
    ...Array.from({ length: 35 }, (_, i) => ({ role: "assistant", content: `已保留历史上下文 ${i + 1}` })),
    { role: "user", content: [{ type: "input_text", text: "请结合截图继续检查。<script>literal</script>" }, { type: "input_image", image_url: "data:image/png;base64,test" }] },
  ];
  for (let i = 0; i < 52; i++) {
    const input = [
    { role: "user", content: "排查候选词提交后仍然高亮的问题。" },
    { role: "assistant", content: "已定位候选词提交与 markedRange 更新逻辑。" },
    { role: "user", content: `第 ${i + 2} 步：检查输入控制器的状态重置。${i === 4 ? secret : "保留已有输入上下文。"}` }
    ];
    await post("relay/v1/responses", { model: "gpt-5.5", metadata: { session_id: "review-session" }, ...(i === 0 ? { instructions: "你是编程助手。保留用户已有修改，使用工具验证代码。", input: mixedInput, tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }, { type: "custom", name: "apply_patch", description: "按补丁修改文件" }] } : { input }) });
  }
  for (let i = 0; i < 64; i++) await post("relay/v1/responses", { model: "gpt-5.5", input: `Pagination fixture ${i}: ${secret}` });
  let audits, sessionRecords;
  for (let i = 0; i < 600; i++) {
    audits = await (await fetch(`${app.url}api/v1/security/audit?kind=request&limit=100`)).json();
    const sessions = await (await fetch(`${app.url}api/v1/security/sessions?limit=100`)).json();
    const session = sessions.items.find(item => item.identified);
    if (session) sessionRecords = await (await fetch(`${app.url}api/v1/security/audit?session=${session.id}&limit=100`)).json();
    if (audits.total === 117 && sessionRecords?.items.length === 53 && sessionRecords.items.every(item => ["complete", "partial"].includes(item.inspectionStatus)) && audits.items.every(item => !["pending", "running"].includes(item.inspectionStatus))) break;
    await delay(100);
  }
  assert.equal(audits.total, 117);
  assert.equal(audits.items.every(item => ["complete", "partial"].includes(item.inspectionStatus)), true);
  assert.equal(sessionRecords.items[1].inspectionStatus, "partial", "mixed image/reasoning context honestly reports limited semantic inspection");
  const audit = sessionRecords.items[0];
  const record = (await (await fetch(`${app.url}api/v1/security/audit/${audit.id}`)).json()).record;
  assert.equal(audit.clientModelId, "gpt-5.5");
  assert.equal(audit.upstreamModelId, "VENDOR-GPT");
  assert.equal(record.clientModelId, audit.clientModelId);
  assert.equal(record.upstreamModelId, audit.upstreamModelId);
  assert.ok(record.responsePreview?.startsWith("普通上下文"), "streamed model text has a readable summary");
  const requestHit = record.findings.find(f => f.evidenceStage === "request_content");
  const responseHit = record.findings.find(f => f.evidenceStage === "response_content");
  for (const finding of [requestHit, responseHit]) {
    assert.equal(finding.ruleId, "SEC-SECRET-001");
    assert.equal(finding.evidence.bodyRef.matchKind, "sensitive");
    assert.ok(finding.evidence.bodyRef.start > 1024 * 1024);
    assert.equal(finding.evidence.bodyRef.end - finding.evidence.bodyRef.start, Buffer.byteLength(secret));
  }
  browser = await chromium.launch({ headless: true, ...(process.env.CABLETIDY_BROWSER_EXECUTABLE ? { executablePath: process.env.CABLETIDY_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: report.viewport });
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  const errors = [];
  let expectedRefreshFailure = false;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !(expectedRefreshFailure && message.text().includes("503"))) errors.push(message.text()); });
  const screenshot = async name => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no horizontal page overflow");
    const file = path.join(output, name);
    const scroll = await page.evaluate(() => ({ left: scrollX, top: scrollY }));
    await page.evaluate(() => scrollTo({ left: 0, top: 0, behavior: "instant" }));
    await page.screenshot({ path: file, fullPage: true });
    await page.evaluate(position => scrollTo({ ...position, behavior: "instant" }), scroll);
    report.screenshots.push(file);
  };
  const visibleHit = async stage => {
    await page.waitForFunction(expected => {
      const marks = [...document.querySelectorAll(".security-body-hit")];
      if (marks.map(mark => mark.textContent).join("") !== expected) return false;
      const box = marks[0]?.closest(".security-body-content").getBoundingClientRect();
      if (!box) return false;
      return marks.every(mark => [...mark.getClientRects()].every(rect =>
        rect.top >= Math.max(0, box.top) && rect.bottom <= Math.min(innerHeight, box.bottom)
        && rect.left >= Math.max(0, box.left) && rect.right <= Math.min(innerWidth, box.right)));
    }, secret);
    const geometry = await page.evaluate(() => {
      const mark = document.querySelector(".security-body-hit");
      const body = mark.closest(".security-body-content");
      return { text: mark.textContent, hit: mark.getBoundingClientRect().toJSON(), body: body.getBoundingClientRect().toJSON(), bodyScrollTop: body.scrollTop, pageScrollY: scrollY };
    });
    if (stage === "request") assert.ok(geometry.bodyScrollTop > 0, "the long body scrolls to its actual hit");
    assert.match(await page.locator("#page-content").innerText(), new RegExp(secret));
    assert.equal(await page.locator(".security-body-content script").count(), 0);
    report.hits.push({ stage, ...geometry });
  };
  const visibleSource = async expected => {
    await page.waitForFunction(expected => {
      const target = document.querySelector("[data-security-body-anchor]");
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      let top = 0, bottom = innerHeight, left = 0, right = innerWidth;
      for (let parent = target.parentElement; parent; parent = parent.parentElement) {
        if (!/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflow)) continue;
        const box = parent.getBoundingClientRect();
        top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
        left = Math.max(left, box.left); right = Math.min(right, box.right);
      }
      if (rect.top < top || rect.bottom > bottom || rect.left < left || rect.right > right) return false;
      const body = target.closest("pre");
      const prefix = document.createRange();
      prefix.selectNodeContents(body);
      prefix.setEnd(target, 0);
      const index = body.textContent.indexOf(expected, prefix.toString().length);
      if (index < 0) return false;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let at = 0, started = false, node;
      while ((node = walker.nextNode())) {
        const end = at + node.textContent.length;
        if (!started && index < end) { range.setStart(node, index - at); started = true; }
        if (started && index + expected.length <= end) { range.setEnd(node, index + expected.length - at); break; }
        at = end;
      }
      return [...range.getClientRects()].every(rect => rect.top >= top && rect.bottom <= bottom && rect.left >= left && rect.right <= right);
    }, expected);
    const body = page.getByLabel("保留正文", { exact: true });
    assert.ok((await body.textContent()).includes(expected));
    assert.equal(await body.locator(".security-body-hit").count(), 0, "source links must not add risk highlighting");
    assert.equal(await body.locator("script").count(), 0);
  };
  const checkList = async savedScroll => {
    await page.waitForFunction(y => document.querySelectorAll(".security-session-row").length === 15 && Math.abs(scrollY - y) <= 2, savedScroll);
    assert.equal(await page.getByLabel("仅看有风险").isChecked(), true);
    assert.equal(await page.locator('[name="category"]').inputValue(), "sensitive_data");
    assert.match(await page.locator(".security-pagination").innerText(), /第 2 页/);
    assert.equal(await page.locator(".security-detail").count(), 0);
  };
  await page.goto(app.url);
  await page.getByRole("button", { name: "审计记录", exact: true }).click();
  await page.locator(".security-session-row").first().waitFor();
  await page.getByLabel("仅看有风险").check();
  await page.getByText("更多筛选", { exact: true }).click();
  await page.locator('[name="category"]').selectOption("sensitive_data");
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  const detailButton = page.locator(`[data-action="security-session"][data-id="${audit.sessionKey}"]`);
  await detailButton.scrollIntoViewIfNeeded();
  const savedScroll = await page.evaluate(() => scrollY);
  assert.ok(savedScroll > 300);
  await screenshot("01-desktop-list-page-two.png");
  await detailButton.click();
  await page.locator(".trace-event-row").first().waitFor();
  assert.equal(new URL(page.url()).hash, `#security/session/${audit.sessionKey}`);
  assert.equal(await page.locator(".trace-event-row").count(), 50);
  assert.equal(await page.getByRole("button", { name: "下一页请求", exact: true }).count(), 0);
  assert.equal(await page.locator(".security-session-symbol").count(), 0);
  await page.locator(".trace-inspector-heading").waitFor();
  const requestModels = page.locator(".trace-event-row.is-selected .trace-event-models");
  assert.match(await requestModels.innerText(), /模型\s+gpt-5\.5 → VENDOR-GPT/);
  const modelFacts = page.locator(".trace-inspector-body > .trace-facts");
  assert.match(await modelFacts.innerText(), /模型\s+gpt-5\.5 → VENDOR-GPT/);
  report.checks.push("each request and its overview show the recorded client and upstream models");
  await screenshot("02-desktop-session-trace.png");
  await page.locator(".trace-event-list").evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => document.querySelectorAll(".trace-event-row").length === 53);
  const scrollAfterAppend = await page.locator(".trace-event-list").evaluate(node => node.scrollTop);
  assert.ok(scrollAfterAppend > 1000, "scroll append preserves the reading position");
  assert.equal(await page.locator(".trace-event-row.is-selected").getAttribute("data-id"), audit.id);
  await page.getByRole("button", { name: "刷新会话", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".trace-event-row").length === 53 && document.querySelector(".trace-inspector-heading"));
  assert.equal(await page.locator(".trace-event-list").evaluate(node => node.scrollTop), scrollAfterAppend);
  assert.equal(await page.locator(".trace-event-row.is-selected").getAttribute("data-id"), audit.id);
  report.checks.push("scrolling appends requests beyond 50 without replacing prior rows or the selected request; refresh retains the loaded range and scroll position");
  const durationToggle = page.getByRole("button", { name: "耗时占比", exact: true });
  assert.equal(await durationToggle.getAttribute("aria-pressed"), "false");
  const segmentWidths = () => page.locator(".trace-segment").evaluateAll(nodes => nodes.map(node => node.style.flexGrow));
  const requestOrder = () => page.locator(".trace-event-row").evaluateAll(nodes => nodes.map(node => node.dataset.id));
  const defaultWidths = await segmentWidths(), initialOrder = await requestOrder();
  await durationToggle.click();
  assert.equal(await durationToggle.getAttribute("aria-pressed"), "true");
  assert.notDeepEqual(await segmentWidths(), defaultWidths);
  assert.deepEqual(await requestOrder(), initialOrder);
  await durationToggle.click();
  assert.equal(await durationToggle.getAttribute("aria-pressed"), "false");
  assert.deepEqual(await segmentWidths(), defaultWidths);
  assert.deepEqual(await requestOrder(), initialOrder);
  assert.equal(await page.locator(".trace-event-row.is-selected").getAttribute("data-id"), audit.id);
  assert.equal(await page.locator(".trace-event-list").evaluate(node => node.scrollTop), scrollAfterAppend);
  report.checks.push("the duration toggle changes and restores segment widths while preserving request order, selection and scroll position");
  const mixedRequest = sessionRecords.items[1];
  await page.locator(`.trace-event-row[data-id="${mixedRequest.id}"]`).click();
  await page.locator('[data-action="security-trace-tab"][data-tab="request"]').click();
  await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="0"]').waitFor();
  const overviewText = await page.locator(".trace-inspector-body").innerText();
  for (const label of ["系统提示词", "开发者指令", "用户输入", "历史模型消息", "历史工具调用", "工具结果", "推理 / 压缩上下文", "可用工具定义"]) assert.ok(overviewText.includes(label));
  assert.equal(await page.locator('[aria-label="请求内容"] .trace-content-item').count(), 40);
  assert.equal(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="1"] > .trace-content-detail > pre').textContent(), fullItemText);
  assert.match(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="5"]').innerText(), /markedRange 未清除|对应第 5 项 · 客户端报告的结果/);
  assert.match(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="8"]').innerText(), /没有可读文本/);
  const checkSourceHeading = async index => {
    const block = page.locator(`[aria-label="请求内容"] .trace-content-item[data-content-index="${index}"]`);
    const header = await block.locator(":scope > summary").boundingBox();
    const title = await block.locator(".trace-content-title").boundingBox();
    const source = await block.getByRole("button", { name: "查看此项原文", exact: true }).boundingBox();
    assert.ok(source && header && title);
    assert.ok(source.x >= title.x + title.width - 1, "source button sits to the right of the title");
    assert.ok(source.y >= header.y && source.y + source.height <= header.y + header.height + 1, "source button shares the title row");
  };
  await checkSourceHeading(0);
  await screenshot("06-desktop-codex-mixed-overview.png");
  await page.getByLabel("请求内容", { exact: true }).getByRole("button", { name: "下一组内容", exact: true }).click();
  await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="44"]').waitFor();
  assert.match(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="44"]').innerText(), /图片 · 非文本内容见完整结构或原文/);
  await page.setViewportSize({ width: 390, height: 844 });
  await checkSourceHeading(44);
  await screenshot("07-mobile-codex-mixed-overview.png");
  await page.setViewportSize(report.viewport);
  await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="44"] > summary .trace-content-title').click();
  assert.equal(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="44"]').getAttribute("open"), null);
  await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="44"]').getByRole("button", { name: "查看此项原文", exact: true }).click();
  await visibleSource("请结合截图继续检查");
  assert.equal(await page.locator(".security-body-content script").count(), 0);
  report.checks.push("Codex mixed contexts retain all roles, tool/result links, opaque reasoning, multimodal markers and paginated source navigation on desktop and mobile");
  await page.locator(`.trace-event-row[data-id="${audit.id}"]`).click();
  await page.locator('[data-action="security-trace-tab"][data-tab="overview"]').click();
  await page.locator(".trace-inspector-heading").waitFor();
  await page.getByLabel("搜索已加载轨迹").fill("第 6 步");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  assert.equal(await page.locator(".trace-event-row").count(), 1);
  await page.getByLabel("搜索已加载轨迹").fill("");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.locator('[data-action="security-trace-tab"][data-tab="risks"]').click();
  assert.equal(await page.locator(".security-sessions, #security-filter-form").count(), 0);
  assert.equal(await page.locator('[data-page="security"]').getAttribute("aria-current"), "page");
  await page.locator(`[data-action="security-finding"][data-id="${requestHit.id}"]`).click();
  await visibleHit("request");
  await screenshot("02-desktop-request-hit.png");
  await page.locator('[data-action="security-trace-tab"][data-tab="risks"]').click();
  await page.locator(`[data-action="security-finding"][data-id="${responseHit.id}"]`).click();
  await visibleHit("response-evidence");
  await screenshot("03-desktop-response-hit.png");
  assert.equal(await page.locator('[data-security-snapshot^="stream/"]').count(), 0);
  assert.equal(await page.locator(".security-event-timeline").count(), 1);
  assert.match(await page.locator(".security-event-timeline").innerText(), /流式事件/);
  report.checks.push("precise request and response hits are shown in their corresponding body panels without exposing detection snapshots as top-level panels");
  const bodyRequests = [];
  const trackBodyRequest = request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith(`/security/audit/${audit.id}/body`)) bodyRequests.push(url.searchParams.get("snapshot"));
  };
  page.on("request", trackBodyRequest);
  for (const id of ["request/headers", "request", "response/headers", "response"]) {
    const panel = page.locator(`[data-security-snapshot="${id}"]`);
    assert.equal(await panel.getAttribute("open"), null);
    const before = bodyRequests.length;
    await panel.locator("summary").first().click();
    await panel.locator(".security-body-content").first().waitFor();
    assert.ok((await panel.locator(".security-body-content").first().innerText()).length > 0);
    await delay(100);
    assert.deepEqual(bodyRequests.slice(before), [id], "expanding loads exactly once despite rerendering");
    const content = await panel.innerText();
    await panel.locator("summary").first().click();
    await panel.locator("summary").first().click();
    await delay(100);
    assert.equal(await panel.innerText(), content);
    assert.equal(bodyRequests.length, before + 1, "reopening loaded content avoids duplicate requests");
  }
  const eventId = await page.locator("[data-security-event]").first().getAttribute("data-security-event");
  const eventIndex = await page.locator(".security-event").evaluateAll((nodes, id) => nodes.findIndex(node => node.dataset.securityEvent === id), eventId);
  const eventPanel = page.locator(".security-event").nth(eventIndex);
  const beforeEvent = bodyRequests.length;
  await eventPanel.locator("summary").click();
  await eventPanel.getByLabel("检测快照").waitFor();
  assert.ok((await eventPanel.getByLabel("检测快照").innerText()).length > 0);
  await delay(100);
  assert.deepEqual(bodyRequests.slice(beforeEvent), [eventId]);
  await eventPanel.locator("summary").click();
  await eventPanel.locator("summary").click();
  await delay(100);
  assert.equal(bodyRequests.length, beforeEvent + 1);
  const bodyGate = new Promise(resolve => { releaseBodyExpansion = resolve; });
  let bodyEntered;
  const bodyPrefetched = new Promise(resolve => { bodyEntered = resolve; });
  const delayedBody = url => url.pathname.endsWith(`/security/audit/${audit.id}/body`) && url.searchParams.get("snapshot") === "request/headers";
  await page.route(delayedBody, async route => {
    const response = await route.fetch();
    bodyEntered();
    await bodyGate;
    await route.fulfill({ response });
  });
  const headerPanel = page.locator('[data-security-snapshot="request/headers"]');
  const beforeInterleaved = bodyRequests.length;
  await headerPanel.locator("summary").first().click();
  await bodyPrefetched;
  assert.match(await headerPanel.innerText(), /正在加载正文片段/);
  const concurrentEventId = await page.locator("[data-security-event]").first().getAttribute("data-security-event");
  const concurrentEventIndex = await page.locator(".security-event").evaluateAll((nodes, id) => nodes.findIndex(node => node.dataset.securityEvent === id), concurrentEventId);
  const concurrentEventPanel = page.locator(".security-event").nth(concurrentEventIndex);
  await concurrentEventPanel.locator("summary").click();
  await concurrentEventPanel.getByLabel("检测快照").waitFor();
  const eventContent = await concurrentEventPanel.getByLabel("检测快照").innerText();
  releaseBodyExpansion();
  await headerPanel.locator(".security-body-content").first().waitFor();
  assert.ok((await headerPanel.locator(".security-body-content").first().innerText()).length > 0);
  assert.doesNotMatch(await headerPanel.innerText(), /正在加载正文片段/);
  assert.equal(await concurrentEventPanel.getByLabel("检测快照").innerText(), eventContent);
  await headerPanel.locator("summary").first().click();
  await headerPanel.locator("summary").first().click();
  await delay(100);
  assert.deepEqual(bodyRequests.slice(beforeInterleaved), ["request/headers", concurrentEventId]);
  await page.unroute(delayedBody);
  report.checks.push("expanding a stream event while headers are loading preserves both responses and avoids restarting the stream request when headers arrive");
  page.off("request", trackBodyRequest);
  report.checks.push("collapsed request/response headers, bodies and stream events load on expansion without rerender request loops; reopening preserves loaded content");
  await page.goBack();
  await checkList(savedScroll);
  await page.goForward();
  await page.locator(".trace-event-row").first().waitFor();
  await page.reload();
  await page.locator(".trace-event-row").first().waitFor();
  assert.equal(await page.locator(".security-sessions, #security-filter-form").count(), 0);
  await page.locator(".trace-inspector-heading").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("05-mobile-session-trace.png");
  await page.setViewportSize(report.viewport);
  await page.getByRole("button", { name: "返回审计记录", exact: true }).click();
  await checkList(savedScroll);
  await screenshot("04-desktop-list-restored.png");
  await page.goto(`${app.url}#security/audit/${audit.id}`);
  await page.locator(".security-detail").waitFor();
  report.checks.push("standalone audit detail deep links remain available");
  report.checks.push("browser back/forward, detail reload and return button restore applied filters, page two and exact list scroll");
  const lastRequest = sessionRecords.items.at(-1);
  await page.goto(`${app.url}#security/session/${lastRequest.id}`);
  await page.waitForFunction(id => document.querySelector(".trace-event-row.is-selected")?.dataset.id === id && document.querySelector(".trace-inspector-heading"), lastRequest.id);
  assert.equal(new URL(page.url()).hash, `#security/session/${audit.sessionKey}`);
  assert.equal(await page.locator(".trace-event-row").count(), 53);
  await page.reload();
  await page.waitForFunction(id => document.querySelector(".trace-event-row.is-selected")?.dataset.id === id && document.querySelector(".trace-inspector-heading"), lastRequest.id);
  const retainedScroll = await page.locator(".trace-event-list").evaluate(node => node.scrollTop);
  const retainedDetail = await page.locator(".trace-inspector-body").innerText();
  assert.ok(retainedScroll > 1000);
  expectedRefreshFailure = true;
  await page.route("**/api/v1/security/audit?*", async route => {
    if (new URL(route.request().url()).searchParams.has("cursor")) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "刷新暂时失败" } }) });
    else await route.continue();
  });
  await page.getByRole("button", { name: "刷新会话", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "刷新暂时失败" }).waitFor();
  assert.equal(await page.locator(".trace-event-row").count(), 53);
  assert.equal(await page.locator(".trace-event-row.is-selected").getAttribute("data-id"), lastRequest.id);
  assert.equal(await page.locator(".trace-event-list").evaluate(node => node.scrollTop), retainedScroll);
  assert.equal(await page.locator(".trace-inspector-body").innerText(), retainedDetail);
  await page.unroute("**/api/v1/security/audit?*");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="alert"]') && document.querySelectorAll(".trace-event-row").length === 53 && document.querySelector(".trace-inspector-heading"));
  expectedRefreshFailure = false;
  assert.equal(await page.locator(".trace-event-list").evaluate(node => node.scrollTop), retainedScroll);
  assert.equal(await page.locator(".trace-event-row.is-selected").getAttribute("data-id"), lastRequest.id);
  await page.getByRole("button", { name: "返回审计记录", exact: true }).click();
  await page.locator(".security-session-row").first().waitFor();
  await page.goBack();
  await page.waitForFunction(id => document.querySelector(".trace-event-row.is-selected")?.dataset.id === id && document.querySelector(".trace-inspector-heading"), lastRequest.id);
  assert.equal(new URL(page.url()).hash, `#security/session/${audit.sessionKey}`);
  report.checks.push("old UUID links redirect to the canonical session and preserve a selection beyond the first page through reload and history; failed refreshes preserve rows, detail and scroll until retry succeeds");
  const refreshGate = new Promise(resolve => { releaseRaceRefresh = resolve; });
  let refreshEntered;
  const refreshPrefetched = new Promise(resolve => { refreshEntered = resolve; });
  const delayedDetail = `**/api/v1/security/audit/${lastRequest.id}`;
  await page.route(delayedDetail, async route => {
    const response = await route.fetch();
    refreshEntered();
    await refreshGate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "刷新会话", exact: true }).click();
  await refreshPrefetched;
  const newerRequest = sessionRecords.items.at(-2);
  await page.locator(`.trace-event-row[data-id="${newerRequest.id}"]`).click();
  await page.waitForFunction(id => document.querySelector(".trace-event-row.is-selected")?.dataset.id === id && document.querySelector(".trace-inspector-heading"), newerRequest.id);
  const newerDetail = await page.locator(".trace-inspector-body").innerText();
  releaseRaceRefresh();
  await page.waitForFunction(() => !document.querySelector('[data-action="security-session-refresh"]').disabled);
  assert.equal(await page.locator(".trace-event-row.is-selected").getAttribute("data-id"), newerRequest.id);
  assert.equal(await page.locator(".trace-inspector-body").innerText(), newerDetail);
  assert.equal(await page.evaluate(() => history.state.sessionRequestId), newerRequest.id);
  await page.unroute(delayedDetail);
  await page.reload();
  await page.waitForFunction(id => document.querySelector(".trace-event-row.is-selected")?.dataset.id === id && document.querySelector(".trace-inspector-heading"), newerRequest.id);
  report.checks.push("selecting another request during a delayed refresh preserves its detail and history after the old response arrives and after reload");
  const claudeSession = "38e0afcb-b001-43b3-bb62-a6c9f048b77f";
  const claudeFullBody = claudeRequestFixture();
  claudeFullBody.system[0].text = fullItemText;
  claudeFullBody.messages[0].content[0].text = fullItemText;
  for (const body of [claudeFullBody, claudeRequestFixture({ history: 45 }), {
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "只有工具结果" }] }],
  }]) await post("claude-main/v1/messages", { model: "claude-sonnet-4-6", max_tokens: 100,
    metadata: { user_id: JSON.stringify({ session_id: claudeSession, account_uuid: "browser-review" }) }, ...body });
  let claudeRecords;
  for (let i = 0; i < 300; i++) {
    claudeRecords = await (await fetch(`${app.url}api/v1/security/audit?kind=request&provider=cabletidy_claude-main&limit=10`)).json();
    if (claudeRecords.total === 3 && claudeRecords.items.every(item => ["complete", "partial"].includes(item.inspectionStatus) && !item.inspectionProgress?.active)) break;
    await delay(100);
  }
  assert.equal(claudeRecords.total, 3);
  const claudeDetails = await Promise.all(claudeRecords.items.map(async item => (await (await fetch(`${app.url}api/v1/security/audit/${item.id}`)).json()).record));
  const claudeMixed = claudeDetails.find(item => item.requestContent.total === 19);
  const claudePaged = claudeDetails.find(item => item.requestContent.total === 64);
  const claudeToolOnly = claudeDetails.find(item => item.requestContent.total === 1);
  assert.ok(claudeMixed && claudePaged && claudeToolOnly);
  await page.goto(`${app.url}#security/session/${claudeMixed.sessionKey}`);
  await page.locator(`.trace-event-row[data-id="${claudeMixed.id}"]`).waitFor();
  await page.locator(`.trace-event-row[data-id="${claudeMixed.id}"]`).click();
  await page.locator('[data-action="security-trace-tab"][data-tab="request"]').click();
  await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="16"]').waitFor();
  assert.equal(await page.locator('[aria-label="请求内容"] .trace-content-item').count(), 19);
  assert.equal(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="0"] > .trace-content-detail > pre').textContent(), fullItemText);
  assert.equal(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="2"] > .trace-content-detail > pre').textContent(), fullItemText);
  await checkSourceHeading(0);
  const claudeCounts = await page.getByLabel("请求内容组成", { exact: true }).innerText();
  for (const count of ["系统提示词 2", "用户输入 4", "历史工具调用 3", "工具结果 4", "可用工具定义 2"]) assert.ok(claudeCounts.includes(count), count);
  const openClaudeBlock = async index => {
    const block = page.locator(`[aria-label="请求内容"] .trace-content-item[data-content-index="${index}"]`);
    if (await block.getAttribute("open") === null) await block.locator("summary").first().click();
    return block;
  };
  for (const index of [0, 3, 4, 6, 10, 11, 12]) await openClaudeBlock(index);
  assert.match(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="0"]').innerText(), /缓存控制.*ephemeral.*1h/);
  assert.match(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="4"]').innerText(), /没有可读文本/);
  assert.match(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="6"]').innerText(), /保留参数 JSON 的键/);
  assert.match(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="10"]').innerText(), /对应第 7 项 · 客户端报告的结果/);
  assert.match(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="10"]').innerText(), /图片 · 文档 · 工具引用/);
  assert.match(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="10"]').innerText(), /第 3 条消息 · user · tool_result/);
  assert.match(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="11"]').innerText(), /客户端报告工具错误/);
  assert.equal(await page.locator(".trace-request-content script").count(), 0);
  const inspectorScroll = await page.locator(".trace-inspector-body").evaluate(node => {
    node.scrollTop = node.querySelector(".trace-request-content").offsetTop - node.offsetTop;
    return node.scrollTop;
  });
  assert.ok(inspectorScroll >= 0);
  await screenshot("08-desktop-claude-mixed-overview.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await checkSourceHeading(10);
  await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="10"]').scrollIntoViewIfNeeded();
  await screenshot("09-mobile-claude-mixed-overview.png");
  await page.setViewportSize(report.viewport);
  await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="10"] > summary .trace-content-title').click();
  assert.equal(await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="10"]').getAttribute("open"), null);
  await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="10"]').getByRole("button", { name: "查看此项原文", exact: true }).click();
  await visibleSource("read-source");
  await page.locator(`.trace-event-row[data-id="${claudePaged.id}"]`).click();
  await page.locator('[data-action="security-trace-tab"][data-tab="request"]').click();
  await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="39"]').waitFor();
  await page.getByLabel("请求内容", { exact: true }).getByRole("button", { name: "下一组内容", exact: true }).click();
  await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="55"]').waitFor();
  const pagedResult = await openClaudeBlock(55);
  assert.match(await pagedResult.innerText(), /对应第 7 项 · 客户端报告的结果/);
  assert.match(await pagedResult.innerText(), /解析器已经按内容块读取/);
  await page.setViewportSize({ width: 390, height: 844 });
  await pagedResult.scrollIntoViewIfNeeded();
  await screenshot("10-mobile-claude-paged-tools.png");
  await page.setViewportSize(report.viewport);
  await page.locator(`.trace-event-row[data-id="${claudeToolOnly.id}"]`).click();
  await page.locator('[data-action="security-trace-tab"][data-tab="request"]').click();
  await page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="0"]').waitFor();
  assert.match(await page.getByLabel("请求内容组成", { exact: true }).innerText(), /用户输入 0/);
  assert.equal(await page.locator('[aria-label="请求内容"] .trace-content-item').count(), 1);
  assert.match(await (await openClaudeBlock(0)).innerText(), /本次请求未找到对应调用/);
  report.checks.push("Claude content blocks keep system/cache metadata, thinking, parallel and server tools, multimodal results, errors and cross-page relations; user-role tool results are counted separately; desktop/mobile source navigation is exact");
  report.checks.push("Codex and Claude long items display their exact full text including the tail; all items open by default and source actions sit on the right of desktop and mobile title rows");
  // A source item's offset can be deep inside the first returned storage chunk.
  // Loading that chunk alone does not make its target visible in the nested pane.
  for (const claude of [false, true]) {
    const target = `${claude ? "Claude" : "Codex"} 原文导航目标 <script>literal</script>`;
    const preceding = "前置🙂".repeat(12000);
    await post(claude ? "claude-main/v1/messages" : "relay/v1/responses", claude ? {
      model: "claude-sonnet-4-6", max_tokens: 100,
      messages: [{ role: "user", content: preceding }, { role: "user", content: [{ type: "text", text: target }] }],
    } : { model: "gpt-5.5", input: [{ role: "user", content: preceding }, { role: "user", content: target }] });
    let detail;
    for (let i = 0; i < 300; i++) {
      const latest = await (await fetch(`${app.url}api/v1/security/audit?kind=request&provider=${claude ? "cabletidy_claude-main" : "cabletidy_relay"}&limit=1`)).json();
      const record = latest.items[0];
      if (record && !record.inspectionProgress?.active && ["complete", "partial"].includes(record.inspectionStatus)) {
        detail = (await (await fetch(`${app.url}api/v1/security/audit/${record.id}`)).json()).record;
        if (detail.requestContent.items[1]?.preview === target) break;
      }
      await delay(100);
    }
    assert.equal(detail.requestContent.items[1].preview, target);
    assert.ok(detail.requestContent.items[1].start > 120000);
    await page.goto(`${app.url}#security/session/${detail.sessionKey || detail.id}`);
    for (const mobile of [false, true]) {
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : report.viewport);
      await page.locator('[data-action="security-trace-tab"][data-tab="request"]').click();
      const item = page.locator('[aria-label="请求内容"] .trace-content-item[data-content-index="1"]');
      await item.waitFor();
      await item.locator(":scope > summary .trace-content-title").click();
      assert.equal(await item.getAttribute("open"), null);
      await item.getByRole("button", { name: "查看此项原文", exact: true }).click();
      await visibleSource(target);
      const body = page.getByLabel("保留正文", { exact: true });
      assert.ok(await body.evaluate(node => node.scrollTop) > 0, "long preceding content requires scrolling the body itself");
      const geometry = await body.locator("[data-security-body-anchor]").evaluate(node => ({
        anchor: node.getBoundingClientRect().toJSON(), bodyScrollTop: node.closest("pre").scrollTop,
      }));
      report.hits.push({ stage: `${claude ? "claude" : "codex"}-source-${mobile ? "mobile" : "desktop"}`, ...geometry });
      await screenshot(`${claude ? "13" : "11"}-${mobile ? "mobile" : "desktop"}-${claude ? "claude" : "codex"}-source-navigation.png`);
    }
  }
  report.checks.push("Codex and Claude source links scroll to the exact visible position after 120 KB of preceding UTF-8 text on desktop/mobile, including collapsed items, without adding risk highlighting");
  for (const claude of [false, true]) {
    const text = `${claude ? "Claude" : "Codex"} 完整响应🙂\n`.repeat(600) + "响应末尾 <script>literal</script>";
    const target = `${claude ? "Claude" : "Codex"} 响应原文目标`;
    const responseBlocks = claude ? [{ type: "thinking", thinking: "思考正文", signature: "sig" }, { type: "text", text }, { type: "tool_use", id: "read-response", name: "Read", input: { file_path: "src/lib.rs" } }, ...Array.from({length: 40}, (_, i) => ({type: "text", text: i === 39 ? target : `响应片段 ${i}`}))] : [{type: "reasoning", summary: [{type: "summary_text",text:"推理摘要"}]}, {type:"message",role:"assistant",content:[{type:"output_text",text}]}, {type:"custom_tool_call",call_id:"patch-response",name:"apply_patch",input:"*** Begin Patch\n*** End Patch"}, ...Array.from({length:40}, (_,i) => ({type:"message",role:"assistant",content:[{type:"output_text",text:i===39?target:`响应片段 ${i}`}]}))];
    await post(claude ? "claude-main/v1/messages" : "relay/v1/responses", { model: claude ? "claude-sonnet-4-6" : "gpt-5.5", max_tokens: 100, responseBlocks, ...(claude ? {messages:[{role:"user",content:"响应展示验收"}]} : {input:"响应展示验收"}) });
    let detail;
    for (let i=0;i<300;i++) {
      const latest = await (await fetch(`${app.url}api/v1/security/audit?kind=request&provider=${claude?"cabletidy_claude-main":"cabletidy_relay"}&limit=1`)).json();
      const record = latest.items[0];
      if (record && !record.inspectionProgress?.active && ["complete","partial"].includes(record.inspectionStatus)) {
        detail = (await (await fetch(`${app.url}api/v1/security/audit/${record.id}`)).json()).record;
        if (detail.responseContent?.total===43) break;
      }
      await delay(100);
    }
    assert.equal(detail.responseContent.total,43);
    await page.goto(`${app.url}#security/session/${detail.sessionKey || detail.id}`);
    for (const mobile of [false,true]) {
      await page.setViewportSize(mobile?{width:390,height:844}:report.viewport);
      await page.locator('[data-action="security-trace-tab"][data-tab="response"]').click();
      const response = page.getByLabel("响应内容",{exact:true});
      await response.waitFor();
      const tabs = page.locator('.trace-tabs');
      assert.deepEqual(await tabs.locator('button').allTextContents(), ["概览","风险 0","请求内容","响应内容","原始内容"]);
      assert.equal(await tabs.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, "five tabs fit the inspector width");
      if (mobile) {
        await response.getByRole("button",{name:"上一组内容",exact:true}).click();
      }
      await response.locator('.trace-content-item[data-content-index="1"]').waitFor();
      if (await response.locator('.trace-content-item[data-content-index="1"]').count()) {
        assert.equal(await response.locator('.trace-content-item[data-content-index="1"] > .trace-content-detail > pre').textContent(),text);
        await response.getByRole("button",{name:"下一组内容",exact:true}).click();
      }
      await response.locator('.trace-content-item[data-content-index="42"]').waitFor();
      assert.match(await response.innerText(),new RegExp(target));
      assert.equal(await page.getByLabel("请求内容",{exact:true}).count(),0);
      await page.locator('[data-action="security-trace-tab"][data-tab="request"]').click();
      assert.equal(await page.getByLabel("请求内容",{exact:true}).locator('.trace-content-item[data-content-index="0"]').count(),1);
      await page.locator('[data-action="security-trace-tab"][data-tab="response"]').click();
      assert.match(await response.innerText(),new RegExp(target));
      await response.scrollIntoViewIfNeeded();
      await screenshot(`${claude?"16":"15"}-${mobile?"mobile":"desktop"}-${claude?"claude":"codex"}-response-overview.png`);
      await response.locator('.trace-content-item[data-content-index="42"]').getByRole("button",{name:"查看此项原文",exact:true}).click();
      await visibleSource(target);
    }
  }
  report.checks.push("Codex and Claude responses show complete long text, thinking and tools, paginate independently, and navigate to response source on desktop and 390px mobile");
  assert.deepEqual(errors, []);
  report.checks.push("no browser errors or horizontal page overflow; body content remains escaped and original credentials are highlighted");
  report.savedListScrollY = savedScroll;
  report.passed = true;
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await fs.rm(path.join(output, "failure-full-page.png"), { force: true });
  console.log(`Desktop security review passed. Full-page screenshots and report: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, "failure-full-page.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  releaseRaceRefresh?.();
  releaseBodyExpansion?.();
  await browser?.close();
  await app?.close();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await fs.rm(home, { recursive: true, force: true });
}
