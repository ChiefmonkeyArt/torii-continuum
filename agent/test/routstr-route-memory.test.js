import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readMinimum,routeMemory} from '../core/routstr-route-memory.mjs';

test('payment minimum accepts only bounded, recognized contracts in msats',async()=>{
  const read=detail=>readMinimum(Response.json({detail}));
  assert.equal(await read({type:'minimum_balance_required',amount_required_msat:1001}),2);
  assert.equal(await read({error:{code:'insufficient_balance',message:'Insufficient balance: 3.1 sats (3100 msats) required for this model; 2 sats available.'}}),4);
  for(const detail of [{code:'bogus',required_msats:10000},{code:'insufficient_balance',required_msats:-1},
    {code:'insufficient_balance',required_msats:2**55},{code:'insufficient_balance',message:'please deposit 40 sats'},
    {code:'insufficient_balance',required_msats:1000,junk:'X'.repeat(8192)}]) assert.equal(await read(detail),0);
});

test('receipt is opaque, expires and never introduces a missing provider or another model',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'route-receipt-')), file=join(dir,'last.json');
  let clock=1000;
  const a={baseUrl:'https://a.example',model:{id:'selected'}}, b={...a,baseUrl:'https://b.example'};
  try{
    let r=routeMemory(file,()=>clock);await r.success(b.baseUrl,b.model.id);
    assert.doesNotMatch(await readFile(file,'utf8'),/example|selected/);
    r=routeMemory(file,()=>clock);
    assert.deepEqual(await r.prefer([a,b]),[b,a]);
    assert.deepEqual(await r.prefer([a]),[a]);
    const other={...b,model:{id:'other'}};
    assert.deepEqual(await r.prefer([a,other]),[a,other]);
    r.learn(b.baseUrl,'selected',4); assert.equal(r.quote(b.baseUrl,'other'),0);
    clock+=86400001;assert.deepEqual(await r.prefer([a,b]),[a,b]);assert.equal(r.quote(b.baseUrl,'selected'),0);
  } finally {await rm(dir,{recursive:true,force:true});}
});
