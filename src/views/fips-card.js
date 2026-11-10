/**
 * Node mesh (FIPS) card on the dashboard (docs/adr-fips-default.md §1, §4).
 * Shows whether FIPS runs, this node's FIPS name and its Quest peers, and
 * lets the operator swap signed introduction cards with another operator.
 * Every change is a full peer list signed in the browser; the agent only
 * passes it to the node's root helper, which checks it again. Mesh (fd…)
 * addresses are never shown.
 */
import { h, clear } from './util.js';
import { shortNpub } from '../lib/npub.js';
import { reconcileSignedEvent } from '../signer-compat.js';
import * as agent from '../data/agent.js';

export const PEER_REQUEST_KIND = 27532;
export const INTRO_PREFIX = 'torii-fips-intro:';
const FIELDS = ['transportNpub', 'beaconPubkey', 'ownerPubkey', 'zoneId', 'website'];

const b64url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const encodeCard = (event) => INTRO_PREFIX + b64url(JSON.stringify(event));

/** Unsigned full peer list; the node applies only a list newer than the last. */
export function buildPeerRequest(peers, createdAt) {
  return {
    kind: PEER_REQUEST_KIND, created_at: createdAt, tags: [['t', 'torii-fips-peers']],
    content: JSON.stringify({ version: 1, peers: peers.map((p) => Object.fromEntries(FIELDS.map((k) => [k, p[k]]))) }),
  };
}

async function sign(signer, built) {
  if (!signer || typeof signer.signEvent !== 'function') throw new Error('No Nostr signer found. Connect your signer first.');
  let returned;
  try { returned = await signer.signEvent(built); } catch (e) { throw new Error(`Signing cancelled or failed: ${e?.message || e}`); }
  const rec = reconcileSignedEvent(built, returned);
  if (!rec.ok) throw new Error('The signer returned no signature. Nothing was changed.');
  return rec.event;
}

/** Sign and queue the full list. */
export async function signAndPutPeers({ api = agent, signer, peers, now = () => Math.floor(Date.now() / 1000) }) {
  const event = await sign(signer, buildPeerRequest(peers, now()));
  const r = await api.putFipsPeers(event);
  if (!r.ok) throw new Error(`The node refused the change: ${r.reason}`);
  return r.data;
}

const shortName = (n) => (n && n.length > 20 ? `${n.slice(0, 12)}…${n.slice(-6)}` : n || '');
const host = (website) => { try { return new URL(website).hostname; } catch { return website; } };
const note = (text, cls = 'muted') => h('div', { class: cls, style: 'font-size:13px;margin-top:6px;', text });

async function copy(btn, text) {
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}

/**
 * @param {{api?: typeof agent, signer?: () => any}} [deps]
 */
export function FipsCard(deps = {}) {
  const api = deps.api || agent;
  const getSigner = deps.signer || (() => (typeof window !== 'undefined' ? window.nostr : null));
  const body = h('div', { class: 'fips-card-body' }, [note('Checking FIPS…')]);
  const card = h('div', { class: 'card fips-card' }, [h('h3', { text: 'Node mesh (FIPS)' }), body]);
  let status = null;
  const msg = h('div', { role: 'status', 'aria-live': 'polite' });
  const say = (text, cls) => msg.replaceChildren(text ? note(text, cls) : '');

  async function change(peers, done) {
    say('Waiting for your signer…');
    try {
      await signAndPutPeers({ api, signer: getSigner(), peers });
      say(done);
      await load();
    } catch (e) { say(e.message, 'error'); }
  }

  function introPanel() {
    const out = h('div');
    const make = h('button', { class: 'ghost', type: 'button', text: 'Make introduction card' });
    make.addEventListener('click', async () => {
      say('Preparing…');
      const r = await api.fipsIntroduction();
      if (!r.ok) return say(r.reason, 'error');
      try {
        const cardText = encodeCard(await sign(getSigner(), r.data.template));
        const field = h('input', { type: 'text', readonly: 'readonly', value: cardText, 'aria-label': 'Introduction card', style: 'flex:1 1 220px;min-width:0;font-family:var(--font-mono, monospace);font-size:12px;' });
        const btn = h('button', { class: 'ghost', type: 'button', text: 'Copy', onclick: () => copy(btn, cardText) });
        out.replaceChildren(h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;' }, [field, btn]),
          note('Send this to the other operator. It holds no secret.'));
        say('');
      } catch (e) { say(e.message, 'error'); }
    });
    return h('div', { style: 'margin-top:12px;' }, [make, out]);
  }

  function addPanel() {
    const input = h('textarea', { rows: '2', placeholder: 'Paste another node\'s introduction card', 'aria-label': 'Introduction card to add', style: 'width:100%;font-family:var(--font-mono, monospace);font-size:12px;' });
    const result = h('div');
    const check = h('button', { class: 'ghost', type: 'button', text: 'Check card' });
    check.addEventListener('click', async () => {
      result.replaceChildren();
      say('Checking the card and that node\'s heartbeat…');
      const r = await api.fipsCheckCard(input.value);
      if (!r.ok) return say(r.reason, 'error');
      const p = r.data.peer;
      if (status.peers.some((x) => x.transportNpub === p.transportNpub)) return say('That node is already a peer.');
      if (status.peers.length >= status.max) return say(`This node already has ${status.max} peers. Remove one first.`, 'error');
      say('');
      const add = h('button', { type: 'button', text: 'Add peer' });
      add.addEventListener('click', () => change([...status.peers, p], 'Added. The node applies it within a few seconds.'));
      result.replaceChildren(note(`${host(p.website)} · zone ${p.zoneId} · owner ${shortNpub(p.ownerPubkey)}`, ''), h('div', { style: 'margin-top:6px;' }, [add]));
    });
    return h('div', { style: 'margin-top:12px;' }, [input, h('div', { style: 'margin-top:6px;' }, [check]), result]);
  }

  function render() {
    clear(body);
    if (!status.installed) {
      body.append(note('FIPS is not installed on this node. Run the Suite fips stage to add it.'));
      return;
    }
    const copyBtn = h('button', { class: 'ghost', type: 'button', text: 'Copy' });
    copyBtn.addEventListener('click', () => copy(copyBtn, status.npub));
    body.append(
      h('div', { style: 'margin-top:2px;' }, [h('span', { class: `pill ${status.running ? 'ok' : 'danger'}`, text: status.running ? 'Running' : 'Not running' })]),
      status.running ? '' : note('FIPS is installed but stopped. Check torii-fips on the node.'),
      h('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:6px;font-size:13px;' }, [
        h('span', { text: 'FIPS name' }), h('code', { text: shortName(status.npub) }), copyBtn]),
      note(`Peers: ${status.peers.length} of ${status.max}`),
    );
    for (const p of status.peers) {
      const rm = h('button', { class: 'ghost', type: 'button', text: 'Remove' });
      rm.addEventListener('click', () => change(status.peers.filter((x) => x.transportNpub !== p.transportNpub), 'Removed. The node applies it within a few seconds.'));
      body.append(h('div', { class: 'fips-peer', style: 'display:flex;gap:8px;align-items:center;font-size:13px;margin-top:4px;' }, [
        h('span', { text: `${host(p.website)} · ${p.zoneId}` }), rm]));
    }
    if (status.pending) body.append(note('Waiting for the node to apply your last change. If this stays, the node refused it.'));
    body.append(introPanel(), addPanel(), msg);
  }

  async function load() {
    const r = await api.fipsStatus();
    if (!card.isConnected && status) return;
    if (!r.ok) { body.replaceChildren(note(`Could not read FIPS status: ${r.reason}`, 'error')); return; }
    status = r.data;
    render();
  }

  queueMicrotask(load);
  return card;
}
