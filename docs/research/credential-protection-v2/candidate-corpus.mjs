// Independently labelled synthetic fixtures. Expected output is specified without
// importing detector rules. These are regression cases, not a production sample.
const marker='__EXPECTED_CREDENTIAL__';
export const cases=[];
const add=(id,layer,body,expected=body,label='negative')=>cases.push({id,layer,body,expected,label});
const text=(id,layer,input,expected=input,label='negative')=>add(id,layer,{input},{input:expected},label);
for(const [id,input] of [
 ['member','const token = body.accessToken;'],['call','const password = vault.read("db");'],
 ['comparison','if (password === "expected") {}'],['comparison-not-equal','if (api_key !== "expected") {}'],
 ['typescript','interface Credentials {\n password: "string";\n token: string;\n}'],
 ['typed-variable','const password: "string" = input;'],['rust','fn connect(secret: &str) {}'],
 ['regex','const matcher = /password=12345/;'],['dynamic','const token = "prefix" + input;'],
 ['dynamic-template','const token = `prefix${input}`;'],['dynamic-method','const password = "prefix".concat(input);'],
 ['long-nonvalue-name','const notapassword = "visible";'],['suffix-description','const password_policy = "visible";'],
 ['source-reference','const api_key = config.api_key;'],['type-alias','type Config = { token: "string" };'],
 ['nested-types','interface C { nested: { password: "string" }; token: "string"; }'],
 ['markdown-label','Read the `api_key:` field and the `token:` field.'],
 ['source-path','const secretRef = "vault://environment/password";'],
])text(id,'source',input);
for(const [id,input] of [
 ['env-reference','DATABASE_PASSWORD=$DATABASE_PASSWORD'],['env-braces','DATABASE_PASSWORD=${DATABASE_PASSWORD}'],
 ['env-template','PASSWORD="prefix${PASSWORD}"'],['env-command','PASSWORD=$(read_password)'],
 ['env-comment','PASSWORD="[REDACTED]"'],['masked','api_key="********"'],
 ['document-slot','api_key="YOUR_API_KEY_HERE"'],['angle-slot','token="<TOKEN>"'],
 ['markdown-mask','The `password="[REDACTED]"` field is hidden.'],
])text(id,'environment/documentation',input);
for(const field of ['notapassword','password_policy','token_count','secretRef','accessTokenCount','tokenizer','tokenBucket','publicKey'])add(`field-${field}`,'json',{metadata:{[field]:'visible'}});
for(const [id,input] of [
 ['cookie-preferences','Cookie: theme=dark; locale=en-US'],['url-public','ssh://git@example.invalid/repo'],
 ['url-signature','https://example.invalid/path?signature=unverified'],
 ['url-name','https://example.invalid/?notapassword=visible'],
 ['ordinary-prose','Basic instructions explain bearer token handling.'],
 ['sha','revision=97b2197a278db5bffcb0893a39831fda21a3aa64'],
 ['uuid','session_id=33220850-1822-4047-a198-6146871f940e'],
 ['opaque','d6A3q9H1m8Z5r2T4p7K0b1F8n6W3x5C9'],
])text(id,'protocol/content',input);
for(const [id,input,secret] of [
 ['js-double','const password = "short";','short'],['js-single',"const password = 'another';",'another'],
 ['js-backtick','const token = `fixedCredential31`;', 'fixedCredential31'],
 ['python-literal',"password = 'localphrase'",'localphrase'],
 ['source-unicode',String.raw`const password = "密\u7801\"final";`,String.raw`密\u7801\"final`],
 ['env-suffix','DATABASE_PASSWORD=studyPassword81','studyPassword81'],
 ['env-hyphen','DB-PASSWORD=studyPass92','studyPass92'],
 ['env-export','export STRIPE_API_KEY=studySecret57','studySecret57'],
 ['env-dollar-literal','PASSWORD=$9literal','\u00249literal'],
 ['source-template-fixed','const password = `fixedWord28`;', 'fixedWord28'],
 ['source-low-entropy','const password = "changeme";','changeme'],
 ['documentation-real','Example: `password="documentCredential74"`','documentCredential74'],
 ['provider-document','Use sk-proj-study-2Q9x5W8m3P6r1H7z','sk-proj-study-2Q9x5W8m3P6r1H7z'],
 ['aws-temporary','ASIAZ7T3R8Q2P6N4M9K1','ASIAZ7T3R8Q2P6N4M9K1'],
 ['aws-longterm','AKIAZ8P5N2M6R9Q3T7K4','AKIAZ8P5N2M6R9Q3T7K4'],
 ['github','ghp_5K8r2H9m3W6p1Q7x4Z8n2R9b3T6v1C7a','ghp_5K8r2H9m3W6p1Q7x4Z8n2R9b3T6v1C7a'],
 ['bearer-short','Authorization: bearer tiny','tiny'],
 ['bearer-spaces','Authorization: Bearer\totherTiny','otherTiny'],
 ['basic','Authorization: Basic dXNlcjpsb2NhbHBocmFzZQ==','dXNlcjpsb2NhbHBocmFzZQ=='],
 ['url-password','https://user:studySecret83@example.invalid/path','user:studySecret83'],
 ['url-query','https://example.invalid/?DB_PASSWORD=querySecret27&theme=dark','querySecret27'],
 ['cookie-quoted','Cookie: session="sessionValue39"; theme=dark','sessionValue39'],
 ['cookie-short','Cookie: sid=tinyCookie; locale=en-US','tinyCookie'],
])text(id,'explicit-literal',input,input.replace(secret,marker),'positive');
for(const [field,secret] of [
 ['dbPassword','tiny'],['DATABASE_PASSWORD','structuredPass27'],['stripeApiKey','structuredKey38'],
 ['OPENAI_API_KEY','structuredKey46'],['AWS_SECRET_ACCESS_KEY','structuredKey53'],
 ['X_AUTH_TOKEN','structuredToken74'],['clientSecret','structuredClient82'],
 ['password','test'],['token','null'],['authentication','structuredAuth19'],
])add(`json-${field}`,'json',{metadata:{[field]:secret}},{metadata:{[field]:marker}},'positive');
add('authorization-trim','json',{metadata:{authorization:'  bEaReR\tjsonTiny  '}},{metadata:{authorization:`  bEaReR\t${marker}  `}},'positive');
add('cookie-attributes','json',{metadata:{setCookie:'session="cookieValue53"; Path=/; HttpOnly; SameSite=Lax'}},{metadata:{setCookie:`session="${marker}"; Path=/; HttpOnly; SameSite=Lax`}},'positive');
add('nested','json',{input:JSON.stringify({metadata:{dbPassword:'nestedValue61',password_policy:'keep'}})},{input:JSON.stringify({metadata:{dbPassword:marker,password_policy:'keep'}})},'positive');
for(const [id,input] of [
 ['unknown-escape',String.raw`const password = "uncertain\x21";`],
 ['unfinished','const password = "notClosed'],
 ['jwt-unverified','eyJnotJson.x.y'],
])text(id,'uncertain',input,input,'ambiguous');
const grammar='start: plain_source\nplain_source: SOURCE\nSOURCE: /[\\s\\S]+/';
add('grammar-negative','structure',{input:'const data = {api_key:plain};',tools:[{type:'custom',name:'exec',format:{type:'grammar',syntax:'lark',definition:grammar}}]});
add('schema-negative','structure',{tools:[{type:'function',name:'connect',parameters:{type:'object',properties:{password:{type:'string',description:'Password policy'},enabled:{type:'boolean',default:true}},required:['password']}}]});
for(const role of ['grammar','identifier','schema-const']){
 const secret='sk-proj-study-9T2m5K8r1Q6x3H7z';
 const body=role==='identifier'?{previous_response_id:secret}:role==='grammar'?{tools:[{type:'custom',name:'exec',format:{type:'grammar',syntax:'lark',definition:`start: "${secret}"`}}]}:{tools:[{type:'function',name:'connect',parameters:{type:'object',properties:{token:{type:'string',const:secret}}}}]};
 add(`blocked-${role}`,'structure',body,null,'blocked');
}
export {marker};
