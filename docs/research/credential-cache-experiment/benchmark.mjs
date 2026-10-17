// Paired growing histories, synthetic values, local mock upstream only.
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
const output=path.resolve(process.env.CABLETIDY_EVALUATION_OUTPUT || path.dirname(fileURLToPath(import.meta.url)));
const baseline=process.env.CABLETIDY_BASELINE_BINARY;
assert.ok(baseline,'Set CABLETIDY_BASELINE_BINARY to the release daemon built from commit 57711d2');
const experiment=path.join(root,'target/release/cabletidy-test-daemon');
const variants=[
  {name:'committed',executable:baseline,cache:false,enabled:true},
  {name:'cache-off',executable:experiment,cache:false,enabled:true},
  {name:'cache-on',executable:experiment,cache:true,enabled:true},
  {name:'protection-off',executable:experiment,cache:false,enabled:false},
];
const scenarios=[
  {name:'stable-64k',bytes:65536,mappings:32,concurrency:1,kind:'stable'},
  {name:'stable-256k-parallel',bytes:262144,mappings:128,concurrency:4,kind:'stable'},
  {name:'catalog-additions-256k',bytes:262144,mappings:32,concurrency:1,kind:'additions'},
  {name:'retroactive-64k',bytes:65536,mappings:32,concurrency:1,kind:'retroactive'},
  {name:'changed-history-256k',bytes:262144,mappings:32,concurrency:1,kind:'changed'},
];
const hash=v=>createHash('sha256').update(v).digest('hex');
const quantile=(v,q)=>[...v].sort((a,b)=>a-b)[Math.ceil(v.length*q)-1];
const stats=v=>({n:v.length,p50:quantile(v,.5),p95:quantile(v,.95),p99:quantile(v,.99)});
const key='sk-proj-cache-benchmark-9R2q5W8m3T7v1X6n';
const seeds=n=>Array.from({length:n},(_,i)=>`seed-${i}-Q8m2R7v9`);
const later=(s,round)=>`later-${s}-${round}-Q9m3R7x8`;
const marker='__CREDENTIAL__';
const normalize=v=>v.replace(/CTSEC_v1_[a-f0-9]{32}/g,marker);
const results=[];
const captured=new Map();
let requestCount=0;
const upstream=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const raw=Buffer.concat(chunks).toString('utf8');
  const body=JSON.parse(raw);captured.set(body.metadata.benchmarkId,{raw,body});requestCount++;
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({type:'response',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:body.input[0].content}]}]}));
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const unit='Ordinary history, source punctuation {}[](); and Unicode 中文🙂. ';
const text=bytes=>unit.repeat(Math.ceil(bytes/Buffer.byteLength(unit)));
function bodies(scenario,session,round) {
  const blocks=[];
  let prior=0;
  for(let i=0;i<=Math.min(round,3);i++) {
    const size=Math.floor(scenario.bytes * (i+1)/4);
    let content=text(size-prior);prior=size;
    if(i===0) content+=` Known ${key}`;
    if(scenario.kind==='retroactive' && i===0) content+=' '+later(session,4);
    if(scenario.kind==='changed' && i===0) content+=` edited-${round}`;
    blocks.push({role:'user',content});
  }
  for(let i=4;i<=round;i++) blocks.push({role:'user',content:text(512)+` append-${i}`});
  const metadata={};
  if(scenario.kind==='additions') metadata.password=later(session,round);
  if(scenario.kind==='retroactive' && round>=4) metadata.password=later(session,4);
  const body={model:'gpt-5.5',instructions:'Fixed system instructions.',input:blocks,
    tools:[{type:'function',name:'read',parameters:{type:'object',properties:{path:{type:'string'}}}}],metadata};
  const expected=structuredClone(body);
  const values=[key,...seeds(scenario.mappings)];
  if(scenario.kind==='additions') values.push(later(session,round));
  if(scenario.kind==='retroactive' && round>=4) values.push(later(session,4));
  const replace=v=>typeof v==='string'?values.reduce((out,value)=>out.split(value).join(marker),v):Array.isArray(v)?v.map(replace):v && typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,value])=>[k,replace(value)])):v;
  return {body,expected:replace(expected)};
}
async function settle(item) {
  for(let i=0;i<3000;i++) {
    const data=await(await fetch(item.app.url+'api/v1/security/audit?kind=request&limit=100')).json();
    assert.ok(data.items?.length);
    if(data.items.every(r=>r.inspectionProgress?.active===false)) return data.items;
    await delay(5);
  }
  throw new Error('audit timeout');
}
async function sample(item) {
  const values=await Promise.allSettled([
    fetch(item.app.url+'api/v1/security/status').then(r=>r.json()),
    fs.readFile(`/proc/${item.app.child.pid}/status`,'utf8'),
  ]);
  if(values[0].status==='fulfilled') {
    const r=values[0].value.resources;
    item.memory=Math.max(item.memory,r.workingMemoryBytes);
    item.spool=Math.max(item.spool,r.encryptedSpoolBytes);
    item.budgets={workingMemory:r.workingMemoryBudget,encryptedSpool:r.encryptedSpoolBudget};
  }
  if(values[1].status==='fulfilled') item.rss=Math.max(item.rss,Number(values[1].value.match(/^VmHWM:\s+(\d+)/m)?.[1]||0)*1024);
}
try {
  for(const scenario of scenarios) {
    const apps=[];
    try {
      for(const variant of variants) {
        const home=await fs.mkdtemp(path.join(os.tmpdir(),'cabletidy-cache-bench-'));
        const app=await createApplication({paths:getPaths(home),executable:variant.executable,
          env:{CABLETIDY_TEST_CREDENTIAL_CACHE:variant.cache?'1':'0'},loadCodexCatalog:async()=>catalogFixture()});
        const config=normalizeConfig(codexConfigFixture());config.web.port=Number(new URL(app.url).port);
        config.credentialProtection={enabled:variant.enabled,mappingTtlSeconds:3600};
        config.upstreams.relay.baseUrl=`http://127.0.0.1:${upstream.address().port}/v1`;
        config.virtualProviders.cabletidy_relay.models['gpt-5.5'].upstreamModelId='gpt-5.5';
        const setup=await fetch(app.url+'api/v1/config/commit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config,baseRevision:0,upstreamSecrets:{relay:'benchmark-auth-only-9Q3m'}})});
        assert.equal(setup.status,200);await setup.text();
        apps.push({...variant,app,home,rows:[],audit:[],memory:0,spool:0,rss:0,errors:0});
      }
      const run=async(item,session,round,measured)=>{
        const batchStart=performance.now();
        const returned=await Promise.all(Array.from({length:scenario.concurrency},async(_,lane)=>{
          const scope=`${session}-${lane}`;
          let {body,expected}=round<0?{body:{model:'gpt-5.5',input:[{role:'user',content:'seed directory'}],metadata:{password:seeds(scenario.mappings)}},expected:null}:bodies(scenario,scope,round);
          const id=`${item.name}-${scope}-${round}`;
          body.metadata.benchmarkId=id;if(expected)expected.metadata.benchmarkId=id;
          const start=performance.now();
          const response=await fetch(item.app.url+'relay/v1/responses',{method:'POST',headers:{'content-type':'application/json','session-id':scope},body:JSON.stringify(body)});
          const value=await response.json();const ms=performance.now()-start;
          if(response.status!==200)item.errors++;
          assert.equal(response.status,200,JSON.stringify(value));
          assert.equal(value.output[0].content[0].text,body.input[0].content,'response restoration');
          const actual=captured.get(id);assert.ok(actual);
          if(expected) {
            const actualWire=normalize(actual.raw),expectedWire=JSON.stringify(item.enabled?expected:body);
            if(actualWire!==expectedWire) {
              let at=0;while(at<Math.min(actualWire.length,expectedWire.length)&&actualWire[at]===expectedWire[at])at++;
              throw new Error(`whole upstream payload ${scenario.name}/${id}, first difference ${at}: ${JSON.stringify(actualWire.slice(at-40,at+120))} expected ${JSON.stringify(expectedWire.slice(at-40,at+120))}; lengths ${actualWire.length}/${expectedWire.length}`);
            }
          }
          captured.delete(id);
          return {id,scope,round,ms,wireBytes:Buffer.byteLength(JSON.stringify(body))};
        }));
        const records=await settle(item);
        const auditMs=performance.now()-batchStart;
        if(measured) {
          item.audit.push(auditMs);
          for(const row of returned) {
            // Header session identity is scoped to provider and protocol. The list
            // is newest first; background completion cannot change that order.
            const match=records.find(r=>r.sessionKey===hash(JSON.stringify([r.providerId,r.protocol,row.scope])));
            assert.ok(match,'current audit record');
            row.work=match.credentialDetection.work || null;
            item.rows.push(row);
          }
        }
        await sample(item);
      };
      // Warmup uses its own session; measurement starts with independent histories.
      for(const item of apps) {await run(item,'warmup',-1,false);for(let round=0;round<4;round++)await run(item,'warmup',round,false);}
      for(let session=0;session<8;session++) {
        for(const item of apps) await run(item,`session-${session}`,-1,false);
        for(let round=0;round<8;round++) {
          for(const item of (session+round)%2?[...apps].reverse():apps) await run(item,`session-${session}`,round,true);
        }
        console.log(`${scenario.name}: ${session+1}/8 paired growing sessions`);
      }
      for(const item of apps) {
        const mature=item.rows.filter(r=>r.round>=4);
        const work=mature.filter(r=>r.work);
        results.push({scenario,variant:item.name,transportMs:stats(mature.map(r=>r.ms)),allGrowthTransportMs:stats(item.rows.map(r=>r.ms)),
          detectorMs:work.length?stats(work.map(r=>r.work.elapsedMicros/1000)):null,
          detectorWork:work.length?Object.fromEntries(['extractedNodes','reusedNodes','reusedDecodedBytes','deltaCheckedNodes','deltaInvalidatedNodes','cacheBytes'].map(k=>[k,stats(work.map(r=>r.work[k]))])):null,
          auditBatchMs:stats(item.audit),workingMemorySampleMax:item.memory,encryptedSpoolSampleMax:item.spool,rssHwmBytes:item.rss,budgets:item.budgets,errors:item.errors,rows:item.rows});
      }
    } finally {
      for(const item of apps){await item.app.close();await fs.rm(item.home,{recursive:true,force:true});}
    }
  }
  const comparisons=scenarios.map(scenario=>{
    const get=name=>results.find(r=>r.scenario.name===scenario.name&&r.variant===name);
    const on=get('cache-on'),off=get('cache-off'),committed=get('committed'),disabled=get('protection-off');
    return {scenario:scenario.name,cacheVsOffP95:on.transportMs.p95/off.transportMs.p95,
      cacheVsCommittedP95:on.transportMs.p95/committed.transportMs.p95,
      commonChangeVsCommittedP95:off.transportMs.p95/committed.transportMs.p95,
      cacheProtectionVsDisabledP95:on.transportMs.p95/disabled.transportMs.p95,
      detectorCacheVsOffP95:on.detectorMs.p95/off.detectorMs.p95};
  });
  const report={date:new Date().toISOString(),baselineCommit:'57711d2',platform:process.platform,cpu:os.cpus()[0]?.model,
    rust:execFileSync('rustc',['--version'],{encoding:'utf8'}).trim(),
    binarySha256:{committed:hash(await fs.readFile(baseline)),experiment:hash(await fs.readFile(experiment))},
    build:'Same Cargo.lock and release thin LTO; cargo build --locked --release --features test-support --bin cabletidy-test-daemon',
    scope:'Local synthetic growing histories. Eight independent session groups, four growing and four mature rounds; order alternates per paired round. Separate warmup. Transport includes response restoration; all forwarded JSON bytes checked after normalizing random placeholders. Detection counters sum two passes and include key strings. Cache-off isolates deferred raw spelling reads from cache reuse. Mature p95/p99 have 32 samples for concurrency 1 and 128 for concurrency 4. Audit includes batch and 5 ms polling; resources sampled after batches, so short peaks can be missed; RSS includes startup. Production cache remains disabled.',
    upstreamCalls:requestCount,results,comparisons};
  await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'performance.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(comparisons,null,2));
  assert.ok(results.every(r=>r.errors===0));
} finally {upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
