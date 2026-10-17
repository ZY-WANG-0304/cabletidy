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
  for (let i=0;i<3;i++) {
    response = await post('relay/v1/responses',{model:'gpt-5.5',input:i === 2 ? "本轮无需凭据" : `请复核这段凭据：${key}，再确认 ${key}，回复时保持原文。🙂`, ...(i === 0 ? {metadata:{api_key:"unused-browser-token"}} : {})},{'session-id':'protection-browser'});
    assert.equal(response.status,200);assert.equal((await response.text()).includes(key), i < 2);
  }
  let records;
  for (let i=0;i<200;i++) {
    records=(await(await fetch(`${app.url}api/v1/security/audit?kind=request`)).json()).items;
    if (records?.length===3 && records.every(r=>r.inspectionProgress?.active===false)) break;
    await delay(25);
  }
  assert.equal(records.length,3);assert.equal(calls[0].input,calls[1].input);assert.ok(!JSON.stringify(calls).includes(key));
  browser=await chromium.launch({headless:true,...(process.env.CABLETIDY_BROWSER_EXECUTABLE?{executablePath:process.env.CABLETIDY_BROWSER_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${app.url}#security/session/${records[0].sessionKey}`);
  await page.locator('.trace-inspector-heading').waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.trace-segment[data-credential-protected] .protection-key').length===2);
  assert.deepEqual(await page.locator('.trace-tabs button').allTextContents(),['概览',`风险 ${records.at(-1).findingCount}`,'凭据保护','请求内容','响应内容','原始内容']);
  // Select the second round: one used credential, one unused session mapping.
  await page.locator('.trace-event-row').nth(1).click();
  await page.locator('[data-tab="protection"]').click();
  await page.locator('.protection-mapping').waitFor();
  assert.equal(await page.locator('.protection-mapping').count(),1);
  assert.match(await page.locator('.protection-counts').textContent(), /涉及 1 个凭据 · 请求替换 2 次 · 响应还原 2 次/);
  assert.equal(await page.locator('.protection-history').getAttribute('open'),null);
  assert.equal(await page.locator('.protection-mapping-details').first().getAttribute('open'),null);
  await page.locator('.protection-history > summary').click();
  assert.match(await page.locator('.protection-history-item').textContent(),/unused-browser-token/);
  await page.locator('.protection-history > summary').click();
  await page.locator('.protection-mapping .protection-mapping-details > summary').click();
  assert.match(await page.locator('.protection-mapping-details[open]').textContent(),/CTSEC_v1_|本次续期到期时间/);
  await page.locator('.protection-mapping .protection-mapping-details > summary').click();
  assert.ok((await page.locator('.protection-mapping').textContent()).includes(key));
  assert.ok((await page.locator('.credential-protection').textContent()).includes('1 小时'));
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.locator('.protection-copy').click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),key);
  await page.screenshot({path:path.join(output,'desktop-protection.png'),fullPage:true});
  for (const side of ['request','response']) {
    await page.locator('[data-tab="protection"]').click();
    await page.locator(`[data-action="security-protection-source"][data-side="${side}"]`).click();
    const dialog=page.locator('#protection-source-dialog');
    await dialog.locator('.security-body-hit').first().waitFor();
    assert.match(await dialog.locator('.protection-source-controls').textContent(),/1 \/ 2 处/);
    assert.equal(await page.locator('[data-tab="protection"]').getAttribute('aria-pressed'),'true');
    assert.equal(await dialog.locator('.security-body-hit').first().textContent(),key);
    assert.ok(!(await dialog.locator('.protection-source-snippet').textContent()).includes('CTSEC_v1_'));
    if(side==='request') {
      const styles=await dialog.locator('.security-protection-hit.security-risk-hit.security-body-hit').first().evaluate(el=>{
        const css=getComputedStyle(el);return {background:css.backgroundImage,line:css.boxShadow,outline:css.outlineColor};
      });
      assert.match(styles.background,/linear-gradient/);assert.ok(styles.line.includes('64, 134, 120'));assert.equal(styles.outline,'rgb(223, 139, 50)');
    }
    const firstLocation=await dialog.locator('.protection-source-location').textContent();
    await dialog.locator('[data-step="1"]').click();
    await page.waitForFunction(()=>document.querySelector('.protection-source-controls')?.textContent.includes('2 / 2 处') && !!document.querySelector('.protection-source-location'));
    assert.notEqual(await dialog.locator('.protection-source-location').textContent(),firstLocation);
    assert.equal(await page.evaluate(()=>document.querySelector('#protection-source-dialog').contains(document.activeElement)),true);
    await dialog.locator('[data-step="-1"]').click();
    await dialog.locator('.security-body-hit').first().waitFor();
    await page.screenshot({path:path.join(output,`desktop-modal-${side}.png`),fullPage:true});
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
    await page.locator(`[data-tab="${side}"]`).click();
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
  await page.locator('[data-tab="protection"]').click();
  await page.locator('[data-action="security-protection-source"][data-side="request"]').click();
  await page.locator('#protection-source-dialog .security-body-hit').first().waitFor();
  assert.equal(await page.evaluate(()=>document.querySelector('#protection-source-dialog').scrollWidth <= document.querySelector('#protection-source-dialog').clientWidth + 1),true);
  await page.screenshot({path:path.join(output,'mobile-modal.png'),fullPage:true});
  await page.locator('[data-action="security-protection-close"]').click();
  await page.locator('.trace-event-row').nth(2).click();
  await page.locator('.protection-empty').waitFor();
  assert.match(await page.locator('.protection-empty').textContent(),/已启用，本次没有替换或还原/);
  assert.match(await page.locator('.protection-history > summary').textContent(),/2 条/);
  const observed = new Set(records.map(record => record.id));
  const inspectNext = async (body, status, session) => {
    const response = await post('relay/v1/responses',{model:'gpt-5.5',...body},{'session-id':session});
    assert.equal(response.status,status);await response.text();
    let record;
    for(let i=0;i<200;i++) {
      const rows=(await(await fetch(`${app.url}api/v1/security/audit?kind=request`)).json()).items;
      record=rows.find(r=>!observed.has(r.id) && r.inspectionProgress?.active===false);
      if(record)break;await delay(25);
    }
    assert.ok(record);observed.add(record.id);
    await page.goto(`${app.url}#security/session/${record.sessionKey}`);
    await page.locator('.trace-inspector-heading').waitFor();
    await page.locator('[data-tab="protection"]').click();
    await page.locator('.credential-decisions').waitFor();
    return record;
  };
  await inspectNext({input:String.raw`const password = "unknown\x21";`},200,'browser-weak');
  await page.locator('.credential-decisions summary').click();
  assert.match(await page.locator('.credential-decision').textContent(),/低置信度[\s\S]*未替换/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.locator('[data-tab="risks"]').click();
  await page.locator('.credential-finding-facts').first().waitFor();
  assert.match((await page.locator('.credential-finding-facts').allTextContents()).join('\n'),/候选提示[\s\S]*未替换/);
  await inspectNext({previous_response_id:key},422,'browser-blocked');
  await page.locator('.credential-decisions summary').click();
  assert.match(await page.locator('.credential-decision').textContent(),/强证据[\s\S]*未替换 · 结构中无法安全替换/);
  let latest=(await(await fetch(`${app.url}api/v1/config`)).json()).config;
  latest.credentialProtection.enabled=false;
  response=await post('api/v1/config/commit',{config:latest,baseRevision:latest.revision});assert.equal(response.status,200);await response.text();
  await inspectNext({metadata:{password:'browser-short'}},200,'browser-disabled');
  await page.locator('.credential-decisions summary').click();
  assert.match(await page.locator('.credential-decision').textContent(),/未替换 · 保护关闭/);
  await page.screenshot({path:path.join(output,'mobile-disabled-candidate.png'),fullPage:true});
  latest=(await(await fetch(`${app.url}api/v1/config`)).json()).config;latest.credentialProtection.enabled=true;
  response=await post('api/v1/config/commit',{config:latest,baseRevision:latest.revision});assert.equal(response.status,200);await response.text();
  await page.goto(`${app.url}#settings`);
  await page.locator('#protection-enabled').waitFor();
  assert.equal(await page.locator('#protection-enabled').isChecked(),true);
  assert.equal(await page.locator('#protection-ttl').inputValue(),'3600');
  assert.deepEqual(errors,[]);
  console.log(`Credential protection browser checks passed; screenshots: ${output}`);
} finally {
  await browser?.close();await app?.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));await fs.rm(home,{recursive:true,force:true});
}
