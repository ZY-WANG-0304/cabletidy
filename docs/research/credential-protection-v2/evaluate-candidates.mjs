import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createApplication} from '../../../test/helpers/native-app.mjs';
import {getPaths,normalizeConfig} from '../../../test/helpers/native.mjs';
import {catalogFixture,codexConfigFixture} from '../../../test/helpers/codex-fixture.mjs';
import {cases,marker} from './candidate-corpus.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const output=path.resolve(process.env.CABLETIDY_EVALUATION_OUTPUT || path.join(root,'.cabletidy-debug/credential-protection-evaluation'));
await fs.mkdir(output,{recursive:true});
let captured;
const upstream=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;captured=JSON.parse(body);
 res.writeHead(200,{'content-type':'application/json'});
 res.end(JSON.stringify({type:'response',model:captured.model,output:[]}));
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const home=await fs.mkdtemp(path.join(os.tmpdir(),'cabletidy-candidate-evaluation-'));
const app=await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalogFixture()});
const call=(route,body,session)=>fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','session-id':session},body:JSON.stringify(body)});
const results=[];
try{
 const config=normalizeConfig(codexConfigFixture());config.web.port=Number(new URL(app.url).port);
 config.credentialProtection={enabled:true,mappingTtlSeconds:3600};config.upstreams.relay.baseUrl=`http://127.0.0.1:${upstream.address().port}/v1`;
 const setup=await call('api/v1/config/commit',{config,baseRevision:0,upstreamSecrets:{relay:'evaluation-http-auth-only-47N8'}},'setup');
 assert.equal(setup.status,200);await setup.text();
 const normalize=value=>JSON.parse(JSON.stringify(value).replace(/CTSEC_v1_[a-f0-9]{32}/g,marker));
 for(const c of cases){
  captured=null;
  const response=await call('relay/v1/responses',{model:'gpt-5.5',...c.body},c.id);await response.text();
  const actual=captured && Object.fromEntries(Object.keys(c.body).map(key=>[key,captured[key]]));
  const correct=response.status===(c.label==='blocked'?422:200) && (c.label==='blocked'?captured===null:JSON.stringify(normalize(actual))===JSON.stringify(c.expected));
  results.push({id:c.id,layer:c.layer,label:c.label,status:response.status,correct,changed:actual!==null&&JSON.stringify(actual)!==JSON.stringify(c.body),replacementCount:actual?(JSON.stringify(actual).match(/CTSEC_v1_[a-f0-9]{32}/g)||[]).length:0});
  if(!correct)console.log(`FAIL ${c.id}: status=${response.status}`);
 }
 const original='sessionValue83-r2',first={metadata:{password:original}},second={input:`prefix${original}suffix / ${original}`,metadata:{value:original}};
 await(await call('relay/v1/responses',{model:'gpt-5.5',...first},'multi-round')).text();const prior=captured.metadata.password;
 await(await call('relay/v1/responses',{model:'gpt-5.5',...second},'multi-round')).text();
 results.push({id:'multi-round-unit-policy',layer:'session',label:'structural',correct:captured.input===`prefix${original}suffix / ${prior}`&&captured.metadata.value===prior});
 const binary=path.join(root,'target/debug/cabletidy-test-daemon'+(process.platform==='win32'?'.exe':''));
 const report={date:new Date().toISOString(),ruleVersion:'credentials-3',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),binarySha256:createHash('sha256').update(await fs.readFile(binary)).digest('hex'),corpusSha256:createHash('sha256').update(await fs.readFile(fileURLToPath(new URL('./candidate-corpus.mjs',import.meta.url)))).digest('hex'),scope:'Synthetic diagnostic regression corpus with independently specified expected complete payloads. Unique request sessions except explicit multi-round case; local mock upstream. Not a held-out production precision/recall estimate. No online credential validation.',results,summary:{}};
 for(const label of ['negative','positive','ambiguous','blocked','structural']){
  const group=results.filter(r=>r.label===label);report.summary[label]={count:group.length,correct:group.filter(r=>r.correct).length,changed:group.filter(r=>r.changed).length};
 }
 await fs.writeFile(path.join(output,'candidate-evaluation.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({output:path.join(output,'candidate-evaluation.json'),summary:report.summary},null,2));
 assert.ok(results.every(r=>r.correct),'candidate regression evaluation failed');
}finally{
 await app.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await fs.rm(home,{recursive:true,force:true});
}
