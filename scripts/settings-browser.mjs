import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApplication } from "../test/helpers/native-app.mjs";
import { getPaths, normalizeConfig } from "../test/helpers/native.mjs";
import { catalogFixture, namedCodexConfigFixture } from "../test/helpers/codex-fixture.mjs";

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
  const auditForm = page.locator("#audit-settings-form");
  const protectionForm = page.locator("#protection-settings-form");
  const auditSave = auditForm.getByRole("button", { name: "保存设置", exact: true });
  const persisted = async () => (await (await fetch(`${app.url}api/v1/config`)).json()).config;
  const commit = async audit => {
    const config = await persisted();
    config.audit = audit;
    const response = await fetch(`${app.url}api/v1/config/commit`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: config.revision, config }),
    });
    assert.equal(response.status, 200);
  };
  const refresh = async () => {
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("#refresh-button").disabled);
  };
  const save = async audit => {
    await auditSave.click();
    await page.waitForFunction(() => !document.querySelector('#audit-settings-form button[type="submit"]').disabled);
    assert.deepEqual((await persisted()).audit, audit);
  };
  const initial = await persisted();
  const cables = normalizeConfig(namedCodexConfigFixture({ alpha: "Alpha", beta: "Beta", gamma: "一条名称很长的线路，用于验证手机上名称能够正常换行而不超出屏幕" }));
  Object.assign(initial, { upstreams: cables.upstreams, routes: cables.routes, virtualProviders: cables.virtualProviders, cables: cables.cables });
  initial.virtualProviders.cabletidy_alpha.credentialProtection = true;
  initial.virtualProviders.cabletidy_beta.credentialProtection = false;
  initial.virtualProviders.cabletidy_gamma.enabled = false;
  const seeded = await fetch(`${app.url}api/v1/config/commit`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: initial.revision, config: initial }),
  });
  assert.equal(seeded.status, 200, await seeded.text());
  await page.goto(app.url);
  await page.waitForFunction(() => document.querySelector("#rail-status").textContent === "服务运行中");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  assert.equal(await page.locator("#page-title").textContent(), "设置");
  assert.equal(await page.locator('[data-page="settings"].nav-item').getAttribute("aria-current"), "page");
  assert.equal(await page.locator(".nav-item.is-active").count(), 1);
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).inputValue(), "30");
  assert.equal(await page.getByLabel("存储上限（MiB）", { exact: true }).inputValue(), "5120");
  assert.equal(await page.locator("#audit-settings-cleanup").isVisible(), false);
  const protectionEnabled = protectionForm.getByRole("checkbox", { name: "启用凭据保护", exact: true });
  const protectionAll = protectionForm.getByRole("checkbox", { name: "全选线路", exact: true });
  const protectionTtl = protectionForm.getByLabel("会话闲置有效期数值", { exact: true });
  const protectionUnit = protectionForm.getByLabel("会话闲置有效期单位", { exact: true });
  const setProtectionTtl = async (value, unit = "seconds") => {
    await protectionUnit.selectOption(unit);
    await protectionTtl.fill(value);
  };
  const checkProtectionTtl = async seconds => {
    const units = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
    assert.equal(Number(await protectionTtl.inputValue()) * units[await protectionUnit.inputValue()], seconds);
  };
  const line = id => protectionForm.locator(`[data-protection-cable="${id}"]`);
  const checkLines = async expected => {
    assert.equal(await protectionForm.locator("[data-protection-cable]").count(), 3);
    for (const id of ["alpha", "beta", "gamma"]) assert.equal(await line(id).isChecked(), expected.includes(id), id);
    assert.equal(await protectionForm.locator("[data-protection-count]").textContent(), `已选 ${expected.length} / 3 条`);
  };
  const saveProtection = async protection => {
    await protectionForm.getByRole("button", { name: "保存设置", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#protection-settings-form button[type="submit"]').disabled);
    assert.deepEqual((await persisted()).credentialProtection, protection);
    const disk = JSON.parse(await fs.readFile(getPaths(home).config, "utf8"));
    assert.deepEqual(disk.credentialProtection, protection);
    assert.deepEqual(disk.virtualProviders, (await persisted()).virtualProviders);
  };
  assert.equal(await protectionEnabled.isChecked(), false);
  await checkProtectionTtl(3600);
  assert.equal(await protectionTtl.inputValue(), "1");
  assert.equal(await protectionUnit.inputValue(), "hours");
  await protectionUnit.selectOption("minutes");
  assert.equal(await protectionTtl.inputValue(), "60");
  await protectionUnit.selectOption("seconds");
  assert.equal(await protectionTtl.inputValue(), "3600");
  await protectionUnit.selectOption("hours");
  assert.equal(await protectionForm.locator(".protection-scope").evaluate(element => element.open), false);
  assert.equal((await protectionForm.textContent()).match(/保存后对新请求生效/g).length, 1);
  await protectionForm.getByText("保护范围说明", { exact: true }).click();
  await protectionForm.getByText("仅替换模型上下文中识别到的凭据。连接上游的身份认证仍使用真实凭据，本地审计记录保留凭据原文。", { exact: true }).waitFor();
  await protectionForm.getByText("保护范围说明", { exact: true }).click();
  await checkLines(["alpha", "gamma"]);
  assert.equal(await protectionAll.isDisabled(), true);
  for (const id of ["alpha", "beta", "gamma"]) assert.equal(await line(id).isDisabled(), true);
  await protectionEnabled.check();
  await checkLines(["alpha", "gamma"]);
  assert.equal(await protectionAll.isDisabled(), false);
  assert.equal(await protectionAll.evaluate(input => input.indeterminate), true);
  await protectionAll.check();
  await checkLines(["alpha", "beta", "gamma"]);
  assert.equal(await protectionAll.isChecked(), true);
  assert.equal(await protectionAll.evaluate(input => input.indeterminate), false);
  await line("beta").uncheck();
  assert.equal(await protectionEnabled.isChecked(), true);
  assert.equal(await protectionAll.isChecked(), false);
  assert.equal(await protectionAll.evaluate(input => input.indeterminate), true);
  await setProtectionTtl("60");
  const revision = (await persisted()).revision;
  await saveProtection({ enabled: true, mappingTtlSeconds: 60 });
  assert.equal((await persisted()).revision, revision + 1, "global, cable selection and TTL use one commit");
  assert.equal((await persisted()).virtualProviders.cabletidy_beta.credentialProtection, false);
  await page.reload();
  await protectionEnabled.waitFor();
  assert.equal(await protectionEnabled.isChecked(), true);
  await checkProtectionTtl(60);
  await checkLines(["alpha", "gamma"]);
  await line("beta").check();
  await saveProtection({ enabled: true, mappingTtlSeconds: 60 });
  assert.equal((await persisted()).virtualProviders.cabletidy_beta.credentialProtection, true);
  await protectionAll.uncheck();
  await checkLines([]);
  assert.equal(await protectionAll.evaluate(input => input.indeterminate), false);
  await line("beta").check();
  await saveProtection({ enabled: true, mappingTtlSeconds: 60 });
  await protectionEnabled.uncheck();
  await checkLines(["beta"]);
  assert.equal(await protectionAll.isDisabled(), true);
  for (const id of ["alpha", "beta", "gamma"]) assert.equal(await line(id).isDisabled(), true);
  await saveProtection({ enabled: false, mappingTtlSeconds: 60 });
  await refresh();
  await checkLines(["beta"]);
  await page.reload();
  await protectionEnabled.waitFor();
  await checkLines(["beta"]);
  const retainedUrl = app.url;
  const retainedPort = Number(new URL(retainedUrl).port);
  await app.close();
  app = await createApplication({ paths: getPaths(home), preferredPort: retainedPort, loadCodexCatalog: async () => catalogFixture() });
  assert.equal(app.url, retainedUrl);
  await page.reload();
  await protectionEnabled.waitFor();
  assert.equal(await protectionEnabled.isChecked(), false);
  await checkProtectionTtl(60);
  await checkLines(["beta"]);
  assert.equal(await line("beta").isDisabled(), true);
  assert.equal(await protectionAll.isDisabled(), true);
  await protectionEnabled.check();
  await checkLines(["beta"]);
  await protectionAll.check();
  await protectionAll.uncheck();
  await checkLines([]);
  await protectionEnabled.uncheck();
  await setProtectionTtl("3600");
  await saveProtection({ enabled: false, mappingTtlSeconds: 3600 });
  await refresh();
  assert.equal(await protectionEnabled.isChecked(), false);
  await checkProtectionTtl(3600);
  await checkLines([]);
  await setProtectionTtl("59");
  assert.equal(await protectionTtl.evaluate(input => input.checkValidity()), false);
  await setProtectionTtl("3600");

  for (const [value, unit, seconds] of [["90", "seconds", 90], ["1.5", "minutes", 90], ["0.5", "hours", 1800], ["2", "days", 172800]]) {
    await setProtectionTtl(value, unit);
    await saveProtection({ enabled: false, mappingTtlSeconds: seconds });
    await page.reload();
    await protectionEnabled.waitFor();
    await checkProtectionTtl(seconds);
  }
  await setProtectionTtl("61");
  await protectionUnit.selectOption("hours");
  assert.equal(await protectionTtl.evaluate(input => input.checkValidity()), true);
  await saveProtection({ enabled: false, mappingTtlSeconds: 61 });
  await setProtectionTtl("1.01");
  assert.equal(await protectionTtl.evaluate(input => input.checkValidity()), false);
  await setProtectionTtl("3600");
  await saveProtection({ enabled: false, mappingTtlSeconds: 3600 });

  // An unrelated settings save retains the protection draft; refresh merges a remote TTL.
  await protectionEnabled.check();
  await line("alpha").check();
  await save({ retentionDays: 30, budgetBytes: 5 * 1024 ** 3 });
  await checkLines(["alpha"]);
  const remoteTtl = await persisted();
  remoteTtl.credentialProtection.mappingTtlSeconds = 120;
  let remoteSave = await fetch(`${app.url}api/v1/config/commit`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: remoteTtl.revision, config: remoteTtl }),
  });
  assert.equal(remoteSave.status, 200);
  await refresh();
  await checkLines(["alpha"]);
  await checkProtectionTtl(120);
  await saveProtection({ enabled: true, mappingTtlSeconds: 120 });

  // A changed cable set must block the old draft until the latest form is loaded.
  await line("alpha").uncheck();
  await protectionEnabled.uncheck();
  const remoteLines = await persisted();
  delete remoteLines.cables.gamma;
  remoteSave = await fetch(`${app.url}api/v1/config/commit`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: remoteLines.revision, config: remoteLines }),
  });
  assert.equal(remoteSave.status, 200);
  await refresh();
  await protectionForm.getByRole("alert").waitFor();
  await checkLines([]);
  await protectionForm.getByRole("button", { name: "保存设置", exact: true }).click();
  assert.equal((await persisted()).virtualProviders.cabletidy_alpha.credentialProtection, true);
  page.once("dialog", dialog => dialog.accept());
  await protectionForm.getByRole("button", { name: "加载最新配置", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-protection-cable]").length === 2);
  const restoredLines = await persisted();
  restoredLines.cables.gamma = cables.cables.gamma;
  remoteSave = await fetch(`${app.url}api/v1/config/commit`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: restoredLines.revision, config: restoredLines }),
  });
  assert.equal(remoteSave.status, 200);
  await refresh();
  await checkLines(["alpha"]);
  await line("alpha").uncheck();
  await protectionEnabled.uncheck();
  await setProtectionTtl("3600");
  await saveProtection({ enabled: false, mappingTtlSeconds: 3600 });

  const temporary = page.getByLabel("服务器目录", { exact: true });
  assert.equal(await temporary.inputValue(), "");
  const customTemporary = path.join(home, "custom temporary files");
  await temporary.fill(customTemporary);
  await page.getByRole("button", { name: "保存临时目录", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#temporary-settings-form button[type="submit"]').disabled);
  assert.equal((await persisted()).temporaryDirectory, customTemporary);
  assert.match(await page.locator("#temporary-settings-form").textContent(), /重启 CableTidy 后生效/);
  assert.equal((await persisted()).audit.retentionDays, 30);
  await temporary.fill("relative/path");
  await page.getByRole("button", { name: "保存临时目录", exact: true }).click();
  await page.locator("#temporary-settings-form [data-form-feedback]").waitFor();
  assert.equal(await temporary.inputValue(), "relative/path");
  assert.equal((await persisted()).temporaryDirectory, customTemporary);
  await temporary.fill("");
  await page.getByRole("button", { name: "保存临时目录", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#temporary-settings-form button[type="submit"]').disabled);
  assert.equal((await persisted()).temporaryDirectory, null);
  await page.mouse.move(1250, 700);
  await page.screenshot({ path: path.join(output, "settings-desktop.png"), fullPage: true, animations: "disabled" });

  await page.getByLabel("保存周期不设上限", { exact: true }).check();
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).isDisabled(), true);
  await page.getByLabel("存储不设上限", { exact: true }).check();
  assert.equal(await page.getByLabel("存储上限（MiB）", { exact: true }).isDisabled(), true);
  await save({ retentionDays: null, budgetBytes: null });
  await page.reload();
  await auditSave.waitFor();
  assert.equal(await page.getByLabel("保存周期不设上限", { exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel("存储不设上限", { exact: true }).isChecked(), true);
  await page.getByRole("button", { name: "审计记录", exact: true }).click();
  await page.getByText("审计存储正常", { exact: false }).waitFor();
  assert.match(await page.locator("#page-content").textContent(), /保存周期不设上限/);
  assert.match(await page.locator("#page-content").textContent(), /存储不设上限/);
  await page.goBack();
  await auditSave.waitFor();

  await page.getByLabel("保存周期不设上限", { exact: true }).uncheck();
  await page.getByLabel("保存周期（天）", { exact: true }).fill("7");
  assert.equal(await page.locator("#audit-settings-cleanup").isVisible(), true);
  await save({ retentionDays: 7, budgetBytes: null });
  await page.getByLabel("存储不设上限", { exact: true }).uncheck();
  assert.equal(await page.getByLabel("存储上限（MiB）", { exact: true }).inputValue(), "5120");
  await save({ retentionDays: 7, budgetBytes: 5 * 1024 ** 3 });
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
  await auditSave.click();
  await page.getByRole("alert").filter({ hasText: "配置已在其他窗口变更" }).waitFor();
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).inputValue(), "14");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[name="budgetMiB"]').value === "256");
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).inputValue(), "14");
  await save({ retentionDays: 14, budgetBytes: 256 * 1048576 });

  await page.getByLabel("保存周期（天）", { exact: true }).fill("0");
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).evaluate(input => input.checkValidity()), false);
  await page.getByLabel("保存周期（天）", { exact: true }).fill("14");
  const budgetInput = page.getByLabel("存储上限（MiB）", { exact: true });
  assert.equal(await budgetInput.getAttribute("min"), "16");
  await budgetInput.fill("15.9");
  assert.equal(await budgetInput.evaluate(input => input.checkValidity()), false);
  await budgetInput.fill("256");
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await auditSave.isVisible(), true);
  const saveBounds = await auditSave.boundingBox();
  assert.ok(saveBounds.y + saveBounds.height <= 812, "Save stays within the mobile viewport");
  await page.locator(".toast").last().waitFor({ state: "hidden", timeout: 10000 });
  await page.screenshot({ path: path.join(output, "settings-mobile.png"), fullPage: true });
  await protectionEnabled.check();
  await checkLines([]);
  await protectionAll.check();
  await checkLines(["alpha", "beta", "gamma"]);
  await line("beta").uncheck();
  await saveProtection({ enabled: true, mappingTtlSeconds: 3600 });
  assert.equal(await protectionEnabled.isChecked(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const ttlTitle = await protectionForm.locator('label[for="protection-ttl"]').boundingBox();
  const ttlBounds = await protectionTtl.boundingBox();
  const unitBounds = await protectionUnit.boundingBox();
  assert.ok(ttlTitle.x < ttlBounds.x && ttlBounds.x < unitBounds.x);
  assert.ok(Math.abs(ttlTitle.y + ttlTitle.height / 2 - ttlBounds.y - ttlBounds.height / 2) < 2, "TTL title and controls stay on one line on mobile");
  await page.locator(".toast").last().waitFor({ state: "hidden", timeout: 10000 });
  await protectionForm.locator("..").screenshot({ path: path.join(output, "protection-mobile.png") });
  await checkLines(["alpha", "gamma"]);
  await protectionEnabled.uncheck();
  await saveProtection({ enabled: false, mappingTtlSeconds: 3600 });
  await page.locator(".toast").last().waitFor({ state: "hidden", timeout: 10000 });
  await protectionForm.locator("..").screenshot({ path: path.join(output, "protection-disabled-mobile.png") });

  const defaults = { retentionDays: 14, budgetBytes: 256 * 1048576 };
  for (const [key, label, toggle, unit, finite, local, remote] of [
    ["retentionDays", "保存周期（天）", "保存周期不设上限", 1, 14, 7, 90],
    ["budgetBytes", "存储上限（MiB）", "存储不设上限", 1048576, 256, 64, 128],
  ]) {
    for (const [baseValue, localValue, remoteValue] of [[finite, local, null], [finite, null, remote], [null, local, remote]]) {
      await commit({ ...defaults, [key]: baseValue === null ? null : baseValue * unit });
      await refresh();
      const input = page.getByLabel(label, { exact: true });
      const unlimited = page.getByLabel(toggle, { exact: true });
      await unlimited.setChecked(localValue === null);
      if (localValue !== null) await input.fill(String(localValue));
      const draft = await input.inputValue();
      await commit({ ...defaults, [key]: remoteValue === null ? null : remoteValue * unit });
      await auditSave.click();
      await page.getByRole("alert").filter({ hasText: "配置已在其他窗口变更" }).waitFor();
      await refresh();
      await page.getByRole("alert").filter({ hasText: "冲突，已暂停保存" }).waitFor();
      assert.equal(await input.inputValue(), draft);
      assert.equal(await unlimited.isChecked(), localValue === null);
      const revision = (await persisted()).revision;
      await auditSave.click();
      assert.equal((await persisted()).revision, revision, "Conflicting settings cannot be submitted");
      page.once("dialog", dialog => dialog.accept());
      await page.getByRole("button", { name: "加载最新配置", exact: true }).click();
      assert.equal(await unlimited.isChecked(), remoteValue === null);
    }

    await commit(defaults);
    await refresh();
    await page.getByLabel(toggle, { exact: true }).check();
    const agreed = { ...defaults, [key]: null };
    await commit(agreed);
    await auditSave.click();
    await page.getByRole("alert").filter({ hasText: "配置已在其他窗口变更" }).waitFor();
    await refresh();
    assert.equal(await page.getByRole("alert").count(), 0, "Matching unlimited edits merge without a conflict");
    await save(agreed);
  }

  await commit(defaults);
  await refresh();
  await page.getByRole("button", { name: "线路", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const historyNavigation = async (direction, accept) => {
    const handled = new Promise(resolve => page.once("dialog", async dialog => {
      assert.match(dialog.message(), /有未保存的修改/);
      if (accept) await dialog.accept();
      else await dialog.dismiss();
      resolve();
    }));
    await page.evaluate(direction => window.history[direction](), direction);
    await handled;
    await page.waitForURL(accept ? (direction === "back" ? app.url : `${app.url}#security`) : `${app.url}#settings`);
  };
  await page.getByLabel("保存周期（天）", { exact: true }).fill("7");
  await historyNavigation("back", false);
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).inputValue(), "7");
  await historyNavigation("back", true);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).inputValue(), "14");
  await page.getByRole("button", { name: "审计记录", exact: true }).click();
  await page.goBack();
  await page.getByLabel("保存周期（天）", { exact: true }).fill("7");
  await historyNavigation("forward", false);
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).inputValue(), "7");
  await historyNavigation("forward", true);
  await page.goBack();
  assert.equal(await page.getByLabel("保存周期（天）", { exact: true }).inputValue(), "14");
  assert.deepEqual(errors, []);
  console.log("Settings browser checks passed: centralized credential protection, bulk/individual cable selection, one-commit persistence, reload/restart, finite/unlimited combinations, semantic conflicts, back/forward draft protection, validation, desktop and mobile.");
  console.log(`Screenshots: ${output}`);
} finally {
  await browser?.close();
  await app?.close();
  await fs.rm(home, { recursive: true, force: true });
}
