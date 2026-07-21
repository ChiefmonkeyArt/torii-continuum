/**
 * Re-render-safe Lightning top-up polling (v0.2.89-alpha, Item 1).
 *
 * Field bug (2026-07-20): a Cashu top-up modal hung on "Waiting for payment…"
 * and nginx logged ZERO GET /api/wallet/mint-quote/… calls — the poll interval
 * stopped firing with no trace. The fix hoists the poll onto a module-scope
 * singleton keyed by quote id, so a re-render of the enclosing view can't orphan
 * it, and any orphaned interval self-cancels loudly.
 *
 * The poll tick + scheduler are exported as pure, DOM-free functions so the
 * contract is testable with real timers/fake-timers (the repo runs vitest in the
 * node environment — no jsdom — mirroring routstr.test.js / routstr-usage.test.js).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  topUpSessions,
  createTopUpSession,
  clearTopUpSession,
  topUpPollTick,
  startTopUpPoll,
} from './routstr.js';

const here = dirname(fileURLToPath(import.meta.url));
const routstrSrc = readFileSync(join(here, 'routstr.js'), 'utf8');

const noopLog = () => {};

afterEach(() => {
  // Clear any interval a test left running and empty the singleton.
  for (const id of [...topUpSessions.keys()]) clearTopUpSession(id);
});

describe('topUpPollTick — the single poll iteration', () => {
  it('calls the Cashu status endpoint once with the quote id and counts the attempt', async () => {
    const session = createTopUpSession({ quoteId: 'q-cashu', source: 'cashu' });
    session.pollHandle = 123; // pretend an interval scheduled us
    const statusCashu = vi.fn().mockResolvedValue({ ok: true, data: { paid: false, state: 'UNPAID' } });

    const res = await topUpPollTick(session, 123, { statusCashu, statusNwc: vi.fn(), onPaid: vi.fn(), log: noopLog });

    expect(statusCashu).toHaveBeenCalledTimes(1);
    expect(statusCashu).toHaveBeenCalledWith('q-cashu');
    expect(session.attempt).toBe(1);
    expect(res).toEqual({ ok: true, paid: false });
  });

  it('routes to the NWC status endpoint when the source is nwc', async () => {
    const session = createTopUpSession({ quoteId: 'h-nwc', source: 'nwc' });
    session.pollHandle = 7;
    const statusNwc = vi.fn().mockResolvedValue({ ok: true, data: { paid: false } });
    const statusCashu = vi.fn();

    await topUpPollTick(session, 7, { statusCashu, statusNwc, onPaid: vi.fn(), log: noopLog });

    expect(statusNwc).toHaveBeenCalledWith('h-nwc');
    expect(statusCashu).not.toHaveBeenCalled();
  });

  it('self-cancels and never hits the endpoint when the interval is orphaned', async () => {
    const session = createTopUpSession({ quoteId: 'q-orphan', source: 'cashu' });
    session.pollHandle = 999;                 // the singleton records a DIFFERENT handle
    const statusCashu = vi.fn();
    const log = vi.fn();

    const res = await topUpPollTick(session, 111, { statusCashu, statusNwc: vi.fn(), onPaid: vi.fn(), log });

    expect(res).toEqual({ orphaned: true });
    expect(statusCashu).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[topup] orphaned interval self-cancelled');
  });

  it('self-cancels when the session was cleared out from under it', async () => {
    const session = createTopUpSession({ quoteId: 'q-gone', source: 'cashu' });
    session.pollHandle = 5;
    clearTopUpSession('q-gone');              // e.g. onClose drained the singleton
    const statusCashu = vi.fn();

    const res = await topUpPollTick(session, 5, { statusCashu, statusNwc: vi.fn(), onPaid: vi.fn(), log: noopLog });

    expect(res).toEqual({ orphaned: true });
    expect(statusCashu).not.toHaveBeenCalled();
  });

  it('on paid=true drains the singleton BEFORE onPaid, so a late tick cannot re-mint', async () => {
    const session = createTopUpSession({ quoteId: 'q-paid', source: 'cashu' });
    session.pollHandle = 42;
    let sessionStillLiveDuringOnPaid = true;
    const onPaid = vi.fn(() => { sessionStillLiveDuringOnPaid = topUpSessions.has('q-paid'); });
    const statusCashu = vi.fn().mockResolvedValue({ ok: true, data: { paid: true, new_balance_sats: 1369 } });

    const res = await topUpPollTick(session, 42, { statusCashu, statusNwc: vi.fn(), onPaid, log: noopLog });

    expect(res).toEqual({ paid: true });
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(onPaid).toHaveBeenCalledWith({ paid: true, new_balance_sats: 1369 });
    expect(sessionStillLiveDuringOnPaid).toBe(false); // singleton drained first
    expect(topUpSessions.has('q-paid')).toBe(false);
  });

  it('keeps polling (no self-cancel) on a transient !ok response', async () => {
    const session = createTopUpSession({ quoteId: 'q-transient', source: 'cashu' });
    session.pollHandle = 1;
    const statusCashu = vi.fn().mockResolvedValue({ ok: false, reason: 'offline' });
    const onPaid = vi.fn();

    const res = await topUpPollTick(session, 1, { statusCashu, statusNwc: vi.fn(), onPaid, log: noopLog });

    expect(res).toEqual({ ok: false });
    expect(onPaid).not.toHaveBeenCalled();
    expect(topUpSessions.has('q-transient')).toBe(true); // still live, will poll again
  });
});

describe('startTopUpPoll — scheduled polling over fake time', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires the first status check ~2s after entry', async () => {
    const session = createTopUpSession({ quoteId: 'q-1', source: 'cashu' });
    const statusCashu = vi.fn().mockResolvedValue({ ok: true, data: { paid: false } });
    startTopUpPoll(session, { statusCashu, statusNwc: vi.fn(), onPaid: vi.fn(), log: noopLog }, 2000);

    expect(statusCashu).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(statusCashu).toHaveBeenCalledTimes(1);
    expect(statusCashu).toHaveBeenCalledWith('q-1');
  });

  it('survives a simulated view re-render and keeps polling', async () => {
    const session = createTopUpSession({ quoteId: 'q-2', source: 'cashu' });
    const statusCashu = vi.fn().mockResolvedValue({ ok: true, data: { paid: false } });
    startTopUpPoll(session, { statusCashu, statusNwc: vi.fn(), onPaid: vi.fn(), log: noopLog }, 2000);

    await vi.advanceTimersByTimeAsync(2000);
    expect(statusCashu).toHaveBeenCalledTimes(1);

    // A re-render of the enclosing view rebuilds its closures but must NOT touch
    // the module singleton — the interval id still lives on topUpSessions.
    expect(topUpSessions.get('q-2').pollHandle).not.toBeNull();

    await vi.advanceTimersByTimeAsync(4000);
    expect(statusCashu).toHaveBeenCalledTimes(3); // poll survived, kept firing
  });

  it('mints exactly once when paid arrives on the third tick, then stops polling', async () => {
    const session = createTopUpSession({ quoteId: 'q-3', source: 'cashu' });
    const statusCashu = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { paid: false, state: 'UNPAID' } })
      .mockResolvedValueOnce({ ok: true, data: { paid: false, state: 'UNPAID' } })
      .mockResolvedValue({ ok: true, data: { paid: true, new_balance_sats: 1369 } });
    const onPaid = vi.fn();
    startTopUpPoll(session, { statusCashu, statusNwc: vi.fn(), onPaid, log: noopLog }, 2000);

    await vi.advanceTimersByTimeAsync(6000); // three ticks → paid on the third
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(topUpSessions.has('q-3')).toBe(false);

    const callsAtMint = statusCashu.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000); // no further polls after paid
    expect(statusCashu.mock.calls.length).toBe(callsAtMint);
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it('polls continuously for 30s of unpaid then mints once when paid lands', async () => {
    const session = createTopUpSession({ quoteId: 'q-4', source: 'cashu' });
    let paid = false;
    const statusCashu = vi.fn().mockImplementation(async () => ({ ok: true, data: { paid, state: paid ? 'PAID' : 'UNPAID' } }));
    const onPaid = vi.fn();
    startTopUpPoll(session, { statusCashu, statusNwc: vi.fn(), onPaid, log: noopLog }, 2000);

    await vi.advanceTimersByTimeAsync(30_000); // 15 unpaid ticks, no self-cancel
    expect(statusCashu).toHaveBeenCalledTimes(15);
    expect(onPaid).not.toHaveBeenCalled();
    expect(topUpSessions.has('q-4')).toBe(true);

    paid = true;
    await vi.advanceTimersByTimeAsync(2000); // next tick sees paid
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(topUpSessions.has('q-4')).toBe(false);
  });
});

describe('routstr.js source — poll is bound to the singleton, not a closure', () => {
  it('startPoll creates a module-singleton session and schedules via startTopUpPoll', () => {
    expect(routstrSrc).toMatch(/function startPoll\(id\)/);
    expect(routstrSrc).toMatch(/createTopUpSession\(\{ quoteId: id/);
    expect(routstrSrc).toMatch(/startTopUpPoll\(session,/);
    // The old closure-bound interval must be gone.
    expect(routstrSrc).not.toMatch(/pollHandle = setInterval/);
  });

  it('stopTimers + onClose clear the singleton, not just a local interval', () => {
    expect(routstrSrc).toMatch(/clearTopUpSession\(activeQuoteId\)/);
    expect(routstrSrc).toMatch(/onClose:\s*\(\)\s*=>\s*\{\s*stopTimers\(\)/);
  });

  it('instrumentation is console.info gated on the window debug flag (never console.log)', () => {
    expect(routstrSrc).toMatch(/window\.__TORII_DEBUG_TOPUP__ === true/);
    expect(routstrSrc).toMatch(/\[topup\] poll tick/);
    expect(routstrSrc).toMatch(/\[topup\] poll response/);
    expect(routstrSrc).toMatch(/\[topup\] orphaned interval self-cancelled/);
    expect(routstrSrc).not.toMatch(/console\.log\(/);
  });

  it('honours ?debug=topup and the localStorage flag', () => {
    expect(routstrSrc).toMatch(/debug'\) === 'topup'/);
    expect(routstrSrc).toMatch(/torii\.debug\.topup/);
  });
});
