import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createApplication} from '../test/helpers/native-app.mjs';
import {getPaths, readCodexConfig} from '../test/helpers/native.mjs';
import {catalogFixture} from '../test/helpers/codex-fixture.mjs';

const home=await fs.mkdtemp(path.join(os.tmpdir(),'cabletidy-live-edit-'));
let app,browser;
try {
  const catalog=catalogFixture();
  app=await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalog});
  const config=async()=> (await (await fetch(`${app.url}api/v1/config`)).json()).config;
  const runtime=async()=> (await (await fetch(`${app.url}api/v1/runtime`)).json()).clientActivation.codex;
  const commit=async operation=>{
    const c=await config();
    const r=await fetch(`${app.url}api/v1/config/commit`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseRevision:c.revision,operation})});
    assert.equal(r.status,200,await r.text());
  };
  await commit({type:'supplier.save',supplierId:'vendor',data:{name:'Vendor',interfaces:{responses:{protocol:'openai.responses',baseUrl:'https://example.invalid'}}}});
  await commit({type:'supplier.model.save',supplierId:'vendor',data:{modelId:'wire',model:{identity:'gpt-5.5',interfaces:['responses'],interfaceCapabilities:{responses:{toolForms:['function','custom']}}}}});
  const binding={sources:[{supplierId:'vendor',modelId:'wire',interfaceId:'responses'}],promptStrategy:'selected',promptModel:'gpt-5.5'};
  for (const name of ['Work','Other']) await commit({type:'cable.inventory.create',data:{id:name.toLowerCase(),suppliers:['vendor'],models:{first:binding},defaultModel:'first'}});
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1366,height:768}});
  const errors=[],confirmations=[];let acceptUpdate=false,activeId='work';
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('dialog',async dialog=>{
    if (dialog.message().includes('现在更新 Codex 接入配置吗')) confirmations.push(dialog.message());
    if (dialog.message().includes('现在更新 Codex 接入配置吗') && !acceptUpdate) await dialog.dismiss();
    else await dialog.accept();
  });
  const main=page.locator('#inventory-cable-form');
  const editor=page.locator('#inventory-model-dialog');
  const open=async name=>{
    await page.goto(app.url);
    await page.getByRole('button',{name,exact:true}).click();
  };
  const changed=async(action,status=200)=>{
    const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/config/commit') && r.request().method()==='POST');
    await action();const r=await response;assert.equal(r.status(),status,await r.text());
    if (r.request().postDataJSON().operation.type === 'cable.inventory.rename') assert.equal(r.request().postDataJSON().operation.data.target,'codex');
    await page.waitForFunction(()=>!document.querySelector('#refresh-button').disabled);
  };
  const add=async id=>{
    await main.getByRole('button',{name:'添加模型',exact:true}).click();
    await editor.locator('[name=sourceSupplier]').selectOption('vendor');
    await editor.getByRole('combobox',{name:'上游模型',exact:true}).fill('wire');
    await editor.getByRole('listbox').getByRole('option').click();
    await editor.locator('[name=clientId]').fill(id);
  };
  const idEditor=page.locator('#inventory-id-dialog');
  const startRename=async id=>{
    await main.getByRole('button',{name:'修改',exact:true}).click();
    await idEditor.getByRole('heading',{name:'修改基本信息',exact:true}).waitFor();
    assert.equal(await idEditor.getByRole('button',{name:'确认修改',exact:true}).isDisabled(),true);
    assert.equal(await idEditor.locator('[data-inventory-id-change]').isVisible(),false);
    assert.equal(await idEditor.getByLabel('客户端',{exact:true}).isEnabled(),true);
    await idEditor.getByLabel('客户端',{exact:true}).selectOption('codex');
    await idEditor.getByLabel('线路ID',{exact:true}).fill(id);
    await idEditor.getByText(/旧接口路径立即失效/).waitFor();
    assert.match(await idEditor.locator('[data-inventory-id-endpoint]').innerText(),new RegExp('/'+id+'/v1$'));
    if (process.env.CABLETIDY_BROWSER_SCREENSHOTS) {
      await fs.mkdir(process.env.CABLETIDY_BROWSER_SCREENSHOTS,{recursive:true});
      await page.screenshot({path:path.join(process.env.CABLETIDY_BROWSER_SCREENSHOTS,`cable-id-${page.viewportSize().width}.png`)});
    }
  };
  const renameId=async id=>{
    await startRename(id);
    await changed(()=>idEditor.getByRole('button',{name:'确认修改',exact:true}).click());
  };
  const codexPath=path.join(home,'codex-client','config.toml');
  const codexFile=()=>fs.readFile(codexPath,'utf8');
  await open(activeId);
  assert.equal(await main.locator('[name=name]').count(),0);
  assert.equal(await main.locator('[name=cableId], [name=target]').count(),0);
  const basics=main.getByRole('region',{name:'基本信息',exact:true});
  await basics.getByText('线路ID',{exact:true}).waitFor();
  await basics.getByText('Codex',{exact:true}).waitFor();
  assert.equal(await basics.locator('.panel-header').getByRole('button',{name:'修改',exact:true}).count(),1);
  if (process.env.CABLETIDY_BROWSER_SCREENSHOTS) {
    await fs.mkdir(process.env.CABLETIDY_BROWSER_SCREENSHOTS,{recursive:true});
    await page.screenshot({path:path.join(process.env.CABLETIDY_BROWSER_SCREENSHOTS,'cable-basics-panel.png')});
  }
  assert.equal(await main.getByRole('button',{name:'保存线路',exact:true}).count(),0);
  assert.equal(await main.getByRole('button',{name:'创建线路',exact:true}).count(),0);
  const beforeCancel=await config();
  await startRename('discarded-id');
  await idEditor.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await idEditor.count(),0);
  assert.deepEqual(await config(),beforeCancel);
  await add('second');
  await editor.locator('[data-inventory-effective]').getByText('Codex 使用窗口',{exact:true}).waitFor();
  assert.equal(await editor.locator('[data-inventory-tools]').count(),0);
  await changed(()=>editor.getByRole('button',{name:'添加到线路',exact:true}).click());
  assert.ok((await config()).cables[activeId].models.second);
  assert.equal(confirmations.length,0);
  await assert.rejects(codexFile(),{code:'ENOENT'});

  // A failed model commit keeps the dialog and leaves the persisted line untouched.
  await main.locator('[data-action=edit-inventory-model][data-id=second]').click();
  await editor.locator('[name=displayName]').fill('Changed name');
  await page.route('**/api/v1/config/commit',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{message:'Save failed'}})}));
  await changed(()=>editor.getByRole('button',{name:'保存模型配置',exact:true}).click(),500);
  assert.equal(await editor.isVisible(),true);
  assert.equal(await editor.locator('[name=displayName]').inputValue(),'Changed name');
  assert.notEqual((await config()).cables[activeId].models.second.name,'Changed name');
  await page.unroute('**/api/v1/config/commit');
  await changed(()=>editor.getByRole('button',{name:'保存模型配置',exact:true}).click());
  assert.equal((await config()).cables[activeId].models.second.name,'Changed name');

  await page.getByRole('button',{name:'应用到 Codex',exact:true}).click();
  await page.getByText('当前激活的 Codex 配置',{exact:true}).waitFor();
  assert.equal((await runtime()).needsUpdate,false);
  // Saving a web-search-only edit keeps the ID and waits for independent application.
  const beforeSearch=await codexFile();
  await main.getByRole('button',{name:'修改',exact:true}).click();
  const search=idEditor.getByLabel('网页搜索',{exact:true});
  assert.deepEqual(await search.locator('option').evaluateAll(options=>options.map(o=>o.value)),['','cached','indexed','live','disabled']);
  await search.selectOption('disabled');
  assert.equal(await idEditor.locator('[data-inventory-id-change]').isVisible(),false);
  await changed(()=>idEditor.getByRole('button',{name:'确认修改',exact:true}).click());
  assert.equal((await config()).cables.work.webSearch,'disabled');
  assert.equal(await codexFile(),beforeSearch);
  assert.equal((await runtime()).needsUpdate,true);
  assert.equal(confirmations.length,1);
  await page.getByRole('button',{name:'应用到 Codex',exact:true}).click();
  await page.getByText('当前激活的 Codex 配置',{exact:true}).waitFor();
  assert.equal(readCodexConfig(await codexFile()).web_search,'disabled');
  confirmations.length=0;
  const before=await codexFile();
  await changed(()=>main.locator('[data-inventory-default=second]').check());
  assert.equal((await config()).cables[activeId].defaultModel,'second');
  assert.equal(await codexFile(),before);
  assert.equal(confirmations.length,1);
  assert.equal((await runtime()).needsUpdate,true);
  await page.locator('[data-inventory-activation]').waitFor();
  await open(activeId);
  await page.locator('[data-inventory-activation]').waitFor();
  await startRename('renamed-work');
  const beforeRename=await config();
  for (const id of ['UPPER', 'api', 'other', 'bad/path', 'a'.repeat(55)]) {
    await idEditor.locator('[name=cableId]').fill(id);
    assert.equal(await idEditor.getByRole('button',{name:'确认修改',exact:true}).isDisabled(),true);
  }
  await idEditor.locator('[name=cableId]').fill('renamed-work');
  await idEditor.locator('[name=cableId]').press('Tab');
  assert.deepEqual(await config(),beforeRename,'blur must not modify the Cable ID');
  assert.equal((await fetch(`${app.url}work/v1/models`)).status,200);
  await page.route('**/api/v1/config/commit',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{message:'ID save failed'}})}));
  await changed(()=>idEditor.getByRole('button',{name:'确认修改',exact:true}).click(),500);
  assert.equal(await idEditor.locator('[name=cableId]').inputValue(),'renamed-work');
  assert.deepEqual(await config(),beforeRename);
  await page.unroute('**/api/v1/config/commit');
  await changed(()=>idEditor.getByRole('button',{name:'确认修改',exact:true}).click());
  activeId='renamed-work';
  assert.equal((await config()).cables[activeId].name,undefined);
  assert.equal((await config()).cables.work,undefined);
  assert.equal(await codexFile(),before);
  assert.equal((await runtime()).cableId,activeId);
  await page.getByRole('heading',{name:activeId,exact:true}).waitFor();
  assert.equal(confirmations.length,2);
  assert.equal((await fetch(`${app.url}work/v1/models`)).status,404);
  assert.equal((await fetch(`${app.url}${activeId}/v1/models`)).status,200);
  await open(activeId);
  await page.locator('[data-inventory-activation]').getByText(/旧接口路径已失效/).waitFor();

  // Confirmation applies the new ID, model catalog and default together.
  acceptUpdate=true;
  await changed(()=>main.locator('[data-inventory-default=first]').check());
  assert.equal((await runtime()).needsUpdate,false);
  assert.match(await codexFile(),/cabletidy_renamed-work/);
  assert.equal(readCodexConfig(await codexFile()).model_providers.cabletidy_work,undefined);
  assert.equal(readCodexConfig(await codexFile()).model,'first');
  assert.equal(await page.locator('[data-inventory-activation]').count(),0);

  // Apply failures do not undo the line edit or conceal the pending update.
  const applied=await codexFile();
  await page.route('**/api/v1/targets/apply',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{message:'Apply failed'}})}));
  await changed(()=>main.locator('[data-inventory-default=second]').check());
  assert.equal((await config()).cables[activeId].defaultModel,'second');
  assert.equal(await codexFile(),applied);
  await page.locator('#toast-region').getByText(/线路已保存，更新 Codex 接入失败/).waitFor();
  await page.locator('[data-inventory-activation]').waitFor();
  await page.unroute('**/api/v1/targets/apply');
  await page.getByRole('button',{name:'应用到 Codex',exact:true}).click();
  await page.getByText('当前激活的 Codex 配置',{exact:true}).waitFor();

  // Editing another line never switches the active client's configuration.
  const count=confirmations.length,active=await codexFile();
  await open('other');
  await renameId('another-line');
  assert.equal(confirmations.length,count);
  assert.equal(await codexFile(),active);
  await open(activeId);
  acceptUpdate=false;
  await changed(()=>main.locator('[data-inventory-binding=second]').getByRole('button',{name:'移除',exact:true}).click());
  assert.equal((await config()).cables[activeId].defaultModel,'first');
  assert.equal((await config()).cables[activeId].models.second,undefined);
  assert.equal(await codexFile(),active);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await renameId('final-work');
  activeId='final-work';
  assert.equal(await codexFile(),active);
  const oldUrl=app.url;
  await app.close();
  app=await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalog});
  assert.equal(app.url,oldUrl);
  await open(activeId);
  await page.locator('[data-inventory-activation]').getByText(/旧接口路径已失效/).waitFor();
  await page.getByRole('button',{name:'应用到 Codex',exact:true}).click();
  await page.getByText('当前激活的 Codex 配置',{exact:true}).waitFor();
  assert.equal(readCodexConfig(await codexFile()).model_provider,'cabletidy_final-work');
  await page.getByRole('button',{name:'撤销接入',exact:true}).click();
  await page.getByText('尚未激活到 Codex 配置',{exact:true}).waitFor();
  const restored=readCodexConfig(await codexFile());
  assert.equal(restored.model_provider,undefined);
  for (const id of ['work','renamed-work','final-work']) assert.equal(restored.model_providers?.[`cabletidy_${id}`],undefined);
  assert.deepEqual(errors,[]);
  console.log('Live cable editing browser checks passed: immediate saves, failure recovery, explicit ID rename, default updates, independent application, confirmation, persistent pending state and mobile layout.');
} finally {
  await browser?.close();await app?.close();await fs.rm(home,{recursive:true,force:true});
}
