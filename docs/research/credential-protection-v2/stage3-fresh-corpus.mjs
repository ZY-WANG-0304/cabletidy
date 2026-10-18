// Frozen after the first holdout exposed typed-assignment omission, before replay.
// New payload families and base values. Four variants per family are correlated.
// This is a second synthetic diagnostic holdout, not production validation.
import {createHash} from 'node:crypto';
export const marker='__LABELLED_CREDENTIAL__';
export const contracts=[];
const families=[];
const add=(layer,name,label,build,value=id=>`fresh-${id.replaceAll('/','-')}-W9z4R2`)=>families.push({layer,name,label,build,value});
const text=fn=>s=>({input:fn(s)});
const provider=id=>`sk-proj-new-${createHash('sha256').update(id).digest('hex').slice(0,30)}`;
add('source','python-annotated-single','positive',text(s=>`password: str = '${s}'\nassert enabled`));
add('source','js-let-typed-template','positive',text(s=>`let api_key: string = \`${s}\`;\nuse(api_key);`));
add('source','annotated-expression','negative',text(s=>`let api_key: string = vault.${s.replaceAll('-','_')};`));
add('source','annotated-unknown-escape','ambiguous',text(s=>`let client_secret: string = "${s}\\x22";`));
add('environment','spaced-single-export','positive',text(s=>`export DB_PASSWORD = '${s}'\nTIMEOUT=2`));
add('environment','mixed-case-spaced','positive',text(s=>`database_Password = "${s}"`));
add('environment','quoted-ref','negative',text(s=>`export DB_PASSWORD="\${${s.replaceAll('-','_')}}"`));
add('environment','truncated-export','ambiguous',text(s=>`export CLIENT_SECRET='${s}`));
add('json','deep-extension','positive',s=>({extension:{rows:[{clientSecret:s},{passwordPolicy:'minimum'}]}}));
add('json','triple-encoded','positive',s=>({input:JSON.stringify({message:JSON.stringify({metadata:{access_token:s}})})}));
add('json','metadata-count-description','negative',s=>({extension:{token_count:s,passwordDescription:s}}));
add('json','encoded-unknown-source','ambiguous',s=>({input:JSON.stringify({snippet:`let client_secret = '${s}\\q';`})}));
add('markdown','numbered-inline-double','positive',text(s=>`1. Configure \`CLIENT_SECRET="${s}"\`.\n2. Start locally.`));
add('markdown','literal-plus-negative-comment','positive',text(s=>`## Fixture\n\`\`\`js\nconst token = \`${s}\`; // don't use a live key\n\`\`\``));
add('markdown','unresolved-member-doc','negative',text(s=>`> Use \`api_key = settings.${s.replaceAll('-','_')}\` when available.`));
add('markdown','truncated-fenced-source','ambiguous',text(s=>`\`\`\`js\nconst token = '${s}`));
add('protocol','basic-structured','positive',s=>({metadata:{authorization:`Basic ${s}`}}),id=>Buffer.from('fixture:'+id).toString('base64'));
add('protocol','mixed-sid-and-header','positive',s=>({metadata:{cookie:`sid="${s}"; Path=/; Secure`}}));
add('protocol','query-policy-public','negative',text(s=>`https://example.invalid/?password_policy=${s}&token_count=7`));
add('protocol','unknown-auth-source','ambiguous',text(s=>`const client_secret = "${s}\\v";\nAccept: application/json`));
add('provider','readme-comment','positive',text(s=>`<!-- synthetic credential example: ${s} -->`),provider);
add('provider','ordinary-array-value','positive',s=>({input:[{role:'user',content:[{type:'input_text',text:s}]}]}),provider);
add('provider','near-format-partial','negative',text(s=>`${s}: ghp_ / AKIA / ASIA / sk-proj-`));
add('provider','escape-auth-looking','ambiguous',text(s=>`const token = '${s}\\z';`));
add('structure','schema-nested-enum-block','blocked',s=>({tools:[{type:'function',name:'build',parameters:{type:'object',properties:{settings:{type:'object',properties:{access_token:{type:'string',enum:[s]}}}}}}]}),provider);
add('structure','grammar-python-auth-block','blocked',s=>({tools:[{type:'custom',name:'exec',format:{type:'grammar',syntax:'lark',definition:`start: '${s}'\n`}}]}),provider);
add('structure','schema-type-and-names','negative',s=>({tools:[{type:'function',name:'build',parameters:{type:'object',properties:{password:{type:'string',description:s}},required:['password']}}],previous_response_id:`response-${s}`}));
add('structure','grammar-unsupported-literal','ambiguous',s=>({tools:[{type:'custom',name:'exec',format:{type:'grammar',syntax:'lark',definition:`start: SOURCE\nSOURCE: /ordinary/\n// const password = "${s}\\x21";`}}]}));
export const cases=families.flatMap(f=>Array.from({length:4},(_,n)=>{
 const id=`fresh/${f.layer}/${f.name}/${n}`,body=f.build(f.value(id));
 return {id,layer:f.layer,family:`fresh/${f.layer}/${f.name}`,split:'heldout',label:f.label,body,expected:f.label==='positive'?f.build(marker):f.label==='blocked'?null:body};
}));
