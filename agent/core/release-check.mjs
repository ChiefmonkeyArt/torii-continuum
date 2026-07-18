/**
 * Server-side release-metadata checker (VERSION-UPDATE-1).
 *
 * Answers one question for the UI: "is there a newer Continuum release than the
 * one this agent is running?" — WITHOUT ever blocking login and WITHOUT trusting
 * arbitrary client input. The browser cannot query GitHub with the correct
 * caching/rate-limiting/SSRF posture, so the agent owns the check and exposes a
 * tiny, non-secret summary at GET /api/version.
 *
 * Guarantees:
 *   • Cached: a successful lookup is reused for `ttlMs` (default 15 min) so a
 *     dashboard full of pollers hits GitHub at most once per window.
 *   • Rate-limited / fail-soft: a failed lookup is negative-cached for
 *     `errorTtlMs` (default 60 s) and the LAST GOOD result keeps being served
 *     (flagged `stale`). GitHub/network failure NEVER throws to the caller — the
 *     login page always renders, showing at least the current version.
 *   • SSRF-hardened: the request is pinned to https://api.github.com, refuses
 *     redirects, times out, and reads a bounded number of bytes.
 *   • Correct ordering: prerelease-aware semver decides "newer" (see semver.mjs);
 *     draft/unparseable tags are ignored.
 *
 * Factory-injected fetch/now/clock so the whole thing is unit-tested with no
 * network and deterministic time.
 */

import { isValidSemver, isNewer, maxSemver, compareSemver } from './semver.mjs';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const DEFAULT_OWNER = 'ChiefmonkeyArt';
const DEFAULT_REPO = 'torii-continuum';

/**
 * @param {object} opts
 * @param {string} opts.currentVersion  running agent version (from package.json)
 * @param {string} [opts.owner]
 * @param {string} [opts.repo]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]      ms clock (Date.now)
 * @param {number} [opts.ttlMs]          success cache TTL (default 900000 = 15m)
 * @param {number} [opts.errorTtlMs]     failure back-off (default 60000 = 60s)
 * @param {number} [opts.timeoutMs]      per-request timeout (default 5000)
 * @param {number} [opts.maxBytes]       response read cap (default 512 KiB)
 * @param {(v:string)=>boolean} [opts.channelFilter] keep only tags on the
 *        running channel (default: same prerelease channel, e.g. `-alpha`)
 */
export function createReleaseChecker(opts = {}) {
  const currentVersion = String(opts.currentVersion || '').trim();
  const owner = sanitizeSlug(opts.owner) || DEFAULT_OWNER;
  const repo = sanitizeSlug(opts.repo) || DEFAULT_REPO;
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const ttlMs = numOr(opts.ttlMs, 15 * 60 * 1000);
  const errorTtlMs = numOr(opts.errorTtlMs, 60 * 1000);
  const timeoutMs = numOr(opts.timeoutMs, 5000);
  const maxBytes = numOr(opts.maxBytes, 512 * 1024);
  const channelFilter =
    typeof opts.channelFilter === 'function' ? opts.channelFilter : defaultChannelFilter(currentVersion);

  // { latest, checkedAt } once we have ANY good answer; kept and re-served stale.
  let lastGood = null;
  // Timestamp of the most recent attempt (success OR failure) for back-off.
  let lastAttemptAt = 0;
  let lastAttemptOk = false;
  let inFlight = null;

  const releasesUrl = `${GITHUB_API_ORIGIN}/repos/${owner}/${repo}/releases?per_page=30`;

  function summary(source, stale) {
    const latest = lastGood?.latest || null;
    const update_available = !!(latest && isNewer(latest, currentVersion));
    return {
      ok: true,
      current: currentVersion || null,
      latest,
      update_available,
      channel: channelOf(currentVersion),
      checked_at: lastGood ? new Date(lastGood.checkedAt).toISOString() : null,
      source, // 'cache' | 'live' | 'unreachable'
      stale: !!stale,
    };
  }

  async function fetchLatest() {
    if (!fetchImpl) return { ok: false, reason: 'no-fetch' };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(releasesUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'torii-continuum-agent',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error', // SSRF guard: never follow a redirect off api.github.com
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, reason: e?.name === 'AbortError' ? 'timeout' : 'network' };
    }
    clearTimeout(timer);
    if (!res || !res.ok) return { ok: false, reason: `http ${res?.status ?? 0}` };

    let text;
    try {
      text = await readBounded(res, maxBytes);
    } catch {
      return { ok: false, reason: 'oversized' };
    }
    let arr;
    try {
      arr = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'bad-json' };
    }
    const latest = pickLatest(arr, channelFilter);
    return { ok: true, latest };
  }

  /**
   * Return the cached summary, refreshing in the background window rules:
   *   • fresh success within ttlMs        → serve cache
   *   • no data / expired / failed recently but past errorTtlMs → attempt live
   *   • live failure                       → serve last-good (stale) or unreachable
   */
  async function get() {
    const t = now();
    const haveFresh = lastGood && lastAttemptOk && t - lastGood.checkedAt < ttlMs;
    if (haveFresh) return summary('cache', false);

    // Back off after a recent failure so we don't hammer GitHub while it's down.
    const backingOff = !lastAttemptOk && lastAttemptAt && t - lastAttemptAt < errorTtlMs;
    if (backingOff) {
      return lastGood ? summary('cache', true) : summary('unreachable', true);
    }

    if (!inFlight) {
      inFlight = fetchLatest().finally(() => {
        inFlight = null;
      });
    }
    const r = await inFlight;
    lastAttemptAt = now();
    lastAttemptOk = r.ok;
    if (r.ok) {
      lastGood = { latest: r.latest, checkedAt: lastAttemptAt };
      return summary('live', false);
    }
    return lastGood ? summary('cache', true) : summary('unreachable', true);
  }

  /**
   * The set of tags currently considered installable-and-newer. Used by the
   * updater to reject a client-supplied tag that is not the vetted latest.
   * @returns {string|null}
   */
  function latestKnown() {
    return lastGood?.latest || null;
  }

  return { get, latestKnown, _peek: () => ({ lastGood, lastAttemptOk, lastAttemptAt }) };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function numOr(v, d) {
  return Number.isFinite(v) && v > 0 ? v : d;
}

function sanitizeSlug(s) {
  if (typeof s !== 'string') return '';
  // GitHub owner/repo: letters, digits, dot, underscore, dash only.
  return /^[A-Za-z0-9._-]+$/.test(s) ? s : '';
}

function channelOf(version) {
  const dash = String(version || '').indexOf('-');
  if (dash === -1) return 'stable';
  return String(version).slice(dash + 1).split('.')[0] || 'stable';
}

// Only surface releases on the SAME channel as the running build, so an operator
// on `-alpha` is never nudged to a `-beta`/stable line that may be incompatible.
// A stable build (no pre-release) only sees other stable releases.
function defaultChannelFilter(currentVersion) {
  const ch = channelOf(currentVersion);
  return (v) => channelOf(v) === ch;
}

/**
 * Choose the highest valid, non-draft, non-prerelease-flagged-out release tag on
 * the running channel from a GitHub /releases array. Pure + exported for tests.
 * @param {any} releases parsed /releases response
 * @param {(v:string)=>boolean} channelFilter
 * @returns {string|null}
 */
export function pickLatest(releases, channelFilter = () => true) {
  if (!Array.isArray(releases)) return null;
  const tags = [];
  for (const r of releases) {
    if (!r || typeof r !== 'object') continue;
    if (r.draft === true) continue; // never offer a draft
    const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : '';
    if (!isValidSemver(tag)) continue;
    if (!channelFilter(tag)) continue;
    tags.push(tag);
  }
  return maxSemver(tags);
}

async function readBounded(res, maxBytes) {
  // Prefer the streaming body so an oversized payload is rejected without
  // buffering it all. Falls back to text() when no reader is available.
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text();
    if (Buffer.byteLength(t) > maxBytes) throw new Error('oversized');
    return t;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error('oversized');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export { compareSemver };
