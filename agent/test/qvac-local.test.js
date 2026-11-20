import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askQvac, localQuestion } from '../lib/qvac-local.mjs';

async function withSocket(work, run) {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-test-')), path = join(dir, 's');
  const s = createServer(peer => { peer.on('error', () => {}); peer.once('data', line => work(peer, JSON.parse(line))); });
  await new Promise(r => s.listen(path, r));
  try { await run(path); } finally { await new Promise(r => s.close(r)); await rm(dir,{recursive:true,force:true}); }
}
test('local input limits count bytes; no attachments, arrays, or empty content', () => {
  for (const q of ['', ' ', null, [], {}, '🌈'.repeat(513)]) assert.equal(localQuestion(q),null);
  assert.equal(localQuestion(' hi '),'hi');
});
test('local-only socket sees just the question, reconstructs split UTF-8 and requires done', async () => {
  await withSocket((p,msg) => {
    assert.deepEqual(msg,{question:'hi'});
    const buf = Buffer.from('{"delta":"hé"}\n{"done":true}\n');
    const i = buf.indexOf(0xc3) + 1; p.write(buf.subarray(0,i)); setImmediate(()=>p.end(buf.subarray(i)));
  }, async path => {
    const deltas=[]; assert.equal(await askQvac('hi',{path,onDelta:d=>deltas.push(d)}),'hé'); assert.deepEqual(deltas,['hé']);
  });
});
test('unavailable, truncated, oversized and stalled local replies fail closed', async () => {
  for (const handler of [p=>p.end('{"delta":"partial"}\n'),p=>p.end('bad\n'),p=>p.end('a'.repeat(32769)),p=>p.end('{"done":true}\n'),p=>p.resume()]) {
    await withSocket(handler, async path => { await assert.rejects(askQvac('hi',{path,timeoutMs:100})); });
  }
  await assert.rejects(askQvac('hi',{path:'/nonexistent/torii-qvac.sock'}));
});
