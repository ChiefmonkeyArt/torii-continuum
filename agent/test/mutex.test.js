/**
 * Resource-keyed mutex (audit A12).
 *
 * Proves the primitive the genesis/updater/consent fixes depend on: same-key
 * `run` calls execute strictly one at a time (in submission order), different
 * keys interleave, and an error in one task does not strand the next queued
 * task for that key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedMutex } from '../lib/mutex.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('same-key runs serialize in submission order', async () => {
  const m = createKeyedMutex();
  const order = [];
  const mk = (n, delay) => async () => {
    order.push(`start:${n}`);
    await sleep(delay);
    order.push(`end:${n}`);
    return n;
  };
  const [a, b, c] = await Promise.all([
    m.run('k', mk('a', 30)),
    m.run('k', mk('b', 5)),
    m.run('k', mk('c', 1)),
  ]);
  assert.deepEqual([a, b, c], ['a', 'b', 'c']);
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
});

test('different keys run concurrently', async () => {
  const m = createKeyedMutex();
  let inFlight = 0;
  let maxInFlight = 0;
  const job = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(10);
    inFlight -= 1;
  };
  await Promise.all(['a', 'b', 'c', 'd'].map((k) => m.run(k, job)));
  assert.ok(maxInFlight > 1, `expected overlap, saw maxInFlight=${maxInFlight}`);
});

test('a throwing task does not strand the next same-key task', async () => {
  const m = createKeyedMutex();
  const first = m.run('k', async () => { throw new Error('boom'); });
  await assert.rejects(first, /boom/);
  const second = await m.run('k', async () => 'ok');
  assert.equal(second, 'ok');
});

test('release order also serializes once a new same-key task queues behind a thrower', async () => {
  const m = createKeyedMutex();
  const results = [];
  const p1 = m.run('k', async () => { throw new Error('x'); }).catch((e) => results.push('throw'));
  const p2 = m.run('k', async () => { results.push('second'); return 2; });
  await Promise.all([p1, p2]);
  assert.deepEqual(results, ['throw', 'second']);
});