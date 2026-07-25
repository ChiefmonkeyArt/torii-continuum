/**
 * Chat skill — with character + memory grounding (CONT-CHARACTER-1).
 *
 * The prompt has FOUR layers, in this exact order:
 *
 *   1. Base skill instructions (this file's SKILL_INSTRUCTIONS)
 *      — what the skill's role is, hard invariants of the app itself.
 *
 *   2. Character (CHARACTER.md v2, verified against signed 30092 root)
 *      — the Three Laws, sovereignty stance, 13 reflexes, source lineage.
 *
 *   3. Procedural skills (from decrypted 30095 events)
 *      — reflexes injected as directives the model must apply before speaking.
 *
 *   4. Semantic facts (from decrypted 30094 events)
 *      — durable operator preferences and beliefs.
 *
 * If the memory cache is locked (no /api/memory/unlock yet), layers 2\u20134
 * degrade to a minimal safety notice: the agent still runs, but announces
 * to the model that it is operating without character memory and should
 * defer questions that require it.
 *
 * Episodic (30096 not applicable — no 30096 at inference) is NEVER read
 * here. After the model responds, we append one line to episodic for
 * offline reflection.
 */

import { buildWorkingValues, fenceUntrusted } from '../lib/workingvalues.mjs';

// Kept deliberately short. This prompt is prefilled on every chat turn, and on
// a low-spec VPS (no AVX2) each token of prefill costs real wall-clock time, so
// a bloated system prompt makes even a one-word "gm" time out. Concise persona
// only \u2014 no full character dump, no memory blobs. See composeSystemPrompt.
const SKILL_INSTRUCTIONS = `You are Continuum, the assistant inside the Torii Continuum app \u2014 an app builder, project engine and bot-work marketplace on nostr + bitcoin + FOSS. You help the operator manage their projects, sessions, todos and marketplace tasks.

Be concise, honest, no filler. Never invent capabilities the app doesn't have. From a chat turn you never sign, publish, or write files \u2014 every publish needs an explicit human click on a signed draft.`;

const LOCKED_NOTICE =
  'Character memory is LOCKED: do not claim durable preferences/beliefs (say you\'d need memory unlocked) and do not draft memory events. You can still help with app navigation and general questions.';

// Hard cap on any single injected memory fragment, in characters. ~4 chars/token,
// so 600 chars \u2248 150 tokens. Keeps a "gm" turn well under the 500-token target
// even with character + semantic + procedural all present.
const MAX_FRAGMENT_CHARS = 600;

/** Rough token estimate (\u22484 chars/token) for logging prompt size. */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/** Truncate an injected fragment so it can't blow up the prefill budget. */
function cap(text, max = MAX_FRAGMENT_CHARS) {
  if (!text) return text;
  return text.length <= max ? text : text.slice(0, max).trimEnd() + '\u2026';
}

/**
 * @param {object} router  Model router (createModelRouter). Routes to Routstr or Ollama
 *                          based on strategy and payment/availability. Same .chat() shape as routstr.
 * @param {object} log
 * @param {object} deps
 * @param {import('../lib/memory.mjs').createMemoryLoader extends (...a:any) => infer R ? R : never} deps.memory
 * @param {import('../lib/reflect.mjs').createReflector extends (...a:any) => infer R ? R : never} deps.reflector
 */
export function createChatSkill(router, log, { memory, reflector } = {}) {
  async function handle({ message, context }) {
    // Code-side guards (procedural, kind 30095 with guard === "code-only")
    // run BEFORE we spend a satoshi on the model.
    if (memory) {
      const guard = memory.applyProceduralGuards(message);
      if (!guard.ok) {
        log.warn(`[chat] procedural guard blocked: ${guard.reason}`);
        return { ok: false, reason: `guard: ${guard.reason}` };
      }
    }

    // Compose the system prompt from the layer stack.
    const systemPrompt = composeSystemPrompt({ memory, context });

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ];

    // Prefill cost is the bottleneck on low-spec (no-AVX2) hardware, so log the
    // prompt size on every turn to catch regressions on the live VPS.
    const promptTokens = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    // Record which working-values covenant constrained this turn (version +
    // digest + rendered-header hash) so prompt provenance is auditable without
    // logging the prompt body. The constitution is public, versioned data.
    const { provenance } = buildWorkingValues();
    log.info(`[chat] prompt tokens: ${promptTokens} · working-values ${provenance.constitution_version}/${provenance.code_of_practice_version} hdr=${provenance.header_sha256.slice(0, 12)}`);

    const started = Date.now();
    // Router decides between Routstr (paid, sovereign) and Ollama (local, free).
    // Same return shape as routstr.chat — plus a `provider` field on success.
    const result = await router.chat({ skill: 'chat', messages });
    const duration = Date.now() - started;

    if (!result.ok) {
      log.warn(`[chat] model call failed (${result.code || 'no code'}): ${result.reason}`);
      // Preserve the structured code so the HTTP layer can emit a machine-
      // readable, already-sanitised error instead of raw provider prose.
      return { ok: false, reason: result.reason, code: result.code || null, provider: result.provider || null };
    }

    // Append to episodic AFTER a successful turn. Reflect never reads
    // during a live turn \u2014 only offline via /api/reflect.
    if (reflector) {
      try {
        await reflector.appendEpisodic({
          user_message: message,
          assistant_reply: result.content,
          model: result.model,
          context,
        });
      } catch (e) {
        // Don't fail the reply on episodic-write errors \u2014 we already paid the model.
        log.warn(`[chat] episodic append failed: ${e.message}`);
      }
    }

    return {
      ok: true,
      reply: result.content,
      model: result.model,
      provider: result.provider,
      duration_ms: duration,
      sats_spent: result.sats_spent || 0,
      // Set when the paid provider failed and the free local model answered, so
      // the dock can label the reply honestly rather than implying Routstr ran.
      fell_back_from: result.fell_back_from || null,
    };
  }

  return { handle };
}

/**
 * Build the four-layer system prompt. Exported for tests.
 */
export function composeSystemPrompt({ memory, context }) {
  const ctxLine = context?.label
    ? `The operator is currently on the "${context.label}" page (${context.where || 'unknown'}).`
    : '';

  // Layer 0: the working-values header (Genesis constitution + Code of Practice)
  // is injected ABOVE character and any retrieved memory. It is the live
  // covenant that outranks everything below it, so a poisoned memory fragment
  // can never silently override it. Deterministic + versioned; provenance is
  // logged by handle() for prompt diagnostics without exposing anything secret.
  const { header: workingValues } = buildWorkingValues();
  const parts = [workingValues, SKILL_INSTRUCTIONS];

  if (memory) {
    const status = memory.status();
    const fragments = memory.promptFragments();

    // The full CHARACTER.md is ~4.4k tokens \u2014 far too large to prefill on every
    // chat turn on a low-spec VPS. Inject only a capped slice (identity/stance
    // header), and likewise cap semantic/procedural fragments. Keeps the prompt
    // small while the model still knows who it is. Full character reasoning
    // stays available to offline/reflect paths that don't share this budget.
    if (!status.character_loaded) {
      parts.push('CHARACTER.md is missing from disk. Operating with skill instructions only.');
    } else if (!status.cache.unlocked) {
      parts.push(LOCKED_NOTICE);
      parts.push('## Character\n\n' + cap(fragments.character));
    } else {
      if (!status.character_root_verified) {
        parts.push(
          `Warning: CHARACTER.md does NOT match the signed character_root (30092): ${status.character_root_reason}. Refuse identity-dependent requests until resolved.`,
        );
      }
      parts.push('## Character\n\n' + cap(fragments.character));
      if (fragments.procedural) parts.push(cap(fragments.procedural));
      // Semantic facts are RETRIEVED MEMORY: treat as untrusted data, never as
      // instructions. Fenced with an explicit boundary so a poisoned fact can't
      // smuggle directives past the covenant/character above it.
      if (fragments.semantic) parts.push(fenceUntrusted('Durable facts', cap(fragments.semantic)));
    }
  }

  if (ctxLine) parts.push(ctxLine);

  return parts.join('\n\n');
}
