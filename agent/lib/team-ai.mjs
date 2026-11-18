/**
 * Project AI member (docs/adr-team-ai-member.md).
 *
 * One AI identity per node. The owner puts it on a project's roster as an
 * agent of the owner; the owner's Teams then adds it to that project's
 * encrypted chat like anyone else. Here it holds its own Cordn session (the
 * vendored @cordn/cli library), accepts the welcome and answers @mentions:
 *
 *   - only live messages (no backlog), only once per message;
 *   - only from someone whose roster role is owner or maintainer;
 *   - never from an agent (no loops), never in a chat it is not listed in;
 *   - answers only: no tools, no actions, no attachments;
 *   - per project the owner picks Local (Ollama) or Routstr, shown as a label.
 *
 * The pure rules are exported for tests; createTeamAi wires the effects.
 */
import { acceptTeamsJoins } from './team-ai-join.mjs';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { effectiveRole } from './roster.mjs';

export const AI_NAME = 'Continuum AI';
export const MAX_AGE_SEC = 120;
export const CONTEXT_MESSAGES = 20;
export const CONTEXT_CHARS = 8000;
export const REPLY_CHARS = 3000;
export const PER_MINUTE = 6;
export const PER_DAY = 60;
export const MODELS = Object.freeze(['local', 'routstr']);
const ASKERS = new Set(['owner', 'maintainer']);
const TEXT_KINDS = new Set([9]);
const MARKER_RE = /(?:^|\s)torii:project=([a-z0-9][a-z0-9-]{0,47})(?=$|\s)/;
const HEX64 = /^[0-9a-f]{64}$/;

/** The project slug from a chat's description marker, or null. */
export function slugOfGroup(metadata) {
  const m = typeof metadata?.description === 'string' ? metadata.description.match(MARKER_RE) : null;
  return m ? m[1] : null;
}

/** Does this message address the AI (an npub mention or a p tag)? */
export function mentions(msg, aiHex, aiNpub) {
  if (typeof msg?.content === 'string' && msg.content.includes(`nostr:${aiNpub}`)) return true;
  return Array.isArray(msg?.tags) && msg.tags.some((t) => Array.isArray(t) && t[0] === 'p' && t[1] === aiHex);
}

/**
 * Should the AI answer this message? Pure.
 * @returns {{ok:true}|{ok:false, why:string}}
 */
export function decide({ msg, aiHex, aiNpub, roster, ownerHex, adminPubkeys, now, seen }) {
  if (!msg || msg.direction !== 'inbound' || msg.sender === aiHex) return { ok: false, why: 'not_inbound' };
  if (!TEXT_KINDS.has(msg.kind)) return { ok: false, why: 'not_text' };
  if (!mentions(msg, aiHex, aiNpub)) return { ok: false, why: 'not_mentioned' };
  if (seen?.has(msg.id)) return { ok: false, why: 'seen' };
  if (!(now - msg.createdAt <= MAX_AGE_SEC)) return { ok: false, why: 'old' };
  if (!roster || roster.owner !== ownerHex) return { ok: false, why: 'no_roster' };
  // Only in a chat this project's owner runs, and only while we are listed.
  if (!Array.isArray(adminPubkeys) || !adminPubkeys.includes(roster.owner)) return { ok: false, why: 'not_owner_chat' };
  const me = roster.members.find((m) => m.pubkey === aiHex);
  if (!me || me.role !== 'agent') return { ok: false, why: 'not_listed' };
  const asker = roster.members.find((m) => m.pubkey === msg.sender);
  if (!asker || asker.role === 'agent') return { ok: false, why: 'not_person' };
  if (!ASKERS.has(effectiveRole(roster, msg.sender))) return { ok: false, why: 'role' };
  return { ok: true };
}

/** Sliding per-project limits: PER_MINUTE a minute and PER_DAY a day. */
export function createRateLimiter({ perMinute = PER_MINUTE, perDay = PER_DAY, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    take(key) {
      const t = now();
      const list = (hits.get(key) || []).filter((x) => t - x < 86_400_000);
      if (list.length >= perDay || list.filter((x) => t - x < 60_000).length >= perMinute) {
        hits.set(key, list);
        return false;
      }
      list.push(t);
      hits.set(key, list);
      return true;
    },
  };
}

/** Mentions become readable names; other nostr: references are dropped. */
export function plainText(content, names, aiNpub) {
  return String(content || '')
    .replace(/nostr:(npub1[023456789acdefghjklmnpqrstuvwxyz]+)/g, (_m, npub) => {
      if (npub === aiNpub) return `@${AI_NAME}`;
      try { return `@${names(nip19.decode(npub).data) || npub.slice(0, 12)}`; } catch { return ''; }
    })
    .replace(/nostr:\w+/g, '')
    .trim();
}

/**
 * Chat messages for the model: a short system note, then up to
 * CONTEXT_MESSAGES earlier lines (newest kept, CONTEXT_CHARS in total), then
 * the question.
 */
export function buildPrompt({ slug, history, msg, aiHex, aiNpub, names }) {
  const system = `You are ${AI_NAME}, a helper inside the private, encrypted team chat for the project "${slug}". `
    + 'Answer the question you were asked, briefly and in plain text. You can read the recent messages below. '
    + 'You cannot take actions, open files, change the project or see anything outside this chat. '
    + 'If you are not sure, say so.';
  const line = (m) => `${m.sender === aiHex ? AI_NAME : names(m.sender) || m.sender.slice(0, 8)}: ${plainText(m.content, names, aiNpub)}`;
  const earlier = [];
  let used = 0;
  const before = (history || []).filter((m) => TEXT_KINDS.has(m.kind) && m.id !== msg.id && m.cursor < msg.cursor);
  for (let i = before.length - 1; i >= 0 && earlier.length < CONTEXT_MESSAGES; i--) {
    const l = line(before[i]).slice(0, 1000);
    if (used + l.length > CONTEXT_CHARS) break;
    used += l.length;
    earlier.unshift(l);
  }
  const messages = [{ role: 'system', content: system }];
  if (earlier.length) messages.push({ role: 'user', content: `Recent messages in the chat:\n${earlier.join('\n')}` });
  messages.push({ role: 'user', content: line(msg).slice(0, 4000) });
  return messages;
}

/** "Local · llama3.2:1b" / "Routstr · gpt-4o-mini". */
export function modelLabel(model, { localModel, routstrModel } = {}) {
  return model === 'routstr' ? `Routstr · ${routstrModel || 'auto'}` : `Local · ${localModel || 'model'}`;
}

/** Per-project settings: { [slug]: { model } }. Default is Local. */
export function createAiSettings({ dir }) {
  const file = join(dir, 'settings.json');
  let cache = null;
  async function load() {
    if (cache) return cache;
    try { cache = JSON.parse(await readFile(file, 'utf8')); } catch { cache = {}; }
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
    return cache;
  }
  return {
    async get(slug) {
      const s = (await load())[slug];
      return { model: MODELS.includes(s?.model) ? s.model : 'local' };
    },
    async set(slug, { model }) {
      if (!MODELS.includes(model)) return { ok: false, code: 'bad_model' };
      const all = { ...(await load()), [slug]: { model } };
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify(all), { mode: 0o600 });
      await rename(tmp, file);
      cache = all;
      return { ok: true, model };
    },
  };
}

/**
 * The running member. Disabled (info().enabled false) without a coordinator
 * and relay in config.teams.
 */
export function createTeamAi({
  cfg, secretStore, rosterStore, teamsState, router, chatModel, dir, log, profiles = null,
  loadSession = () => import('../vendor/cordn-session.mjs'),
  now = () => Math.floor(Date.now() / 1000),
  pollMs = 5000,
  retryMs = 5000,
}) {
  const coordinator = cfg.teams?.coordinator || null;
  const relay = cfg.teams?.relay || null;
  const settings = createAiSettings({ dir });
  const limiter = createRateLimiter();
  const seen = new Set();
  const names = new Map();
  let sk = null, hex = null, npub = null, session = null, persistent = null, timer = null;
  let ready = false, stopped = false, lastError = null;

  async function identity() {
    if (hex) return;
    let stored = await secretStore.get('team_ai_key');
    if (!stored || !HEX64.test(stored)) {
      stored = randomBytes(32).toString('hex');
      await secretStore.put('team_ai_key', stored, { atomic: true });
    }
    sk = Uint8Array.from(Buffer.from(stored, 'hex'));
    hex = getPublicKey(sk);
    npub = nip19.npubEncode(hex);
  }

  function remember(seenId) {
    seen.add(seenId);
    if (seen.size > 2000) seen.delete(seen.values().next().value);
  }

  async function answer(alias, msg) {
    const group = session.getGroup(alias);
    const slug = slugOfGroup(group?.metadata);
    if (!slug) return;
    const stored = await rosterStore.get(slug);
    const roster = stored?.roster ?? null;
    const verdict = decide({
      msg, aiHex: hex, aiNpub: npub, roster, ownerHex: roster?.owner,
      adminPubkeys: group?.metadata?.adminPubkeys, now: now(), seen,
    });
    if (!verdict.ok) {
      log.debug?.({ evt: 'team_ai.pass', why: verdict.why, kind: msg?.kind });
      if (verdict.why !== 'not_mentioned' && verdict.why !== 'not_text') log.info({ evt: 'team_ai.skip', why: verdict.why });
      return;
    }
    remember(msg.id);
    if (!limiter.take(slug)) {
      await session.sendMessage(alias, 'I am answering a lot right now. Please ask again in a minute.');
      return;
    }
    const { model } = await settings.get(slug);
    const label = labelFor(model);
    const history = session.listMessages(alias);
    await learnNames(roster.members.map((m) => m.pubkey));
    const nameOf = (pk) => names.get(pk) || '';
    const messages = buildPrompt({ slug, history, msg, aiHex: hex, aiNpub: npub, names: nameOf });
    let text;
    if (model === 'local' && !cfg.ollama?.enabled) {
      text = 'The local model is off on this server, so I cannot answer yet. The owner can switch me to Routstr in the project Team page.';
    } else {
      const r = await router.chat({ skill: 'chat', messages, strategy: model === 'routstr' ? 'routstr_only' : 'ollama_only' });
      text = r?.ok && typeof r.content === 'string' && r.content.trim()
        ? r.content.trim().slice(0, REPLY_CHARS)
        : 'Sorry, I could not get an answer from the model just now.';
      log.info({ evt: 'team_ai.reply', ok: Boolean(r?.ok), provider: r?.provider || null, label });
    }
    await session.sendMessage(alias, text);
    await persistent?.persist().catch(() => {});
  }

  function labelFor(model) {
    return modelLabel(model, { localModel: cfg.ollama?.model, routstrModel: chatModel?.() });
  }

  async function acceptWelcomes(welcomeIdentifier) {
    const list = await session.fetchWelcomes();
    for (const w of list) {
      try {
        const g = await session.acceptWelcome(welcomeIdentifier(w));
        log.info({ evt: 'team_ai.joined', project: slugOfGroup(g?.metadata) });
      } catch (e) {
        log.warn({ evt: 'team_ai.accept_failed', err: String(e?.message || e).slice(0, 200) });
      }
    }
    if (list.length) {
      await session.watchAllGroups();
      await persistent.persist();
    }
  }

  async function connect() {
    await identity();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    const lib = await loadSession();
    const { openPersistentSession, welcomeIdentifier } = lib;
    persistent = await openPersistentSession({
      stateFile: join(dir, 'session.state'),
      privateKey: Buffer.from(sk).toString('hex'),
      serverPubkey: coordinator,
      relays: [relay],
      transportEncryption: 'required',
    });
    session = persistent.session;
    // Teams members who join while the owner is away arrive under a join seal.
    if (lib.decryptGroupPayload) acceptTeamsJoins(session, lib, log);
    await chmod(join(dir, 'session.state.key'), 0o600).catch(() => {});
    if (!session.getLastResortKeyPackage?.()) {
      await session.generateKeyPackage('continuum-ai', { lastResort: true });
      await persistent.persist();
    }
    await teamsState.setReady(hex);
    ready = true;
    session.onGroupEvent((ev) => {
      if (ev.type !== 'messages-ingested') return;
      log.debug?.({ evt: 'team_ai.ingested', n: ev.received?.length || 0, issues: (ev.issues || []).map((i) => String(i.detail).slice(0, 120)) });
      // Live only: the first sync of a chat replays its history.
      for (const m of ev.received) {
        answer(ev.groupAlias, m).catch((e) => log.warn({ evt: 'team_ai.answer_failed', err: String(e?.message || e).slice(0, 200) }));
      }
    });
    await session.watchAllGroups();
    const tick = async () => {
      if (stopped) return;
      try { await acceptWelcomes(welcomeIdentifier); lastError = null; } catch (e) { lastError = String(e?.message || e).slice(0, 200); }
      if (!stopped) timer = setTimeout(tick, pollMs);
    };
    tick();
    log.info({ evt: 'team_ai.on', pubkey: hex });
  }

  /**
   * Never throws: a slow or down chat server is retried with backoff (5 s up
   * to 5 min) so the agent keeps running and the AI comes up when it can.
   */
  async function start() {
    if (!coordinator || !relay) {
      log.info({ evt: 'team_ai.off', why: 'no teams.coordinator / teams.relay in config' });
      return;
    }
    let delay = retryMs;
    while (!stopped) {
      try {
        await connect();
        return;
      } catch (e) {
        lastError = String(e?.message || e).slice(0, 200);
        log.warn({ evt: 'team_ai.start_retry', err: lastError, in_ms: delay });
        await persistent?.close?.().catch(() => {});
        persistent = null; session = null; ready = false;
        await new Promise((r) => { timer = setTimeout(r, delay); });
        delay = Math.min(delay * 2, 300_000);
      }
    }
  }

  async function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    await persistent?.close?.().catch(() => {});
  }

  /** Names for the prompt, from the team profiles the agent already keeps. */
  async function learnNames(pubkeys) {
    const want = pubkeys.filter((pk) => HEX64.test(pk) && pk !== hex && !names.has(pk)).slice(0, 50);
    if (!want.length || !profiles) return;
    try {
      for (const p of Object.values(await profiles(want) || {})) {
        const n = p?.display_name || p?.name;
        if (n) names.set(p.pubkey, String(n).slice(0, 64));
      }
    } catch { /* names are a nicety */ }
  }

  /** The AI's own kind-0, signed here, so Teams shows its name. */
  function profileEvent() {
    if (!sk) return null;
    return finalizeEvent({ kind: 0, created_at: 1767225600, tags: [], content: JSON.stringify({ name: AI_NAME, display_name: AI_NAME, about: 'The project AI on this Torii node.', bot: true }) }, sk);
  }

  async function info(slug) {
    if (coordinator && relay) await identity();
    const base = { enabled: Boolean(coordinator && relay), ready, pubkey: hex, npub, name: AI_NAME, error: lastError };
    if (!slug) return base;
    const { model } = await settings.get(slug);
    return { ...base, model, label: labelFor(model), local_available: cfg.ollama?.enabled === true };
  }

  return { start, stop, info, settings, profileEvent, identity, get pubkey() { return hex; } };
}
