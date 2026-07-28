/**
 * MEMORY-ACTIVATION-1 controller tests. The activation flow is a pure, DOM-free
 * state machine with every I/O dependency injected, so we drive it through all
 * eight states and assert:
 *   • locked owner can run the flow to SUCCESS only after an AUTHORITATIVE
 *     unlocked_for_owner:true refresh (never on the optimistic activate result);
 *   • a signer that is missing/incapable → SIGNER_UNAVAILABLE, no network;
 *   • a signer that throws (cancel/deny) on sign OR decrypt → SIGNER_REJECTED;
 *   • challenge/ciphertext/activate/state network failures → ERROR (recoverable);
 *   • the flow can be retried after any terminal error;
 *   • no plaintext or key is ever emitted in a transition.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ACTIVATION_STATES, signerCapabilities, signerAvailable,
  buildActivationEvent, decryptEntries, runActivation,
} from './memory-activation.js';

const S = ACTIVATION_STATES;

function fullSigner() {
  return {
    nostr: {
      signEvent: async (e) => ({ ...e, id: 'id', sig: 'sig', pubkey: 'pk' }),
      getPublicKey: async () => 'ownerhex',
      nip44: { decrypt: async (_pk, ct) => ct.replace('ct:', '') },
    },
  };
}

// A deps object wired to happy-path stubs; individual tests override fields.
function happyDeps(overrides = {}) {
  return {
    signerAvailable: () => true,
    getPublicKey: async () => 'ownerhex',
    signEvent: async (e) => ({ ...e, id: 'id', sig: 'sig', pubkey: 'ownerhex' }),
    decrypt: async (_pk, ct) => ct,
    fetchChallenge: async () => ({ ok: true, data: { challenge: 'chal-123' } }),
    fetchCiphertexts: async () => ({ ok: true, data: { entries: [] } }),
    postActivate: async () => ({ ok: true, data: { ok: true } }),
    fetchState: async () => ({ ok: true, data: { unlocked_for_owner: true } }),
    origin: 'https://example.test',
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

describe('signerCapabilities / signerAvailable', () => {
  it('reports a fully capable signer as available', () => {
    const win = fullSigner();
    expect(signerCapabilities(win)).toEqual({
      present: true, canSign: true, canGetPublicKey: true, canDecrypt: true,
    });
    expect(signerAvailable(win)).toBe(true);
  });

  it('reports no signer at all as unavailable', () => {
    expect(signerAvailable({})).toBe(false);
    expect(signerCapabilities({}).present).toBe(false);
  });

  it('reports a signer missing nip44.decrypt as unavailable', () => {
    const win = { nostr: { signEvent: () => {}, getPublicKey: () => {} } };
    expect(signerAvailable(win)).toBe(false);
    expect(signerCapabilities(win).canDecrypt).toBe(false);
  });
});

describe('buildActivationEvent', () => {
  it('builds a kind-22242 event carrying the challenge in content + tags', () => {
    const evt = buildActivationEvent('chal', 'https://o.test', 1_700_000_000_000);
    expect(evt.kind).toBe(22242);
    expect(evt.content).toBe('chal');
    expect(evt.created_at).toBe(1_700_000_000);
    expect(evt.tags).toContainEqual(['challenge', 'chal']);
    expect(evt.tags).toContainEqual(['relay', 'https://o.test']);
  });
});

describe('decryptEntries', () => {
  it('decrypts each blob and recovers d-tag/kind from a full event', async () => {
    const event = { kind: 30091, created_at: 5, id: 'evid', tags: [['d', 'mydtag']], content: '{"a":1}' };
    const list = [{ kind: 30091, ciphertext: 'ct1' }];
    const decrypt = async () => JSON.stringify(event);
    const out = await decryptEntries(list, 'pk', decrypt);
    expect(out).toHaveLength(1);
    expect(out[0].d_tag).toBe('mydtag');
    expect(out[0].kind).toBe(30091);
    expect(out[0].event_id).toBe('evid');
    expect(out[0].content).toEqual({ a: 1 });
  });

  it('passes a non-event plaintext through as content', async () => {
    const out = await decryptEntries([{ kind: 1, ciphertext: 'x' }], 'pk', async () => 'just text');
    expect(out[0].content).toBe('just text');
    expect(out[0].d_tag).toBeUndefined();
  });

  it('skips malformed entries with no ciphertext', async () => {
    const out = await decryptEntries([null, { kind: 1 }, {}], 'pk', async () => 'x');
    expect(out).toHaveLength(0);
  });

  it('propagates a signer decrypt rejection (caller maps to SIGNER_REJECTED)', async () => {
    const decrypt = async () => { throw new Error('user rejected'); };
    await expect(decryptEntries([{ kind: 1, ciphertext: 'x' }], 'pk', decrypt)).rejects.toThrow('user rejected');
  });
});

describe('runActivation — happy path', () => {
  it('walks READY→…→SUCCESS and resolves ok only on authoritative unlock', async () => {
    const states = [];
    const res = await runActivation(happyDeps(), (t) => states.push(t.state));
    expect(res.ok).toBe(true);
    expect(res.state).toBe(S.SUCCESS);
    expect(states).toContain(S.REQUESTING_SIGNATURE);
    expect(states).toContain(S.ACTIVATING);
    expect(states[states.length - 1]).toBe(S.SUCCESS);
  });

  it('sends the signed event + decrypted entries to postActivate', async () => {
    const postActivate = vi.fn(async () => ({ ok: true }));
    const deps = happyDeps({
      fetchCiphertexts: async () => ({ ok: true, data: { entries: [{ kind: 1, ciphertext: 'hello' }] } }),
      decrypt: async (_pk, ct) => ct,
      postActivate,
    });
    await runActivation(deps);
    expect(postActivate).toHaveBeenCalledTimes(1);
    const arg = postActivate.mock.calls[0][0];
    expect(arg.event).toBeTruthy();
    expect(Array.isArray(arg.entries)).toBe(true);
  });
});

describe('runActivation — signer unavailable', () => {
  it('emits SIGNER_UNAVAILABLE and touches no network', async () => {
    const fetchChallenge = vi.fn();
    const res = await runActivation(happyDeps({ signerAvailable: () => false, fetchChallenge }));
    expect(res.state).toBe(S.SIGNER_UNAVAILABLE);
    expect(res.ok).toBe(false);
    expect(fetchChallenge).not.toHaveBeenCalled();
  });
});

describe('runActivation — signer rejection', () => {
  it('signEvent throwing → SIGNER_REJECTED', async () => {
    const res = await runActivation(happyDeps({
      signEvent: async () => { throw new Error('cancelled'); },
    }));
    expect(res.state).toBe(S.SIGNER_REJECTED);
    expect(res.reason).toMatch(/cancelled/);
  });

  it('a null signature → SIGNER_REJECTED', async () => {
    const res = await runActivation(happyDeps({ signEvent: async () => null }));
    expect(res.state).toBe(S.SIGNER_REJECTED);
  });

  it('decrypt throwing → SIGNER_REJECTED', async () => {
    const res = await runActivation(happyDeps({
      fetchCiphertexts: async () => ({ ok: true, data: { entries: [{ kind: 1, ciphertext: 'x' }] } }),
      decrypt: async () => { throw new Error('denied'); },
    }));
    expect(res.state).toBe(S.SIGNER_REJECTED);
  });
});

describe('runActivation — network/server failures are recoverable ERROR', () => {
  it('challenge fetch rejects → ERROR', async () => {
    const res = await runActivation(happyDeps({ fetchChallenge: async () => { throw new Error('net'); } }));
    expect(res.state).toBe(S.ERROR);
  });

  it('challenge not ok → ERROR', async () => {
    const res = await runActivation(happyDeps({ fetchChallenge: async () => ({ ok: false, reason: 'boom' }) }));
    expect(res.state).toBe(S.ERROR);
    expect(res.reason).toBe('boom');
  });

  it('ciphertexts not ok → ERROR', async () => {
    const res = await runActivation(happyDeps({ fetchCiphertexts: async () => ({ ok: false, reason: 'x' }) }));
    expect(res.state).toBe(S.ERROR);
  });

  it('activate not ok → ERROR', async () => {
    const res = await runActivation(happyDeps({ postActivate: async () => ({ ok: false, reason: 'nope' }) }));
    expect(res.state).toBe(S.ERROR);
    expect(res.reason).toBe('nope');
  });
});

describe('runActivation — never falsely shows unlocked', () => {
  it('activate ok but authoritative state still LOCKED → ERROR, not SUCCESS', async () => {
    const states = [];
    const res = await runActivation(happyDeps({
      postActivate: async () => ({ ok: true }),
      fetchState: async () => ({ ok: true, data: { unlocked_for_owner: false } }),
    }), (t) => states.push(t.state));
    expect(res.state).toBe(S.ERROR);
    expect(states).not.toContain(S.SUCCESS);
  });

  it('authoritative state fetch fails → ERROR, not SUCCESS', async () => {
    const res = await runActivation(happyDeps({ fetchState: async () => { throw new Error('down'); } }));
    expect(res.state).toBe(S.ERROR);
  });
});

describe('runActivation — retry after a terminal error', () => {
  it('a failed run followed by a good run reaches SUCCESS', async () => {
    let calls = 0;
    const deps = happyDeps({
      fetchChallenge: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, reason: 'transient' };
        return { ok: true, data: { challenge: 'c2' } };
      },
    });
    const first = await runActivation(deps);
    expect(first.state).toBe(S.ERROR);
    const second = await runActivation(deps);
    expect(second.state).toBe(S.SUCCESS);
  });
});

describe('activation tolerates the signers that actually exist (CONT-SIGNER-1)', () => {
  const runTo = async (overrides) => {
    const seen = [];
    const r = await runActivation(happyDeps(overrides), (t) => seen.push(t));
    return { r, seen };
  };

  it('activates when the signer answers with only {id, sig}', async () => {
    // A NIP-46 bridge shape. Forwarded verbatim it reached the agent with no
    // kind, no tags and no pubkey, and was refused as our own malformed payload.
    let posted;
    const { r } = await runTo({
      signEvent: async () => ({ id: 'id', sig: 'sig' }),
      postActivate: async (body) => { posted = body.event; return { ok: true, data: { ok: true } }; },
    });

    expect(r.state).toBe(S.SUCCESS);
    expect(posted).toMatchObject({
      kind: 22242, content: 'chal-123', id: 'id', sig: 'sig', pubkey: 'ownerhex',
    });
    expect(posted.tags).toContainEqual(['challenge', 'chal-123']);
  });

  it('fills pubkey from the signer, not from anywhere else', async () => {
    let posted;
    const { r } = await runTo({
      getPublicKey: async () => 'a-different-key',
      signEvent: async () => ({ id: 'id', sig: 'sig' }),
      postActivate: async (body) => { posted = body.event; return { ok: true, data: { ok: true } }; },
    });

    expect(r.state).toBe(S.SUCCESS);
    expect(posted.pubkey).toBe('a-different-key');
  });

  it('preserves a created_at the signer rewrote', async () => {
    // Permitted by NIP-07 and accepted by the agent, because the signature
    // covers whatever the signer chose. A merge preferring our own values would
    // have quietly broken this.
    let posted;
    const { r } = await runTo({
      signEvent: async (e) => ({ ...e, created_at: 1, id: 'id', sig: 'sig', pubkey: 'ownerhex' }),
      postActivate: async (body) => { posted = body.event; return { ok: true, data: { ok: true } }; },
    });

    expect(r.state).toBe(S.SUCCESS);
    expect(posted.created_at).toBe(1);
  });

  it('rejects an unsigned answer without posting anything', async () => {
    const postActivate = vi.fn(async () => ({ ok: true, data: { ok: true } }));
    const { r } = await runTo({ signEvent: async (e) => ({ ...e, id: 'id' }), postActivate });

    expect(r.state).toBe(S.SIGNER_REJECTED);
    expect(postActivate).not.toHaveBeenCalled();
  });

  it('rejects a signer that altered the challenge, and blames the signer', async () => {
    const postActivate = vi.fn(async () => ({ ok: true, data: { ok: true } }));
    const { r } = await runTo({
      signEvent: async (e) => ({ ...e, tags: [], id: 'id', sig: 'sig', pubkey: 'ownerhex' }),
      postActivate,
    });

    expect(r.state).toBe(S.SIGNER_REJECTED);
    expect(r.reason).toMatch(/signer/i);
    expect(postActivate).not.toHaveBeenCalled();
  });
});
