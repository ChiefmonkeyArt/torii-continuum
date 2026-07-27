import { describe, it, expect } from 'vitest';
import {
  STATES,
  REFRESH_WINDOW_SEC,
  MAX_REFRESH_DELAY_MS,
  classify,
  reduce,
  isAuthorised,
  shouldRefresh,
  msUntilRefresh,
} from './session-state.js';

const NOW = 1_700_000_000;

describe('classify — the clock\'s reading of a token', () => {
  it('no expiry at all is anonymous, not expired', () => {
    // The distinction matters: "never signed in" must not render the same as
    // "your session ended", and only the latter should bounce anybody.
    expect(classify(null, NOW)).toBe(STATES.ANONYMOUS);
    expect(classify(undefined, NOW)).toBe(STATES.ANONYMOUS);
    expect(classify(NaN, NOW)).toBe(STATES.ANONYMOUS);
  });

  it('comfortably-future expiry is active', () => {
    expect(classify(NOW + 3600, NOW)).toBe(STATES.ACTIVE);
  });

  it('inside the refresh window is expiring, and the boundary counts as inside', () => {
    expect(classify(NOW + REFRESH_WINDOW_SEC - 1, NOW)).toBe(STATES.EXPIRING);
    expect(classify(NOW + REFRESH_WINDOW_SEC, NOW)).toBe(STATES.EXPIRING);
    expect(classify(NOW + REFRESH_WINDOW_SEC + 1, NOW)).toBe(STATES.ACTIVE);
  });

  it('expiry exactly now is already expired', () => {
    expect(classify(NOW, NOW)).toBe(STATES.EXPIRED);
    expect(classify(NOW - 1, NOW)).toBe(STATES.EXPIRED);
  });
});

describe('isAuthorised — who may see protected surfaces', () => {
  it('active, expiring and refreshing all grant access', () => {
    // refreshing especially: the token is still good, so tearing the shell
    // down mid-renewal would log the operator out to fix a non-problem.
    expect(isAuthorised(STATES.ACTIVE)).toBe(true);
    expect(isAuthorised(STATES.EXPIRING)).toBe(true);
    expect(isAuthorised(STATES.REFRESHING)).toBe(true);
  });

  it('anonymous and expired do not', () => {
    expect(isAuthorised(STATES.ANONYMOUS)).toBe(false);
    expect(isAuthorised(STATES.EXPIRED)).toBe(false);
  });
});

describe('reduce — transitions', () => {
  it('signing in classifies straight from the new expiry', () => {
    expect(reduce(STATES.ANONYMOUS, { type: 'signed_in', expiresAt: NOW + 3600, now: NOW }))
      .toBe(STATES.ACTIVE);
  });

  it('signing out is unconditional, from any state', () => {
    for (const s of Object.values(STATES)) {
      expect(reduce(s, { type: 'signed_out' })).toBe(STATES.ANONYMOUS);
    }
  });

  it('a tick walks active → expiring → expired as the clock moves', () => {
    const exp = NOW + 3600;
    expect(reduce(STATES.ACTIVE, { type: 'tick', expiresAt: exp, now: NOW })).toBe(STATES.ACTIVE);
    expect(reduce(STATES.ACTIVE, { type: 'tick', expiresAt: exp, now: exp - 60 })).toBe(STATES.EXPIRING);
    expect(reduce(STATES.EXPIRING, { type: 'tick', expiresAt: exp, now: exp + 1 })).toBe(STATES.EXPIRED);
  });

  it('a tick during a refresh does not disturb it', () => {
    // The renewal owns the state until it resolves; re-classifying underneath
    // it would race the response.
    const exp = NOW + 60;
    expect(reduce(STATES.REFRESHING, { type: 'tick', expiresAt: exp, now: NOW }))
      .toBe(STATES.REFRESHING);
  });

  it('but a token that dies mid-refresh really is expired', () => {
    // Holding "refreshing" here would leave the shell showing protected data
    // it can no longer fetch.
    expect(reduce(STATES.REFRESHING, { type: 'tick', expiresAt: NOW - 1, now: NOW }))
      .toBe(STATES.EXPIRED);
  });

  it('refresh_started only applies to a live session', () => {
    expect(reduce(STATES.EXPIRING, { type: 'refresh_started' })).toBe(STATES.REFRESHING);
    expect(reduce(STATES.ACTIVE, { type: 'refresh_started' })).toBe(STATES.REFRESHING);
    // Nothing to renew — the caller is confused, so the state is left alone.
    expect(reduce(STATES.EXPIRED, { type: 'refresh_started' })).toBe(STATES.EXPIRED);
    expect(reduce(STATES.ANONYMOUS, { type: 'refresh_started' })).toBe(STATES.ANONYMOUS);
  });

  it('a successful refresh returns to active on the NEW expiry', () => {
    expect(reduce(STATES.REFRESHING, { type: 'refresh_ok', expiresAt: NOW + 86400, now: NOW }))
      .toBe(STATES.ACTIVE);
  });

  it('max_lifetime_reached is terminal — the owner must sign again', () => {
    // The agent will not renew this lineage again, so staying "expiring" would
    // just retry forever against a permanent no.
    expect(reduce(STATES.REFRESHING, {
      type: 'refresh_failed', code: 'max_lifetime_reached', expiresAt: NOW + 60, now: NOW,
    })).toBe(STATES.EXPIRED);
  });

  it('a transport failure keeps the still-valid session alive', () => {
    // A flaky network is not a reason to throw somebody out of their work.
    expect(reduce(STATES.REFRESHING, {
      type: 'refresh_failed', code: 'offline', expiresAt: NOW + 60, now: NOW,
    })).toBe(STATES.EXPIRING);
  });

  it('a failure after the token has already died is expired', () => {
    expect(reduce(STATES.REFRESHING, {
      type: 'refresh_failed', code: 'offline', expiresAt: NOW - 1, now: NOW,
    })).toBe(STATES.EXPIRED);
  });

  it('an unknown event is a no-op rather than a reset', () => {
    expect(reduce(STATES.ACTIVE, { type: 'nonsense' })).toBe(STATES.ACTIVE);
    expect(reduce(STATES.ACTIVE, null)).toBe(STATES.ACTIVE);
    expect(reduce(STATES.ACTIVE, {})).toBe(STATES.ACTIVE);
  });
});

describe('shouldRefresh — exactly one state asks for a renewal', () => {
  it('only expiring', () => {
    expect(shouldRefresh(STATES.EXPIRING)).toBe(true);
    // active would renew on a loop; refreshing already is one.
    expect(shouldRefresh(STATES.ACTIVE)).toBe(false);
    expect(shouldRefresh(STATES.REFRESHING)).toBe(false);
    expect(shouldRefresh(STATES.EXPIRED)).toBe(false);
    expect(shouldRefresh(STATES.ANONYMOUS)).toBe(false);
  });
});

describe('msUntilRefresh — scheduling math', () => {
  it('nothing to wait for without a session, or after one ends', () => {
    expect(msUntilRefresh(null, NOW)).toBeNull();
    expect(msUntilRefresh(NOW - 1, NOW)).toBeNull();
  });

  it('due immediately once inside the window', () => {
    expect(msUntilRefresh(NOW + REFRESH_WINDOW_SEC - 1, NOW)).toBe(0);
  });

  it('aims at the moment the window opens', () => {
    // 10 minutes of life, 5-minute window → wake in 5 minutes.
    const exp = NOW + 600;
    expect(msUntilRefresh(exp, NOW)).toBe((600 - REFRESH_WINDOW_SEC) * 1000);
  });

  it('never sleeps longer than the cap, however long the token lives', () => {
    // A tab left open overnight should not stake its session on one timer
    // surviving a laptop suspend.
    expect(msUntilRefresh(NOW + 86400, NOW)).toBe(MAX_REFRESH_DELAY_MS);
    expect(msUntilRefresh(NOW + 7 * 86400, NOW)).toBe(MAX_REFRESH_DELAY_MS);
  });

  it('the cap is below a default 24h TTL, so long sessions get re-checked', () => {
    expect(MAX_REFRESH_DELAY_MS).toBeLessThan(86400 * 1000);
  });

  it('the refresh window is comfortably longer than a slow request', () => {
    // The browser chat deadline is 115s (CONT-TIMEOUT-1); a renewal must have
    // room to fail and be retried before the token actually dies.
    expect(REFRESH_WINDOW_SEC * 1000).toBeGreaterThan(115_000 * 2);
  });
});
