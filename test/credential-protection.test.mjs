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
async function fixture(t, handler, { claude = false, enabled = true, upstreamSecret = authentication, ttl = 3600 } = {}) {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls.push({body, headers:req.headers, url:req.url});
    try { await handler(body, res); } catch (e) { res.destroy(e); }
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cabletidy-protection-'));
  let app = await createApplication({paths:getPaths(home), loadCodexCatalog:async () => catalogFixture()});
  t.after(async () => { upstream.closeAllConnections(); await Promise.all([app.close(),new Promise(r=>upstream.close(r))]); await fs.rm(home,{recursive:true,force:true}); });
  const config = normalizeConfig(claude ? claudeConfigFixture() : codexConfigFixture());
  config.web.port = Number(new URL(app.url).port);
  config.upstreams.relay.baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  config.credentialProtection = { enabled, mappingTtlSeconds:ttl };
  const call = (route,body,headers={}) => fetch(`${app.url}${route}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const commit = await call('api/v1/config/commit',{config,baseRevision:0,upstreamSecrets:{relay:upstreamSecret}});
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

test('query credentials use form decoding for keys and values while literal plus signs stay literal', async t => {
  const plain = 'actual secret with spaces';
  const f = await fixture(t, (body, res) => respond(res, body, body.metadata.api_key));
  const body = {model:f.model,input:plain,metadata:{api_key:plain}};
  for (const query of [
    `extra=${encodeURIComponent(plain)}`,
    'extra=actual+secret+with+spaces',
    'actual+secret+with+spaces=safe',
    'extra=actual%20secret+with%20spaces',
  ]) {
    const response = await f.call(`relay/v1/responses?${query}`, body);
    assert.equal(response.status, 422, query); await response.text();
    assert.equal(f.calls.length, 0);
  }
  for (const query of ['extra=actual%2Bsecret%2Bwith%2Bspaces', 'extra=ordinary+text']) {
    const response = await f.call(`relay/v1/responses?${query}`, body);
    assert.equal(response.status, 200); assert.equal((await response.json()).output[0].content[0].text, plain);
    const expected = new URLSearchParams(query).get('extra');
    assert.equal(new URL(f.calls.at(-1).url, 'http://fixture').searchParams.get('extra'), expected);
  }
  const response = await f.call('relay/v1/responses', body, {'openai-project':'actual+secret+with+spaces'});
  assert.equal(response.status, 200); await response.text();
  assert.equal(f.calls.at(-1).headers['openai-project'], 'actual+secret+with+spaces');
  const plus = 'real+literal+secret';
  const blocked = await f.call(`relay/v1/responses?extra=${encodeURIComponent(plus)}`, {...body,metadata:{api_key:plus}});
  assert.equal(blocked.status, 422);
});

for (const claude of [false, true]) for (const exactFormat of [false, true]) test(`saved and declared credentials with placeholder prefixes remain protected (${claude ? 'Claude' : 'Responses'}, exactFormat=${exactFormat})`, async t => {
  // A local credential is authoritative even when its spelling matches a complete B.
  const saved = exactFormat ? 'CTSEC_v1_0123456789abcdef0123456789abcdef' : 'CTSEC_v1_MyUniqueSavedCredential_2026!';
  const password = 'CTSEC_v1_MyActualPassword_2026!';
  const f = await fixture(t, (body, res) => respond(res, body, body.metadata.password), {claude,upstreamSecret:saved});
  const response = await f.request({input:`Use ${saved} and ${password}`,messages:[{role:'user',content:`Use ${saved} and ${password}`}],metadata:{password}});
  assert.equal(response.status, 200); assert.equal((await response.json()).output[0].content[0].text, password);
  const upstream = f.calls[0]; const wire = JSON.stringify(upstream.body);
  assert.ok(!wire.includes(saved)); assert.ok(!wire.includes(password));
  assert.equal(claude ? upstream.headers['x-api-key'] : upstream.headers.authorization, claude ? saved : `Bearer ${saved}`);
  assert.match(upstream.body.metadata.password, /^CTSEC_v1_[a-f0-9]{32}$/);
  const records = await f.records(); const detail = await (await f.call(`api/v1/security/audit/${records[0].id}`)).json();
  assert.equal(detail.record.protection.status, 'completed');
  assert.deepEqual(new Set(detail.record.protection.mappings.map(m => m.original)), new Set([saved,password]));
});

for (const claude of [false, true]) test(`non-ASCII forwarded headers fail closed and disabled protection preserves them (${claude ? 'Claude' : 'Responses'})`, async t => {
  const f = await fixture(t, (body, res) => respond(res, body, body.input), {claude});
  const body = {model:f.model,input:'start',metadata:{api_key:key}};
  const route = claude ? 'claude-main/v1/messages' : 'relay/v1/responses';
  const extra = claude ? 'anthropic-beta' : 'openai-project';
  for (const name of [extra, 'accept']) {
    for (const value of [`prefix ${key}`, `\u00e9 ${key}`, '\u00e9 safe']) {
      const response = await f.call(route, body, {[name]:value});
      assert.equal(response.status, 422, `${name}: ${value}`); await response.text();
      assert.equal(f.calls.length, 0);
    }
  }
  const result = await (await f.call('api/v1/config')).json(); result.config.credentialProtection.enabled = false;
  const committed = await f.call('api/v1/config/commit', {config:result.config,baseRevision:result.config.revision});
  assert.equal(committed.status, 200); await committed.text();
  const response = await f.call(route, body, {[extra]:`\u00e9 ${key}`,accept:`\u00e9 ${key}`});
  assert.equal(response.status, 200); await response.text();
  assert.ok(f.calls[0].headers[extra].endsWith(key)); assert.ok(f.calls[0].headers.accept.endsWith(key));
});

for (const completed of [false, true]) test(`SSE DONE flushes pending channels and preserves the marker (completed=${completed})`, async t => {
  const f = await fixture(t, (body, res) => {
    res.writeHead(200, {'content-type':'text/event-stream'});
    const text = JSON.stringify({api_key:body.metadata.api_key});
    for (const ch of text) res.write(event({type:'response.output_text.delta',output_index:0,content_index:0,delta:ch}));
    res.write(event({type:'response.output_text.delta',output_index:1,content_index:0,delta:'Implemented in C'}));
    const args = JSON.stringify({payload:JSON.stringify({api_key:body.metadata.api_key})});
    for (const ch of args) res.write(event({type:'response.function_call_arguments.delta',output_index:2,delta:ch}));
    if (completed) res.write(event({type:'response.completed',response:{output:[]}}));
    res.end('id: terminal\r\ndata: [DONE]\r\n\r\n');
  });
  const special = 'actual-"quoted"-\\-中文';
  const wire = await (await f.request({input:'start',metadata:{api_key:special},stream:true})).text();
  assert.ok(wire.endsWith('id: terminal\r\ndata: [DONE]\r\n\r\n'));
  const values = parseSse(wire.slice(0,wire.indexOf('id: terminal'))).map(item => item.value);
  const text = values.filter(v => v.type==='response.output_text.delta' && v.output_index===0).map(v=>v.delta).join('');
  assert.equal(JSON.parse(text).api_key, special);
  assert.equal(values.filter(v => v.type==='response.output_text.delta' && v.output_index===1).map(v=>v.delta).join(''), 'Implemented in C');
  const args = values.filter(v => v.type==='response.function_call_arguments.delta').map(v=>v.delta).join('');
  assert.equal(JSON.parse(JSON.parse(args).payload).api_key, special);
  const records = await f.records(); assert.equal(records[0].protection.status, 'completed');
});

for (const enabled of [false, true]) test(`SSE DONE preserves responses with no credential mappings (enabled=${enabled})`, async t => {
  const f = await fixture(t, (body, res) => {
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.write(event({type:'response.completed',response:{model:body.model,output:[]}}));
    res.end('data: [DONE]\n\n');
  }, {enabled});
  const response = await f.request({input:'safe',stream:true});
  assert.equal(response.status, 200); assert.ok((await response.text()).endsWith('data: [DONE]\n\n'));
  const records = await f.records(); assert.equal(records[0].outcome, 'completed');
  if (enabled) assert.equal(records[0].protection.status, 'completed');
});

test('SSE DONE keeps fail-closed checks for incomplete placeholders', async t => {
  const f = await fixture(t, (body, res) => {
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.write(event({type:'response.output_text.delta',output_index:0,content_index:0,delta:body.input.slice(0,15)}));
    res.end('data: [DONE]\n\n');
  });
  await assert.rejects(async () => {const response=await f.request({input:key,stream:true});await response.text();});
  const records = await f.records(); assert.equal(records[0].protection.status, 'failed');
});

test('slow request headers renew the session before the old idle deadline', {timeout:100_000}, async t => {
  let prior;
  const f = await fixture(t, (body, res) => {prior ||= body.metadata?.api_key; respond(res, body, prior);}, {ttl:60});
  const plain = 'slowRequestPlainCredential';
  const first = await f.request({input:'start',metadata:{api_key:plain}}, 'slow-session');
  assert.equal((await first.json()).output[0].content[0].text, plain);
  const records = await f.records();
  const detail = await (await f.call(`api/v1/security/audit/${records[0].id}`)).json();
  const deadline = detail.record.protection.expiresAtMs;
  await delay(Math.max(0,deadline-Date.now()-10_000));
  const body = JSON.stringify({model:f.model,input:'continue',max_tokens:100});
  const slow = http.request(new URL('relay/v1/responses', f.app.url), {
    method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),'session-id':'slow-session'},
  });
  t.after(() => slow.destroy());
  const finished = new Promise((resolve,reject) => {
    slow.on('error',reject);
    slow.on('response',res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});
  });
  slow.flushHeaders(); slow.write(body.slice(0,1));
  let accepted;
  for (let i=0;i<200;i++) {
    const list = await (await f.call('api/v1/security/audit?kind=request')).json();
    accepted = list.items?.find(r=>r.id!==records[0].id);
    if (accepted) break;
    await delay(20);
  }
  assert.ok(accepted, 'gateway received the request headers'); assert.ok(accepted.atMs < deadline);
  await delay(Math.max(0,deadline-Date.now()+3_000)); slow.end(body.slice(1));
  const response = await finished;
  assert.equal(response.status, 200); assert.equal(response.body.output[0].content[0].text, plain);
  assert.equal(f.calls.length, 2); assert.match(prior, /^CTSEC_v1_[a-f0-9]{32}$/);
  const after = await f.records(); const renewed = await (await f.call(`api/v1/security/audit/${accepted.id}`)).json();
  assert.equal(after.length, 2); assert.equal(renewed.record.protection.mappings[0].reused, true);
  assert.ok(renewed.record.protection.expiresAtMs > deadline);
});

for (const claude of [false, true]) test(`known placeholders in assignments and nested commands reuse the original mapping (${claude ? 'Claude' : 'Responses'})`, async t => {
  const original = 'actual-"quoted"-\\-中文CredentialValue';
  const f = await fixture(t, (body, res) => respond(res, body, body.input ?? body.metadata.api_key), {claude});
  const first = await f.request({metadata:{api_key:original}});
  assert.equal(first.status, 200); assert.equal((await first.json()).output[0].content[0].text, original);
  const b = f.calls[0].body.metadata.api_key;
  const values = [
    value => `plain ${value}`,
    value => `api_key=${value}`,
    value => `api_key="${value}"`,
    value => `export API_KEY=${value}`,
    value => JSON.stringify({api_key:value}),
    value => JSON.stringify({command:`export API_KEY=${value}`}),
    value => JSON.stringify({arguments:JSON.stringify({command:`export API_KEY=${value}`})}),
    value => `Bearer ${value}`,
    value => `https://example.invalid/?api_key=${value}`,
  ];
  for (const make of values) {
    const input = make(b);
    const response = await f.request({input});
    assert.equal(response.status, 200, input);
    const text = (await response.json()).output[0].content[0].text;
    assert.equal(f.calls.at(-1).body.input, input, 'upstream keeps the existing B');
    assert.equal(text, make(original), 'client receives the original A');
  }
  const authorization = `Bearer ${b}`;
  const authorized = await f.request({input:authorization,metadata:{authorization}});
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).output[0].content[0].text, `Bearer ${original}`);
  assert.equal(f.calls.at(-1).body.metadata.authorization, authorization);
  const records = await f.records(); assert.equal(records.length, values.length + 2);
  for (const record of records) {
    const detail = await (await f.call(`api/v1/security/audit/${record.id}`)).json();
    const protection = detail.record.protection;
    assert.equal(protection.status, 'completed'); assert.equal(protection.mappings.length, 1);
    assert.equal(protection.mappings[0].original, original); assert.equal(protection.mappings[0].replacement, b);
    if (record.protection.requestCount === 0) {
      assert.equal(protection.responseCount, 1); assert.equal(protection.mappings[0].reused, true);
      const page = await (await f.call(`api/v1/security/audit/${record.id}/body?snapshot=response`)).json();
      assert.ok(page.protectionRanges.length, 'restored A retains protection evidence');
    }
  }
});

test('unknown and other-session placeholders in assignments stay literal without new credential mappings', async t => {
  const f = await fixture(t, (body,res)=>respond(res,body,body.input ?? body.metadata.api_key));
  const first = await f.request({metadata:{api_key:'actualCredentialValue'}}, 'source-session'); await first.text();
  const other = f.calls[0].body.metadata.api_key;
  for (const b of [other,'CTSEC_v1_00000000000000000000000000000000']) {
    const input = JSON.stringify({command:`export API_KEY=${b}`});
    const response = await f.request({input}, 'unrelated-session');
    assert.equal(response.status, 200); assert.equal((await response.json()).output[0].content[0].text, input);
    assert.equal(f.calls.at(-1).body.input, input);
  }
  const records = await f.records();
  for (const record of records.filter(r => r.protection.requestCount === 0)) {
    const detail = await (await f.call(`api/v1/security/audit/${record.id}`)).json();
    assert.deepEqual(detail.record.protection.mappings, []); assert.equal(detail.record.protection.responseCount, 0);
  }
});

test('a saved real credential equal to an existing B still takes priority over placeholder exemption', async t => {
  const f = await fixture(t, (body,res)=>respond(res,body,body.input ?? body.metadata.api_key));
  const first = await f.request({metadata:{api_key:'actualCredentialValue'}}); await first.text();
  const saved = f.calls[0].body.metadata.api_key;
  const firstRecords = await f.records();
  const config = await (await f.call('api/v1/config')).json();
  const commit = await f.call('api/v1/config/commit', {config:config.config,baseRevision:config.config.revision,upstreamSecrets:{relay:saved}});
  assert.equal(commit.status, 200); await commit.text();
  const input = `api_key=${saved}`;
  const response = await f.request({input}); assert.equal(response.status, 200);
  assert.equal((await response.json()).output[0].content[0].text, input);
  assert.ok(!f.calls.at(-1).body.input.includes(saved));
  assert.equal(f.calls.at(-1).headers.authorization, `Bearer ${saved}`);
  const records = await f.records();
  const record = records.find(r => r.id !== firstRecords[0].id);
  assert.ok(record);
  const detail = await (await f.call(`api/v1/security/audit/${record.id}`)).json();
  assert.ok(detail.record.protection.mappings.some(m=>m.original===saved && m.requestCount===1 && m.responseCount===1));
});

for (const claude of [false, true]) test(`known placeholder commands restore original credentials in streamed tool arguments (${claude ? 'Claude' : 'Responses'})`, async t => {
  const original = 'actual-"quoted"-\\-中文CredentialValue';
  const f = await fixture(t, (body,res) => {
    if (!body.stream) return respond(res,body,body.metadata.api_key);
    const args = body.input;
    res.writeHead(200, {'content-type':'text/event-stream'});
    if (claude) res.write(namedEvent({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'c1',name:'run',input:{}}}));
    for (const ch of args) res.write(claude
      ? namedEvent({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:ch}})
      : event({type:'response.function_call_arguments.delta',output_index:0,delta:ch}));
    if (claude) {res.write(namedEvent({type:'content_block_stop',index:0}));res.end(namedEvent({type:'message_stop'}));}
    else {res.write(event({type:'response.function_call_arguments.done',output_index:0,arguments:args}));res.end(event({type:'response.completed',response:{output:[]}}));}
  }, {claude});
  const first = await f.request({metadata:{api_key:original}}); await first.text();
  const b = f.calls[0].body.metadata.api_key;
  const input = JSON.stringify({command:`export API_KEY=${b}`});
  const wire = await (await f.request({input,stream:true})).text();
  assert.equal(f.calls[1].body.input, input);
  const values = parseSse(wire).map(item=>item.value);
  const args = values.filter(v=>claude ? v.delta?.type==='input_json_delta' : v.type==='response.function_call_arguments.delta')
    .map(v=>claude ? v.delta.partial_json : v.delta).join('');
  assert.equal(JSON.parse(args).command, `export API_KEY=${original}`);
  assert.ok(!wire.includes(b));
  const records = await f.records(); const streamed = records.find(r=>r.protection.requestCount===0);
  assert.ok(streamed); const detail = await (await f.call(`api/v1/security/audit/${streamed.id}`)).json();
  assert.equal(detail.record.protection.status,'completed'); assert.equal(detail.record.protection.mappings.length,1);
  assert.equal(detail.record.protection.mappings[0].original,original);
  assert.ok(detail.record.protection.responseCount>0);
});

for (const claude of [false, true]) test(`new credentials in environment tool output use the same field recognition as JSON (${claude ? 'Claude' : 'Responses'})`, async t => {
  const f = await fixture(t, (body,res)=>respond(res,body,claude ? body.messages[1].content[0].content : body.input[0].output), {claude});
  const original = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  for (const name of ['API_KEY','AWS_SECRET_ACCESS_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','X_AUTH_TOKEN','ID_TOKEN','secretAccessKey','proxy-authorization']) {
    for (const make of [a=>`${name}=${a}`, a=>`export ${name}="${a}"`, a=>JSON.stringify({[name]:a})]) {
      const output = make(original);
      const body = claude ? {messages:[{role:'assistant',content:[{type:'tool_use',id:'c1',name:'shell',input:{command:'cat .env'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'c1',content:output}]}]} : {input:[{type:'function_call_output',call_id:'c1',output}]};
      const response = await f.request(body, `${name.replaceAll('-','_')}-${output.startsWith('{')?'json':'env'}`);
      assert.equal(response.status,200); assert.equal((await response.json()).output[0].content[0].text,output);
      const upstream = claude ? f.calls.at(-1).body.messages[1].content[0].content : f.calls.at(-1).body.input[0].output;
      assert.ok(!upstream.includes(original), name); assert.match(upstream,/CTSEC_v1_[a-f0-9]{32}/);
    }
  }
  const records = await f.records();
  for (const record of records) {assert.equal(record.protection.status,'completed');assert.ok(record.protection.requestCount>0);}
});

test('decoded query credential names force checks for newly supplied values', async t => {
  const f = await fixture(t,(body,res)=>respond(res,body,'ok'));
  const original = 'new plain credential';
  for (const name of ['id_token','aws_secret_access_key','openai_api_key','anthropic_api_key','x_auth_token','secretAccessKey','access_token','refresh_token','client_secret']) {
    for (const value of [encodeURIComponent(original), original.replaceAll(' ','+')]) {
      const query = `${name.replaceAll('_','%5F')}=${value}`;
      const response = await f.call(`relay/v1/responses?${query}`,{model:f.model,input:'safe'});
      assert.equal(response.status,422,query); await response.text(); assert.equal(f.calls.length,0);
    }
  }
  for (const query of ['id_token=','ordinary=plain+value']) {
    const response = await f.call(`relay/v1/responses?${query}`,{model:f.model,input:'safe'});
    assert.equal(response.status,200); await response.text();
  }
});

for (const claude of [false, true]) test(`SSE initial text participates in every placeholder boundary (${claude ? 'Claude' : 'Responses'})`, async t => {
  let split=0;
  const f = await fixture(t,(body,res)=>{
    const b = body.metadata.api_key;
    res.writeHead(200,{'content-type':'text/event-stream'});
    if (claude) {
      res.write(namedEvent({type:'content_block_start',index:2,content_block:{type:'text',text:`prefix ${b.slice(0,split)}`}}));
      res.write(namedEvent({type:'content_block_delta',index:2,delta:{type:'text_delta',text:`${b.slice(split)} suffix`}}));
      res.write(namedEvent({type:'content_block_stop',index:2})); res.end(namedEvent({type:'message_stop'}));
    } else {
      res.write(namedEvent({type:'response.content_part.added',item_id:'m1',output_index:2,content_index:3,part:{type:'output_text',text:`prefix ${b.slice(0,split)}`}}));
      res.write(namedEvent({type:'response.output_text.delta',item_id:'m1',output_index:2,content_index:3,delta:`${b.slice(split)} suffix`}));
      res.write(namedEvent({type:'response.output_text.done',item_id:'m1',output_index:2,content_index:3,text:`prefix ${b} suffix`}));
      res.end(namedEvent({type:'response.completed',response:{output:[]}}));
    }
  },{claude});
  for (split of [0,1,7,8,12,39,40]) {
    const response = await f.request({input:'echo',messages:[{role:'user',content:'echo'}],metadata:{api_key:key},stream:true});
    const events = parseSse(await response.text());
    for (const e of events) assert.equal(e.name,e.value.type);
    const text = events.map(e=>e.value).filter(v=>claude ? v.index===2 : ['response.content_part.added','response.output_text.delta'].includes(v.type))
      .map(v=>claude ? v.content_block?.text ?? v.delta?.text ?? '' : v.part?.text ?? v.delta ?? '').join('');
    assert.equal(text,`prefix ${key} suffix`,String(split));
    assert.equal(events.filter(e=>e.value.type===(claude?'content_block_start':'response.content_part.added')).length,1);
  }
  const records = await f.records();
  for (const r of records) {
    assert.equal(r.protection.status,'completed');assert.ok(r.protection.responseCount>0);
    const detail=await(await f.call(`api/v1/security/audit/${r.id}`)).json();
    const mapping=detail.record.protection.mappings[0];
    assert.equal(mapping.original,key);
    const locations=await(await f.call(`api/v1/security/audit/${r.id}/protection-locations?mapping=${mapping.id}&side=response`)).json();
    assert.ok(locations.total>0,'initial/delta restoration keeps navigable original evidence');
  }
});

for (const claude of [false, true]) for (const mode of ['stop','eof','incomplete']) test(`SSE initial JSON text determines escaping and terminal checks (${claude ? 'Claude' : 'Responses'}, ${mode})`, async t => {
  const original = 'real-"quoted"-\\-中文';
  const f = await fixture(t,(body,res)=>{
    const b=body.metadata.password;
    res.writeHead(200,{'content-type':'text/event-stream'});
    const text=mode==='incomplete' ? b.slice(0,15) : `{"password":"${b}"}`;
    const initial=mode==='stop' ? '{"password":"' : text;
    if (claude) {
      res.write(namedEvent({type:'content_block_start',index:0,content_block:{type:'text',text:initial}}));
      if(mode==='stop') res.write(namedEvent({type:'content_block_delta',index:0,delta:{type:'text_delta',text:`${b}"}`}}));
      if(mode!=='eof') {res.write(namedEvent({type:'content_block_stop',index:0}));res.write(namedEvent({type:'message_stop'}));}
    } else {
      res.write(namedEvent({type:'response.content_part.added',output_index:0,content_index:0,part:{type:'output_text',text:initial}}));
      if(mode==='stop') res.write(namedEvent({type:'response.output_text.delta',output_index:0,content_index:0,delta:`${b}"}`}));
      if(mode!=='eof') res.write(namedEvent({type:'response.completed',response:{output:[]}}));
    }
    res.end();
  },{claude});
  const request=()=>f.request({input:'echo',messages:[{role:'user',content:'echo'}],metadata:{password:original},stream:true});
  if(mode==='incomplete') {
    await assert.rejects(async()=>{await(await request()).text();});
  } else {
    const events=parseSse(await(await request()).text());
    for (const e of events) assert.equal(e.name,e.value.type);
    const text=events.map(e=>e.value).filter(v=>claude ? v.index===0 : ['response.content_part.added','response.output_text.delta'].includes(v.type))
      .map(v=>claude ? v.content_block?.text ?? v.delta?.text ?? '' : v.part?.text ?? v.delta ?? '').join('');
    assert.deepEqual(JSON.parse(text),{password:original});
    assert.equal(events.filter(e=>e.value.type===(claude?'content_block_start':'response.content_part.added')).length,1);
  }
  const records=await f.records();assert.equal(records[0].protection.status,mode==='incomplete'?'failed':'completed');
});

for (const claude of [false, true]) test(`nested credential schema properties preserve ordinary defaults and protect genuine token defaults (${claude ? 'Claude' : 'Responses'})`, async t => {
  const f=await fixture(t,(body,res)=>respond(res,body,'ok'),{claude});
  const properties={token:{type:'string',default:key},enabled:{type:'boolean',default:false},timeout:{type:'number',const:30},encoding:{type:'string',default:'utf8',enum:['utf8','ascii'],examples:['utf8']}};
  for (const name of ['authentication','password','connection']) {
    const parameters={type:'object',properties:{[name]:{type:'object',properties,required:['token','enabled']}}};
    const tools=claude?[{name:'connect',input_schema:parameters}]:[{type:'function',name:'connect',parameters}];
    const response=await f.request({input:'start',messages:[{role:'user',content:'start'}],tools});
    assert.equal(response.status,200,name);await response.text();
    const schema=claude?f.calls.at(-1).body.tools[0].input_schema:f.calls.at(-1).body.tools[0].parameters;
    const actual=schema.properties[name].properties;
    assert.deepEqual({...actual,token:properties.token},properties);assert.match(actual.token.default,/^CTSEC_v1_[a-f0-9]{32}$/);
  }
});

for (const channel of ['refusal','summary']) for (const deltas of [false,true]) test(`SSE initial ${channel} uses its own delta event and isolated channel (deltas=${deltas})`, async t => {
  const f=await fixture(t,(body,res)=>{
    const b=body.metadata.api_key;
    const summary=channel==='summary';
    const prefix=summary?'response.reasoning_summary_part':'response.content_part';
    const delta=summary?'response.reasoning_summary_text':'response.refusal';
    const field=summary?'text':'refusal';
    const index=summary?{summary_index:3}:{content_index:3};
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(namedEvent({type:`${prefix}.added`,output_index:2,...index,part:{type:summary?'summary_text':'refusal',[field]:deltas?b.slice(0,12):`literal CTSE`}}));
    if(deltas) res.write(namedEvent({type:`${delta}.delta`,output_index:2,...index,delta:b.slice(12)}));
    res.write(namedEvent({type:'response.output_text.delta',output_index:2,content_index:3,delta:'ordinary text'}));
    res.end(namedEvent({type:'response.completed',response:{output:[]}}));
  });
  const events=parseSse(await(await f.request({input:'echo',metadata:{api_key:key},stream:true})).text());
  for(const e of events) assert.equal(e.name,e.value.type);
  const family=channel==='summary'?'response.reasoning_summary_part':'response.content_part';
  const delta=channel==='summary'?'response.reasoning_summary_text.delta':'response.refusal.delta';
  const text=events.map(e=>e.value).filter(v=>v.type===`${family}.added`||v.type===delta)
    .map(v=>v.part?.[channel==='summary'?'text':'refusal']??v.delta??'').join('');
  assert.equal(text,deltas?key:'literal CTSE');
  assert.equal(events.map(e=>e.value).filter(v=>v.type==='response.output_text.delta').map(v=>v.delta).join(''),'ordinary text');
});

async function assertRestorationCount(f, expected, original = key) {
  const [record] = await f.records();
  assert.equal(record.protection.status, 'completed');
  assert.equal(record.protection.responseCount, expected);
  const detail = await (await f.call(`api/v1/security/audit/${record.id}`)).json();
  const mapping = detail.record.protection.mappings.find(m => m.original === original);
  assert.ok(mapping);
  assert.equal(mapping.responseCount, expected);
  return {record,mapping};
}

async function assertRestorationEvidence(f, expected, original = key) {
  const {record,mapping} = await assertRestorationCount(f,expected,original);
  const locations = await (await f.call(`api/v1/security/audit/${record.id}/protection-locations?mapping=${mapping.id}&side=response`)).json();
  assert.equal(locations.total, expected);
  assert.equal(locations.items.length, expected);
  for (const hit of locations.items) {
    const body = await (await f.call(`api/v1/security/audit/${record.id}/body?snapshot=${hit.snapshotId}&offset=${Math.max(0,hit.start-100)}`)).json();
    assert.ok(body.chunks.some(c => c.start <= hit.start && c.end >= hit.end));
    assert.ok(body.protectionRanges.length, 'restored content remains highlighted');
    if (original === key) {
      const chunk = body.chunks.find(c => c.start <= hit.start && c.end >= hit.end);
      assert.equal(Buffer.from(chunk.content).subarray(hit.start-chunk.start,hit.end-chunk.start).toString(), key);
    }
  }
}

for (const channel of ['Claude','output_text','refusal','summary']) for (const mode of ['full','split','json']) test(`SSE initial ${channel} restores sibling citations and annotations (${mode})`, async t => {
  const claude = channel === 'Claude', summary = channel === 'summary';
  const original = mode === 'json' ? 'real-"quoted"-\\-中文' : key;
  const field = channel === 'refusal' ? 'refusal' : 'text';
  const partFamily = summary ? 'response.reasoning_summary_part' : 'response.content_part';
  const textFamily = summary ? 'response.reasoning_summary_text' : channel === 'refusal' ? 'response.refusal' : 'response.output_text';
  const indexes = {output_index:2,...(summary ? {summary_index:3} : {content_index:3})};
  const f = await fixture(t, (body,res) => {
    const b = claude ? body.messages[0].content[0].source.data : body.input;
    const text = mode === 'json' ? JSON.stringify({password:b}) : `Credential: ${b}`;
    const split = mode === 'split' ? text.indexOf(b) + 12 : text.length;
    res.writeHead(200, {'content-type':'text/event-stream'});
    if (claude) {
      const citation = {type:'char_location',cited_text:b,document_index:0,document_title:'Credential document',start_char_index:0,end_char_index:b.length};
      res.write(namedEvent({type:'message_start',message:{id:'m1',type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:1,output_tokens:1}}}));
      // Put citations before text so the indexed leaf is not its first sibling.
      res.write(namedEvent({type:'content_block_start',index:2,content_block:{type:'text',citations:[citation],text:text.slice(0,split)}}));
      if (mode === 'split') res.write(namedEvent({type:'content_block_delta',index:2,delta:{type:'text_delta',text:text.slice(split)}}));
      res.write(namedEvent({type:'content_block_stop',index:2}));
      res.write(namedEvent({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}}));
      res.end(namedEvent({type:'message_stop'}));
    } else {
      const annotations = [{type:'url_citation',start_index:0,end_index:text.length,url:'https://example.invalid/source',title:b}];
      const part = {type:summary ? 'summary_text' : channel,annotations,[field]:text.slice(0,split)};
      res.write(namedEvent({type:`${partFamily}.added`,item_id:'m1',...indexes,part}));
      if (mode === 'split') res.write(namedEvent({type:`${textFamily}.delta`,item_id:'m1',...indexes,delta:text.slice(split)}));
      res.write(namedEvent({type:`${textFamily}.done`,item_id:'m1',...indexes,[field]:text}));
      res.end(namedEvent({type:'response.completed',response:{output:[]}}));
    }
  }, {claude});
  const response = await f.request({
    ...(claude ? {messages:[{role:'user',content:[{type:'document',source:{type:'text',media_type:'text/plain',data:original},title:'Credential document',citations:{enabled:true}},{type:'text',text:'Quote the document'}]}]} : {input:original}),
    ...(mode === 'json' ? {metadata:{password:original}} : {}),stream:true,
  });
  assert.equal(response.status,200);
  const wire = await response.text(), events = parseSse(wire);
  assert.ok(!wire.includes('CTSEC_v1_'));
  for (const e of events) assert.equal(e.name,e.value.type);
  const values = events.map(e => e.value);
  const initial = values.find(v => v.type === (claude ? 'content_block_start' : `${partFamily}.added`));
  assert.equal(claude ? initial.content_block.citations[0].cited_text : initial.part.annotations[0].title, original);
  const text = values.filter(v => claude ? v.index === 2 : [ `${partFamily}.added`, `${textFamily}.delta` ].includes(v.type))
    .map(v => claude ? v.content_block?.text ?? v.delta?.text ?? '' : v.part?.[field] ?? v.delta ?? '').join('');
  if (mode === 'json') assert.deepEqual(JSON.parse(text),{password:original});
  else assert.equal(text,`Credential: ${original}`);
  const upstreamValue = claude ? f.calls[0].body.messages[0].content[0].source.data : f.calls[0].body.input;
  assert.match(upstreamValue,/^CTSEC_v1_[a-f0-9]{32}$/);
  if (channel === 'refusal') await assertRestorationCount(f,3,original);
  else await assertRestorationEvidence(f,claude ? 2 : 3,original);
});

for (const field of ['text','partial_json']) for (const buffered of [false,true]) test(`Claude SSE ${field} delta restores sibling extension fields (buffered=${buffered})`, async t => {
  const f = await fixture(t,(body,res) => {
    const b = body.messages[0].content;
    const text = field === 'partial_json' || buffered ? JSON.stringify({api_key:b}) : `Credential: ${b}`;
    const split = text.indexOf(b) + 12;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(namedEvent({type:'content_block_start',index:2,content_block:field === 'text' ? {type:'text',text:''} : {type:'tool_use',id:'c1',name:'connect',input:{}}}));
    res.write(namedEvent({type:'content_block_delta',index:2,delta:{type:field === 'text' ? 'text_delta' : 'input_json_delta',...(buffered ? {} : {source:{title:b}}),[field]:text.slice(0,split)}}));
    res.write(namedEvent({type:'content_block_delta',index:2,delta:{type:field === 'text' ? 'text_delta' : 'input_json_delta',...(buffered ? {source:{title:b}} : {}),[field]:text.slice(split)}}));
    res.write(namedEvent({type:'content_block_stop',index:2}));
    res.end(namedEvent({type:'message_stop'}));
  },{claude:true});
  const wire = await (await f.request({messages:[{role:'user',content:key}],stream:true})).text();
  const values = parseSse(wire).map(e => e.value);
  assert.ok(!wire.includes('CTSEC_v1_'));
  for (const v of values.filter(v => v.delta?.source)) assert.equal(v.delta.source.title,key);
  const text = values.map(v => v.delta?.[field] ?? '').join('');
  if (field === 'partial_json' || buffered) assert.deepEqual(JSON.parse(text),{api_key:key});
  else assert.equal(text,`Credential: ${key}`);
  await assertRestorationCount(f,buffered ? 3 : 2);
});
