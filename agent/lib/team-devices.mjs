/**
 * team-devices.mjs: "Your computers" (torii-teams ADR 0016; docs/adr-fips-default.md §3, §5).
 *
 * Each person on a project signs one note listing up to 3 of their own FIPS
 * computers (kind 27531, t=torii-teams-devices, content {v:1, devices:[{npub,
 * label}]}). It is the full list: removing one is signing the list without it.
 *
 * The agent also writes memory/teams/mesh.json for root: every project's
 * owner-signed roster, the owner-signed invite grants of people who joined by
 * link, and the notes of people still on a project. Root (Suite `torii-teams
 * sync`) checks every signature itself, so nothing here is trusted by root.
 *
 * Storage: memory/teams/devices.json and mesh.json, 0600, atomic temp+rename,
 * one writer at a time. mesh.json is rewritten only when its bytes change, so
 * root's path unit fires only on a real change.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { canonicalEvent } from './roster.mjs';

export const DEVICE_KIND = 27531;
export const DEVICE_TAG = 'torii-teams-devices';
export const MAX_DEVICES = 3;
export const MAX_LABEL = 32;
export const MAX_SKEW_SEC = 600;
const MAX_CONTENT = 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const NPUB = /^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/;
const LABEL = /^[^\p{C}]*$/u;

const fail = (code, reason) => ({ ok: false, code, reason });

function npubOk(n) {
  if (!NPUB.test(String(n || ''))) return false;
  try { return nip19.decode(n).type === 'npub'; } catch { return false; }
}

/** Pure check of a member's device note. Returns { ok, devices } or a failure. */
export function validateDeviceNote(input, { pubkey, now, prevCreatedAt = 0 }) {
  const e = canonicalEvent(input);
  if (!e || e.kind !== DEVICE_KIND || !Array.isArray(e.tags)) return fail('bad_event', `kind must be ${DEVICE_KIND}`);
  if (e.pubkey !== pubkey) return fail('not_signer', 'sign with your own key');
  if (!e.tags.some((t) => Array.isArray(t) && t[0] === 't' && t[1] === DEVICE_TAG) || e.tags.length > 4) return fail('bad_event', 'not a device list');
  if (!Number.isInteger(e.created_at) || Math.abs(e.created_at - now) > MAX_SKEW_SEC) return fail('clock', 'check this computer\'s clock');
  if (e.created_at <= prevCreatedAt) return fail('stale', 'a newer list is already saved');
  if (typeof e.content !== 'string' || e.content.length > MAX_CONTENT) return fail('bad_event', 'list too long');
  let c;
  try { c = JSON.parse(e.content); } catch { return fail('bad_event', 'list is not JSON'); }
  if (c?.v !== 1 || !Array.isArray(c.devices)) return fail('bad_event', 'not a device list');
  if (c.devices.length > MAX_DEVICES) return fail('too_many', `at most ${MAX_DEVICES} computers`);
  const seen = new Set();
  const devices = [];
  for (const d of c.devices) {
    if (!d || typeof d !== 'object' || Object.keys(d).some((k) => k !== 'npub' && k !== 'label')) return fail('bad_device', 'bad computer entry');
    if (!npubOk(d.npub)) return fail('bad_npub', 'that is not a FIPS name (npub1…)');
    if (seen.has(d.npub)) return fail('duplicate', 'that computer is already listed');
    const label = d.label ?? '';
    if (typeof label !== 'string' || label.length > MAX_LABEL || !LABEL.test(label)) return fail('bad_label', `name: up to ${MAX_LABEL} plain characters`);
    seen.add(d.npub);
    devices.push({ npub: d.npub, label });
  }
  let sigOk = false;
  try { sigOk = verifyEvent(e); } catch { sigOk = false; }
  if (!sigOk) return fail('bad_sig', 'signature does not verify');
  return { ok: true, event: e, devices };
}

/**
 * @param {{dir:string, rosterStore:object, ownerHex:()=>string|null, now?:()=>number}} o
 */
export function createTeamDevices({ dir, rosterStore, ownerHex, now = () => Math.floor(Date.now() / 1000) }) {
  if (!dir || !rosterStore) throw new Error('team-devices: dir and rosterStore required');
  const notesFile = join(dir, 'devices.json');
  const meshFile = join(dir, 'mesh.json');
  let tail = Promise.resolve();
  const serial = (fn) => { const run = tail.then(fn); tail = run.catch(() => {}); return run; };

  async function readJson(f, fallback) {
    try { return JSON.parse(await readFile(f, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT' || e instanceof SyntaxError) return fallback;
      throw e;
    }
  }
  async function atomic(f, text) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, f);
  }
  const loadNotes = async () => {
    const n = await readJson(notesFile, {});
    return n && typeof n.notes === 'object' && n.notes ? n.notes : {};
  };

  /** Everyone currently on a project: owner, listed humans, people admitted by link. */
  async function listedHumans() {
    const owner = ownerHex();
    const out = new Set(HEX64.test(owner || '') ? [owner] : []);
    for (const slug of await rosterStore.slugs()) {
      let s = null;
      try { s = await rosterStore.get(slug); } catch { continue; }
      for (const m of s?.roster?.members ?? []) if (m.role !== 'agent') out.add(m.pubkey);
    }
    return out;
  }

  async function buildMesh(notes) {
    const humans = await listedHumans();
    const projects = [];
    for (const slug of await rosterStore.slugs()) {
      let s = null;
      try { s = await rosterStore.get(slug); } catch { continue; }
      if (!s) continue;
      const admitted = (Array.isArray(s.admitted) ? s.admitted : [])
        .filter((a) => a?.grant).map((a) => ({ pubkey: a.pubkey, role: a.role, grant: a.grant }));
      projects.push({ slug, roster: s.event ?? null, admitted });
    }
    const devices = Object.keys(notes).sort().filter((pk) => humans.has(pk)).map((pk) => notes[pk]);
    return { mesh: { version: 1, projects, devices }, humans };
  }

  /** Rewrite mesh.json if it changed; drop notes of people no longer on any project. */
  function writeMesh() {
    return serial(async () => {
      const notes = await loadNotes();
      const { mesh, humans } = await buildMesh(notes);
      const gone = Object.keys(notes).filter((pk) => !humans.has(pk));
      if (gone.length) {
        for (const pk of gone) delete notes[pk];
        await atomic(notesFile, JSON.stringify({ notes }));
      }
      const text = JSON.stringify(mesh) + '\n';
      let prev = null;
      try { prev = await readFile(meshFile, 'utf8'); } catch { /* first write */ }
      if (prev !== text) await atomic(meshFile, text);
      return { changed: prev !== text, projects: mesh.projects.length, devices: mesh.devices.length };
    });
  }

  async function get(pubkey) {
    const listed = (await listedHumans()).has(pubkey);
    const note = listed ? (await loadNotes())[pubkey] : null;
    let devices = [];
    if (note) { try { devices = JSON.parse(note.content).devices; } catch { devices = []; } }
    return { devices, listed, max: MAX_DEVICES };
  }

  async function put(pubkey, event) {
    if (!(await listedHumans()).has(pubkey)) return fail('not_listed', 'you are not on a project here');
    const r = await serial(async () => {
      const notes = await loadNotes();
      const v = validateDeviceNote(event, { pubkey, now: now(), prevCreatedAt: notes[pubkey]?.created_at ?? 0 });
      if (!v.ok) return v;
      notes[pubkey] = v.event;
      await atomic(notesFile, JSON.stringify({ notes }));
      return { ok: true, devices: v.devices };
    });
    if (r.ok) await writeMesh();
    return r;
  }

  return { get, put, writeMesh };
}
