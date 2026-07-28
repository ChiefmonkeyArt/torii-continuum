/**
 * The pure half of CONT-SIGNER-1: reconciliation, injection waiting, and the
 * verify-code mapping, tested with no DOM and no network.
 *
 * The load-bearing property is the DIRECTION of reconciliation. It would be very
 * easy to write a merge that prefers our own event — and it would work for the
 * common signer, break a signer that legitimately rewrites created_at, and make
 * a client-side field substitution look like a valid signature to any reader of
 * the code. The tests below pin the direction, not just the outcome.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  reconcileSignedEvent,
  signerAlteredChallenge,
  awaitSigner,
  describeVerifyCode,
  HASHED_FIELDS,
  KNOWN_SIGNERS,
  SIGNER_WAIT_MS,
  SIGNER_POLL_MS,
} from './signer-compat.js';

const CHALLENGE = 'c'.repeat(64);
const PUBKEY = 'a'.repeat(64);
const SIG = 's'.repeat(128);
const ID = 'i'.repeat(64);

const built = () => ({
  kind: 22242,
  created_at: 1_700_000_000,
  content: CHALLENGE,
  tags: [['challenge', CHALLENGE], ['relay', 'https://torii.test']],
});

describe('reconcileSignedEvent', () => {
  it('fills the whole event for a signer that returns only {id, sig}', () => {
    const r = reconcileSignedEvent(built(), { id: ID, sig: SIG });

    expect(r.ok).toBe(true);
    expect(r.event.kind).toBe(22242);
    expect(r.event.created_at).toBe(1_700_000_000);
    expect(r.event.content).toBe(CHALLENGE);
    expect(r.event.tags).toEqual(built().tags);
    expect(r.event.id).toBe(ID);
    expect(r.event.sig).toBe(SIG);
    // pubkey is the one field we never knew, so it is reported, not invented.
    expect(r.missing).toEqual(['pubkey']);
    expect(r.event.pubkey).toBeUndefined();
  });

  it('fills only pubkey for a signer that echoes everything else', () => {
    const r = reconcileSignedEvent(built(), { ...built(), id: ID, sig: SIG });

    expect(r.ok).toBe(true);
    expect(r.filled).toEqual([]);
    expect(r.missing).toEqual(['pubkey']);
  });

  it('leaves a complete answer completely untouched', () => {
    const signed = { ...built(), id: ID, sig: SIG, pubkey: PUBKEY };
    const r = reconcileSignedEvent(built(), signed);

    expect(r.filled).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.event).toEqual(signed);
  });

  it('PREFERS the signer everywhere it expressed an opinion', () => {
    // The direction that matters. A signer may legitimately rewrite created_at,
    // and the agent accepts it because the signature covers whatever the signer
    // chose. Substituting our own value would break a case that works today —
    // and, worse, would put a field on the wire that nothing signed.
    const signerChoice = {
      kind: 22242,
      created_at: 1_699_999_970,
      content: CHALLENGE,
      tags: [['challenge', CHALLENGE], ['relay', 'https://torii.test'], ['extra', '1']],
      pubkey: PUBKEY,
      id: ID,
      sig: SIG,
    };
    const r = reconcileSignedEvent(built(), signerChoice);

    expect(r.event.created_at).toBe(1_699_999_970);
    expect(r.event.tags).toEqual(signerChoice.tags);
    expect(r.filled).toEqual([]);
  });

  it('does not treat a falsy-but-present signer value as a gap', () => {
    const r = reconcileSignedEvent({ ...built(), created_at: 999 }, {
      ...built(), created_at: 0, content: '', id: ID, sig: SIG, pubkey: PUBKEY,
    });

    expect(r.event.created_at).toBe(0);
    expect(r.event.content).toBe('');
    expect(r.filled).toEqual([]);
  });

  it('walks exactly the fields the agent hashes into the id', () => {
    expect([...HASHED_FIELDS].sort())
      .toEqual(['content', 'created_at', 'kind', 'pubkey', 'tags']);
  });

  it('rejects a non-object answer as empty', () => {
    for (const bad of [null, undefined, '', 'signed', 42, true, [1, 2]]) {
      expect(reconcileSignedEvent(built(), bad)).toEqual({ ok: false, kind: 'empty' });
    }
  });

  it('rejects an answer with no signature as unsigned, not as empty', () => {
    // A distinct condition with distinct copy: the signer answered, it just did
    // not sign. Collapsing it into "empty" loses that.
    for (const bad of [{ id: ID }, { id: ID, sig: '' }, { id: ID, sig: 42 }]) {
      expect(reconcileSignedEvent(built(), bad)).toEqual({ ok: false, kind: 'unsigned' });
    }
  });

  it('does not mutate either input', () => {
    const b = built();
    const frozen = Object.freeze({ id: ID, sig: SIG });
    const r = reconcileSignedEvent(b, frozen);

    expect(b).toEqual(built());
    expect(r.event).not.toBe(frozen);
  });
});

describe('signerAlteredChallenge', () => {
  it('accepts an event that still proves the challenge we were given', () => {
    expect(signerAlteredChallenge({ ...built(), pubkey: PUBKEY }, CHALLENGE)).toBe(false);
  });

  it('catches a dropped challenge tag before it reaches the agent', () => {
    // Caught here so the operator is told their SIGNER altered the request. Left
    // to the agent it arrives as "missing challenge tag" — an agent-shaped
    // complaint, with a Retry against a signer that will do it again.
    expect(signerAlteredChallenge({ ...built(), tags: [] }, CHALLENGE)).toBe(true);
    expect(signerAlteredChallenge({ ...built(), tags: undefined }, CHALLENGE)).toBe(true);
  });

  it('catches a rewritten challenge value', () => {
    const tags = [['challenge', 'd'.repeat(64)]];
    expect(signerAlteredChallenge({ ...built(), tags }, CHALLENGE)).toBe(true);
  });

  it('catches content that no longer agrees with the tag', () => {
    expect(signerAlteredChallenge({ ...built(), content: 'other' }, CHALLENGE)).toBe(true);
  });

  it('tolerates empty content, which the agent also tolerates', () => {
    expect(signerAlteredChallenge({ ...built(), content: '' }, CHALLENGE)).toBe(false);
  });

  it('survives a malformed tags array without throwing', () => {
    for (const tags of [[null], ['challenge'], [[]], 'nope']) {
      expect(signerAlteredChallenge({ ...built(), tags }, CHALLENGE)).toBe(true);
    }
  });
});

describe('awaitSigner', () => {
  it('resolves true immediately when the signer is already present', async () => {
    const setTimer = vi.fn();
    await expect(awaitSigner({ hasSigner: () => true, setTimer })).resolves.toBe(true);
    // The common case must not cost a tick, let alone a poll interval.
    expect(setTimer).not.toHaveBeenCalled();
  });

  it('resolves true when the signer is injected late', async () => {
    let present = false;
    setTimeout(() => { present = true; }, 30);

    await expect(awaitSigner({
      hasSigner: () => present, timeoutMs: 400, pollMs: 10,
    })).resolves.toBe(true);
  });

  it('gives up and resolves false once the window closes', async () => {
    await expect(awaitSigner({
      hasSigner: () => false, timeoutMs: 40, pollMs: 10,
    })).resolves.toBe(false);
  });

  it('does not wait at all when the window is zero or negative', async () => {
    const setTimer = vi.fn();
    for (const timeoutMs of [0, -1]) {
      await expect(awaitSigner({ hasSigner: () => false, timeoutMs, setTimer }))
        .resolves.toBe(false);
    }
    expect(setTimer).not.toHaveBeenCalled();
  });

  it('clears its timer on the way out so nothing is left armed', async () => {
    const clearTimer = vi.fn(clearTimeout);
    let present = false;
    setTimeout(() => { present = true; }, 20);

    await awaitSigner({ hasSigner: () => present, timeoutMs: 400, pollMs: 10, clearTimer });
    expect(clearTimer).toHaveBeenCalled();
  });

  it('waits long enough to matter but not long enough to look hung', () => {
    expect(SIGNER_WAIT_MS).toBeGreaterThanOrEqual(1_000);
    expect(SIGNER_WAIT_MS).toBeLessThanOrEqual(3_000);
    expect(SIGNER_POLL_MS).toBeGreaterThan(0);
    expect(SIGNER_POLL_MS).toBeLessThan(SIGNER_WAIT_MS);
  });
});

describe('describeVerifyCode', () => {
  it('separates the refusal a retry cannot fix from the one it can', () => {
    // This is the entire reason the agent grew a code.
    expect(describeVerifyCode('not_owner')).toBe('not_owner');
    expect(describeVerifyCode('challenge_expired')).toBe('challenge_expired');
  });

  it('blames the signer for the shapes only a signer can produce', () => {
    for (const code of ['bad_signature', 'malformed_event', 'wrong_kind']) {
      expect(describeVerifyCode(code)).toBe('signer_incompatible');
    }
  });

  it('falls back to agent_rejected for an older agent that sends no code', () => {
    // Forward compatibility in the other direction: a browser on this release
    // talking to an agent that predates it must behave exactly as before.
    for (const code of [null, undefined, '', 'something_new']) {
      expect(describeVerifyCode(code)).toBe('agent_rejected');
    }
  });
});

describe('KNOWN_SIGNERS', () => {
  it('offers more than one signer, because more than one exists', () => {
    // The previous copy named a single vendor in three places, which told an
    // operator already running a different NIP-07 signer that their setup was
    // unsupported.
    expect(KNOWN_SIGNERS.length).toBeGreaterThan(1);
  });

  it('gives every signer a name and at least one reachable install link', () => {
    for (const s of KNOWN_SIGNERS) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.links.length).toBeGreaterThan(0);
      for (const [label, href] of s.links) {
        expect(label.length).toBeGreaterThan(0);
        expect(href).toMatch(/^https:\/\//);
      }
    }
  });

  it('is frozen, so a caller cannot quietly reorder or extend the advice', () => {
    expect(Object.isFrozen(KNOWN_SIGNERS)).toBe(true);
    expect(() => { KNOWN_SIGNERS.push({}); }).toThrow();
  });
});
