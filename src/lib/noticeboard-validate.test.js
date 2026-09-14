/**
 * FE-08 — the frontend noticeboard validator gates the signature.
 *
 * The review/sign surface must refuse to sign a malformed or generic
 * (non-noticeboard) draft. These tests pin `validateNoticeboardEvent` to the
 * same kind + `d` tag + content invariant the agent's `noticeboard-contract`
 * enforces, so a malformed draft can never reach `window.nostr.signEvent`.
 */
import { describe, it, expect } from 'vitest';
import { validateNoticeboardEvent, NOTICEBOARD_KIND, NOTICEBOARD_D } from './noticeboard-validate.js';

function goodEvent(overrides = {}) {
  return {
    kind: NOTICEBOARD_KIND,
    created_at: 1700000000,
    tags: [['d', NOTICEBOARD_D]],
    content: JSON.stringify({
      version: 1,
      updated_at: 1700000000,
      notices: [{ kind: 'notice', title: 'Hello' }],
    }),
    ...overrides,
  };
}

describe('validateNoticeboardEvent', () => {
  it('accepts a well-formed noticeboard draft', () => {
    expect(validateNoticeboardEvent(goodEvent())).toEqual({ ok: true });
  });

  it('rejects a non-noticeboard kind (generic shelf draft)', () => {
    const r = validateNoticeboardEvent(goodEvent({ kind: 1 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/kind 30078/);
  });

  it('rejects a missing or wrong d tag', () => {
    expect(validateNoticeboardEvent(goodEvent({ tags: [] })).ok).toBe(false);
    expect(validateNoticeboardEvent(goodEvent({ tags: [['d', 'something-else']] })).ok).toBe(false);
    expect(validateNoticeboardEvent(goodEvent({ tags: [['d', NOTICEBOARD_D], ['d', NOTICEBOARD_D]] })).ok).toBe(false);
  });

  it('rejects non-JSON content', () => {
    expect(validateNoticeboardEvent(goodEvent({ content: 'not json' })).ok).toBe(false);
  });

  it('rejects content with no notices array', () => {
    expect(validateNoticeboardEvent(goodEvent({ content: JSON.stringify({ nope: true }) })).ok).toBe(false);
    expect(validateNoticeboardEvent(goodEvent({ content: JSON.stringify({ notices: [] }) })).ok).toBe(false);
  });

  it('rejects a malformed notice (missing title / bad price / bad date)', () => {
    const badTitle = { notices: [{ kind: 'notice', title: '   ' }] };
    expect(validateNoticeboardEvent(goodEvent({ content: JSON.stringify(badTitle) })).ok).toBe(false);

    const badPrice = { notices: [{ kind: 'notice', title: 'x', price_sats: -5 }] };
    expect(validateNoticeboardEvent(goodEvent({ content: JSON.stringify(badPrice) })).ok).toBe(false);

    const badDate = { notices: [{ kind: 'notice', title: 'x', starts_at: 'garbage' }] };
    expect(validateNoticeboardEvent(goodEvent({ content: JSON.stringify(badDate) })).ok).toBe(false);
  });

  it('rejects a missing created_at', () => {
    const ev = goodEvent();
    delete ev.created_at;
    expect(validateNoticeboardEvent(ev).ok).toBe(false);
  });

  it('accepts a valid notice with price, body, url and dates', () => {
    const ev = goodEvent({
      content: JSON.stringify({
        version: 1,
        updated_at: 1700000000,
        notices: [{
          kind: 'auction', title: 'Auction', body: 'details',
          price_sats: 2100, url: 'https://example.com/x',
          starts_at: 1700000000, ends_at: 1700010000,
        }],
      }),
    });
    expect(validateNoticeboardEvent(ev)).toEqual({ ok: true });
  });
});