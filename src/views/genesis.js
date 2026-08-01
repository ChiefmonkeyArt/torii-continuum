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
import { constitution, genesisRead, genesisCreate, genesisAcknowledgeConstitution } from '../data/agent.js';
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
    const upgrade = data.constitution_upgrade;
    const offerUpgrade = !!(upgrade && upgrade.upgrade_available && con);
    if (offerUpgrade) body.appendChild(upgradeCard(upgrade, con, () => load(body)));
    // Normally the covenant is summarised (the owner already agreed to it). While
    // an adoption is on offer it is expanded in full: consenting to a version
    // whose text is not on screen is not consent.
    if (con) body.appendChild(constitutionCard(con, { compact: !offerUpgrade }));
    if (con && con.layers) body.appendChild(layersCard(con.layers));
    return;
  }

  // No manifest yet — show the creation form and the full constitution preview.
  body.appendChild(createForm(body, con));
  if (con) body.appendChild(constitutionCard(con, { compact: false }));
  if (con && con.layers) body.appendChild(layersCard(con.layers));
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
    ['Born under', `${m.constitution?.version} · ${String(m.constitution?.digest || '').slice(0, 12)}…`],
    // The covenant actually in force. Absent until the owner adopts a newer one,
    // in which case the birth row above is preserved untouched beside it.
    ['Covenant in force', m.constitution?.acknowledged_version
      ? `${m.constitution.acknowledged_version} · ${String(m.constitution.acknowledged_digest || '').slice(0, 12)}… (adopted)`
      : `${m.constitution?.version} · as born`],
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

  // Covenant currency: a bot born under an earlier-but-valid constitution version
  // is honest provenance, NOT tampering. Only shown when the pin is valid (conOk)
  // but no longer current AND the owner has already adopted the current text —
  // otherwise the upgrade card says all of this and offers the action, so
  // repeating it here would only be noise.
  let currencyNote = null;
  const upgrade = data.constitution_upgrade;
  if (conOk && data.constitution_is_current === false && data.constitution_current_version && upgrade?.is_current) {
    currencyNote = h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 6px;', text: `This bot was born under constitution ${m.constitution?.version} and has since adopted ${data.constitution_current_version}. The birth covenant is preserved and pinned, never rewritten — both remain verifiable.` });
  }

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
  if (currencyNote) children.push(currencyNote);

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

// ─── Covenant upgrade / acknowledgement ─────────────────────
//
// A bot already alive under an earlier covenant is NOT silently rebound to a
// newer one: adopting text its owner never agreed to would be exactly the
// unconsented change explicit-command-only exists to prevent. So adoption is an
// explicit owner act, taken here, against the version + digest displayed on this
// page — the agent refuses if that pair is not the bytes it holds.
//
// The single exception is the safety floor. Those rules can only ever cause the
// bot to REFUSE — never to act, spend, publish or retain — so withholding them
// pending a click would leave existing bots permitted to do the very thing the
// rule forbids. They bind immediately and are labelled as already in force.

/** Human labels for rule ids. Falls back to the machine `rule`/`id` on anything new. */
const RULE_LABELS = {
  'selective-revelation': 'Selective revelation',
  'verify-dont-trust': 'Verify, don’t trust',
  'four-freedoms-forkable': 'Four freedoms & forkability',
  'no-credential-custody': 'No credential or key custody',
  'pareto-focus': 'Pareto focus (80/20)',
};

function ruleLabel(r) {
  return RULE_LABELS[r?.id] || r?.rule || r?.id || 'Rule';
}

function upgradeCard(upgrade, con, reload) {
  const c = con.constitution || {};
  const allRules = [
    ...(Array.isArray(c.invariants) ? c.invariants : []),
    ...(Array.isArray(c.operating_rules) ? c.operating_rules : []),
  ];
  const byId = new Map(allRules.map((r) => [r.id, r]));
  const names = (ids) => (Array.isArray(ids) ? ids : []).map((id) => ruleLabel(byId.get(id) || { id }));

  const errorEl = h('div', { class: 'muted', style: 'color: var(--accent-danger); min-height: 18px; font-size: 12.5px; margin-top: 8px;', role: 'alert' });
  const btn = h('button', { class: 'primary', onClick: adopt }, [`Adopt constitution ${upgrade.current_version}`]);

  async function adopt() {
    errorEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Adopting…';
    // Send the pair the owner was SHOWN, not the pair the agent believes is
    // current — a mismatch must fail rather than quietly consent to other bytes.
    const r = await genesisAcknowledgeConstitution({ version: con.version, digest: con.digest });
    btn.disabled = false;
    btn.textContent = `Adopt constitution ${upgrade.current_version}`;
    if (!r.ok) {
      errorEl.textContent = r.data?.reason || r.reason || 'Could not record acknowledgement.';
      return;
    }
    reload();
  }

  const children = [
    h('div', { style: 'display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;' }, [
      h('h2', { class: 'page-title', style: 'font-size: 17px; margin: 0;', text: 'A newer covenant is available' }),
      h('span', { class: 'mono muted', style: 'font-size: 12px;', text: `${upgrade.active_version || upgrade.pinned_version || 'unknown'} → ${upgrade.current_version}` }),
    ]),
    h('div', { class: 'muted', style: 'font-size: 12.5px; margin: 6px 0 4px;', text: 'Your bot stays bound to the covenant it is on until you adopt this one. Nothing changes without this explicit act, and the version it was born under is preserved either way — adoption is recorded alongside it, never over it.' }),
  ];

  if (!upgrade.known_pinned_version) {
    children.push(h('div', { class: 'muted', style: 'font-size: 12.5px; color: var(--accent-danger); margin: 4px 0;', text: `This bot pins constitution ${upgrade.pinned_version || '(none)'}, whose text this agent does not hold. That is not something we can show you, so treat the pin as unverifiable.` }));
  }

  const floor = names(upgrade.safety_floor_rule_ids);
  if (floor.length) {
    children.push(h('div', { class: 'muted', style: 'font-size: 12px; font-weight: 600; margin: 12px 0 2px; text-transform: uppercase; letter-spacing: 0.04em;', text: 'Already binding — safety floor' }));
    children.push(h('div', { class: 'muted', style: 'font-size: 12.5px;', text: `${floor.join(' · ')} — in force on every bot regardless of covenant version, because these rules can only cause a refusal, never an action.` }));
  }

  const newly = names(upgrade.newly_binding_rule_ids);
  children.push(h('div', { class: 'muted', style: 'font-size: 12px; font-weight: 600; margin: 12px 0 2px; text-transform: uppercase; letter-spacing: 0.04em;', text: 'Would newly bind on adoption' }));
  children.push(h('div', { class: 'muted', style: 'font-size: 12.5px;', text: newly.length ? newly.join(' · ') : 'No new rules — this version revises existing wording only.' }));

  children.push(h('div', { class: 'mono muted', style: 'font-size: 11.5px; margin-top: 10px; word-break: break-all;', text: `adopting ${con.version} · digest ${con.digest}` }));
  children.push(h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 4px;', text: 'The full text of this version is shown below. Read it before adopting.' }));
  children.push(h('div', { class: 'form-actions', style: 'margin-top: 12px;' }, [btn]));
  children.push(errorEl);

  return h('div', { class: 'card' }, children);
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

  // Layer-A sovereignty invariants (added in genesis-1.1.0) and the operating
  // rules (added in genesis-1.2.0). Rendered the same way as the humanitarian
  // articles — textContent only, no raw HTML.
  const invariants = Array.isArray(c.invariants) ? c.invariants : [];
  if (invariants.length && !compact) {
    children.push(sectionHeading('Sovereignty invariants'));
    for (const inv of invariants) children.push(ruleRow(inv));
  }

  // Kept a distinct section, not folded into the invariants, because an
  // operating rule is a priority heuristic rather than a sovereignty guarantee —
  // and this one explicitly yields to every duty above it.
  const operating = Array.isArray(c.operating_rules) ? c.operating_rules : [];
  if (operating.length && !compact) {
    children.push(sectionHeading('Operating rules'));
    for (const r of operating) children.push(ruleRow(r));
  }

  return h('div', { class: 'card' }, children);
}

function sectionHeading(text) {
  return h('div', { class: 'muted', style: 'font-size: 12px; font-weight: 600; margin: 12px 0 2px; text-transform: uppercase; letter-spacing: 0.04em;', text });
}

function ruleRow(r) {
  const title = h('div', { style: 'display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 2px;' }, [
    h('span', { style: 'font-size: 13px; font-weight: 600;', text: ruleLabel(r) }),
    // A floor rule binds every bot immediately, even one born under an older
    // covenant, so say so here rather than only on the upgrade card.
    r.safety_floor ? h('span', { class: 'pill', style: 'font-size: 11px;', title: 'Binds every bot immediately, on any constitution version', text: 'safety floor' }) : null,
  ]);
  return h('div', { style: 'padding: 8px 0; border-top: 1px solid hsl(var(--border));' }, [
    title,
    r.statement ? h('div', { class: 'muted', style: 'font-size: 12.5px;', text: r.statement }) : null,
  ]);
}

// ─── Layered principles provenance (Layer B + Layer C) ──────
//
// Surfaces WHERE the operational rules (Code of Practice, Layer B) and the
// attributed influences (Reference Canon, Layer C) live, plus the normative
// hierarchy used to resolve conflicts. Everything is rendered via textContent —
// doc paths are shown as plain text, NOT as clickable/navigable links, so no
// external-navigation or XSS surface is added.

const HIERARCHY_LABELS = {
  law_safety_hard_refusal_of_clear_harm: 'Law, safety & hard refusal of clear harm',
  owner_authority: 'Owner authority',
  consent_and_privacy: 'Consent & privacy',
  humanitarian_care: 'Humanitarian care',
  operational_preferences: 'Operational preferences (Code of Practice)',
  advisory_references: 'Advisory references (Reference Canon)',
};

function layersCard(layers) {
  const b = layers.b_code_of_practice || {};
  const c = layers.c_reference_canon || {};
  const hierarchy = Array.isArray(layers.normative_hierarchy) ? layers.normative_hierarchy : [];

  const layerRow = (tag, title, meta) => h('div', {
    style: 'display: flex; gap: 12px; padding: 8px 0; border-top: 1px solid hsl(var(--border)); align-items: baseline;',
  }, [
    h('span', { class: 'pill', style: 'flex: 0 0 auto;', text: tag }),
    h('div', {}, [
      h('div', { style: 'font-size: 13px; font-weight: 600;', text: title }),
      h('div', { class: 'mono muted', style: 'font-size: 11.5px; word-break: break-all;', text: meta }),
    ]),
  ]);

  const hierarchyItems = hierarchy.map((key, i) => h('li', {
    class: 'muted', style: 'font-size: 12.5px; margin-bottom: 2px;',
    text: `${i + 1}. ${HIERARCHY_LABELS[key] || key}`,
  }));

  return h('div', { class: 'card' }, [
    h('h2', { class: 'page-title', style: 'font-size: 17px; margin: 0 0 4px;', text: 'Layered principles' }),
    h('div', { class: 'muted', style: 'font-size: 12.5px; margin-bottom: 6px;', text: 'The constitution above is Layer A — minimal, machine-enforceable invariants. Operational rules and attributed influences live in two further layers, shown here for provenance (see these docs in the repository).' }),
    layerRow('Layer A', layers.a_constitution?.title || 'Genesis constitutional invariants', `enforceable · ${layers.a_constitution?.version || ''}`),
    layerRow('Layer B', b.title || 'Sovereign AI Code of Practice', `${b.doc || ''} · ${b.version || ''}`),
    layerRow('Layer C', c.title || 'Sovereign AI Reference Canon', `${c.doc || ''} · ${c.version || ''} · non-binding`),
    h('div', { class: 'muted', style: 'font-size: 12px; font-weight: 600; margin: 14px 0 4px; text-transform: uppercase; letter-spacing: 0.04em;', text: 'Conflict resolution — normative hierarchy (highest first)' }),
    h('ol', { style: 'margin: 0; padding-left: 18px;' }, hierarchyItems),
  ]);
}
