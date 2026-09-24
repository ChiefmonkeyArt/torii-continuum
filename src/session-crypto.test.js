/**
 * OWNER-UI-1 client crypto — session-id mapping + NIP-44 seal/unseal.
 * Pure, DOM-free; the signer is staged as fake encrypt/decrypt so the
 * round-trip and the trust model (keyed to the owner pubkey) are tested
 * without a browser.
 */
import { describe, it, expect } from 'vitest';
import { sealSession, unsealSession, sanitizeMessages, SESSION_BLOB_VERSION } from './session-crypto.js';
import { sessionIdFor } from './chat-threads.js';

// A reversible, pubkey-scoped stand-in for window.nostr.nip44: it refuses to
// unseal under the wrong pubkey, mirroring NIP-44's receiver-binding.
const fakeEncrypt = (pk, plaintext) => Promise.resolve(JSON.stringify({ pk, p: plaintext }));
const fakeDecrypt = (pk, ct) => {
  const o = JSON.parse(ct);
  if (o.pk !== pk) throw new Error('wrong recipient pubkey');
  return Promise.resolve(o.p);
};
const PUB = 'a'.repeat(64);

describe('sessionIdFor', () => {
  it('maps general / project / page thread keys to valid slugs', () => {
    expect(sessionIdFor('general')).toBe('general');
    expect(sessionIdFor('project:torii-quest')).toBe('project-torii-quest');
    expect(sessionIdFor('page:/dashboard')).toBe('page-dashboard');
    expect(sessionIdFor('page:/projects/:slug/board')).toBe('page-projects-slug-board');
  });

  it('never emits an empty or non-slug id', () => {
    for (const key of ['', null, undefined, '///', ':::']) {
      const id = sessionIdFor(key);
      expect(id).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
    }
  });

  it('does not collide distinct thread keys', () => {
    const keys = ['general', 'project:a', 'project:b', 'page:/', 'page:/dashboard', 'page:/projects/a'];
    const ids = keys.map(sessionIdFor);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('sanitizeMessages', () => {
  it('keeps well-formed messages and coerces a missing timestamp', () => {
    const out = sanitizeMessages([{ who: 'user', text: 'hi' }, { who: 'ai', text: 'yo', at: 123, action: 'topup' }]);
    expect(out).toEqual([
      { who: 'user', text: 'hi', at: 0 },
      { who: 'ai', text: 'yo', at: 123, action: 'topup' },
    ]);
  });

  it('drops malformed entries', () => {
    expect(sanitizeMessages([null, {}, { who: 1, text: 'x' }, { who: 'u' }, { who: 'ai', text: 'ok' }])).toEqual([
      { who: 'ai', text: 'ok', at: 0 },
    ]);
  });
});

describe('sealSession / unsealSession', () => {
  it('round-trips bounded private title, pin and project metadata without changing legacy blobs', async () => {
    const metadata = { title: '  My project  ', pinned: true, project: 'torii' };
    const ct = await sealSession({ encrypt: fakeEncrypt, pubkey: PUB }, { threadKey: 'session-a', messages: [], metadata });
    const value = await unsealSession({ decrypt: fakeDecrypt, pubkey: PUB }, ct);
    expect(value.metadata).toEqual({ title: 'My project', pinned: true, project: 'torii' });
  });
  it('round-trips threadKey + messages through seal and unseal', async () => {
    const msgs = [{ who: 'user', text: 'hello', at: 1 }, { who: 'ai', text: 'hi', at: 2 }];
    const ct = await sealSession({ encrypt: fakeEncrypt, pubkey: PUB }, { threadKey: 'project:torii', messages: msgs });
    expect(typeof ct).toBe('string');
    expect(await unsealSession({ decrypt: fakeDecrypt, pubkey: PUB }, ct)).toEqual({ threadKey: 'project:torii', messages: msgs });
  });

  it('blob carries the version marker', async () => {
    const ct = await sealSession({ encrypt: fakeEncrypt, pubkey: PUB }, { threadKey: 'general', messages: [] });
    const { v } = JSON.parse(JSON.parse(ct).p);
    expect(v).toBe(SESSION_BLOB_VERSION);
  });

  it('unsealing under the wrong pubkey throws (receiver-bound)', async () => {
    const ct = await sealSession({ encrypt: fakeEncrypt, pubkey: PUB }, { threadKey: 'general', messages: [{ who: 'u', text: 'x' }] });
    await expect(unsealSession({ decrypt: fakeDecrypt, pubkey: 'b'.repeat(64) }, ct)).rejects.toThrow(/recipient/);
  });

  it('rejects a non-JSON / foreign blob', async () => {
    await expect(unsealSession({ decrypt: fakeDecrypt, pubkey: PUB }, JSON.stringify({ pk: PUB, p: 'not-json' })))
      .rejects.toThrow(/valid JSON|foreign/i);
  });

  it('requires encrypt/decrypt/pubkey and rejects a missing message list', async () => {
    // missing deps
    await expect(sealSession(null, {})).rejects.toThrow(/encrypt is required/);
    await expect(unsealSession({}, 'x')).rejects.toThrow(/decrypt is required/);
    await expect(sealSession({ encrypt: fakeEncrypt }, { threadKey: 'x', messages: [] })).rejects.toThrow(/pubkey/);
    await expect(unsealSession({ decrypt: fakeDecrypt, pubkey: PUB }, '')).rejects.toThrow(/ciphertext/);
    // blob without a message list
    const ct = await sealSession({ encrypt: (pk, p) => fakeEncrypt(pk, '{"nope":1}'), pubkey: PUB }, { threadKey: 'x', messages: [] });
    await expect(unsealSession({ decrypt: fakeDecrypt, pubkey: PUB }, ct)).rejects.toThrow(/message list/);
  });
});
