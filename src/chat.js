/**
 * AI chat dock.
 *
 * Wiring:
 *   • If VITE_AGENT_URL is set and the user is logged in, chat goes through
 *     the agent (POST /api/chat), which pays per request in Cashu via Routstr.
 *   • Otherwise, we serve the canned mock reply so the demo build on
 *     continuum-torii.pplx.app still feels alive without a live backend.
 *
 * Each view sets context via setChatContext() so replies can reference
 * the current project/page.
 */

import { chat as agentChat } from './data/agent.js';
import { isSessionLive } from './auth.js';
import { currentRoute } from './router.js';
import { threadKeyFor, pageTypeFor, projectSlugFrom, trimThread, sanitizeThreads, THREAD_CAP } from './chat-threads.js';

let logEl, inputEl, sendBtn, contextEl, modeEl, toggleEl, dockEl;
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

export function mountChat(root) {
  dockEl = document.createElement('div');
  dockEl.className = 'chat-dock collapsed';
  dockEl.innerHTML = `
    <div class="chat-log" role="log" aria-live="polite"></div>
    <div class="chat-input-row">
      <span class="chat-context" title="Chat context"></span>
      <button class="chat-mode" type="button"></button>
      <textarea class="chat-input" placeholder="Ask Continuum anything… (mock responses)" rows="1" aria-label="Chat input"></textarea>
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

  loadThreads();
  syncActiveThread();
}

function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(140, inputEl.scrollHeight) + 'px';
}

function greet() {
  const live = isSessionLive();
  push('ai', live
    ? 'Continuum online. Signed in. I can help plan projects, draft milestones, and reason across your Brain. Model calls are paid per request via Routstr + Cashu.'
    : 'Continuum online. Running in demo mode (mock replies). Sign in with Plebeian Signer to route real calls through your agent.');
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
    el.querySelector('.bubble').textContent = m.text;
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
  if (expanded) setTimeout(() => { logEl.scrollTop = logEl.scrollHeight; }, 200);
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
  pushTo(turnKey, 'ai', reply);
}

// Append to a specific thread; only re-render when it is the visible one.
function pushTo(key, who, text) {
  if (!Array.isArray(threads[key])) threads[key] = [];
  threads[key].push({ who, text, at: Date.now() });
  threads[key] = trimThread(threads[key], THREAD_CAP);
  saveThreads();
  if (key === activeKey) renderLog();
}

/**
 * Route the user turn either to the live agent (POST /api/chat) or to the
 * local mock reply. The agent is used only when we have a session token —
 * agent.js drops the request if the token is missing or expired.
 */
async function getReply(text, ctx) {
  if (isSessionLive()) {
    const r = await agentChat({ message: text, context: ctx });
    if (r.ok && r.data?.reply) return r.data.reply;
    // Fall through to mock on any failure, with a hint prefix so the user knows
    if (r.reason && !r.offline) return `(agent error: ${r.reason})\n\n` + await mockReply(text, ctx);
    return `(agent unreachable — served mock)\n\n` + await mockReply(text, ctx);
  }
  return mockReply(text, ctx);
}

/**
 * Mock reply — pretends to be a routed DeepSeek call.
 * Used when there is no active session or the agent is unreachable.
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
