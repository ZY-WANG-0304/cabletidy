import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createApplication} from '../../../test/helpers/native-app.mjs';
import {getPaths,normalizeConfig} from '../../../test/helpers/native.mjs';
import {catalogFixture,codexConfigFixture} from '../../../test/helpers/codex-fixture.mjs';
const corpusUrl=new URL(process.env.CABLETIDY_EVALUATION_CORPUS||'./stage3-corpus.mjs',import.meta.url);
const {cases,contracts,marker}=await import(corpusUrl.href);
const root=fileURLToPath(new URL('../../../',import.meta.url));
const output=path.resolve(process.env.CABLETIDY_EVALUATION_OUTPUT||path.join(root,'.cabletidy-debug/credential-protection-evaluation'));
await fs.mkdir(output,{recursive:true});
const hash=v=>createHash('sha256').update(v).digest('hex');
const manifest={version:1,corpusSha256:hash(await fs.readFile(fileURLToPath(corpusUrl))),specimens:cases.length,families:new Set(cases.map(c=>c.family)).size,contracts:contracts.length,
 partition:cases.map(({id,family,split,label,layer,body,expected})=>({id,family,split,label,layer,payloadSha256:hash(JSON.stringify(body)),expectedSha256:hash(JSON.stringify(expected))}))};
// Freeze labels and partition before starting the application or seeing outputs.
await fs.writeFile(path.join(output,'stage3-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const captured=new Map();
const event=v=>`data: ${JSON.stringify(v)}\n\n`;
const upstream=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw);captured.set(body.metadata.evaluationId,{raw,body});
 const text=typeof body.input==='string'?body.input:body.metadata.password||'ok';
 if(body.stream){
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write(event({type:'response.output_item.added',output_index:0,item:{id:'m1',type:'message',role:'assistant',content:[]}}));
  const split=body.metadata.evaluationBoundary;
  for(const delta of [text.slice(0,split),text.slice(split)])res.write(event({type:'response.output_text.delta',item_id:'m1',output_index:0,content_index:0,delta}));
  res.write(event({type:'response.output_text.done',item_id:'m1',output_index:0,content_index:0,text}));
  res.end(event({type:'response.completed',response:{output:[{id:'m1',type:'message',role:'assistant',content:[{type:'output_text',text}]}]}}));
 }else {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'response',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]}));}
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const home=await fs.mkdtemp(path.join(os.tmpdir(),'cabletidy-stage3-eval-'));
const executable=process.env.CABLETIDY_EVALUATION_BINARY||path.join(root,'target/release/cabletidy-test-daemon');
let app;
const normalize=text=>text.replace(/CTSEC_v1_[a-f0-9]{32}/g,marker);
const requestBody=(body,id)=>({model:'gpt-5.5',...body,metadata:{...body.metadata,evaluationId:id}});
const results=[],contractResults=[];
const phase=process.env.CABLETIDY_EVALUATION_PHASE||'regression-after-first-holdout';
const partitionUse=phase.startsWith('regression')?'Previously inspected heldout partition is now regression after failures informed fixes.':'Fresh synthetic holdout frozen before this pass; no tuning on its outputs in this report.';
try{
 app=await createApplication({paths:getPaths(home),executable,loadCodexCatalog:async()=>catalogFixture()});
 const call=(route,body,session)=>fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','session-id':session},body:typeof body==='string'?body:JSON.stringify(body)});
 const config=normalizeConfig(codexConfigFixture());config.web.port=Number(new URL(app.url).port);config.credentialProtection={enabled:true,mappingTtlSeconds:3600};config.upstreams.relay.baseUrl=`http://127.0.0.1:${upstream.address().port}/v1`;
 config.virtualProviders.cabletidy_relay.models['gpt-5.5'].upstreamModelId='gpt-5.5';
 const setup=await call('api/v1/config/commit',{config,baseRevision:0,upstreamSecrets:{relay:'evaluation-transport-auth-only-97Q'}},'setup');assert.equal(setup.status,200);await setup.text();
 const evaluate=async c=>{
  const raw=JSON.stringify(requestBody(c.body,c.id));
  const response=await call('relay/v1/responses',raw,c.id),returned=await response.text();
  const actual=captured.get(c.id),expected=c.expected&&JSON.stringify(requestBody(c.expected,c.id));
  const correct=response.status===(c.label==='blocked'?422:200)&&(c.label==='blocked'?!actual:normalize(actual?.raw||'')===expected);
  const row={id:c.id,family:c.family,layer:c.layer,split:c.split,label:c.label,status:response.status,correct,changed:!!actual&&actual.raw!==raw,replacements:(actual?.raw.match(/CTSEC_v1_[a-f0-9]{32}/g)||[]).length};
  if(!correct)console.log(`FAIL ${c.id} ${response.status}: ${normalize(actual?.raw||returned).slice(0,240)} EXPECTED ${expected?.slice(0,240)}`);
  return row;
 };
 // Inspect tuning first; held-out is a separately enabled pass over frozen labels.
 for(const split of ['tuning',...(process.env.CABLETIDY_EVALUATION_HELDOUT==='1'?['heldout']:[])]){
  const partition=cases.filter(c=>c.split===split);
  for(let offset=0;offset<partition.length;offset+=4)results.push(...await Promise.all(partition.slice(offset,offset+4).map(evaluate)));
  console.log(`${split}: ${results.filter(c=>c.split===split).length} completed`);
 }
 if(process.env.CABLETIDY_EVALUATION_HELDOUT==='1')for(const c of contracts){
  let correct=true;
  const send=async(body,id,session=c.id)=>{
   const response=await call('relay/v1/responses',requestBody(body,id),session),text=await response.text();
   assert.equal(response.status,200,text);return {text,captured:captured.get(id)};
  };
  try{
   if(c.group==='multi-round'||c.group==='isolation'){
    await send({metadata:{password:c.value}},c.id+'-1');const b=captured.get(c.id+'-1').body.metadata.password;
    const session=c.group==='isolation'?c.id+'-other':c.id;
    await send({input:c.value},c.id+'-2',session);correct=captured.get(c.id+'-2').body.input===(c.group==='isolation'?c.value:b);
   }else if(c.group==='split-sse'){
    const result=await send({input:c.value,metadata:{password:c.value,evaluationBoundary:c.boundary},stream:true},c.id);
    const values=result.text.split('\n\n').filter(Boolean).map(s=>JSON.parse(s.slice(s.indexOf('data: ')+6)));
    correct=values.filter(v=>v.type==='response.output_text.delta').map(v=>v.delta).join('')===c.value&&!result.text.includes('CTSEC_v1_');
   }else if(c.group==='duplicate-json'){
    const prefix=`{"model":"gpt-5.5","metadata":{"evaluationId":"${c.id}"},"password":"${c.value}","password":"safeSecond${c.value}"}`;
    const response=await call('relay/v1/responses',prefix,c.id);await response.text();const actual=captured.get(c.id)?.raw;
    correct=response.status===200&&normalize(actual||'')===`{"model":"gpt-5.5","metadata":{"evaluationId":"${c.id}"},"password":"${marker}","password":"${marker}"}`;
   }else{
    const body={input:[{type:'function_call',name:'read',call_id:'call-'+c.id,arguments:JSON.stringify({password:c.value})},{type:'function_call_output',call_id:'call-'+c.id,output:'done'}],tools:[{type:'custom',name:'exec',format:{type:'grammar',syntax:'lark',definition:'start: plain_source\nplain_source: SOURCE\nSOURCE: /[\\s\\S]+/'}}]};
    const {captured:actual}=await send(body,c.id);
    const expected=structuredClone(body);expected.input[0].arguments=JSON.stringify({password:marker});
    correct=normalize(actual.raw)===JSON.stringify(requestBody(expected,c.id));
   }
  }catch(error){correct=false;console.log(`FAIL ${c.id}: ${error.message.slice(0,180)}`);}
  contractResults.push({id:c.id,group:c.group,correct});
 }
 // Ensure observations, including blocked requests, completed the audit path.
 let settled=false,auditCount=0;
 const detectorVersions=new Set();
 for(let i=0;i<600;i++){
  let cursor,active=false,count=0;
  do {
   const data=await(await fetch(app.url+'api/v1/security/audit?kind=request&limit=100'+(cursor?'&cursor='+cursor:''))).json();
   assert.ok(Array.isArray(data.items),'audit listing failed');
   for(const record of data.items)if(record.credentialDetection?.ruleVersion)detectorVersions.add(record.credentialDetection.ruleVersion);
   count+=data.items.length;active ||= data.items.some(r=>r.inspectionProgress?.active!==false);cursor=data.nextCursor;
  }while(cursor);
  auditCount=count;
  if(count>=results.length+contractResults.length&&!active){settled=true;break;}
  await delay(25);
 }
 const wilson=(success,n)=>{if(!n)return null;const z=1.959963984540054,z2=z*z,center=(success/n+z2/(2*n))/(1+z2/n),width=z*Math.sqrt(success/n*(1-success/n)/n+z2/(4*n*n))/(1+z2/n);return {estimate:success/n,lower:Math.max(0,center-width),upper:Math.min(1,center+width),n};};
 const metrics=rows=>{
  const positive=rows.filter(r=>r.label==='positive'),negative=rows.filter(r=>r.label==='negative'),blocked=rows.filter(r=>r.label==='blocked'),ambiguous=rows.filter(r=>r.label==='ambiguous');
  const automatic=rows.filter(r=>r.replacements>0),correctAutomatic=automatic.filter(r=>r.label==='positive'&&r.correct);
  return {specimens:rows.length,families:new Set(rows.map(r=>r.family)).size,pass:rows.filter(r=>r.correct).length,precision: wilson(correctAutomatic.reduce((n,r)=>n+r.replacements,0),automatic.reduce((n,r)=>n+r.replacements,0)),positivePayloadRecall:wilson(positive.filter(r=>r.correct).length,positive.length),negativeChangeRate:wilson(negative.filter(r=>r.changed).length,negative.length),blocked:{total:blocked.length,correct:blocked.filter(r=>r.correct).length},ambiguous:{total:ambiguous.length,unchanged:ambiguous.filter(r=>!r.changed).length}};
 };
 const strata={};for(const split of ['tuning','heldout'])strata[split]={total:metrics(results.filter(r=>r.split===split)),layers:Object.fromEntries([...new Set(cases.map(c=>c.layer))].map(layer=>[layer,metrics(results.filter(r=>r.split===split&&r.layer===layer))]))};
 assert.equal(detectorVersions.size,1,'evaluation must observe one detector version');
 const report={date:new Date().toISOString(),phase,partitionUse,detectorVersion:[...detectorVersions][0],auditPolicyVersion:'audit-4',binarySha256:hash(await fs.readFile(executable)),manifestSha256:hash(JSON.stringify(manifest)),scope:'Local synthetic grouped diagnostic evaluation. Families contain correlated variants; Wilson intervals are descriptive specimen intervals, not independent or production inference. Exact full wire payload comparison verifies noncredential bytes as well as replacement. Refusals are separate. No online credential validation.',auditSettled:settled,auditCount,strata,contractSummary:Object.fromEntries([...new Set(contracts.map(c=>c.group))].map(group=>[group,{total:contractResults.filter(c=>c.group===group).length,correct:contractResults.filter(c=>c.group===group&&c.correct).length}])),results,contracts:contractResults};
 await fs.writeFile(path.join(output,'stage3-evaluation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({strata,contractSummary:report.contractSummary,auditSettled:settled},null,2));
 assert.ok(results.every(r=>r.correct)&&contractResults.every(r=>r.correct)&&settled,'stage3 evaluation has failures');
}finally{await app?.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await fs.rm(home,{recursive:true,force:true});}
