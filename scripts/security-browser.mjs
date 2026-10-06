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
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: body.model, output: body.reviewCase ? [
    { type: "output_text", text: `${context}响应命中前 ${secret} 响应命中后；继续复核上下文。` },
  ] : [] }));
});
await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
let app, browser, page;
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
  await post("relay/v1/responses", { model: "gpt-5.5", reviewCase: true, input: `${context}请求命中前 ${secret} 请求命中后；继续复核上下文。` });
  for (let i = 0; i < 64; i++) await post("relay/v1/responses", { model: "gpt-5.5", input: `Pagination fixture ${i}: ${secret}` });
  let audits;
  for (let i = 0; i < 600; i++) {
    audits = await (await fetch(`${app.url}api/v1/security/audit?kind=request&limit=100`)).json();
    if (audits.total === 65 && audits.items.every(item => !["pending", "running"].includes(item.inspectionStatus))) break;
    await delay(100);
  }
  assert.equal(audits.total, 65);
  assert.equal(audits.items.every(item => item.inspectionStatus === "complete"), true);
  const audit = audits.items.at(-1);
  const record = (await (await fetch(`${app.url}api/v1/security/audit/${audit.id}`)).json()).record;
  const requestHit = record.findings.find(f => f.evidenceStage === "request_content");
  const responseHit = record.findings.find(f => f.evidenceStage === "response_content");
  for (const finding of [requestHit, responseHit]) {
    assert.equal(finding.ruleId, "SEC-SECRET-001");
    assert.equal(finding.evidence.bodyRef.matchKind, "redaction");
    assert.ok(finding.evidence.bodyRef.start > 1024 * 1024);
    assert.equal(finding.evidence.bodyRef.end - finding.evidence.bodyRef.start, 10);
  }
  browser = await chromium.launch({ headless: true, ...(process.env.CABLETIDY_BROWSER_EXECUTABLE ? { executablePath: process.env.CABLETIDY_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: report.viewport });
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
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
    await page.waitForFunction(() => {
      const marks = [...document.querySelectorAll(".security-body-hit")];
      if (marks.map(mark => mark.textContent).join("") !== "[REDACTED]") return false;
      const box = document.querySelector('[aria-label="保留正文"]').getBoundingClientRect();
      return marks.every(mark => [...mark.getClientRects()].every(rect =>
        rect.top >= Math.max(0, box.top) && rect.bottom <= Math.min(innerHeight, box.bottom)
        && rect.left >= Math.max(0, box.left) && rect.right <= Math.min(innerWidth, box.right)));
    });
    const geometry = await page.evaluate(() => {
      const mark = document.querySelector(".security-body-hit");
      const body = document.querySelector('[aria-label="保留正文"]');
      return { text: mark.textContent, hit: mark.getBoundingClientRect().toJSON(), body: body.getBoundingClientRect().toJSON(), bodyScrollTop: body.scrollTop, pageScrollY: scrollY };
    });
    assert.ok(geometry.bodyScrollTop > 0, "the long body scrolls to its actual hit");
    assert.doesNotMatch(await page.locator("#page-content").innerText(), new RegExp(secret));
    assert.equal(await page.locator(".security-body-content script").count(), 0);
    report.hits.push({ stage, ...geometry });
  };
  const checkList = async savedScroll => {
    await page.waitForFunction(y => document.querySelectorAll(".security-table tbody tr").length === 15 && Math.abs(scrollY - y) <= 2, savedScroll);
    assert.equal(await page.getByLabel("仅看有风险").isChecked(), true);
    assert.equal(await page.locator('[name="category"]').inputValue(), "sensitive_data");
    assert.match(await page.locator(".security-pagination").innerText(), /第 2 页/);
    assert.equal(await page.locator(".security-detail").count(), 0);
  };
  await page.goto(app.url);
  await page.getByRole("button", { name: "安全", exact: true }).click();
  await page.locator(".security-table tbody tr").first().waitFor();
  await page.getByLabel("仅看有风险").check();
  await page.locator('[name="category"]').selectOption("sensitive_data");
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  const detailButton = page.locator(`[data-action="security-detail"][data-id="${audit.id}"]`);
  await detailButton.scrollIntoViewIfNeeded();
  const savedScroll = await page.evaluate(() => scrollY);
  assert.ok(savedScroll > 300);
  await screenshot("01-desktop-list-page-two.png");
  await detailButton.click();
  await page.locator(".security-detail").waitFor();
  assert.equal(new URL(page.url()).hash, `#security/audit/${audit.id}`);
  assert.equal(await page.locator(".security-table, #security-filter-form").count(), 0);
  assert.equal(await page.locator('[data-page="security"]').getAttribute("aria-current"), "page");
  await page.locator(`[data-action="security-finding"][data-id="${requestHit.id}"]`).click();
  await visibleHit("request");
  await screenshot("02-desktop-request-hit.png");
  await page.locator(`[data-action="security-finding"][data-id="${responseHit.id}"]`).click();
  await visibleHit("response-evidence");
  await screenshot("03-desktop-response-hit.png");
  assert.equal(await page.locator('[data-security-snapshot^="stream/"]').count(), 0);
  report.checks.push("precise request and response hits are shown in their corresponding body panels without exposing detection snapshots as top-level panels");
  await page.goBack();
  await checkList(savedScroll);
  await page.goForward();
  await page.locator(".security-detail").waitFor();
  await page.reload();
  await page.locator(".security-detail").waitFor();
  assert.equal(await page.locator(".security-table, #security-filter-form").count(), 0);
  await page.getByRole("button", { name: "返回审计日志", exact: true }).click();
  await checkList(savedScroll);
  await screenshot("04-desktop-list-restored.png");
  report.checks.push("browser back/forward, detail reload and return button restore applied filters, page two and exact list scroll");
  assert.deepEqual(errors, []);
  report.checks.push("no browser errors or horizontal page overflow; body content remains escaped and credentials remain redacted");
  report.savedListScrollY = savedScroll;
  report.passed = true;
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await fs.rm(path.join(output, "failure-full-page.png"), { force: true });
  console.log(`Desktop security review passed. Full-page screenshots and report: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, "failure-full-page.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await fs.rm(home, { recursive: true, force: true });
}
