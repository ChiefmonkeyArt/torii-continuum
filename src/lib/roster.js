/**
 * Team roster builder (TEAMS-2a). Pure — produces the UNSIGNED kind-30098
 * event the owner's NIP-07/NIP-46 signer signs. Mirrors agent/lib/roster.mjs
 * so obviously-bad rosters fail before the signer prompt; the agent remains
 * the authority and re-validates everything.
 */
import { parseNpub, toNpub } from './npub.js';

export const ROSTER_KIND = 30098;
export const MAX_HUMANS = 12;
const LISTED = new Set(['maintainer', 'contributor', 'viewer']);

/**
 * @param {string} slug
 * @param {Array<{npub:string, role:string, of?:string}>} members  owner excluded
 * @param {{ownerHex:string, createdAt?:number}} opts
 */
export function buildRosterEvent(slug, members, { ownerHex, createdAt } = {}) {
  const tags = [['d', slug]];
  const seen = new Set([ownerHex]);
  const humans = new Set([ownerHex]);
  const agents = [];
  for (const m of members || []) {
    const p = parseNpub(m.npub);
    if (!p.ok) throw new Error(`invalid npub: ${p.reason}`);
    if (seen.has(p.hex)) throw new Error(p.hex === ownerHex ? 'owner is implicit' : 'duplicate member');
    seen.add(p.hex);
    if (m.role === 'agent') {
      const of = parseNpub(m.of);
      if (!of.ok) throw new Error('agent needs the npub of its human');
      agents.push(['p', p.hex, 'agent', of.hex]);
    } else if (LISTED.has(m.role)) {
      humans.add(p.hex);
      tags.push(['p', p.hex, m.role]);
    } else {
      throw new Error('unknown role');
    }
  }
  if (humans.size > MAX_HUMANS) throw new Error(`at most ${MAX_HUMANS} people`);
  for (const a of agents) {
    if (!humans.has(a[3])) throw new Error('agent-of must be a listed person');
    tags.push(a);
  }
  return {
    kind: ROSTER_KIND,
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/**
 * Stored roster → editable rows for buildRosterEvent (owner left out: it is
 * implicit). Agents keep their human as `of`. Inverse of buildRosterEvent.
 * @param {{owner:string, members:Array<{pubkey:string, role:string, of?:string}>}|null} roster
 */
export function rosterRows(roster) {
  if (!roster || !Array.isArray(roster.members)) return [];
  return roster.members
    .filter((m) => m.role !== 'owner')
    .map((m) => (m.role === 'agent'
      ? { npub: toNpub(m.pubkey), role: 'agent', of: toNpub(m.of) }
      : { npub: toNpub(m.pubkey), role: m.role }));
}
