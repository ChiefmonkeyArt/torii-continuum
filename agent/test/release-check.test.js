/**
 * release-check.mjs — server-side release-metadata checker (VERSION-UPDATE-1).
 *
 * Covers with NO real network + deterministic clock:
 *   • pickLatest: draft skip, invalid-tag skip, off-channel skip, highest wins
 *   • get(): live success, cache-within-ttl, live refresh after ttl
 *   • back-off after failure within errorTtlMs (no re-hit)
 *   • serve last-good (stale) when live fails; unreachable when never good
 *   • update_available flag reflects semver newer + same channel
 *   • SSRF posture: request pins api.github.com + redirect:'error'
 *   • oversized body rejected by the bounded reader
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseChecker, pickLatest } from '../core/release-check.mjs';

// Minimal Response-like with a byte-cap-friendly streaming body.
function res(status, bodyObj, { chunkBytes } = {}) {
  const text = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const bytes = chunkBytes ? new Uint8Array(chunkBytes) : Buffer.from(text, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: new Uint8Array(bytes) };
          },
          async cancel() {},
        };
      },
    },
    async text() { return text; },
  };
}

function releasesPayload(tags) {
  return tags.map((t) =>
    typeof t === 'string' ? { tag_name: t, draft: false } : t,
  );
}

// ── pickLatest (pure) ────────────────────────────────────────────────

test('pickLatest ignores drafts, invalid tags, off-channel', () => {
  const alpha = (v) => v.includes('-alpha');
  const arr = [
    { tag_name: 'v0.2.70-alpha', draft: true },   // draft skip
    { tag_name: 'not-a-tag', draft: false },       // invalid skip
    { tag_name: 'v0.2.71-beta', draft: false },    // off-channel skip
    { tag_name: 'v0.2.69-alpha', draft: false },
    { tag_name: 'v0.2.68-alpha', draft: false },
  ];
  assert.equal(pickLatest(arr, alpha), 'v0.2.69-alpha');
});

test('pickLatest returns null for non-array / empty', () => {
  assert.equal(pickLatest(null), null);
  assert.equal(pickLatest([]), null);
});

// ── get(): caching + refresh ─────────────────────────────────────────

test('get(): live success then cache within ttl, refresh after ttl', async () => {
  let t = 1_000_000;
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return res(200, releasesPayload(['v0.2.70-alpha', 'v0.2.69-alpha']));
  };
  const rc = createReleaseChecker({
    currentVersion: '0.2.69-alpha',
    fetchImpl,
    now: () => t,
    ttlMs: 1000,
  });

  const a = await rc.get();
  assert.equal(a.source, 'live');
  assert.equal(a.latest, 'v0.2.70-alpha');
  assert.equal(a.update_available, true);
  assert.equal(a.channel, 'alpha');
  assert.equal(calls, 1);

  t += 500; // within ttl → cache
  const b = await rc.get();
  assert.equal(b.source, 'cache');
  assert.equal(calls, 1);

  t += 1000; // past ttl → live again
  const c = await rc.get();
  assert.equal(c.source, 'live');
  assert.equal(calls, 2);
});

test('get(): update_available false when latest not newer', async () => {
  const rc = createReleaseChecker({
    currentVersion: '0.2.70-alpha',
    fetchImpl: async () => res(200, releasesPayload(['v0.2.70-alpha'])),
    now: () => 1,
  });
  const s = await rc.get();
  assert.equal(s.latest, 'v0.2.70-alpha');
  assert.equal(s.update_available, false);
});

test('get(): failure backs off within errorTtlMs, serves last-good stale', async () => {
  let t = 1_000_000;
  let mode = 'ok';
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (mode === 'ok') return res(200, releasesPayload(['v0.2.70-alpha']));
    throw new Error('network down');
  };
  const rc = createReleaseChecker({
    currentVersion: '0.2.69-alpha',
    fetchImpl,
    now: () => t,
    ttlMs: 100,
    errorTtlMs: 1000,
  });

  await rc.get(); // seed last-good
  assert.equal(calls, 1);

  t += 200; // past ttl
  mode = 'fail';
  const stale = await rc.get();
  assert.equal(stale.source, 'cache');
  assert.equal(stale.stale, true);
  assert.equal(stale.latest, 'v0.2.70-alpha');
  assert.equal(calls, 2);

  t += 100; // still within errorTtlMs of the failure → back off, no fetch
  const backoff = await rc.get();
  assert.equal(backoff.stale, true);
  assert.equal(calls, 2);
});

test('get(): unreachable when never succeeded', async () => {
  const rc = createReleaseChecker({
    currentVersion: '0.2.69-alpha',
    fetchImpl: async () => { throw new Error('down'); },
    now: () => 1,
  });
  const s = await rc.get();
  assert.equal(s.source, 'unreachable');
  assert.equal(s.stale, true);
  assert.equal(s.latest, null);
  assert.equal(s.update_available, false);
  assert.equal(s.current, '0.2.69-alpha');
});

test('get(): http error is a failure (not thrown)', async () => {
  const rc = createReleaseChecker({
    currentVersion: '0.2.69-alpha',
    fetchImpl: async () => res(503, undefined),
    now: () => 1,
  });
  const s = await rc.get();
  assert.equal(s.source, 'unreachable');
});

// ── SSRF posture ─────────────────────────────────────────────────────

test('get(): pins api.github.com and refuses redirects', async () => {
  let seenUrl = null;
  let seenOpts = null;
  const rc = createReleaseChecker({
    currentVersion: '0.2.69-alpha',
    owner: 'ChiefmonkeyArt',
    repo: 'torii-continuum',
    fetchImpl: async (url, opts) => {
      seenUrl = url;
      seenOpts = opts;
      return res(200, releasesPayload(['v0.2.70-alpha']));
    },
    now: () => 1,
  });
  await rc.get();
  assert.ok(seenUrl.startsWith('https://api.github.com/repos/ChiefmonkeyArt/torii-continuum/releases'));
  assert.equal(seenOpts.redirect, 'error');
  assert.equal(seenOpts.headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('get(): oversized body rejected → failure', async () => {
  const rc = createReleaseChecker({
    currentVersion: '0.2.69-alpha',
    fetchImpl: async () => res(200, undefined, { chunkBytes: 2048 }),
    now: () => 1,
    maxBytes: 1024,
  });
  const s = await rc.get();
  assert.equal(s.source, 'unreachable');
});

test('latestKnown reflects last-good only', async () => {
  const rc = createReleaseChecker({
    currentVersion: '0.2.69-alpha',
    fetchImpl: async () => res(200, releasesPayload(['v0.2.70-alpha'])),
    now: () => 1,
  });
  assert.equal(rc.latestKnown(), null);
  await rc.get();
  assert.equal(rc.latestKnown(), 'v0.2.70-alpha');
});
