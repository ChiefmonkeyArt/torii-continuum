/**
 * wallet.health() — CONT-HEALTH-2 non-mutating wallet + mint health.
 *
 * Offline by construction: the wallet is built with zero configured mints, so
 * no cashu-ts network call is reached. These pin the disabled path, the exact
 * public shape, and the info-disclosure guarantee (no proofs / secrets / tokens
 * in the output). The mutation-free guarantee is structural: health() only ever
 * calls readProofs() + read-only cashu-ts probes, never send()/receive().
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWallet, mintHealth } from '../core/wallet.mjs';

function silentLog() { return { info() {}, warn() {}, error() {} }; }

// ── Fake wallet/mint exercising the cashu-ts ^3.7.1 read primitives the health
// probe depends on. Verified against the published cashu-ts 3.7.1 API surface:
//   loadMint(): Promise<void>
//   getMintInfo(): MintInfo  (getters .name/.version/.pubkey; .isSupported(7) →
//                             { supported: boolean })
//   groupProofsByState(proofs): Promise<{ unspent, pending, spent }>
// The probe must ONLY call these three read methods — never send()/receive().
function fakeWallet({
  load = async () => {},
  info = { name: 'Test Mint', version: 'Nutshell/1.0', pubkey: 'abc123', nut07: true },
  grouped = null,
  groupThrows = null,
} = {}) {
  const calls = { loadMint: 0, getMintInfo: 0, groupProofsByState: 0, send: 0, receive: 0 };
  return {
    calls,
    async loadMint() { calls.loadMint++; return load(); },
    getMintInfo() {
      calls.getMintInfo++;
      if (info === null) throw new Error('info unavailable');
      return {
        name: info.name,
        version: info.version,
        pubkey: info.pubkey,
        isSupported(n) { return { supported: n === 7 ? !!info.nut07 : false }; },
      };
    },
    async groupProofsByState(proofs) {
      calls.groupProofsByState++;
      if (groupThrows) throw groupThrows;
      if (grouped) return grouped;
      return { unspent: proofs, pending: [], spent: [] };
    },
    async send() { calls.send++; throw new Error('send must never be called by health'); },
    async receive() { calls.receive++; throw new Error('receive must never be called by health'); },
  };
}

const PROOFS = [
  { amount: 10, secret: 'top-secret-1', C: 'commit-1' },
  { amount: 5, secret: 'top-secret-2', C: 'commit-2' },
];

test('health() with no mints reports disabled, not a fake green light', async () => {
  const w = await createWallet({ cashu: { mints: [] } }, silentLog());
  const h = await w.health();
  assert.equal(h.configured, false);
  assert.equal(h.overall, 'disabled');
  assert.deepEqual(h.mints, []);
  assert.ok(typeof h.checked_at === 'string' && h.checked_at.length > 0);
});

test('health() is exposed alongside the existing wallet surface', async () => {
  const w = await createWallet({ cashu: { mints: [] } }, silentLog());
  assert.equal(typeof w.health, 'function');
  assert.equal(typeof w.balance, 'function');
  assert.equal(typeof w.receive, 'function');
  assert.equal(typeof w.send, 'function');
});

test('health() output never carries proofs, secrets, or tokens', async () => {
  const w = await createWallet({ cashu: { mints: [] } }, silentLog());
  const blob = JSON.stringify(await w.health()).toLowerCase();
  for (const forbidden of ['secret', 'proof', '"c"', 'token', 'privkey', 'private']) {
    assert.ok(!blob.includes(forbidden), `health output must not include "${forbidden}"`);
  }
});

test('health() does not mutate balance (read-only)', async () => {
  const w = await createWallet({ cashu: { mints: [] } }, silentLog());
  const before = await w.balance();
  await w.health();
  const after = await w.balance();
  assert.deepEqual(before, after);
});

// ── mintHealth() connected-path coverage (CONT-HEALTH-2, review M3) ──────────

test('mintHealth: healthy mint with all-unspent proofs → ok', async () => {
  const wallet = fakeWallet();
  const r = await mintHealth({ url: 'https://mint.example', wallet, proofs: PROOFS, timeoutMs: 1000 });
  assert.equal(r.state, 'ok');
  assert.equal(r.reachable, true);
  assert.equal(r.reason, null);
  assert.equal(r.balance_sats, 15);
  assert.equal(r.proof_count, 2);
  assert.equal(r.identity.name, 'Test Mint');
  assert.equal(r.identity.nut07_supported, true);
  // pubkey is fingerprinted, never echoed raw.
  assert.ok(r.identity.pubkey_fingerprint.startsWith('sha256:'));
  assert.ok(!r.identity.pubkey_fingerprint.includes('abc123'));
  assert.equal(r.validated.checked, true);
  assert.equal(r.validated.unspent_sats, 15);
  assert.equal(r.validated.spent_sats, 0);
  assert.equal(r.validated.pending_sats, 0);
  // Only read primitives were touched.
  assert.equal(wallet.calls.send, 0);
  assert.equal(wallet.calls.receive, 0);
  assert.equal(wallet.calls.loadMint, 1);
  assert.equal(wallet.calls.groupProofsByState, 1);
});

test('mintHealth: empty wallet with NUT-07 support → ok, no state check attempted', async () => {
  const wallet = fakeWallet();
  const r = await mintHealth({ url: 'https://mint.example', wallet, proofs: [], timeoutMs: 1000 });
  assert.equal(r.state, 'ok');
  assert.equal(r.balance_sats, 0);
  assert.equal(r.validated, null); // nothing to check
  assert.equal(wallet.calls.groupProofsByState, 0);
});

test('mintHealth: mint without NUT-07 → degraded (balance unvalidated)', async () => {
  const wallet = fakeWallet({ info: { name: 'NoNut07', version: 'x', pubkey: 'p', nut07: false } });
  const r = await mintHealth({ url: 'https://mint.example', wallet, proofs: PROOFS, timeoutMs: 1000 });
  assert.equal(r.state, 'degraded');
  assert.match(r.reason, /NUT-07/);
  assert.equal(r.identity.nut07_supported, false);
  assert.equal(r.validated, null);
  assert.equal(wallet.calls.groupProofsByState, 0); // never checked without NUT-07
});

test('mintHealth: some proofs spent/pending → degraded', async () => {
  const wallet = fakeWallet({
    grouped: {
      unspent: [{ amount: 10 }],
      pending: [{ amount: 3 }],
      spent: [{ amount: 2 }],
    },
  });
  const r = await mintHealth({ url: 'https://mint.example', wallet, proofs: PROOFS, timeoutMs: 1000 });
  assert.equal(r.state, 'degraded');
  assert.match(r.reason, /spent or pending/);
  assert.equal(r.validated.spent_sats, 2);
  assert.equal(r.validated.pending_sats, 3);
  assert.equal(r.validated.unspent_sats, 10);
});

test('mintHealth: proof-state check failure → degraded with sanitized reason', async () => {
  const wallet = fakeWallet({ groupThrows: new Error('ECONNRESET while /checkstate') });
  const r = await mintHealth({ url: 'https://mint.example', wallet, proofs: PROOFS, timeoutMs: 1000 });
  assert.equal(r.state, 'degraded');
  assert.match(r.reason, /proof-state check failed/);
  assert.equal(r.validated.checked, false);
  assert.equal(r.validated.reason, 'unreachable'); // coarse category, not raw error
});

test('mintHealth: mint info unavailable → degraded', async () => {
  const wallet = fakeWallet({ info: null });
  const r = await mintHealth({ url: 'https://mint.example', wallet, proofs: PROOFS, timeoutMs: 1000 });
  assert.equal(r.state, 'degraded');
  assert.equal(r.identity, null);
  assert.match(r.reason, /info unavailable/);
});

test('mintHealth: unreachable mint (loadMint rejects) → unreachable, sanitized', async () => {
  const wallet = fakeWallet({ load: async () => { throw new Error('getaddrinfo ENOTFOUND mint.example'); } });
  const r = await mintHealth({ url: 'https://mint.example', wallet, proofs: PROOFS, timeoutMs: 1000 });
  assert.equal(r.state, 'unreachable');
  assert.equal(r.reachable, false);
  assert.equal(r.reason, 'unreachable');
  assert.equal(r.identity, null);
  assert.equal(r.validated, null);
  assert.equal(wallet.calls.getMintInfo, 0);
});

test('mintHealth: hung mint hits the wall-clock timeout → unreachable/timeout', async () => {
  const wallet = fakeWallet({ load: () => new Promise(() => {}) }); // never resolves
  const r = await mintHealth({ url: 'https://mint.example', wallet, proofs: PROOFS, timeoutMs: 20 });
  assert.equal(r.state, 'unreachable');
  assert.equal(r.reason, 'timeout');
});

test('mintHealth: never mutates the caller-supplied proofs', async () => {
  const wallet = fakeWallet();
  const proofs = PROOFS.map((p) => ({ ...p }));
  const snapshot = JSON.parse(JSON.stringify(proofs));
  await mintHealth({ url: 'https://mint.example', wallet, proofs, timeoutMs: 1000 });
  assert.deepEqual(proofs, snapshot);
});

test('mintHealth: output never leaks proof secrets or commitments', async () => {
  const wallet = fakeWallet();
  const blob = JSON.stringify(await mintHealth({ url: 'https://mint.example', wallet, proofs: PROOFS, timeoutMs: 1000 }));
  assert.ok(!blob.includes('top-secret'), 'must not echo proof secret');
  assert.ok(!blob.includes('commit-'), 'must not echo proof commitment');
});
