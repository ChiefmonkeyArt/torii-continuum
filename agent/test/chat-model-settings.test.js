import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createChatModelSettings} from '../core/chat-model-settings.mjs';
import {createRoutstr} from '../core/routstr.mjs';
import {fetchProviderCatalog} from '../core/routstr-discovery.mjs';
import {buildApp} from '../index.mjs';
const config={session_secret:'a'.repeat(64),admin_npub:'',admin_bootstrap:true,
  server:{host:'127.0.0.1',port:0,cors_origins:[]},cashu:{mints:[]},rate_limit:{enabled:false},
  routstr:{endpoint:'https://example.invalid',models:{chat:'deepseek-v3.2'},discovery:{enabled:false},limits:{max_sats_per_request:50}},
  ollama:{enabled:false},logging:{level:'silent'}};
const log={info(){},warn(){},error(){}};
const model=id=>({id,name:id,pricing_sats:{prompt:.001,completion:.002,request:0},max_cost_sats:1});
test('selection persists privately across restarts without touching config, and serializes saves',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'model-settings-')),path=join(dir,'chat-model.json'),before=JSON.stringify(config);
 try{
  const settings=await createChatModelSettings(config,{path});
  assert.equal(settings.current(),'deepseek-v3.2');assert.equal(settings.override(),null);
  await settings.save('deepseek-v4-flash');
  assert.equal(settings.current(),'deepseek-v4-flash');
  assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal((await createChatModelSettings(config,{path})).current(),'deepseek-v4-flash');
  await Promise.all([settings.save('one'),settings.save('two')]);
  assert.equal(settings.current(),'two');assert.equal(JSON.parse(await readFile(path)).model,'two');
  await assert.rejects(settings.save('../bad?key=secret'));
  assert.equal(JSON.stringify(config),before);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('failed persistence leaves the active model unchanged',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'model-fail-')),path=join(dir,'selection');
 try{const settings=await createChatModelSettings(config,{path});await mkdir(path);
  await assert.rejects(settings.save('deepseek-v4-flash'));assert.equal(settings.current(),'deepseek-v3.2');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('real routes require auth, reject unavailable/extra fields, and return durable server selection',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'model-routes-'));
 const settings=await createChatModelSettings(config,{path:join(dir,'model.json')});
 let catalogs=0;
 const routstr={availableModels:async()=>{catalogs++;return[model('deepseek-v3.2'),model('deepseek-v4-flash')];},
  stopDiscovery(){},stopPaymentRecovery(){},discoveryStatus(){return{};}};
 const {app}=await buildApp(config,{chatModelSettings:settings,routstr,
  auth:{verifySessionToken:t=>({ok:t==='test',npub:'test'}),isClaimed:()=>true}});
 const headers={authorization:'Bearer test'};
 try{
  for(const method of ['GET','POST'])assert.equal((await app.inject({method,url:method==='GET'?'/api/routstr/models':'/api/routstr/model',payload:method==='POST'?{model:'deepseek-v4-flash'}:undefined})).statusCode,401);
  assert.equal(catalogs,0);
  assert.equal((await app.inject({method:'GET',url:'/api/routstr/models',headers})).json().selected_model,'deepseek-v3.2');
  for(const [payload,code] of [[{model:'missing'},409],[{model:'../bad?x'},400],[{model:'deepseek-v4-flash',max_sats_per_request:999},400]])
    assert.equal((await app.inject({method:'POST',url:'/api/routstr/model',headers,payload})).statusCode,code);
  assert.equal(settings.current(),'deepseek-v3.2');
  const saved=await app.inject({method:'POST',url:'/api/routstr/model',headers,payload:{model:'deepseek-v4-flash'}});
  assert.equal(saved.json().selected_model,'deepseek-v4-flash');
  assert.equal((await app.inject({method:'GET',url:'/api/routstr/models',headers})).json().selected_model,'deepseek-v4-flash');
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
test('saved selection is used on the next chat, stays stable in flight, and unavailable selection cannot silently downgrade',async()=>{
 let selected='deepseek-v4-flash',sends=0;
 const seen=[],old=globalThis.fetch,dir=await mkdtemp(join(tmpdir(),'model-routing-'));
 globalThis.fetch=async(_url,init)=>{
  seen.push(JSON.parse(init.body).model);selected='deepseek-v3.2';
  return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n');
 };
 const router=createRoutstr({...config,logging:{cost_log:join(dir,'cost')}},{send:async()=>{sends++;return{ok:true,token:'cashuATEST'};}},log,{
  getChatModel:()=>selected,fetchCatalog:async()=>[{baseUrl:'https://provider.example',models:[model('deepseek-v3.2'),model('deepseek-v4-flash')]}]});
 try{
  for(let i=0;i<2;i++)assert.equal((await router.chat({messages:[{role:'user',content:'gm'}]})).ok,true);
  assert.deepEqual(seen,['deepseek-v4-flash','deepseek-v3.2']);
  selected='missing';assert.equal((await router.chat({messages:[{role:'user',content:'gm'}]})).ok,false);
  assert.equal(sends,2);
 }finally{globalThis.fetch=old;await rm(dir,{recursive:true,force:true});}
});
test('model list excludes held/unpriced models; selected model survives catalog cap',async()=>{
 const router=createRoutstr({...config,routstr:{...config.routstr,quarantined_providers:['https://held.example']}},{},log,{
  fetchCatalog:async()=>[{baseUrl:'https://held.example',models:[model('held')]},{baseUrl:'https://good.example',models:[model('deepseek-v4-flash'),{id:'unpriced'}]}]});
 assert.deepEqual((await router.availableModels()).map(m=>m.id),['deepseek-v4-flash']);
 const data=Array.from({length:400},(_,i)=>({id:i===300?'deepseek-v4-flash':'m'+i}));
 const rows=await fetchProviderCatalog([{baseUrl:'https://good.example'}],{preferredModelIds:['deepseek-v4-flash'],fetchFn:async()=>new Response(JSON.stringify({data}))});
 assert.equal(rows[0].models.length,200);assert.equal(rows[0].models[0].id,'deepseek-v4-flash');
});
