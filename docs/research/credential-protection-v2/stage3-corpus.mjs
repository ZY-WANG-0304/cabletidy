// Synthetic labels are specified by fixtures, independently of implementation.
// Eight specimens per family are correlated. Split by family AND base value;
// counts must never be presented as 672 independent production observations.
import {createHash} from 'node:crypto';
export const marker='__LABELLED_CREDENTIAL__';
const jwt='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.q7M2rX9hK5zT8pB4';
const families=[];
const family=(layer,name,label,build,value=id=>`lab-${id.replaceAll('/','-')}-R8m2Q7`)=>families.push({layer,name,label,build,value});
const input=build=>value=>({input:build(value)});
const add=(layer,rows)=>rows.forEach(([name,label,build,value])=>family(layer,name,label,build,value));
add('source',[
 ['js-string','positive',input(s=>`const password = "${s}"; // local fixture`)],
 ['py-string','positive',input(s=>`db_password = '${s}'\nprint("ready")`)],
 ['member-ref','negative',input(s=>`const api_key = config.${s.replaceAll('-','_')};`)],
 ['object-literal','positive',input(s=>`const config = {client_secret: "${s}", retries: 3};`)],
 ['comparison','negative',input(s=>`if (password === "${s}") { return true; }`)],
 ['unsupported-escape','ambiguous',input(s=>`const password = "${s}\\x21";`)],
 ['backtick','positive',input(s=>`const token = \`${s}\`;`)],
 ['type-declaration','negative',input(s=>`interface C { password: "${s}"; }`)],
 ['unfinished','ambiguous',input(s=>`const password = "${s}`)],
 ['quoted-dictionary','positive',input(s=>`settings = {"password": "${s}"}`)],
 ['dynamic-literal','negative',input(s=>`const token = "${s}" + variable;`)],
 ['typed-assignment','positive',input(s=>`const password: string = "${s}";`)],
]);
add('environment',[
 ['bare-suffix','positive',input(s=>`DATABASE_PASSWORD=${s}\nPORT=8000`)],
 ['quoted-export','positive',input(s=>`export API_KEY="${s}"`)],
 ['reference','negative',input(s=>`PASSWORD=\${${s.replaceAll('-','_')}}`)],
 ['hyphen-name','positive',input(s=>`DB-PASSWORD='${s}'`)],
 ['command','negative',input(s=>`PASSWORD=$(load_${s.replaceAll('-','_')})`)],
 ['unknown-escape','ambiguous',input(s=>`PASSWORD="${s}\\x21"`)],
 ['client-secret','positive',input(s=>`CLIENT_SECRET=${s}`)],
 ['policy','negative',input(s=>`PASSWORD_POLICY=${s}`)],
 ['unfinished','ambiguous',input(s=>`PASSWORD="${s}`)],
 ['auth-suffix','positive',input(s=>`X_AUTH_TOKEN=${s}`)],
 ['interpolation','negative',input(s=>`PASSWORD="${s}\${DYNAMIC}"`)],
 ['short-password','positive',input(s=>`PASSWORD=${s}`),id=>id.endsWith('0')?'test':'plain'],
]);
add('json',[
 ['actual-password','positive',s=>({metadata:{password:s,retries:3}})],
 ['camel-suffix','positive',s=>({metadata:{dbPassword:s,locale:'en-US'}})],
 ['policy-field','negative',s=>({metadata:{password_policy:s}})],
 ['nested-encoding','positive',s=>({input:JSON.stringify({access_token:s,enabled:true})})],
 ['count-field','negative',s=>({metadata:{tokenCount:s}})],
 ['jwt-ordinary','ambiguous',s=>({metadata:{ordinary:`${s} ${jwt}`}})],
 ['array-values','positive',s=>({metadata:{api_key:[s]}})],
 ['secret-ref','negative',s=>({metadata:{secretRef:`vault://${s}`}})],
 ['unsupported-literal','ambiguous',input(s=>`{"text":"const password = \\\"${s}\\\\x21\\\";"}`)],
 ['schema-default','positive',s=>({tools:[{type:'function',name:'connect',parameters:{type:'object',properties:{password:{type:'string',default:s}}}}]})],
 ['public-key','negative',s=>({metadata:{publicKey:s}})],
 ['unicode-value','positive',s=>({metadata:{password:`密碼🙂-${s}`}})],
]);
add('markdown',[
 ['inline-value','positive',input(s=>`Set \`password="${s}"\` for the local demo.`)],
 ['env-fence','positive',input(s=>`\`\`\`env\nDATABASE_PASSWORD=${s}\n\`\`\``)],
 ['label-only','negative',input(s=>`The \`api_key:\` field is named ${s}.`)],
 ['source-fence','positive',input(s=>`\`\`\`js\nconst client_secret = "${s}";\n\`\`\``)],
 ['masked','negative',input(s=>`${s}: password="[REDACTED]"`)],
 ['unfinished-example','ambiguous',input(s=>`Example: password="${s}`)],
 ['auth-example','positive',input(s=>`Example header: Authorization: Bearer ${s}`)],
 ['dynamic-example','negative',input(s=>`Example: token="${s}" + runtime`)],
 ['jwt-document','ambiguous',input(s=>`Decode this unverified example ${s}: ${jwt}`)],
 ['quoted-object','positive',input(s=>`JSON: {"api_key":"${s}"}`)],
 ['template-placeholder','negative',input(s=>`${s}: password="YOUR_PASSWORD_HERE"`)],
 ['cookie-example','positive',input(s=>`Cookie: session="${s}"; theme=dark`)],
]);
add('protocol',[
 ['bearer-header','positive',input(s=>`Authorization: Bearer ${s}\nAccept: application/json`)],
 ['cookie-value','positive',s=>({metadata:{cookie:`sid=${s}; theme=dark; locale=en-US`}})],
 ['public-url','negative',input(s=>`https://example.invalid/${s}?theme=dark`)],
 ['query-value','positive',input(s=>`https://example.invalid/?DB_PASSWORD=${s}&page=2`)],
 ['preferences','negative',input(s=>`Cookie: theme=${s}; locale=en-US`)],
 ['jwt-prose','ambiguous',input(s=>`payload ${s} ${jwt}`)],
 ['url-userinfo','positive',input(s=>`https://user:${s}@example.invalid/path`)],
 ['public-ssh','negative',input(s=>`ssh://git@example.invalid/${s}`)],
 ['unknown-literal','ambiguous',input(s=>`const token = "${s}\\x21";`)],
 ['structured-bearer','positive',s=>({metadata:{authorization:`  bEaReR\t${s}  `}})],
 ['signature-param','negative',input(s=>`https://example.invalid/?signature=${s}`)],
 ['set-cookie','positive',s=>({metadata:{setCookie:`session="${s}"; Path=/; HttpOnly; SameSite=Lax`}})],
]);
const provider=id=>`sk-proj-lab-${createHash('sha256').update(id).digest('hex').slice(0,28)}`;
add('provider',[
 ['openai-prose','positive',input(s=>`Fixture value ${s}`),provider],
 ['github','positive',input(s=>`Fixture value ${s}`),id=>`ghp_${createHash('sha256').update(id).digest('hex').slice(0,36)}`],
 ['digest','negative',input(s=>`revision ${s}`),id=>createHash('sha256').update(id).digest('hex')],
 ['aws-temporary','positive',input(s=>`Fixture ${s}`),id=>`ASIA${createHash('sha256').update(id).digest('hex').slice(0,16).toUpperCase()}`],
 ['uuid','negative',input(s=>`reference ${s}`),id=>{const v=createHash('sha256').update(id).digest('hex');return `${v.slice(0,8)}-${v.slice(8,12)}-4${v.slice(13,16)}-a${v.slice(17,20)}-${v.slice(20,32)}`;}],
 ['jwt-unverified','ambiguous',input(s=>`${s} ${jwt}`)],
 ['aws-permanent','positive',input(s=>`Fixture ${s}`),id=>`AKIA${createHash('sha256').update(id).digest('hex').slice(0,16).toUpperCase()}`],
 ['random-no-context','negative',input(s=>`opaque ${s}`),id=>createHash('sha256').update(id).digest('base64url')],
 ['jwt-like','ambiguous',input(s=>`${s} eyJnotJson.x.y`)],
 ['provider-code','positive',input(s=>`const example = "${s}";`),provider],
 ['prefix-only','negative',input(s=>`${s} sk-proj-`)],
 ['provider-document','positive',input(s=>`\`\`\`text\n${s}\n\`\`\``),provider],
]);
const tool=s=>[{type:'function',name:'connect',parameters:{type:'object',properties:{token:{type:'string',const:s}}}}];
add('structure',[
 ['grammar-secret','blocked',s=>({tools:[{type:'custom',name:'exec',format:{type:'grammar',syntax:'lark',definition:`start: "${s}"`}}]}),provider],
 ['schema-const','blocked',s=>({tools:tool(s)}),provider],
 ['grammar-symbol','negative',input(s=>`const value = {api_key:plain}; // ${s}`)],
 ['schema-enum','blocked',s=>({tools:[{type:'function',name:'connect',parameters:{type:'object',properties:{token:{type:'string',enum:[s]}}}}]}),provider],
 ['schema-description','negative',s=>({tools:[{type:'function',name:'connect',parameters:{type:'object',properties:{password:{type:'string',description:`policy ${s}`}},required:['password']}}]})],
 ['schema-token-context','blocked',s=>({tools:tool(`${s} ${jwt}`)})],
 ['protocol-id','blocked',s=>({previous_response_id:s}),provider],
 ['references','negative',s=>({input:[{type:'function_call',name:'read',call_id:`call_${s}`,arguments:'{}'},{type:'function_call_output',call_id:`call_${s}`,output:'done'}]})],
 ['grammar-weak','ambiguous',s=>({tools:[{type:'custom',name:'exec',format:{type:'grammar',syntax:'lark',definition:`start: "${s} ${jwt}"`}}]})],
 ['signed-content','blocked',s=>({input:[{type:'reasoning',encrypted_content:s}]}),provider],
 ['grammar-original','negative',s=>({input:`fixture ${s}`,tools:[{type:'custom',name:'exec',format:{type:'grammar',syntax:'lark',definition:'start: plain_source\nplain_source: SOURCE\nSOURCE: /[\\s\\S]+/'}}]})],
 ['schema-pattern','blocked',s=>({tools:[{type:'function',name:'connect',parameters:{type:'object',properties:{ordinary:{type:'string',pattern:s}}}}]}),provider],
]);
export const cases=families.flatMap((f,index)=>Array.from({length:8},(_,n)=>{
 const id=`${f.layer}/${f.name}/${n}`,secret=f.value(id),body=f.build(secret);
 let expected=f.label==='positive'?f.build(marker):f.label==='blocked'?null:body;
 if(f.name==='unicode-value') expected={metadata:{password:marker}};
 if(f.name==='url-userinfo') expected={input:`https://${marker}@example.invalid/path`};
 // All shared JWT base fixtures stay in tuning to avoid value leakage.
 const split=index%12%3===2 && !JSON.stringify(body).includes(jwt)?'heldout':'tuning';
 return {id,family:`${f.layer}/${f.name}`,layer:f.layer,split,label:f.label,body,expected};
}));
export const contracts=Array.from({length:100},(_,i)=>({id:`contract-${i}`,group:['multi-round','isolation','split-sse','duplicate-json','schema-reference'][i%5],value:`contract-${i}-R8m2Q7`,boundary:1+i%39}));
