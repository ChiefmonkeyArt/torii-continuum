/**
 * The Nostr login flow as an explicit, bounded sequence of stages (CONT-LOGIN-1).
 *
 * Login used to be a single opaque await chain. Only the signer step carried a
 * deadline (90s) and the two network steps inherited the generic 30s client
 * budget, so "stalled" was indistinguishable from "working": one static status
 * line, no elapsed feedback, no way out, and a second click that returned
 * silently because a module-level in-flight boolean swallowed it.
 *
 * This module is pure — no DOM, no network, no timers. It owns three things:
 *   • WHAT the stages are and how long each may take,
 *   • what the operator should be TOLD at each stage,
 *   • what they can DO about each way a stage can fail.
 *
 * Keeping the recovery decision here (rather than inline at the failure site)
 * is deliberate: every failure path is then forced to name a recovery, so a new
 * failure mode cannot ship as a dead-end message with no way forward.
 */
import { classify, STATES } from './session-state.js';

/**
 * Per-stage deadlines.
 *
 * These are NOT one budget divided up — each bounds a different kind of wait,
 * so each is chosen against a different question:
 *
 *   challenge — a machine answering a machine. A healthy agent replies in
 *     milliseconds, so 12s is already pathological; the old 30s default came
 *     from the chat budget (a model generating tokens) and is far too patient
 *     for a click the operator is waiting on.
 *   signer    — a HUMAN reading a popup and pressing approve. This is the one
 *     stage where a long wait is legitimate, so it gets by far the largest
 *     share. It is cut from 90s to 60s because beyond a minute the honest
 *     conclusion is that the popup never appeared or was dismissed, and the
 *     operator is better served by a clear failure they can retry.
 *   verify    — a machine answering a machine, plus one HMAC. Same reasoning
 *     as challenge.
 */
export const STAGE_TIMEOUTS_MS = Object.freeze({
  challenge: 12_000,
  signer: 60_000,
  verify: 12_000,
});

/** Stage order. Exported so the UI can show progress as "step 2 of 3". */
export const STAGE_ORDER = Object.freeze(['challenge', 'signer', 'verify']);

/**
 * Absolute ceiling on ONE login attempt, with a small margin over the sum of
 * the stages. This is the guarantee that matters: whatever happens inside —
 * a stage that never settles, a signer that resolves after its own deadline, a
 * promise nobody ever rejects — the attempt is over by now and the in-flight
 * latch is released. Without a ceiling the latch is only as reliable as the
 * least reliable thing it awaits, which is a browser extension.
 */
export const LOGIN_DEADLINE_MS =
  STAGE_TIMEOUTS_MS.challenge + STAGE_TIMEOUTS_MS.signer + STAGE_TIMEOUTS_MS.verify + 5_000;

/**
 * How long the signer may take before the UI stops saying "waiting" and starts
 * saying "this is taking longer than expected". Purely a copy change — the
 * stage keeps running — but it is the difference between a screen that looks
 * hung and a screen that is visibly still trying.
 */
export const SIGNER_SLOW_HINT_MS = 12_000;

/** The deadline for a stage, or null when the stage is unknown. */
export function stageTimeout(stage) {
  return Object.prototype.hasOwnProperty.call(STAGE_TIMEOUTS_MS, stage)
    ? STAGE_TIMEOUTS_MS[stage]
    : null;
}

/** Human label for progress display, e.g. "Signing (step 2 of 3)". */
export function stageLabel(stage) {
  const i = STAGE_ORDER.indexOf(stage);
  return i === -1 ? '' : `step ${i + 1} of ${STAGE_ORDER.length}`;
}

/** What the operator is told while a stage is running. */
export function stageMessage(stage, { slow = false } = {}) {
  switch (stage) {
    case 'challenge':
      return 'Requesting a challenge from your agent…';
    case 'signer':
      return slow
        ? 'Still waiting for your signer. Check for a signer popup — it may be behind this window.'
        : 'Waiting for your signer to approve the login…';
    case 'verify':
      return 'Verifying your signature…';
    default:
      return '';
  }
}

/**
 * Every way a stage can fail, mapped to what the operator is told and what they
 * can do next.
 *
 * `recovery` is a machine-readable hint the UI turns into an affordance:
 *   'retry'          → offer a Retry button (the attempt can simply be redone)
 *   'install-signer' → offer the extension install links
 *   'check-agent'    → retry, but say the agent is the thing to look at
 *   'switch-signer'  → the signer or the key it holds is the problem, and
 *                      retrying with it unchanged cannot succeed
 *   'none'           → nothing to offer (a deliberate cancel)
 *
 * Note that almost everything here is retryable. That is the point: a stalled
 * login is nearly always a transient condition — a dismissed popup, a sleeping
 * VPS, a flaky link — and the previous UI treated all of them as terminal.
 *
 * @param {string} stage
 * @param {string} kind  one of: timeout, offline, rejected, empty, unsigned,
 *                       cancelled, no_signer, no_agent, agent_rejected,
 *                       signer_incompatible, signer_changed_challenge,
 *                       not_owner, challenge_expired, no_session,
 *                       session_not_stored, session_expired
 * @param {{detail?: string}} [opts]
 * @returns {{message: string, recovery: string, retryable: boolean, error: boolean, stage: string, kind: string}}
 */
export function describeStageFailure(stage, kind, opts = {}) {
  const detail = opts.detail ? String(opts.detail) : '';
  const out = (message, recovery) => ({
    stage,
    kind,
    message,
    recovery,
    retryable: recovery === 'retry' || recovery === 'check-agent',
    error: kind !== 'cancelled',
  });

  switch (kind) {
    case 'cancelled':
      return out('Sign-in cancelled.', 'none');
    case 'no_agent':
      return out('Sign-in needs a self-hosted agent. See agent/README.md to bring up your Torii.', 'none');
    case 'no_signer':
      return out(
        'No NIP-07 signer found. Install one of the signers below, then try again.',
        'install-signer',
      );
    case 'timeout':
      if (stage === 'signer') {
        return out(
          'Your signer did not answer in time. Open your signer, approve the request, then try again.',
          'retry',
        );
      }
      return out(
        `Your agent did not answer in time (${stage}). It may be starting up or under load.`,
        'check-agent',
      );
    case 'offline':
      return out(
        `Could not reach your agent (${stage})${detail ? `: ${detail}` : ''}.`,
        'check-agent',
      );
    case 'rejected':
      return out(
        `Your signer declined the request${detail ? `: ${detail}` : ''}.`,
        'retry',
      );
    case 'empty':
      return out('Your signer returned no signature.', 'retry');
    case 'unsigned':
      return out('Your signer returned an unsigned event.', 'retry');
    // The next four are CONT-SIGNER-1. Each one used to surface as
    // `agent_rejected` with a plain Retry, which named the wrong component and,
    // for not_owner, offered a loop that could never terminate.
    case 'signer_changed_challenge':
      return out(
        'Your signer altered the login request, so it cannot be verified. Try a different NIP-07 signer.',
        'switch-signer',
      );
    case 'signer_incompatible':
      return out(
        `Your signer produced an event your agent could not verify${detail ? `: ${detail}` : ''}. Try a different NIP-07 signer.`,
        'switch-signer',
      );
    case 'not_owner':
      return out(
        'That key is not this Torii\u2019s owner. Switch your signer to the owner key, then try again.',
        'switch-signer',
      );
    case 'challenge_expired':
      return out('The login request expired before it was signed. Try again.', 'retry');
    // The next three are CONT-COMPLETE-1: the agent said yes, but no session
    // resulted. Each names a DIFFERENT component as the thing to fix, which is
    // the whole reason they are not one kind: sending an operator to check their
    // agent when the actual fault is their browser's storage, or their clock, is
    // a diagnosis that costs hours.
    case 'no_session':
      return out(
        'Your agent accepted the signature but returned no session. If it sits behind a proxy, check that the proxy is not stripping the response body.',
        'check-agent',
      );
    case 'session_not_stored':
      return out(
        'Your session could not be saved in this browser. Private browsing and blocked site data both prevent it — allow site data for this page, then try again.',
        'retry',
      );
    case 'session_expired':
      return out(
        'Your agent issued a session that had already expired, so its clock and this device’s disagree. Fix the clock on whichever is wrong, then try again.',
        'check-agent',
      );
    case 'agent_rejected':
      return out(
        `Your agent rejected the signature${detail ? `: ${detail}` : ''}.`,
        'retry',
      );
    default:
      return out(`Sign-in failed${detail ? `: ${detail}` : ''}.`, 'retry');
  }
}

/**
 * Why a 200 from /api/auth/verify did not produce a usable session — or null
 * when it did (CONT-COMPLETE-1).
 *
 * A 200 is the agent's opinion, not a session. Treating the two as the same
 * thing is what let sign-in "succeed" into a state the rest of the app then
 * refused to recognise: the operator was routed straight back to the login card
 * with an empty status line and no statement of what went wrong, while the agent
 * log showed auth.verify.success. Every branch here is a way that can happen,
 * and naming them separately is what makes each one actionable.
 *
 * The expiry rule is NOT re-derived here — it is `classify` from the session
 * state machine, the same function the router's guard and the renewal clock
 * consume. A second opinion about what "live" means is precisely the class of
 * divergence that produced this bug.
 *
 * @param {{replyHadToken: boolean, storedToken: unknown, expiresAt: number|null, nowSec: number}} o
 * @returns {'no_session'|'session_not_stored'|'session_expired'|null}
 */
export function describeCompletionFailure({ replyHadToken, storedToken, expiresAt, nowSec }) {
  // The agent sent a token and we could not keep it: the fault is this browser's
  // storage, not the agent, and saying "check your agent" would be a wrong turn.
  if (!storedToken) return replyHadToken ? 'session_not_stored' : 'no_session';
  const state = classify(expiresAt, nowSec);
  if (state === STATES.EXPIRED) return 'session_expired';
  // No readable expiry at all: the token cannot be reasoned about, so there is
  // no session even though a string was stored.
  if (state === STATES.ANONYMOUS) return 'no_session';
  return null;
}

/**
 * What a click on an already-running login should say.
 *
 * The old code did `if (loginInFlight) return;` — a silent no-op. To the
 * operator that is a dead button, which is the single most common way a
 * "stalled" login is actually experienced: something IS happening, but the UI
 * says nothing at all when you ask it again. Now the click is always answered,
 * and during the human-scale stage it is answered with a way out.
 */
export function busyStatus(stage) {
  const cancellable = stage === 'signer';
  return {
    phase: 'busy',
    stage,
    message: cancellable
      ? 'Still waiting for your signer. Cancel to start over.'
      : 'Sign-in is already in progress…',
    cancellable,
    recovery: cancellable ? 'cancel' : 'none',
  };
}
