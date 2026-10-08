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

const output = path.resolve(process.env.CABLETIDY_BROWSER_OUTPUT || ".cabletidy-debug/security-review");
await fs.mkdir(output, { recursive: true });
const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-security-browser-"));
const secret = "browser-review-credential-123456";
const context = "普通上下文：请复核网关实际观察到的内容。<script>literal</script>\n".repeat(24000);
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
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
  res.end(JSON.stringify({ model: body.model, output: body.reviewCase ? [{ type: "output_text", text }] : [] }));
});
await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
let app, browser, page, releaseRaceRefresh;
const report = { viewport: { width: 1440, height: 1000 }, screenshots: [], hits: [], checks: [] };
try {
  app = await createApplication({ paths: getPaths(home), loadCodexCatalog: async () => catalogFixture() });
  const config = normalizeConfig(codexConfigFixture());
  config.web.port = Number(new URL(app.url).port);
  config.upstreams.relay.baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const post = async (route, body) => {
    const response = await fetch(`${app.url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
  };
  await post("api/v1/config/commit", { baseRevision: 0, config, upstreamSecrets: { relay: secret } });
  await post("relay/v1/responses", { model: "gpt-5.5", metadata: { session_id: "review-session" }, reviewCase: true, stream: true, input: `排查候选词提交后仍然高亮的问题。\n${context}请求命中前 ${secret} 请求命中后；继续复核上下文。` });
  for (let i = 0; i < 52; i++) await post("relay/v1/responses", { model: "gpt-5.5", metadata: { session_id: "review-session" }, input: [
    { role: "user", content: "排查候选词提交后仍然高亮的问题。" },
    { role: "assistant", content: "已定位候选词提交与 markedRange 更新逻辑。" },
    { role: "user", content: `第 ${i + 2} 步：检查输入控制器的状态重置。${i === 4 ? secret : "保留已有输入上下文。"}` }
  ] });
  for (let i = 0; i < 64; i++) await post("relay/v1/responses", { model: "gpt-5.5", input: `Pagination fixture ${i}: ${secret}` });
  let audits, sessionRecords;
  for (let i = 0; i < 600; i++) {
    audits = await (await fetch(`${app.url}api/v1/security/audit?kind=request&limit=100`)).json();
    const sessions = await (await fetch(`${app.url}api/v1/security/sessions?limit=100`)).json();
    const session = sessions.items.find(item => item.identified);
    if (session) sessionRecords = await (await fetch(`${app.url}api/v1/security/audit?session=${session.id}&limit=100`)).json();
    if (audits.total === 117 && sessionRecords?.items.length === 53 && sessionRecords.items.every(item => item.inspectionStatus === "complete") && audits.items.every(item => !["pending", "running"].includes(item.inspectionStatus))) break;
    await delay(100);
  }
  assert.equal(audits.total, 117);
  assert.equal(audits.items.every(item => item.inspectionStatus === "complete"), true);
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
  assert.equal(await page.getByRole("button", { name: "请求顺序", exact: true }).count(), 0);
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
  report.checks.push("a single duration toggle changes and restores segment widths while preserving request order, selection and scroll position");
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
  await browser?.close();
  await app?.close();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await fs.rm(home, { recursive: true, force: true });
}
