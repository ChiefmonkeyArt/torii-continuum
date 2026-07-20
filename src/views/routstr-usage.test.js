/**
 * Routstr — Live Usage Stats poll (v0.2.86-alpha, Item 6).
 *
 * The usage card refreshes its counters in place on a 5s poll that is gated by
 * document.visibilityState === 'visible' AND the view still being mounted, with
 * an immediate refresh when the tab becomes visible again. Changed cells flash
 * the accent colour for 200ms; the interval + visibilitychange listener are
 * cleaned up on unmount.
 *
 * usageSnapshot / applyUsage are the testable core (pure + DOM-diff); the poll
 * gating + cleanup wiring is asserted against the source (the repo runs vitest
 * in the node environment, mirroring routstr.test.js).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { usageSnapshot, applyUsage } from './routstr.js';

const here = dirname(fileURLToPath(import.meta.url));
const routstrSrc = readFileSync(join(here, 'routstr.js'), 'utf8');

// A minimal value-cell shim: just the surface applyUsage/flashCell touch.
function cell(text = '') {
  return { textContent: text, isConnected: true, style: {} };
}
function makeEls(snap) {
  return {
    requests24h: cell(snap.requests24h),
    satsSpent: cell(snap.satsSpent),
    tokensIn: cell(snap.tokensIn),
    tokensOut: cell(snap.tokensOut),
    budget: cell(snap.budget),
  };
}

describe('usageSnapshot — display strings + budget percentage', () => {
  it('formats each counter and computes the budget pct', () => {
    const snap = usageSnapshot({ requests24h: 5, satsSpent: 100, tokensIn: 1000, tokensOut: 2000, monthlyBudget: 1000 });
    expect(snap).toEqual({
      requests24h: '5',
      satsSpent: '100 sats',
      tokensIn: '1000',
      tokensOut: '2000',
      budget: '100 / 1000 sats',
      pct: 10,
    });
  });

  it('caps pct at 100 and treats a zero/absent budget as 0%', () => {
    expect(usageSnapshot({ satsSpent: 5000, monthlyBudget: 1000 }).pct).toBe(100);
    expect(usageSnapshot({ satsSpent: 10, monthlyBudget: 0 }).pct).toBe(0);
    expect(usageSnapshot({}).pct).toBe(0);
  });

  it('defaults missing counters to zero', () => {
    const snap = usageSnapshot({});
    expect(snap.requests24h).toBe('0');
    expect(snap.tokensIn).toBe('0');
  });
});

describe('applyUsage — diff-and-flash only the cells that changed', () => {
  it('updates only changed cells, flashes them, and sets the bar width', () => {
    const prev = usageSnapshot({ requests24h: 1, satsSpent: 10, tokensIn: 5, tokensOut: 6, monthlyBudget: 100 });
    const els = makeEls(prev);
    const bar = { isConnected: true, style: {} };
    const flash = vi.fn();

    const next = usageSnapshot({ requests24h: 2, satsSpent: 10, tokensIn: 5, tokensOut: 6, monthlyBudget: 100 });
    const changed = applyUsage(els, bar, next, flash);

    expect(changed).toEqual(['requests24h']);
    expect(els.requests24h.textContent).toBe('2');
    expect(els.satsSpent.textContent).toBe('10 sats'); // unchanged
    expect(flash).toHaveBeenCalledTimes(1);
    expect(flash).toHaveBeenCalledWith(els.requests24h);
    expect(bar.style.width).toBe(next.pct + '%');
  });

  it('skips cells that are no longer connected (view unmounted mid-poll)', () => {
    const els = makeEls(usageSnapshot({ requests24h: 1 }));
    els.requests24h.isConnected = false;
    const flash = vi.fn();
    const changed = applyUsage(els, null, usageSnapshot({ requests24h: 99 }), flash);
    expect(changed).not.toContain('requests24h');
    expect(flash).not.toHaveBeenCalled();
  });
});

describe('applyUsage — the 200ms accent flash reverts (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sets accent immediately then eases back to the base colour after 200ms', () => {
    const els = makeEls(usageSnapshot({ requests24h: 1 }));
    els.requests24h.style.color = 'var(--ink-hi)';
    // Default flash (no injection) exercises the real flashCell timing.
    applyUsage(els, null, usageSnapshot({ requests24h: 2 }));

    expect(els.requests24h.style.color).toBe('var(--accent)');
    expect(els.requests24h.style.transition).toBe('color 200ms ease');
    vi.advanceTimersByTime(200);
    expect(els.requests24h.style.color).toBe('var(--ink-hi)');
  });
});

describe('routstr.js source — poll is 5s, visibility+mount gated, and cleaned up', () => {
  it('polls every 5000ms', () => {
    expect(routstrSrc).toMatch(/const USAGE_POLL_MS = 5000/);
    expect(routstrSrc).toMatch(/setInterval\(usageTick, USAGE_POLL_MS\)/);
  });

  it('gates the tick on tab visibility and view mount', () => {
    expect(routstrSrc).toMatch(/document\.visibilityState !== 'visible'/);
    expect(routstrSrc).toMatch(/usageMount\.isConnected === false/);
  });

  it('refreshes immediately when the tab becomes visible', () => {
    expect(routstrSrc).toMatch(/addEventListener\('visibilitychange', usageVisibilityHandler\)/);
    expect(routstrSrc).toMatch(/document\.visibilityState === 'visible'\) usageTick\(\)/);
  });

  it('cleans up the interval and the listener on stop/unmount', () => {
    expect(routstrSrc).toMatch(/clearInterval\(usagePollHandle\)/);
    expect(routstrSrc).toMatch(/removeEventListener\('visibilitychange', usageVisibilityHandler\)/);
    // The render wires start on live and stop otherwise.
    expect(routstrSrc).toMatch(/startBalancePoll\(mount\); startUsagePoll\(mount\)/);
    expect(routstrSrc).toMatch(/stopBalancePoll\(\); stopUsagePoll\(\)/);
  });
});
