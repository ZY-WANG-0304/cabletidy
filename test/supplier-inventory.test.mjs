import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "./helpers/native-app.mjs";
import { getPaths, applyConfigOperation, normalizeConfig, resolveRequest, planCodexCatalog, publicConfig, validateConfig, buildTargetArtifacts } from "./helpers/native.mjs";
import { catalogFixture } from "./helpers/codex-fixture.mjs";

const facts = identity => ({ identity, interfaces:["responses"],capabilityStates:{reasoning:"supported"},interfaceCapabilities:{responses:{toolForms:["function","custom"]}},contextWindow:128000,reasoning:{modes:["effort"],efforts:["low","high"]} });
const supplier = (id,url) => ({type:"supplier.save",supplierId:id,data:{name:id,interfaces:{responses:{protocol:"openai.responses",baseUrl:url,secret:"supplier-fixture-key",auth:{header:"authorization",scheme:"Bearer"}}}}});
const supply = (id,mid,identity,oldModelId="") => ({type:"supplier.model.save",supplierId:id,data:{modelId:mid,oldModelId,model:facts(identity)}});
const binding = (sid,mid) => ({sources:[{supplierId:sid,modelId:mid,interfaceId:"responses"}],promptStrategy:"selected",promptModel:"gpt-5.5"});
async function edit(c,op) { return (await applyConfigOperation(c,op,catalogFixture())).config; }

test("supplier keys remain separate from client IDs and rename invalidates old references",async () => {
  let c=normalizeConfig({});
  c=await edit(c,supplier("official","https://example.invalid"));
  c=await edit(c,supply("official","wire-pro","deepseek-v4-pro"));
  c=await edit(c,supply("official","another-id","deepseek-v4-pro"));
  c=await edit(c,{type:"cable.inventory.create",data:{id:"work",suppliers:["official"],models:{pro:binding("official","wire-pro")},defaultModel:"pro"}});
  assert.deepEqual(Object.keys(c.suppliers.official.models),["wire-pro","another-id"]);
  assert.deepEqual(Object.keys(c.virtualProviders.cabletidy_work.models),["pro"]);
  assert.equal(resolveRequest(c,c.virtualProviders.cabletidy_work,{model:"pro"}).upstreamModelId,"wire-pro");
  assert.throws(() => resolveRequest(c,c.virtualProviders.cabletidy_work,{model:"another-id"}),/未在当前 Cable 中开放/);
  c=await edit(c,supply("official","wire-new","deepseek-v4-pro","wire-pro"));
  assert.equal(c.cables.work.models.pro.sources[0].modelId,"wire-pro");
  assert.throws(() => resolveRequest(c,c.virtualProviders.cabletidy_work,{model:"pro"}),/来源不存在/);
  c=await edit(c,{type:"cable.inventory.save",cableId:"work",data:{suppliers:["official"],models:{pro:binding("official","wire-new")},defaultModel:"pro"}});
  assert.equal(resolveRequest(c,c.virtualProviders.cabletidy_work,{model:"pro"}).upstreamModelId,"wire-new");
});

test("all six compatible identities use selected native instructions and preserve adapter settings",async () => {
  let c=normalizeConfig({}); c=await edit(c,supplier("vendor","https://example.invalid/v1"));
  const identities=["glm-5.3","glm-5.3-flash","kimi-k3","deepseek-v4-pro","deepseek-flash","MiniMax-M3"];
  const models={};
  for (const [i,identity] of identities.entries()) { c=await edit(c,supply("vendor",`wire-${i}`,identity));models[`client-${i}`]=binding("vendor",`wire-${i}`); }
  c=await edit(c,{type:"cable.inventory.create",data:{id:"models",suppliers:["vendor"],models,defaultModel:"client-0"}});
  const plan=planCodexCatalog(c,c.virtualProviders.cabletidy_models,catalogFixture());
  assert.equal(plan.catalog.models.length,6);
  for(const m of plan.catalog.models) { assert.equal(m.base_instructions,"Official base for gpt-5.5");assert.deepEqual(m.model_messages,catalogFixture().catalog.models[0].model_messages);assert.equal(m.apply_patch_tool_type,"freeform");assert.deepEqual(m.input_modalities,["text"]);assert.ok(m.supported_reasoning_levels.some(r=>r.effort === "high"));assert.equal(m.upgrade,null); }
});

test("multi-supplier Responses forwarding, discovery, history guard and deletion preserve inventory",async t => {
  const received=[];
  const upstream=http.createServer(async(req,res)=>{
    if(req.url==="/models") {res.setHeader("content-type","application/json");res.end(JSON.stringify({data:[{id:"wire-a"},{id:"not-selected"}]}));return;}
    let raw="";for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);received.push({url:req.url,body,auth:req.headers.authorization});
    res.setHeader("content-type","application/json");res.end(JSON.stringify({id:"response",object:"response",model:body.model,output:[{type:"message",content:[{type:"output_text",text:"done"}]}]}));
  });
  await new Promise(resolve=>upstream.listen(0,"127.0.0.1",resolve));
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"cabletidy-suppliers-"));
  const app=await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalogFixture()});
  t.after(async()=>{await app.close();await new Promise(r=>upstream.close(r));await fs.rm(home,{recursive:true,force:true});});
  const call=async(endpoint,body)=>{const response=await fetch(`${app.url}${endpoint}`,body===undefined?{}:{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  let c=(await call("api/v1/config")).body.config;
  const commit=async operation=>{const result=await call("api/v1/config/commit",{baseRevision:c.revision,operation});assert.equal(result.status,200,JSON.stringify(result.body));c=result.body.config;return result;};
  const url=`http://127.0.0.1:${upstream.address().port}`;
  const withContinuation = id => {const op=supplier(id,url);op.data.interfaces.responses.supportsResponseIdContinuation=true;return op;};
  await commit(withContinuation("first"));await commit(withContinuation("second"));
  await commit(supply("first","wire-a","deepseek-v4-pro"));await commit(supply("second","wire-b","MiniMax-M3"));
  await commit({type:"cable.inventory.create",data:{id:"work",suppliers:["first","second"],models:{a:binding("first","wire-a"),b:binding("second","wire-b")},defaultModel:"a"}});
  const discovered=await call("api/v1/suppliers/discover",{supplierId:"first",interfaceId:"responses"});assert.equal(discovered.status,200);assert.equal(discovered.body.models.length,2);
  await call("api/v1/virtual-providers/cabletidy_work/pause",{});assert.equal((await call("work/v1/models")).status,503);
  await call("api/v1/virtual-providers/cabletidy_work/start",{});
  c=(await call("api/v1/config")).body.config;
  const list=await call("work/v1/models");assert.deepEqual(list.body.data.map(m=>m.id),["a","b"]);
  const result=await call("work/v1/responses",{model:"b",store:true,reasoning:{effort:"high",summary:"auto"},input:[{role:"user",content:"test"}],tools:[{type:"function",name:"exec_command",parameters:{type:"object"}}]});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.model,"b");
  assert.equal(received[0].url,"/responses");assert.equal(received[0].body.model,"wire-b");assert.equal(received[0].body.store,false);assert.deepEqual(received[0].body.reasoning,{effort:"high"});assert.equal(received[0].auth,"Bearer supplier-fixture-key");
  const history=await call("work/v1/responses",{model:"b",previous_response_id:"remote",input:"next"});assert.equal(history.status,422);assert.equal(received.length,1);
  const encrypted=await call("work/v1/responses",{model:"b",input:[{type:"reasoning",encrypted_content:"proof"}]});assert.equal(encrypted.status,422);
  // A saved compatible binding must revalidate the chosen prompt before forwarding.
  const changedCatalog=catalogFixture();
  changedCatalog.catalog.models.shift();
  app.state.loadCodexCatalog=async()=>changedCatalog;
  await call("api/v1/codex/models?refresh=1");
  const missingPrompt=await call("work/v1/responses",{model:"b",input:"next"});
  assert.equal(missingPrompt.status,422);
  assert.match(missingPrompt.body.error.message,/所选提示词不在本机/);
  const incompatibleCatalog=catalogFixture();
  incompatibleCatalog.catalog.models[0].tool_mode="code_mode_only";
  app.state.loadCodexCatalog=async()=>incompatibleCatalog;
  await call("api/v1/codex/models?refresh=1");
  const incompatiblePrompt=await call("work/v1/responses",{model:"b",input:"next"});
  assert.equal(incompatiblePrompt.status,422);
  assert.match(incompatiblePrompt.body.error.message,/tool_mode.*不兼容/);
  assert.equal(received.length,1,'invalid prompts never reach the upstream');
  app.state.loadCodexCatalog=async()=>catalogFixture();
  await call("api/v1/codex/models?refresh=1");
  await commit({type:"supplier.model.delete",supplierId:"second",modelId:"wire-b"});
  const missing=await call("work/v1/responses",{model:"b",input:"next"});assert.equal(missing.status,503);assert.match(missing.body.error.message,/来源不存在/);
  await commit({type:"cable.delete",cableId:"work"});assert.ok(c.suppliers.first);assert.ok(c.suppliers.second);
});

test("native client models retain versioned instructions and restrict declared supply efforts",async()=>{
  let c=normalizeConfig({});c=await edit(c,supplier("native","https://example.invalid"));
  const model={...facts("gpt-5.5"),reasoning:{modes:["effort"],efforts:["high"]}};
  c=await edit(c,{type:"supplier.model.save",supplierId:"native",data:{modelId:"wire-gpt",model}});
  c=await edit(c,{type:"cable.inventory.create",data:{id:"native",suppliers:["native"],models:{alias:binding("native","wire-gpt")},defaultModel:"alias"}});
  const m=planCodexCatalog(c,c.virtualProviders.cabletidy_native,catalogFixture()).catalog.models[0];
  assert.equal(m.base_instructions,"Official base for gpt-5.5");assert.equal(m.model_messages.instructions_template,"Official template for gpt-5.5");
  assert.deepEqual(m.supported_reasoning_levels.map(r=>r.effort),["high"]);assert.equal(m.default_reasoning_level,"high");
  assert.deepEqual(m.future_metadata,{retained:true});assert.equal(m.context_window,128000);assert.equal(m.slug,"alias");
});

test("supported reasoning levels come from supply; Cable default overrides do not change the catalog",async()=>{
  let c=normalizeConfig({}); c=await edit(c,supplier("vendor","https://example.invalid/v1"));
  c=await edit(c,supply("vendor","wire","deepseek-v4-pro"));
  for (const [name,effort] of [["Low","low"],["High","high"]]) {
    c=await edit(c,{type:"cable.inventory.create",data:{id:name.toLowerCase(),suppliers:["vendor"],models:{pro:{...binding("vendor","wire"),reasoning:{defaultEffort:effort}}},defaultModel:"pro"}});
  }
  for (const id of ["low","high"]) {
    const entry=planCodexCatalog(c,c.virtualProviders[`cabletidy_${id}`],catalogFixture()).catalog.models[0];
    assert.equal(entry.default_reasoning_level,"medium");
    assert.ok(entry.supported_reasoning_levels.some(level=>level.effort === "high"));
  }
  assert.equal(c.suppliers.vendor.models.wire.reasoning.default,undefined);
  const bad=await edit(c,{type:"cable.inventory.save",cableId:"low",data:{suppliers:["vendor"],models:{pro:{...binding("vendor","wire"),reasoning:{defaultEffort:"max"}}},defaultModel:"pro"}});
  assert.equal(planCodexCatalog(bad,bad.virtualProviders.cabletidy_low,catalogFixture()).catalog.models[0].default_reasoning_level,"medium");
  const budget=await edit(c,{type:"cable.inventory.save",cableId:"low",data:{suppliers:["vendor"],models:{pro:{...binding("vendor","wire"),reasoning:{defaultBudget:4096}}},defaultModel:"pro"}});
  assert.throws(()=>planCodexCatalog(budget,budget.virtualProviders.cabletidy_low,catalogFixture()),/预算映射/);
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"cabletidy-reasoning-transfer-"));
  const paths=getPaths(home);await fs.writeFile(paths.config,JSON.stringify(c));
  const app=await createApplication({paths,ephemeralPort:true,loadCodexCatalog:async()=>catalogFixture()});
  try {
    const exported=await (await fetch(`${app.url}api/v1/cables/export`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cableIds:["low","high"]})})).json();
    assert.equal(exported.config.cables.low.models.pro.reasoning.defaultEffort,"low");
    assert.equal(exported.config.cables.high.models.pro.reasoning.defaultEffort,"high");
    const revision=(await (await fetch(`${app.url}api/v1/config`)).json()).config.revision;
    const imported=await (await fetch(`${app.url}api/v1/cables/import`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({bundle:exported,baseRevision:revision,useImportedCredentials:false,choices:{low:"create",high:"create"}})})).json();
    assert.equal(imported.config.cables["low-import-2"].models.pro.reasoning.defaultEffort,"low");
    assert.equal(imported.config.cables["high-import-2"].models.pro.reasoning.defaultEffort,"high");
  } finally {await app.close();await fs.rm(home,{recursive:true,force:true});}
});

test("old client defaults migrate idempotently without overriding explicit bindings or old selections",()=>{
  const model={...facts("deepseek-v4-pro"),inputModalities:["text","audio"],capabilityStates:{reasoning:"supported",parallel_tool_calls:"unsupported"},reasoning:{modes:["effort","budget"],efforts:["low","high","ultra"],default:"high",toggle:false,budget:{unit:"tokens",min:0,max:4096001,default:1024001}}};
  const source=binding("vendor","wire");
  const c=normalizeConfig({suppliers:{vendor:{name:"Vendor",interfaces:{responses:{protocol:"openai.responses",baseUrl:"https://example.invalid"}},models:{wire:model}}},cables:{one:{target:"codex",virtualProvider:"cabletidy_one",managedModels:true,suppliers:["vendor"],models:{pro:source}},two:{target:"codex",virtualProvider:"cabletidy_two",managedModels:true,suppliers:["vendor"],models:{pro:{...source,reasoning:{defaultEffort:"low",defaultBudget:null}}}}}});
  assert.deepEqual(c.cables.one.models.pro.reasoning,{defaultEffort:"high",defaultBudget:1024001});
  assert.deepEqual(c.cables.two.models.pro.reasoning,{defaultEffort:"low",defaultBudget:null});
  assert.deepEqual(c.suppliers.vendor.models.wire.reasoning,{modes:["effort","budget"],efforts:["low","high"],budget:{unit:"tokens",min:0,max:4096001}});
  assert.deepEqual(c.suppliers.vendor.models.wire.migration.reasoning,{default:"high",toggle:false,budgetDefault:1024001,ultra:true});
  assert.deepEqual(c.suppliers.vendor.models.wire.inputModalities,["text","audio"]);
  assert.equal(c.suppliers.vendor.models.wire.capabilityStates.parallel_tool_calls,"unsupported");
  assert.deepEqual(c.cables.one.models.pro.sources,source.sources);
  assert.deepEqual(normalizeConfig(c),c);
});

test("interface defaults with uncertain ownership stay in migration records",()=>{
  const model={...facts("deepseek-v4-pro"),reasoning:{modes:["effort"],efforts:["low","high"]},interfaceCapabilities:{responses:{toolForms:["function","custom"],reasoning:{default:"low",budget:{unit:"tokens",default:1024}}}}};
  const c=normalizeConfig({suppliers:{vendor:{name:"Vendor",interfaces:{responses:{protocol:"openai.responses",baseUrl:"https://example.invalid"}},models:{wire:model}}},cables:{work:{target:"codex",virtualProvider:"cabletidy_work",managedModels:true,suppliers:["vendor"],models:{pro:binding("vendor","wire")}}}});
  assert.equal(c.cables.work.models.pro.reasoning,undefined);
  assert.deepEqual(c.cables.work.models.pro.migration.sourceReasoningDefaults,[{defaultEffort:"low",defaultBudget:1024}]);
  assert.deepEqual(c.suppliers.vendor.models.wire.interfaceCapabilities.responses.migration.reasoning,{default:"low",budgetDefault:1024});
  assert.deepEqual(normalizeConfig(c),c);
});

test("MiniMax-M3 maps enabled client efforts to one supplied on value",async t=>{
  const received=[];
  const server=http.createServer(async(req,res)=>{let raw="";for await(const chunk of req)raw+=chunk;received.push(JSON.parse(raw));res.setHeader("content-type","application/json");res.end(JSON.stringify({id:"r",object:"response",output:[]}));});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"cabletidy-minimax-"));
  const app=await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalogFixture()});
  t.after(async()=>{await app.close();await new Promise(resolve=>server.close(resolve));await fs.rm(home,{recursive:true,force:true});});
  let c=(await (await fetch(`${app.url}api/v1/config`)).json()).config;
  const commit=async operation=>{const response=await fetch(`${app.url}api/v1/config/commit`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({baseRevision:c.revision,operation})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));c=result.config;};
  await commit(supplier("vendor",`http://127.0.0.1:${server.address().port}`));
  const model={...facts("MiniMax-M3"),reasoning:{modes:["effort"],efforts:["none","high"]}};
  await commit({type:"supplier.model.save",supplierId:"vendor",data:{modelId:"wire",model}});
  await commit({type:"cable.inventory.create",data:{id:"work",suppliers:["vendor"],models:{pro:binding("vendor","wire")},defaultModel:"pro"}});
  for (const effort of ["none","minimal","medium","max"]) {
    const response=await fetch(`${app.url}work/v1/responses`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"pro",input:"test",reasoning:{effort}})});
    assert.equal(response.status,200,await response.text());
    assert.equal(received.at(-1).reasoning.effort,effort === "none" ? "none" : "high");
  }
});

test("legacy manual groups retain their current source but new groups are rejected",async()=>{
  let c=normalizeConfig({});for(const sid of ["one","two"]){c=await edit(c,supplier(sid,"https://example.invalid"));c=await edit(c,supply(sid,"wire","deepseek-v4-pro"));}
  c.suppliers.two.models.wire.interfaceCapabilities.responses.toolForms=["custom","function"];
  const group={sources:[binding("one","wire").sources[0],binding("two","wire").sources[0]],activeSource:1,promptStrategy:"selected",promptModel:"gpt-5.5"};
  await assert.rejects(edit(c,{type:"cable.inventory.create",data:{id:"group",suppliers:["one","two"],models:{pro:group},defaultModel:"pro"}}),/只能绑定一个/);
  c=normalizeConfig({...c,cables:{group:{id:"group",name:"Group",target:"codex",virtualProvider:"cabletidy_group",managedModels:true,suppliers:["one","two"],models:{pro:group},defaultModel:"pro"}}});
  c=await edit(c,{type:"cable.inventory.save",cableId:"group",data:{suppliers:["one","two"],models:{pro:group},defaultModel:"pro"}});
  await assert.rejects(edit(c,{type:"cable.inventory.save",cableId:"group",data:{suppliers:["one","two"],models:{pro:{...group,activeSource:0}}}}),/只能绑定一个/);
  assert.equal(resolveRequest(c,c.virtualProviders.cabletidy_group,{model:"pro"}).upstream.id,"supplier.two.responses");
  c=await edit(c,{type:"supplier.model.delete",supplierId:"one",modelId:"wire"});
  assert.throws(()=>resolveRequest(c,c.virtualProviders.cabletidy_group,{model:"pro"}),/来源不存在/);
});

test("inventory export/import roundtrip isolates supplier collisions and credentials",async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"cabletidy-inventory-transfer-"));
  const app=await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalogFixture()});
  t.after(async()=>{await app.close();await fs.rm(home,{recursive:true,force:true});});
  const call=async(endpoint,body)=>{const r=await fetch(`${app.url}api/v1/${endpoint}`,body===undefined?{}:{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  let c=(await call("config")).body.config;
  const commit=async operation=>{const r=await call("config/commit",{baseRevision:c.revision,operation});assert.equal(r.status,200,JSON.stringify(r.body));c=r.body.config;};
  await commit(supplier("vendor","https://example.invalid/v1?credential=private"));await commit(supply("vendor","wire","deepseek-v4-pro"));
  await commit({type:"cable.inventory.create",data:{id:"work",suppliers:["vendor"],models:{alias:{...binding("vendor","wire"),aliases:["old-name"],codex:{contextWindow:64000,maxContextWindow:96000}}},defaultModel:"alias"}});
  const bundle=(await call("cables/export",{cableIds:["work"]})).body;
  assert.equal(bundle.config.cables.work.models.alias.aliases,undefined);
  assert.deepEqual(bundle.config.cables.work.models.alias.codex,{contextWindow:64000,maxContextWindow:96000});
  assert.equal(bundle.config.suppliers.vendor.models.wire.contextWindow,128000);
  assert.equal(bundle.version,2);assert.equal(bundle.config.suppliers.vendor.interfaces.responses.baseUrl,"https://example.invalid/v1");
  assert.equal(bundle.config.suppliers.vendor.interfaces.responses.secretRef,undefined);
  assert.equal(bundle.config.suppliers.vendor.interfaces.responses.supportsStreaming,true);
  assert.equal(bundle.config.suppliers.vendor.interfaces.responses.supportsResponseIdContinuation,false);
  assert.deepEqual(bundle.config.suppliers.vendor.models.wire.interfaceCapabilities.responses.toolForms,["function","custom"]);assert.deepEqual(bundle.config.cables.work.models.alias.sources,binding("vendor","wire").sources);
  assert.doesNotMatch(JSON.stringify(bundle),/supplier-fixture-key|private/);
  bundle.config.cables.work.models.alias.aliases=["old-name"];
  let r=await call("cables/import",{bundle,baseRevision:c.revision,useImportedCredentials:false,choices:{work:"create"}});assert.equal(r.status,200,JSON.stringify(r.body));c=r.body.config;
  assert.equal(c.cables["work-import-2"].models.alias.aliases,undefined);
  const imported=c.cables["work-import-2"];assert.deepEqual(imported.models.alias.codex,{contextWindow:64000,maxContextWindow:96000});assert.equal(imported.models.alias.sources[0].supplierId,"vendor-2");assert.equal(c.suppliers["vendor-2"].interfaces.responses.secretConfigured,false);
  assert.deepEqual(c.suppliers["vendor-2"].models.wire.interfaceCapabilities.responses.toolForms,["function","custom"]);
  assert.equal(c.suppliers["vendor-2"].models.wire.history,undefined);assert.equal(c.suppliers.vendor.interfaces.responses.secretConfigured,true);
  const withKeys=(await call("cables/export",{cableIds:["work"],includeCredentials:true})).body;
  r=await call("cables/import",{bundle:withKeys,baseRevision:c.revision,useImportedCredentials:true,choices:{work:"create"}});assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(r.body.config.suppliers["vendor-3"].interfaces.responses.secretConfigured,true);assert.equal(r.body.config.cables["work-import-3"].models.alias.sources[0].modelId,"wire");
  for (const [file,useImportedCredentials,expected] of [[bundle,false,false],[withKeys,false,false],[withKeys,true,true]]) {
    c=(await call("config")).body.config;
    const updated=await call("cables/import",{bundle:file,baseRevision:c.revision,useImportedCredentials,choices:{work:"update"}});
    assert.equal(updated.status,200,JSON.stringify(updated.body));
    const next=updated.body.config;
    const sid=next.cables.work.models.alias.sources[0].supplierId;
    assert.notEqual(sid,"vendor");
    assert.equal(next.suppliers[sid].interfaces.responses.secretConfigured,expected);
    assert.equal(next.suppliers.vendor.interfaces.responses.secretConfigured,true);
  }
});

test("Codex Cable activation restores the previous Cable and protects user edits",async t=>{
  const {prepareTargetArtifacts,applyCodexArtifacts,nativeAsync,readCodexConfig}=await import("./helpers/native.mjs");
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"cabletidy-activation-"));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const options={paths:getPaths(path.join(home,"gateway")),codexHome:path.join(home,"codex"),loadCatalog:async()=>catalogFixture()};
  await fs.mkdir(options.codexHome,{recursive:true});const root=path.join(options.codexHome,"config.toml");
  await fs.writeFile(root,'model_provider = "original"\nmodel = "old"\nweb_search = "cached"\n');
  let c=normalizeConfig({});c=await edit(c,supplier("vendor","https://example.invalid"));c=await edit(c,supply("vendor","wire","deepseek-v4-pro"));
  for(const name of ["A","B"])c=await edit(c,{type:"cable.inventory.create",data:{id:name.toLowerCase(),suppliers:["vendor"],models:{pro:binding("vendor","wire")},defaultModel:"pro"}});
  for(const cableId of ["a","b"])await applyCodexArtifacts(await prepareTargetArtifacts(c,{...options,cableId}),options);
  const afterB=await fs.readFile(root,"utf8");await assert.rejects(nativeAsync("codex.restore","a",options),/其他 Cable/);assert.equal(await fs.readFile(root,"utf8"),afterB);
  await nativeAsync("codex.restore","b",options);assert.equal(readCodexConfig(await fs.readFile(root,"utf8")).model_provider,"cabletidy_a");
  const appliedA=await fs.readFile(root,"utf8");await fs.writeFile(root,appliedA.replace('model = "pro"','model = "user-edit"'));
  await assert.rejects(nativeAsync("codex.restore","a",options),/用户修改/);
  await fs.writeFile(root,appliedA);await nativeAsync("codex.restore","a",options);const restored=readCodexConfig(await fs.readFile(root,"utf8"));assert.equal(restored.model_provider,"original");assert.equal(restored.web_search,"cached");assert.equal(restored.model_catalog_json,undefined);
});

test("Responses streaming tools, cleartext reasoning history and DeepSeek effort mapping",async t=>{
  const received=[];const patch="*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
  const output=[{type:"reasoning",id:"reason",summary:[],content:[{type:"reasoning_text",text:"inspect first"}]},{type:"function_call",id:"fn",name:"exec_command",call_id:"exec",arguments:'{"cmd":"pwd"}'},{type:"custom_tool_call",id:"patch",name:"apply_patch",call_id:"patch-call",input:patch}];
  const upstream=http.createServer(async(req,res)=>{let raw="";for await(const b of req)raw+=b;const body=JSON.parse(raw);received.push(body);res.writeHead(200,{"content-type":"text/event-stream"});const events=[{type:"response.created",response:{id:"r",model:body.model,status:"in_progress"}},...output.map((item,output_index)=>({type:"response.output_item.done",output_index,item})),{type:"response.completed",response:{id:"r",model:body.model,status:"completed",output}}];for(const event of events)res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);res.end();});
  await new Promise(r=>upstream.listen(0,"127.0.0.1",r));const home=await fs.mkdtemp(path.join(os.tmpdir(),"cabletidy-response-tools-"));const app=await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalogFixture()});
  t.after(async()=>{await app.close();await new Promise(r=>upstream.close(r));await fs.rm(home,{recursive:true,force:true});});
  const post=async(endpoint,body)=>fetch(`${app.url}${endpoint}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  let c=(await(await fetch(`${app.url}api/v1/config`)).json()).config;
  const commit=async operation=>{const r=await post("api/v1/config/commit",{baseRevision:c.revision,operation});const v=await r.json();assert.equal(r.status,200,JSON.stringify(v));c=v.config;};
  await commit(supplier("deepseek",`http://127.0.0.1:${upstream.address().port}`));await commit(supply("deepseek","deepseek-v4-pro","deepseek-v4-pro"));await commit({type:"cable.inventory.create",data:{id:"stream",suppliers:["deepseek"],models:{pro:binding("deepseek","deepseek-v4-pro")},defaultModel:"pro"}});
  const tools=[{type:"function",name:"exec_command",parameters:{type:"object"}},{type:"custom",name:"apply_patch",format:{type:"text"}}];
  const r=await post("stream/v1/responses",{model:"pro",stream:true,input:"test",reasoning:{effort:"medium",summary:"auto"},include:["reasoning.encrypted_content"],parallel_tool_calls:true,tools:[{type:"tool_search",execution:"client"},...tools,{type:"namespace",name:"multi_agent_v1",tools:[]},{type:"tool_search",execution:"client"}]});assert.equal(r.status,200);const events=await r.text();assert.match(events,/"model":"pro"/);assert.ok(events.includes("custom_tool_call"));assert.equal(received[0].reasoning.effort,"high");assert.deepEqual(received[0].include,[]);assert.equal(received[0].store,false);assert.deepEqual(received[0].tools,tools);assert.equal(received[0].parallel_tool_calls,false);
  const history=[{role:"user",content:"test"},...output,{type:"function_call_output",call_id:"exec",output:"/tmp"},{type:"custom_tool_call_output",call_id:"patch-call",output:"success"},{role:"user",content:"continue"}];
  const next=await post("stream/v1/responses",{model:"pro",stream:true,input:history,reasoning:{effort:"xhigh"},tools});assert.equal(next.status,200);await next.text();assert.deepEqual(received[1].input,history);
  const isolated=await post("api/v1/targets/isolated",{cableId:"stream"});assert.equal(isolated.status,200);const bundle=(await isolated.json()).bundle;assert.equal(bundle.files.length,2);assert.doesNotMatch(JSON.stringify(bundle),/supplier-fixture-key/);
  const bad=await post("stream/v1/responses",{model:"pro",input:history,tools:[{type:"computer_use_preview"}]});assert.equal(bad.status,422);assert.equal(received.length,2);
});


test("interface differences inherit other declared capabilities and protocol drafts stay unavailable",async()=>{
  let c=normalizeConfig({});c=await edit(c,supplier("vendor","https://example.invalid"));
  const model={...facts("deepseek-v4-pro"),interfaceCapabilities:{responses:{toolForms:["function","custom"],capabilityStates:{vision:"unsupported"},contextWindow:64000}}};
  c=await edit(c,{type:"supplier.model.save",supplierId:"vendor",data:{modelId:"wire",model}});
  c=await edit(c,{type:"cable.inventory.create",data:{id:"diff",suppliers:["vendor"],models:{pro:binding("vendor","wire")},defaultModel:"pro"}});
  const entry=planCodexCatalog(c,c.virtualProviders.cabletidy_diff,catalogFixture()).catalog.models[0];assert.equal(entry.context_window,64000);assert.equal(resolveRequest(c,c.virtualProviders.cabletidy_diff,{model:"pro"}).upstreamModelId,"wire");
});

test("associations only narrow model and interface declarations in saving and runtime",async()=>{
  let c=normalizeConfig({});
  c=await edit(c,supplier("bounds","https://example.invalid"));
  const parent={...facts("deepseek-v4-pro"),inputModalities:["text"],capabilityStates:{reasoning:"supported",parallel_tool_calls:"unsupported"},contextWindow:128000,maxOutputTokens:8192,reasoning:{modes:["effort","budget"],efforts:["low","high"],budget:{unit:"tokens",min:1024,max:8192}}};
  c=await edit(c,{type:"supplier.model.save",supplierId:"bounds",data:{modelId:"wire",model:parent}});
  c=await edit(c,{type:"cable.inventory.create",data:{id:"bounds",suppliers:["bounds"],models:{pro:binding("bounds","wire")},defaultModel:"pro"}});
  const invalid=[{capabilityStates:{parallel_tool_calls:"supported"}},{capabilityStates:{vision:"supported"}},{capabilities:["reasoning","vision"]},{inputModalities:["text","image"]},{contextWindow:128001},{maxOutputTokens:8193},{reasoning:{modes:["toggle"]}},{reasoning:{efforts:["max"]}},{reasoning:{budget:{unit:"seconds",min:1024,max:8192}}},{reasoning:{budget:{min:1000}}},{reasoning:{budget:{max:9000}}},{reasoning:{budget:{min:9000}}},{reasoning:{budget:{max:1000}}}];
  for (const difference of invalid) {
    const model={...parent,interfaceCapabilities:{responses:{toolForms:["function","custom"],...difference}}};
    await assert.rejects(edit(c,{type:"supplier.model.save",supplierId:"bounds",data:{oldModelId:"wire",modelId:"wire",model}}),/模型未声明|公共|预算/);
    const legacy=structuredClone(c); legacy.suppliers.bounds.models.wire=model;
    const normalized=normalizeConfig(legacy);
    assert.equal(validateConfig(normalized).ok,false);
    assert.match(normalized.virtualProviders.cabletidy_bounds.models.pro.sourceError,/关联配置越界/);
    assert.throws(()=>resolveRequest(normalized,normalized.virtualProviders.cabletidy_bounds,{model:"pro"}),/关联配置越界/);
  }
  const valid={...parent,interfaceCapabilities:{responses:{toolForms:["function","custom"],contextWindow:64000,maxOutputTokens:4096,inputModalities:["text"],reasoning:{modes:["effort","budget"],efforts:["high"],budget:{unit:"tokens",min:2048,max:4096}}}}};
  c=await edit(c,{type:"supplier.model.save",supplierId:"bounds",data:{oldModelId:"wire",modelId:"wire",model:valid}});
  assert.equal(validateConfig(c).ok,true);
  const effective=c.virtualProviders.cabletidy_bounds.models.pro;
  assert.equal(effective.contextWindow,64000); assert.equal(effective.maxOutputTokens,4096);
  assert.deepEqual(effective.reasoning.efforts,["high"]); assert.deepEqual(effective.reasoning.budget,{unit:"tokens",min:2048,max:4096});
  const shrunk=structuredClone(c); shrunk.suppliers.bounds.models.wire.contextWindow=32000;
  assert.match(normalizeConfig(shrunk).virtualProviders.cabletidy_bounds.models.pro.sourceError,/关联配置越界/);
  const noStream=structuredClone(c); noStream.suppliers.bounds.interfaces.responses.supportsStreaming=false;
  noStream.suppliers.bounds.models.wire.interfaceCapabilities.responses.supportsStreaming=true;
  assert.equal(validateConfig(noStream).ok,false);
  assert.match(normalizeConfig(noStream).virtualProviders.cabletidy_bounds.models.pro.sourceError,/接口不支持流式/);
});

test("association inheritance stays sparse and legacy restrictions narrow the effective contract",async()=>{
  let c=normalizeConfig({});
  c=await edit(c,supplier("inherit","https://example.invalid"));
  const model={...facts("deepseek-v4-pro"),capabilities:["reasoning","vision","parallel_tool_calls"],capabilityStates:{reasoning:"supported",vision:"supported"},inputModalities:["text","image","audio"],reasoning:{modes:["effort","budget"],efforts:["low","high"],budget:{unit:"tokens",min:1024,max:8192}}};
  c=await edit(c,{type:"supplier.model.save",supplierId:"inherit",data:{modelId:"wire",model}});
  c=await edit(c,{type:"cable.inventory.create",data:{id:"inherit",suppliers:["inherit"],models:{pro:binding("inherit","wire")},defaultModel:"pro"}});
  let effective=c.virtualProviders.cabletidy_inherit.models.pro;
  assert.deepEqual(effective.inputModalities,["text","image","audio"]);
  assert.ok(effective.capabilities.includes("parallel_tool_calls"));
  const changed={...model,contextWindow:256000,reasoning:{...model.reasoning,budget:{unit:"tokens",min:2048,max:16384}}};
  c=await edit(c,{type:"supplier.model.save",supplierId:"inherit",data:{oldModelId:"wire",modelId:"wire",model:changed}});
  assert.deepEqual(c.suppliers.inherit.models.wire.interfaceCapabilities.responses,{toolForms:["function","custom"]});
  assert.equal(c.virtualProviders.cabletidy_inherit.models.pro.contextWindow,256000);
  assert.deepEqual(c.virtualProviders.cabletidy_inherit.models.pro.reasoning.budget,changed.reasoning.budget);
  const restricted={...changed,interfaceCapabilities:{responses:{toolForms:["function","custom"],capabilities:["reasoning"],contextWindow:null,reasoning:{budget:{min:null,max:8192,unit:null}}}}};
  c=await edit(c,{type:"supplier.model.save",supplierId:"inherit",data:{oldModelId:"wire",modelId:"wire",model:restricted}});
  effective=c.virtualProviders.cabletidy_inherit.models.pro;
  assert.deepEqual(effective.inputModalities,["text","audio"]);
  assert.equal(effective.capabilities.includes("vision"),false);
  assert.equal(effective.capabilities.includes("parallel_tool_calls"),false);
  assert.equal(effective.contextWindow,256000);
  assert.deepEqual(effective.reasoning.budget,{unit:"tokens",min:2048,max:8192});
  assert.equal(c.suppliers.inherit.models.wire.interfaceCapabilities.responses.contextWindow,null);
});

test("legacy association violations stay blocked but can be repaired one record at a time",async t=>{
  let c=normalizeConfig({});
  c=await edit(c,supplier("legacy","https://example.invalid"));
  for (const id of ["one","two"]) c=await edit(c,supply("legacy",id,"deepseek-v4-pro"));
  c=await edit(c,{type:"cable.inventory.create",data:{id:"legacy",suppliers:["legacy"],models:{one:binding("legacy","one"),two:binding("legacy","two")},defaultModel:"one"}});
  for (const model of Object.values(c.suppliers.legacy.models)) model.interfaceCapabilities.responses.contextWindow=256000;
  c=normalizeConfig(c);
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"cabletidy-association-repair-"));
  const paths=getPaths(home);await fs.writeFile(paths.config,JSON.stringify(c));
  const app=await createApplication({paths,ephemeralPort:true,loadCodexCatalog:async()=>catalogFixture()});
  t.after(async()=>{await app.close();await fs.rm(home,{recursive:true,force:true});});
  const request=async operation=>fetch(`${app.url}api/v1/config/commit`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({baseRevision:c.revision,operation})});
  c=(await(await fetch(`${app.url}api/v1/config`)).json()).config;
  assert.equal(validateConfig(c).ok,false);
  assert.match(c.virtualProviders.cabletidy_legacy.models.one.sourceError,/关联配置越界/);
  assert.deepEqual((await(await fetch(`${app.url}legacy/v1/models`)).json()).data,[]);
  const rejected=await request({type:"supplier.model.save",supplierId:"legacy",data:{oldModelId:"one",modelId:"one",model:c.suppliers.legacy.models.one}});
  assert.equal(rejected.status,422);
  const valid={...c.suppliers.legacy.models.one,interfaceCapabilities:{responses:{toolForms:["function","custom"]}}};
  const repair=await request({type:"supplier.model.save",supplierId:"legacy",data:{oldModelId:"one",modelId:"one",model:valid}});
  assert.equal(repair.status,200,await repair.clone().text());c=(await repair.json()).config;
  assert.equal(c.virtualProviders.cabletidy_legacy.models.one.sourceError,undefined);
  assert.match(c.virtualProviders.cabletidy_legacy.models.two.sourceError,/关联配置越界/);
  assert.deepEqual((await(await fetch(`${app.url}legacy/v1/models`)).json()).data.map(model=>model.id),["one"]);
  const expanded={...c.suppliers.legacy.models.one,interfaceCapabilities:{responses:{toolForms:["function","custom"],contextWindow:512000}}};
  assert.equal((await request({type:"supplier.model.save",supplierId:"legacy",data:{oldModelId:"one",modelId:"one",model:expanded}})).status,422);
  const final=await request({type:"supplier.model.save",supplierId:"legacy",data:{oldModelId:"two",modelId:"two",model:valid}});
  assert.equal(final.status,200,await final.clone().text());c=(await final.json()).config;
  assert.equal(validateConfig(c).ok,true);
});

test("drafts retain unknown supply facts and empty bindings without requiring a Codex catalog",async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"cabletidy-inventory-drafts-"));
  let catalogCalls=0;
  const app=await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>{catalogCalls++;throw new Error("Codex not installed");}});
  t.after(async()=>{await app.close();await fs.rm(home,{recursive:true,force:true});});
  let c=(await(await fetch(`${app.url}api/v1/config`)).json()).config;
  const commit=async operation=>{const r=await fetch(`${app.url}api/v1/config/commit`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({baseRevision:c.revision,operation})});const v=await r.json();assert.equal(r.status,200,JSON.stringify(v));c=v.config;};
  await commit(supplier("draft","https://example.invalid"));
  await commit({type:"supplier.model.save",supplierId:"draft",data:{modelId:"token",model:{identity:null,interfaces:["responses"],capabilityStates:{reasoning:"unknown"},contextWindow:null,maxOutputTokens:null}}});
  await commit({type:"cable.inventory.create",data:{id:"draft",suppliers:["draft"],models:{token:binding("draft","token"),pending:{sources:[],activeSource:0}},defaultModel:"token"}});
  assert.equal(catalogCalls,0);
  assert.equal(c.suppliers.draft.models.token.contextWindow,null);assert.ok(c.cables.draft.models.token);
  assert.match(c.virtualProviders.cabletidy_draft.models.pending.sourceError,/来源不存在/);
  const list=await(await fetch(`${app.url}draft/v1/models`)).json();assert.deepEqual(list.data,[]);
  assert.throws(()=>resolveRequest(c,c.virtualProviders.cabletidy_draft,{model:"token"}),/身份未知/);
});

test("apply permits no default and native capabilities stay inside the installed definition",async()=>{
  let c=normalizeConfig({});c=await edit(c,supplier("native","https://example.invalid"));
  c=await edit(c,{type:"supplier.model.save",supplierId:"native",data:{modelId:"wire",model:{...facts("gpt-5.5"),capabilityStates:{...facts("gpt-5.5").capabilityStates,vision:"supported"},inputModalities:["text","image"]}}});
  c=await edit(c,{type:"cable.inventory.create",data:{id:"native",suppliers:["native"],models:{alias:binding("native","wire")}}});
  assert.equal(buildTargetArtifacts(c,{cableId:"native"}).clientModelId,null);
  const snapshot=catalogFixture();snapshot.catalog.models[0].input_modalities=["text"];
  assert.deepEqual(planCodexCatalog(c,c.virtualProviders.cabletidy_native,snapshot).catalog.models[0].input_modalities,["text"]);
  const malformed=normalizeConfig({suppliers:{broken:{name:"Broken",interfaces:{responses:null},models:{}}}});
  assert.equal(validateConfig(malformed).ok,false);assert.doesNotThrow(()=>publicConfig(malformed));
});

test("interface facts and reasoning budgets are validated without enabling user-defined adaptation",async()=>{
  let c=normalizeConfig({});c=await edit(c,supplier("vendor","https://example.invalid"));
  const check=model=>validateConfig(normalizeConfig({...c,suppliers:{vendor:{...c.suppliers.vendor,models:{wire:model}}}}));
  for(const difference of [{contextWindow:-1},{toolForms:["freeform"]},{reasoning:{modes:["script"]}},{reasoning:{budget:{unit:"tokens",min:100,max:50}}},{identity:"gpt-5.5"}]) {
    assert.equal(check({...facts("deepseek-v4-pro"),interfaceCapabilities:{responses:difference}}).ok,false,JSON.stringify(difference));
  }
  assert.equal(check({...facts("deepseek-v4-pro"),codex:{metadataMode:"override"}}).ok,false);
  const budgetModel={...facts("deepseek-v4-pro"),reasoning:{modes:["budget","toggle"],toggle:false,budget:{unit:"tokens",min:0,max:4096,default:1024}}};
  assert.equal(check(budgetModel).ok,true);
  c=await edit(c,{type:"supplier.model.save",supplierId:"vendor",data:{modelId:"budget",model:budgetModel}});
  c=await edit(c,{type:"cable.inventory.create",data:{id:"budget",suppliers:["vendor"],models:{pro:binding("vendor","budget")},defaultModel:"pro"}});
  assert.throws(()=>resolveRequest(c,c.virtualProviders.cabletidy_budget,{model:"pro"}),/暂无内置映射/);
});

test("Codex bindings discard legacy aliases and publish only the client model ID",async()=>{
  let c=normalizeConfig({});c=await edit(c,supplier("vendor","https://example.invalid"));c=await edit(c,supply("vendor","wire","deepseek-v4-pro"));
  c=await edit(c,{type:"cable.inventory.create",data:{id:"single",suppliers:["vendor"],models:{pro:{...binding("vendor","wire"),aliases:["quick","token"]}},defaultModel:"pro"}});
  const check=current=>{
    assert.equal(current.cables.single.models.pro.aliases,undefined);
    const provider=current.virtualProviders.cabletidy_single;
    assert.equal(provider.models.pro.aliases,undefined);
    const plan=planCodexCatalog(current,provider,catalogFixture());
    assert.deepEqual(plan.catalog.models.map(model=>model.slug),["pro"]);
    assert.deepEqual(plan.models,["pro"]);
    assert.equal(resolveRequest(current,provider,{model:"pro"}).upstreamModelId,"wire");
    for(const alias of ["quick","token"]) assert.throws(()=>resolveRequest(current,provider,{model:alias}),/未在当前 Cable 中开放/);
  };
  check(c);
  c.cables.single.models.pro.aliases=["quick","token"];
  c=normalizeConfig(c);
  check(c);
  assert.deepEqual(normalizeConfig(c),c);
  c=await edit(c,{type:"cable.inventory.save",cableId:"single",data:{suppliers:["vendor"],models:{pro:{...c.cables.single.models.pro,aliases:["quick","token"]}},defaultModel:"pro"}});
  check(c);
  // Missing source profiles must not revive aliases either.
  delete c.suppliers.vendor.models.wire;
  c.cables.single.models.pro.aliases=["quick"];
  c=normalizeConfig(c);
  assert.equal(c.virtualProviders.cabletidy_single.models.pro.aliases,undefined);
  assert.throws(()=>resolveRequest(c,c.virtualProviders.cabletidy_single,{model:"quick"}),/未在当前 Cable 中开放/);
});

test("supplier resource operations generate internal IDs and select protocol authentication", async () => {
  let c = normalizeConfig({});
  const create = {type:"supplier.create",data:{name:"Official",interface:{protocol:"openai.responses",baseUrl:"https://example.invalid/v1",authMethod:"bearer",secret:"fixture-token"}}};
  const first = await applyConfigOperation(c, create, catalogFixture());
  const sid = first.selection.supplierId;
  assert.match(sid, /^s-[a-f0-9]{20}$/);
  assert.equal(first.page, "supplier-detail");
  assert.equal(first.selection.interfaceId, "responses");
  assert.equal(first.config.suppliers[sid].interfaces.responses.supportsStreaming, true);
  assert.equal(first.config.suppliers[sid].interfaces.responses.supportsResponseIdContinuation, false);
  c = first.config;
  const second = await applyConfigOperation(c, create, catalogFixture());
  assert.notEqual(second.selection.supplierId, sid);
  assert.equal(Object.keys(second.config.suppliers).length, 2);
  for (const [protocol, method, header, scheme] of [
    ["openai.responses", "bearer", "authorization", "Bearer"],
    ["openai.responses", "api-key", "api-key", ""],
    ["openai.chat_completions", "bearer", "authorization", "Bearer"],
    ["anthropic.messages", "api-key", "x-api-key", ""],
    ["anthropic.messages", "bearer", "authorization", "Bearer"],
    ["gemini.generate_content", "api-key", "x-goog-api-key", ""],
    ["gemini.generate_content", "bearer", "authorization", "Bearer"],
  ]) {
    const result = await applyConfigOperation(c, {type:"supplier.interface.save",supplierId:sid,data:{interface:{protocol,baseUrl:"https://example.invalid",authMethod:method,secret:"fixture-token"}}}, catalogFixture());
    c = result.config;
    const value = c.suppliers[sid].interfaces[result.selection.interfaceId];
    assert.deepEqual(value.auth, {method,header,scheme});
    assert.equal(value.secret, undefined);
    assert.equal(validateConfig(c).ok, true);
  }
  await assert.rejects(edit(c, {type:"supplier.interface.save",supplierId:sid,data:{interface:{protocol:"openai.responses",baseUrl:"https://example.invalid",authMethod:"custom"}}}), /认证方式/);
  const invalid = structuredClone(c);
  invalid.suppliers[sid].interfaces.responses.auth.header = "arbitrary-header";
  assert.equal(validateConfig(invalid).ok, false);
  c = await edit(c, supply(sid, "wire", "deepseek-v4-pro"));
  c = await edit(c, {type:"cable.inventory.create",data:{id:"stable",suppliers:[sid],models:{pro:binding(sid,"wire")},defaultModel:"pro"}});
  const oldSupplier = structuredClone(c.suppliers[sid]);
  c = await edit(c, {type:"supplier.metadata.save",supplierId:sid,data:{name:"Renamed",enabled:true}});
  assert.deepEqual(c.suppliers[sid], {...oldSupplier,name:"Renamed"});
  assert.equal(c.cables.stable.models.pro.sources[0].supplierId, sid);
  await assert.rejects(edit(c, {type:"supplier.interface.delete",supplierId:sid,interfaceId:"responses"}), /模型使用/);
  c = await edit(c, {type:"supplier.interface.delete",supplierId:sid,interfaceId:"responses-2"});
  assert.equal(c.suppliers[sid].interfaces["responses-2"], undefined);
});

test("supplier authentication requires credentials only for the edited interface and forwards builtin headers", async t => {
  const received = [];
  const upstream = http.createServer((req,res) => {
    received.push(req.headers);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({data:[{id:"wire"}]}));
  });
  await new Promise(resolve => upstream.listen(0,"127.0.0.1",resolve));
  const home = await fs.mkdtemp(path.join(os.tmpdir(),"cabletidy-supplier-auth-"));
  const app = await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalogFixture()});
  t.after(async () => {await app.close();await new Promise(resolve=>upstream.close(resolve));await fs.rm(home,{recursive:true,force:true});});
  const url = `http://127.0.0.1:${upstream.address().port}`;
  const call = async (endpoint,body) => {
    const response = await fetch(`${app.url}api/v1/${endpoint}`, body === undefined ? {} : {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  let c = (await call("config")).body.config;
  const commit = async (operation,status=200) => {
    const result = await call("config/commit",{baseRevision:c.revision,operation});
    assert.equal(result.status,status,JSON.stringify(result.body));
    if (status===200) c=result.body.config;
    return result;
  };
  // An imported draft without a credential must not block another supplier's edits.
  await commit({type:"supplier.save",supplierId:"draft",data:{name:"Draft",interfaces:{responses:{protocol:"openai.responses",baseUrl:url,auth:{method:"bearer",header:"authorization",scheme:"Bearer"}}}}});
  const create = secret => ({type:"supplier.create",data:{name:"Local",interface:{name:"Official Responses",protocol:"openai.responses",baseUrl:url,authMethod:"bearer",secret}}});
  const missing = await commit(create(""),422);
  assert.equal(missing.body.error.code,"credential_required");
  const created = await commit(create("fixture-auth-token"));
  const sid = created.body.selection.supplierId;
  const update = (method,secret="") => ({type:"supplier.interface.save",supplierId:sid,data:{interfaceId:"responses",interface:{protocol:"openai.responses",baseUrl:url,authMethod:method,secret}}});
  const discover = async () => {const result=await call("suppliers/discover",{supplierId:sid,interfaceId:"responses"});assert.equal(result.status,200,JSON.stringify(result.body));return received.at(-1);};
  assert.equal((await discover()).authorization,"Bearer fixture-auth-token");
  await commit(update("bearer"));
  assert.equal((await discover()).authorization,"Bearer fixture-auth-token");
  await commit(update("api-key","fixture-api-key"));
  const keyHeaders = await discover();
  assert.equal(keyHeaders["api-key"],"fixture-api-key");
  assert.equal(keyHeaders.authorization,undefined);
  await commit(update("none"));
  const noAuth = await discover();
  assert.equal(noAuth.authorization,undefined);
  assert.equal(noAuth["api-key"],undefined);
  const add = {type:"supplier.interface.save",supplierId:sid,data:{interface:{protocol:"gemini.generate_content",baseUrl:url,authMethod:"api-key"}}};
  await commit(add,422);
  await commit({...add,data:{interface:{...add.data.interface,authMethod:"none"}}});
  await commit(supply(sid,"wire","deepseek-v4-pro"));
  await commit({type:"cable.inventory.create",data:{id:"portable",suppliers:[sid],models:{pro:binding(sid,"wire")},defaultModel:"pro"}});
  const exported = await call("cables/export",{cableIds:["portable"]});
  assert.equal(exported.status,200,JSON.stringify(exported.body));
  const portable = exported.body.config.suppliers[sid].interfaces.responses;
  assert.equal(portable.name,"Official Responses");
  assert.deepEqual(portable.auth,{method:"none"});
  const imported = await call("cables/import",{bundle:exported.body,baseRevision:c.revision,useImportedCredentials:false,choices:{portable:"create"}});
  assert.equal(imported.status,200,JSON.stringify(imported.body));
  const importedId = imported.body.config.cables["portable-import-2"].suppliers[0];
  assert.equal(imported.body.config.suppliers[importedId].interfaces.responses.name,"Official Responses");
  assert.deepEqual(imported.body.config.suppliers[importedId].interfaces.responses.auth,{method:"none"});
  assert.doesNotMatch(JSON.stringify(c), /fixture-auth-token|fixture-api-key/);
});

test("supplier creation saves multiple interfaces and model facts atomically", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-supplier-create-"));
  const app = await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalogFixture()});
  t.after(async () => {await app.close();await fs.rm(home,{recursive:true,force:true});});
  const read = async () => (await (await fetch(`${app.url}api/v1/config`)).json()).config;
  const initial = await read();
  const create = {
    type:"supplier.create",
    data:{name:"Multi API",interfaces:{
      responses:{name:"Responses",protocol:"openai.responses",baseUrl:"https://example.invalid/v1",authMethod:"none"},
      messages:{name:"Messages",protocol:"anthropic.messages",baseUrl:"https://example.invalid",authMethod:"api-key",secret:"fixture-messages-key"},
    },models:{wire:{identity:null,interfaces:["responses","messages"]},another:{identity:"kimi-k3",interfaces:["responses"]}}},
  };
  const commit = async (operation, status) => {
    const response = await fetch(`${app.url}api/v1/config/commit`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({baseRevision:initial.revision,operation})});
    const body = await response.json();
    assert.equal(response.status,status,JSON.stringify(body));
    return body;
  };
  const missing = structuredClone(create);
  delete missing.data.interfaces.messages.secret;
  assert.equal((await commit(missing,422)).error.code,"credential_required");
  assert.deepEqual(await read(), initial);
  const invalid = structuredClone(create);
  invalid.data.models.wire.interfaces = ["missing"];
  await commit(invalid,422);
  assert.deepEqual(await read(), initial);
  const empty = structuredClone(create);
  empty.data.interfaces = {};
  await commit(empty,422);
  assert.deepEqual(await read(), initial);
  const result = await commit(create,200);
  const supplier = result.config.suppliers[result.selection.supplierId];
  assert.deepEqual(Object.keys(supplier.interfaces),["responses","messages"]);
  assert.deepEqual(Object.keys(supplier.models),["wire","another"]);
  assert.deepEqual(supplier.models.wire.interfaces,["responses","messages"]);
  assert.deepEqual(supplier.interfaces.messages.auth,{method:"api-key",header:"x-api-key",scheme:""});
  assert.equal(supplier.interfaces.messages.secretConfigured,true);
  assert.equal(result.config.revision,initial.revision+1);
  assert.doesNotMatch(JSON.stringify(result.config),/fixture-messages-key/);
});

test("interface streaming and model-interface tool forms constrain the published contract", async () => {
  let c = normalizeConfig({});
  c = await edit(c, supplier("vendor", "https://example.invalid"));
  c = await edit(c, supply("vendor", "wire", "deepseek-v4-pro"));
  c = await edit(c, {type:"cable.inventory.create", data:{id:"contract", suppliers:["vendor"], models:{pro:binding("vendor","wire")}, defaultModel:"pro"}});
  const changed = (interfaceFacts, modelFacts = {}) => normalizeConfig({...c,suppliers:{vendor:{...c.suppliers.vendor,interfaces:{responses:{...c.suppliers.vendor.interfaces.responses,...interfaceFacts}},models:{wire:{...c.suppliers.vendor.models.wire,interfaceCapabilities:{responses:{toolForms:["function","custom"],...modelFacts}}}}}}});
  for (const unavailable of [changed({supportsStreaming:false},{supportsStreaming:true}), changed({}, {supportsStreaming:false}), changed({}, {supportsStreaming:null})]) {
    assert.throws(() => resolveRequest(unavailable, unavailable.virtualProviders.cabletidy_contract,{model:"pro"}), /流式/);
  }
  for (const toolForms of [[],["function"],["custom"]]) {
    const unavailable = changed({}, {toolForms});
    assert.throws(() => planCodexCatalog(unavailable,unavailable.virtualProviders.cabletidy_contract,catalogFixture()), /工具/);
  }
  const enabled = changed({supportsResponseIdContinuation:true});
  assert.equal(planCodexCatalog(enabled,enabled.virtualProviders.cabletidy_contract,catalogFixture()).catalog.models[0].apply_patch_tool_type,"freeform");
  const another = changed({}, {toolForms:["function"]});
  another.suppliers.vendor.interfaces.alternate = {...another.suppliers.vendor.interfaces.responses};
  another.suppliers.vendor.models.wire.interfaces.push("alternate");
  another.suppliers.vendor.models.wire.interfaceCapabilities.alternate = {toolForms:["function","custom"]};
  another.cables.contract.models.other = {...binding("vendor","wire"),sources:[{supplierId:"vendor",modelId:"wire",interfaceId:"alternate"}]};
  const multi = normalizeConfig(another);
  assert.throws(() => planCodexCatalog(multi,multi.virtualProviders.cabletidy_contract,catalogFixture()), /custom 工具形式/);
  multi.cables.contract.defaultModel = "other";
  const available = normalizeConfig(multi);
  const plan = planCodexCatalog(available,available.virtualProviders.cabletidy_contract,catalogFixture());
  assert.deepEqual(plan.models,["other"]);
});

test("old supply migration preserves streaming restrictions without inferring custom tools or history policy", () => {
  const c = normalizeConfig({suppliers:{old:{name:"Old",interfaces:{responses:{protocol:"openai.responses",baseUrl:"https://example.invalid"}},models:{wire:{identity:"deepseek-v4-pro",interfaces:["responses"],capabilityStates:{tools:"supported",streaming:"unsupported"},history:"native"}}}}});
  const m = c.suppliers.old.models.wire;
  assert.equal(c.suppliers.old.interfaces.responses.supportsStreaming,true);
  assert.equal(c.suppliers.old.interfaces.responses.supportsResponseIdContinuation,false);
  assert.deepEqual(m.interfaceCapabilities.responses.toolForms,[]);
  assert.equal(m.interfaceCapabilities.responses.supportsStreaming,false);
  assert.equal(m.history,undefined);
  assert.equal(m.capabilityStates.tools,undefined);
  assert.deepEqual(normalizeConfig(c),c);
  const oldNull=structuredClone(c);oldNull.suppliers.old.models.wire.history=null;
  assert.equal(normalizeConfig(oldNull).suppliers.old.models.wire.history,undefined);
  assert.equal(validateConfig(c).ok,true);
  for (const toolForms of [true,["freeform"],["custom","custom"]]) {
    const invalid = structuredClone(c);
    invalid.suppliers.old.models.wire.interfaceCapabilities.responses.toolForms = toolForms;
    assert.equal(validateConfig(invalid).ok,false);
  }
  for (const field of ["supportsStreaming","supportsResponseIdContinuation"]) {
    const invalid = structuredClone(c);
    invalid.suppliers.old.interfaces.responses[field] = "yes";
    assert.equal(validateConfig(invalid).ok,false);
  }
});

test("native remote history requires declared continuation and undeclared custom tools are rejected", async t => {
  const received = [];
  const upstream = http.createServer(async (req,res) => {let raw="";for await (const b of req) raw+=b;const body=JSON.parse(raw);received.push(body);res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"r",model:body.model,output:[]}));});
  await new Promise(resolve => upstream.listen(0,"127.0.0.1",resolve));
  const home = await fs.mkdtemp(path.join(os.tmpdir(),"cabletidy-native-forms-"));
  const app = await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalogFixture()});
  t.after(async()=>{await app.close();await new Promise(resolve=>upstream.close(resolve));await fs.rm(home,{recursive:true,force:true});});
  const call=async(endpoint,body)=>fetch(`${app.url}${endpoint}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  let c=(await(await fetch(`${app.url}api/v1/config`)).json()).config;
  const commit=async operation=>{const result=await call("api/v1/config/commit",{baseRevision:c.revision,operation});const v=await result.json();assert.equal(result.status,200,JSON.stringify(v));c=v.config;};
  await commit(supplier("native",`http://127.0.0.1:${upstream.address().port}`));
  await commit(supply("native","wire","gpt-5.5"));
  await commit({type:"cable.inventory.create",data:{id:"native-state",suppliers:["native"],models:{gpt:binding("native","wire")},defaultModel:"gpt"}});
  const remote={model:"gpt",previous_response_id:"r",input:"next"};
  assert.equal((await call("native-state/v1/responses",remote)).status,422);
  assert.equal(received.length,0);
  await commit({type:"supplier.interface.save",supplierId:"native",data:{interfaceId:"responses",interface:{protocol:"openai.responses",baseUrl:`http://127.0.0.1:${upstream.address().port}`,authMethod:"bearer",supportsResponseIdContinuation:true}}});
  assert.equal((await call("native-state/v1/responses",remote)).status,200);
  assert.equal(received[0].previous_response_id,"r");
  await commit({type:"supplier.model.save",supplierId:"native",data:{oldModelId:"wire",modelId:"wire",model:{...facts("gpt-5.5"),interfaceCapabilities:{responses:{toolForms:["function"]}}}}});
  const custom={model:"gpt",input:"patch",tools:[{type:"custom",name:"apply_patch",format:{type:"text"}}]};
  assert.equal((await call("native-state/v1/responses",custom)).status,422);
  const namespaced={...custom,tools:[{type:"namespace",name:"workspace",tools:custom.tools}]};
  assert.equal((await call("native-state/v1/responses",namespaced)).status,422);
  assert.equal(received.length,1);
});

test('saving model bindings releases unused suppliers but keeps referenced suppliers protected',async()=>{
  let c=normalizeConfig({});
  for(const sid of ['one','two']) {
    c=await edit(c,supplier(sid,'https://example.invalid'));
    c=await edit(c,supply(sid,'wire','deepseek-v4-pro'));
  }
  c=await edit(c,{type:'cable.inventory.create',data:{id:'work',suppliers:['one','two'],models:{a:binding('one','wire'),b:binding('two','wire')}}});
  c=await edit(c,{type:'cable.inventory.save',cableId:'work',data:{suppliers:['one','two'],models:{a:binding('one','wire')}}});
  assert.deepEqual(c.cables.work.suppliers,['one']);
  c.cables.work.suppliers.push('two');
  c.cables.empty={id:'empty',target:'codex',virtualProvider:'cabletidy_empty',managedModels:true,suppliers:['two'],models:{}};
  c=normalizeConfig(c);
  assert.deepEqual(c.cables.work.suppliers,['one'],'old partially used selections are pruned on load');
  assert.deepEqual(c.cables.empty.suppliers,[],'old empty lines release stale references on load');
  assert.ok(c.suppliers.two);
  c=await edit(c,{type:'supplier.delete',supplierId:'two'});
  await assert.rejects(edit(c,{type:'supplier.delete',supplierId:'one'}),/解除供应商引用/);
  c=await edit(c,{type:'cable.inventory.save',cableId:'work',data:{suppliers:['one'],models:{}}});
  assert.deepEqual(c.cables.work.suppliers,[]);
  assert.ok(c.suppliers.one);
  c=await edit(c,{type:'supplier.delete',supplierId:'one'});
  assert.deepEqual(c.suppliers,{});
});

test('Responses web search preserves tool options, choices, results and upstream errors for compatible models',async t=>{
  const received=[];
  const searchResult={type:'web_search_call',id:'ws_fixture',status:'completed',action:{type:'search',query:'fixture',sources:[{type:'url',url:'https://example.invalid/source'}]}};
  const answer={type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'Fixture answer',annotations:[{type:'url_citation',start_index:0,end_index:7,url:'https://example.invalid/source',title:'Fixture'}]}]};
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);received.push(body);
    if(body.input==='upstream-reject') {res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'invalid_request_error',code:'unsupported_search',message:'Fixture interface does not support web_search'}}));return;}
    const response={id:'r_fixture',model:body.model,status:'completed',output:[searchResult,answer]};
    if(body.stream) {
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const event of [{type:'response.output_item.done',output_index:0,item:searchResult},{type:'response.output_item.done',output_index:1,item:answer},{type:'response.completed',response}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } else {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));}
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'cabletidy-web-search-'));
  const app=await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalogFixture()});
  t.after(async()=>{await app.close();await new Promise(resolve=>upstream.close(resolve));await fs.rm(home,{recursive:true,force:true});});
  const post=(endpoint,body)=>fetch(`${app.url}${endpoint}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  let c=(await(await fetch(`${app.url}api/v1/config`)).json()).config;
  const commit=async operation=>{const r=await post('api/v1/config/commit',{baseRevision:c.revision,operation});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));c=value.config;};
  await commit(supplier('vendor',`http://127.0.0.1:${upstream.address().port}/v1`));
  await commit(supply('vendor','wire','deepseek-v4-pro'));
  await commit({type:'cable.inventory.create',data:{id:'search',suppliers:['vendor'],models:{pro:binding('vendor','wire')},defaultModel:'pro'}});
  for(const type of ['web_search','web_search_preview']) for(const stream of [false,true]) {
    const tool=type==='web_search' ? {type,external_web_access:false,search_context_size:'high',filters:{allowed_domains:['example.invalid']},user_location:{type:'approximate',country:'CN'}} : {type,search_context_size:'low'};
    const body={model:'pro',input:[{role:'user',content:'Ordinary question'},searchResult,answer,{role:'user',content:'Continue'}],stream,tools:[{type:'tool_search',execution:'client'},tool],tool_choice:{type},include:['web_search_call.action.sources']};
    const r=await post('search/v1/responses',body);
    assert.equal(r.status,200);
    const text=await r.text();
    const reply=stream ? text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(event=>event.type==='response.completed').response : JSON.parse(text);
    assert.deepEqual(reply.output,[searchResult,answer]);
    const sent=received.at(-1);
    assert.deepEqual(sent.tools,[tool]);assert.deepEqual(sent.input,body.input);assert.deepEqual(sent.tool_choice,body.tool_choice);assert.deepEqual(sent.include,body.include);
    assert.equal(sent.model,'wire');
  }
  const rejected=await post('search/v1/responses',{model:'pro',input:'upstream-reject',tools:[{type:'web_search',external_web_access:true}]});
  assert.equal(rejected.status,400);
  assert.equal((await rejected.json()).error.code,'unsupported_search');
  assert.equal(received.length,5);
  assert.equal((await(await fetch(`${app.url}api/v1/config`)).json()).config.cables.search.webSearch,undefined);
});
