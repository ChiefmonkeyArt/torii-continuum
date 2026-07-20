/** Routstr page — connect, Cashu pay, model picker, usage stats.
 *  All UI-only for MVP; wire real endpoint later.
 */
import { h, clear, formatSats, openModal } from './util.js';
import * as store from '../data/store.js';
import { getRoutstr, updateRoutstr } from '../data/store.js';
import { setChatContext } from '../chat.js';
import {
  walletBalance, walletReceive, isAgentConfigured,
  walletMintQuote, walletMintQuoteStatus, walletNwcInvoice, walletNwcInvoiceStatus,
  nwcStatus, nwcConnect, nwcTest, nwcDisconnect,
} from '../data/agent.js';
import { renderQR } from './qr.js';
import { isSessionLive, startLogin } from '../auth.js';
import { isDemo, demoSource, demoBanner, demoIntercept } from '../demo/demo-mode.js';

// Lightning-QR top-up (v0.2.83-alpha). Preset amounts, default, and the hard
// client-side cap. The agent independently re-enforces cashu.max_mint_sats, so
// this cap is only a UX guard against fat-fingered amounts.
const TOPUP_PRESETS = [500, 1000, 5000, 21000];
const TOPUP_DEFAULT_SATS = 1000;
const TOPUP_MAX_SATS = 100_000;
// Poll the invoice every 2s; regenerate/expire the QR after this fallback when
// the agent reports no explicit expiry.
const TOPUP_POLL_MS = 2000;
const TOPUP_FALLBACK_EXPIRY_SEC = 600;

// The chat dock sets this sessionStorage flag before navigating here so the
// operator lands straight on the Cashu receive form after tapping "Top Up".
const FOCUS_TOPUP_KEY = 'continuum.routstr.focusTopUp';

// Poll the agent for live wallet balance while the Routstr page is mounted.
let balancePollHandle = null;
// Live handle to the balance number node so the poll can refresh it in place
// without re-rendering (and tearing) the whole page.
let balanceNumEl = null;
// Live handles to the inline Cashu receive/top-up form so the "Top Up" button
// (here and from the chat dock) can reveal + focus it without a re-render.
let topUpSectionEl = null;
let topUpInputEl = null;

/**
 * Read the spendable balance (sats) out of an agent balance payload.
 *
 * The admin `/api/wallet/balance` route returns `{ total_sats, per_mint, ... }`,
 * NOT `balance_sats` — reading the wrong key silently yielded `undefined`, which
 * `formatSats` renders as an em dash while the connection pill still showed
 * "connected" (the v0.2.48 live regression). We prefer `total_sats` and keep a
 * `balance_sats` fallback so an onboarding-shaped payload also resolves. Pure +
 * exported so the contract is unit-tested without a network.
 * @param {any} data parsed response body
 * @returns {number|null} sats, or null when the payload carries no numeric balance
 */
export function readBalanceSats(data) {
  if (!data || typeof data !== 'object') return null;
  if (Number.isFinite(data.total_sats)) return data.total_sats;
  if (Number.isFinite(data.balance_sats)) return data.balance_sats;
  return null;
}

export function renderRoutstr(mount, opts = {}) {
  const demo = isDemo(opts);
  const S = demoSource(opts, store);
  setChatContext({ label: 'Routstr', where: 'routstr' });
  clear(mount);

  const r = S.getRoutstr();
  const c = r.content;
  // A demo visitor is signed out, so live is false and no poll/network runs;
  // the extra `!demo` guard keeps that explicit even if the fixtures ever flip
  // a connected flag.
  const live = !demo && isSessionLive();

  if (demo) mount.appendChild(demoBanner());

  // Kick off (or refresh) live balance polling when logged in.
  if (live) startBalancePoll(mount);
  else stopBalancePoll();

  const header = h('div', { class: 'page-header' }, [
    h('div', {}, [
      h('h1', { class: 'page-title', text: 'Routstr' }),
      h('div', { class: 'page-sub', text: 'Pay-per-request AI over Cashu. Pick your model, load a mint, route requests through nostr-native infra.' }),
    ]),
    h('div', { class: 'page-actions' }, [
      c.connected
        ? h('button', { onClick: demoIntercept(demo, disconnect) }, ['Disconnect'])
        : h('button', { class: 'primary', onClick: demoIntercept(demo, connect) }, ['Connect Cashu wallet']),
    ]),
  ]);
  mount.appendChild(header);

  // Two matching horizontal wallet cards: Cashu (left) + NWC (right).
  const walletCards = h('div', { class: 'grid-2' }, [
    renderCashuCard(c, demo),
    renderNwcCard(live, demo),
  ]);
  mount.appendChild(walletCards);

  mount.appendChild(h('div', { style: 'height: 16px' }));

  // Grid: model list + usage
  const grid = h('div', { class: 'grid-2' }, [
    renderModelPicker(c, demo),
    renderUsage(c),
  ]);
  mount.appendChild(grid);

  mount.appendChild(h('div', { style: 'height: 16px' }));

  // Endpoint + advanced
  const settings = h('div', { class: 'card' }, [
    h('h3', { text: 'Endpoint' }),
    h('p', { class: 'muted', text: 'Point Continuum at any Routstr-compatible endpoint. Default is api.routstr.com.' }),
    h('div', { class: 'form-row' }, [
      h('label', { text: 'Routstr URL' }),
      (() => {
        const inp = h('input', { type: 'text', value: c.endpoint });
        inp.addEventListener('change', demoIntercept(demo, () => updateRoutstr({ endpoint: inp.value.trim() || 'https://api.routstr.com' })));
        return inp;
      })(),
    ]),
    h('div', { class: 'form-row' }, [
      h('label', { text: 'Monthly Cashu budget (sats)' }),
      (() => {
        const inp = h('input', { type: 'number', value: c.usage.monthlyBudget, min: 0, step: 1000 });
        inp.addEventListener('change', demoIntercept(demo, () => updateRoutstr({ usage: { ...c.usage, monthlyBudget: Math.max(0, parseInt(inp.value || '0', 10)) } })));
        return inp;
      })(),
    ]),
  ]);
  mount.appendChild(settings);

  // If we arrived here from the chat dock's "Top Up" button, reveal + focus the
  // Cashu receive form so funding is one paste away. Never in demo (no session).
  if (!demo) maybeFocusTopUp();
}

// ─── Card 1: Cashu / Routstr balance ────────────────────────────────────────

function renderCashuCard(c, demo) {
  balanceNumEl = h('span', { class: 'bal-num', text: formatSats(c.cashuBalanceSats) });

  const hero = h('div', { class: 'routstr-hero' }, [
    h('div', { class: 'routstr-avatar', text: '⚡' }),
    h('div', { style: 'flex: 1;' }, [
      h('div', {}, [
        h('span', { class: c.connected ? 'pill ok' : 'pill', text: c.connected ? 'connected' : 'not connected' }),
        ' ',
        h('span', { class: 'mono muted', text: c.endpoint }),
      ]),
      h('div', { style: 'margin-top: 8px;', class: 'muted', text: c.connected
        ? 'Cashu tokens are loaded locally and burned per request. No account, no key custody.'
        : 'Connect a Cashu wallet (mock) to enable pay-per-request. Nothing is sent to the network yet.' }),
    ]),
    h('div', { class: 'stat' }, [
      h('span', { class: 'label', text: 'Cashu balance' }),
      h('span', { class: 'value' }, [
        balanceNumEl,
        ' ',
        h('span', { class: 'unit', text: 'sats' }),
      ]),
    ]),
  ]);

  const topUpBtn = h('button', { class: 'primary', onClick: demoIntercept(demo, () => toggleTopUp(true)) }, ['Top Up']);

  return h('div', { class: 'card hot' }, [
    h('h3', { text: 'Cashu balance' }),
    hero,
    h('div', { class: 'wallet-card-actions', style: 'margin-top: 14px;' }, [topUpBtn]),
  ]);
}

// ─── Top Up modal (v0.2.83-alpha): Lightning-QR primary, paste-token fallback ─
//
// State machine per the brief: idle → generating → waiting → paid → done, plus
// expired and error. A single setInterval polls the invoice every 2s and is
// always cleared on close/success/expiry. The primary path shows a QR of a
// BOLT11 invoice (Cashu mint-quote OR NWC-issued); the secondary link reveals
// the legacy paste-a-Cashu-token form so no prior behaviour regresses.

// Live handle to the open top-up modal so toggleTopUp(false) and the chat-dock
// handoff can address it without a re-render.
let topUpModal = null;

// The "Top Up" button (here and from the chat dock) opens the QR modal.
function toggleTopUp(show) {
  if (show) openTopUpModal();
  else if (topUpModal) { topUpModal.close(); topUpModal = null; }
}

function maybeFocusTopUp() {
  let flag = null;
  try { flag = sessionStorage.getItem(FOCUS_TOPUP_KEY); } catch (_e) {}
  if (!flag) return;
  try { sessionStorage.removeItem(FOCUS_TOPUP_KEY); } catch (_e) {}
  toggleTopUp(true);
}

function openTopUpModal() {
  if (topUpModal) return; // already open
  if (!isAgentConfigured() || !isSessionLive()) { startLogin(); return; }

  // ── Mutable modal state ──
  let source = 'cashu';        // 'cashu' | 'nwc'
  let amount = TOPUP_DEFAULT_SATS;
  let selectedMint = null;     // optional mint url (Cashu, when >1 configured)
  let nwcConnected = false;    // gates the NWC source until a wallet is linked
  let pollHandle = null;
  let countdownHandle = null;

  const stopTimers = () => {
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    if (countdownHandle) { clearInterval(countdownHandle); countdownHandle = null; }
  };

  // ── Amount input + preset chips ──
  const amountInput = h('input', {
    type: 'number', min: 1, max: TOPUP_MAX_SATS, step: 100, value: String(amount),
    class: 'topup-amount', style: 'width: 100%;',
  });
  const clampAmount = () => {
    let v = parseInt(amountInput.value || '0', 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    if (v > TOPUP_MAX_SATS) v = TOPUP_MAX_SATS;
    amount = v;
    amountInput.value = String(v);
    syncChips();
  };
  amountInput.addEventListener('change', clampAmount);

  const chips = TOPUP_PRESETS.map((sats) => {
    const chip = h('button', { class: 'topup-chip', type: 'button' }, [formatSats(sats)]);
    chip.addEventListener('click', () => { amount = sats; amountInput.value = String(sats); syncChips(); });
    return chip;
  });
  function syncChips() {
    chips.forEach((chip, i) => {
      chip.classList.toggle('active', TOPUP_PRESETS[i] === amount);
    });
  }
  const chipRow = h('div', { class: 'topup-chips' }, chips);

  // ── Optional mint selector (only shown when >1 mint is configured) ──
  const mintSelect = h('select', { class: 'topup-mint', style: 'width: 100%;' });
  const mintRow = h('div', { class: 'form-row', style: 'display:none;' }, [
    h('label', { text: 'Mint' }), mintSelect,
  ]);
  mintSelect.addEventListener('change', () => { selectedMint = mintSelect.value || null; });

  // ── Source selector (Cashu / NWC). NWC disabled until a wallet is linked. ──
  const cashuRadio = h('input', { type: 'radio', name: 'topup-source', value: 'cashu', checked: true });
  const nwcRadio = h('input', { type: 'radio', name: 'topup-source', value: 'nwc' });
  const nwcLabel = h('label', { class: 'topup-source-opt', title: 'Link an NWC wallet on the NWC card to enable this.' }, [
    nwcRadio, ' NWC wallet',
  ]);
  const setSource = (s) => { source = s; };
  cashuRadio.addEventListener('change', () => { if (cashuRadio.checked) setSource('cashu'); });
  nwcRadio.addEventListener('change', () => { if (nwcRadio.checked) setSource('nwc'); });
  const sourceRow = h('div', { class: 'topup-sources' }, [
    h('label', { class: 'topup-source-opt' }, [cashuRadio, ' Cashu mint invoice']),
    nwcLabel,
  ]);

  // ── Invoice panel (QR + copy + countdown + status) ──
  const qrWrap = h('div', { class: 'topup-qr' });
  const copyBtn = h('button', { class: 'topup-copy', type: 'button', style: 'display:none;' }, ['Copy invoice']);
  const countdownEl = h('div', { class: 'topup-countdown muted', style: 'display:none;' });
  const invoicePanel = h('div', { class: 'topup-invoice', style: 'display:none;' }, [qrWrap, copyBtn, countdownEl]);

  const status = h('div', { class: 'topup-status muted', style: 'min-height: 20px; margin-top: 10px;', text: '' });

  const genBtn = h('button', { class: 'primary', type: 'button' }, ['Generate invoice']);
  genBtn.addEventListener('click', () => { clampAmount(); startGenerate(); });

  // ── Secondary: paste-a-Cashu-token fallback (legacy flow, preserved) ──
  const pasteLink = h('button', { class: 'topup-paste-link linkish', type: 'button' }, ['Have a Cashu token? Paste it']);
  const pasteForm = renderTopUpForm();
  pasteLink.addEventListener('click', () => {
    const showing = pasteForm.style.display !== 'none';
    pasteForm.style.display = showing ? 'none' : 'block';
    if (!showing && topUpInputEl) topUpInputEl.focus();
  });

  const idleControls = h('div', { class: 'topup-controls' }, [
    sourceRow,
    h('div', { class: 'form-row', style: 'margin-top: 12px;' }, [
      h('label', { text: 'Amount (sats)' }), amountInput,
    ]),
    chipRow,
    mintRow,
    h('div', { style: 'display:flex; justify-content:flex-end; margin-top: 12px;' }, [genBtn]),
  ]);

  const body = h('div', { class: 'topup-modal-body' }, [
    idleControls,
    invoicePanel,
    status,
    h('div', { class: 'topup-fallback', style: 'margin-top: 16px; border-top: 1px solid hsl(var(--border)); padding-top: 12px;' }, [
      pasteLink,
      pasteForm,
    ]),
  ]);

  syncChips();

  topUpModal = openModal({
    title: 'Top up Routstr balance',
    subtitle: 'Scan the QR with a Lightning wallet, or paste a Cashu token.',
    body,
    onClose: () => { stopTimers(); topUpModal = null; },
  });

  // Discover mints + NWC capability so the source/mint controls reflect reality.
  primeControls();

  // ── State transitions ──

  function setStatus(text, kind) {
    status.textContent = text || '';
    status.style.color = kind === 'error' ? 'hsl(var(--destructive))'
      : kind === 'ok' ? 'hsl(var(--ok, 142 70% 45%))' : '';
  }

  async function primeControls() {
    // NWC: enable the source only when a connected wallet can make invoices.
    try {
      const s = await nwcStatus();
      const d = s.ok ? (s.data || {}) : {};
      nwcConnected = d.connected === true && d.can_make_invoice !== false;
      nwcRadio.disabled = !nwcConnected;
      nwcLabel.classList.toggle('disabled', !nwcConnected);
      nwcLabel.title = nwcConnected
        ? 'Issue the invoice on your linked NWC wallet.'
        : 'Link an NWC wallet on the NWC card to enable this.';
    } catch (_e) { nwcRadio.disabled = true; }

    // Cashu: offer a mint dropdown only when more than one mint is configured.
    try {
      const b = await walletBalance();
      const perMint = b.ok && b.data && typeof b.data.per_mint === 'object' ? b.data.per_mint : null;
      const mints = perMint ? Object.keys(perMint) : [];
      if (mints.length > 1) {
        clear(mintSelect);
        mintSelect.appendChild(h('option', { value: '' }, ['Auto (recommended)']));
        for (const m of mints) mintSelect.appendChild(h('option', { value: m }, [hostOf(m)]));
        mintRow.style.display = '';
      }
    } catch (_e) {}
  }

  function toIdle() {
    stopTimers();
    invoicePanel.style.display = 'none';
    copyBtn.style.display = 'none';
    countdownEl.style.display = 'none';
    clear(qrWrap);
    idleControls.style.display = '';
    genBtn.disabled = false;
    setStatus('');
  }

  async function startGenerate() {
    if (source === 'nwc' && !nwcConnected) { setStatus('Connect an NWC wallet first.', 'error'); return; }
    genBtn.disabled = true;
    idleControls.style.display = 'none';
    setStatus('Requesting an invoice…');

    const res = source === 'cashu'
      ? await walletMintQuote(amount, selectedMint || undefined)
      : await walletNwcInvoice(amount, 'Routstr top-up');

    if (!res.ok) { setStatus(`Could not create invoice: ${res.reason}`, 'error'); addRetry(); return; }

    const d = res.data || {};
    const bolt11 = source === 'cashu' ? d.request : d.invoice;
    const id = source === 'cashu' ? d.quote : d.payment_hash;
    if (!bolt11 || !id) { setStatus('Agent returned an incomplete invoice.', 'error'); addRetry(); return; }

    showInvoice(bolt11, id, d.expiry);
  }

  function showInvoice(bolt11, id, expiry) {
    invoicePanel.style.display = '';
    clear(qrWrap);
    try {
      // BOLT11 is uppercased so the QR uses the denser alphanumeric mode.
      qrWrap.appendChild(renderQR(`lightning:${bolt11.toUpperCase()}`, { size: 240, ecl: 'M' }));
    } catch (_e) {
      qrWrap.appendChild(h('div', { class: 'muted', text: 'Could not render QR — copy the invoice instead.' }));
    }
    copyBtn.style.display = '';
    copyBtn.textContent = 'Copy invoice';
    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(bolt11); copyBtn.textContent = 'Copied ✓'; }
      catch (_e) { copyBtn.textContent = 'Copy failed'; }
      setTimeout(() => { copyBtn.textContent = 'Copy invoice'; }, 1500);
    };
    setStatus('Waiting for payment…');
    startCountdown(expiry);
    startPoll(id);
  }

  function startCountdown(expiry) {
    // Cashu expiry is an absolute unix timestamp; NWC may return a duration.
    const now = Math.floor(Date.now() / 1000);
    let deadline;
    if (Number.isFinite(expiry) && expiry > now + 1) deadline = expiry;          // absolute
    else if (Number.isFinite(expiry) && expiry > 0) deadline = now + expiry;      // duration
    else deadline = now + TOPUP_FALLBACK_EXPIRY_SEC;

    countdownEl.style.display = '';
    const render = () => {
      const left = deadline - Math.floor(Date.now() / 1000);
      if (left <= 0) { toExpired(); return; }
      const m = Math.floor(left / 60), s = left % 60;
      countdownEl.textContent = `Expires in ${m}:${String(s).padStart(2, '0')}`;
    };
    render();
    countdownHandle = setInterval(render, 1000);
  }

  function startPoll(id) {
    pollHandle = setInterval(async () => {
      const r = source === 'cashu'
        ? await walletMintQuoteStatus(id)
        : await walletNwcInvoiceStatus(id);
      if (!r.ok) return; // transient; keep polling until expiry
      if (r.data?.paid === true) toPaid(r.data);
    }, TOPUP_POLL_MS);
  }

  async function toPaid(data) {
    stopTimers();
    countdownEl.style.display = 'none';
    copyBtn.style.display = 'none';
    setStatus('Payment received — updating balance…', 'ok');

    // Prefer the server-reported new balance (Cashu); otherwise read it back.
    let newBal = Number.isFinite(data?.new_balance_sats) ? data.new_balance_sats : null;
    if (newBal == null) {
      const b = await walletBalance();
      newBal = b.ok ? readBalanceSats(b.data) : null;
    }
    if (newBal != null) {
      updateRoutstr({ connected: true, cashuBalanceSats: newBal });
      if (balanceNumEl && balanceNumEl.isConnected) balanceNumEl.textContent = formatSats(newBal);
      setStatus(`Paid. New balance: ${formatSats(newBal)} sats.`, 'ok');
    } else {
      setStatus('Paid. Balance will refresh shortly.', 'ok');
    }
    // done: offer to close.
    const doneBtn = h('button', { class: 'primary', type: 'button', style: 'margin-top: 12px;' }, ['Done']);
    doneBtn.addEventListener('click', () => toggleTopUp(false));
    invoicePanel.appendChild(doneBtn);
  }

  function toExpired() {
    stopTimers();
    countdownEl.textContent = 'Invoice expired';
    countdownEl.style.display = '';
    copyBtn.style.display = 'none';
    setStatus('This invoice expired before payment.', 'error');
    addRetry();
  }

  function addRetry() {
    genBtn.disabled = false;
    const retry = h('button', { class: 'primary', type: 'button', style: 'margin-top: 12px;' }, ['Generate a new invoice']);
    retry.addEventListener('click', () => { retry.remove(); toIdle(); });
    (invoicePanel.style.display === 'none' ? status.parentNode : invoicePanel).appendChild(retry);
  }
}

function hostOf(u) {
  try { return new URL(u).host; } catch { return String(u); }
}

// Legacy inline Cashu-token receive form (POST /api/wallet/receive {token}).
// Retained as the secondary "paste a token" path inside the top-up modal so the
// original redeem behaviour never regresses. Hidden until the paste link opens
// it. Sets the module-level topUpInputEl so the modal can focus it.
function renderTopUpForm() {
  topUpInputEl = h('textarea', {
    rows: 4,
    placeholder: 'cashuAeyJ0b2tlbiI6W3sicHJvb2ZzIjpb…',
    style: 'width: 100%; font-family: var(--font-mono); font-size: 12px;',
  });
  const status = h('div', { class: 'muted', style: 'font-size: 12px; min-height: 18px; margin-top: 6px;', text: 'Paste a Cashu token from your wallet. Only whitelisted mints will be accepted.' });
  const submit = h('button', { class: 'primary' }, ['Redeem to agent']);
  const actions = h('div', { style: 'display:flex; gap: 8px; justify-content: flex-end; margin-top: 12px;' }, [submit]);

  submit.addEventListener('click', async () => {
    const tok = (topUpInputEl.value || '').trim();
    if (!tok) { status.textContent = 'Paste a Cashu token first.'; return; }
    if (!isAgentConfigured() || !isSessionLive()) {
      status.textContent = 'Sign in to redeem a token.';
      startLogin();
      return;
    }
    submit.disabled = true;
    status.style.color = '';
    status.textContent = 'Sending to agent…';
    const r = await walletReceive(tok);
    if (!r.ok) {
      submit.disabled = false;
      status.textContent = `Failed: ${r.reason}`;
      status.style.color = 'hsl(var(--destructive))';
      return;
    }
    // /api/wallet/receive replies { ok, added_sats, mint } — it does NOT echo the
    // new total, so read the authoritative balance back from /api/wallet/balance.
    const added = Number.isFinite(r.data?.added_sats) ? r.data.added_sats : null;
    const b = await walletBalance();
    const newBal = b.ok ? readBalanceSats(b.data) : null;
    status.textContent = newBal != null
      ? `Received ${added ?? '?'} sats. New balance: ${newBal} sats.`
      : `Received ${added ?? '?'} sats.`;
    updateRoutstr({ connected: true, ...(newBal != null ? { cashuBalanceSats: newBal } : {}) });
    if (balanceNumEl && balanceNumEl.isConnected && newBal != null) {
      balanceNumEl.textContent = formatSats(newBal);
    }
    submit.disabled = false;
    topUpInputEl.value = '';
    setTimeout(() => renderRoutstr(document.getElementById('main-content')), 900);
  });

  topUpSectionEl = h('div', { class: 'topup-form', style: 'display: none; margin-top: 12px;' }, [
    h('div', { class: 'muted', style: 'font-size: 12px; margin-bottom: 6px;', text: 'Paste a Cashu token — it is sent to your agent, decoded and stored on your Torii. Your browser never keeps proofs.' }),
    topUpInputEl,
    status,
    actions,
  ]);
  return topUpSectionEl;
}

// ─── Card 2: NWC wallet (NIP-47 Nostr Wallet Connect) ───────────────────────
//
// The agent implements NWC (NIP-47) only — NOT NIP-60 — so this card is
// labelled "NWC wallet". It reuses the existing onboarding wallet endpoints
// (status/connect/test/disconnect) rather than adding any new protocol support.

// Case-insensitive substring fingerprint → wallet maker. Ordered so a more
// specific needle (getalby, mutinywallet) is tried before its shorter alias,
// though both map to the same maker. Source string is the alias + relay hosts
// (see nwcFingerprint) — never the secret or full URI.
const WALLET_MAKERS = [
  ['getalby', 'Alby'],
  ['alby', 'Alby'],
  ['mutinywallet', 'Mutiny'],
  ['mutiny', 'Mutiny'],
  ['cashu.me', 'cashu.me'],
  ['zeusln', 'Zeus'],
  ['zeus', 'Zeus'],
  ['coinos', 'Coinos'],
  ['strike', 'Strike'],
  ['phoenix', 'Phoenix'],
];

// Build the (non-secret) fingerprint string a maker is inferred from: the
// wallet alias plus its relay hosts, lowercased. Never includes the secret,
// the full URI, or the wallet pubkey.
export function nwcFingerprint(d) {
  const parts = [];
  if (d && d.alias) parts.push(String(d.alias));
  const relays = (d && d.wallet && d.wallet.relays) || [];
  for (const r of relays) parts.push(String(r));
  return parts.join(' ').toLowerCase();
}

// Infer the wallet maker from its fingerprint. Returns { maker, known }; an
// unrecognised wallet is "Unknown wallet" (known:false) and the caller surfaces
// the relay host instead.
export function inferWalletMaker(fingerprint) {
  const s = String(fingerprint || '').toLowerCase();
  for (const [needle, maker] of WALLET_MAKERS) {
    if (s.includes(needle)) return { maker, known: true };
  }
  return { maker: 'Unknown wallet', known: false };
}

// The connected-wallet identity block:
//   line 1 — alias (or "Wallet")
//   line 2 — inferred maker + a small badge (network, else "NWC")
//   line 3 — muted pubkey shortcode
// For an unrecognised maker, the relay host is shown so the operator still
// knows where the wallet connects.
export function renderNwcIdentity(d) {
  const alias = (d && d.alias) ? String(d.alias) : 'Wallet';
  const { maker, known } = inferWalletMaker(nwcFingerprint(d));
  const relays = (d && d.wallet && d.wallet.relays) || [];
  const prefix = d && d.wallet && d.wallet.wallet_pubkey_prefix;

  const lines = [
    h('div', { class: 'nwc-alias', style: 'font-weight: 600;', text: alias }),
    h('div', { class: 'nwc-maker', style: 'display:flex; align-items:center; gap:6px; margin-top:2px;' }, [
      h('span', { text: maker }),
      h('span', { class: 'badge', text: d && d.network ? String(d.network) : 'NWC' }),
    ]),
  ];
  if (!known && relays.length) {
    lines.push(h('div', { class: 'muted', style: 'font-size: 11.5px;', text: String(relays[0]) }));
  }
  if (prefix) {
    lines.push(h('div', { class: 'mono muted', style: 'font-size: 11.5px;', text: `${String(prefix)}…` }));
  }
  return h('div', { class: 'nwc-identity', style: 'margin-top: 8px;' }, lines);
}

function renderNwcCard(live, demo) {
  const body = h('div', { class: 'nwc-body' }, [
    h('div', { class: 'muted', text: live ? 'Checking wallet…' : 'Sign in to connect a Lightning wallet.' }),
  ]);
  const card = h('div', { class: 'card' }, [
    h('h3', { text: 'NWC wallet' }),
    h('p', { class: 'muted', text: 'Nostr Wallet Connect (NIP-47). Link a NWC-capable Lightning wallet to fund the agent by payment.' }),
    body,
  ]);
  if (live) loadNwcStatus(body);
  else {
    body.appendChild(h('div', { class: 'wallet-card-actions', style: 'margin-top: 12px;' }, [
      h('button', { class: 'primary', onClick: demoIntercept(demo, () => startLogin()) }, ['Sign in']),
    ]));
  }
  return card;
}

async function loadNwcStatus(body) {
  const r = await nwcStatus();
  clear(body);
  if (!r.ok) {
    // Logged-out / offline builds get { offline } from req(); anything else is a
    // server-controlled reason. Render an accurate not-connected state either way.
    body.appendChild(h('div', {}, [
      h('span', { class: 'pill', text: 'not connected' }),
    ]));
    if (r.reason && !r.offline) {
      body.appendChild(h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 8px;', text: r.reason }));
    }
    body.appendChild(renderNwcActions(false, body));
    return;
  }
  const d = r.data || {};
  const connected = d.connected === true;
  const head = h('div', {}, [
    h('span', { class: connected ? 'pill ok' : 'pill', text: connected ? 'connected' : 'not connected' }),
  ]);
  body.appendChild(head);

  if (connected) {
    body.appendChild(renderNwcIdentity(d));
    const bits = [];
    if (d.network) bits.push(`network: ${d.network}`);
    bits.push(d.can_fund_routstr ? 'can fund Routstr by payment' : 'cannot fund Routstr (no pay_invoice)');
    // Preserve the make_invoice capability signal (used by the top-up-by-NWC
    // flow) — it moved out of the connect step into the card's capability line.
    const canInvoice = d.can_make_invoice != null ? d.can_make_invoice : d.capabilities?.can_make_invoice;
    if (canInvoice != null) bits.push(canInvoice ? 'can make invoice' : 'cannot make invoice');
    body.appendChild(h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 8px;', text: bits.join(' · ') }));
  } else {
    body.appendChild(h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 8px;', text: 'No NWC wallet linked yet.' }));
    if (d.error) body.appendChild(h('div', { class: 'muted', style: 'font-size: 12px;', text: d.error }));
  }
  const statusLine = h('div', { class: 'muted', style: 'font-size: 12px; min-height: 16px; margin-top: 8px;' });
  body.appendChild(renderNwcActions(connected, body, statusLine));
  body.appendChild(statusLine);
}

function renderNwcActions(connected, body, statusLine) {
  const wrap = h('div', { class: 'wallet-card-actions', style: 'display:flex; gap: 8px; margin-top: 12px;' });
  if (connected) {
    const test = h('button', {}, ['Test']);
    test.addEventListener('click', async () => {
      if (statusLine) { statusLine.style.color = ''; statusLine.textContent = 'Testing wallet…'; }
      const r = await nwcTest();
      if (!statusLine) return;
      if (r.ok) statusLine.textContent = r.data?.can_fund_routstr ? 'Wallet responded — can fund Routstr.' : 'Wallet responded.';
      else { statusLine.textContent = `Test failed: ${r.reason}`; statusLine.style.color = 'hsl(var(--destructive))'; }
    });
    const disc = h('button', {}, ['Disconnect']);
    disc.addEventListener('click', async () => {
      if (statusLine) { statusLine.style.color = ''; statusLine.textContent = 'Disconnecting…'; }
      await nwcDisconnect();
      loadNwcStatus(body);
    });
    wrap.appendChild(test);
    wrap.appendChild(disc);
  } else {
    const conn = h('button', { class: 'primary' }, ['Connect']);
    conn.addEventListener('click', () => openNwcConnectModal(body));
    wrap.appendChild(conn);
  }
  return wrap;
}

function openNwcConnectModal(body) {
  const input = h('textarea', {
    rows: 3,
    placeholder: 'nostr+walletconnect://…',
    style: 'width: 100%; font-family: var(--font-mono); font-size: 12px;',
  });
  const status = h('div', { class: 'muted', style: 'font-size: 12px; min-height: 18px; margin-top: 6px;', text: 'Paste your NWC connection URI. It is stored encrypted on your Torii.' });
  const submit = h('button', { class: 'primary' }, ['Connect wallet']);
  const cancel = h('button', {}, ['Cancel']);
  const actions = h('div', { style: 'display:flex; gap: 8px; justify-content: flex-end; margin-top: 12px;' }, [cancel, submit]);
  const modalBody = h('div', {}, [input, status, actions]);

  const handle = openModal({
    title: 'Connect NWC wallet',
    subtitle: 'Nostr Wallet Connect (NIP-47). The URI never leaves your agent unencrypted.',
    body: modalBody,
  });
  cancel.addEventListener('click', () => handle.close());
  submit.addEventListener('click', async () => {
    const uri = (input.value || '').trim();
    if (!uri) { status.textContent = 'Paste a NWC URI first.'; return; }
    submit.disabled = true;
    status.style.color = '';
    status.textContent = 'Connecting…';
    const r = await nwcConnect(uri);
    if (!r.ok) {
      submit.disabled = false;
      status.textContent = `Failed: ${r.reason}`;
      status.style.color = 'hsl(var(--destructive))';
      return;
    }
    handle.close();
    loadNwcStatus(body);
  });
}

function renderModelPicker(c, demo) {
  const list = h('div', { class: 'model-list' });
  for (const m of c.models) {
    const row = h('div', { class: 'model ' + (m.id === c.selectedModel ? 'selected' : '') }, [
      h('div', { style: 'flex: 1; min-width: 0;' }, [
        h('div', { class: 'name', text: m.name }),
        h('div', { class: 'mono muted', style: 'font-size: 11.5px;', text: m.id }),
      ]),
      m.badge ? h('span', { class: 'badge', text: m.badge }) : null,
      h('span', { class: 'price', text: `${m.pricePer1kSats} sats/1k tok` }),
    ]);
    row.addEventListener('click', demoIntercept(demo, () => {
      updateRoutstr({ selectedModel: m.id });
      renderRoutstr(document.getElementById('main-content'));
    }));
    list.appendChild(row);
  }
  return h('div', { class: 'card' }, [
    h('h3', { text: 'AI model' }),
    h('p', { class: 'muted', text: 'Default is DeepSeek Chat — cheap and capable. Switch anytime; the chat dock uses whichever is selected.' }),
    list,
  ]);
}

function renderUsage(c) {
  const u = c.usage;
  const pct = u.monthlyBudget > 0 ? Math.min(100, Math.round((u.satsSpent / u.monthlyBudget) * 100)) : 0;
  return h('div', { class: 'card' }, [
    h('h3', { text: 'Usage stats' }),
    h('p', { class: 'muted', text: 'Last 24 hours. Live counters light up once you connect and start sending requests.' }),
    h('div', { class: 'grid-2', style: 'gap: 12px; margin-top: 8px;' }, [
      renderStat('Requests · 24h', String(u.requests24h)),
      renderStat('Sats spent · 24h', formatSats(u.satsSpent) + ' sats'),
      renderStat('Tokens in',  formatSats(u.tokensIn)),
      renderStat('Tokens out', formatSats(u.tokensOut)),
    ]),
    h('div', { style: 'margin-top: 14px;' }, [
      h('div', { class: 'muted', style: 'font-size: 12px; display: flex; justify-content: space-between;' }, [
        h('span', { text: 'Monthly budget' }),
        h('span', { text: `${formatSats(u.satsSpent)} / ${formatSats(u.monthlyBudget)} sats` }),
      ]),
      h('div', { class: 'usage-bar', style: 'margin-top: 6px;' }, [
        h('i', { style: `width: ${pct}%` }),
      ]),
    ]),
  ]);
}

function renderStat(label, value) {
  return h('div', {}, [
    h('div', { class: 'label muted', style: 'font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;', text: label }),
    h('div', { class: 'mono', style: 'font-size: 18px; color: var(--ink-hi); margin-top: 2px;', text: value }),
  ]);
}

function connect() {
  // If we're not signed in, prompt login first (agent-configured builds) or
  // fall back to the mock behaviour on demo builds.
  if (!isAgentConfigured()) {
    // Demo mode: no agent, so bump the mock balance so the UI feels alive.
    const bal = 12000 + Math.floor(Math.random() * 8000);
    updateRoutstr({ connected: true, cashuBalanceSats: bal });
    renderRoutstr(document.getElementById('main-content'));
    return;
  }
  if (!isSessionLive()) {
    startLogin();
    return;
  }
  toggleTopUp(true);
}

function disconnect() {
  // Local UI toggle only — the agent-side wallet is persistent by design.
  // Signing out (sidebar) revokes the session token; the mint proofs on your Torii remain.
  updateRoutstr({ connected: false, cashuBalanceSats: 0 });
  stopBalancePoll();
  renderRoutstr(document.getElementById('main-content'));
}

function startBalancePoll(mount) {
  stopBalancePoll();
  const tick = async () => {
    const r = await walletBalance();
    if (!r.ok || !r.data) return;
    const sats = readBalanceSats(r.data);
    if (sats == null) return; // no numeric balance in payload — leave display as-is
    const cur = getRoutstr().content;
    if (cur.cashuBalanceSats !== sats || !cur.connected) {
      updateRoutstr({ connected: true, cashuBalanceSats: sats });
      // Refresh the balance number in place. A targeted textContent write avoids
      // tearing/re-rendering the whole page mid-interaction, and only touches the
      // node if it is still on-screen (Routstr page still mounted).
      if (balanceNumEl && balanceNumEl.isConnected) {
        balanceNumEl.textContent = formatSats(sats);
      }
    }
  };
  tick();
  balancePollHandle = setInterval(tick, 15000);
}

function stopBalancePoll() {
  if (balancePollHandle) { clearInterval(balancePollHandle); balancePollHandle = null; }
}
