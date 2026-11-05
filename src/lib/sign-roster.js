/**
 * Sign a project roster in the browser (NIP-07 / NIP-46) and hand it to the
 * agent. Shared by the Team page editor and the new-project "Team chat" step.
 * The key never leaves the signer; this only builds and submits the event.
 */
import { buildRosterEvent } from './roster.js';
import { parseNpub } from './npub.js';
import { reconcileSignedEvent } from '../signer-compat.js';

/**
 * @returns {Promise<{ok:true, data:any, event:object}|{ok:false, reason:string, status?:number}>}
 */
export async function signAndPutRoster({ api, signer, slug, rows, ownerHex, previousCreatedAt = 0, now, onStatus = () => {} }) {
  if (!signer || typeof signer.signEvent !== 'function') {
    return { ok: false, reason: 'No Nostr signer found. Connect your signer to sign the roster.' };
  }
  let owner = ownerHex;
  if (!owner) {
    const p = parseNpub((await signer.getPublicKey?.()) || '');
    if (!p.ok) return { ok: false, reason: 'Your signer did not share its public key.' };
    owner = p.hex;
  }
  let built;
  try {
    // The agent refuses a roster that is not newer than the stored one.
    const createdAt = Math.max(now(), previousCreatedAt + 1);
    built = buildRosterEvent(slug, rows.filter((r) => r.npub).map((r) => ({ ...r })), { ownerHex: owner, createdAt });
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  onStatus('Waiting for your signer…');
  let returned;
  try {
    returned = await signer.signEvent(built);
  } catch (e) {
    return { ok: false, reason: `Signing cancelled or failed: ${e?.message || e}` };
  }
  const rec = reconcileSignedEvent(built, returned);
  if (!rec.ok) return { ok: false, reason: 'The signer returned no signature. Nothing was saved.' };
  const event = rec.event;
  if (!event.pubkey) event.pubkey = owner;
  onStatus('Saving…');
  const r = await api.putProjectRoster(slug, event);
  if (!r.ok) return { ok: false, status: r.status, reason: r.status === 409 ? 'stale' : `The agent refused the roster: ${r.reason}` };
  return { ok: true, data: r.data, event };
}
