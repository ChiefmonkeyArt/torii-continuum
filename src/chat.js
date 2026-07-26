/**
 * AI chat dock.
 *
 * Wiring:
 *   • If an agent is configured (VITE_AGENT_URL / same-origin) and the user is
 *     logged in, chat goes through the agent (POST /api/chat), which pays per
 *     request in Cashu via Routstr and falls back to a local Ollama model on a
 *     retryable upstream failure.
 *   • Canned mock replies exist ONLY for the agent-less demo build. A production
 *     build (agent configured) NEVER fabricates a reply: a failed turn reports a
 *     structured, sanitised error so the operator can't mistake a canned string
 *     for their sovereign bot. See mockRepliesAllowed().
 *
 * Each view sets context via setChatContext() so replies can reference
 * the current project/page.
 */

import { chat as agentChat, isAgentConfigured } from './data/agent.js';
import { isSessionLive } from './auth.js';
import { currentRoute } from './router.js';
import { threadKeyFor, pageTypeFor, projectSlugFrom, trimThread, sanitizeThreads, THREAD_CAP } from './chat-threads.js';
import { clampInputHeight, inputShouldScroll, reserveSpaceFor } from './chat-layout.js';

let logEl, inputEl, sendBtn, contextEl, modeEl, toggleEl, dockEl;
let dockResizeObserver = null;
// Per-thread message history. Each key (see chat-threads.threadKeyFor) maps to
// its own message array so navigating between pages/projects swaps the visible
// conversation without losing any thread's history.
let threads = {};
let activeKey = 'page:/';
let mode = 'page'; // 'page' (default) | 'general'
let context = { label: 'Continuum', where: 'projects' };
let expanded = false;
let thinking = false;

const THREADS_STORAGE_KEY = 'continuum.chat.threads';
// Read by the Routstr page (src/views/routstr.js) on mount: when set, the page
// auto-reveals and focuses the Cashu receive/top-up form so the operator lands
// exactly where they need to add funds after tapping "Top Up" in the chat dock.
const ROUTSTR_FOCUS_TOPUP_KEY = 'continuum.routstr.focusTopUp';

/**
 * Decide whether a failed agent chat result is an insufficient-funds condition,
 * so the dock can offer a top-up path instead of a generic "(agent error…)"
 * mock. Prefers a structured `code === "insufficient_funds"` if the agent ever
 * exposes one (checked on the result and on result.data), and falls back to
 * text-matching the human reason string the agent returns today, e.g.
 *   "routstr: wallet: insufficient balance across all mints for 50 sats
 *    (need +100 floor); ollama: timeout after 60000ms"
 * Pure + exported so the contract is unit-tested without a network.
 * @param {any} result agent.chat() result ({ ok, reason, code?, data?, status? })
 * @returns {boolean}
 */
export function isInsufficientFundsReply(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.code === 'insufficient_funds') return true;
  if (result.data && result.data.code === 'insufficient_funds') return true;
  const reason = typeof result.reason === 'string' ? result.reason.toLowerCase() : '';
  if (!reason) return false;
  return /insufficient balance|insufficient funds|insufficient_funds|hard_floor|need \+\d+ floor|\b402\b/.test(reason);
}

export function mountChat(root) {
  dockEl = document.createElement('div');
  dockEl.className = 'chat-dock collapsed';
  dockEl.setAttribute('role', 'region');
  dockEl.setAttribute('aria-label', 'Continuum chat');
  dockEl.innerHTML = `
    <div class="chat-log" role="log" aria-live="polite"></div>
    <div class="chat-input-row">
      <span class="chat-context" title="Chat context"></span>
      <button class="chat-mode" type="button"></button>
      <textarea class="chat-input" placeholder="Ask Continuum anything…" rows="1" aria-label="Chat input"></textarea>
      <button class="chat-send" type="button">Send</button>
      <button class="chat-toggle" type="button" aria-label="Toggle chat">▲</button>
    </div>
  `;
  root.appendChild(dockEl);

  logEl = dockEl.querySelector('.chat-log');
  inputEl = dockEl.querySelector('.chat-input');
  sendBtn = dockEl.querySelector('.chat-send');
  contextEl = dockEl.querySelector('.chat-context');
  modeEl = dockEl.querySelector('.chat-mode');
  toggleEl = dockEl.querySelector('.chat-toggle');

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener('input', autosize);
  modeEl.addEventListener('click', toggleMode);
  toggleEl.addEventListener('click', () => setExpanded(!expanded));

  // Keep the content scroller's reserved bottom space in lockstep with the
  // floating dock's height — whether it changes from auto-grow, expand/collapse,
  // a new message, or a viewport resize — so no content is ever obscured.
  if (typeof ResizeObserver !== 'undefined') {
    dockResizeObserver = new ResizeObserver(() => reserveSpace());
    dockResizeObserver.observe(dockEl);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', reserveSpace);
  }

  loadThreads();
  syncActiveThread();
  updatePlaceholder();
  autosize();
  reserveSpace();
}

// Only the agent-less demo build may advertise mock replies. Signed in, or in
// any production build, replies are real agent calls (or an honest error), so
// the "(mock responses)" qualifier would be a lie.
function updatePlaceholder() {
  if (!inputEl) return;
  inputEl.placeholder = !isSessionLive() && mockRepliesAllowed()
    ? 'Ask Continuum anything… (mock responses)'
    : 'Ask Continuum anything…';
}

// Auto-grow the textarea with its content up to a sensible max, then let it
// scroll internally instead of pushing the dock taller. Any height change
// re-reserves matching space below the content.
function autosize() {
  if (!inputEl) return;
  inputEl.style.height = 'auto';
  const scrollH = inputEl.scrollHeight;
  inputEl.style.height = clampInputHeight(scrollH) + 'px';
  inputEl.style.overflowY = inputShouldScroll(scrollH) ? 'auto' : 'hidden';
  reserveSpace();
}

// Publish the floating dock's height (plus a gap) as --chat-reserve so the main
// content scroller can pad its bottom by exactly that much. A zero measurement
// (pre-layout) leaves the CSS fallback in place rather than collapsing content.
function reserveSpace() {
  if (!dockEl || typeof document === 'undefined') return;
  const reserve = reserveSpaceFor(dockEl.offsetHeight);
  const root = document.documentElement;
  if (!root || !root.style) return;
  if (reserve > 0) root.style.setProperty('--chat-reserve', reserve + 'px');
}

function greet() {
  if (isSessionLive()) {
    push('ai', 'Continuum online. Signed in. I can help plan projects, draft milestones, and reason across your Brain. Model calls are paid per request via Routstr + Cashu, with a local model as fallback.');
    return;
  }
  push('ai', mockRepliesAllowed()
    ? 'Continuum online. Running in demo mode (mock replies). Sign in with Plebeian Signer to route real calls through your agent.'
    : 'Continuum online. Sign in with Plebeian Signer to route real calls through your agent.');
}

export function setChatContext(next) {
  context = { ...context, ...next };
  syncActiveThread();
}

/**
 * Build the enriched context sent to the agent: the label/where the current
 * view set, plus the router-derived route/pageType/projectSlug and the current
 * mode. columnId/cardId are best-effort (the board keeps them in-memory, not in
 * the hash) so they are null here. Unknown fields are ignored server-side.
 */
function buildContext() {
  const r = currentRoute() || { pattern: '/', params: {} };
  const route = (typeof window !== 'undefined' && window.location.hash)
    ? window.location.hash.slice(1) : '/';
  return {
    label: context.label,
    where: context.where,
    mode,
    route,
    pageType: pageTypeFor(r.pattern),
    projectSlug: (r.params && r.params.slug) || projectSlugFrom(context) || null,
    columnId: null,
    cardId: null,
  };
}

// Recompute the active thread key from the current context + mode, swap the
// visible history to that thread, greet it if empty, and refresh the chrome.
function syncActiveThread() {
  activeKey = threadKeyFor(buildContext(), mode);
  if (!Array.isArray(threads[activeKey])) threads[activeKey] = [];
  if (threads[activeKey].length === 0) greet();
  renderContext();
  updatePlaceholder();
  renderLog();
}

function toggleMode() {
  mode = mode === 'general' ? 'page' : 'general';
  syncActiveThread();
}

function currentMessages() {
  if (!Array.isArray(threads[activeKey])) threads[activeKey] = [];
  return threads[activeKey];
}

function renderContext() {
  if (!contextEl) return;
  const label = mode === 'general' ? 'general' : context.label;
  contextEl.textContent = `context · ${label}`;
  contextEl.title = `Context: ${label} · ${context.where} · ${mode}`;
  if (modeEl) {
    const general = mode === 'general';
    modeEl.textContent = general ? 'General' : 'This page';
    modeEl.classList.toggle('active', general);
    modeEl.setAttribute('aria-pressed', String(general));
    modeEl.setAttribute('aria-label', general
      ? 'Chat scope: general side conversation. Switch to this page.'
      : 'Chat scope: this page. Switch to a general side conversation.');
  }
}

function push(who, text) {
  pushTo(activeKey, who, text);
}

function loadThreads() {
  try {
    const raw = localStorage.getItem(THREADS_STORAGE_KEY);
    if (raw) threads = sanitizeThreads(JSON.parse(raw), THREAD_CAP);
  } catch (_e) { threads = {}; }
}

function saveThreads() {
  try {
    localStorage.setItem(THREADS_STORAGE_KEY, JSON.stringify(threads));
  } catch (_e) { /* quota / disabled storage — keep threads in-memory only */ }
}

function renderLog() {
  logEl.innerHTML = '';
  for (const m of currentMessages()) {
    const el = document.createElement('div');
    el.className = 'chat-msg ' + m.who;
    el.innerHTML = `
      <div class="avatar">${m.who === 'user' ? 'you' : 'AI'}</div>
      <div class="bubble"></div>
    `;
    const bubble = el.querySelector('.bubble');
    bubble.textContent = m.text;
    if (m.action === 'topup') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-topup primary';
      btn.textContent = 'Top Up';
      btn.addEventListener('click', goToTopUp);
      bubble.appendChild(btn);
    }
    logEl.appendChild(el);
  }
  if (thinking) {
    const t = document.createElement('div');
    t.className = 'chat-thinking';
    t.textContent = 'thinking';
    logEl.appendChild(t);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function setExpanded(v) {
  expanded = v;
  dockEl.classList.toggle('expanded', expanded);
  dockEl.classList.toggle('collapsed', !expanded);
  toggleEl.textContent = expanded ? '▼' : '▲';
  reserveSpace();
  if (expanded) setTimeout(() => { logEl.scrollTop = logEl.scrollHeight; reserveSpace(); }, 200);
}

async function send() {
  const text = (inputEl.value || '').trim();
  if (!text || thinking) return;
  // Pin the turn to the thread it was sent from, so an AI reply that arrives
  // after the user has navigated to another page still lands in the right
  // conversation rather than the newly-active one.
  const turnKey = activeKey;
  push('user', text);
  inputEl.value = '';
  autosize();
  if (!expanded) setExpanded(true);

  thinking = true;
  renderLog();
  const reply = await getReply(text, buildContext());
  thinking = false;
  if (reply && typeof reply === 'object') pushTo(turnKey, 'ai', reply.text, reply.action);
  else pushTo(turnKey, 'ai', reply);
}

// Append to a specific thread; only re-render when it is the visible one. An
// optional `action` tags the message so renderLog can attach an affordance
// (e.g. a "Top Up" button for an insufficient-funds reply).
function pushTo(key, who, text, action) {
  if (!Array.isArray(threads[key])) threads[key] = [];
  threads[key].push({ who, text, at: Date.now(), ...(action ? { action } : {}) });
  threads[key] = trimThread(threads[key], THREAD_CAP);
  saveThreads();
  if (key === activeKey) renderLog();
}

/**
 * Are canned mock replies permitted in this build?
 *
 * ONLY for the agent-less demo build (no VITE_AGENT_URL, no same-origin agent).
 * Once an agent is configured this is a production install, and fabricating a
 * plausible-looking reply there is actively harmful: the operator cannot tell a
 * canned string from their bot's real answer, and a silent mock masks a real
 * outage. Pure + exported so the invariant is unit-tested.
 * @returns {boolean}
 */
export function mockRepliesAllowed() {
  return !isAgentConfigured();
}

/**
 * Map a failed agent chat result to an operator-facing sentence, keyed off the
 * agent's structured `code` (agent/lib/provider-errors.mjs) with a graceful
 * degradation to the sanitised reason string. Never fabricates an assistant
 * answer — this is always presented as an error, not a reply.
 * Pure + exported for tests.
 * @param {any} result agent.chat() result
 * @returns {string}
 */
export function chatErrorMessage(result) {
  const code = result && typeof result.code === 'string' ? result.code : null;
  switch (code) {
    case 'upstream_timeout':
      return 'The model provider timed out and the local fallback did not answer either. Nothing was charged for an unanswered turn. Try again in a moment.';
    case 'upstream_html':
      return 'The model provider returned an error page instead of a response (usually a temporary edge/proxy fault). Try again shortly.';
    case 'upstream_5xx':
      return 'The model provider is returning server errors right now, and the local fallback was unavailable. Try again shortly.';
    case 'upstream_empty':
      return 'The model returned an empty response. Try rephrasing, or try again in a moment.';
    case 'network':
      return 'Could not reach the model provider or the local fallback. Check the agent’s connectivity and try again.';
    case 'provider_disabled':
      return 'No model provider is available: Routstr failed and no local Ollama model is enabled. Enable a local model or restore Routstr access.';
    case 'bad_request':
      return 'The agent rejected that request as malformed. This is a bug worth reporting rather than a provider outage.';
    case 'budget_exhausted':
      return 'That turn ran out of time before any model could answer, so it was stopped rather than left hanging. Nothing was charged. Try again, or raise the agent’s turn budget (model_router.total_budget_ms).';
    case 'client_timeout':
      return 'Your agent did not respond in time, so this turn was abandoned here in the browser. It may still be working — wait a moment before retrying.';
    default:
      break;
  }
  if (result && result.offline) {
    return 'Your agent is unreachable, so this turn could not be routed. No canned reply is served in a production build — reconnect the agent and try again.';
  }
  const reason = result && typeof result.reason === 'string' && result.reason.trim() ? result.reason.trim() : 'unknown error';
  return `That turn could not be completed: ${reason}`;
}

/**
 * Route the user turn to the live agent (POST /api/chat). The agent is used only
 * when we have a session token — agent.js drops the request if the token is
 * missing or expired. Canned replies are served ONLY on the agent-less demo
 * build; a production build reports a structured error instead of a fake answer.
 */
async function getReply(text, ctx) {
  if (isSessionLive()) {
    const r = await agentChat({ message: text, context: ctx });
    if (r.ok && r.data?.reply) {
      // Be honest when the paid provider failed and the free local model answered.
      const fellBack = r.data.fell_back_from;
      return fellBack
        ? `${r.data.reply}\n\n_(answered by the local ${r.data.model || 'fallback'} model — ${fellBack} was unavailable)_`
        : r.data.reply;
    }
    // Insufficient funds is a recoverable, user-actionable state — surface a
    // clear message plus a Top Up path.
    if (isInsufficientFundsReply(r)) {
      return { text: 'You have insufficient funds to route this request. Top up your wallet to keep chatting.', action: 'topup' };
    }
    return chatErrorMessage(r);
  }
  // Signed out. The demo build shows the canned shell; a production build asks
  // the visitor to sign in rather than pretending to be the bot.
  if (mockRepliesAllowed()) return mockReply(text, ctx);
  return 'Sign in with your Nostr signer to route this through your agent. Continuum does not answer with canned replies in a live install.';
}

// Navigate to the Routstr page and ask it to focus the top-up/receive form.
// The sessionStorage flag is best-effort — navigation still happens if storage
// is unavailable; the page just won't auto-open the receive section.
function goToTopUp() {
  try { sessionStorage.setItem(ROUTSTR_FOCUS_TOPUP_KEY, '1'); } catch (_e) {}
  if (typeof window !== 'undefined') window.location.hash = '#/routstr';
}

/**
 * Mock reply — canned demo-shell copy. Reachable ONLY on the agent-less demo
 * build for a signed-out visitor (see mockRepliesAllowed). Never served as a
 * substitute for a failed live agent turn.
 */
function mockReply(text, ctx) {
  const q = text.toLowerCase();
  const canned = pickCanned(q, ctx);
  return new Promise((resolve) => {
    const delay = 500 + Math.floor(Math.random() * 600);
    setTimeout(() => resolve(canned), delay);
  });
}

function pickCanned(q, ctx) {
  if (q.includes('help') || q.includes('what can')) {
    return `I'm your project engine. I can help with:
• planning milestones and next actions on ${ctx.label}
• listing todos / adding new ones
• summarising sessions
• browsing marketplace tasks tagged for ${ctx.label}
• picking a model on Routstr (default: DeepSeek Chat)
This is a mock shell — real calls light up once Routstr is connected.`;
  }
  if (q.includes('milestone') || q.includes('roadmap')) {
    return `${ctx.label} has 5 milestones in the current plan. M1–M2 are done, M3 is active. Open the Project home page (left menu → Projects → click a card) to see the full ladder.`;
  }
  if (q.includes('todo') || q.includes('task')) {
    return `Open the project home to see the todo list — you can toggle items and add new ones. To publish an AI-work task, drop it on the Marketplace (left menu).`;
  }
  if (q.includes('routstr') || q.includes('model') || q.includes('deepseek')) {
    return `Routstr page is under the Routstr tab. Default model is DeepSeek Chat (6 sats / 1k tokens). Pay-per-request via Cashu — connect a wallet to enable.`;
  }
  if (q.includes('marketplace') || q.includes('bounty')) {
    return `Marketplace lists open AI-work tasks. Your Quest + Continuum tasks are highlighted in amber so you can see what belongs to your projects vs. the wider network.`;
  }
  if (q.includes('new project') || q.includes('add repo') || q.includes('github')) {
    return `Projects → “New Project” lets you paste a GitHub URL (github.com/user/repo) or an ngit remote (ngit://…). Names auto-slug to a project id.`;
  }
  return `(mock) noted for ${ctx.label}: “${q.slice(0, 120)}”. I'd normally route this to DeepSeek Chat via Routstr — wire a Cashu-loaded endpoint on the Routstr page to switch on live replies.`;
}

export function toggleChat() { setExpanded(!expanded); }

/**
 * Prefill the dock with a prepared turn WITHOUT sending it. Used by the board's
 * "Ask Continuum to work on this task" action: the operator reviews the drafted
 * prompt and hits Send themselves, because every agent turn spends sats. This
 * only prepares the input — it never calls send(). No-op if the dock isn't
 * mounted yet.
 */
export function compose(text) {
  if (!inputEl) return;
  mode = 'page';
  syncActiveThread();
  inputEl.value = text;
  autosize();
  setExpanded(true);
  renderContext();
  inputEl.focus();
}
