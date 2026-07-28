/**
 * Tolerating the signers that actually exist (CONT-SIGNER-1).
 *
 * NIP-07 says `signEvent(event)` returns a signed event. It does not say what
 * the returned object must contain, and in practice the ecosystem disagrees:
 *
 *   • Some extensions echo the whole event back with `id`, `sig` and `pubkey`
 *     added. This is what the login flow was written against.
 *   • Some return only `{ id, sig }` — several NIP-46 bridges and remote
 *     signers do, because the bridge signs a payload it does not consider
 *     itself the owner of and returns just the proof.
 *   • Some omit `pubkey` but echo everything else.
 *   • Some legitimately REWRITE `created_at` (clock skew correction, or a
 *     signer batching requests). NIP-07 permits this and the agent accepts it,
 *     because the signature is computed over whatever the signer chose.
 *
 * The login flow used to forward the signer's return value verbatim, so the
 * middle two shapes put a malformed event on the wire and the agent refused it
 * — reported to the operator as "your agent rejected the signature", blaming
 * the wrong component for a shape mismatch the browser could have healed.
 *
 * This module is pure: no DOM, no network, no timers of its own. It owns three
 * things — how to reconcile a signer's answer with the event we asked it to
 * sign, how long to wait for a signer that has not been injected yet, and how
 * to map the agent's verify code onto a stage failure.
 */

/**
 * The fields the agent hashes into the event id, in the order NIP-01 serialises
 * them: [0, pubkey, created_at, kind, tags, content]. Every one of them must be
 * present and must be the value the signer signed over, which is why this list
 * — and not a broader "copy everything" — is what reconciliation walks.
 */
export const HASHED_FIELDS = Object.freeze(['kind', 'created_at', 'content', 'tags', 'pubkey']);

/**
 * Reconcile what the signer returned with what we asked it to sign.
 *
 * The rule is: the SIGNER wins wherever it expressed an opinion, and we only
 * fill the gaps. That direction is not arbitrary —
 *
 *   • It is the only safe direction. The agent independently recomputes
 *     `getEventHash(event)` over `[0, pubkey, created_at, kind, tags, content]`
 *     and checks it against `event.id`, then verifies `sig` against that id.
 *     Any field we substitute that the signer did not sign over changes the
 *     hash and the event is refused. So reconciliation cannot manufacture an
 *     acceptance; it can only produce a correctly-shaped payload for a
 *     signature that was already going to stand or fall on its own.
 *   • It is what keeps a signer that rewrote `created_at` working. Preferring
 *     our own value there would break a case that currently succeeds.
 *
 * Consequently we never "repair" a field the signer set, not even one we
 * believe is wrong. A signer that dropped our challenge tag has produced an
 * event we cannot use, and re-adding the tag would only invalidate the id —
 * see `signerAlteredChallenge` for naming that honestly instead.
 *
 * `missing` names the fields still absent after reconciliation, which in
 * practice is only ever `pubkey`: it is the one field of the hashed set that
 * the browser never knew, so a signer that returns just `{ id, sig }` leaves a
 * hole nothing local can fill. The caller closes it with `getPublicKey()` —
 * NIP-07 requires that method, and it names the same key that produced `sig`.
 *
 * @param {object} built     the event we handed to the signer
 * @param {any}    returned  whatever `signEvent` resolved with
 * @returns {{ok: true, event: object, filled: string[], missing: string[]}
 *          | {ok: false, kind: 'empty'|'unsigned'}}
 */
export function reconcileSignedEvent(built, returned) {
  if (!returned || typeof returned !== 'object' || Array.isArray(returned)) {
    return { ok: false, kind: 'empty' };
  }
  // `sig` is the one thing only the signer can supply, so its absence means
  // nothing was signed — a distinct condition from a merely sparse answer.
  if (typeof returned.sig !== 'string' || !returned.sig) {
    return { ok: false, kind: 'unsigned' };
  }

  const event = { ...returned };
  const filled = [];
  const missing = [];
  for (const key of HASHED_FIELDS) {
    if (event[key] !== undefined && event[key] !== null) continue;
    if (built[key] === undefined || built[key] === null) { missing.push(key); continue; }
    event[key] = built[key];
    filled.push(key);
  }
  return { ok: true, event, filled, missing };
}


/**
 * Did the signer change the challenge this event was supposed to prove?
 *
 * Checked BEFORE the event goes on the wire. The agent would reject it anyway,
 * but it would do so as "missing challenge tag", which reads as an agent fault
 * and offers a plain retry against a signer that will do the same thing again.
 * Naming it here lets the UI say which component misbehaved.
 *
 * @param {object} event      the reconciled event
 * @param {string} challenge  the challenge the agent issued
 */
export function signerAlteredChallenge(event, challenge) {
  const tags = Array.isArray(event?.tags) ? event.tags : [];
  const tag = tags.find((t) => Array.isArray(t) && t[0] === 'challenge');
  if (!tag || tag[1] !== challenge) return true;
  // The agent also cross-checks content against the tag when content is set.
  if (event.content && event.content !== challenge) return true;
  return false;
}

/**
 * How long to keep looking for `window.nostr` before concluding there is no
 * signer.
 *
 * Extensions inject `window.nostr` from a content script, and that script is
 * not ordered against our bundle — Alby in particular can land after
 * DOMContentLoaded. Deciding "no signer" from a single synchronous read at
 * click time therefore tells an operator who HAS a signer to go install one,
 * with no retry offered because a missing signer is not a retryable condition.
 *
 * 1.5s is chosen to be longer than any injection delay observed in practice
 * and short enough that an operator who genuinely has no extension is not left
 * staring at a spinner. It is deliberately far below the challenge deadline so
 * it cannot eat that stage's budget.
 */
export const SIGNER_WAIT_MS = 1_500;

/** Poll interval while waiting for injection. Cheap: one property read. */
export const SIGNER_POLL_MS = 50;

/**
 * Wait briefly for a signer to appear.
 *
 * Resolves `true` as soon as `hasSigner()` is true — immediately, without
 * yielding, when the signer is already there, so the common case pays nothing.
 *
 * @param {{hasSigner: () => boolean, timeoutMs?: number, pollMs?: number,
 *          setTimer?: Function, clearTimer?: Function}} opts
 * @returns {Promise<boolean>}
 */
export function awaitSigner({
  hasSigner,
  timeoutMs = SIGNER_WAIT_MS,
  pollMs = SIGNER_POLL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (hasSigner()) return Promise.resolve(true);
  if (!(timeoutMs > 0)) return Promise.resolve(false);

  return new Promise((resolve) => {
    let elapsed = 0;
    let timer = null;
    const done = (found) => {
      if (timer !== null) { try { clearTimer(timer); } catch (_e) {} timer = null; }
      resolve(found);
    };
    const step = () => {
      if (hasSigner()) { done(true); return; }
      elapsed += pollMs;
      if (elapsed >= timeoutMs) { done(false); return; }
      timer = setTimer(step, pollMs);
    };
    timer = setTimer(step, pollMs);
  });
}

/**
 * The signers we can point an operator at.
 *
 * A registry rather than one hard-coded vendor. The previous copy named a
 * single extension in three places, which is wrong on two counts: an operator
 * already running a different NIP-07 signer is told their setup is unsupported,
 * and an operator with none is steered to one implementation as though it were
 * the only one. Order is a recommendation, not a requirement.
 */
export const KNOWN_SIGNERS = Object.freeze([
  Object.freeze({
    id: 'plebeian',
    name: 'Plebeian Signer',
    links: Object.freeze([
      Object.freeze(['Chrome', 'https://chromewebstore.google.com/detail/plebeian-signer-nostr-ide/ijbiankmnehjephbkfdgphckcdgbgoho']),
      Object.freeze(['Firefox', 'https://addons.mozilla.org/en-US/firefox/addon/plebeian-signer/']),
    ]),
  }),
  Object.freeze({
    id: 'nos2x',
    name: 'nos2x',
    links: Object.freeze([
      Object.freeze(['Chrome', 'https://chromewebstore.google.com/detail/nos2x/kpgefcfmnafjgpblomihpgmejjdanjjp']),
      Object.freeze(['Firefox', 'https://addons.mozilla.org/en-US/firefox/addon/nos2x-fox/']),
    ]),
  }),
  Object.freeze({
    id: 'alby',
    name: 'Alby',
    links: Object.freeze([
      Object.freeze(['Chrome', 'https://chromewebstore.google.com/detail/alby-bitcoin-wallet-for-l/iokeahhehimjnekafflcihljlcjccdbe']),
      Object.freeze(['Firefox', 'https://addons.mozilla.org/en-US/firefox/addon/alby/']),
    ]),
  }),
]);

/**
 * Map the agent's `/api/auth/verify` failure code onto a stage failure kind.
 *
 * The whole point of the code is that these refusals have opposite remedies:
 * `not_owner` can never be fixed by retrying with the same key, while
 * `challenge_expired` is fixed by starting over. Collapsing both into
 * "agent rejected, try again" is how a futile retry loop was offered for a
 * refusal that is permanent for the current identity.
 *
 * An unknown or absent code falls back to `agent_rejected`, which keeps older
 * agents behaving exactly as they do today.
 *
 * @param {string|null|undefined} code
 * @returns {string} a kind understood by describeStageFailure
 */
export function describeVerifyCode(code) {
  switch (code) {
    case 'not_owner':
      return 'not_owner';
    case 'challenge_expired':
      return 'challenge_expired';
    case 'bad_signature':
    case 'malformed_event':
    case 'wrong_kind':
      return 'signer_incompatible';
    default:
      return 'agent_rejected';
  }
}
