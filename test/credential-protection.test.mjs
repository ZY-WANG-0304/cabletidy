import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from './helpers/native-app.mjs';
import { getPaths, normalizeConfig } from './helpers/native.mjs';
import { catalogFixture, codexConfigFixture } from './helpers/codex-fixture.mjs';
import { claudeConfigFixture } from './helpers/claude-fixture.mjs';

const key = 'sk-proj-9fK2mNvQ8xRtZ4wB7hLpY1cD';
const authentication = 'upstream-auth-only-4fR8';
const event = v => `data: ${JSON.stringify(v)}\n\n`;
async function fixture(t, handler, { claude = false, enabled = true } = {}) {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls.push({body, headers:req.headers});
    try { await handler(body, res); } catch (e) { res.destroy(e); }
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cabletidy-protection-'));
  let app = await createApplication({paths:getPaths(home), loadCodexCatalog:async () => catalogFixture()});
  t.after(async () => { upstream.closeAllConnections(); await Promise.all([app.close(),new Promise(r=>upstream.close(r))]); await fs.rm(home,{recursive:true,force:true}); });
  const config = normalizeConfig(claude ? claudeConfigFixture() : codexConfigFixture());
  config.web.port = Number(new URL(app.url).port);
  config.upstreams.relay.baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  config.credentialProtection = { enabled, mappingTtlSeconds:3600 };
  const call = (route,body,headers={}) => fetch(`${app.url}${route}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const commit = await call('api/v1/config/commit',{config,baseRevision:0,upstreamSecrets:{relay:authentication}});
  assert.equal(commit.status,200,await commit.text());
  const model = claude ? 'claude-sonnet-4-6':'gpt-5.5';
  const endpoint = claude ? 'claude-main/v1/messages':'relay/v1/responses';
  return {calls,call,home,app,model,config,request:(body={},session='session-1')=>call(endpoint,{model,max_tokens:100,...body},claude?{'x-claude-code-session-id':session}:{'session-id':session}),
    async records() { for(let i=0;i<300;i++){const v=await (await call('api/v1/security/audit?kind=request')).json();if(v.items?.length && v.items.every(r=>r.inspectionProgress?.active===false))return v.items;await delay(20);}assert.fail('audit did not settle'); },
    async restart(){await app.close();app=await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalogFixture()});},
  };
}
const respond=(res,body,text)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'response',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]}));};

 test('same session reuses placeholders, independent sessions isolate them, audit shows A after restart',async t=>{
  const f=await fixture(t,(body,res)=>respond(res,body,body.input));
  for(const session of ['s-1','s-1','s-2']) {
    const response=await f.request({input:`Key: ${key}`},session);
    assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.output[0].content[0].text,`Key: ${key}`);assert.equal(result.model,f.model);
  }
  const [a,b,c]=f.calls;
  assert.equal(a.body.input,b.body.input);assert.notEqual(a.body.input,c.body.input);
  for(const v of f.calls){assert.ok(!JSON.stringify(v.body).includes(key));assert.match(v.body.input,/CTSEC_v1_[a-f0-9]{32}/);assert.equal(v.headers.authorization,`Bearer ${authentication}`);}
  const records=await f.records();assert.equal(records.length,3);
  let reused=false;
  for(const r of records){
    const detail=await (await f.call(`api/v1/security/audit/${r.id}`)).json();
    assert.equal(detail.record.protection.status,'completed');
    assert.equal(detail.record.protection.mappings[0].original,key);
    reused ||= detail.record.protection.mappings[0].reused;
    assert.equal(detail.record.protection.requestCount,1);assert.equal(detail.record.protection.responseCount,1);
    for(const side of ['request','response']) {
      const content=detail.record[`${side}Content`];assert.ok(JSON.stringify(content).includes(key));assert.ok(content.items.some(i=>i.protectionRanges?.preview?.length));
      const page=await (await f.call(`api/v1/security/audit/${r.id}/body?snapshot=${side}`)).json();assert.ok(page.chunks.map(c=>c.content).join('').includes(key));assert.ok(page.protectionRanges.length);
    }
  }
  assert.ok(reused);
  const id=records[0].id;await f.restart();
  const detail=await (await f.call(`api/v1/security/audit/${id}`)).json();assert.equal(detail.record.protection.mappings[0].original,key);assert.ok(detail.record.responseContent.items.some(i=>i.protectionRanges.preview.length));
 });

 test('credentials declared later protect earlier copies; nested JSON and tools restore quoted A',async t=>{
  const special='real-token-"quoted"-\\-中文';
  const f=await fixture(t,(body,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'response',model:body.model,output:[{type:'function_call',name:'write',call_id:'c1',arguments:JSON.stringify({token:body.metadata.api_key})},{type:'message',role:'assistant',content:[{type:'output_text',text:body.metadata.api_key}]}]}));});
  const response=await f.request({input:[{role:'user',content:[{type:'input_text',text:`Earlier ${special}`}]}],metadata:{api_key:special},extra:JSON.stringify({access_token:special})});
  assert.equal(response.status,200);const result=await response.json();
  assert.equal(JSON.parse(result.output[0].arguments).token,special);assert.equal(result.output[1].content[0].text,special);
  assert.ok(!JSON.stringify(f.calls[0].body).includes(special));
  assert.equal(JSON.parse(f.calls[0].body.extra).access_token,f.calls[0].body.metadata.api_key);
 });

 test('Responses SSE restores a placeholder split at every byte boundary',async t=>{
  const f=await fixture(t,async(body,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(event({type:'response.output_item.added',output_index:0,item:{id:'m1',type:'message',role:'assistant',content:[]}}));
    for(const ch of body.input)res.write(event({type:'response.output_text.delta',item_id:'m1',output_index:0,content_index:0,delta:ch}));
    res.write(event({type:'response.output_text.done',item_id:'m1',output_index:0,content_index:0,text:body.input}));
    res.end(event({type:'response.completed',response:{model:body.model,output:[{id:'m1',type:'message',role:'assistant',content:[{type:'output_text',text:body.input}]}]}}));
  });
  const wire=await (await f.request({input:key,stream:true})).text();
  const events=wire.split('\n\n').filter(Boolean).map(s=>JSON.parse(s.slice(s.indexOf('data: ')+6)));
  assert.equal(events.filter(e=>e.type==='response.output_text.delta').map(e=>e.delta).join(''),key);
  assert.equal(events.at(-1).response.output[0].content[0].text,key);
  assert.ok(!wire.includes('CTSEC_v1_'));
  const records=await f.records();const d=await(await f.call(`api/v1/security/audit/${records[0].id}`)).json();assert.equal(d.record.outcome,'completed');assert.ok(d.record.responseContent.items.some(i=>i.protectionRanges?.preview?.length));
  const mapping=d.record.protection.mappings[0];
  const locations=await(await f.call(`api/v1/security/audit/${records[0].id}/protection-locations?mapping=${mapping.id}&side=response`)).json();
  assert.ok(locations.total>0);assert.equal(locations.total,mapping.responseCount);
  assert.ok(locations.items.some(hit=>hit.snapshotId.startsWith('stream/')));
 });

 test('Claude SSE restores interleaved text and JSON tool parameters, maintaining valid JSON',async t=>{
  const f=await fixture(t,(body,res)=>{
    const b=body.messages[0].content;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(event({type:'message_start',message:{type:'message',model:body.model,role:'assistant',content:[]}}));
    res.write(event({type:'content_block_start',index:0,content_block:{type:'text',text:''}}));
    res.write(event({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'c1',name:'write',input:{}}}));
    const arg=JSON.stringify({api_key:b});
    for(let i=0;i<Math.max(b.length,arg.length);i++){
      if(i<b.length)res.write(event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:b[i]}}));
      if(i<arg.length)res.write(event({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:arg[i]}}));
    }
    res.write(event({type:'content_block_stop',index:0}));res.write(event({type:'content_block_stop',index:1}));res.end(event({type:'message_stop'}));
  },{claude:true});
  const wire=await (await f.request({messages:[{role:'user',content:key}],stream:true})).text();
  const events=wire.split('\n\n').filter(Boolean).map(s=>JSON.parse(s.slice(s.indexOf('data: ')+6)));
  assert.equal(events.filter(e=>e.index===0 && e.delta).map(e=>e.delta.text).join(''),key);
  assert.equal(JSON.parse(events.filter(e=>e.index===1 && e.delta).map(e=>e.delta.partial_json).join('')).api_key,key);
  assert.ok(!wire.includes('CTSEC_v1_'));
 });

 test('disabled protection passes through; signed content and unsafe headers fail before upstream',async t=>{
  const f=await fixture(t,(body,res)=>respond(res,body,body.input));
  let response=await f.request({input:[{type:'reasoning',encrypted_content:key}]});assert.equal(response.status,422);assert.equal(f.calls.length,0);
  response=await f.call('relay/v1/responses',{model:f.model,input:key},{'openai-project':key});assert.equal(response.status,422);assert.equal(f.calls.length,0);
  const result=await(await f.call('api/v1/config')).json();result.config.credentialProtection.enabled=false;
  response=await f.call('api/v1/config/commit',{config:result.config,baseRevision:result.config.revision});assert.equal(response.status,200);
  response=await f.request({input:key});assert.equal(response.status,200);await response.text();assert.equal(f.calls[0].body.input,key);
 });

test('a learned plain token stays protected across rounds, including server-side context',async t=>{
  const plain='plainCredentialValue';let prior;
  const f=await fixture(t,(body,res)=>{prior=body.metadata?.api_key || prior;respond(res,body,prior);});
  let response=await f.request({input:'start',metadata:{api_key:plain}});assert.equal((await response.json()).output[0].content[0].text,plain);
  response=await f.request({input:`中文🙂 prefix ${plain} suffix`});assert.equal((await response.json()).output[0].content[0].text,plain);
  assert.equal(f.calls[1].body.input,`中文🙂 prefix ${prior} suffix`);
  response=await f.request({input:'continue',previous_response_id:'server-context'});assert.equal((await response.json()).output[0].content[0].text,plain);
  response=await f.request({input:'continue'},'unrelated-session');assert.equal((await response.json()).output[0].content[0].text,prior);
});

test('unknown placeholders remain literal; original A returned without restoration has no protection highlight',async t=>{
  const unknown='CTSEC_v1_00000000000000000000000000000000';
  const f=await fixture(t,(body,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'response',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:body.input}]},{type:'message',role:'assistant',content:[{type:'output_text',text:`literal ${key} ${unknown}`}]}]}));});
  const response=await f.request({input:key});const result=await response.json();
  assert.equal(result.output[0].content[0].text,key);assert.equal(result.output[1].content[0].text,`literal ${key} ${unknown}`);
  const records=await f.records();const detail=await(await f.call(`api/v1/security/audit/${records[0].id}`)).json();
  const items=detail.record.responseContent.items;assert.ok(items[0].protectionRanges.preview.length);assert.deepEqual(items[1].protectionRanges.preview,[]);
  const page=await(await f.call(`api/v1/security/audit/${records[0].id}/body?snapshot=response`)).json();assert.equal(page.protectionRanges.length,1);
});

test('plain text upstream errors restore A, retain status and keep unrelated placeholders',async t=>{
  const f=await fixture(t,(body,res)=>{res.writeHead(429,{'content-type':'text/plain; charset=utf-8','retry-after':'3'});res.end(`Failed for ${body.input}; CTSEC_v1_unknown`);});
  const response=await f.request({input:key});assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'3');assert.equal(await response.text(),`Failed for ${key}; CTSEC_v1_unknown`);
  const records=await f.records();const page=await(await f.call(`api/v1/security/audit/${records[0].id}/body?snapshot=response`)).json();assert.ok(page.protectionRanges.length);
});

test('nested JSON strings in arbitrary fields restore quoted tokens without corrupting JSON',async t=>{
  const special='quoted-token-"example"-\\-中文';
  const f=await fixture(t,(body,res)=>respond(res,body,body.input));
  const inner=JSON.stringify({token:special});const input=JSON.stringify({envelope:inner});
  const response=await f.request({input});const result=await response.json();
  assert.equal(JSON.parse(JSON.parse(result.output[0].content[0].text).envelope).token,special);
  assert.ok(!JSON.stringify(f.calls).includes(special));
});

test('opaque block credentials and percent-encoded query credentials fail before forwarding',async t=>{
  const f=await fixture(t,(body,res)=>respond(res,body,body.input));
  for(const input of [[{data:key,type:'redacted_thinking'}],[{type:'redacted_thinking',data:key}]]) {
    const response=await f.request({input});assert.equal(response.status,422);assert.equal(f.calls.length,0);
  }
  const encoded=[...key].map(ch=>`%${ch.charCodeAt(0).toString(16)}`).join('');
  const response=await f.call(`relay/v1/responses?token=${encoded}`,{model:f.model,input:'safe'});
  assert.equal(response.status,422);assert.equal(f.calls.length,0);
});

test('incomplete SSE restoration aborts the stream and retains explicit failure evidence',async t=>{
  const f=await fixture(t,(body,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(event({type:'response.output_text.delta',output_index:0,content_index:0,delta:body.input.slice(0,15)}));
    res.end(event({type:'response.completed',response:{output:[]}}));
  });
  await assert.rejects(async()=>{const response=await f.request({input:key,stream:true});await response.text();});
  const records=await f.records();assert.equal(records[0].protection.status,'failed');
  assert.equal(records[0].protection.reason,'response_restore_failed');
});

function parseSse(wire) {
  return wire.replace(/\r\n/g, '\n').split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n');
    return { name: lines.find(line => line.startsWith('event:'))?.slice(6).trim(),
      value: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')) };
  });
}
const namedEvent = value => `event: ${value.type}\r\nid: fixture\r\n: keep comment\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;

test('Unicode escapes inside nested tool JSON cannot send the decoded credential upstream', async t => {
  const unicode = [...key].map(ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const f = await fixture(t, (body, res) => respond(res, body, 'ok'));
  const argumentsText = `{"value":"${unicode}"}`;
  const response = await f.request({input:[{type:'function_call',name:'use_key',call_id:'c1',arguments:argumentsText}]});
  assert.equal(response.status, 200); await response.text();
  const upstreamKey = JSON.parse(f.calls[0].body.input[0].arguments).value;
  assert.notEqual(upstreamKey, key); assert.match(upstreamKey, /^CTSEC_v1_[a-f0-9]{32}$/);
  const records = await f.records(); assert.ok(records[0].protection.requestCount > 0);
});

test('credential properties preserve tool schemas and do not teach schema metadata as credentials', async t => {
  const f = await fixture(t, (body, res) => respond(res, body, 'ok'));
  const parameters = {type:'object',properties:{api_key:{type:'string',description:'API credential',minLength:1,default:key}},required:['api_key']};
  let response = await f.request({input:'start',tools:[{type:'function',name:'connect',parameters}]});
  assert.equal(response.status, 200); await response.text();
  const property = f.calls[0].body.tools[0].parameters.properties.api_key;
  assert.equal(property.type, 'string'); assert.equal(property.description, 'API credential'); assert.equal(property.minLength, 1);
  assert.notEqual(property.default, key); assert.deepEqual(f.calls[0].body.tools[0].parameters.required, ['api_key']);
  response = await f.request({input:'string API credential'}); assert.equal(response.status, 200); await response.text();
  assert.equal(f.calls[1].body.input, 'string API credential');
});

test('protected Claude SSE preserves each event name with its data and extension fields', async t => {
  const f = await fixture(t, (body, res) => {
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.write(namedEvent({type:'message_start',message:{type:'message',model:body.model,role:'assistant',content:[]}}));
    res.write(namedEvent({type:'content_block_start',index:0,content_block:{type:'text',text:''}}));
    res.write(namedEvent({type:'content_block_delta',index:0,delta:{type:'text_delta',text:body.messages[0].content}}));
    res.write(namedEvent({type:'content_block_stop',index:0})); res.end(namedEvent({type:'message_stop'}));
  }, {claude:true});
  const wire = await (await f.request({messages:[{role:'user',content:key}],stream:true})).text();
  const events = parseSse(wire); assert.equal(events.length, 5);
  for (const item of events) assert.equal(item.name, item.value.type);
  assert.equal(events[2].value.delta.text, key); assert.ok(wire.includes('id: fixture')); assert.ok(wire.includes(': keep comment'));
});

test('ordinary placeholder-prefix suffixes are flushed before SSE done events', async t => {
  const f = await fixture(t, (body, res) => {
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.write(event({type:'response.output_text.delta',output_index:0,content_index:0,delta:'Implemented in C'}));
    res.write(event({type:'response.output_text.done',output_index:0,content_index:0,text:'Implemented in C'}));
    res.end(event({type:'response.completed',response:{output:[]}}));
  });
  const wire = await (await f.request({input:key,stream:true})).text();
  const events = parseSse(wire).map(item => item.value);
  assert.equal(events.filter(value => value.type==='response.output_text.delta').map(value => value.delta).join(''), 'Implemented in C');
  const records = await f.records(); assert.equal(records[0].protection.status, 'completed');
});

for (const claude of [false, true]) test(`nested tool JSON restores quoted credentials across byte deltas (${claude ? 'Claude' : 'Responses'})`, async t => {
  const special = 'real-token-"quoted"-\\-中文';
  const f = await fixture(t, (body, res) => {
    const b = body.metadata.api_key;
    const args = JSON.stringify({payload:JSON.stringify({api_key:b})});
    res.writeHead(200, {'content-type':'text/event-stream'});
    if (claude) res.write(namedEvent({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'c1',name:'connect',input:{}}}));
    for (const ch of args) res.write(claude
      ? namedEvent({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:ch}})
      : event({type:'response.function_call_arguments.delta',output_index:0,delta:ch}));
    if (claude) { res.write(namedEvent({type:'content_block_stop',index:1})); res.end(namedEvent({type:'message_stop'})); }
    else { res.write(event({type:'response.function_call_arguments.done',output_index:0,arguments:args})); res.end(event({type:'response.completed',response:{output:[]}})); }
  }, {claude});
  const wire = await (await f.request({input:'start',messages:[{role:'user',content:'start'}],metadata:{api_key:special},stream:true})).text();
  const events = parseSse(wire).map(item => item.value);
  const args = events.filter(value => claude ? value.delta?.type==='input_json_delta' : value.type==='response.function_call_arguments.delta')
    .map(value => claude ? value.delta.partial_json : value.delta).join('');
  assert.equal(JSON.parse(JSON.parse(args).payload).api_key, special);
  const records = await f.records(); assert.equal(records[0].protection.status, 'completed');
});

test('known placeholders split across Claude thinking deltas fail without changing signed content', async t => {
  const f = await fixture(t, (body, res) => {
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.write(namedEvent({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}));
    for (const ch of body.messages[0].content) res.write(namedEvent({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:ch}}));
    res.write(namedEvent({type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'unchanged-signature'}}));
    res.write(namedEvent({type:'content_block_stop',index:0})); res.end(namedEvent({type:'message_stop'}));
  }, {claude:true});
  await assert.rejects(async () => { const response = await f.request({messages:[{role:'user',content:key}],stream:true}); await response.text(); });
  const records = await f.records(); assert.equal(records[0].protection.status, 'failed');
  assert.equal(records[0].protection.reason, 'response_restore_failed');
});

for (const claude of [false, true]) test(`ordinary text flushes without a done event and safe signatures remain unchanged (${claude ? 'Claude' : 'Responses'})`, async t => {
  const f = await fixture(t, (body, res) => {
    res.writeHead(200, {'content-type':'text/event-stream'});
    if (claude) {
      res.write(namedEvent({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'safe thought'}}));
      res.write(namedEvent({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:' continuation'}}));
      res.write(namedEvent({type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'unchanged-signature'}}));
      res.write(namedEvent({type:'content_block_stop',index:0}));
      res.write(namedEvent({type:'content_block_delta',index:1,delta:{type:'text_delta',text:'literal CTSE'}}));
      res.end(namedEvent({type:'message_stop'}));
    } else {
      res.write(event({type:'response.output_text.delta',output_index:0,content_index:0,delta:'literal CTSE'}));
      res.end(event({type:'response.completed',response:{output:[]}}));
    }
  }, {claude});
  const wire = await (await f.request({input:key,messages:[{role:'user',content:key}],stream:true})).text();
  const events = parseSse(wire).map(item => item.value);
  assert.equal(events.filter(value => claude ? value.delta?.type==='text_delta' : value.type==='response.output_text.delta')
    .map(value => claude ? value.delta.text : value.delta).join(''), 'literal CTSE');
  if (claude) assert.equal(events.find(value => value.delta?.type==='signature_delta').delta.signature, 'unchanged-signature');
});

test('Unicode escaped credentials preserve nested JSON, surrogate pairs and original audit spelling', async t => {
  const special = 'plain-"quote"-\\-中文🙂';
  const unicode = special.split('').map(ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4,'0').toUpperCase()}`).join('');
  const argumentsText = JSON.stringify({payload:`{"api_key":"${unicode}"}`});
  const f = await fixture(t, (body, res) => respond(res, body, body.input[0].arguments));
  const response = await f.request({input:[{type:'function_call',name:'connect',call_id:'c1',arguments:argumentsText}]});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(JSON.parse(JSON.parse(result.output[0].content[0].text).payload).api_key, special);
  const upstream = JSON.parse(JSON.parse(f.calls[0].body.input[0].arguments).payload).api_key;
  assert.match(upstream, /^CTSEC_v1_[a-f0-9]{32}$/);
  const records = await f.records();
  const page = await (await f.call(`api/v1/security/audit/${records[0].id}/body?snapshot=request`)).json();
  assert.ok(page.chunks.map(chunk => chunk.content).join('').includes(JSON.stringify(argumentsText).slice(1,-1)));
  assert.ok(page.protectionRanges.length);
});

for (const mode of ['start-and-delta', 'responses-reasoning']) test(`opaque placeholder detection spans events (${mode})`, async t => {
  const claude = mode==='start-and-delta';
  const f = await fixture(t, (body,res) => {
    const b = claude ? body.messages[0].content : body.input;
    res.writeHead(200, {'content-type':'text/event-stream'});
    if (claude) {
      res.write(namedEvent({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:b.slice(0,10)}}));
      for (const ch of b.slice(10)) res.write(namedEvent({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:ch}}));
      res.end(namedEvent({type:'message_stop'}));
    } else {
      for (const ch of b) res.write(event({type:'response.reasoning_text.delta',output_index:0,content_index:0,delta:ch}));
      res.end(event({type:'response.completed',response:{output:[]}}));
    }
  }, {claude});
  await assert.rejects(async () => {const response=await f.request({input:key,messages:[{role:'user',content:key}],stream:true});await response.text();});
  const records = await f.records(); assert.equal(records[0].protection.status,'failed');
});

for (const suffix of ['C', 'CTSE', 'ordinary text']) test(`framed SSE EOF releases normal text suffix (${suffix})`, async t => {
  const f = await fixture(t, (body, res) => {
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.end(event({type:'response.output_text.delta',output_index:0,content_index:0,delta:`Tail ${suffix}`}));
  });
  const wire = await (await f.request({input:key,stream:true})).text();
  const events = parseSse(wire).map(item => item.value);
  assert.equal(events.map(value => value.delta).join(''), `Tail ${suffix}`);
});

test('protection locations include repeated inputs, unused mappings and response-only restorations', async t => {
  let previous;
  const f = await fixture(t, (body, res) => {
    previous = body.metadata?.api_key || previous;
    respond(res, body, body.input === 'continue' ? previous : body.input);
  });
  await (await f.request({input:`first ${key} second ${key}`,metadata:{api_key:'history-plain-token'}})).text();
  await (await f.request({input:'continue'})).text();
  const records = await f.records();
  const details = await Promise.all(records.map(async r => (await (await f.call(`api/v1/security/audit/${r.id}`)).json()).record));
  const first = details.find(d=>d.protection.requestCount === 3), second = details.find(d=>d.protection.requestCount === 0);
  assert.ok(first);assert.ok(second);
  const keyMapping = first.protection.mappings.find(m=>m.original===key);
  const route = (d,m,side,offset=0) => `api/v1/security/audit/${d.id}/protection-locations?mapping=${m.id}&side=${side}&offset=${offset}`;
  const page = await (await f.call(route(first,keyMapping,'request'))).json();
  assert.equal(page.total,2);assert.equal(page.items.length,2);assert.equal(page.nextOffset,null);
  for(const hit of page.items) {
    const body = await (await f.call(`api/v1/security/audit/${first.id}/body?snapshot=${hit.snapshotId}&offset=${Math.max(0,hit.start-100)}`)).json();
    const chunk = body.chunks.find(c=>c.start<=hit.start && c.end>=hit.end);
    assert.equal(Buffer.from(chunk.content).subarray(hit.start-chunk.start,hit.end-chunk.start).toString(),key);
  }
  const pastKey = second.protection.mappings.find(m=>m.original===key);
  assert.equal(pastKey.requestCount+pastKey.responseCount,0);
  const restored = second.protection.mappings.find(m=>m.original==='history-plain-token');
  assert.equal(restored.reused,true);assert.equal(restored.requestCount,0);assert.equal(restored.responseCount,1);
  assert.equal((await (await f.call(route(second,restored,'response'))).json()).total,1);
  assert.equal((await f.call(route(first,keyMapping,'invalid'))).status,400);
  assert.equal((await f.call(`api/v1/security/audit/${first.id}/protection-locations?side=request`)).status,400);
  assert.equal((await (await f.call(route(first,keyMapping,'request',2))).json()).items.length,0);
});

for (const spelling of ['plain', 'unicode']) test(`nested duplicate members all protect their original values (${spelling})`, async t => {
  const encoded = spelling === 'unicode' ? [...key].map(ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4,'0')}`).join('') : key;
  const args = `{"value":"${encoded}","value":"safe"}`;
  const f = await fixture(t, (body, res) => respond(res, body, body.input[0].arguments));
  const response = await f.request({input:[{type:'function_call',name:'connect',call_id:'c1',arguments:args}]});
  assert.equal(response.status,200); await response.text();
  const outbound = f.calls[0].body.input[0].arguments;
  assert.ok(!outbound.includes(key)); assert.ok(!outbound.includes(encoded));
  assert.match(outbound,/"value":"CTSEC_v1_[a-f0-9]{32}","value":"safe"/);
  const records = await f.records(); assert.equal(records[0].protection.requestCount,1);
});

test('explicit credential fields retain forced protection inside JSON strings', async t => {
  const plain = 'realPlainCredential';
  const f = await fixture(t, (body, res) => respond(res, body, body.metadata.api_key));
  for (const value of [JSON.stringify([plain]), JSON.stringify({value:plain}), JSON.stringify([JSON.stringify({value:plain})])]) {
    const response = await f.request({input:'start',metadata:{api_key:value}});
    assert.equal(response.status,200); await response.text();
    assert.ok(!JSON.stringify(f.calls.at(-1).body).includes(plain));
    assert.match(f.calls.at(-1).body.metadata.api_key,/CTSEC_v1_/);
  }
  const records = await f.records(); assert.ok(records.every(r=>r.protection.requestCount===1));
});

test('nested non-string credentials fail with the same policy as ordinary fields', async t => {
  const f = await fixture(t, (body, res) => respond(res, body, 'ok'));
  for (const password of [123456789,true,false]) {
    for (const body of [{metadata:{password}}, {input:[{type:'function_call',name:'connect',call_id:'c1',arguments:JSON.stringify({password})}]}, {metadata:{api_key:JSON.stringify([password])}}]) {
      const response = await f.request(body);
      assert.equal(response.status,422); assert.equal((await response.json()).error.code,'credential_protection_failed');
      assert.equal(f.calls.length,0);
    }
  }
  const response = await f.request({input:[{type:'function_call',name:'connect',call_id:'c1',arguments:'{"password":null,"enabled":true}'}]});
  assert.equal(response.status,200); await response.text(); assert.equal(f.calls.length,1);
});

for (const claude of [false,true]) test(`JSON text restores identically for whole, single-character and irregular deltas (${claude ? 'Claude' : 'Responses'})`, async t => {
  const special = 'actual-"quoted"-\\-中文';
  const f = await fixture(t, (body, res) => {
    const token = body.metadata.api_key;
    const text = ' \n' + JSON.stringify(body.metadata.depth === 'nested' ? {payload:JSON.stringify({api_key:token})} : {api_key:token});
    const chunks = body.metadata.partition === 'whole' ? [text] : body.metadata.partition === 'characters' ? [...text] : text.match(/[\s\S]{1,7}/gu);
    res.writeHead(200,{'content-type':'text/event-stream'});
    if (claude) res.write(namedEvent({type:'content_block_start',index:0,content_block:{type:'text',text:''}}));
    for (const chunk of chunks) res.write(claude ? namedEvent({type:'content_block_delta',index:0,delta:{type:'text_delta',text:chunk}}) : event({type:'response.output_text.delta',output_index:0,content_index:0,delta:chunk}));
    if (claude) { res.write(namedEvent({type:'content_block_stop',index:0})); res.end(namedEvent({type:'message_stop'})); }
    else { res.write(event({type:'response.output_text.done',output_index:0,content_index:0,text})); res.end(event({type:'response.completed',response:{output:[]}})); }
  },{claude});
  for (const depth of ['direct','nested']) {
    let reference;
    for (const partition of ['whole','characters','irregular']) {
      const response = await f.request({input:'start',messages:[{role:'user',content:'start'}],metadata:{api_key:special,partition,depth},stream:true});
      assert.equal(response.status,200);
      const events = parseSse(await response.text()).map(item=>item.value);
      const output = events.filter(v=>claude ? v.delta?.type==='text_delta' : v.type==='response.output_text.delta').map(v=>claude ? v.delta.text : v.delta).join('');
      const value=JSON.parse(output);
      assert.equal((depth === 'nested' ? JSON.parse(value.payload) : value).api_key,special);
      if (!claude) assert.equal(output,events.find(v=>v.type==='response.output_text.done').text);
      if (reference) assert.equal(output,reference); else reference=output;
    }
  }
  const records = await f.records(); assert.ok(records.every(r=>r.protection.status==='completed'));
});

for (const mode of ['valid','incomplete']) test(`JSON text at framed EOF retains restoration and failure semantics (${mode})`, async t => {
  const special = 'actual-"quoted"-\\-中文';
  const f = await fixture(t, (body,res) => {
    const b=body.metadata.api_key;
    const text=mode==='valid' ? JSON.stringify([b]) : '{"key":"'+b.slice(0,20);
    res.writeHead(200,{'content-type':'text/event-stream'});
    for (const ch of text) res.write(event({type:'response.output_text.delta',output_index:0,content_index:0,delta:ch}));
    res.end();
  });
  const response = await f.request({input:'start',metadata:{api_key:special},stream:true});
  if (mode==='valid') {
    const output=parseSse(await response.text()).map(item=>item.value.delta).join('');
    assert.deepEqual(JSON.parse(output),[special]);
  } else {
    await assert.rejects(()=>response.text());
    const records=await f.records(); assert.equal(records[0].protection.reason,'response_restore_failed');
  }
});

test('ordinary prose remains incremental while a text channel is still open', async t => {
  let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const f=await fixture(t,async(body,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(event({type:'response.output_text.delta',output_index:0,content_index:0,delta:`Ready ${body.metadata.api_key} now`}));
    await pending;
    res.end(event({type:'response.completed',response:{output:[]}}));
  });
  const special='actual-"quoted"-\\-中文';
  const response=await f.request({input:'start',metadata:{api_key:special},stream:true});
  const reader=response.body.getReader(); let deadline;
  try {
    const first=await Promise.race([reader.read(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('text did not arrive before channel end')),5000);})]);
    const wire=new TextDecoder().decode(first.value);
    assert.equal(parseSse(wire)[0].value.delta,`Ready ${special} now`);
  } finally {clearTimeout(deadline);finish();await reader.cancel();}
});
