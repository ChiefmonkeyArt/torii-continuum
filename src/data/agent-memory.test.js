/**
 * MEMORY-1 client-fn request-shape tests. No network/DOM — fetch + localStorage
 * are tiny in-memory stubs. These lock in the exact endpoints, methods, and body
 * shapes so the SPA ↔ agent memory contract cannot silently drift, and prove the
 * security-relevant invariants of the client layer:
 *
 *   • approve sends ONLY {payload_sha256, approval_nonce, ciphertext, event_id}
 *     — never plaintext, never a key. Sealing happens in the browser (memory.js).
 *   • delete always carries confirm:true (no accidental unlink).
 *   • export always carries confirm:true.
 *   • path segments (proposal id, quarantine sha) are URL-encoded.
 *   • every call short-circuits offline with no fetch when no agent is configured.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  memoryWorkingValues, memoryUsage, memoryScoped, memoryVerify, memoryDelete,
  memoryProposals, memoryPropose, memoryApprove, memoryReject,
  memoryExport, memoryImport, memoryQuarantine, memoryQuarantineApprove, memoryQuarantineReject,
} from './agent.js';

function makeStorageStub() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

describe('MEMORY-1 client fns — request shapes', () => {
  let calls;
  beforeEach(() => {
    globalThis.localStorage = makeStorageStub();
    globalThis.window = { __CONTINUUM_AGENT_URL__: 'https://agent.example' };
    calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
  });
  afterEach(() => {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.fetch;
  });

  const body = (i = 0) => JSON.parse(calls[i].opts.body);

  it('memoryWorkingValues GETs /api/memory/working-values with no body', async () => {
    await memoryWorkingValues();
    expect(calls[0].url).toBe('https://agent.example/api/memory/working-values');
    expect(calls[0].opts.method).toBe('GET');
    expect(calls[0].opts.body).toBeUndefined();
  });

  it('memoryUsage GETs /api/memory/usage', async () => {
    await memoryUsage();
    expect(calls[0].url).toBe('https://agent.example/api/memory/usage');
    expect(calls[0].opts.method).toBe('GET');
  });

  it('memoryScoped GETs /api/memory/scoped with project+class query when given', async () => {
    await memoryScoped({ project: 'proj x', cls: 'semantic' });
    expect(calls[0].url).toBe('https://agent.example/api/memory/scoped?project=proj+x&class=semantic');
    expect(calls[0].opts.method).toBe('GET');
  });

  it('memoryScoped GETs the bare endpoint when no scope is given', async () => {
    await memoryScoped();
    expect(calls[0].url).toBe('https://agent.example/api/memory/scoped');
  });

  it('memoryVerify POSTs /api/memory/scoped/verify with the project', async () => {
    await memoryVerify({ project: 'p' });
    expect(calls[0].url).toBe('https://agent.example/api/memory/scoped/verify');
    expect(calls[0].opts.method).toBe('POST');
    expect(body()).toEqual({ project: 'p' });
  });

  it('memoryDelete POSTs delete and ALWAYS sends confirm:true', async () => {
    await memoryDelete({ id: 'item1', project: 'p', reason: 'owner-delete' });
    expect(calls[0].url).toBe('https://agent.example/api/memory/scoped/delete');
    expect(calls[0].opts.method).toBe('POST');
    expect(body()).toEqual({ id: 'item1', project: 'p', reason: 'owner-delete', confirm: true });
  });

  it('memoryProposals GETs /api/memory/proposals', async () => {
    await memoryProposals();
    expect(calls[0].url).toBe('https://agent.example/api/memory/proposals');
    expect(calls[0].opts.method).toBe('GET');
  });

  it('memoryPropose POSTs ciphertext + hash ONLY — never plaintext', async () => {
    await memoryPropose({ project: 'p', kind: 30094, cls: 'semantic', d_tag: 'k', ciphertext: 'SEALED', payload_sha256: 'a'.repeat(64), source: 'chat' });
    expect(calls[0].url).toBe('https://agent.example/api/memory/proposals');
    expect(calls[0].opts.method).toBe('POST');
    const sent = body();
    expect(sent.kind).toBe(30094);
    expect(sent.d_tag).toBe('k');
    expect(sent.ciphertext).toBe('SEALED');
    expect(sent.payload_sha256).toBe('a'.repeat(64));
    // Hard invariant: the client never forwards plaintext.
    expect('payload' in sent).toBe(false);
    expect('evidence' in sent).toBe(false);
    expect('plaintext' in sent).toBe(false);
  });

  it('memoryApprove POSTs hash + nonce ONLY — never plaintext, ciphertext, or a key', async () => {
    await memoryApprove('prop 1', {
      payload_sha256: 'a'.repeat(64), approval_nonce: 'nonce-1', event_id: 'ev1',
    });
    // Path segment url-encoded.
    expect(calls[0].url).toBe('https://agent.example/api/memory/proposals/prop%201/approve');
    expect(calls[0].opts.method).toBe('POST');
    const sent = body();
    expect(sent).toEqual({ payload_sha256: 'a'.repeat(64), approval_nonce: 'nonce-1', event_id: 'ev1' });
    // Hard invariant: the client re-sends neither plaintext, ciphertext, nor key material.
    expect('payload' in sent).toBe(false);
    expect('ciphertext' in sent).toBe(false);
    expect('plaintext' in sent).toBe(false);
    expect('key' in sent).toBe(false);
    expect('privkey' in sent).toBe(false);
  });

  it('memoryReject POSTs the nonce to the reject endpoint (id encoded)', async () => {
    await memoryReject('prop/1', { approval_nonce: 'n' });
    expect(calls[0].url).toBe('https://agent.example/api/memory/proposals/prop%2F1/reject');
    expect(body()).toEqual({ approval_nonce: 'n' });
  });

  it('memoryExport POSTs /api/memory/export with confirm:true', async () => {
    await memoryExport();
    expect(calls[0].url).toBe('https://agent.example/api/memory/export');
    expect(calls[0].opts.method).toBe('POST');
    expect(body()).toEqual({ confirm: true });
  });

  it('memoryImport POSTs the bundle wrapped in {bundle}', async () => {
    const bundle = { schema: 'torii.continuum.memory_bundle/1', items: [] };
    await memoryImport(bundle);
    expect(calls[0].url).toBe('https://agent.example/api/memory/import');
    expect(body()).toEqual({ bundle });
  });

  it('memoryQuarantine GETs /api/memory/quarantine', async () => {
    await memoryQuarantine();
    expect(calls[0].url).toBe('https://agent.example/api/memory/quarantine');
    expect(calls[0].opts.method).toBe('GET');
  });

  it('memoryQuarantineApprove POSTs to the sha-scoped approve endpoint (sha encoded)', async () => {
    await memoryQuarantineApprove('ab/cd', { sha256: 'ab/cd', project: 'p', d_tag: 'k' });
    expect(calls[0].url).toBe('https://agent.example/api/memory/quarantine/ab%2Fcd/approve');
    expect(body()).toEqual({ sha256: 'ab/cd', project: 'p', d_tag: 'k' });
  });

  it('memoryQuarantineReject POSTs to the sha-scoped reject endpoint', async () => {
    await memoryQuarantineReject('deadbeef');
    expect(calls[0].url).toBe('https://agent.example/api/memory/quarantine/deadbeef/reject');
    expect(calls[0].opts.method).toBe('POST');
  });
});

describe('MEMORY-1 client fns — offline short-circuit (no fetch, no leak)', () => {
  beforeEach(() => {
    globalThis.localStorage = makeStorageStub();
    globalThis.window = {}; // no agent URL configured
  });
  afterEach(() => {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.fetch;
  });

  it('every memory call returns offline without touching fetch', async () => {
    let fetched = 0;
    globalThis.fetch = async () => { fetched++; return { ok: true, status: 200, json: async () => ({}) }; };
    const results = await Promise.all([
      memoryWorkingValues(), memoryUsage(), memoryScoped({ project: 'p' }), memoryVerify({ project: 'p' }),
      memoryDelete({ id: 'x', project: 'p' }), memoryProposals(),
      memoryApprove('id', { payload_sha256: 'h', approval_nonce: 'n', ciphertext: 'c' }),
      memoryReject('id', { approval_nonce: 'n' }), memoryExport(), memoryImport({}),
      memoryQuarantine(), memoryQuarantineApprove('s', {}), memoryQuarantineReject('s'),
    ]);
    expect(fetched).toBe(0);
    for (const r of results) expect(r.offline).toBe(true);
  });
});
