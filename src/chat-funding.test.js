/**
 * Chat dock — insufficient-funds detection + top-up path (v0.2.70-alpha).
 *
 * The live bug: a signed-in POST /api/chat can fail with a wallet reason like
 *   "routstr: wallet: insufficient balance across all mints for 50 sats
 *    (need +100 floor); ollama: timeout after 60000ms"
 * The old dock prefixed a mock reply. It now shows "insufficient funds" + a
 * "Top Up" button. `isInsufficientFundsReply` is the pure classifier; the rest
 * are source-structure assertions matching the repo's jsdom-free convention.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isInsufficientFundsReply } from './chat.js';

const here = dirname(fileURLToPath(import.meta.url));
const chatSrc = readFileSync(join(here, 'chat.js'), 'utf8');

describe('isInsufficientFundsReply — structured code path', () => {
  it('matches a top-level result.code === "insufficient_funds"', () => {
    expect(isInsufficientFundsReply({ ok: false, code: 'insufficient_funds' })).toBe(true);
  });

  it('matches a nested result.data.code === "insufficient_funds"', () => {
    expect(isInsufficientFundsReply({ ok: false, data: { code: 'insufficient_funds' } })).toBe(true);
  });

  it('does not match an unrelated structured code', () => {
    expect(isInsufficientFundsReply({ ok: false, code: 'rate_limited' })).toBe(false);
  });
});

describe('isInsufficientFundsReply — reason text fallback', () => {
  it('matches the real agent wallet reason string', () => {
    const reason = 'routstr: wallet: insufficient balance across all mints for 50 sats (need +100 floor); ollama: timeout after 60000ms';
    expect(isInsufficientFundsReply({ ok: false, reason })).toBe(true);
  });

  it('matches the "need +N floor" fragment', () => {
    expect(isInsufficientFundsReply({ ok: false, reason: 'wallet: need +100 floor' })).toBe(true);
  });

  it('matches a hard_floor marker', () => {
    expect(isInsufficientFundsReply({ ok: false, reason: 'blocked by hard_floor guard' })).toBe(true);
  });

  it('matches a bare 402 payment-required marker', () => {
    expect(isInsufficientFundsReply({ ok: false, reason: 'routstr: 402 payment required' })).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isInsufficientFundsReply({ ok: false, reason: 'INSUFFICIENT BALANCE across mints' })).toBe(true);
  });
});

describe('isInsufficientFundsReply — negatives', () => {
  it('does not match an unrelated error reason', () => {
    expect(isInsufficientFundsReply({ ok: false, reason: 'ollama: timeout after 60000ms' })).toBe(false);
  });

  it('does not misfire on "402" embedded in a larger number', () => {
    expect(isInsufficientFundsReply({ ok: false, reason: 'request id 44029 failed' })).toBe(false);
  });

  it('returns false for missing/empty/non-object inputs', () => {
    expect(isInsufficientFundsReply(null)).toBe(false);
    expect(isInsufficientFundsReply(undefined)).toBe(false);
    expect(isInsufficientFundsReply({})).toBe(false);
    expect(isInsufficientFundsReply({ ok: false })).toBe(false);
    expect(isInsufficientFundsReply('insufficient balance')).toBe(false);
  });
});

describe('chat.js — top-up wiring (source structure)', () => {
  it('renders a Top Up button for an insufficient-funds reply, not the generic mock', () => {
    expect(chatSrc).toMatch(/action:\s*'topup'/);
    expect(chatSrc).toMatch(/chat-topup/);
    expect(chatSrc).toContain('Top Up');
  });

  it('navigates to #/routstr and sets the focus-top-up sessionStorage flag', () => {
    expect(chatSrc).toContain('continuum.routstr.focusTopUp');
    expect(chatSrc).toMatch(/window\.location\.hash\s*=\s*'#\/routstr'/);
  });

  it('no longer hardcodes "(mock responses)" in the textarea placeholder attribute', () => {
    expect(chatSrc).not.toMatch(/placeholder="Ask Continuum anything… \(mock responses\)"/);
  });

  it('only advertises mock replies in the placeholder when not live', () => {
    expect(chatSrc).toMatch(/isSessionLive\(\)[\s\S]*mock responses/);
  });
});
