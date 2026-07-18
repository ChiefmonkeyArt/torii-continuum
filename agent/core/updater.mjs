/**
 * Admin-authenticated self-update request spooler (VERSION-UPDATE-1).
 *
 * PRIVILEGE SEPARATION is the whole point. The agent runs as the unprivileged
 * `continuum` user under a strict systemd sandbox (ProtectSystem=strict; the
 * ONLY writable path is its own memory/ dir). It therefore CANNOT — and must not
 * be able to — edit the root-owned deploy pin (/etc/torii/continuum-deploy.conf)
 * or run the deploy. Instead, an admin POST /api/update writes a single, vetted
 * "update request" file into the agent's writable spool. A separate root-side ops
 * step (ops/apply-update-request.sh, run as ExecStartPre of the deploy service)
 * INDEPENDENTLY re-validates that request and, only if it passes, rewrites the
 * pin's CONTINUUM_TARGET_TAG. The existing hardened deploy service then converges.
 *
 * So this module NEVER executes anything, never touches root-owned files, and
 * never trusts a client-supplied tag beyond what the server itself vetted:
 *   • strict tag grammar (mirrors ops CONTINUUM_TAG_RE),
 *   • must be strictly newer than the running version (semver-aware),
 *   • must be the server-known latest OR appear in the optional allowlist,
 *   • one request in flight at a time (concurrency lock via the spool file).
 *
 * fs is injected so the whole thing is unit-tested against a temp dir with no
 * global mocking.
 */

import { isValidSemver, isNewer } from './semver.mjs';
import { randomBytes } from 'node:crypto';

// Mirrors ops/deploy-unattended.sh CONTINUUM_TAG_RE exactly: a v-prefixed semver
// with an optional pre-release of [0-9A-Za-z.-]. The `v` prefix is REQUIRED here
// (release tags carry it) so the value written for the root applier is the exact
// tag string git resolves.
const UPDATE_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

/** True iff `tag` is a valid, v-prefixed deployable release tag. */
export function isValidUpdateTag(tag) {
  return typeof tag === 'string' && UPDATE_TAG_RE.test(tag);
}

/**
 * Decide whether an admin may queue `tag`, given what the server knows. Pure so
 * the authorization matrix is unit-tested without any I/O.
 * @param {object} p
 * @param {string} p.tag              client-requested tag
 * @param {string} p.currentVersion  running agent version (bare, e.g. 0.2.69-alpha)
 * @param {string|null} p.latestKnown server-vetted latest tag (e.g. v0.2.70-alpha)
 * @param {string[]} [p.allowlist]    optional extra allowed tags
 * @returns {{ok:true}|{ok:false,code:string,reason:string}}
 */
export function authorizeUpdate({ tag, currentVersion, latestKnown, allowlist = [] }) {
  if (!isValidUpdateTag(tag)) {
    return { ok: false, code: 'invalid_tag', reason: 'tag is not a valid vX.Y.Z[-pre] release tag' };
  }
  const bare = tag.replace(/^v/, '');
  if (currentVersion && bare === String(currentVersion).replace(/^v/, '')) {
    return { ok: false, code: 'already_current', reason: 'already running the requested version' };
  }
  if (currentVersion && !isNewer(tag, currentVersion)) {
    // Refuse sidegrades/downgrades: an update must go strictly forward.
    return { ok: false, code: 'not_newer', reason: 'requested tag is not newer than the running version' };
  }
  const allowSet = new Set((allowlist || []).filter(isValidUpdateTag));
  const isLatest = latestKnown && isValidUpdateTag(latestKnown) && tag === latestKnown;
  if (!isLatest && !allowSet.has(tag)) {
    // Never trust an arbitrary client tag: it must be the vetted latest or listed.
    return { ok: false, code: 'not_allowed', reason: 'tag is neither the known latest release nor allowlisted' };
  }
  return { ok: true };
}

/**
 * @param {object} opts
 * @param {string} opts.requestPath  absolute path to the spool file (agent-writable)
 * @param {() => number} [opts.now]   ms clock
 * @param {typeof import('node:fs/promises')} [opts.fs]
 * @param {string[]} [opts.allowlist] optional allowlist of extra deployable tags
 */
export function createUpdater(opts = {}) {
  const requestPath = opts.requestPath;
  if (!requestPath) throw new Error('createUpdater: requestPath required');
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const fs = opts.fs || fsPromisesLazy();
  const allowlist = Array.isArray(opts.allowlist) ? opts.allowlist : [];

  async function readRequest() {
    let raw;
    try {
      raw = await fs.readFile(requestPath, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw e;
    }
    try {
      const j = JSON.parse(raw);
      return j && typeof j === 'object' ? j : null;
    } catch {
      // A corrupt spool file is treated as "a request is present" so we don't
      // silently overwrite something a human may need to inspect; status()
      // surfaces it and cancel() can clear it.
      return { corrupt: true };
    }
  }

  async function status() {
    const req = await readRequest();
    if (!req) return { pending: false };
    if (req.corrupt) return { pending: true, corrupt: true };
    return {
      pending: true,
      tag: req.tag || null,
      from_version: req.from_version || null,
      requested_at: req.requested_at || null,
      requested_by: req.requested_by || null,
    };
  }

  /**
   * Queue an update. Rejects (never throws for expected cases) when the tag is
   * unauthorized or a request is already pending (concurrency lock).
   * @param {object} p
   * @param {string} p.tag
   * @param {string} p.currentVersion
   * @param {string|null} p.latestKnown
   * @param {string} [p.requestedBy] admin npub (non-secret) for the audit trail
   */
  async function request({ tag, currentVersion, latestKnown, requestedBy }) {
    const authz = authorizeUpdate({ tag, currentVersion, latestKnown, allowlist });
    if (!authz.ok) return authz;

    // Concurrency lock: one queued request at a time. A second POST while one is
    // pending is rejected rather than clobbering the first.
    const existing = await readRequest();
    if (existing) {
      return {
        ok: false,
        code: 'pending',
        reason: 'an update is already queued; cancel it before requesting another',
        current: existing.corrupt ? null : existing.tag || null,
      };
    }

    const payload = {
      tag,
      from_version: currentVersion || null,
      requested_at: new Date(now()).toISOString(),
      requested_by: typeof requestedBy === 'string' ? requestedBy : null,
      nonce: randomBytes(8).toString('hex'),
      schema: 1,
    };
    const tmp = `${requestPath}.tmp-${payload.nonce}`;
    // Atomic publish: write a temp file then rename over the spool path so the
    // root applier never reads a half-written request.
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, requestPath);
    return { ok: true, status: 'queued', tag, requested_at: payload.requested_at };
  }

  /** Cancel a queued request (admin). No-op when nothing is pending. */
  async function cancel() {
    try {
      await fs.unlink(requestPath);
      return { ok: true, cancelled: true };
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, cancelled: false };
      throw e;
    }
  }

  return { request, status, cancel, readRequest };
}

// Lazy so importing this module in a pure-logic test (authorizeUpdate /
// isValidUpdateTag) never requires node:fs.
function fsPromisesLazy() {
  let mod = null;
  const load = async () => (mod ||= await import('node:fs/promises'));
  return {
    async readFile(...a) { return (await load()).readFile(...a); },
    async writeFile(...a) { return (await load()).writeFile(...a); },
    async rename(...a) { return (await load()).rename(...a); },
    async unlink(...a) { return (await load()).unlink(...a); },
  };
}
