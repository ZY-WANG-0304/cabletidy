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

const root=fileURLToPath(new URL('../../../',import.meta.url));
const dir=path.resolve(process.env.CABLETIDY_EVALUATION_OUTPUT || path.join(root,'.cabletidy-debug/credential-protection-evaluation'));
await fs.mkdir(dir,{recursive:true});
const cases=[];
const add=(id,label,text,extra={})=>cases.push({id,label,body:{input:text,...extra}});
for(const [id,text] of [
 ['bare-variable','const value = {api_key:plain};'],
 ['bare-member','const value = {api_key:body.metadata.api_key};'],
 ['bare-function','const token = get_secret_key();'],
 ['environment-member','const token = process.env.OPENAI_API_KEY;'],
 ['rust-type','fn connect(secret: &str) {}'],
 ['typescript-type','type Settings = { token: string };'],
 ['template-literal','const token = `prefix${value}`;'],
 ['markdown-field','Read the `api_key:` field.'],
 ['object-expression','const data = {upstreamSecrets:{relay:upstreamSecret}};'],
 ['schema-source','const p = {api_key:{type:\'string\'}};'],
 ['env-reference','OPENAI_API_KEY=$OPENAI_API_KEY'],
 ['env-brace-reference','OPENAI_API_KEY=${OPENAI_API_KEY}'],
 ['masked','api_key="[REDACTED]"'],
 ['instruction-slot','api_key="YOUR_API_KEY_HERE"'],
 ['angle-slot','api_key="<API_KEY>"'],
 ['ordinary-prose','Basic instructions about bearer token handling.'],
 ['uuid','session_id=12345678-1234-4321-abcd-123456789abc'],
 ['sha','commit=1c07d5ed80c2fb14ad17db85d88b65a3ce851e45'],
 ['schema-metadata','safe'],
 ['cookie-preferences','Cookie: theme=dark; locale=en-US'],
 ['regex-source','const pattern = /api_key:([A-Za-z0-9_]+)/;'],
 ['quoted-source-path','const secretRef="secret://upstreams/relay";'],
 ['credential-comparison','if (token === expectedToken) { return true; }'],
])add(id,'negative',text);
cases.find(c=>c.id==='schema-metadata').body.tools=[{type:'function',name:'connect',parameters:{type:'object',properties:{api_key:{type:'string',description:'API credential'}},required:['api_key']}}];
for(const [id,text] of [
 ['provider-like-api-key','Use sk-proj-9fK2mNvQ8xRtZ4wB7hLpY1cD'],
 ['github-classic','ghp_'+ 'A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p7Q8r9'],
 ['github-fine-grained','github_pat_'+ 'A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p7Q8r9'],
 ['aws-access-id','AKIAJQ7M5R2T6V3X4N7P'],
 ['env-opaque','DATABASE_PASSWORD=q7M!2rX@9hK5'],
 ['env-low-entropy','PASSWORD=hunter2'],
 ['quoted-source-password','const password = "hunter2";'],
 ['bearer','Authorization: Bearer q7M2rX9hK5zT8pB4'],
 ['basic','Authorization: Basic dXNlcjpodW50ZXIy'],
 ['url-auth','https://user:hunter2@example.org/path'],
 ['url-query','https://example.org/?api_key=q7M2rX9hK5zT8pB4'],
 ['cookie-session','Cookie: session=q7M2rX9hK5zT8pB4; theme=dark'],
 ['jwt','eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.q7M2rX9hK5zT8pB4'],
 ['saved-secret','prefix isolated-authorization suffix'],
 ['private-key','-----BEGIN PRIVATE KEY-----\nMIIEXPERIMENTALNONLIVEKEY\n-----END PRIVATE KEY-----'],
 ['source-real-key','const api_key = "sk-proj-9fK2mNvQ8xRtZ4wB7hLpY1cD";'],
])add(id,'positive',text);
add('json-low-entropy','positive','safe',{metadata:{password:'hunter2'}});
add('nested-json','positive',JSON.stringify({password:'q7M2rX9hK5zT8pB4'}));
add('aws-session-id','positive','ASIAJQ7M5R2T6V3X4N7P');
// JWT without authentication context is intentionally a low-confidence audit candidate.
cases.find(c=>c.id==='jwt').label='ambiguous';
add('opaque-without-context','ambiguous','q7M2rX9hK5zT8pB4');
add('quoted-placeholder-password','ambiguous','const password = "changeme";');
add('json-test-password','ambiguous','safe',{metadata:{password:'test'}});
add('uuid-as-credential','positive','safe',{metadata:{api_key:'12345678-1234-4321-abcd-123456789abc'}});

let captured;
const upstream=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;captured=JSON.parse(body);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'response',model:'UPSTREAM-GPT-5.5',output:[]}));});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const home=await fs.mkdtemp(path.join(os.tmpdir(),'cabletidy-credential-evaluation-'));
const app=await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalogFixture()});
const call=(route,body,session)=>fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','session-id':session},body:JSON.stringify(body)});
const results=[];
try {
 const config=normalizeConfig(codexConfigFixture());config.web.port=Number(new URL(app.url).port);config.credentialProtection={enabled:true,mappingTtlSeconds:3600};config.upstreams.relay.baseUrl=`http://127.0.0.1:${upstream.address().port}/v1`;
 let r=await call('api/v1/config/commit',{config,baseRevision:0,upstreamSecrets:{relay:'isolated-authorization'}},'setup');if(r.status!==200)throw Error(await r.text());await r.text();
 for(const c of cases){captured=null;const body={model:'gpt-5.5',...c.body};r=await call('relay/v1/responses',body,c.id);await r.text();const out=captured&&{...captured,model:body.model};const changed=out!==null&&JSON.stringify(out)!==JSON.stringify(body);results.push({id:c.id,label:c.label,status:r.status,changed,placeholderCount:captured?(JSON.stringify(captured).match(/CTSEC_v1_/g)||[]).length:0,blocked:captured===null,...(['bearer','basic'].includes(c.id)?{schemePreserved:captured?.input.startsWith(c.id==='bearer'?'Authorization: Bearer ':'Authorization: Basic ')}:{}),...(['cookie-preferences','cookie-session'].includes(c.id)?{cookiePreferencesPreserved:captured?.input.includes('theme=dark')}:{}),...(['saved-secret','private-key','json-low-entropy'].includes(c.id)?{originalAbsent:captured!==null&&!JSON.stringify(captured).includes(c.id==='saved-secret'?'isolated-authorization':c.id==='private-key'?'MIIEXPERIMENTALNONLIVEKEY':'hunter2')}:{}),...(['env-opaque','env-low-entropy','aws-session-id'].includes(c.id)?{originalAbsent:captured!==null&&!JSON.stringify(captured).includes(c.id==='env-opaque'?'q7M!2rX@9hK5':c.id==='env-low-entropy'?'hunter2':'ASIAJQ7M5R2T6V3X4N7P')}:{})});}
 const grammar='start: plain_source\nplain_source: SOURCE\nSOURCE: /[\\s\\S]+/\n';
 const grammarBody={model:'gpt-5.5',input:'const value = {api_key:plain};',tools:[{type:'custom',name:'exec',format:{type:'grammar',syntax:'lark',definition:grammar}}]};
 r=await call('relay/v1/responses',grammarBody,'grammar-negative');await r.text();results.push({id:'custom-grammar-integrity',label:'structural',status:r.status,preserved:captured?.tools[0].format.definition===grammar});
 const second={model:'gpt-5.5',input:'Explain plain_source and a plain response.',tools:[{type:'custom',name:'exec',format:{type:'grammar',syntax:'lark',definition:grammar}}]};
 r=await call('relay/v1/responses',second,'grammar-negative');await r.text();results.push({id:'cross-request-poisoning',label:'structural',status:r.status,preserved:captured?.tools[0].format.definition===grammar,changedInput:captured?.input!==second.input});
 const binary=path.join(root,'target/debug/cabletidy-test-daemon'+(process.platform==='win32'?'.exe':''));
 const report={date:new Date().toISOString().slice(0,10),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),binarySha256:createHash('sha256').update(await fs.readFile(binary)).digest('hex'),corpus:'48 hand-built cases: 23 negatives, 19 strong positives, 4 ambiguous cases (unauthenticated JWT relabeled from baseline positive), 2 structural checks; independent sessions except explicit cross-request test; mock upstream; fixture labels reflect secret-bearing intent, not active API validity',results,summary:{}};
 for(const label of ['negative','positive','ambiguous']){const group=results.filter(r=>r.label===label);report.summary[label]={count:group.length,changed:group.filter(r=>r.changed).length,blocked:group.filter(r=>r.blocked).length};}
 await fs.writeFile(path.join(dir,'current-algorithm-evaluation.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({output:path.join(dir,'current-algorithm-evaluation.json'),summary:report.summary,structural:results.filter(r=>r.label==='structural')},null,2));
}finally{await app.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await fs.rm(home,{recursive:true,force:true});}
