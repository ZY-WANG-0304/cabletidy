import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createApplication } from '../test/helpers/native-app.mjs';
import { getPaths, normalizeConfig } from '../test/helpers/native.mjs';
import { catalogFixture, codexConfigFixture } from '../test/helpers/codex-fixture.mjs';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cabletidy-protection-browser-'));
const output = path.resolve(process.env.CABLETIDY_BROWSER_OUTPUT || '.cabletidy-debug/credential-protection');
await fs.mkdir(output, { recursive: true });
const key = 'sk-proj-Q8mV4rN2yLp7xZ9wK3cF6tD1';
const calls = [], errors = [];
const upstream = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); calls.push(body);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({type:'response', status:'completed', model:body.model, output:[{type:'message',role:'assistant',content:[{type:'output_text',text:body.input}]}]}));
});
let app, browser;
try {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  app = await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalogFixture()});
  const config = normalizeConfig(codexConfigFixture());
  config.web.port = Number(new URL(app.url).port);
  config.upstreams.relay.baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  config.credentialProtection = {enabled:true,mappingTtlSeconds:3600};
  const post = (route, body, headers={}) => fetch(`${app.url}${route}`, {method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  let response = await post('api/v1/config/commit',{config,baseRevision:0,upstreamSecrets:{relay:'upstream-auth-browser'}});
  assert.equal(response.status,200,await response.text());
  for (let i=0;i<2;i++) {
    response = await post('relay/v1/responses',{model:'gpt-5.5',input:`请复核这段凭据：${key}，回复时保持原文。🙂`},{'session-id':'protection-browser'});
    assert.equal(response.status,200);assert.ok((await response.text()).includes(key));
  }
  let records;
  for (let i=0;i<200;i++) {
    records=(await(await fetch(`${app.url}api/v1/security/audit?kind=request`)).json()).items;
    if (records?.length===2 && records.every(r=>r.inspectionProgress?.active===false)) break;
    await delay(25);
  }
  assert.equal(records.length,2);assert.equal(calls[0].input,calls[1].input);assert.ok(!JSON.stringify(calls).includes(key));
  browser=await chromium.launch({headless:true,...(process.env.CABLETIDY_BROWSER_EXECUTABLE?{executablePath:process.env.CABLETIDY_BROWSER_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${app.url}#security/session/${records[0].sessionKey}`);
  await page.locator('.trace-inspector-heading').waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.trace-segment[data-credential-protected] .protection-key').length===2);
  assert.deepEqual(await page.locator('.trace-tabs button').allTextContents(),['概览',`风险 ${records[0].findingCount}`,'凭据保护','请求内容','响应内容','原始内容']);
  await page.locator('[data-tab="protection"]').click();
  await page.locator('.protection-mapping').waitFor();
  assert.ok((await page.locator('.protection-mapping').textContent()).includes(key));
  assert.ok((await page.locator('.credential-protection').textContent()).includes('3600'));
  await page.screenshot({path:path.join(output,'desktop-protection.png'),fullPage:true});
  for (const side of ['request','response']) {
    await page.locator('[data-tab="protection"]').click();
    await page.locator(`[data-action="security-protection-source"][data-side="${side}"]`).click();
    await page.locator('.trace-content-timeline .security-protection-hit').first().waitFor();
    assert.ok((await page.locator('.trace-content-timeline .security-protection-hit').allTextContents()).includes(key));
    assert.ok(!(await page.locator('.trace-content-timeline').textContent()).includes('CTSEC_v1_'));
  }
  await page.locator('[data-tab="body"]').click();
  await page.locator('.security-body-content .security-protection-hit').first().waitFor();
  assert.ok((await page.locator('.security-body-content').textContent()).includes(key));
  assert.ok(!(await page.locator('.security-body-content').textContent()).includes('CTSEC_v1_'));
  await page.screenshot({path:path.join(output,'desktop-original.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.locator('[data-tab="protection"]').click();
  await page.screenshot({path:path.join(output,'mobile-protection.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.locator('[data-tab="request"]').click();
  await page.locator('.trace-content-timeline .security-protection-hit').first().waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.screenshot({path:path.join(output,'mobile-request.png'),fullPage:true});
  await page.goto(`${app.url}#settings`);
  await page.locator('#protection-enabled').waitFor();
  assert.equal(await page.locator('#protection-enabled').isChecked(),true);
  assert.equal(await page.locator('#protection-ttl').inputValue(),'3600');
  assert.deepEqual(errors,[]);
  console.log(`Credential protection browser checks passed; screenshots: ${output}`);
} finally {
  await browser?.close();await app?.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));await fs.rm(home,{recursive:true,force:true});
}
