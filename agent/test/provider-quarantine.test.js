import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validQuarantine, isQuarantined } from '../core/provider-quarantine.mjs';
import { createRoutstrPayment } from '../core/routstr-payment.mjs';
import { createRoutstr } from '../core/routstr.mjs';
import { fetchProviderCatalog } from '../core/routstr-discovery.mjs';
import { quarantineProvider } from '../ops/set-payment-mode.mjs';
const bad='https://failed.example', good='https://healthy.example';
const token='cashuATESTPAYMENT', key='sk-'+createHash('sha256').update(token).digest('hex');
const name='rrefund_'+'a'.repeat(20);
const raw=JSON.stringify({base:bad,sats:2,token,key});
const json=d=>new Response(JSON.stringify(d));
const cfg={session_secret:'a'.repeat(64),routstr:{payment_mode:'ephemeral_bearer',quarantined_providers:[bad]}};
function fixture(record=raw) {
  const records=new Map([[name,record]]);
  let sends=0, requests=0;
  const store={get:async n=>records.get(n),put:async(n,v)=>records.set(n,v),
    list:async()=>[...records.keys()],remove:async n=>records.delete(n)};
  const wallet={send:async()=>{sends++;return{ok:true,token};},receive:async()=>({ok:true,added_sats:1})};
  const fetchFn=async(url,init)=>{
    requests++;assert.ok(!url.startsWith(bad));
    return url.endsWith('/create')?json({api_key:key}):json({token:'cashuAREFUND'});
  };
  return{records,store,wallet,fetchFn,count:()=>({sends,requests})};
}
test('quarantine accepts bounded public origins only, matches origin paths and refuses malformed lists',()=>{
  assert.equal(validQuarantine([bad]),true);
  for(const x of [bad,[bad+'/path'],['http://failed.example'],['https://localhost'],[bad+'?x=1'],Array(9).fill(bad)])
    assert.equal(validQuarantine(x),false);
  assert.equal(isQuarantined(cfg,bad+'/v1'),true);
  assert.equal(isQuarantined(cfg,good),false);
});
test('explicit quarantine preserves claim exactly, skips refund polling and blocks same-provider deposits',async()=>{
  const f=fixture(), p=createRoutstrPayment(cfg,f.wallet,{store:f.store,fetchFn:f.fetchFn});
  await p.recover();
  assert.equal((await p.begin(bad,1)).ok,false);
  assert.equal((await p.begin(bad+'/path',1)).ok,false);
  assert.equal(f.records.get(name),raw);
  assert.deepEqual(f.count(),{sends:0,requests:0});
});
test('healthy provider can fund and settle while the explicitly held claim survives',async()=>{
  const f=fixture(), p=createRoutstrPayment(cfg,f.wallet,{store:f.store,fetchFn:f.fetchFn});
  const h=await p.begin(good,1);
  assert.equal(h.ok,true);
  assert.deepEqual(await p.finish(h),{pending:false,refunded:1});
  assert.equal(f.records.get(name),raw);
  assert.equal(f.records.size,1);
  assert.equal(f.count().sends,1);
});
test('without explicit quarantine, or with corrupt/other-provider claims, the global guard remains',async()=>{
  for(const [config,record] of [
    [{...cfg,routstr:{payment_mode:'ephemeral_bearer'}},raw],
    [cfg,'{}'],[cfg,JSON.stringify({base:good,token,key,sats:2})],
  ]) {
    const f=fixture(record),p=createRoutstrPayment(config,f.wallet,{store:f.store,fetchFn:f.fetchFn});
    assert.equal((await p.begin(good,1)).ok,false);
    assert.equal(f.count().sends,0);
    assert.equal(f.records.get(name),record);
  }
});
test('router excludes held provider before spending and preserves selected DeepSeek model',async()=>{
  const f=fixture(),dir=await mkdtemp(join(tmpdir(),'quarantine-router-')),saved=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    assert.ok(url.startsWith(good));assert.equal(JSON.parse(init.body).model,'deepseek-v3.2');
    return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n');
  };
  try {
    const router=createRoutstr({...cfg,routstr:{...cfg.routstr,discovery:{enabled:false},
      models:{chat:'deepseek-v3.2'},limits:{max_sats_per_request:1}},
      logging:{cost_log:join(dir,'cost.jsonl')}},f.wallet,{info(){},warn(){}},{
      payment:{store:f.store,fetchFn:f.fetchFn},
      fetchCatalog:async()=>[bad,good].map(baseUrl=>({baseUrl,models:[{id:'deepseek-v3.2',max_cost_sats:1}]})),
    });
    assert.equal((await router.chat({messages:[{role:'user',content:'gm'}]})).ok,true);
    assert.equal(f.count().sends,1);assert.equal(f.records.get(name),raw);
  }finally{globalThis.fetch=saved;await rm(dir,{recursive:true,force:true});}
});
test('quarantined legacy fallback cannot fund a request',async()=>{
  const f=fixture(),dir=await mkdtemp(join(tmpdir(),'quarantine-legacy-'));
  try {
    const router=createRoutstr({...cfg,routstr:{...cfg.routstr,endpoint:bad,discovery:{enabled:false},
      models:{chat:'deepseek-v3.2'},limits:{max_sats_per_request:1}},
      logging:{cost_log:join(dir,'cost.jsonl')}},f.wallet,{info(){},warn(){}},{
        fetchCatalog:async()=>[],payment:{store:f.store,fetchFn:f.fetchFn}});
    assert.equal((await router.chat({messages:[{role:'user',content:'gm'}]})).ok,false);
    assert.equal(f.count().sends,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('targeted bounded catalog includes a model after index 200 without expanding default output',async()=>{
  const data=Array.from({length:582},(_,i)=>({id:i===443?'llama-3.1-8b-instruct':'model-'+i}));
  const deps={fetchFn:async()=>json({data})};
  assert.equal((await fetchProviderCatalog([{baseUrl:good}],deps))[0].models.length,200);
  const result=await fetchProviderCatalog([{baseUrl:good}],{...deps,modelIds:['llama-3.1-8b-instruct']});
  assert.deepEqual(result[0].models.map(m=>m.id),['llama-3.1-8b-instruct']);
});
test('operator isolation is atomic, idempotent, private-backed and preserves model/caps/secret',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'quarantine-config-')),path=join(dir,'config.yaml'),backupDir=join(dir,'backup');
  const before={session_secret:'private',routstr:{models:{chat:'deepseek-v3.2'},limits:{max_sats_per_request:50}}};
  await writeFile(path,JSON.stringify(before),{mode:0o600});
  try {
    const result=await quarantineProvider(bad,{path,backupDir});
    assert.deepEqual(parse(await readFile(result.backup,'utf8')),before);
    const after=parse(await readFile(path,'utf8'));
    assert.deepEqual(after.routstr.quarantined_providers,[bad]);
    delete after.routstr.quarantined_providers;assert.deepEqual(after,before);
    assert.equal((await quarantineProvider(bad,{path,backupDir})).changed,false);
    await assert.rejects(quarantineProvider('https://localhost',{path,backupDir}));
  }finally{await rm(dir,{recursive:true,force:true});}
});
