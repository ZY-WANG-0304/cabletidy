import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApplication } from "../test/helpers/native-app.mjs";
import { getPaths } from "../test/helpers/native.mjs";
import { catalogFixture } from "../test/helpers/codex-fixture.mjs";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-settings-browser-"));
const output = path.resolve(process.env.CABLETIDY_BROWSER_OUTPUT || ".cabletidy-debug/settings-review");
await fs.mkdir(output, { recursive: true });
let app, browser;
const errors = [];
try {
  app = await createApplication({ paths: getPaths(home), loadCodexCatalog: async () => catalogFixture() });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  const persisted = async () => (await (await fetch(`${app.url}api/v1/config`)).json()).config;
  const save = async audit => {
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#audit-settings-form button[type="submit"]').disabled);
    assert.deepEqual((await persisted()).audit, audit);
  };
  await page.goto(app.url);
  await page.waitForFunction(() => document.querySelector("#rail-status").textContent === "服务运行中");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  assert.equal(await page.locator("#page-title").textContent(), "设置");
  assert.equal(await page.locator('[data-page="settings"].nav-item').getAttribute("aria-current"), "page");
  assert.equal(await page.locator(".nav-item.is-active").count(), 1);
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).inputValue(), "30");
  assert.equal(await page.getByLabel("存储上限（MiB）", { exact: true }).inputValue(), "128");
  assert.equal(await page.locator("#audit-settings-cleanup").isVisible(), false);
  await page.mouse.move(1250, 700);
  await page.screenshot({ path: path.join(output, "settings-desktop.png"), fullPage: true, animations: "disabled" });

  await page.getByLabel("保存周期不设上限", { exact: true }).check();
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).isDisabled(), true);
  await page.getByLabel("存储不设上限", { exact: true }).check();
  assert.equal(await page.getByLabel("存储上限（MiB）", { exact: true }).isDisabled(), true);
  await save({ retentionDays: null, budgetBytes: null });
  await page.reload();
  await page.getByRole("button", { name: "保存设置", exact: true }).waitFor();
  assert.equal(await page.getByLabel("保存周期不设上限", { exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel("存储不设上限", { exact: true }).isChecked(), true);
  await page.getByRole("button", { name: "审计记录", exact: true }).click();
  await page.getByText("审计存储正常", { exact: false }).waitFor();
  assert.match(await page.locator("#page-content").textContent(), /保存周期不设上限/);
  assert.match(await page.locator("#page-content").textContent(), /存储不设上限/);
  await page.goBack();
  await page.getByRole("button", { name: "保存设置", exact: true }).waitFor();

  await page.getByLabel("保存周期不设上限", { exact: true }).uncheck();
  await page.getByLabel("保存周期（天）", { exact: true }).fill("7");
  assert.equal(await page.locator("#audit-settings-cleanup").isVisible(), true);
  await save({ retentionDays: 7, budgetBytes: null });
  await page.getByLabel("存储不设上限", { exact: true }).uncheck();
  await page.getByLabel("存储上限（MiB）", { exact: true }).fill("64");
  await page.getByLabel("保存周期不设上限", { exact: true }).check();
  await save({ retentionDays: null, budgetBytes: 64 * 1048576 });
  await page.getByLabel("保存周期不设上限", { exact: true }).uncheck();
  await page.getByLabel("保存周期（天）", { exact: true }).fill("90");
  await save({ retentionDays: 90, budgetBytes: 64 * 1048576 });
  assert.equal(await page.locator("#audit-settings-cleanup").isVisible(), false);

  await page.getByLabel("保存周期（天）", { exact: true }).fill("14");
  const external = await persisted();
  external.audit.budgetBytes = 256 * 1048576;
  const response = await fetch(`${app.url}api/v1/config/commit`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: external.revision, config: external }),
  });
  assert.equal(response.status, 200);
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "配置已在其他窗口变更" }).waitFor();
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).inputValue(), "14");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[name="budgetMiB"]').value === "256");
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).inputValue(), "14");
  await save({ retentionDays: 14, budgetBytes: 256 * 1048576 });

  await page.getByLabel("保存周期（天）", { exact: true }).fill("0");
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).evaluate(input => input.checkValidity()), false);
  await page.getByLabel("保存周期（天）", { exact: true }).fill("14");
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await page.getByRole("button", { name: "保存设置", exact: true }).isVisible(), true);
  const saveBounds = await page.getByRole("button", { name: "保存设置", exact: true }).boundingBox();
  assert.ok(saveBounds.y + saveBounds.height <= 812, "Save stays within the mobile viewport");
  await page.locator(".toast").last().waitFor({ state: "hidden", timeout: 10000 });
  await page.screenshot({ path: path.join(output, "settings-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Settings browser checks passed: finite/unlimited combinations, reload, navigation, conflicts, validation, desktop and mobile.");
  console.log(`Screenshots: ${output}`);
} finally {
  await browser?.close();
  await app?.close();
  await fs.rm(home, { recursive: true, force: true });
}
