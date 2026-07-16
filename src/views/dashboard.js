/** Dashboard — the Continuum project-oversight surface, now an internal page.
 *  Kept intentionally light: it summarises the projects you have and links
 *  out to each sibling app's own dashboard.
 *
 *  CONT-HEALTH-1 (v0.2.13): also renders a live Provider card that polls
 *  /api/health/models every 20s while the dashboard is mounted so the
 *  operator sees Routstr + Ollama reachability without touching a terminal.
 *  Admin-gated endpoint — a logged-out visitor sees a login prompt instead.
 */
import { h, clear, timeAgo } from './util.js';
import { listProjects, todosFor, sessionsFor, boardStatsFor, subscribe } from '../data/store.js';
import { setChatContext } from '../chat.js';
import { isAgentConfigured, isLoggedIn, healthModels, walletHealth } from '../data/agent.js';

// Module-level poll handle mirrors the routstr.js pattern. A single dashboard
// mount owns at most one interval; navigating away clears it via the
// hashchange listener installed below.
let providerPollHandle = null;
let providerHashListener = null;
let storeUnsub = null;
const POLL_INTERVAL_MS = 20_000;

function stopProviderPoll() {
  if (providerPollHandle) { clearInterval(providerPollHandle); providerPollHandle = null; }
  if (providerHashListener) {
    window.removeEventListener('hashchange', providerHashListener);
    providerHashListener = null;
  }
  if (storeUnsub) { storeUnsub(); storeUnsub = null; }
}

// pill(state, text) — small status chip using the existing .pill classes.
// state ∈ {'ok','warn','danger','muted'}
function pill(state, text) {
  const cls = state === 'muted' ? 'pill' : `pill ${state}`;
  return h('span', { class: cls, text });
}

// Render the provider card body into `body` given a resolved health payload
// (or a failure envelope from the agent client). Idempotent — called on
// every poll tick to refresh in place.
function renderProviderBody(body, res, elapsedMs, walletRes) {
  clear(body);

  // Not configured (demo build with VITE_AGENT_URL empty)
  if (!isAgentConfigured()) {
    body.appendChild(h('div', { class: 'muted', style: 'font-size: 13px;', text: 'Agent URL not configured for this build. In a self-hosted deploy this card shows live Routstr + Ollama reachability.' }));
    return;
  }

  // Not logged in — endpoint is admin-gated, so no point calling it
  if (!isLoggedIn()) {
    body.appendChild(h('div', { class: 'muted', style: 'font-size: 13px;', text: 'Sign in with your Nostr key (sidebar → Sign in) to see live provider status. The /api/health/models endpoint is admin-gated.' }));
    return;
  }

  // Call failed (network / 401 / 5xx)
  if (!res.ok) {
    body.appendChild(h('div', {}, [
      pill('danger', 'Unreachable'),
      h('span', { style: 'margin-left: 8px; font-size: 13px;', text: res.reason || 'unknown error' }),
    ]));
    return;
  }

  const d = res.data || {};
  const strategy = d.strategy || '—';
  const version = d.version || '—';

  // Strategy + version row
  body.appendChild(h('div', { class: 'muted', style: 'font-size: 12px; margin-bottom: 10px;', text: `Strategy: ${strategy} · Agent ${version} · ${elapsedMs} ms round-trip` }));

  // Routstr row — enabled today with no server-side reachability probe, so we
  // show "Enabled" rather than fake a green light. When we add a Routstr
  // reachability probe this can promote to ok/danger like Ollama.
  const rs = d.routstr || {};
  const routstrRow = h('div', { class: 'provider-row' }, [
    h('div', { class: 'provider-name', text: 'Routstr' }),
    rs.enabled ? pill('ok', 'Enabled') : pill('muted', 'Disabled'),
    h('span', { class: 'provider-model', text: rs.model || '' }),
  ]);
  body.appendChild(routstrRow);

  // Ollama row — the endpoint DOES probe reachability, so we can show
  // ok/danger/muted honestly.
  const ol = d.ollama || {};
  let ollamaPill;
  if (!ol.enabled) ollamaPill = pill('muted', 'Disabled');
  else if (ol.reachable) ollamaPill = pill('ok', 'Reachable');
  else ollamaPill = pill('danger', 'Unreachable');
  const ollamaRow = h('div', { class: 'provider-row' }, [
    h('div', { class: 'provider-name', text: 'Ollama' }),
    ollamaPill,
    h('span', { class: 'provider-model', text: ol.chat_model || '' }),
  ]);
  body.appendChild(ollamaRow);

  if (ol.enabled && !ol.reachable && ol.reason) {
    body.appendChild(h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 6px;', text: `Ollama: ${ol.reason}` }));
  }

  // CONT-HEALTH-2: wallet + mint health. Non-mutating validation of stored
  // proofs against each configured mint (reachability + NUT-07 proof-state).
  renderWalletHealth(body, walletRes);
}

// Overall wallet state → pill styling. Never renders proofs, tokens, or secrets
// — only the coarse state + sanitized per-mint reasons the endpoint returns.
function renderWalletHealth(body, walletRes) {
  const wrap = h('div', { class: 'provider-wallet', style: 'margin-top: 14px; border-top: 1px solid hsl(var(--border)); padding-top: 12px;' });
  wrap.appendChild(h('div', { class: 'muted', style: 'font-size: 12px; margin-bottom: 8px;', text: 'Wallet & mints' }));

  if (!walletRes || !walletRes.ok) {
    wrap.appendChild(h('div', {}, [
      pill('danger', 'Unreachable'),
      h('span', { style: 'margin-left: 8px; font-size: 13px;', text: (walletRes && walletRes.reason) || 'wallet health unavailable' }),
    ]));
    body.appendChild(wrap);
    return;
  }

  const w = walletRes.data || {};
  if (w.configured === false || w.overall === 'disabled') {
    wrap.appendChild(h('div', {}, [
      pill('muted', 'Disabled'),
      h('span', { style: 'margin-left: 8px; font-size: 13px;', text: 'No Cashu mints configured.' }),
    ]));
    body.appendChild(wrap);
    return;
  }

  const overallPill = w.overall === 'ok' ? pill('ok', 'Healthy')
    : w.overall === 'unreachable' ? pill('danger', 'Unreachable')
      : pill('warn', 'Degraded');
  wrap.appendChild(h('div', { class: 'provider-row' }, [
    h('div', { class: 'provider-name', text: 'Overall' }),
    overallPill,
  ]));

  (Array.isArray(w.mints) ? w.mints : []).forEach((m) => {
    const mp = m.state === 'ok' ? pill('ok', 'OK')
      : m.state === 'unreachable' ? pill('danger', 'Unreachable')
        : pill('warn', 'Degraded');
    const bal = typeof m.balance_sats === 'number' ? `${m.balance_sats} sats` : '';
    const name = (m.identity && m.identity.name) || m.mint_fingerprint || 'mint';
    wrap.appendChild(h('div', { class: 'provider-row' }, [
      h('div', { class: 'provider-name', text: name }),
      mp,
      h('span', { class: 'provider-model', text: bal }),
    ]));
    if (m.reason) {
      wrap.appendChild(h('div', { class: 'muted', style: 'font-size: 12px; margin: 2px 0 6px;', text: m.reason }));
    }
  });

  body.appendChild(wrap);
}

async function tickProvider(body) {
  // If the dashboard was navigated away from between ticks, the body node is
  // still detached — bail out to avoid a spurious render into limbo.
  if (!body.isConnected) { stopProviderPoll(); return; }
  const t0 = performance.now();
  const [res, walletRes] = await Promise.all([healthModels(), walletHealth()]);
  const elapsedMs = Math.round(performance.now() - t0);
  if (!body.isConnected) return; // navigated away mid-await
  renderProviderBody(body, res, elapsedMs, walletRes);
}

function ProviderCard() {
  const body = h('div', { class: 'provider-card-body' });
  const card = h('div', { class: 'card provider-card' }, [
    h('div', { class: 'provider-card-head' }, [
      h('h3', { text: 'Providers' }),
      h('span', { class: 'muted', style: 'font-size: 12px;', text: `Polling every ${POLL_INTERVAL_MS / 1000}s` }),
    ]),
    body,
  ]);

  // First tick immediately, then start the interval.
  tickProvider(body);
  stopProviderPoll(); // idempotent — replace any stale handle
  providerPollHandle = setInterval(() => tickProvider(body), POLL_INTERVAL_MS);

  // Stop polling as soon as the user leaves #/dashboard. The listener
  // removes itself in stopProviderPoll() so we don't leak.
  providerHashListener = () => {
    const path = (window.location.hash || '#/').slice(1);
    if (!path.startsWith('/dashboard')) stopProviderPoll();
  };
  window.addEventListener('hashchange', providerHashListener);

  return card;
}

export function renderDashboard(mount) {
  setChatContext({ label: 'Dashboard', where: 'dashboard' });
  clear(mount);

  const projects = listProjects();
  let openTodos = 0, totalTodos = 0, totalSessions = 0;
  // Overall progress now reflects real kanban board state aggregated across
  // every project's board, not milestone status (KANBAN-PROG-1).
  const board = { total: 0, backlog: 0, todo: 0, doing: 0, done: 0 };
  for (const p of projects) {
    const bs = boardStatsFor(p.content.slug);
    board.total += bs.total;
    board.backlog += bs.backlog;
    board.todo += bs.todo;
    board.doing += bs.doing;
    board.done += bs.done;
    const td = todosFor(p.content.slug);
    totalTodos += td.length;
    openTodos += td.filter((t) => !t.content.done).length;
    totalSessions += sessionsFor(p.content.slug).length;
  }
  const pct = board.total ? Math.round((board.done / board.total) * 100) : 0;

  const header = h('div', { class: 'page-header' }, [
    h('div', {}, [
      h('h1', { class: 'page-title', text: 'Dashboard' }),
      h('div', { class: 'page-sub', text: 'Cross-project oversight at a glance. Everything here is derived from your local nostr-shaped events.' }),
    ]),
  ]);
  mount.appendChild(header);

  const grid = h('div', { class: 'grid-3' }, [
    h('div', { class: 'card' }, [
      h('div', { class: 'stat' }, [
        h('span', { class: 'label', text: 'Overall progress' }),
        h('span', { class: 'value', text: `${pct}%` }),
      ]),
      h('div', { class: 'usage-bar', style: 'margin-top: 12px;' }, [h('i', { style: `width: ${pct}%` })]),
      h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 8px;', text: `${board.done} / ${board.total} cards done · ${board.doing} doing` }),
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'stat' }, [
        h('span', { class: 'label', text: 'Open todos' }),
        h('span', { class: 'value', text: String(openTodos) }),
      ]),
      h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 12px;', text: `${totalTodos} tracked across ${projects.length} projects.` }),
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'stat' }, [
        h('span', { class: 'label', text: 'Sessions logged' }),
        h('span', { class: 'value', text: String(totalSessions) }),
      ]),
      h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 12px;', text: 'Chat + build sessions across all projects.' }),
    ]),
  ]);
  mount.appendChild(grid);

  mount.appendChild(h('div', { style: 'height: 16px' }));

  // CONT-HEALTH-1: live provider reachability card. Polls
  // /api/health/models every 20s while dashboard is mounted; cleaned up on
  // hashchange away from #/dashboard.
  mount.appendChild(ProviderCard());

  mount.appendChild(h('div', { style: 'height: 16px' }));

  // Per-project rundown — driven by real kanban board state (KANBAN-PROG-1).
  // Rebuilt in place whenever the store changes so adding/moving a card on a
  // board is reflected here without a navigation.
  const perProj = h('div', { class: 'card' });
  function renderPerProject() {
    clear(perProj);
    perProj.appendChild(h('h3', { text: 'By project' }));
    perProj.appendChild(h('p', { class: 'muted', text: 'Kanban progress across your boards. Click any project to open its home page.' }));
    for (const p of listProjects()) {
      const bs = boardStatsFor(p.content.slug);
      perProj.appendChild(h('div', { class: 'session', style: 'margin-bottom: 6px; cursor:pointer;', role: 'button', onClick: () => { window.location.hash = `#/projects/${p.content.slug}`; } }, [
        h('div', { class: 'title', text: p.content.name }),
        h('div', { style: 'flex: 1; padding: 0 12px;' }, [
          h('div', { class: 'project-progress' }, [h('i', { style: `width: ${bs.percent}%` })]),
          h('div', { class: 'muted', style: 'font-size: 11px; margin-top: 4px;', text: `Done ${bs.done} · Doing ${bs.doing} · Todo ${bs.todo} · Backlog ${bs.backlog}` }),
        ]),
        h('div', { class: 'meta', text: `${bs.done}/${bs.total} · ${bs.percent}%` }),
      ]));
    }
    perProj.appendChild(h('div', { class: 'muted', style: 'font-size: 11px; margin-top: 10px; font-style: italic;', text: 'Counts local board cards; imported read-only cards not included.' }));
  }
  renderPerProject();
  mount.appendChild(perProj);

  // Re-render the kanban-derived section on store mutations (card add/move/
  // delete). Guard against firing into a detached node and clean up alongside
  // the provider poll when the user leaves #/dashboard.
  storeUnsub = subscribe(() => {
    if (!perProj.isConnected) { stopProviderPoll(); return; }
    renderPerProject();
  });

  mount.appendChild(h('div', { style: 'height: 16px' }));

  // Link out to the sibling Torii Quest project (separate repo + app)
  mount.appendChild(h('div', { class: 'card' }, [
    h('h3', { text: 'Torii Quest (sibling app)' }),
    h('p', { class: 'muted', text: 'Torii Quest is a separate repo and app — the arena shooter. Its own build-time oversight dashboard lives on its own site.' }),
    h('a', { href: 'https://torii-quest.pplx.app', target: '_blank', rel: 'noopener noreferrer' }, ['Open torii-quest.pplx.app ↗']),
  ]));
}
