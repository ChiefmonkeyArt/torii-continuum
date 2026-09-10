/**
 * Noticeboard view — the operator's draft → approve → sign → publish surface.
 *
 * NAP-BRIDGE-8. The node only ever DRAFTS the kind-30078 d="noticeboard" event
 * (POST /api/noticeboard/draft → an unsigned event on the pending shelf). This
 * view is where the human is in the loop: compose notices, review the composed
 * board, sign it in-browser with the NIP-07 signer (the node never sees a key),
 * publish the signed event to the operator's relay, then discard the draft.
 *
 * Nakama reads the published board and never edits it — this is the only write
 * path, and it is always the operator.
 */

import { h, clear, timeAgo } from './util.js';
import { noticeboardDraft, pendingDrafts, pendingDraft, discardDraft } from '../data/agent.js';
import { publishEvent } from '../lib/relay-publish.js';
import { setChatContext } from '../chat.js';

const KINDS = ['notice', 'auction', 'sale', 'event', 'announcement'];

let rows = [];
let statusEl = null;
let reviewEl = null;

export function renderNoticeboard(mount) {
  setChatContext({ label: 'Noticeboard', where: 'noticeboard' });
  clear(mount);
  rows = [];

  const header = h('div', { class: 'page-header' }, [
    h('div', {}, [
      h('p', { class: 'eyebrow', text: 'World signal' }),
      h('h1', { class: 'page-title', text: 'Noticeboard' }),
      h('div', { class: 'page-sub', text: 'Draft the read-only board Nakama shows players. You review it, sign it in-browser, and it lands on your relay.' }),
    ]),
  ]);
  mount.appendChild(header);

  const note = h('div', { class: 'muted', style: 'font-size: 12.5px; margin: -4px 0 16px; max-width: 640px;', text: 'One replaceable event (kind 30078, d="noticeboard"). Publishing replaces the previous board. Nakama reads it and never writes it — you are the only hand on the pen.' });
  mount.appendChild(note);

  statusEl = h('div', {});
  mount.appendChild(statusEl);

  // ── Composer ──────────────────────────────────────────────
  const composer = h('div', { class: 'card', style: 'margin-bottom: 16px;' });
  const rowsWrap = h('div', {});
  composer.appendChild(h('div', { class: 'card-title', text: 'Compose notices' }));
  composer.appendChild(rowsWrap);
  composer.appendChild(h('div', { style: 'display:flex; gap:8px; margin-top:8px;' }, [
    h('button', { class: 'ghost', onClick: () => rowsWrap.appendChild(renderRow()) }, ['Add notice']),
    h('button', { class: 'primary', onClick: () => compose(rowsWrap) }, ['Draft for signature']),
  ]));
  mount.appendChild(composer);

  rowsWrap.appendChild(renderRow());

  // ── Review panel (filled on draft/review) ──────────────────
  reviewEl = h('div', {});
  mount.appendChild(reviewEl);

  // ── Existing drafts on the pending shelf ──────────────────
  const shelf = h('div', { class: 'card', style: 'margin-top: 16px;' });
  shelf.appendChild(h('div', { class: 'card-title', text: 'Waiting for signature' }));
  mount.appendChild(shelf);
  loadShelf(shelf);
}

function renderRow() {
  const kindSel = h('select', { style: 'flex: 0 0 auto;', }, KINDS.map((k) => h('option', { value: k }, [k])));
  const titleInp = h('input', { type: 'text', placeholder: 'Title (required)', maxlength: '120', style: 'flex: 2 1 180px;' });
  const bodyInp = h('input', { type: 'text', placeholder: 'Body (optional)', maxlength: '500', style: 'flex: 2 1 220px;' });
  const priceInp = h('input', { type: 'number', placeholder: 'sats', min: '0', style: 'flex: 0 1 90px;' });
  const urlInp = h('input', { type: 'url', placeholder: 'https://…', maxlength: '500', style: 'flex: 2 1 200px;' });

  const ref = {
    kindSel, titleInp, bodyInp, priceInp, urlInp,
    read: () => ({
      kind: kindSel.value,
      title: titleInp.value.trim(),
      body: bodyInp.value.trim(),
      price_sats: priceInp.value,
      url: urlInp.value.trim(),
    }),
  };
  rows.push(ref);

  const el = h('div', { style: 'display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; align-items:center;' }, [
    kindSel, titleInp, bodyInp, priceInp, urlInp,
    h('button', { class: 'ghost', title: 'Remove', onClick: () => { el.remove(); rows = rows.filter((r) => r !== ref); } }, ['✕']),
  ]);
  return el;
}

async function compose(rowsWrap) {
  const notices = rows.map((r) => r.read());
  const filled = notices.filter((n) => n.title);
  if (!filled.length) {
    setStatus('error', 'Add at least one notice with a title.');
    return;
  }
  setStatus('busy', 'Drafting…');
  const r = await noticeboardDraft(filled);
  if (!r.ok) {
    setStatus('error', r.reason || 'Draft failed.');
    return;
  }
  clear(statusEl);
  showReview(r.data);
}

async function loadShelf(shelf) {
  const r = await pendingDrafts();
  const list = r.ok && Array.isArray(r.data?.drafts) ? r.data.drafts : [];
  if (!list.length) {
    shelf.appendChild(h('div', { class: 'muted', style: 'font-size: 12.5px;', text: 'No drafts waiting. Compose above to draft a board.' }));
    return;
  }
  for (const d of list) {
    const row = h('div', { style: 'display:flex; align-items:center; gap:8px; padding:8px 0; border-top:1px solid var(--border, rgba(0,0,0,0.08));' }, [
      h('span', { style: 'flex:1; font-family: var(--font-mono, monospace); font-size: 12.5px;', text: d.file }),
      h('span', { class: 'muted', style: 'font-size: 12px;', text: typeof d.proposed_at === 'number' ? timeAgo(Math.floor(d.proposed_at / 1000)) : '' }),
      h('button', { class: 'ghost', onClick: () => reviewFile(d.file) }, ['Review']),
      h('button', { class: 'ghost', onClick: () => discard(d.file, row) }, ['Discard']),
    ]);
    shelf.appendChild(row);
  }
}

async function reviewFile(file) {
  setStatus('busy', 'Loading draft…');
  const r = await pendingDraft(file);
  clear(statusEl);
  if (!r.ok) {
    setStatus('error', r.reason || 'Could not load the draft.');
    return;
  }
  // The shelf GET returns the raw draft object (event fields + _relay/
  // _proposed_at), not the {file,event,relay} shape the fresh-draft response
  // uses — normalise to that shape for showReview.
  const d = r.data || {};
  showReview({
    file,
    event: { kind: d.kind, content: d.content, created_at: d.created_at, tags: d.tags },
    relay: d._relay,
  });
}

function showReview({ file, event, relay }) {
  clear(reviewEl);
  // The signable event is exactly the NIP-01 template: kind/content/created_at/
  // tags. Strip the shelf's `_proposed_at` metadata so the signer signs a clean
  // event and the published event matches what Nakama later reads.
  const signable = { kind: event.kind, content: event.content, created_at: event.created_at, tags: event.tags };

  let notices = [];
  try {
    const parsed = JSON.parse(event.content);
    if (Array.isArray(parsed.notices)) notices = parsed.notices;
  } catch (_e) { /* malformed content is a server bug; show raw below */ }

  const list = notices.length
    ? h('ul', { style: 'list-style:none; padding:0; margin: 10px 0;' }, notices.map((n) => h('li', { style: 'padding: 8px 0; border-top: 1px solid var(--border, rgba(0,0,0,0.08));' }, [
      badge(n.kind), h('strong', { text: n.title }),
      n.price_sats != null ? h('span', { class: 'muted', text: ` · ${n.price_sats} sats` }) : null,
      n.body ? h('div', { class: 'muted', style: 'font-size: 12.5px; margin-top: 2px;', text: n.body }) : null,
    ])))
    : h('div', { class: 'muted', text: '(no notices)' });

  reviewEl.appendChild(h('div', { class: 'card', style: 'margin-top: 4px;' }, [
    h('div', { class: 'card-title', text: 'Review & sign' }),
    h('div', { class: 'muted', style: 'font-size: 12px;', text: `Will publish to ${relay} · kind ${event.kind} · replaces any live board` }),
    list,
    h('div', { style: 'display:flex; gap:8px; margin-top: 8px;' }, [
      h('button', { class: 'primary', onClick: () => signAndPublish(file, signable, relay) }, ['Sign & publish']),
      h('button', { class: 'ghost', onClick: () => discard(file, null) }, ['Discard draft']),
    ]),
  ]));
}

function badge(kind) {
  const label = h('span', { class: 'muted', text: kind });
  label.style.cssText += 'border:1px solid var(--border, rgba(0,0,0,0.12)); border-radius:4px; padding:1px 6px; font-size:11px; margin-right:6px;';
  return label;
}

async function signAndPublish(file, signable, relay) {
  if (typeof window === 'undefined' || !window.nostr?.signEvent) {
    setStatus('error', 'No NIP-07 signer available. Install a Nostr signer extension (e.g. a Plebeian-compatible signer) to sign in-browser.');
    return;
  }
  setStatus('busy', 'Signing in your browser…');
  let signed;
  try {
    signed = await window.nostr.signEvent(signable);
  } catch (e) {
    setStatus('error', `Signing cancelled or failed: ${e?.message || e}`);
    return;
  }
  setStatus('busy', `Publishing to ${relay}…`);
  try {
    const res = await publishEvent(relay, signed);
    clear(statusEl);
    setStatus('ok', `Published. Nakama will show the new board within its cache window.`);
    if (file) await discardDraft(file);
    clear(reviewEl);
  } catch (e) {
    setStatus('error', `Publish failed — draft kept: ${e?.reason || e}`);
  }
}

async function discard(file, rowEl) {
  const r = await discardDraft(file);
  if (r.ok) {
    if (rowEl) rowEl.remove();
    else clear(reviewEl);
    setStatus('ok', 'Draft discarded.');
  } else {
    setStatus('error', r.reason || 'Could not discard the draft.');
  }
}

function setStatus(kind, text) {
  clear(statusEl);
  const cls = kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : 'muted';
  statusEl.appendChild(h('div', { class: cls, style: 'font-size: 12.5px; margin: -4px 0 12px;', text }));
}