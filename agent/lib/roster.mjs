/**
 * roster.mjs — owner-signed project roster (TEAMS-2a, slice 1).
 *
 * The single source of truth for "who is on this project, with what role".
 * Chat membership (Cordn), private-repo read access (ngit-grasp
 * NGIT_PRIVATE_MEMBERS) and merge rights (NIP-34 announcement maintainers)
 * are all DERIVED from it — never hand-maintained separately
 * (docs/adr-team-collaboration.md, "One roster, three projections").
 *
 * Event shape (addressable kind 30098, `d` = project slug):
 *   {
 *     kind: 30098,
 *     pubkey: <owner hex>,               // must be the Continuum admin/owner
 *     tags: [
 *       ['d', '<slug>'],
 *       ['p', '<hex>', '<role>'],        // role: maintainer|contributor|viewer
 *       ['p', '<hex>', 'agent', '<human hex>'],  // a clanker, agent-of a human
 *     ],
 *     content: '',
 *   }
 * The owner is implicit (event.pubkey) and never listed in a `p` tag.
 *
 * Trust rules (all fail closed):
 *   • signature verifies (nostr-tools verifyEvent) and the signer IS the owner;
 *     the browser signs via NIP-07/NIP-46 — no private key ever reaches here;
 *   • `d` equals the route slug (no cross-project replay);
 *   • created_at strictly newer than the stored roster (no rollback/replay) and
 *     not more than MAX_FUTURE_SEC ahead of the clock;
 *   • bounded: ≤ MAX_HUMANS humans (owner included) and ≤ MAX_ENTRIES entries;
 *   • no duplicates, no owner in `p`, every agent's human is a listed human
 *     (or the owner) and an agent cannot be agent-of another agent.
 *
 * Agents never merge and never manage the roster: an agent's effective role
 * is min(its human's role, contributor). Removing the human removes the agent
 * (validation rejects a dangling agent-of).
 *
 * Storage: memory/team/<slug>.json, atomic temp+rename at 0600 under 0700.
 * Not relay-published in this slice; the roster is private node state.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';

export const ROSTER_KIND = 30098;
export const MAX_HUMANS = 12; // ADR: small teams, maximum 12 people
export const MAX_ENTRIES = 32; // humans (excl. owner) + agents
export const MAX_FUTURE_SEC = 600;
export const ROLES = Object.freeze(['owner', 'maintainer', 'contributor', 'viewer', 'agent']);
const LISTED_ROLES = new Set(['maintainer', 'contributor', 'viewer']);
const RANK = { viewer: 1, contributor: 2, maintainer: 3, owner: 4 };
const HEX64 = /^[0-9a-f]{64}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

// Capabilities by effective role. 'chat' + 'read' = Cordn member + private
// repo read; 'propose' = push pr/ branches + post patches; 'merge' = listed
// as a repository maintainer; 'manage' = sign roster changes (owner only).
const CAPS = {
  viewer: ['read', 'chat'],
  contributor: ['read', 'chat', 'propose'],
  maintainer: ['read', 'chat', 'propose', 'merge'],
  owner: ['read', 'chat', 'propose', 'merge', 'manage'],
};

function fail(code, reason) {
  return { ok: false, code, reason };
}

/**
 * Pure structural + trust validation. Returns the parsed roster on success.
 * @param {object} event   a signed Nostr event
 * @param {{ownerHex:string, slug:string, now:number, prevCreatedAt?:number}} ctx
 */
/**
 * Rebuild a plain event from the seven NIP-01 fields. This strips extra
 * properties and nostr-tools' cached "verified" symbol (which object spread
 * would otherwise carry onto a tampered copy), so verifyEvent always hashes
 * and checks the bytes actually being stored.
 */
export function canonicalEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const { id, pubkey, created_at, kind, tags, content, sig } = e;
  return { id, pubkey, created_at, kind, tags, content, sig };
}

export function validateRosterEvent(input, ctx) {
  const { ownerHex, slug, now, prevCreatedAt = 0 } = ctx || {};
  const event = canonicalEvent(input);
  if (!HEX64.test(String(ownerHex || ''))) return fail('no_owner', 'owner not configured');
  if (!SLUG_RE.test(String(slug || ''))) return fail('bad_slug', 'bad project slug');
  if (!event || typeof event !== 'object') return fail('bad_event', 'event required');
  if (event.kind !== ROSTER_KIND) return fail('bad_kind', `kind must be ${ROSTER_KIND}`);
  if (!Array.isArray(event.tags)) return fail('bad_event', 'tags must be an array');
  if (event.tags.length > MAX_ENTRIES + 4) return fail('too_many', 'too many tags');
  if (event.pubkey !== ownerHex) return fail('not_owner', 'roster must be signed by the owner');
  if (!Number.isInteger(event.created_at)) return fail('bad_event', 'created_at must be an integer');
  if (event.created_at > now + MAX_FUTURE_SEC) return fail('future', 'created_at too far in the future');
  if (event.created_at <= prevCreatedAt) return fail('stale', 'roster is not newer than the stored one');
  if (typeof event.content !== 'string' || event.content.length > 0) {
    return fail('bad_event', 'content must be empty');
  }
  let sigOk = false;
  try { sigOk = verifyEvent(event); } catch { sigOk = false; }
  if (!sigOk) return fail('bad_sig', 'signature does not verify');

  const dTags = event.tags.filter((t) => Array.isArray(t) && t[0] === 'd');
  if (dTags.length !== 1 || dTags[0][1] !== slug) return fail('bad_d', 'd tag must equal the project slug');

  const members = [];
  const seen = new Set([ownerHex]);
  const humans = new Map([[ownerHex, 'owner']]);
  const agents = [];
  for (const t of event.tags) {
    if (!Array.isArray(t) || t[0] !== 'p') continue;
    const [, pk, role, of] = t;
    if (!HEX64.test(String(pk || ''))) return fail('bad_member', 'p tag pubkey must be 64-hex');
    if (pk === ownerHex) return fail('bad_member', 'owner must not be listed');
    if (seen.has(pk)) return fail('duplicate', 'duplicate member');
    seen.add(pk);
    if (role === 'agent') {
      if (!HEX64.test(String(of || ''))) return fail('bad_member', 'agent needs an agent-of pubkey');
      agents.push({ pubkey: pk, of });
    } else if (LISTED_ROLES.has(role)) {
      humans.set(pk, role);
    } else {
      return fail('bad_role', 'unknown role');
    }
  }
  if (humans.size > MAX_HUMANS) return fail('too_many', `at most ${MAX_HUMANS} people`);
  if (humans.size - 1 + agents.length > MAX_ENTRIES) return fail('too_many', `at most ${MAX_ENTRIES} entries`);
  members.push({ pubkey: ownerHex, role: 'owner' });
  for (const [pk, role] of humans) if (pk !== ownerHex) members.push({ pubkey: pk, role });
  for (const a of agents) {
    if (!humans.has(a.of)) return fail('dangling_agent', 'agent-of must reference a listed human');
    members.push({ pubkey: a.pubkey, role: 'agent', of: a.of });
  }
  return { ok: true, roster: { slug, owner: ownerHex, created_at: event.created_at, id: event.id, members } };
}

/** Effective role: agents get min(human role, contributor). */
export function effectiveRole(roster, pubkey) {
  if (!roster) return null;
  const m = roster.members.find((x) => x.pubkey === pubkey);
  if (!m) return null;
  if (m.role !== 'agent') return m.role;
  const human = roster.members.find((x) => x.pubkey === m.of);
  if (!human) return null;
  return RANK[human.role] >= RANK.contributor ? 'contributor' : 'viewer';
}

/** Capability check: can(roster, pubkey, 'read'|'chat'|'propose'|'merge'|'manage'). */
export function can(roster, pubkey, cap) {
  const role = effectiveRole(roster, pubkey);
  return role ? CAPS[role].includes(cap) : false;
}

/**
 * The three projections. Pure, deterministic (sorted), hex pubkeys.
 *   cordn       — group members (everyone on the roster, agents included)
 *   ngitPrivate — NGIT_PRIVATE_MEMBERS read access (same set)
 *   maintainers — NIP-34 announcement maintainers (owner + maintainers; never agents)
 */
export function project(roster) {
  if (!roster) return { cordn: [], ngitPrivate: [], maintainers: [] };
  const all = roster.members.map((m) => m.pubkey).sort();
  const maintainers = roster.members
    .filter((m) => m.role === 'owner' || m.role === 'maintainer')
    .map((m) => m.pubkey)
    .sort();
  return { cordn: all, ngitPrivate: [...all], maintainers };
}

/**
 * File-backed store. One JSON file per project: { event, roster }.
 * Writes are serialized per process so two PUTs cannot interleave.
 */
export function createRosterStore({ dir, audit = null, now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!dir) throw new Error('roster: dir required');
  let tail = Promise.resolve();
  const file = (slug) => join(dir, `${slug}.json`);

  async function get(slug) {
    if (!SLUG_RE.test(String(slug || ''))) return null;
    try {
      const raw = JSON.parse(await readFile(file(slug), 'utf8'));
      return raw && raw.roster && raw.event ? raw : null;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  function put(slug, event, ownerHex) {
    const run = tail.then(async () => {
      const prev = await get(slug);
      const clean = canonicalEvent(event);
      const v = validateRosterEvent(clean, {
        ownerHex, slug, now: now(), prevCreatedAt: prev?.roster?.created_at ?? 0,
      });
      if (!v.ok) return v;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.${slug}.${randomBytes(6).toString('hex')}.tmp`);
      await writeFile(tmp, JSON.stringify({ event: clean, roster: v.roster }), { mode: 0o600 });
      await rename(tmp, file(slug));
      if (audit) {
        // Public pubkeys + counts only; no content, nothing secret.
        await audit.append('team.roster.set', {
          slug, event_id: clean.id, created_at: clean.created_at, members: v.roster.members.length,
        });
      }
      return { ok: true, roster: v.roster };
    });
    tail = run.catch(() => {});
    return run;
  }

  return { get, put };
}
