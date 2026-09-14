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
import { validateNoticeboardEvent } from '../lib/noticeboard-validate.js';
import { reconcileSignedEvent } from '../signer-compat.js';
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

  // FE-08: gate the signature on a validated noticeboard event. A generic draft
  // off the pending shelf, or one whose content fails to parse into a well-formed
  // notices array, must not reach the signer.
  const valid = validateNoticeboardEvent(signable);

  let notices = [];
  let malformed = false;
  try {
    const parsed = JSON.parse(event.content);
    if (Array.isArray(parsed.notices)) notices = parsed.notices;
    else malformed = true;
  } catch (_e) { malformed = true; }

  const list = notices.length
    ? h('ul', { style: 'list-style:none; padding:0; margin: 10px 0;' }, notices.map((n) => h('li', { style: 'padding: 8px 0; border-top: 1px solid var(--border, rgba(0,0,0,0.08));' }, [
      badge(n.kind), h('strong', { text: n.title }),
      n.price_sats != null ? h('span', { class: 'muted', text: ` · ${n.price_sats} sats` }) : null,
      n.body ? h('div', { class: 'muted', style: 'font-size: 12.5px; margin-top: 2px;', text: n.body }) : null,
      // FE-08: show the outbound destination before the operator signs, so a
      // URL can never be smuggled into a signed board unseen.
      n.url ? h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 2px; text-decoration: underline;', text: `→ ${n.url}` }) : null,
    ])))
    : h('div', { class: 'muted', text: '(no notices)' });

  const actions = [];
  if (valid.ok) {
    actions.push(h('button', { class: 'primary', onClick: () => signAndPublish(file, signable, relay) }, ['Sign & publish']));
  } else {
    // Malformed/unexpected draft: no signature button, and the reason is shown
    // inline. `discard` is still offered so the operator can clear the shelf.
    actions.push(h('div', { class: 'error', style: 'font-size: 12.5px; padding: 8px; border-radius: 4px;', text: `Refusing to sign — ${valid.reason}` }));
  }
  actions.push(h('button', { class: 'ghost', onClick: () => discard(file, null) }, ['Discard draft']));

  reviewEl.appendChild(h('div', { class: 'card', style: 'margin-top: 4px;' }, [
    h('div', { class: 'card-title', text: 'Review & sign' }),
    h('div', { class: 'muted', style: 'font-size: 12px;', text: `Will publish to ${relay} · kind ${event.kind} · d="${(event.tags || []).find((t) => Array.isArray(t) && t[0] === 'd')?.[1] || ''}" · replaces any live board` }),
    list,
    h('div', { style: 'display:flex; gap:8px; margin-top: 8px; flex-wrap: wrap; align-items: center;' }, actions),
  ]));
}

function badge(kind) {
  const label = h('span', { class: 'muted', text: kind });
  label.style.cssText += 'border:1px solid var(--border, rgba(0,0,0,0.12)); border-radius:4px; padding:1px 6px; font-size:11px; margin-right:6px;';
  return label;
}

async function signAndPublish(file, signable, relay) {
  // FE-08: re-validate immediately before signing. The draft could have been
  // edited on the shelf since review, so this is the real gate — never ask for
  // a signature on a malformed or generic event.
  const pre = validateNoticeboardEvent(signable);
  if (!pre.ok) {
    setStatus('error', `Refusing to sign — ${pre.reason}`);
    return;
  }
  if (typeof window === 'undefined' || !window.nostr?.signEvent) {
    setStatus('error', 'No NIP-07 signer available. Install a Nostr signer extension (e.g. a Plebeian-compatible signer) to sign in-browser.');
    return;
  }
  setStatus('busy', 'Signing in your browser…');
  let returned;
  try {
    returned = await window.nostr.signEvent(signable);
  } catch (e) {
    setStatus('error', `Signing cancelled or failed: ${e?.message || e}`);
    return;
  }
  // FE-08: reconcile the signer's return with what we asked to sign (shared
  // signer-result adapter used by auth/memory), then re-verify the reconciled
  // event is still a valid noticeboard before it reaches the relay.
  const reconciled = reconcileSignedEvent(signable, returned);
  if (!reconciled.ok) {
    setStatus('error', reconciled.kind === 'unsigned' ? 'The signer returned no signature — nothing was signed.' : 'The signer returned an empty result.');
    return;
  }
  const signed = reconciled.event;
  const post = validateNoticeboardEvent(signed);
  if (!post.ok) {
    setStatus('error', `The signed event is not a valid noticeboard (${post.reason}) — not published, draft kept.`);
    return;
  }
  setStatus('busy', `Publishing to ${relay}…`);
  try {
    const res = await publishEvent(relay, signed);
    clear(statusEl);
    // FE-08: a failed discard after a successful publish is surfaced, not
    // silently swallowed — the board went out but the draft may still sit on
    // the shelf waiting for signature.
    if (file) {
      const d = await discardDraft(file);
      if (!d.ok) {
        setStatus('ok', `Published, but the draft could not be discarded (${d.reason || 'unknown'}) — remove it under “Waiting for signature”.`);
        return;
      }
    }
    setStatus('ok', `Published. Nakama will show the new board within its cache window.`);
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