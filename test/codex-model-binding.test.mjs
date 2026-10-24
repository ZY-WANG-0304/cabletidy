import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, applyConfigOperation, planCodexCatalog, publicCodexCatalog, resolveRequest, validateConfig } from './helpers/native.mjs';
import { catalogFixture, daybreakCatalogFixture } from './helpers/codex-fixture.mjs';

function fixture(identity = 'gpt-5.5', promptModel = 'gpt-5.6-sol') {
  const snapshot = catalogFixture();
  const prompt = publicCodexCatalog(snapshot).models.find(m => m.id === promptModel).prompt;
  const source = {supplierId:'vendor',modelId:'wire',interfaceId:'responses'};
  const model = {name:'上游展示名称',identity,interfaces:['responses'],contextWindow:128000,inputModalities:['text'],capabilityStates:{reasoning:'supported'},reasoning:{modes:['effort'],efforts:['high']},interfaceCapabilities:{responses:{toolForms:['function','custom']}}};
  const alias = {name:'Coding model',nameMode:'manual',sources:[source],promptStrategy:'selected',promptModel,promptHash:prompt.hash,promptVersion:prompt.version,reasoning:{defaultEffort:'high'}};
  const config = normalizeConfig({
    suppliers:{vendor:{name:'Vendor',interfaces:{responses:{protocol:'openai.responses',baseUrl:'https://example.invalid',supportsStreaming:true}},models:{wire:model}}},
    cables:{work:{id:'work',name:'Work',target:'codex',virtualProvider:'cabletidy_work',managedModels:true,suppliers:['vendor'],models:{alias},defaultModel:'alias'}},
  });
  return {config,snapshot,source};
}

test('public catalog exposes versioned prompts and native reasoning recommendations',()=>{
  const catalog=publicCodexCatalog(catalogFixture());
  assert.equal(catalog.models[0].defaultEffort,'medium');
  assert.equal(catalog.models[0].prompt.text,'Official template for gpt-5.5');
  assert.match(catalog.models[0].prompt.hash,/^[a-f0-9]{64}$/);
  assert.equal(catalog.models[0].prompt.version,'codex-cli test');
});

for (const color of ['blue','red']) {
  for (const field of ['identity','promptModel']) {
    test(`Daybreak ${color} cannot supply a ${field} through saved bindings`,()=>{
      let {config}=fixture();
      const id=`gpt-daybreak-${color}-latest`;
      if (field === 'identity') config.suppliers.vendor.models.wire.identity=id;
      else config.cables.work.models.alias.promptModel=id;
      config=normalizeConfig(config);
      assert.equal(validateConfig(config).ok,true,'saved records remain readable for repair');
      const before=structuredClone(config);
      assert.throws(()=>planCodexCatalog(config,config.virtualProviders.cabletidy_work,daybreakCatalogFixture()),/不支持 Daybreak/);
      assert.throws(()=>resolveRequest(config,config.virtualProviders.cabletidy_work,{model:'alias'}),/不支持 Daybreak/);
      assert.deepEqual(config,before);
    });
  }
}

test('compatible models do not inherit a Daybreak definition at the start of the bundled catalog',()=>{
  const {config}=fixture('deepseek-v4-pro');
  const entry=planCodexCatalog(config,config.virtualProviders.cabletidy_work,daybreakCatalogFixture()).catalog.models[0];
  assert.equal(entry.base_instructions,'Official base for gpt-5.6-sol');
  assert.doesNotMatch(JSON.stringify(entry),/daybreak/i);
});

for (const identity of ['gpt-5.5','deepseek-v4-pro']) test(`selected native prompt is applied without changing ${identity} supply or routing`,()=>{
  const {config,snapshot}=fixture(identity);
  const entry=planCodexCatalog(config,config.virtualProviders.cabletidy_work,snapshot).catalog.models[0];
  assert.equal(entry.slug,'alias');
  assert.equal(entry.display_name,'Coding model');
  assert.equal(entry.base_instructions,'Official base for gpt-5.6-sol');
  assert.equal(entry.model_messages.instructions_template,'Official template for gpt-5.6-sol');
  assert.equal(entry.model_messages.instructions_variables.personality_default,'original');
  assert.equal(entry.context_window,128000);
  assert.deepEqual(entry.input_modalities,['text']);
  assert.equal(entry.default_reasoning_level,identity === 'gpt-5.5' ? 'high' : 'medium');
  assert.equal(config.virtualProviders.cabletidy_work.models.alias.identity,identity);
  assert.equal(resolveRequest(config,config.virtualProviders.cabletidy_work,{model:'alias'}).upstreamModelId,'wire');
});

test('streaming and tool form failures identify the missing declaration independently',()=>{
  const {config,snapshot}=fixture();
  const plan=()=>{const c=normalizeConfig(config);return planCodexCatalog(c,c.virtualProviders.cabletidy_work,snapshot);};
  config.suppliers.vendor.interfaces.responses.supportsStreaming=false;
  assert.throws(plan,/不支持流式响应.*供应商接口/);
  config.suppliers.vendor.interfaces.responses.supportsStreaming=true;
  config.suppliers.vendor.models.wire.interfaceCapabilities.responses.toolForms=[];
  assert.throws(plan,/未声明工具形式/);
  config.suppliers.vendor.models.wire.interfaceCapabilities.responses.toolForms=['function'];
  assert.throws(plan,/custom 工具形式.*可访问接口/);
  config.suppliers.vendor.models.wire.interfaceCapabilities.responses.toolForms=['function','custom'];
  assert.equal(plan().catalog.models[0].slug,'alias');
  config.suppliers.vendor.models.wire.interfaceCapabilities.responses.supportsStreaming=false;
  assert.throws(plan,/不支持流式响应.*接口差异/);
});

test('compatible bindings including legacy strategies require an explicit native prompt',async()=>{
  for (const identity of ['glm-5.3','glm-5.3-flash','kimi-k3','deepseek-v4-pro','deepseek-flash','MiniMax-M3']) {
    for (const strategy of [undefined,'default','native','compatible','compatible-concise','selected']) {
      let {config,snapshot}=fixture(identity);
      const binding=config.cables.work.models.alias;
      delete binding.promptModel;
      delete binding.promptVersion;
      delete binding.promptHash;
      if (strategy === undefined) delete binding.promptStrategy;
      else binding.promptStrategy=strategy;
      config=normalizeConfig(config);
      assert.equal(validateConfig(config).ok,true,'legacy records remain loadable for repair');
      assert.equal(config.cables.work.models.alias.promptModel,undefined);
      assert.throws(()=>planCodexCatalog(config,config.virtualProviders.cabletidy_work,snapshot),/请选择使用的 Codex 原生模型提示词/);
      assert.throws(()=>resolveRequest(config,config.virtualProviders.cabletidy_work,{model:'alias'}),/请选择使用的 Codex 原生模型提示词/);
      const repaired={...binding,promptStrategy:'selected',promptModel:'gpt-5.6-sol'};
      config=(await applyConfigOperation(config,{type:'cable.inventory.save',cableId:'work',data:{suppliers:['vendor'],models:{alias:repaired},defaultModel:'alias'}},snapshot)).config;
      const entry=planCodexCatalog(config,config.virtualProviders.cabletidy_work,snapshot).catalog.models[0];
      assert.equal(entry.base_instructions,'Official base for gpt-5.6-sol');
      assert.deepEqual(entry.model_messages,snapshot.catalog.models[1].model_messages);
    }
  }
});

test('native identity still supplies its own prompt when no separate prompt is selected',()=>{
  let {config,snapshot}=fixture();
  const binding=config.cables.work.models.alias;
  for (const key of ['promptModel','promptVersion','promptHash']) delete binding[key];
  binding.promptStrategy='default';
  config=normalizeConfig(config);
  const entry=planCodexCatalog(config,config.virtualProviders.cabletidy_work,snapshot).catalog.models[0];
  assert.equal(entry.base_instructions,'Official base for gpt-5.5');
  assert.deepEqual(entry.model_messages,snapshot.catalog.models[0].model_messages);
});

test('supplier-prefixed client IDs remain separate from the upstream request model',()=>{
  let {config,snapshot}=fixture();
  const id='供应商-A/wire';
  config.cables.work.models[id]=config.cables.work.models.alias;
  delete config.cables.work.models.alias;
  config.cables.work.defaultModel=id;
  config=normalizeConfig(config);
  assert.equal(planCodexCatalog(config,config.virtualProviders.cabletidy_work,snapshot).catalog.models[0].slug,id);
  assert.equal(resolveRequest(config,config.virtualProviders.cabletidy_work,{model:id}).upstreamModelId,'wire');
});

test('display name changes preserve Codex model IDs, default selection and upstream routing',()=>{
  let {config,snapshot}=fixture();
  for (const name of ['日常编程','已重命名的模型']) {
    config.cables.work.models.alias.name=name;
    config=normalizeConfig(config);
    const entry=planCodexCatalog(config,config.virtualProviders.cabletidy_work,snapshot).catalog.models[0];
    assert.equal(entry.slug,'alias');
    assert.equal(entry.display_name,name);
    assert.equal(config.cables.work.defaultModel,'alias');
    assert.equal(resolveRequest(config,config.virtualProviders.cabletidy_work,{model:'alias'}).upstreamModelId,'wire');
  }
});

test('renaming an inventory ID migrates endpoints and references without losing line settings',async()=>{
  const {buildTargetArtifacts, configurationEndpoints, validateConfig}=await import('./helpers/native.mjs');
  let {config,snapshot}=fixture();
  config.cables.work.enabled=false;
  config.virtualProviders.cabletidy_work.credentialProtection=false;
  const models=structuredClone(config.cables.work.models);
  config=(await applyConfigOperation(config,{type:'cable.inventory.rename',cableId:'work',data:{id:'renamed-work',target:'codex'}},snapshot)).config;
  const cable=config.cables['renamed-work'];
  assert.equal(cable.name,undefined);
  assert.equal(cable.id,'renamed-work');
  assert.equal(cable.target,'codex');
  assert.equal(cable.virtualProvider,'cabletidy_renamed-work');
  assert.equal(cable.defaultModel,'alias');
  assert.equal(cable.enabled,false);
  assert.deepEqual(cable.models,models);
  assert.equal(config.virtualProviders['cabletidy_renamed-work'].credentialProtection,false);
  assert.equal(config.cables.work,undefined);
  assert.equal(config.virtualProviders.cabletidy_work,undefined);
  assert.equal(config.routes['work-sources'],undefined);
  assert.equal(validateConfig(config).ok,true);
  assert.match(configurationEndpoints(config)[0].baseUrl,/\/renamed-work\/v1$/);
  const artifact=buildTargetArtifacts(config,{cableId:'renamed-work'});
  assert.equal(artifact.cableId,'renamed-work');
  assert.equal(artifact.providerId,'cabletidy_renamed-work');
  assert.match(artifact.providerContents,/CableTidy \/ renamed-work/);
});

test('inventory IDs are validated without normalizing bad input or accepting collisions',async()=>{
  const {config,snapshot}=fixture();
  for (const id of ['', 'UPPER', 'has space', 'bad/path', '中文', '_leading', 'a.b', 'api', 'a'.repeat(55)]) {
    await assert.rejects(applyConfigOperation(config,{type:'cable.inventory.rename',cableId:'work',data:{id}},snapshot),/线路ID/);
    await assert.rejects(applyConfigOperation(config,{type:'cable.inventory.create',data:{id,suppliers:[],models:{}}},snapshot),/线路ID/);
  }
  await assert.rejects(applyConfigOperation(config,{type:'cable.inventory.create',data:{id:'work',suppliers:[],models:{}}},snapshot),/已存在/);
  await assert.rejects(applyConfigOperation(config,{type:'cable.inventory.create',data:{name:'Would normalize',suppliers:[],models:{}}},snapshot),/线路ID/);
  const second=(await applyConfigOperation(config,{type:'cable.inventory.create',data:{id:'other',suppliers:[],models:{}}},snapshot)).config;
  await assert.rejects(applyConfigOperation(second,{type:'cable.inventory.rename',cableId:'work',data:{id:'other'}},snapshot),/已存在/);
  assert.equal(config.cables.work.name,undefined,'existing managed names are removed without renaming the ID');
  for (const id of ['0','lower-case_id','a'.repeat(54),'trailing-']) {
    const next=(await applyConfigOperation(config,{type:'cable.inventory.create',data:{id,suppliers:[],models:{}}},snapshot)).config;
    assert.equal(next.cables[id].id,id);
    assert.equal(next.cables[id].name,undefined);
  }
});

test('missing or changed selected prompts block the default model rather than silently falling back',()=>{
  const {config,snapshot}=fixture();
  snapshot.catalog.models[1].model_messages.instructions_template='Updated prompt';
  assert.throws(()=>planCodexCatalog(config,config.virtualProviders.cabletidy_work,snapshot),/提示词已更新/);
  snapshot.catalog.models.pop();
  assert.throws(()=>planCodexCatalog(config,config.virtualProviders.cabletidy_work,snapshot),/所选提示词不在/);
});

test('prompt selection checks tool contracts and replaces both instruction fields',()=>{
  const {config,snapshot}=fixture();
  delete config.virtualProviders.cabletidy_work.models.alias.promptHash;
  snapshot.catalog.models[1].shell_type='different';
  assert.throws(()=>planCodexCatalog(config,config.virtualProviders.cabletidy_work,snapshot),/shell_type/);
  snapshot.catalog.models[1].shell_type='unified_exec';
  delete snapshot.catalog.models[1].model_messages;
  const entry=planCodexCatalog(config,config.virtualProviders.cabletidy_work,snapshot).catalog.models[0];
  assert.equal(entry.model_messages,undefined);
  assert.equal(entry.base_instructions,'Official base for gpt-5.6-sol');
});

test('two upstreams publish two independent models; new multi-source bindings are rejected',async()=>{
  let {config,snapshot,source}=fixture();
  config.suppliers.vendor.models.other=structuredClone(config.suppliers.vendor.models.wire);
  config=normalizeConfig(config);
  const existing=config.cables.work.models.alias;
  const data={name:'Work',suppliers:['vendor'],models:{alias:existing,other:{...existing,sources:[{...source,modelId:'other'}]}},defaultModel:'other'};
  config=(await applyConfigOperation(config,{type:'cable.inventory.save',cableId:'work',data},snapshot)).config;
  assert.equal(config.cables.work.name,undefined);
  const plan=planCodexCatalog(config,config.virtualProviders.cabletidy_work,snapshot);
  assert.deepEqual(plan.catalog.models.map(m=>m.slug),['alias','other']);
  assert.equal(resolveRequest(config,config.virtualProviders.cabletidy_work,{model:'other'}).upstreamModelId,'other');
  data.models.other.sources.push(source);
  await assert.rejects(applyConfigOperation(config,{type:'cable.inventory.save',cableId:'work',data},snapshot),/只能绑定一个/);
});

test('unselected prompt can be saved as draft, omitted from catalog, and cannot apply as default',()=>{
  let {config,snapshot}=fixture();
  config.cables.work.models.alias.promptModel='';
  delete config.cables.work.defaultModel;
  config=normalizeConfig(config);
  assert.throws(()=>planCodexCatalog(config,config.virtualProviders.cabletidy_work,snapshot),/至少一个可用模型/);
  config.cables.work.defaultModel='alias'; config=normalizeConfig(config);
  assert.throws(()=>planCodexCatalog(config,config.virtualProviders.cabletidy_work,snapshot),/默认模型不可用/);
});

test('optional default removes the managed model and restore recovers the original client settings',async t=>{
  const fs=await import('node:fs/promises'), os=await import('node:os'), path=await import('node:path');
  const {getPaths,prepareTargetArtifacts,applyCodexArtifacts,nativeAsync,readCodexConfig}=await import('./helpers/native.mjs');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'cabletidy-no-default-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const {config,snapshot}=fixture();
  const options={paths:getPaths(path.join(home,'gateway')),codexHome:path.join(home,'codex'),cableId:'work',loadCatalog:async()=>snapshot};
  await fs.mkdir(options.codexHome,{recursive:true});
  const root=path.join(options.codexHome,'config.toml');
  await fs.writeFile(root,'model = "original-model"\nmodel_provider = "original-provider"\n');
  await applyCodexArtifacts(await prepareTargetArtifacts(config,options),options);
  const applied=readCodexConfig(await fs.readFile(root,'utf8'));
  assert.equal(applied.model,'alias');
  const generated=JSON.parse(await fs.readFile(applied.model_catalog_json,'utf8'));
  assert.deepEqual(generated.models.map(({slug,display_name})=>({slug,display_name})),[
    {slug:'alias',display_name:'Coding model'},
  ]);
  delete config.cables.work.defaultModel;
  const cleared=normalizeConfig(config);
  await applyCodexArtifacts(await prepareTargetArtifacts(cleared,options),options);
  assert.equal(readCodexConfig(await fs.readFile(root,'utf8')).model,undefined);
  await nativeAsync('codex.restore','work',options);
  const restored=readCodexConfig(await fs.readFile(root,'utf8'));
  assert.equal(restored.model,'original-model');assert.equal(restored.model_provider,'original-provider');
});

test('prompt selection and its version survive exported and imported line configuration',async t=>{
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const {createApplication}=await import('./helpers/native-app.mjs');
  const {getPaths}=await import('./helpers/native.mjs');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'cabletidy-prompt-transfer-'));
  const paths=getPaths(home),{config,snapshot}=fixture();
  config.cables.work.webSearch='indexed';
  config.cables.work.models.alias.supportsSearchTool=false;
  const http=await import('node:http');
  const reservation=http.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  config.web.port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  await fs.writeFile(paths.config,JSON.stringify(config));
  const app=await createApplication({paths,loadCodexCatalog:async()=>snapshot});
  t.after(async()=>{await app.close();await fs.rm(home,{recursive:true,force:true});});
  const post=async(endpoint,body)=>{
    const r=await fetch(`${app.url}api/v1/${endpoint}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;
  };
  const isolated=await post('targets/isolated',{cableId:'work'});
  assert.match(isolated.bundle.files.find(f=>f.path==='config.toml').contents,/web_search = "indexed"/);
  assert.equal(JSON.parse(isolated.bundle.files.find(f=>f.path==='model-catalog.json').contents).models[0].supports_search_tool,false);
  const bundle=await post('cables/export',{cableIds:['work']});
  assert.equal(bundle.config.cables.work.webSearch,'indexed');
  assert.equal(bundle.config.suppliers.vendor.models.wire.name,'上游展示名称');
  assert.equal(bundle.config.suppliers.vendor.models.wire.version,undefined);
  const original=config.cables.work.models.alias;
  for(const key of ['name','nameMode','promptModel','promptVersion','promptHash','supportsSearchTool'])assert.equal(bundle.config.cables.work.models.alias[key],original[key]);
  const current=(await(await fetch(`${app.url}api/v1/config`)).json()).config;
  const result=await post('cables/import',{bundle,baseRevision:current.revision,useImportedCredentials:false,choices:{work:'create'}});
  assert.equal(result.config.cables['work-import-2'].webSearch,'indexed');
  for(const key of ['name','nameMode','promptModel','promptVersion','promptHash','supportsSearchTool'])assert.equal(result.config.cables['work-import-2'].models.alias[key],original[key]);
});

test('draft model preview uses the applied directory values without saving configuration',async t=>{
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),http=await import('node:http');
  const {createApplication}=await import('./helpers/native-app.mjs');
  const {getPaths}=await import('./helpers/native.mjs');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'cabletidy-effective-config-'));
  const paths=getPaths(home),{config,snapshot}=fixture();
  const reservation=http.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  config.web.port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  await fs.writeFile(paths.config,JSON.stringify(config));
  const app=await createApplication({paths,loadCodexCatalog:async()=>snapshot});
  t.after(async()=>{await app.close();await fs.rm(home,{recursive:true,force:true});});
  const before=await(await fetch(`${app.url}api/v1/config`)).json();
  const binding=structuredClone(config.cables.work.models.alias);
  binding.reasoning.defaultEffort=null;
  binding.codex={contextWindow:64000,maxContextWindow:96000};
  const preview=async value=>{
    const response=await fetch(`${app.url}api/v1/codex/model-preview`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientModelId:'draft-name',binding:value})});
    assert.equal(response.status,200);return response.json();
  };
  const result=await preview(binding);
  assert.equal(result.available,true);
  assert.equal(result.preview.context.supplyContextWindow,128000);
  assert.equal(result.preview.context.windowSource,'Cable 模型设置');
  assert.equal(result.preview.model.max_context_window,96000);
  const model=result.preview.model;
  const profile={...config.virtualProviders.cabletidy_work.models.alias,clientReasoning:binding.reasoning,clientContext:binding.codex};
  const {catalogEntryForProfile}=await import('./helpers/native.mjs');
  const generated=catalogEntryForProfile(snapshot,'draft-name',profile);
  const expected=generated.entry;
  for(const key of Object.keys(model))assert.deepEqual(model[key],expected[key] ?? null,key);
  assert.equal(model.context_window,64000);
  assert.equal(model.default_reasoning_level,'high','uses the effective supported default, not the empty form value');
  assert.deepEqual(model.input_modalities,['text']);
  assert.equal(result.preview.prompt,'gpt-5.6-sol');
  assert.equal('maxOutputTokens' in model,false);
  assert.equal('base_instructions' in model,false);
  const unavailable=await preview({...binding,promptModel:''});
  assert.equal(unavailable.available,false);assert.match(unavailable.issues.join("\n"),/请选择使用/);
  assert.equal(unavailable.preview.model.context_window,64000);
  assert.deepEqual(unavailable.preview.model.supported_reasoning_levels,model.supported_reasoning_levels);
  assert.deepEqual(await(await fetch(`${app.url}api/v1/config`)).json(),before);
  const candidate=structuredClone(before.config);
  candidate.suppliers.vendor.interfaces.responses.supportsStreaming=false;
  candidate.suppliers.vendor.models.wire.interfaceCapabilities.responses.toolForms=['function'];
  const commit=await fetch(`${app.url}api/v1/config/commit`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseRevision:candidate.revision,config:candidate})});
  assert.equal(commit.status,200,await commit.text());
  const blocked=await preview(binding);
  assert.equal(blocked.available,false);
  assert.ok(blocked.issues.some(message=>message.includes('不支持流式响应')));
  assert.ok(blocked.issues.some(message=>message.includes('custom 工具形式')));
  assert.equal(blocked.preview.model.context_window,64000);
  assert.equal(blocked.preview.model.default_reasoning_level,'high');
  assert.deepEqual(blocked.preview.model.input_modalities,['text']);
  const missing=await preview({...binding,sources:[]});
  assert.equal(missing.available,false);
  assert.equal(missing.preview.model.context_window,null);
  assert.ok(missing.issues.some(message=>message.includes('请选择一个上游')));

});


test('inventory basics reject unsupported clients before changing the line identity',async()=>{
  const {config,snapshot}=fixture();
  const before=structuredClone(config);
  for (const target of ['claude','',null]) {
    await assert.rejects(applyConfigOperation(config,{type:'cable.inventory.rename',cableId:'work',data:{id:'renamed-work',target}},snapshot),/仅支持 Codex/);
    await assert.rejects(applyConfigOperation(config,{type:'cable.inventory.create',data:{id:'new-work',target,suppliers:[],models:{}}},snapshot),/仅支持 Codex/);
  }
  assert.deepEqual(config,before);
  const unchanged=await applyConfigOperation(config,{type:'cable.inventory.rename',cableId:'work',data:{id:'work',target:'codex'}},snapshot);
  assert.deepEqual(unchanged.config.cables.work,config.cables.work);
});


test('search tool defaults follow identity and explicit boolean overrides win',async()=>{
  for (const identity of ['gpt-5.5','deepseek-flash','deepseek-v4-pro','glm-5.3','glm-5.3-flash','kimi-k3','MiniMax-M3']) {
    const {config,snapshot}=fixture(identity);
    snapshot.catalog.models[0].supports_search_tool=true;
    snapshot.catalog.models[1].supports_search_tool=false;
    const entry=()=>{const c=normalizeConfig(config);return planCodexCatalog(c,c.virtualProviders.cabletidy_work,snapshot).catalog.models[0];};
    assert.equal(publicCodexCatalog(snapshot).models[0].supportsSearchTool,true);
    assert.equal(publicCodexCatalog(snapshot).models[1].supportsSearchTool,false);
    assert.equal(entry().supports_search_tool,['gpt-5.5','deepseek-flash'].includes(identity),`${identity}: prompt choice must not change the identity default`);
    for (const value of [false,true]) {
      config.cables.work.models.alias.supportsSearchTool=value;
      assert.equal(entry().supports_search_tool,value);
    }
    const models=structuredClone(config.cables.work.models);
    models.alias.supportsSearchTool='false';
    await assert.rejects(applyConfigOperation(config,{type:'cable.inventory.save',cableId:'work',data:{suppliers:['vendor'],models,defaultModel:'alias'}},snapshot),/supports_search_tool.*布尔/);
  }
});

test('web search choices persist independently from IDs and reject invalid values',async()=>{
  let {config,snapshot}=fixture();
  for (const webSearch of ['cached','indexed','live','disabled',null]) {
    config=(await applyConfigOperation(config,{type:'cable.inventory.rename',cableId:'work',data:{id:'work',target:'codex',webSearch}},snapshot)).config;
    assert.equal(config.cables.work.webSearch,webSearch ?? undefined);
    assert.equal(config.cables.work.defaultModel,'alias');
    const created=await applyConfigOperation(config,{type:'cable.inventory.create',data:{id:'new',webSearch,suppliers:[],models:{}}},snapshot);
    assert.equal(created.config.cables.new.webSearch,webSearch ?? undefined);
  }
  for (const webSearch of ['index','inherit','',false,{}]) {
    await assert.rejects(applyConfigOperation(config,{type:'cable.inventory.rename',cableId:'work',data:{id:'new',webSearch}},snapshot),/网页搜索方式/);
  }
});

test('Codex search inheritance preserves current settings; explicit choices apply and restore',async t=>{
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const {getPaths,prepareTargetArtifacts,applyCodexArtifacts,nativeAsync,readCodexConfig}=await import('./helpers/native.mjs');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'cabletidy-web-search-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const {config,snapshot}=fixture();
  for (const [index,mode] of [undefined,'cached','indexed','live','disabled'].entries()) {
    for (const initial of [undefined,'cached']) {
      const codexHome=path.join(home,`${index}-${initial}`);
      const options={paths:getPaths(path.join(home,'gateway')),codexHome,cableId:'work',loadCatalog:async()=>snapshot};
      await fs.mkdir(codexHome,{recursive:true});
      const root=path.join(codexHome,'config.toml');
      await fs.writeFile(root,`model_provider = "original"\n${initial ? `web_search = "${initial}"\n` : ''}`);
      if (mode) config.cables.work.webSearch=mode; else delete config.cables.work.webSearch;
      const artifact=await prepareTargetArtifacts(config,options);
      assert.ok(!artifact.warnings.some(w=>w.includes('避免辅助模型')));
      assert.equal(readCodexConfig(await fs.readFile(root,'utf8')).web_search,initial,'preview must not write');
      await applyCodexArtifacts(artifact,options);
      assert.equal(readCodexConfig(await fs.readFile(root,'utf8')).web_search,mode ?? initial);
      await nativeAsync('codex.restore','work',options);
      assert.equal(readCodexConfig(await fs.readFile(root,'utf8')).web_search,initial);
    }
  }
  // Inherit must also leave later user edits alone during reapply and restore.
  const options={paths:getPaths(path.join(home,'gateway')),codexHome:path.join(home,'inherit'),cableId:'work',loadCatalog:async()=>snapshot};
  await fs.mkdir(options.codexHome,{recursive:true});
  const root=path.join(options.codexHome,'config.toml');
  await fs.writeFile(root,'model_provider = "original"\nweb_search = "cached"\n');
  config.cables.work.webSearch='disabled';
  await applyCodexArtifacts(await prepareTargetArtifacts(config,options),options);
  delete config.cables.work.webSearch;
  await applyCodexArtifacts(await prepareTargetArtifacts(config,options),options);
  assert.equal(readCodexConfig(await fs.readFile(root,'utf8')).web_search,'disabled','inherit leaves the current choice intact');
  await fs.writeFile(root,(await fs.readFile(root,'utf8')).replace('web_search = "disabled"','web_search = "live"'));
  await applyCodexArtifacts(await prepareTargetArtifacts(config,options),options);
  await nativeAsync('codex.restore','work',options);
  const restored=readCodexConfig(await fs.readFile(root,'utf8'));
  assert.equal(restored.web_search,'live');
  assert.equal(restored.model_provider,'original');
});

for (const identity of ['gpt-5.5','deepseek-v4-pro']) test(`${identity} supplier limits and client windows have independent ownership`,()=>{
  const {config,snapshot}=fixture(identity);
  const supply=config.suppliers.vendor.models.wire;
  supply.contextWindow=1050000; supply.maxOutputTokens=128000;
  const native=snapshot.catalog.models.find(m=>m.slug===identity);
  if(native) native.max_context_window=872000;
  // A selected prompt's window is never a compatibility model's default.
  snapshot.catalog.models.find(m=>m.slug==='gpt-5.6-sol').context_window=64000;
  const plan=()=>{const c=normalizeConfig(config);return planCodexCatalog(c,c.virtualProviders.cabletidy_work,snapshot).catalog.models[0];};
  let entry=plan();
  assert.equal(entry.context_window,272000);
  assert.equal(entry.max_context_window,native ? 872000 : 1050000);
  const before=structuredClone(supply);
  config.cables.work.models.alias.codex={contextWindow:500000,maxContextWindow:1000000};
  entry=plan();assert.equal(entry.context_window,500000);assert.equal(entry.max_context_window,1000000);
  assert.deepEqual(supply,before);
  const compiled=normalizeConfig(config).virtualProviders.cabletidy_work.models.alias;
  assert.equal(compiled.contextWindow,1050000);assert.equal(compiled.maxOutputTokens,128000);
  assert.deepEqual(compiled.clientContext,{contextWindow:500000,maxContextWindow:1000000});
  delete config.cables.work.models.alias.codex;
  supply.contextWindow=64000; entry=plan();
  assert.equal(entry.context_window,64000);assert.equal(entry.max_context_window,64000);
});

test('explicit Codex budgets reject invalid values and interface supply overruns without rewriting input',()=>{
  const {config,snapshot}=fixture();
  config.suppliers.vendor.models.wire.contextWindow=1050000;
  config.suppliers.vendor.models.wire.interfaceCapabilities.responses.contextWindow=128000;
  const binding=config.cables.work.models.alias;
  for(const codex of [{contextWindow:0},{maxContextWindow:-1},{contextWindow:1.5},{contextWindow:"64K"},{autoCompactTokenLimit:1000},[]]){
    binding.codex=codex;
    assert.equal(validateConfig(normalizeConfig(config)).ok,false,JSON.stringify(codex));
  }
  for(const codex of [{contextWindow:64000,maxContextWindow:32000},{contextWindow:256000},{maxContextWindow:256000}]){
    binding.codex=codex;
    const c=normalizeConfig(config),before=structuredClone(c);
    assert.throws(()=>planCodexCatalog(c,c.virtualProviders.cabletidy_work,snapshot),/Codex.*(?:不能超过|窗口)/);
    assert.deepEqual(c,before);
    assert.throws(()=>resolveRequest(c,c.virtualProviders.cabletidy_work,{model:'alias'}),/Codex/);
  }
  binding.codex={contextWindow:64000,maxContextWindow:128000};
  const c=normalizeConfig(config),entry=planCodexCatalog(c,c.virtualProviders.cabletidy_work,snapshot).catalog.models[0];
  assert.equal(entry.context_window,64000);assert.equal(entry.max_context_window,128000);
});

test('legacy Codex lines remain usable without an old-to-inventory conversion operation',async()=>{
  const {codexConfigFixture}=await import('./helpers/codex-fixture.mjs');
  const config=normalizeConfig(codexConfigFixture());
  const before=structuredClone(config);
  await assert.rejects(applyConfigOperation(config,{type:'cable.inventory.migrate',cableId:'relay'},catalogFixture()),/未知配置操作/);
  assert.deepEqual(config,before);
  assert.equal(config.cables.relay.managedModels,undefined);
  assert.equal(resolveRequest(config,config.virtualProviders.cabletidy_relay,{model:'gpt-5.5'}).upstreamModelId,'VENDOR-GPT');
  assert.equal(resolveRequest(config,config.virtualProviders.cabletidy_relay,{model:'unregistered'}).upstreamModelId,'unregistered');
});

test('applying client windows preserves compression settings and restores the original global window',async t=>{
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const {prepareTargetArtifacts,applyCodexArtifacts,nativeAsync,readCodexConfig,getPaths}=await import('./helpers/native.mjs');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'cabletidy-window-apply-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const {config,snapshot}=fixture();
  config.suppliers.vendor.models.wire.contextWindow=1050000;
  config.suppliers.vendor.models.wire.maxOutputTokens=128000;
  config.cables.work.models.alias.codex={contextWindow:500000,maxContextWindow:1000000};
  const options={paths:getPaths(path.join(home,'gateway')),codexHome:path.join(home,'codex'),cableId:'work',loadCatalog:async()=>snapshot};
  await fs.mkdir(options.codexHome);
  const root=path.join(options.codexHome,'config.toml');
  await fs.writeFile(root,'model_context_window = 64000\nmodel_auto_compact_token_limit = 12345\nmodel_auto_compact_token_limit_scope = "body_after_prefix"\n');
  const artifacts=await prepareTargetArtifacts(config,options);
  const generated=artifacts.files.find(f=>f.kind==='json' && f.contents.includes('"context_window"'));
  const entry=JSON.parse(generated.contents).models[0];
  assert.equal(entry.context_window,500000);assert.equal(entry.max_context_window,1000000);
  await applyCodexArtifacts(artifacts,options);
  let current=readCodexConfig(await fs.readFile(root,'utf8'));
  assert.equal(current.model_context_window,undefined);
  assert.equal(current.model_auto_compact_token_limit,12345);
  assert.equal(current.model_auto_compact_token_limit_scope,'body_after_prefix');
  assert.equal(JSON.parse(await fs.readFile(current.model_catalog_json,'utf8')).models[0].context_window,500000);
  await nativeAsync('codex.restore','work',options);
  current=readCodexConfig(await fs.readFile(root,'utf8'));
  assert.equal(current.model_context_window,64000);
  assert.equal(current.model_auto_compact_token_limit,12345);
  assert.equal(current.model_auto_compact_token_limit_scope,'body_after_prefix');
});
