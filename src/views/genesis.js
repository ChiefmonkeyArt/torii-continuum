/**
 * Genesis view — the sovereign bot birth certificate (GENESIS-1).
 *
 * An authenticated owner creates their bot ONCE here. The manifest binds the bot
 * to the owner's verified Nostr pubkey (supplied server-side from the session —
 * this form NEVER sends a pubkey), pins the humanitarian constitution version +
 * digest it was born under, and records the explicit-command-only default.
 *
 * HONESTY BOUNDARY. LoRA training and RAG retrieval are labelled here as
 * subsequent stages and are NOT faked. Provenance shows their status as
 * "not-started". The constitution cannot be made literally unalterable by the
 * machine owner; what this surface provides is visible provenance, a stable
 * published digest, tamper-evidence checks, and default-deny semantics.
 *
 * Rendering is via the XSS-safe h() builder (textContent only, no raw HTML),
 * matching team.js. All agent state is fetched through src/data/agent.js.
 */
import { h, clear } from './util.js';
import { shortNpub } from '../lib/npub.js';
import { constitution, genesisRead, genesisCreate } from '../data/agent.js';
import { setChatContext } from '../chat.js';

export function renderGenesis(mount) {
  setChatContext({ label: 'Genesis', where: 'genesis' });
  clear(mount);

  const header = h('div', { class: 'page-header' }, [
    h('div', {}, [
      h('p', { class: 'eyebrow', text: 'Sovereignty' }),
      h('h1', { class: 'page-title', text: 'Genesis' }),
      h('div', { class: 'page-sub', text: 'Bring your sovereign bot to life — owner-bound, under the humanitarian constitution.' }),
    ]),
  ]);
  mount.appendChild(header);

  const body = h('div', { style: 'display: flex; flex-direction: column; gap: 16px;' });
  mount.appendChild(body);

  body.appendChild(h('div', { class: 'muted', style: 'font-size: 13px;', text: 'Loading genesis state…' }));

  load(body);
}

async function load(body) {
  const [genRes, conRes] = await Promise.all([genesisRead(), constitution()]);
  clear(body);

  if (genRes.offline || (!genRes.ok && genRes.reason === 'offline')) {
    body.appendChild(offlineCard());
    return;
  }
  if (!genRes.ok && genRes.status === 401) {
    body.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'muted', style: 'font-size: 13px;', text: 'Your session has expired. Sign in again to view or create your genesis manifest.' }),
    ]));
    return;
  }

  const data = genRes.data || {};
  const con = conRes.ok ? conRes.data : null;

  if (data.exists && data.manifest) {
    body.appendChild(provenanceCard(data));
    if (con) body.appendChild(constitutionCard(con, { compact: true }));
    return;
  }

  // No manifest yet — show the creation form and the full constitution preview.
  body.appendChild(createForm(body, con));
  if (con) body.appendChild(constitutionCard(con, { compact: false }));
}

function offlineCard() {
  return h('div', { class: 'card' }, [
    h('h2', { class: 'page-title', style: 'font-size: 18px; margin: 0 0 6px;', text: 'Agent offline' }),
    h('div', { class: 'muted', style: 'font-size: 13px;', text: 'Genesis requires a live agent daemon. This demo build has no agent behind it, so a bot cannot be created here.' }),
  ]);
}

// ─── Creation ───────────────────────────────────────────────

function createForm(body, con) {
  const nameInput = h('input', { type: 'text', placeholder: 'Display name (required)', maxlength: '80', style: 'flex: 1 1 260px;' });
  const archInput = h('input', { type: 'text', placeholder: 'Archetype (optional) — e.g. “research companion”', maxlength: '60', style: 'flex: 1 1 260px;' });
  const intentInput = h('textarea', { placeholder: 'Creative intent (optional) — what is this bot for?', maxlength: '2000', rows: '4', style: 'width: 100%; resize: vertical; font: inherit;' });
  const errorEl = h('div', { class: 'muted', style: 'color: var(--accent-danger); min-height: 18px; font-size: 12.5px; margin-top: 6px;', role: 'alert' });

  const submitBtn = h('button', { class: 'primary', onClick: submit }, ['Create sovereign bot']);

  async function submit() {
    errorEl.textContent = '';
    const displayName = nameInput.value.trim();
    if (!displayName) {
      errorEl.textContent = 'Display name is required.';
      nameInput.focus();
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';
    const r = await genesisCreate({
      display_name: displayName,
      archetype: archInput.value.trim(),
      creative_intent: intentInput.value.trim(),
    });
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create sovereign bot';
    if (!r.ok) {
      errorEl.textContent = r.data?.reason || r.reason || 'Could not create genesis manifest.';
      return;
    }
    // Re-render from authoritative agent state (idempotent read).
    load(body);
  }

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  const conNote = con
    ? `Your bot will be born under constitution ${con.version} (digest ${con.digest.slice(0, 12)}…).`
    : 'Your bot will be born under the current humanitarian constitution.';

  return h('div', { class: 'card' }, [
    h('h2', { class: 'page-title', style: 'font-size: 18px; margin: 0 0 4px;', text: 'Create your sovereign bot' }),
    h('div', { class: 'muted', style: 'font-size: 13px; margin-bottom: 4px;', text: 'This is a one-time act. Your bot is bound to your verified Nostr identity — the owner key is taken from your signed-in session, never typed here.' }),
    h('div', { class: 'muted', style: 'font-size: 12.5px; margin-bottom: 14px;', text: conNote }),
    h('div', { style: 'display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px;' }, [nameInput, archInput]),
    intentInput,
    h('div', { class: 'muted', style: 'font-size: 12px; margin: 12px 0 4px;', text: 'Defaults at birth: owner-bound · explicit-command-only · default-deny. LoRA training and RAG memory are subsequent stages — they are not active at genesis.' }),
    h('div', { class: 'form-actions', style: 'margin-top: 12px;' }, [submitBtn]),
    errorEl,
  ]);
}

// ─── Provenance ─────────────────────────────────────────────

function provenanceCard(data) {
  const m = data.manifest;
  const conOk = data.constitution_ok === true;
  const digestOk = data.manifest_digest_ok === true;

  const rows = [
    ['Bot ID', m.bot_id],
    ['Owner', shortNpub(m.owner?.npub || m.owner?.pubkey_hex || '')],
    ['Display name', m.display_name || '—'],
    ['Archetype', m.archetype || '—'],
    ['Constitution', `${m.constitution?.version} · ${String(m.constitution?.digest || '').slice(0, 12)}…`],
    ['Command mode', m.policy?.command_mode || '—'],
    ['Created', m.created_at_iso || (m.created_at ? new Date(m.created_at * 1000).toISOString() : '—')],
  ];

  const detailRows = rows.map(([k, v]) => h('div', {
    style: 'display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px solid hsl(var(--border));',
  }, [
    h('span', { class: 'muted', style: 'flex: 0 0 130px; font-size: 12.5px;', text: k }),
    h('span', { class: 'mono', style: 'font-size: 12.5px; word-break: break-all;', text: String(v) }),
  ]));

  const badges = h('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 4px;' }, [
    tamperBadge('Constitution digest', conOk),
    tamperBadge('Manifest digest', digestOk),
  ]);

  const intent = m.creative_intent
    ? h('div', { style: 'margin: 12px 0 4px;' }, [
        h('div', { class: 'muted', style: 'font-size: 12px; margin-bottom: 4px;', text: 'Creative intent' }),
        h('div', { style: 'font-size: 13px; white-space: pre-wrap;', text: m.creative_intent }),
      ])
    : null;

  const stageNote = h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 14px;', text: `Provenance stage: ${m.provenance?.stage || 'genesis-1'} · LoRA: ${m.provenance?.lora || 'not-started'} · RAG: ${m.provenance?.rag || 'not-started'}. These are subsequent stages and are not active yet.` });

  const children = [
    h('div', { style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap;' }, [
      h('h2', { class: 'page-title', style: 'font-size: 18px; margin: 0;', text: m.display_name || 'Your sovereign bot' }),
      h('span', { class: 'pill', text: 'Active' }),
    ]),
    h('div', { class: 'muted', style: 'font-size: 13px; margin: 4px 0 6px;', text: 'This bot is alive and bound to your Nostr identity. Its birth certificate is below.' }),
    badges,
    h('div', { style: 'margin-top: 8px;' }, detailRows),
  ];
  if (intent) children.push(intent);
  children.push(stageNote);

  return h('div', { class: 'card' }, children);
}

function tamperBadge(label, ok) {
  return h('span', {
    class: 'badge',
    style: `font-size: 11.5px; color: ${ok ? 'var(--accent-ok, #2e9e6b)' : 'var(--accent-danger)'};`,
    title: ok ? 'Digest matches — no tampering detected' : 'Digest mismatch — tamper evidence',
    text: `${ok ? '✓' : '✕'} ${label}`,
  });
}

// ─── Constitution preview ───────────────────────────────────

function constitutionCard(con, { compact }) {
  const c = con.constitution || {};
  const articles = Array.isArray(c.articles) ? c.articles : [];

  const children = [
    h('div', { style: 'display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;' }, [
      h('h2', { class: 'page-title', style: 'font-size: 17px; margin: 0;', text: 'Humanitarian constitution' }),
      h('span', { class: 'mono muted', style: 'font-size: 12px;', text: `${con.version}` }),
    ]),
    h('div', { class: 'mono muted', style: 'font-size: 11.5px; margin: 2px 0 10px; word-break: break-all;', text: `digest ${con.digest}` }),
  ];

  if (!compact) {
    children.push(h('div', { class: 'muted', style: 'font-size: 12.5px; margin-bottom: 12px;', text: 'This is the deterministic, versioned covenant every bot is born under. Its digest is published so anyone can verify what the bot committed to. It cannot be made literally unalterable by the machine owner — what it provides is visible provenance, tamper evidence, and default-deny.' }));
    if (c.preamble) {
      children.push(h('div', { style: 'font-size: 12.5px; font-style: italic; margin-bottom: 8px;', text: c.preamble }));
    }
  }

  for (const a of articles) {
    const title = a.tenet || a.id || 'Article';
    const text = a.intent || '';
    children.push(h('div', { style: 'padding: 8px 0; border-top: 1px solid hsl(var(--border));' }, [
      h('div', { style: 'font-size: 13px; font-weight: 600; margin-bottom: 2px;', text: title }),
      text ? h('div', { class: 'muted', style: 'font-size: 12.5px;', text }) : null,
    ]));
  }

  return h('div', { class: 'card' }, children);
}
