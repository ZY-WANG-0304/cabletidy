import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApplication } from "../test/helpers/native-app.mjs";
import { getPaths } from "../test/helpers/native.mjs";
import { namedCodexConfigFixture } from "../test/helpers/codex-fixture.mjs";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-transfer-browser-"));
let app, browser;
try {
  app = await createApplication({ paths: getPaths(home) });
  const config = namedCodexConfigFixture({ alpha: "Alpha", beta: "Beta" });
  for (const provider of Object.values(config.virtualProviders)) {
    provider.models = {};
    delete provider.defaultModel;
  }
  for (const binding of Object.values(config.bindings)) delete binding.defaultModel;
  config.web = (await (await fetch(`${app.url}api/v1/config`)).json()).config.web;
  const response = await fetch(`${app.url}api/v1/config/commit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: 0, config, upstreamSecrets: { alpha: "browser-api-key" } }) });
  assert.equal(response.status, 200, await response.text());
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(app.url);
  await page.getByRole("button", { name: "导出配置", exact: true }).click();
  await page.locator('input[name="bindingIds"][value="beta"]').uncheck();
  const downloadReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载配置文件" }).click();
  const download = await downloadReady;
  const filename = path.join(home, "export.json");
  await download.saveAs(filename);
  const exported = await fs.readFile(filename, "utf8");
  assert.doesNotMatch(exported, /browser-api-key|secretRef|secretConfigured/);
  assert.deepEqual(Object.keys(JSON.parse(exported).config.bindings), ["alpha"]);
  await page.getByRole("button", { name: "导入配置", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(filename);
  await page.getByRole("button", { name: "预览导入" }).click();
  await page.locator('select[name="choice:alpha"]').waitFor();
  assert.equal(await page.locator(".suite-table tbody tr").count(), 2);
  await page.locator('select[name="choice:alpha"]').selectOption("create");
  await page.getByRole("button", { name: "确认导入" }).click();
  await page.getByRole("button", { name: "Alpha (import 2)", exact: true }).waitFor();
  assert.equal(await page.locator(".suite-table tbody tr").count(), 3);
  const loaded = (await (await fetch(`${app.url}api/v1/config`)).json()).config;
  assert.equal(loaded.upstreams.alpha.secretConfigured, true);
  assert.equal(loaded.upstreams["alpha-2"].secretConfigured, false);
  await page.getByRole("button", { name: "导入配置", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(filename);
  await page.getByRole("button", { name: "预览导入" }).click();
  await page.locator('select[name="choice:alpha"]').selectOption("update");
  await page.getByRole("button", { name: "确认导入" }).click();
  await page.locator("#suite-import-form").waitFor({ state: "detached" });
  assert.equal(await page.locator(".suite-table tbody tr").count(), 3);
  const updated = (await (await fetch(`${app.url}api/v1/config`)).json()).config;
  assert.equal(updated.bindings.alpha.name, "Alpha");
  const route = updated.routes[updated.virtualProviders.cabletidy_alpha.route];
  assert.equal(updated.upstreams[route.backends[0].upstream].secretConfigured, true);
  // Invalid files show local feedback and do not change persisted suites.
  await page.getByRole("button", { name: "导入配置", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from("invalid") });
  await page.getByRole("button", { name: "预览导入" }).click();
  await page.getByText("配置套装文件不是有效的 JSON。", { exact: true }).waitFor();
  assert.equal(await page.locator(".suite-table tbody tr").count(), 3);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "导出配置", exact: true }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "transfer controls should fit a mobile viewport");
  assert.deepEqual(errors, []);
  console.log("Configuration transfer browser checks passed (download, selection, preview, import, errors, mobile).");
} finally {
  await browser?.close();
  await app?.close();
  await fs.rm(home, { recursive: true, force: true });
}
