import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createApplication} from '../test/helpers/native-app.mjs';
import {getPaths,normalizeConfig,publicCodexCatalog,planCodexCatalog} from '../test/helpers/native.mjs';
import {catalogFixture} from '../test/helpers/codex-fixture.mjs';

const home=await fs.mkdtemp(path.join(os.tmpdir(),'cabletidy-availability-'));
let app,browser;
try {
  const snapshot=catalogFixture();
  const prompt=publicCodexCatalog(snapshot).models.find(m=>m.id==='gpt-5.6-sol').prompt;
  const model={identity:'deepseek-v4-pro',interfaces:['responses'],contextWindow:128000,inputModalities:['text'],interfaceCapabilities:{responses:{toolForms:['function','custom'],supportsStreaming:true}}};
  const models={},bindings={};
  for (const id of ['current','streaming','tools','prompt','disabled','healthy']) {
    models[id]=structuredClone(model);
    bindings[id]={sources:[{supplierId:'vendor',modelId:id,interfaceId:'responses'}],promptStrategy:'selected',promptModel:'gpt-5.6-sol',promptHash:prompt.hash};
  }
  models.streaming.interfaceCapabilities.responses.supportsStreaming=null;
  models.tools.interfaceCapabilities.responses.toolForms=['function'];
  bindings.prompt.promptHash='outdated';
  models.disabled.enabled=false;
  const seed=normalizeConfig({suppliers:{vendor:{name:'Vendor',interfaces:{responses:{protocol:'openai.responses',baseUrl:'https://example.invalid',supportsStreaming:true}},models}},cables:{work:{id:'work',target:'codex',virtualProvider:'cabletidy_work',managedModels:true,suppliers:['vendor'],models:bindings,defaultModel:'current'}}});
  const paths=getPaths(home);
  await fs.writeFile(paths.config,JSON.stringify(seed));
  app=await createApplication({paths,ephemeralPort:true,loadCodexCatalog:async()=>snapshot});
  const post=async(endpoint,body)=>fetch(`${app.url}api/v1/${endpoint}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const config=async()=> (await (await fetch(`${app.url}api/v1/config`)).json()).config;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('dialog',dialog=>dialog.accept());
  await page.goto(app.url);
  await page.getByRole('button',{name:'work',exact:true}).click();
  const row=id=>page.locator(`[data-inventory-binding="${id}"]`);
  const ready=async()=>page.waitForFunction(()=>[...document.querySelectorAll('[data-inventory-binding-issue]')].every(e=>!e.textContent.includes('正在检查')));
  await ready();
  for (const id of Object.keys(bindings)) {
    const preview=await (await post('codex/model-preview',{clientModelId:id,binding:bindings[id]})).json();
    assert.equal(await row(id).locator('[data-inventory-binding-issue]').textContent(),preview.issues.join('；'));
    assert.equal(preview.available,['current','healthy'].includes(id),id);
    if (id!=='current') assert.equal(await row(id).getByRole('checkbox').isDisabled(),!preview.available,id);
    const candidate=structuredClone(seed);
    candidate.cables.work.models={[id]:bindings[id]};
    candidate.cables.work.defaultModel=id;
    const normalized=normalizeConfig(candidate);
    if (preview.available) planCodexCatalog(normalized,normalized.virtualProviders.cabletidy_work,snapshot);
    else assert.throws(()=>planCodexCatalog(normalized,normalized.virtualProviders.cabletidy_work,snapshot),undefined,id);
    if (!preview.available) {
      await row(id).getByRole('button',{name:id,exact:true}).click();
      await page.locator('#inventory-model-form [data-inventory-issues]').waitFor();
      assert.deepEqual(await page.locator('#inventory-model-form [data-inventory-issues] li').allTextContents(),preview.issues);
      await page.locator('#inventory-model-dialog').getByRole('button',{name:'取消',exact:true}).click();
    }
  }
  // A response from a detached list cannot overwrite the freshly rendered list.
  let releaseOld, intercepted;
  const oldRequest=new Promise(resolve=>{intercepted=resolve;});
  const release=new Promise(resolve=>{releaseOld=resolve;});
  let held=false;
  await page.route('**/api/v1/codex/model-preview',async route=>{
    if (!held && route.request().postDataJSON().clientModelId==='healthy') {
      held=true;intercepted();await release;
      await route.fulfill({json:{available:false,issues:['obsolete result']}});
    } else await route.continue();
  });
  await page.getByRole('button',{name:'返回列表',exact:true}).click();
  await page.getByRole('button',{name:'work',exact:true}).click();
  await oldRequest;
  assert.equal(await row('healthy').getByRole('checkbox').isDisabled(),true);
  await page.getByRole('button',{name:'返回列表',exact:true}).click();
  await page.getByRole('button',{name:'work',exact:true}).click();
  await ready();
  const oldResponse=page.waitForResponse(async response=>response.url().endsWith('/codex/model-preview') && (await response.json()).issues?.includes('obsolete result'));
  releaseOld();await oldResponse;
  await page.unrouteAll({behavior:'wait'});
  assert.equal(await row('healthy').locator('[data-inventory-binding-issue]').textContent(),'');
  assert.equal(await row('healthy').getByRole('checkbox').isDisabled(),false);
  // A fresh server check must reject a formerly available default choice.
  let c=await config();
  c.suppliers.vendor.models.healthy.enabled=false;
  let response=await post('config/commit',{baseRevision:c.revision,config:c});
  assert.equal(response.status,200,await response.text());
  await row('healthy').getByRole('checkbox').click();
  await page.locator('#inventory-cable-form [data-form-feedback]').waitFor();
  assert.equal((await config()).cables.work.defaultModel,'current');
  await ready();
  assert.equal(await row('healthy').getByRole('checkbox').isDisabled(),true);
  // Load the new revision before saving a deletion.
  await page.reload();
  await page.getByRole('button',{name:'work',exact:true}).click();
  await ready();
  // Deleting the current default rechecks all remaining candidates; none qualify.
  await row('current').getByRole('button',{name:'移除',exact:true}).click();
  await row('current').waitFor({state:'detached'});
  assert.equal((await config()).cables.work.defaultModel ?? '','');
  assert.deepEqual(errors,[]);
  console.log('Inventory availability browser checks passed: list/editor/application parity, unknown streaming, missing tools, changed prompts, disabled sources, and fresh default selection.');
} finally {
  await browser?.close();await app?.close();await fs.rm(home,{recursive:true,force:true});
}
