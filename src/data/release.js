/**
 * Pure version-state helpers for the UI (VERSION-UPDATE-1).
 *
 * The agent's GET /api/version endpoint returns a non-secret summary
 * (see agent/core/release-check.mjs):
 *   { ok, current, latest, update_available, channel, checked_at, source, stale }
 *
 * These helpers turn that summary into the small, presentational shape the login
 * card and sidebar render — with NO DOM and NO network, so they are unit-tested
 * under the repo's jsdom-free convention. The agent owns the semver comparison
 * (prerelease-aware, same-channel); the UI never re-derives "newer" from raw
 * tags, it only trusts the server's `update_available` flag.
 */

/** Normalize a version to a single leading `v` for display. */
export function displayVersion(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const bare = v.trim().replace(/^v/, '');
  return `v${bare}`;
}

/**
 * Map an /api/version summary to a UI state.
 * @param {object|null} summary
 * @returns {{state:'current'|'newer'|'unknown', label:string, current:string|null, latest:string|null, stale:boolean}}
 */
export function describeVersionState(summary) {
  const current = displayVersion(summary?.current);
  const latest = displayVersion(summary?.latest);
  const stale = !!summary?.stale;

  // No summary, unreachable check, or no known latest → we can't assert freshness.
  if (!summary || summary.ok === false || summary.source === 'unreachable' || !latest) {
    return {
      state: 'unknown',
      label: 'Latest version unavailable',
      current,
      latest: latest || null,
      stale,
    };
  }

  if (summary.update_available === true) {
    return { state: 'newer', label: `Update available · ${latest}`, current, latest, stale };
  }

  return { state: 'current', label: 'Up to date', current, latest, stale };
}

/**
 * The tag the UI should offer to install, or null when no update is offered.
 * Only ever the server-vetted `latest` and only when update_available — the
 * client never invents or trusts an arbitrary tag.
 * @param {object|null} summary
 * @returns {string|null} v-prefixed tag or null
 */
export function updateTargetTag(summary) {
  if (!summary || summary.update_available !== true) return null;
  return displayVersion(summary.latest);
}
