/**
 * Memory console view (MEMORY-1).
 *
 * The owner-facing surface for the sovereign bot's persistent memory. Every
 * durable memory is encrypted at rest (NIP-44, sealed in THIS browser — the
 * agent never sees plaintext or a key) and isolated by owner + bot + project.
 *
 * What this console does:
 *   • Working values — shows which constitution/Code-of-Practice covenant is
 *     live on every prompt (provenance only; the covenant is public data).
 *   • Usage — per-owner bytes/items against quotas, per-scope breakdown.
 *   • Proposals — AI (or "remember this") suggestions are NEVER auto-saved.
 *     The owner reviews the exact plaintext, then APPROVES by sealing it in the
 *     browser (NIP-44) and posting only the ciphertext + the reviewed payload
 *     hash + a single-use nonce. Reject is explicit + audited.
 *   • Stored memory — metadata list (never ciphertext) with per-item delete
 *     (real unlink + tombstone) and a scope integrity re-check.
 *   • Portability — manual, owner-signed, encrypted. Export assembles a bundle
 *     of CIPHERTEXTS ONLY; the browser signs its manifest digest (NIP-07) and
 *     downloads it. Import verifies signature/owner/hashes and QUARANTINES
 *     items (never straight into live memory); the owner approves them out.
 *
 * Rendering is via the XSS-safe h() builder (textContent only, no raw HTML),
 * matching genesis.js/team.js. All agent state flows through src/data/agent.js.
 */
import { h, clear } from './util.js';
import { setChatContext } from '../chat.js';
import {
  memoryWorkingValues, memoryUsage, memoryScoped, memoryVerify, memoryDelete,
  memoryProposals, memoryApprove, memoryReject,
  memoryExport, memoryImport, memoryQuarantine, memoryQuarantineApprove, memoryQuarantineReject,
  memoryState, memoryCiphertexts, memoryActivateChallenge, memoryActivate,
} from '../data/agent.js';
import {
  ACTIVATION_STATES, signerAvailable, runActivation,
} from './memory-activation.js';

// Custom app kind for the DETACHED portable-bundle manifest signature. Mirrors
// BUNDLE_SIG_KIND in agent/lib/portability.mjs — a signing-only event, never a
// memory event and never published to a relay.
const BUNDLE_SIG_KIND = 30099;

export function renderMemory(mount) {
  setChatContext({ label: 'Memory', where: 'memory' });
  clear(mount);

  mount.appendChild(h('div', { class: 'page-header' }, [
    h('div', {}, [
      h('p', { class: 'eyebrow', text: 'Sovereignty' }),
      h('h1', { class: 'page-title', text: 'Memory' }),
      h('div', { class: 'page-sub', text: 'Your bot’s encrypted, owner-controlled memory. Nothing durable is saved without your explicit approval.' }),
    ]),
  ]));

  const body = h('div', { style: 'display: flex; flex-direction: column; gap: 16px;' });
  mount.appendChild(body);
  body.appendChild(h('div', { class: 'muted', style: 'font-size: 13px;', text: 'Loading memory state…' }));
  load(body);
}

async function load(body) {
  // Authoritative first-run gate: ask the agent whether memory is unlocked FOR
  // THIS OWNER before rendering anything. A locked owner sees the guided
  // activation panel; an unlocked owner drops straight into the console. We
  // never infer "unlocked" from anything but data.unlocked_for_owner.
  const state = await memoryState();
  clear(body);

  if (state.offline || (!state.ok && state.reason === 'offline')) {
    body.appendChild(offlineCard());
    return;
  }
  if (!state.ok && state.status === 401) {
    body.appendChild(card('Session expired', 'Sign in again to view your bot’s memory.'));
    return;
  }
  if (!state.ok && state.status === 403) {
    body.appendChild(card('No bot yet', 'Create your sovereign bot on the Genesis page first — memory is bound to an owner and bot.'));
    return;
  }
  if (!state.ok) {
    body.appendChild(card('Memory unavailable', state.reason || 'Could not read memory state. Please retry.'));
    return;
  }

  if (!state.data?.unlocked_for_owner) {
    body.appendChild(activationCard(body));
    return;
  }

  await renderConsole(body);
}

// The normal Memory Console. Reached only when the owner's memory is
// authoritatively unlocked (fresh load OR right after a successful activation,
// with no page reload).
async function renderConsole(body) {
  clear(body);
  body.appendChild(h('div', { class: 'muted', style: 'font-size: 13px;', text: 'Loading memory…' }));
  const [wv, usage, props, quar] = await Promise.all([
    memoryWorkingValues(), memoryUsage(), memoryProposals(), memoryQuarantine(),
  ]);
  clear(body);

  if (wv.offline || (!wv.ok && wv.reason === 'offline')) {
    body.appendChild(offlineCard());
    return;
  }
  if (!wv.ok && wv.status === 401) {
    body.appendChild(card('Session expired', 'Sign in again to view your bot’s memory.'));
    return;
  }
  if (!wv.ok && wv.status === 403) {
    body.appendChild(card('No bot yet', 'Create your sovereign bot on the Genesis page first — memory is bound to an owner and bot.'));
    return;
  }

  body.appendChild(workingValuesCard(wv.data || {}));
  body.appendChild(usageCard(usage.ok ? usage.data : null));
  body.appendChild(proposalsCard(body, props.ok ? props.data : { proposals: [] }));
  body.appendChild(storedCard(body));
  body.appendChild(quarantineCard(body, quar.ok ? quar.data : { items: [] }));
  body.appendChild(portabilityCard(body));
}

// ─── first-run activation (MEMORY-ACTIVATION-1) ──────────────

// Human-readable copy for each terminal/interim activation state. Interim
// states drive a live status line; terminal states drive the recoverable
// error/success messaging. Kept as data so the view stays declarative and the
// strings are unit-inspectable.
const ACTIVATION_COPY = Object.freeze({
  [ACTIVATION_STATES.REQUESTING_SIGNATURE]: 'Requesting your signature… approve the request in your Nostr signer.',
  [ACTIVATION_STATES.ACTIVATING]: 'Unlocking memory…',
  [ACTIVATION_STATES.SIGNER_REJECTED]: 'Signature request was cancelled or rejected. Memory is still locked — you can try again.',
  [ACTIVATION_STATES.SIGNER_UNAVAILABLE]: 'No NIP-44-capable Nostr signer was found. Install or unlock a signer extension, then retry.',
  [ACTIVATION_STATES.ERROR]: 'Activation could not be completed. Memory is still locked — please retry.',
});

function activationCard(body) {
  const status = h('div', {
    class: 'muted',
    style: 'font-size: 13px; min-height: 18px; margin-top: 4px;',
    role: 'status',
    'aria-live': 'polite',
    'data-testid': 'activation-status',
  });
  const err = h('div', {
    style: 'color: var(--accent-danger); font-size: 13px; min-height: 18px; margin-top: 4px;',
    role: 'alert',
    'data-testid': 'activation-error',
  });

  const cta = h('button', {
    class: 'primary',
    'data-testid': 'activate-memory',
    onClick: onActivate,
  }, ['Activate private memory']);

  async function onActivate() {
    err.textContent = '';
    status.textContent = '';
    cta.disabled = true;

    const win = typeof window !== 'undefined' ? window : {};
    const origin = (typeof window !== 'undefined' && window.location && window.location.origin) || '';

    const deps = {
      signerAvailable: () => signerAvailable(win),
      getPublicKey: () => win.nostr.getPublicKey(),
      signEvent: (evt) => win.nostr.signEvent(evt),
      decrypt: (pk, ct) => win.nostr.nip44.decrypt(pk, ct),
      fetchChallenge: () => memoryActivateChallenge(),
      fetchCiphertexts: () => memoryCiphertexts(),
      postActivate: (payload) => memoryActivate(payload),
      fetchState: () => memoryState(),
      origin,
    };

    const result = await runActivation(deps, (t) => {
      const copy = ACTIVATION_COPY[t.state];
      if (t.state === ACTIVATION_STATES.REQUESTING_SIGNATURE || t.state === ACTIVATION_STATES.ACTIVATING) {
        status.textContent = copy || '';
      } else if (t.state === ACTIVATION_STATES.SUCCESS) {
        status.textContent = 'Memory unlocked.';
      } else if (copy) {
        // Terminal error/rejection/unavailable: surface as a recoverable error.
        status.textContent = '';
        err.textContent = t.reason ? `${copy} (${t.reason})` : copy;
      }
    });

    if (result.ok) {
      // Authoritative refresh already confirmed unlocked_for_owner:true inside
      // runActivation — reveal the console in place, no reload.
      await renderConsole(body);
      return;
    }
    cta.disabled = false;
  }

  return h('div', { class: 'card', 'data-testid': 'activation-panel', style: 'border: 1px solid hsl(var(--border));' }, [
    h('h2', { class: 'page-title', style: 'font-size: 20px; margin: 0 0 8px;', text: 'Activate private memory' }),
    h('div', { style: 'font-size: 13.5px; line-height: 1.5; margin-bottom: 12px;' }, [
      h('p', { style: 'margin: 0 0 8px;', text: 'Your bot’s durable memory is locked. Activation turns it on for you and only you:' }),
      h('ul', { style: 'margin: 0 0 4px; padding-left: 20px; display: flex; flex-direction: column; gap: 4px;' }, [
        h('li', { text: 'Owner-controlled — memory is bound to your key and no one else can unlock it.' }),
        h('li', { text: 'Encrypted in this browser before anything is persisted — the agent never sees plaintext or your key.' }),
        h('li', { text: 'Requires your signature — you authorize activation by signing a one-time challenge in your own Nostr signer.' }),
      ]),
    ]),
    h('div', { class: 'form-actions', style: 'display: flex; gap: 8px; flex-wrap: wrap;' }, [cta]),
    status,
    err,
  ]);
}

// ─── cards ───────────────────────────────────────────────────

function card(title, sub) {
  return h('div', { class: 'card' }, [
    h('h2', { class: 'page-title', style: 'font-size: 18px; margin: 0 0 6px;', text: title }),
    h('div', { class: 'muted', style: 'font-size: 13px;', text: sub }),
  ]);
}

function offlineCard() {
  return card('Agent offline', 'Memory requires a live agent daemon. This demo build has no agent behind it.');
}

function workingValuesCard(wv) {
  return h('div', { class: 'card' }, [
    h('h2', { class: 'page-title', style: 'font-size: 17px; margin: 0 0 4px;', text: 'Working values (live on every prompt)' }),
    h('div', { class: 'muted', style: 'font-size: 12.5px; margin-bottom: 8px;', text: 'This covenant is injected above character and any retrieved memory on every turn. It outranks memory and treats retrieved/imported text as data, never instructions.' }),
    kv('Constitution', wv.constitution_version || '—'),
    kv('Constitution digest', (wv.constitution_digest || '—')),
    kv('Code of Practice', wv.code_of_practice_version || '—'),
    kv('Header digest', wv.header_sha256 || '—'),
  ]);
}

function usageCard(u) {
  if (!u) return card('Usage', 'Usage is unavailable right now.');
  const q = u.quotas || {};
  const scopeRows = (u.scopes || []).map((s) => h('div', {
    style: 'display: flex; gap: 12px; padding: 6px 0; border-top: 1px solid hsl(var(--border)); font-size: 12.5px;',
  }, [
    h('span', { class: 'mono', style: 'flex: 1 1 auto; word-break: break-all;', text: `${s.bot_id}/${s.project}` }),
    h('span', { class: 'muted', style: 'flex: 0 0 auto;', text: `${s.items} items · ${fmtBytes(s.bytes)}${s.index_corrupt ? ' · ⚠ index corrupt' : ''}` }),
  ]));
  return h('div', { class: 'card' }, [
    h('h2', { class: 'page-title', style: 'font-size: 17px; margin: 0 0 4px;', text: 'Usage & quotas' }),
    kv('Total', `${u.total_items} items · ${fmtBytes(u.total_bytes)}`),
    kv('Owner budget', `${fmtBytes(u.total_bytes)} / ${fmtBytes(q.perOwnerBytes)} · ${fmtBytes(u.owner_bytes_remaining)} free`),
    kv('Per-scope caps', `${q.perScopeItems} items · ${fmtBytes(q.perScopeBytes)}`),
    scopeRows.length ? h('div', { style: 'margin-top: 8px;' }, scopeRows) : h('div', { class: 'muted', style: 'font-size: 12.5px; margin-top: 8px;', text: 'No stored memory yet.' }),
  ]);
}

function proposalsCard(body, data) {
  const proposals = data.proposals || [];
  const children = [
    h('h2', { class: 'page-title', style: 'font-size: 17px; margin: 0 0 4px;', text: `Pending proposals (${proposals.length})` }),
    h('div', { class: 'muted', style: 'font-size: 12.5px; margin-bottom: 8px;', text: 'These are suggested memories awaiting your review. Nothing here is stored until you approve it — approval seals the exact payload you see below.' }),
  ];
  if (!proposals.length) {
    children.push(h('div', { class: 'muted', style: 'font-size: 12.5px;', text: 'No proposals awaiting review.' }));
  }
  for (const p of proposals) children.push(proposalRow(body, p));
  return h('div', { class: 'card' }, children);
}

function proposalRow(body, p) {
  const err = h('div', { class: 'muted', style: 'color: var(--accent-danger); font-size: 12px; min-height: 16px;', role: 'alert' });
  const revealBtn = h('button', { onClick: onReveal }, ['Reveal (decrypt in browser)']);
  const approveBtn = h('button', { class: 'primary', disabled: true, onClick: onApprove }, ['Approve']);
  const rejectBtn = h('button', { onClick: onReject }, ['Reject']);
  const pre = h('pre', { class: 'mono', style: 'font-size: 12px; white-space: pre-wrap; word-break: break-word; background: hsl(var(--muted, 0 0% 96%)); padding: 8px; border-radius: 6px; margin: 8px 0;', text: 'Encrypted at rest — click “Reveal” to decrypt in your browser and verify what will be approved.' });

  // Reviewed plaintext (transient, in-memory only) and whether its canonical
  // hash matched the proposal's payload_sha256. Approval is gated on a match.
  let reviewedPlaintext = null;
  let hashVerified = false;

  function nip44Available() {
    return typeof window !== 'undefined' && window.nostr && window.nostr.nip44 && typeof window.nostr.nip44.decrypt === 'function';
  }

  async function onReveal() {
    err.textContent = '';
    if (!nip44Available()) {
      err.textContent = 'A NIP-44-capable Nostr signer (e.g. a browser extension) is required to decrypt this memory.';
      return;
    }
    revealBtn.disabled = true; revealBtn.textContent = 'Decrypting…';
    try {
      const pk = await window.nostr.getPublicKey();
      reviewedPlaintext = await window.nostr.nip44.decrypt(pk, p.ciphertext);
      let displayText = reviewedPlaintext;
      let payloadObj;
      try { payloadObj = JSON.parse(reviewedPlaintext); displayText = JSON.stringify(payloadObj, null, 2); } catch { payloadObj = undefined; }
      pre.textContent = displayText;
      // Verify the decrypted payload's canonical hash matches what the agent
      // stored, so an owner never approves a swapped/tampered ciphertext.
      if (payloadObj !== undefined) {
        const recomputed = await canonicalSha256Hex(payloadObj);
        hashVerified = recomputed === p.payload_sha256;
      } else {
        hashVerified = false;
      }
      if (!hashVerified) {
        err.textContent = '⚠ Decrypted payload does not match the reviewed hash — approval blocked. This proposal may be corrupt.';
        approveBtn.disabled = true;
      } else {
        approveBtn.disabled = false;
      }
    } catch (e) {
      err.textContent = `Could not decrypt: ${e.message || e}`;
    } finally {
      revealBtn.disabled = false; revealBtn.textContent = 'Reveal (decrypt in browser)';
    }
  }

  async function onApprove() {
    err.textContent = '';
    if (!hashVerified) { err.textContent = 'Reveal and verify the payload before approving.'; return; }
    approveBtn.disabled = true; approveBtn.textContent = 'Approving…';
    try {
      // Ciphertext is already sealed on the proposal; approval sends only the
      // reviewed hash + single-use nonce. No plaintext/ciphertext is re-sent.
      const r = await memoryApprove(p.id, {
        payload_sha256: p.payload_sha256, approval_nonce: p.approval_nonce,
      });
      if (!r.ok) { err.textContent = r.reason || 'Approval failed.'; return; }
      load(body);
    } catch (e) {
      err.textContent = `Approval failed: ${e.message || e}`;
    } finally {
      approveBtn.disabled = false; approveBtn.textContent = 'Approve';
    }
  }

  async function onReject() {
    err.textContent = '';
    rejectBtn.disabled = true;
    const r = await memoryReject(p.id, { approval_nonce: p.approval_nonce });
    rejectBtn.disabled = false;
    if (!r.ok) { err.textContent = r.reason || 'Reject failed.'; return; }
    load(body);
  }

  return h('div', { style: 'padding: 10px 0; border-top: 1px solid hsl(var(--border));' }, [
    h('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline;' }, [
      h('span', { class: 'pill', text: p.class }),
      h('span', { class: 'mono', style: 'font-size: 12.5px;', text: p.d_tag }),
      h('span', { class: 'muted', style: 'font-size: 12px;', text: `project ${p.project} · ${p.source}` }),
    ]),
    pre,
    h('div', { class: 'form-actions', style: 'display: flex; gap: 8px;' }, [revealBtn, approveBtn, rejectBtn]),
    err,
  ]);
}

function storedCard(body) {
  const wrap = h('div', { class: 'card' });
  const projectInput = h('input', { type: 'text', placeholder: 'project slug (blank = _global)', maxlength: '64', style: 'flex: 1 1 200px;', 'aria-label': 'Project slug' });
  const loadBtn = h('button', { onClick: refresh }, ['List']);
  const verifyBtn = h('button', { onClick: verify }, ['Verify integrity']);
  const listEl = h('div', { style: 'margin-top: 10px;' });
  const status = h('div', { class: 'muted', style: 'font-size: 12px; min-height: 16px;', role: 'status' });

  async function refresh() {
    status.textContent = 'Loading…'; clear(listEl);
    const project = projectInput.value.trim();
    const r = await memoryScoped({ project });
    status.textContent = '';
    if (!r.ok) { status.textContent = r.reason || 'Could not list memory.'; return; }
    const items = r.data?.items || [];
    if (r.data?.index_corrupt) status.textContent = '⚠ Index for this scope is flagged corrupt; underlying files are preserved.';
    if (!items.length) { listEl.appendChild(h('div', { class: 'muted', style: 'font-size: 12.5px;', text: 'No items in this scope.' })); return; }
    for (const it of items) listEl.appendChild(storedRow(it, project, refresh, status));
  }

  async function verify() {
    status.textContent = 'Verifying…';
    const r = await memoryVerify({ project: projectInput.value.trim() });
    if (!r.ok && r.reason) { status.textContent = r.reason; return; }
    const problems = r.data?.problems || r.problems || [];
    status.textContent = (r.data?.ok ?? r.ok) && !problems.length
      ? `Integrity OK (${r.data?.count ?? r.count ?? 0} items).`
      : `⚠ ${problems.length} integrity problem(s) found.`;
  }

  wrap.appendChild(h('h2', { class: 'page-title', style: 'font-size: 17px; margin: 0 0 4px;', text: 'Stored memory' }));
  wrap.appendChild(h('div', { class: 'muted', style: 'font-size: 12.5px; margin-bottom: 8px;', text: 'Metadata only — ciphertext never leaves the agent except via an explicit, signed export. Deletion removes the local encrypted file and writes a tombstone.' }));
  wrap.appendChild(h('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap;' }, [projectInput, loadBtn, verifyBtn]));
  wrap.appendChild(status);
  wrap.appendChild(listEl);
  return wrap;
}

function storedRow(it, project, refresh, status) {
  const delBtn = h('button', { onClick: onDelete, 'aria-label': `Delete ${it.d_tag}` }, ['Delete']);
  async function onDelete() {
    delBtn.disabled = true; delBtn.textContent = 'Deleting…';
    const r = await memoryDelete({ id: it.id, project, reason: 'owner-delete' });
    if (!r.ok) { status.textContent = r.reason || 'Delete failed.'; delBtn.disabled = false; delBtn.textContent = 'Delete'; return; }
    refresh();
  }
  return h('div', { style: 'display: flex; gap: 10px; align-items: center; padding: 6px 0; border-top: 1px solid hsl(var(--border));' }, [
    h('span', { class: 'pill', style: 'flex: 0 0 auto;', text: it.class }),
    h('span', { class: 'mono', style: 'flex: 1 1 auto; font-size: 12.5px; word-break: break-all;', text: it.d_tag }),
    h('span', { class: 'muted', style: 'flex: 0 0 auto; font-size: 11.5px;', text: `${it.sha256 ? it.sha256.slice(0, 10) : ''}` }),
    delBtn,
  ]);
}

function quarantineCard(body, data) {
  const items = data.items || [];
  const children = [
    h('h2', { class: 'page-title', style: 'font-size: 17px; margin: 0 0 4px;', text: `Import quarantine (${items.length})` }),
    h('div', { class: 'muted', style: 'font-size: 12.5px; margin-bottom: 8px;', text: 'Imported items are held here, sealed and untrusted, until you approve them into live memory. Nothing imported is trusted automatically.' }),
  ];
  if (!items.length) children.push(h('div', { class: 'muted', style: 'font-size: 12.5px;', text: 'Nothing in quarantine.' }));
  for (const it of items) children.push(quarantineRow(body, it));
  return h('div', { class: 'card' }, children);
}

function quarantineRow(body, it) {
  const err = h('div', { class: 'muted', style: 'color: var(--accent-danger); font-size: 12px; min-height: 14px;', role: 'alert' });
  const approveBtn = h('button', { class: 'primary', onClick: onApprove }, ['Approve into memory']);
  const rejectBtn = h('button', { onClick: onReject }, ['Discard']);
  async function onApprove() {
    err.textContent = ''; approveBtn.disabled = true;
    const r = await memoryQuarantineApprove(it.sha256, { sha256: it.sha256, project: it.project, d_tag: it.d_tag });
    approveBtn.disabled = false;
    if (!r.ok) { err.textContent = r.reason || 'Approve failed.'; return; }
    load(body);
  }
  async function onReject() {
    err.textContent = ''; rejectBtn.disabled = true;
    const r = await memoryQuarantineReject(it.sha256);
    rejectBtn.disabled = false;
    if (!r.ok) { err.textContent = r.reason || 'Discard failed.'; return; }
    load(body);
  }
  return h('div', { style: 'padding: 8px 0; border-top: 1px solid hsl(var(--border));' }, [
    h('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline;' }, [
      h('span', { class: 'pill', text: it.class }),
      h('span', { class: 'mono', style: 'font-size: 12.5px;', text: it.d_tag }),
      h('span', { class: 'muted', style: 'font-size: 11.5px;', text: `project ${it.project || '_global'} · ${it.sha256.slice(0, 10)}` }),
    ]),
    h('div', { class: 'form-actions', style: 'display: flex; gap: 8px; margin-top: 6px;' }, [approveBtn, rejectBtn]),
    err,
  ]);
}

function portabilityCard(body) {
  const status = h('div', { class: 'muted', style: 'font-size: 12px; min-height: 16px; margin-top: 8px;', role: 'status' });
  const exportBtn = h('button', { class: 'primary', onClick: onExport }, ['Export (sign & download)']);
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Import memory bundle', style: 'font-size: 12.5px;' });
  const importBtn = h('button', { onClick: onImport }, ['Import bundle']);

  async function onExport() {
    status.textContent = '';
    if (!(typeof window !== 'undefined' && window.nostr && typeof window.nostr.signEvent === 'function')) {
      status.textContent = 'A NIP-07 Nostr signer is required to sign the export.';
      return;
    }
    exportBtn.disabled = true; exportBtn.textContent = 'Assembling…';
    try {
      const r = await memoryExport();
      if (!r.ok) { status.textContent = r.reason || 'Export failed.'; return; }
      const bundle = r.data?.bundle;
      const digest = r.data?.sign_target?.manifest_digest;
      if (!bundle || !digest) { status.textContent = 'Malformed export response.'; return; }
      status.textContent = 'Sign the manifest in your signer…';
      const sig = await window.nostr.signEvent({
        kind: BUNDLE_SIG_KIND, created_at: Math.floor(Date.now() / 1000),
        tags: [['x', digest]], content: digest,
      });
      bundle.signature = sig;
      downloadJson(bundle, `torii-memory-bundle-${digest.slice(0, 12)}.json`);
      status.textContent = 'Bundle signed and downloaded. Keep it safe — it contains only ciphertexts, but they are still yours.';
    } catch (e) {
      status.textContent = `Export failed: ${e.message || e}`;
    } finally {
      exportBtn.disabled = false; exportBtn.textContent = 'Export (sign & download)';
    }
  }

  async function onImport() {
    status.textContent = '';
    const f = fileInput.files && fileInput.files[0];
    if (!f) { status.textContent = 'Choose a bundle JSON file first.'; return; }
    importBtn.disabled = true; importBtn.textContent = 'Verifying…';
    try {
      const text = await f.text();
      let bundle;
      try { bundle = JSON.parse(text); } catch { status.textContent = 'That file is not valid JSON.'; return; }
      const r = await memoryImport(bundle);
      if (!r.ok) { status.textContent = `Rejected: ${r.reason || 'invalid bundle'}`; return; }
      status.textContent = `Verified. Quarantined ${r.data?.quarantined ?? 0}, skipped ${r.data?.duplicate ?? 0} duplicate(s). Review them in Import quarantine above.`;
      load(body);
    } catch (e) {
      status.textContent = `Import failed: ${e.message || e}`;
    } finally {
      importBtn.disabled = false; importBtn.textContent = 'Import bundle';
    }
  }

  return h('div', { class: 'card' }, [
    h('h2', { class: 'page-title', style: 'font-size: 17px; margin: 0 0 4px;', text: 'Portability (manual, encrypted, owner-signed)' }),
    h('div', { class: 'muted', style: 'font-size: 12.5px; margin-bottom: 8px;', text: 'Export bundles CIPHERTEXTS ONLY; you sign its manifest in your own signer, and it downloads to your device. Nothing is published to a relay and no private key ever leaves your browser. Import verifies the signature, exact owner, and every hash before quarantining — foreign or tampered bundles are rejected.' }),
    h('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; align-items: center;' }, [exportBtn]),
    h('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px;' }, [fileInput, importBtn]),
    status,
  ]);
}

// ─── helpers ─────────────────────────────────────────────────

// Canonical serialization mirroring agent/lib/constitution.mjs canonicalize():
// JSON.stringify over deeply key-sorted values. Must match byte-for-byte so a
// browser-recomputed payload hash equals the agent's stored payload_sha256.
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

export function canonicalize(value) {
  return JSON.stringify(sortDeep(value));
}

/** SHA-256 hex of the canonical serialization of `value` (browser WebCrypto). */
export async function canonicalSha256Hex(value) {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Seal a proposed payload for a ciphertext-only proposal. Encrypts the payload
 * with NIP-44 v2 to the owner's OWN key and returns { ciphertext, payload_sha256 }.
 * Callers post exactly this to memoryPropose() — plaintext never leaves here.
 */
export async function sealProposalPayload(payload) {
  const pk = await window.nostr.getPublicKey();
  const plaintext = JSON.stringify(payload);
  const ciphertext = await window.nostr.nip44.encrypt(pk, plaintext);
  const payload_sha256 = await canonicalSha256Hex(payload);
  return { ciphertext, payload_sha256 };
}

function kv(k, v) {
  return h('div', { style: 'display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid hsl(var(--border));' }, [
    h('span', { class: 'muted', style: 'flex: 0 0 150px; font-size: 12.5px;', text: k }),
    h('span', { class: 'mono', style: 'font-size: 12.5px; word-break: break-all;', text: String(v) }),
  ]);
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KiB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MiB`;
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
