/**
 * Minimal, dependency-free semver parsing + comparison (VERSION-UPDATE-1).
 *
 * Continuum ships v-prefixed semver release tags with a pre-release suffix
 * (e.g. `v0.2.69-alpha`, `v1.0.0`, `v0.2.70-rc.1`). The unattended deploy pin
 * grammar (ops/deploy-unattended.sh CONTINUUM_TAG_RE) is the authority for what
 * is deployable; this module mirrors it and adds an ORDERING so the agent can
 * decide whether a fetched GitHub release is genuinely newer than the running
 * build.
 *
 * Comparison follows semver.org precedence:
 *   1. Compare major, minor, patch numerically.
 *   2. A version WITH a pre-release has LOWER precedence than the same version
 *      without one (1.0.0-alpha < 1.0.0).
 *   3. Pre-release identifiers are compared left-to-right: numeric identifiers
 *      compared numerically, alphanumeric compared lexically (ASCII), numeric
 *      always lower than alphanumeric, and a longer set of identifiers wins when
 *      all preceding ones are equal.
 *
 * Pure + side-effect free so it is unit-tested with `node --test` and reused by
 * release-check.mjs and the /api/version route without any I/O.
 */

// Strict v-prefixed semver with an optional pre-release. Mirrors the ops
// deploy-tag grammar (CONTINUUM_TAG_RE) so anything this accepts as "a version"
// is also a shape the deploy pin will accept. Build metadata (+meta) is not used
// by our tags and is intentionally not accepted.
const TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Parse a version string into structured parts, or null when it does not match
 * the strict grammar. Accepts an optional leading `v`.
 * @param {unknown} input
 * @returns {{major:number,minor:number,patch:number,prerelease:string[],raw:string}|null}
 */
export function parseSemver(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const m = s.match(TAG_RE);
  if (!m) return null;
  const [, maj, min, pat, pre] = m;
  return {
    major: Number(maj),
    minor: Number(min),
    patch: Number(pat),
    prerelease: pre ? pre.split('.') : [],
    raw: s,
  };
}

/** True iff `input` is a valid v-prefixed (or bare) semver string. */
export function isValidSemver(input) {
  return parseSemver(input) !== null;
}

const isNumericId = (id) => /^\d+$/.test(id);

// Compare two pre-release identifier arrays per semver.org §11.4.
function comparePrerelease(a, b) {
  // No pre-release outranks any pre-release (1.0.0 > 1.0.0-alpha).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xn = isNumericId(x);
    const yn = isNumericId(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn) {
      return -1; // numeric identifiers are lower than alphanumeric
    } else if (yn) {
      return 1;
    } else {
      return x < y ? -1 : 1; // ASCII lexical
    }
  }
  // All shared identifiers equal → the longer set has higher precedence.
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Compare two version strings. Returns -1 if a<b, 0 if equal, 1 if a>b.
 * Unparseable inputs sort BELOW any valid version (and equal to each other) so
 * a malformed remote tag can never be judged "newer" than the running build.
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** True iff `candidate` is strictly newer than `current` (both parseable). */
export function isNewer(candidate, current) {
  if (!isValidSemver(candidate) || !isValidSemver(current)) return false;
  return compareSemver(candidate, current) > 0;
}

/**
 * Pick the highest valid version from a list, ignoring anything unparseable.
 * Returns the winning raw string (as supplied), or null when none are valid.
 * @param {Iterable<string>} versions
 * @returns {string|null}
 */
export function maxSemver(versions) {
  let best = null;
  for (const v of versions || []) {
    if (!isValidSemver(v)) continue;
    if (best === null || compareSemver(v, best) > 0) best = v;
  }
  return best;
}
