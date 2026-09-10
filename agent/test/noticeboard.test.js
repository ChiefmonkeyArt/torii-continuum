/**
 * NAP-BRIDGE-8 — noticeboard composer unit tests.
 *
 * Covers the pure write-side helpers that turn a raw notices list into an
 * unsigned kind-30078 d="noticeboard" event. No signing, no relay, no network:
 * these are the structural gates that keep a malformed board out of the relay.
 *
 * Run:  node --test test/noticeboard.test.js   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeNotices,
  buildNoticeboardEvent,
  composeNoticeboard,
} from '../core/noticeboard.mjs';
import { NOTICEBOARD_KIND, NOTICEBOARD_D, MAX_NOTICES } from '../core/noticeboard-contract.mjs';

test('normalizeNotices accepts well-formed notices and fills defaults', () => {
  const out = normalizeNotices([
    { title: 'Sticker pack', kind: 'auction', price_sats: 21, url: 'https://a/1' },
    { title: 'Skin' },                        // no kind -> "notice"
    { title: 'Kitsune', body: 'a fox skin' },
  ]);
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { kind: 'auction', title: 'Sticker pack', price_sats: 21, url: 'https://a/1' });
  assert.deepEqual(out[1], { kind: 'notice', title: 'Skin' });
  assert.deepEqual(out[2], { kind: 'notice', title: 'Kitsune', body: 'a fox skin' });
});

test('normalizeNotices rejects a non-array, empty-title, bad-kind-null, bad-price', () => {
  assert.equal(normalizeNotices(null), null);
  assert.equal(normalizeNotices('nope'), null);
  assert.equal(normalizeNotices([{ title: '  ' }]), null);        // blank title
  assert.equal(normalizeNotices([{}]), null);                      // missing title
  assert.equal(normalizeNotices([{ title: 'x', price_sats: -1 }]), null);
  assert.equal(normalizeNotices([{ title: 'x', price_sats: 'NaN' }]), null);
  assert.equal(normalizeNotices([42]), null);                      // non-object element
});

test('normalizeNotices enforces the notice cap and coerces unknown kinds to notice', () => {
  const over = normalizeNotices(Array.from({ length: MAX_NOTICES + 1 }, (_, i) => ({ title: `n${i}` })));
  assert.equal(over, null);
  const coerced = normalizeNotices([{ title: 'x', kind: 'banana' }]);
  assert.equal(coerced[0].kind, 'notice');
});

test('buildNoticeboardEvent emits kind 30078 with the d tag and versioned JSON', () => {
  const ev = buildNoticeboardEvent([{ kind: 'sale', title: 'Skin', price_sats: 500 }], { createdAt: 1730000000 });
  assert.equal(ev.kind, NOTICEBOARD_KIND);
  assert.equal(ev.created_at, 1730000000);
  assert.deepEqual(ev.tags, [['d', NOTICEBOARD_D]]);
  const parsed = JSON.parse(ev.content);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.updated_at, 1730000000);
  assert.deepEqual(parsed.notices, [{ kind: 'sale', title: 'Skin', price_sats: 500 }]);
});

test('composeNoticeboard returns ok+event or ok=false with a reason', () => {
  const good = composeNoticeboard([{ title: 'A' }], { createdAt: 1 });
  assert.equal(good.ok, true);
  assert.equal(good.event.kind, NOTICEBOARD_KIND);

  const bad = composeNoticeboard([{}], { createdAt: 1 });
  assert.equal(bad.ok, false);
  assert.ok(bad.reason.length > 0);
});