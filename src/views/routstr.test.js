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
