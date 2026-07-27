/**
 * Tests for the direct NIP-07 login flow (AUTH-DIRECT-1).
 *
 * Two layers, both jsdom-free:
 *   1. Pure-function tests for buildLoginEvent + withTimeout (the testable core
 *      of the sign step) — kind/tags/created_at, and resolve/reject/timeout via
 *      an injectable timer.
 *   2. Source-structure assertions proving the flow invokes the extension
 *      directly (no intermediate modal), guards against double invocation,
 *      bounds the signer with a timeout, and surfaces status inline via onStatus.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildLoginEvent, withTimeout } from './auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');

describe('buildLoginEvent (NIP-42 challenge event)', () => {
  it('builds a kind 22242 event carrying the challenge as content', () => {
    const ev = buildLoginEvent('chal-123', 'https://example.test', 1_000_000_000_000);
    expect(ev.kind).toBe(22242);
    expect(ev.content).toBe('chal-123');
  });

  it('tags the challenge and the relay/origin', () => {
    const ev = buildLoginEvent('chal-123', 'https://example.test', 1_000_000_000_000);
    expect(ev.tags).toContainEqual(['challenge', 'chal-123']);
    expect(ev.tags).toContainEqual(['relay', 'https://example.test']);
  });

  it('derives created_at as unix seconds from the supplied ms clock', () => {
    const ev = buildLoginEvent('c', 'o', 1_700_000_000_000);
    expect(ev.created_at).toBe(1_700_000_000);
  });
});

describe('withTimeout', () => {
  it('resolves with the underlying value when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('propagates a rejection from the underlying promise', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  it('rejects with a timeout error when the timer fires first', async () => {
    // Injectable timer that fires immediately, simulating an unanswered signer.
    const immediate = (fn) => { fn(); return 0; };
    const never = new Promise(() => {});
    await expect(withTimeout(never, 5, immediate)).rejects.toThrow('timeout');
  });

  it('does not reject with timeout when the promise already settled', async () => {
    // Timer that never fires — the resolved promise must win.
    const noop = () => 0;
    await expect(withTimeout(Promise.resolve('done'), 5, noop)).resolves.toBe('done');
  });
});

describe('src/auth.js — direct invocation, no modal (source structure)', () => {
  const auth = read('auth.js');

  it('invokes the NIP-07 extension directly via window.nostr.signEvent', () => {
    expect(auth).toContain('window.nostr.signEvent');
  });

  it('does not open or import any intermediate login modal', () => {
    expect(auth).not.toMatch(/openModal|showModal|LoginModal|login-modal/);
  });

  // CONT-LOGIN-1 strengthened this: the old guard was `if (loginInFlight)
  // return;` — a SILENT no-op, which to the operator is a dead button and is
  // the most common way a stalled login is actually experienced. A second
  // click must now always be answered.
  it('answers a click during an in-flight attempt instead of returning silently', () => {
    expect(auth).toContain('loginInFlight');
    expect(auth).not.toMatch(/if \(loginInFlight\) return/);
    expect(auth).toMatch(/if \(loginInFlight\)[\s\S]{0,120}busyStatus\(/);
  });

  it('bounds every stage, not only the signer', () => {
    expect(auth).toContain('STAGE_TIMEOUTS_MS.challenge');
    expect(auth).toContain('STAGE_TIMEOUTS_MS.signer');
    expect(auth).toContain('STAGE_TIMEOUTS_MS.verify');
    expect(auth).toMatch(/withTimeout\(/);
  });

  // The never-wedge guarantee: whatever happens inside an attempt, the absolute
  // deadline releases the latch. Without it the latch is only as reliable as
  // the least reliable thing it awaits — a browser extension.
  it('caps the whole attempt with an absolute deadline that releases the latch', () => {
    expect(auth).toContain('LOGIN_DEADLINE_MS');
    expect(auth).toMatch(/endAttempt\(/);
  });

  it('exports a way out of the human-scale stage', () => {
    expect(auth).toMatch(/export function cancelLogin\(/);
  });

  it('dispatches session-changed only after a verified signature', () => {
    expect(auth).toContain("continuum:session-changed");
    // The verify call and the success dispatch both live in the flow body; the
    // dispatch must come after the verify call (not the leading docstring).
    const verifyIdx = auth.indexOf('await verifyChallenge(signed,');
    const dispatchIdx = auth.lastIndexOf('continuum:session-changed');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(verifyIdx);
  });

  it('surfaces status/errors through an injected onStatus sink (inline)', () => {
    expect(auth).toContain('onStatus');
    expect(auth).toMatch(/say\(/);
  });

  it('handles the missing-signer case with install guidance instead of a modal', () => {
    expect(auth).toContain('signerMissing');
    expect(auth).toMatch(/hasSigner\(\)/);
  });
});
