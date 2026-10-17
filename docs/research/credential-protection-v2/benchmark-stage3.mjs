// Identical release builds, local mock upstream, paired alternating runs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createApplication} from '../../../test/helpers/native-app.mjs';
import {getPaths,normalizeConfig} from '../../../test/helpers/native.mjs';
import {catalogFixture,codexConfigFixture} from '../../../test/helpers/codex-fixture.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const output=path.resolve(process.env.CABLETIDY_EVALUATION_OUTPUT||path.join(root,'.cabletidy-debug/credential-protection-evaluation'));
await fs.mkdir(output,{recursive:true});
const baseline=process.env.CABLETIDY_BASELINE_BINARY;
assert.ok(baseline,'Set CABLETIDY_BASELINE_BINARY to a release daemon built from the saved stage2 source');
const binaries={stage2:baseline,stage3:path.join(root,'target/release/cabletidy-test-daemon')};
const upstream=http.createServer(async(req,res)=>{for await(const _ of req){}res.writeHead(200,{'content-type':'application/json'});res.end('{"type":"response","output":[]}');});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const scenarios=[{bytes:4096,mappings:0,concurrency:1},{bytes:65536,mappings:32,concurrency:4},{bytes:262144,mappings:128,concurrency:8}];
const quantile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1];
const stats=v=>({n:v.length,p50:quantile(v,.5),p95:quantile(v,.95),p99:quantile(v,.99)});
const hash=v=>createHash('sha256').update(v).digest('hex');
const results=[];
let sampling=false,sampleTask;
try{
 for(const scenario of scenarios){
  const apps=[];
  try{
   for(const [version,executable] of Object.entries(binaries))for(const enabled of [false,true]){
    const home=await fs.mkdtemp(path.join(os.tmpdir(),`cabletidy-bench-${version}-`));
    const app=await createApplication({paths:getPaths(home),executable,loadCodexCatalog:async()=>catalogFixture()});
    const call=body=>fetch(app.url+'relay/v1/responses',{method:'POST',headers:{'content-type':'application/json','session-id':'benchmark-session'},body:JSON.stringify(body)});
    const config=normalizeConfig(codexConfigFixture());config.web.port=Number(new URL(app.url).port);config.credentialProtection={enabled,mappingTtlSeconds:3600};config.upstreams.relay.baseUrl=`http://127.0.0.1:${upstream.address().port}/v1`;
    const setup=await fetch(app.url+'api/v1/config/commit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config,baseRevision:0,upstreamSecrets:{relay:'benchmark-http-auth-only'}})});assert.equal(setup.status,200);await setup.text();
    if(scenario.mappings){const seed=await call({model:'gpt-5.5',metadata:{api_key:Array.from({length:scenario.mappings},(_,i)=>`seed-${i}-Q8m2R7v9`)}});assert.equal(seed.status,200);await seed.text();}
    apps.push({app,home,call,version,enabled,latency:[],auditBatch:[],errors:0,workingMemorySampleMax:0,encryptedSpoolSampleMax:0,rssHwmBytes:0});
   }
   const key='sk-proj-benchmark-9R2q5W8m3T7v1X6n';
   const unit='ordinary source narrative with punctuation and Unicode 中文🙂. ';let filler=unit.repeat(Math.ceil(scenario.bytes/Buffer.byteLength(unit)));
   // Fixed wire size per scenario, constant four known provider credentials.
   const body={model:'gpt-5.5',input:Buffer.from(filler).subarray(0,scenario.bytes-240).toString()+` ${key} ${key} ${key} ${key}`};
   const settle=async item=>{
    for(let i=0;i<3000;i++){
     const data=await(await fetch(item.app.url+'api/v1/security/audit?kind=request&limit=100')).json();
     if(data.items?.length&&data.items.every(r=>r.inspectionProgress?.active===false))return;
     await delay(5);
    }throw new Error('audit timeout');
   };
   const sample=async item=>{
    const [status,proc]=await Promise.allSettled([fetch(item.app.url+'api/v1/security/status').then(r=>r.json()),fs.readFile(`/proc/${item.app.child.pid}/status`,'utf8')]);
    if(status.status==='fulfilled'){const r=status.value.resources;item.workingMemorySampleMax=Math.max(item.workingMemorySampleMax,r.workingMemoryBytes);item.encryptedSpoolSampleMax=Math.max(item.encryptedSpoolSampleMax,r.encryptedSpoolBytes);item.budgets={workingMemory:r.workingMemoryBudget,encryptedSpool:r.encryptedSpoolBudget};}
    if(proc.status==='fulfilled')item.rssHwmBytes=Math.max(item.rssHwmBytes,Number(proc.value.match(/^VmHWM:\s+(\d+)/m)?.[1]||0)*1024);
   };
   const run=async(item,measure)=>{
    const start=performance.now();
    await Promise.all(Array.from({length:scenario.concurrency},async()=>{
     const sent=performance.now();const response=await item.call(body);await response.text();const elapsed=performance.now()-sent;
     if(response.status!==200)item.errors++;if(measure)item.latency.push(elapsed);
    }));
    await settle(item);if(measure)item.auditBatch.push(performance.now()-start);await sample(item);
   };
   for(const item of apps)for(let i=0;i<4;i++)await run(item,false);
   sampling=true;sampleTask=(async()=>{while(sampling){await Promise.all(apps.map(sample));await delay(20);}})();
   // 32 batches per variant; alternate order each round to reduce temporal bias.
   for(let i=0;i<32;i++){for(const item of i%2?[...apps].reverse():apps)await run(item,true);if(i%8===7)console.log(`${scenario.bytes} bytes: ${i+1}/32 paired rounds`);}
   sampling=false;await sampleTask;
   for(const item of apps)results.push({scenario,version:item.version,protectionEnabled:item.enabled,wireBytes:Buffer.byteLength(JSON.stringify(body)),transportMs:stats(item.latency),auditBatchCompletionMs:stats(item.auditBatch),errors:item.errors,workingMemorySampleMax:item.workingMemorySampleMax,encryptedSpoolSampleMax:item.encryptedSpoolSampleMax,rssHwmBytes:item.rssHwmBytes,budgets:item.budgets});
  }finally{sampling=false;await sampleTask;for(const item of apps){await item.app.close();await fs.rm(item.home,{recursive:true,force:true});}}
 }
 const comparisons=scenarios.map(scenario=>{
  const find=(v,on)=>results.find(r=>r.version===v&&r.protectionEnabled===on&&r.scenario.bytes===scenario.bytes);
  const s2on=find('stage2',true),s3on=find('stage3',true),s3off=find('stage3',false);
  return {scenario,stage3VsStage2ProtectionP95:s3on.transportMs.p95/s2on.transportMs.p95,stage3ProtectionVsDisabledP95:s3on.transportMs.p95/s3off.transportMs.p95,budgetUnchanged:JSON.stringify(s3on.budgets)===JSON.stringify(s2on.budgets)};
 });
 const report={date:new Date().toISOString(),platform:process.platform,architecture:process.arch,cpu:os.cpus()[0]?.model,cpuCount:os.cpus().length,rust:execFileSync('rustc',['--version'],{encoding:'utf8'}).trim(),build:'cargo build --locked --release --features test-support --bin cabletidy-test-daemon; thin LTO; same Cargo.lock',binarySha256:Object.fromEntries(await Promise.all(Object.entries(binaries).map(async([v,p])=>[v,hash(await fs.readFile(p))]))),scope:'Local transport and asynchronous audit, 4 warmup + 32 alternating paired batches per variant and scenario. Resource reservations sampled every 20 ms; RSS VmHWM from Linux /proc is process high water including startup and warmup. Batch audit completion includes 5 ms polling resolution. Low concurrency p99 has limited sample support. No production load or network latency claim.',results,comparisons};
 await fs.writeFile(path.join(output,'stage3-performance.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(comparisons,null,2));assert.ok(results.every(r=>r.errors===0));
}finally{upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
