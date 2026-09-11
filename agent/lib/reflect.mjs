/**
 * Reflection pass — offline only. NEVER runs during a live chat turn.
 *
 * The agent reads its own episodic log at agent/memory/episodic/*.jsonl
 * and proposes new semantic_fact (30094) and procedural_skill (30095)
 * drafts into agent/pending/*.draft.json. The operator reviews each draft
 * and signs (or discards) via Plebeian Signer.
 *
 * Reflection has three phases:
 *
 *   1. Read episodic entries newer than the last-reflected watermark.
 *   2. Extract candidate facts / candidate reflexes via heuristics
 *      (no LLM call in this first cut — deterministic pattern matching
 *      to avoid the model inventing beliefs).
 *   3. Deduplicate against existing 30094/30095 slugs, then write drafts.
 *
 * Design rules:
 *
 *   - Every draft is written to agent/pending/, not memory/. Nothing
 *     enters the character stack without an operator signature.
 *   - Drafts include `evidence`: the exact episodic line(s) that led
 *     to the proposal, so the operator can audit.
 *   - Reflect never proposes a destructive_intent (30096). Only the
 *     operator does that, from the console.
 *
 * v1 is intentionally boring: pattern-matching only. A follow-up
 * (CONT-CHARACTER-2) can add LLM-assisted reflection with strict
 * grounding to episodic evidence.
 */

import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { draftSemanticFact, draftProceduralSkill, KINDS } from './events.mjs';

const WATERMARK_FILE = 'reflect-watermark.json';

/**
 * Simple deterministic patterns for the first reflection pass. Each
 * yields a candidate 30094 or 30095 draft when its trigger fires.
 *
 * IMPORTANT: patterns must be conservative. It is better to propose
 * nothing than to propose a personality change the operator didn't ask
 * for. The whole point of the character stack is that beliefs come from
 * the operator, not from LLM inference on chat history.
 */
const PATTERNS = [
  {
    // Explicit preference statement — user tells the agent to remember X.
    slug_prefix: 'user-preference',
    match: (line) => /\b(remember that|from now on|always|never)\b/i.test(line.user_message || ''),
    build: (line) => ({
      kind: KINDS.SEMANTIC_FACT,
      draft: draftSemanticFact({
        slug: `user-preference-${shortHash(line.user_message)}`,
        fact: line.user_message.trim().slice(0, 400),
        why: 'Operator stated as preference during chat',
        source: `episodic ${line.ts || 'unknown'}`,
        confidence: 'high',
      }),
      evidence: [line],
    }),
  },
  {
    // Refusal-worthy pattern — user asks the agent to break a stated law.
    slug_prefix: 'refusal-teach',
    match: (line) => /\b(publish|post|tweet|nostr|broadcast)\b.*\b(for me|automatically|without asking)\b/i.test(line.user_message || ''),
    build: (line) => ({
      kind: KINDS.PROCEDURAL_SKILL,
      draft: draftProceduralSkill({
        slug: `refuse-autonomous-publish-${shortHash(line.user_message)}`,
        name: 'refuse-autonomous-publish',
        trigger: 'operator asks agent to publish to nostr without explicit per-event click',
        action: 'refuse citing Law 1 (Sovereignty) and Law 2 (Obedience within Character); offer to draft into pending/ instead',
        guard: null,
      }),
      evidence: [line],
    }),
  },
];

function shortHash(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 10);
}

/**
 * @param {object} deps
 * @param {string} deps.agentRoot
 * @param {ReturnType<import('./crypto.mjs').createMemoryCache>} deps.cache
 * @param {object} deps.log
 */
export function createReflector({ agentRoot, cache, log }) {
  const episodicDir = join(agentRoot, 'memory', 'episodic');
  const pendingDir = join(agentRoot, 'pending');
  const watermarkPath = join(agentRoot, 'memory', WATERMARK_FILE);

  async function readWatermark() {
    try {
      const buf = await readFile(watermarkPath, 'utf8');
      return JSON.parse(buf);
    } catch {
      return { last_ts: 0, last_file: null };
    }
  }

  async function writeWatermark(w) {
    await mkdir(join(agentRoot, 'memory'), { recursive: true, mode: 0o700 });
    await writeFile(watermarkPath, JSON.stringify(w, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  async function listEpisodicFiles() {
    try {
      const files = await readdir(episodicDir);
      return files.filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      return [];
    }
  }

  async function readEpisodicLines(file, sinceTs) {
    const path = join(episodicDir, file);
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if ((obj.ts || 0) <= sinceTs) continue;
      out.push(obj);
    }
    return out;
  }

  /**
   * Existing slug set — do not propose duplicates.
   */
  function existingSlugs() {
    const s = new Set();
    for (const e of cache.list(KINDS.SEMANTIC_FACT)) s.add(`${KINDS.SEMANTIC_FACT}:${e.dTag}`);
    for (const e of cache.list(KINDS.PROCEDURAL_SKILL)) s.add(`${KINDS.PROCEDURAL_SKILL}:${e.dTag}`);
    return s;
  }

  /**
   * Also load slug set from existing drafts in pending/ so we don't
   * re-draft the same proposal on every reflect() call.
   */
  async function pendingSlugs() {
    const s = new Set();
    try {
      const files = await readdir(pendingDir);
      for (const f of files) {
        if (!f.endsWith('.draft.json')) continue;
        try {
          const buf = await readFile(join(pendingDir, f), 'utf8');
          const obj = JSON.parse(buf);
          const dTag = (obj.tags || []).find((t) => Array.isArray(t) && t[0] === 'd')?.[1];
          if (obj.kind && dTag) s.add(`${obj.kind}:${dTag}`);
        } catch { /* skip malformed */ }
      }
    } catch { /* no pending dir yet */ }
    return s;
  }

  /**
   * Run one reflection pass. Returns a summary; does not sign anything.
   *
   * @param {object} opts
   * @param {number} [opts.limit]   max drafts to propose per pass (default 10)
   * @param {boolean} [opts.dryRun] if true, don't write files
   */
  async function reflect({ limit = 10, dryRun = false } = {}) {
    if (!cache.isUnlocked()) {
      return { ok: false, reason: 'memory cache locked — unlock first' };
    }
    await mkdir(pendingDir, { recursive: true, mode: 0o700 });

    const watermark = await readWatermark();
    const files = await listEpisodicFiles();
    const existing = existingSlugs();
    const pending = await pendingSlugs();
    const proposed = [];
    let latestTs = watermark.last_ts;

    for (const file of files) {
      const lines = await readEpisodicLines(file, watermark.last_ts);
      for (const line of lines) {
        if (line.ts && line.ts > latestTs) latestTs = line.ts;
        for (const p of PATTERNS) {
          if (!p.match(line)) continue;
          let candidate;
          try {
            candidate = p.build(line);
          } catch (e) {
            log.warn(`[reflect] pattern ${p.slug_prefix} failed to build: ${e.message}`);
            continue;
          }
          const dTag = (candidate.draft.tags || []).find((t) => t[0] === 'd')?.[1];
          const key = `${candidate.kind}:${dTag}`;
          if (existing.has(key) || pending.has(key)) continue;

          if (!dryRun) {
            const path = join(pendingDir, `${candidate.kind}-${dTag}.draft.json`);
            const record = {
              ...candidate.draft,
              _proposed_at: Math.floor(Date.now() / 1000),
              _pattern: p.slug_prefix,
              _evidence: candidate.evidence,
              _needs: 'operator NIP-44 encrypt + sign via Plebeian Signer',
            };
            await writeFile(path, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
          }
          pending.add(key);
          proposed.push({ kind: candidate.kind, d_tag: dTag, pattern: p.slug_prefix });
          if (proposed.length >= limit) break;
        }
        if (proposed.length >= limit) break;
      }
      if (proposed.length >= limit) break;
    }

    if (!dryRun && latestTs > watermark.last_ts) {
      await writeWatermark({ last_ts: latestTs, last_file: files[files.length - 1] || null });
    }

    return {
      ok: true,
      proposed_count: proposed.length,
      proposed,
      watermark_before: watermark.last_ts,
      watermark_after: latestTs,
      dry_run: dryRun,
    };
  }

  /**
   * Append an episodic entry. Called from skills/chat.mjs AFTER the model
   * has responded. Purely for offline reflection — never read at inference.
   */
  async function appendEpisodic({ user_message, assistant_reply, model, context }) {
    await mkdir(episodicDir, { recursive: true, mode: 0o700 });
    const date = new Date();
    const iso = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const file = join(episodicDir, `${iso}.jsonl`);
    const entry = {
      ts: Math.floor(date.getTime() / 1000),
      user_message: (user_message || '').slice(0, 4000),
      assistant_reply: (assistant_reply || '').slice(0, 8000),
      model: model || null,
      context: context || null,
    };
    await writeFile(file, JSON.stringify(entry) + '\n', { flag: 'a', encoding: 'utf8', mode: 0o600 });
  }

  return { reflect, appendEpisodic };
}
