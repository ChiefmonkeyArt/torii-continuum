import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoutstr } from '../core/routstr.mjs';

const catalog = () => [{
  baseUrl: 'https://provider.invalid', name: 'example', models: [{ id: 'deepseek', max_cost_sats: 2 }],
}];
function fixture(fetchCatalog = async () => catalog()) {
  let clock = 0;
  const timers = [];
  let sends = 0;
  const cfg = { routstr: { models: { chat: 'deepseek' }, discovery: { enabled: false, refresh_minutes: 10 } } };
  const provider = createRoutstr(cfg, { send() { sends++; throw new Error('discovery must not pay'); } },
    { info() {}, warn() {}, error() {} }, {
      cacheNow: () => clock,
      fetchCatalog,
      setTimeout(fn, ms) { const t = { fn, ms, cancelled: false, unref() {} }; timers.push(t); return t; },
      clearTimeout(t) { t.cancelled = true; },
    });
  return { provider, timers, advance(ms) { clock += ms; }, sends: () => sends };
}

test('startup preloads metadata only and schedules refresh before expiry', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return catalog(); });
  await f.provider.startDiscovery();
  assert.equal(calls, 1);
  assert.equal(f.sends(), 0);
  assert.equal(f.provider.discoveryStatus().ready, true);
  assert.equal(f.timers[0].ms, 450000);
  await f.provider.startDiscovery();
  assert.equal(calls, 1);
  assert.equal(f.timers.length, 1);
  f.provider.stopDiscovery();
  assert.equal(f.timers[0].cancelled, true);
});

test('fresh chat catalogue does not wait for a background refresh', async () => {
  let release;
  let calls = 0;
  const f = fixture(async () => ++calls === 1 ? catalog() : new Promise(r => { release = r; }));
  await f.provider.startDiscovery();
  f.advance(450000);
  f.timers[0].fn();
  assert.equal(f.provider.discoveryStatus().refreshing, true);
  const available = await f.provider.refreshCatalog();
  assert.equal(available[0].models[0].id, 'deepseek');
  assert.equal(calls, 2);
  release(catalog());
  await Promise.resolve(); await Promise.resolve();
  f.provider.stopDiscovery();
});

test('concurrent cold starts share a single lookup; stop prevents rescheduling', async () => {
  let release;
  let calls = 0;
  const f = fixture(() => { calls++; return new Promise(r => { release = r; }); });
  const one = f.provider.startDiscovery();
  const two = f.provider.refreshCatalog();
  assert.equal(calls, 1);
  f.provider.stopDiscovery();
  release(catalog());
  await Promise.all([one, two]);
  assert.equal(f.timers.length, 0);
});

test('empty early refresh retains only still-fresh data, never renews stale pricing', async () => {
  let calls = 0;
  const f = fixture(async () => ++calls === 1 ? catalog() : []);
  await f.provider.startDiscovery();
  f.advance(450000);
  await f.provider.refreshCatalog({ force: true });
  assert.equal(f.provider.discoveryStatus().ready, true);
  assert.equal(f.provider.discoveryStatus().age_ms, 450000);
  f.advance(160000);
  const result = await f.provider.refreshCatalog();
  assert.deepEqual(result, []);
  assert.equal(f.provider.discoveryStatus().ready, false);
  f.provider.stopDiscovery();
});

test('failed discovery is rate-limited, retried later, and leaks no endpoints in status', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('offline'); });
  await f.provider.startDiscovery();
  assert.equal(f.timers[0].ms, 30000);
  for (let i = 0; i < 10; i++) assert.deepEqual(await f.provider.refreshCatalog(), []);
  assert.equal(calls, 1);
  f.advance(11000);
  await f.provider.refreshCatalog();
  assert.equal(calls, 2);
  assert.ok(!JSON.stringify(f.provider.discoveryStatus()).includes('https'));
  assert.equal(f.sends(), 0);
  f.provider.stopDiscovery();
});
