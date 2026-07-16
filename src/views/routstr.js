/** Routstr page — connect, Cashu pay, model picker, usage stats.
 *  All UI-only for MVP; wire real endpoint later.
 */
import { h, clear, formatSats, openModal } from './util.js';
import { getRoutstr, updateRoutstr } from '../data/store.js';
import { setChatContext } from '../chat.js';
import { walletBalance, walletReceive, isAgentConfigured } from '../data/agent.js';
import { isSessionLive, startLogin } from '../auth.js';

// Poll the agent for live wallet balance while the Routstr page is mounted.
let balancePollHandle = null;
// Live handle to the balance number node so the poll can refresh it in place
// without re-rendering (and tearing) the whole page.
let balanceNumEl = null;

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

export function renderRoutstr(mount) {
  setChatContext({ label: 'Routstr', where: 'routstr' });
  clear(mount);

  const r = getRoutstr();
  const c = r.content;
  const live = isSessionLive();

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
        ? h('button', { onClick: disconnect }, ['Disconnect'])
        : h('button', { class: 'primary', onClick: connect }, ['Connect Cashu wallet']),
    ]),
  ]);
  mount.appendChild(header);

  // Hero: connection + balance
  const hero = h('div', { class: 'card hot' }, [
    h('div', { class: 'routstr-hero' }, [
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
      (() => {
        balanceNumEl = h('span', { class: 'bal-num', text: formatSats(c.cashuBalanceSats) });
        return h('div', { class: 'stat' }, [
          h('span', { class: 'label', text: 'Cashu balance' }),
          h('span', { class: 'value' }, [
            balanceNumEl,
            ' ',
            h('span', { class: 'unit', text: 'sats' }),
          ]),
        ]);
      })(),
    ]),
  ]);
  mount.appendChild(hero);

  mount.appendChild(h('div', { style: 'height: 16px' }));

  // Grid: model list + usage
  const grid = h('div', { class: 'grid-2' }, [
    renderModelPicker(c),
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
        inp.addEventListener('change', () => updateRoutstr({ endpoint: inp.value.trim() || 'https://api.routstr.com' }));
        return inp;
      })(),
    ]),
    h('div', { class: 'form-row' }, [
      h('label', { text: 'Monthly Cashu budget (sats)' }),
      (() => {
        const inp = h('input', { type: 'number', value: c.usage.monthlyBudget, min: 0, step: 1000 });
        inp.addEventListener('change', () => updateRoutstr({ usage: { ...c.usage, monthlyBudget: Math.max(0, parseInt(inp.value || '0', 10)) } }));
        return inp;
      })(),
    ]),
  ]);
  mount.appendChild(settings);
}

function renderModelPicker(c) {
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
    row.addEventListener('click', () => {
      updateRoutstr({ selectedModel: m.id });
      renderRoutstr(document.getElementById('main-content'));
    });
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
  openTopUpModal();
}

function openTopUpModal() {
  const input = h('textarea', {
    rows: 4,
    placeholder: 'cashuAeyJ0b2tlbiI6W3sicHJvb2ZzIjpb…',
    style: 'width: 100%; font-family: var(--font-mono); font-size: 12px;',
  });
  const status = h('div', { class: 'muted', style: 'font-size: 12px; min-height: 18px; margin-top: 6px;', text: 'Paste a Cashu token from your wallet. Only whitelisted mints will be accepted.' });
  const submit = h('button', { class: 'primary' }, ['Redeem to agent']);
  const cancel = h('button', {}, ['Cancel']);
  const actions = h('div', { style: 'display:flex; gap: 8px; justify-content: flex-end; margin-top: 12px;' }, [cancel, submit]);
  const body = h('div', {}, [input, status, actions]);

  const handle = openModal({
    title: 'Top up agent wallet',
    subtitle: 'The Cashu token is sent to your agent, decoded and stored on your Torii. Your browser never keeps proofs — it just hands them to your own gateway.',
    body,
  });

  cancel.addEventListener('click', () => handle.close());
  submit.addEventListener('click', async () => {
    const tok = (input.value || '').trim();
    if (!tok) { status.textContent = 'Paste a Cashu token first.'; return; }
    submit.disabled = true;
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
    setTimeout(() => {
      handle.close();
      renderRoutstr(document.getElementById('main-content'));
    }, 900);
  });
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
