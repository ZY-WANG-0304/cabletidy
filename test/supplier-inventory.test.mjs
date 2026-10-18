import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "./helpers/native-app.mjs";
import { getPaths, applyConfigOperation, normalizeConfig, resolveRequest, planCodexCatalog, publicConfig, validateConfig, buildTargetArtifacts } from "./helpers/native.mjs";
import { catalogFixture } from "./helpers/codex-fixture.mjs";

const facts = identity => ({ identity, interfaces:["responses"],capabilityStates:{tools:"supported",streaming:"supported",reasoning:"supported"},contextWindow:128000,reasoning:{modes:["effort"],efforts:["low","high"]},history:"stateless" });
const supplier = (id,url) => ({type:"supplier.save",supplierId:id,data:{name:id,interfaces:{responses:{protocol:"openai.responses",baseUrl:url,secret:"supplier-fixture-key",auth:{header:"authorization",scheme:"Bearer"}}}}});
const supply = (id,mid,identity,oldModelId="") => ({type:"supplier.model.save",supplierId:id,data:{modelId:mid,oldModelId,model:facts(identity)}});
const binding = (sid,mid) => ({sources:[{supplierId:sid,modelId:mid,interfaceId:"responses"}],promptStrategy:"default"});
async function edit(c,op) { return (await applyConfigOperation(c,op,catalogFixture())).config; }

test("supplier keys remain separate from client aliases and rename invalidates old references",async () => {
  let c=normalizeConfig({});
  c=await edit(c,supplier("official","https://example.invalid"));
  c=await edit(c,supply("official","wire-pro","DeepSeek-V4-Pro"));
  c=await edit(c,supply("official","another-id","DeepSeek-V4-Pro"));
  c=await edit(c,{type:"cable.inventory.create",data:{name:"Work",suppliers:["official"],models:{pro:binding("official","wire-pro")},defaultModel:"pro"}});
  assert.deepEqual(Object.keys(c.suppliers.official.models),["wire-pro","another-id"]);
  assert.deepEqual(Object.keys(c.virtualProviders.cabletidy_work.models),["pro"]);
  assert.equal(resolveRequest(c,c.virtualProviders.cabletidy_work,{model:"pro"}).upstreamModelId,"wire-pro");
  assert.throws(() => resolveRequest(c,c.virtualProviders.cabletidy_work,{model:"another-id"}),/未在当前 Cable 中开放/);
  c=await edit(c,supply("official","wire-new","DeepSeek-V4-Pro","wire-pro"));
  assert.equal(c.cables.work.models.pro.sources[0].modelId,"wire-pro");
  assert.throws(() => resolveRequest(c,c.virtualProviders.cabletidy_work,{model:"pro"}),/来源不存在/);
  c=await edit(c,{type:"cable.inventory.save",cableId:"work",data:{suppliers:["official"],models:{pro:binding("official","wire-new")},defaultModel:"pro"}});
  assert.equal(resolveRequest(c,c.virtualProviders.cabletidy_work,{model:"pro"}).upstreamModelId,"wire-new");
});

test("all six compatible identities get neutral complete Codex entries and selected catalog only",async () => {
  let c=normalizeConfig({}); c=await edit(c,supplier("vendor","https://example.invalid/v1"));
  const identities=["GLM-5.3","GLM-5.3-Flash","Kimi K3","DeepSeek-V4-Pro","DeepSeek-V4.1-Flash","MiniMax M3"];
  const models={};
  for (const [i,identity] of identities.entries()) { c=await edit(c,supply("vendor",`wire-${i}`,identity));models[`client-${i}`]=binding("vendor",`wire-${i}`); }
  c=await edit(c,{type:"cable.inventory.create",data:{name:"Models",suppliers:["vendor"],models,defaultModel:"client-0"}});
  const plan=planCodexCatalog(c,c.virtualProviders.cabletidy_models,catalogFixture());
  assert.equal(plan.catalog.models.length,6);
  for(const m of plan.catalog.models) { assert.match(m.base_instructions,/coding assistant/);assert.equal(m.model_messages,null);assert.equal(m.apply_patch_tool_type,"freeform");assert.deepEqual(m.input_modalities,["text"]);assert.ok(m.supported_reasoning_levels.some(r=>r.effort === "high"));assert.equal(m.upgrade,null); }
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
  await commit(supplier("first",url));await commit(supplier("second",url));
  await commit(supply("first","wire-a","DeepSeek-V4-Pro"));await commit(supply("second","wire-b","MiniMax M3"));
  await commit({type:"cable.inventory.create",data:{name:"Work",suppliers:["first","second"],models:{a:binding("first","wire-a"),b:binding("second","wire-b")},defaultModel:"a"}});
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
  await commit({type:"supplier.model.delete",supplierId:"second",modelId:"wire-b"});
  const missing=await call("work/v1/responses",{model:"b",input:"next"});assert.equal(missing.status,503);assert.match(missing.body.error.message,/来源不存在/);
  await commit({type:"cable.delete",cableId:"work"});assert.ok(c.suppliers.first);assert.ok(c.suppliers.second);
});

test("native aliases retain versioned instructions and restrict declared supply efforts",async()=>{
  let c=normalizeConfig({});c=await edit(c,supplier("native","https://example.invalid"));
  const model={...facts("gpt-5.5"),reasoning:{modes:["effort"],efforts:["high"]},history:"native"};
  c=await edit(c,{type:"supplier.model.save",supplierId:"native",data:{modelId:"wire-gpt",model}});
  c=await edit(c,{type:"cable.inventory.create",data:{name:"Native",suppliers:["native"],models:{alias:binding("native","wire-gpt")},defaultModel:"alias"}});
  const m=planCodexCatalog(c,c.virtualProviders.cabletidy_native,catalogFixture()).catalog.models[0];
  assert.equal(m.base_instructions,"Official base for gpt-5.5");assert.equal(m.model_messages.instructions_template,"Official template for gpt-5.5");
  assert.deepEqual(m.supported_reasoning_levels.map(r=>r.effort),["high"]);assert.equal(m.default_reasoning_level,"high");
  assert.deepEqual(m.future_metadata,{retained:true});assert.equal(m.context_window,128000);assert.equal(m.slug,"alias");
});

test("manual groups require identical contracts and a removed candidate never selects another source",async()=>{
  let c=normalizeConfig({});for(const sid of ["one","two"]){c=await edit(c,supplier(sid,"https://example.invalid"));c=await edit(c,supply(sid,"wire","DeepSeek-V4-Pro"));}
  const group={sources:[binding("one","wire").sources[0],binding("two","wire").sources[0]],activeSource:1,promptStrategy:"default"};
  c=await edit(c,{type:"cable.inventory.create",data:{name:"Group",suppliers:["one","two"],models:{pro:group},defaultModel:"pro"}});
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
  await commit(supplier("vendor","https://example.invalid/v1?credential=private"));await commit(supply("vendor","wire","DeepSeek-V4-Pro"));
  await commit({type:"cable.inventory.create",data:{name:"Work",suppliers:["vendor"],models:{alias:binding("vendor","wire")},defaultModel:"alias"}});
  const bundle=(await call("cables/export",{cableIds:["work"]})).body;
  assert.equal(bundle.version,2);assert.equal(bundle.config.suppliers.vendor.interfaces.responses.baseUrl,"https://example.invalid/v1");
  assert.equal(bundle.config.suppliers.vendor.interfaces.responses.secretRef,undefined);assert.deepEqual(bundle.config.cables.work.models.alias.sources,binding("vendor","wire").sources);
  assert.doesNotMatch(JSON.stringify(bundle),/supplier-fixture-key|private/);
  let r=await call("cables/import",{bundle,baseRevision:c.revision,useImportedCredentials:false,choices:{work:"create"}});assert.equal(r.status,200,JSON.stringify(r.body));c=r.body.config;
  const imported=c.cables["work-import-2"];assert.equal(imported.models.alias.sources[0].supplierId,"vendor-2");assert.equal(c.suppliers["vendor-2"].interfaces.responses.secretConfigured,false);assert.equal(c.suppliers.vendor.interfaces.responses.secretConfigured,true);
  const withKeys=(await call("cables/export",{cableIds:["work"],includeCredentials:true})).body;
  r=await call("cables/import",{bundle:withKeys,baseRevision:c.revision,useImportedCredentials:true,choices:{work:"create"}});assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(r.body.config.suppliers["vendor-3"].interfaces.responses.secretConfigured,true);assert.equal(r.body.config.cables["work-import-3"].models.alias.sources[0].modelId,"wire");
});

test("Codex Cable activation restores the previous Cable and protects user edits",async t=>{
  const {prepareTargetArtifacts,applyCodexArtifacts,nativeAsync,readCodexConfig}=await import("./helpers/native.mjs");
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"cabletidy-activation-"));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const options={paths:getPaths(path.join(home,"gateway")),codexHome:path.join(home,"codex"),loadCatalog:async()=>catalogFixture()};
  await fs.mkdir(options.codexHome,{recursive:true});const root=path.join(options.codexHome,"config.toml");
  await fs.writeFile(root,'model_provider = "original"\nmodel = "old"\nweb_search = "cached"\n');
  let c=normalizeConfig({});c=await edit(c,supplier("vendor","https://example.invalid"));c=await edit(c,supply("vendor","wire","DeepSeek-V4-Pro"));
  for(const name of ["A","B"])c=await edit(c,{type:"cable.inventory.create",data:{name,suppliers:["vendor"],models:{pro:binding("vendor","wire")},defaultModel:"pro"}});
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
  await commit(supplier("deepseek",`http://127.0.0.1:${upstream.address().port}`));await commit(supply("deepseek","deepseek-v4-pro","DeepSeek-V4-Pro"));await commit({type:"cable.inventory.create",data:{name:"Stream",suppliers:["deepseek"],models:{pro:binding("deepseek","deepseek-v4-pro")},defaultModel:"pro"}});
  const tools=[{type:"function",name:"exec_command",parameters:{type:"object"}},{type:"custom",name:"apply_patch",format:{type:"text"}}];
  const r=await post("stream/v1/responses",{model:"pro",stream:true,input:"test",reasoning:{effort:"medium",summary:"auto"},include:["reasoning.encrypted_content"],parallel_tool_calls:true,tools:[{type:"tool_search",execution:"client"},...tools,{type:"namespace",name:"multi_agent_v1",tools:[]},{type:"tool_search",execution:"client"}]});assert.equal(r.status,200);const events=await r.text();assert.match(events,/"model":"pro"/);assert.ok(events.includes("custom_tool_call"));assert.equal(received[0].reasoning.effort,"high");assert.deepEqual(received[0].include,[]);assert.equal(received[0].store,false);assert.deepEqual(received[0].tools,tools);assert.equal(received[0].parallel_tool_calls,false);
  const history=[{role:"user",content:"test"},...output,{type:"function_call_output",call_id:"exec",output:"/tmp"},{type:"custom_tool_call_output",call_id:"patch-call",output:"success"},{role:"user",content:"continue"}];
  const next=await post("stream/v1/responses",{model:"pro",stream:true,input:history,reasoning:{effort:"xhigh"},tools});assert.equal(next.status,200);await next.text();assert.deepEqual(received[1].input,history);
  const isolated=await post("api/v1/targets/isolated",{cableId:"stream"});assert.equal(isolated.status,200);const bundle=(await isolated.json()).bundle;assert.equal(bundle.files.length,2);assert.doesNotMatch(JSON.stringify(bundle),/supplier-fixture-key/);
  const bad=await post("stream/v1/responses",{model:"pro",input:history,tools:[{type:"web_search"}]});assert.equal(bad.status,422);assert.equal(received.length,2);
});


test("interface differences inherit other declared capabilities and protocol drafts stay unavailable",async()=>{
  let c=normalizeConfig({});c=await edit(c,supplier("vendor","https://example.invalid"));
  const model={...facts("DeepSeek-V4-Pro"),interfaceCapabilities:{responses:{capabilityStates:{vision:"unsupported"},contextWindow:64000}}};
  c=await edit(c,{type:"supplier.model.save",supplierId:"vendor",data:{modelId:"wire",model}});
  c=await edit(c,{type:"cable.inventory.create",data:{name:"Diff",suppliers:["vendor"],models:{pro:binding("vendor","wire")},defaultModel:"pro"}});
  const entry=planCodexCatalog(c,c.virtualProviders.cabletidy_diff,catalogFixture()).catalog.models[0];assert.equal(entry.context_window,64000);assert.equal(resolveRequest(c,c.virtualProviders.cabletidy_diff,{model:"pro"}).upstreamModelId,"wire");
});

test("drafts retain unknown supply facts and empty bindings without requiring a Codex catalog",async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"cabletidy-inventory-drafts-"));
  let catalogCalls=0;
  const app=await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>{catalogCalls++;throw new Error("Codex not installed");}});
  t.after(async()=>{await app.close();await fs.rm(home,{recursive:true,force:true});});
  let c=(await(await fetch(`${app.url}api/v1/config`)).json()).config;
  const commit=async operation=>{const r=await fetch(`${app.url}api/v1/config/commit`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({baseRevision:c.revision,operation})});const v=await r.json();assert.equal(r.status,200,JSON.stringify(v));c=v.config;};
  await commit(supplier("draft","https://example.invalid"));
  await commit({type:"supplier.model.save",supplierId:"draft",data:{modelId:"token",model:{identity:null,interfaces:["responses"],capabilityStates:{tools:"unknown",streaming:"unknown"},contextWindow:null,maxOutputTokens:null,history:"unknown"}}});
  await commit({type:"cable.inventory.create",data:{name:"Draft",suppliers:["draft"],models:{token:binding("draft","token"),pending:{sources:[],activeSource:0}},defaultModel:"token"}});
  assert.equal(catalogCalls,0);
  assert.equal(c.suppliers.draft.models.token.contextWindow,null);assert.ok(c.cables.draft.models.token);
  assert.match(c.virtualProviders.cabletidy_draft.models.pending.sourceError,/来源不存在/);
  const list=await(await fetch(`${app.url}draft/v1/models`)).json();assert.deepEqual(list.data,[]);
  assert.throws(()=>resolveRequest(c,c.virtualProviders.cabletidy_draft,{model:"token"}),/身份未知/);
});

test("apply requires an explicit default and native capabilities stay inside the installed definition",async()=>{
  let c=normalizeConfig({});c=await edit(c,supplier("native","https://example.invalid"));
  c=await edit(c,{type:"supplier.model.save",supplierId:"native",data:{modelId:"wire",model:{...facts("gpt-5.5"),capabilityStates:{...facts("gpt-5.5").capabilityStates,vision:"supported"},inputModalities:["text","image"]}}});
  c=await edit(c,{type:"cable.inventory.create",data:{name:"Native",suppliers:["native"],models:{alias:binding("native","wire")}}});
  assert.throws(()=>buildTargetArtifacts(c,{cableId:"native"}),/选择默认模型/);
  const snapshot=catalogFixture();snapshot.catalog.models[0].input_modalities=["text"];
  assert.deepEqual(planCodexCatalog(c,c.virtualProviders.cabletidy_native,snapshot).catalog.models[0].input_modalities,["text"]);
  const malformed=normalizeConfig({suppliers:{broken:{name:"Broken",interfaces:{responses:null},models:{}}}});
  assert.equal(validateConfig(malformed).ok,false);assert.doesNotThrow(()=>publicConfig(malformed));
});

test("interface facts and reasoning budgets are validated without enabling user-defined adaptation",async()=>{
  let c=normalizeConfig({});c=await edit(c,supplier("vendor","https://example.invalid"));
  const check=model=>validateConfig(normalizeConfig({...c,suppliers:{vendor:{...c.suppliers.vendor,models:{wire:model}}}}));
  for(const difference of [{contextWindow:-1},{capabilityStates:{tools:"yes"}},{reasoning:{modes:["script"]}},{reasoning:{budget:{unit:"tokens",min:100,max:50}}},{identity:"gpt-5.5"}]) {
    assert.equal(check({...facts("DeepSeek-V4-Pro"),interfaceCapabilities:{responses:difference}}).ok,false,JSON.stringify(difference));
  }
  assert.equal(check({...facts("DeepSeek-V4-Pro"),codex:{metadataMode:"override"}}).ok,false);
  const budgetModel={...facts("DeepSeek-V4-Pro"),reasoning:{modes:["budget","toggle"],toggle:false,budget:{unit:"tokens",min:0,max:4096,default:1024}}};
  assert.equal(check(budgetModel).ok,true);
  c=await edit(c,{type:"supplier.model.save",supplierId:"vendor",data:{modelId:"budget",model:budgetModel}});
  c=await edit(c,{type:"cable.inventory.create",data:{name:"Budget",suppliers:["vendor"],models:{pro:binding("vendor","budget")},defaultModel:"pro"}});
  assert.throws(()=>resolveRequest(c,c.virtualProviders.cabletidy_budget,{model:"pro"}),/暂无内置映射/);
});

test("explicit Codex aliases publish the same instructions and route to the supplier model ID",async()=>{
  let c=normalizeConfig({});c=await edit(c,supplier("vendor","https://example.invalid"));c=await edit(c,supply("vendor","wire","DeepSeek-V4-Pro"));
  c=await edit(c,{type:"cable.inventory.create",data:{name:"Aliases",suppliers:["vendor"],models:{pro:{...binding("vendor","wire"),aliases:["quick","token"]}},defaultModel:"pro"}});
  const plan=planCodexCatalog(c,c.virtualProviders.cabletidy_aliases,catalogFixture());
  assert.deepEqual(new Set(plan.catalog.models.map(model=>model.slug)),new Set(["pro","quick","token"]));
  const prompt=plan.catalog.models.find(model=>model.slug==="pro").base_instructions;
  for(const alias of ["quick","token"]) {
    assert.equal(plan.catalog.models.find(model=>model.slug===alias).base_instructions,prompt);
    assert.equal(resolveRequest(c,c.virtualProviders.cabletidy_aliases,{model:alias}).upstreamModelId,"wire");
  }
});
