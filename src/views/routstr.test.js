/**
 * Routstr view — balance-reading contract (CONT-HEALTH-3, v0.2.49-alpha).
 *
 * Regression guard for the v0.2.48 live defect: the Routstr hero showed a green
 * "connected" pill but an em-dash Cashu balance. Root cause was a field-name
 * mismatch — the admin `/api/wallet/balance` route returns `total_sats`, but the
 * poll read `balance_sats`, yielding `undefined` → formatSats() → "—".
 *
 * These are pure-function + source-structure assertions (the repo's tests run
 * without a DOM), mirroring board-structure.test.js.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readBalanceSats } from './routstr.js';

const here = dirname(fileURLToPath(import.meta.url));
const routstrSrc = readFileSync(join(here, 'routstr.js'), 'utf8');

describe('readBalanceSats — resolves the agent balance payload', () => {
  it('prefers total_sats (the real /api/wallet/balance shape)', () => {
    expect(readBalanceSats({ total_sats: 1234, per_mint: {} })).toBe(1234);
  });

  it('accepts total_sats of 0 (a funded-but-empty wallet is not "unknown")', () => {
    expect(readBalanceSats({ total_sats: 0 })).toBe(0);
  });

  it('falls back to balance_sats for onboarding-shaped payloads', () => {
    expect(readBalanceSats({ balance_sats: 42 })).toBe(42);
  });

  it('prefers total_sats over balance_sats when both are present', () => {
    expect(readBalanceSats({ total_sats: 7, balance_sats: 9 })).toBe(7);
  });

  it('returns null when no numeric balance is present (renders as em dash, not 0)', () => {
    expect(readBalanceSats({})).toBeNull();
    expect(readBalanceSats({ total_sats: 'x' })).toBeNull();
    expect(readBalanceSats({ total_sats: null })).toBeNull();
    expect(readBalanceSats(null)).toBeNull();
    expect(readBalanceSats(undefined)).toBeNull();
    expect(readBalanceSats('nope')).toBeNull();
  });
});

describe('routstr.js — balance poll uses the correct field', () => {
  it('reads the balance through readBalanceSats, never the raw balance_sats key', () => {
    expect(routstrSrc).toMatch(/readBalanceSats\(r\.data\)/);
    // The old bug: `cashuBalanceSats: r.data.balance_sats`. Ensure it is gone.
    expect(routstrSrc).not.toMatch(/r\.data\.balance_sats/);
  });

  it('reads the redeemed amount from added_sats (the real /api/wallet/receive shape)', () => {
    expect(routstrSrc).toMatch(/r\.data\?\.added_sats|r\.data\.added_sats/);
    // The old bug read received_sats, which the endpoint never returns.
    expect(routstrSrc).not.toMatch(/received_sats/);
  });

  it('refreshes the balance number in place without a full re-render mid-poll', () => {
    expect(routstrSrc).toMatch(/balanceNumEl/);
  });
});

describe('routstr.js — two matching wallet cards (v0.2.70-alpha)', () => {
  it('renders a Cashu balance card and an NWC wallet card', () => {
    expect(routstrSrc).toMatch(/renderCashuCard/);
    expect(routstrSrc).toMatch(/renderNwcCard/);
  });

  it('lays the two wallet cards out in a matching grid-2 of .card elements', () => {
    // Both cards are built and placed side by side in a grid-2 container.
    expect(routstrSrc).toMatch(/grid-2[\s\S]*renderCashuCard\(c\)[\s\S]*renderNwcCard/);
    expect(routstrSrc).toMatch(/renderCashuCard[\s\S]*class:\s*'card hot'/);
    expect(routstrSrc).toMatch(/renderNwcCard[\s\S]*class:\s*'card'/);
  });

  it('labels card 2 as an NWC wallet, not NIP-60 (the agent has no NIP-60 support)', () => {
    expect(routstrSrc).toContain('NWC wallet');
    // NIP-60 may only appear in an explanatory negative sense, never as a card label.
    expect(routstrSrc).not.toMatch(/text:\s*'NIP-?60/i);
  });

  it('Cashu card exposes a Top Up button that reveals the inline receive form', () => {
    expect(routstrSrc).toContain('Top Up');
    expect(routstrSrc).toMatch(/toggleTopUp\(true\)/);
    expect(routstrSrc).toMatch(/topup-form/);
  });

  it('the inline receive form still POSTs the Cashu token via walletReceive', () => {
    expect(routstrSrc).toMatch(/walletReceive\(tok\)/);
  });

  it('honours the chat dock focus-top-up flag on mount', () => {
    expect(routstrSrc).toContain('continuum.routstr.focusTopUp');
    expect(routstrSrc).toMatch(/maybeFocusTopUp/);
  });

  it('reuses the existing NWC endpoints for status/connect/test/disconnect', () => {
    expect(routstrSrc).toMatch(/nwcStatus/);
    expect(routstrSrc).toMatch(/nwcConnect/);
    expect(routstrSrc).toMatch(/nwcTest/);
    expect(routstrSrc).toMatch(/nwcDisconnect/);
  });
});
