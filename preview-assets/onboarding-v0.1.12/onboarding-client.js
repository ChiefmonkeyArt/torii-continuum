/* =========================================================
   onboarding-client.js — step 1 live auth client (preview)

   Self-contained, no build step, no third-party CDN. Wires the
   onboarding step-1 "prove you're the operator" panel to the live
   same-origin agent API:

     POST /api/auth/challenge  -> { challenge, expires_in, kind: 22242 }
     POST /api/auth/verify {event} -> { token, expires_at }

   Primary signer path is NIP-07 via window.nostr (Plebeian Signer).
   Secondary path is NIP-46 with the *browser* acting as the NIP-46
   client (architecture per github.com/dsbaars/bunker46): the browser
   holds an ephemeral client key, talks to the operator's remote signer
   (bunker) over a relay, and asks it to sign the same 22242 auth event.
   There is deliberately NO server bunker-connect endpoint — the browser
   never hands any key or connection secret to the agent; only the final
   signed event reaches /api/auth/verify.

   Session, on success, is written to exactly:
     localStorage['torii.session']
   as JSON. Shape (no secrets — only what the app needs to make
   authenticated calls and show identity):
     {
       token:      string,  // HMAC session token from the agent
       expires_at: number,  // unix seconds; token TTL
       pubkey:     string,  // hex pubkey of the operator that signed
       method:     'nip07' | 'nip46',
       created_at: number   // unix seconds; when we stored it
     }

   The module exports pure, dependency-injected helpers so the whole
   flow is unit-testable offline (mock fetch / signer / storage / relay).
   When loaded in a browser it also self-wires the step-1 panel.
   ========================================================= */

export const AUTH_KIND = 22242;
export const SESSION_KEY = 'torii.session';

// Requested animation clips per phase. The live GLB may not ship every
// clip, so each phase carries an ordered fallback list of clips that DO
// exist in chiefmonkey6.glb; selectAnimation() walks it and returns null
// (== keep the current animation) when nothing matches. This is the
// "graceful fallback if a clip is unavailable" contract.
export const ANIM = {
  prompting: { clip: 'HandGesture_00', fallbacks: ['idle_to_push_up', 'Idle_03'] },
  success: { clip: 'Idle_03', fallbacks: [] },
  failure: { clip: 'Confused_02', fallbacks: ['Hit_Reaction_to_Waist', 'Knock_Down'] },
};

/**
 * Pick the animation clip to play for a phase given the clips actually
 * present in the loaded model. Returns the primary clip if available,
 * else the first available fallback, else null (caller keeps current).
 * @param {'prompting'|'success'|'failure'} phase
 * @param {Iterable<string>|null|undefined} available clip names present in the GLB
 */
export function selectAnimation(phase, available) {
  const spec = ANIM[phase];
  if (!spec) return null;
  // No knowledge of what's available → optimistically request the primary
  // clip; character.js still no-ops if it's genuinely missing.
  if (!available) return spec.clip;
  const set = available instanceof Set ? available : new Set(available);
  for (const name of [spec.clip, ...spec.fallbacks]) {
    if (set.has(name)) return name;
  }
  return null;
}

/**
 * Build the unsigned NIP-07/NIP-42-shaped auth event the agent expects.
 * Mirrors agent/core/auth.mjs exactly: kind 22242, content == challenge,
 * a 'challenge' tag and a 'relay' tag carrying this origin.
 */
export function buildAuthEvent(challenge, origin, now = () => Math.floor(Date.now() / 1000)) {
  return {
    kind: AUTH_KIND,
    created_at: now(),
    content: challenge,
    tags: [
      ['challenge', challenge],
      ['relay', origin],
    ],
  };
}

/**
 * Validate the /api/auth/challenge response. Fail closed: anything not
 * matching the exact contract (non-object, missing/empty challenge,
 * non-numeric or already-elapsed expiry, wrong kind) throws.
 * @returns {{ challenge: string, expires_in: number }}
 */
export function validateChallengeResponse(resp) {
  if (!resp || typeof resp !== 'object') throw new Error('malformed challenge response');
  const { challenge, expires_in, kind } = resp;
  if (typeof challenge !== 'string' || challenge.length < 8) {
    throw new Error('malformed challenge');
  }
  if (typeof expires_in !== 'number' || !Number.isFinite(expires_in) || expires_in <= 0) {
    throw new Error('malformed challenge expiry');
  }
  // The agent tags challenges as kind 22242. If present it must match; a
  // missing kind is tolerated (older agents) but a wrong one is rejected.
  if (kind !== undefined && kind !== AUTH_KIND) {
    throw new Error('unexpected challenge kind');
  }
  return { challenge, expires_in };
}

/**
 * Validate the /api/auth/verify success body. Fail closed: the token must
 * be a non-empty string and expires_at, if present, a future-ish number.
 * @returns {{ token: string, expires_at: number|null }}
 */
export function validateVerifyResponse(resp) {
  if (!resp || typeof resp !== 'object') throw new Error('malformed verify response');
  const { token, expires_at } = resp;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('missing session token');
  }
  let exp = null;
  if (expires_at !== undefined && expires_at !== null) {
    if (typeof expires_at !== 'number' || !Number.isFinite(expires_at)) {
      throw new Error('malformed token expiry');
    }
    exp = expires_at;
  }
  return { token, expires_at: exp };
}

/**
 * Validate a browser-side signed auth event before it is trusted or sent.
 * Fail closed on shape, kind, missing sig/pubkey, or a challenge tag that
 * does not match the challenge we issued (pubkey-mismatch and expired
 * challenges are additionally enforced server-side, but we refuse early).
 */
export function validateSignedEvent(event, expectedChallenge) {
  if (!event || typeof event !== 'object') throw new Error('signer returned no event');
  if (event.kind !== AUTH_KIND) throw new Error('signer returned wrong kind');
  if (typeof event.pubkey !== 'string' || event.pubkey.length !== 64) {
    throw new Error('signer returned no pubkey');
  }
  if (typeof event.sig !== 'string' || event.sig.length !== 128) {
    throw new Error('signer returned no signature');
  }
  const tag = Array.isArray(event.tags)
    ? event.tags.find((t) => Array.isArray(t) && t[0] === 'challenge')
    : null;
  if (!tag || tag[1] !== expectedChallenge) {
    throw new Error('signed challenge mismatch');
  }
  if (event.content !== undefined && event.content !== expectedChallenge) {
    throw new Error('signed content mismatch');
  }
  return event;
}

/**
 * Build the localStorage['torii.session'] value. Only carries the returned
 * session token + public identity metadata the app needs — never any nsec,
 * bunker secret, or relay credential.
 */
export function buildSessionValue({ token, expires_at, pubkey, method }, now = () => Math.floor(Date.now() / 1000)) {
  return {
    token,
    expires_at: expires_at ?? null,
    pubkey,
    method,
    created_at: now(),
  };
}

/**
 * Persist a session to exactly localStorage['torii.session'].
 * storage defaults to window.localStorage.
 */
export function storeSession(session, storage) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) throw new Error('no storage available');
  store.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function readSession(storage) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return null;
  const raw = store.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function postJson(fetchImpl, path, body) {
  const res = await fetchImpl(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Full NIP-07 login. Dependency-injected for offline testing.
 * @param {object} deps
 *   fetch    - same-origin fetch (default window.fetch bound)
 *   signer   - object with async signEvent(template) (default window.nostr)
 *   storage  - localStorage-like (default window.localStorage)
 *   origin   - relay tag origin (default location.origin)
 *   now      - () => unix seconds
 *   onPhase  - optional (phase) => void hook for animation/status
 * @returns {Promise<{ok:true, session}|{ok:false, reason:string}>}
 */
export async function loginWithNip07(deps = {}) {
  const fetchImpl = deps.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const signer = deps.signer || (typeof window !== 'undefined' ? window.nostr : null);
  const origin = deps.origin || (typeof location !== 'undefined' ? location.origin : '');
  const now = deps.now || (() => Math.floor(Date.now() / 1000));
  const onPhase = deps.onPhase || (() => {});

  if (!fetchImpl) return { ok: false, reason: 'no fetch available' };
  if (!signer || typeof signer.signEvent !== 'function') {
    return { ok: false, reason: 'NIP-07 signer not found (install Plebeian Signer)' };
  }

  onPhase('prompting');
  try {
    // 1. Challenge
    const chal = await postJson(fetchImpl, '/api/auth/challenge');
    if (!chal.ok) return fail(onPhase, `agent challenge failed (${chal.status})`);
    const { challenge } = validateChallengeResponse(chal.json);

    // 2. Sign in the browser — nsec never leaves the extension.
    const template = buildAuthEvent(challenge, origin, now);
    let signed;
    try {
      signed = await signer.signEvent(template);
    } catch (e) {
      return fail(onPhase, `signer refused: ${e?.message || e}`);
    }
    validateSignedEvent(signed, challenge);

    // 3. Verify with the agent.
    const ver = await postJson(fetchImpl, '/api/auth/verify', { event: signed });
    if (!ver.ok) return fail(onPhase, ver.json?.error || `verify rejected (${ver.status})`);
    const { token, expires_at } = validateVerifyResponse(ver.json);

    // 4. Store session (torii.session).
    const session = buildSessionValue(
      { token, expires_at, pubkey: signed.pubkey, method: 'nip07' },
      now,
    );
    storeSession(session, deps.storage);
    onPhase('success');
    return { ok: true, session };
  } catch (e) {
    return fail(onPhase, e?.message || String(e));
  }
}

function fail(onPhase, reason) {
  onPhase('failure');
  return { ok: false, reason };
}

// ─── NIP-46 (browser is the client; bunker46 architecture) ──────────
//
// A bunker connection string looks like:
//   bunker://<remote-signer-pubkey-hex>?relay=wss://…&relay=wss://…&secret=…
// The browser mints an ephemeral client keypair, connects to the relay,
// and exchanges NIP-46 (kind 24133) requests encrypted to the remote
// signer. We ask it to `sign_event` the SAME 22242 auth event, then run
// the identical verify+store path. No server endpoint is involved and no
// key or bunker secret is ever transmitted to the agent.

/**
 * Parse a NIP-46 `bunker://` connection string. Fail closed on anything
 * that isn't a bunker URI with a 64-hex remote pubkey and >=1 relay.
 * @returns {{ remotePubkey: string, relays: string[], secret: string|null }}
 */
export function parseBunkerUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) throw new Error('empty connection string');
  const trimmed = uri.trim();
  if (!trimmed.startsWith('bunker://')) throw new Error('not a bunker:// connection string');
  let parsed;
  try {
    // Swap scheme so the URL parser yields host+search reliably.
    parsed = new URL('https://' + trimmed.slice('bunker://'.length));
  } catch {
    throw new Error('malformed connection string');
  }
  const remotePubkey = (parsed.hostname || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(remotePubkey)) throw new Error('bad remote signer pubkey');
  const relays = parsed.searchParams.getAll('relay').filter(Boolean);
  if (relays.length === 0) throw new Error('connection string has no relay');
  for (const r of relays) {
    if (!/^wss?:\/\//.test(r)) throw new Error('bad relay url');
  }
  const secret = parsed.searchParams.get('secret');
  return { remotePubkey, relays, secret: secret || null };
}

/**
 * Full NIP-46 login. The browser is the NIP-46 *client*. Transport and
 * crypto are injected so this is testable offline and so we never hard-bind
 * a heavy dependency into a static, build-free preview.
 *
 * @param {object} deps
 *   bunkerUri - the bunker:// connection string from the operator
 *   fetch     - same-origin fetch
 *   transport - { request(remotePubkey, method, params) => Promise<result> }
 *               A thin NIP-46 client: encrypts a kind-24133 request to the
 *               remote signer, publishes to the bunker's relays, and resolves
 *               with the decrypted result. `sign_event` returns the signed
 *               event (object or JSON string).
 *   storage   - localStorage-like
 *   origin    - relay tag origin for the auth event
 *   now, onPhase
 * @returns {Promise<{ok:true, session}|{ok:false, reason:string}>}
 */
export async function loginWithNip46(deps = {}) {
  const fetchImpl = deps.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const origin = deps.origin || (typeof location !== 'undefined' ? location.origin : '');
  const now = deps.now || (() => Math.floor(Date.now() / 1000));
  const onPhase = deps.onPhase || (() => {});
  const transport = deps.transport;

  if (!fetchImpl) return { ok: false, reason: 'no fetch available' };
  if (!transport || typeof transport.request !== 'function') {
    // Privacy-first + explicit: we do NOT silently fall back to NIP-07 or to
    // any server-side bunker. Without a client transport the remote-signer
    // path simply cannot proceed, and we say so.
    return { ok: false, reason: 'NIP-46 remote signing unavailable in this browser' };
  }

  let conn;
  try {
    conn = parseBunkerUri(deps.bunkerUri);
  } catch (e) {
    return fail(onPhase, e?.message || 'bad connection string');
  }

  onPhase('prompting');
  try {
    // Establish the client<->signer session (NIP-46 connect handshake).
    await transport.request(conn.remotePubkey, 'connect', conn.secret ? [conn.remotePubkey, conn.secret] : [conn.remotePubkey]);

    // 1. Challenge from the agent.
    const chal = await postJson(fetchImpl, '/api/auth/challenge');
    if (!chal.ok) return fail(onPhase, `agent challenge failed (${chal.status})`);
    const { challenge } = validateChallengeResponse(chal.json);

    // 2. Ask the remote signer to sign the auth event.
    const template = buildAuthEvent(challenge, origin, now);
    let signed = await transport.request(conn.remotePubkey, 'sign_event', [JSON.stringify(template)]);
    if (typeof signed === 'string') {
      try {
        signed = JSON.parse(signed);
      } catch {
        return fail(onPhase, 'remote signer returned malformed event');
      }
    }
    validateSignedEvent(signed, challenge);

    // 3. Verify + 4. store — identical to the NIP-07 path.
    const ver = await postJson(fetchImpl, '/api/auth/verify', { event: signed });
    if (!ver.ok) return fail(onPhase, ver.json?.error || `verify rejected (${ver.status})`);
    const { token, expires_at } = validateVerifyResponse(ver.json);

    const session = buildSessionValue(
      { token, expires_at, pubkey: signed.pubkey, method: 'nip46' },
      now,
    );
    storeSession(session, deps.storage);
    onPhase('success');
    return { ok: true, session };
  } catch (e) {
    return fail(onPhase, e?.message || String(e));
  }
}

// ─── Browser wiring ─────────────────────────────────────────────────
// Only runs in a real DOM. Tests import the functions above and never
// trigger this block.
export function initStep1(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return;
  const panel = doc.querySelector('.panel[data-panel="1"]');
  if (!panel) return;

  const signBtn = panel.querySelector('[data-sign-primary]');
  const altBtn = panel.querySelector('[data-sign-alt]');
  const nip46Row = panel.querySelector('[data-nip46]');
  const nip46Input = panel.querySelector('[data-bunker-input]');
  const nip46Go = panel.querySelector('[data-bunker-go]');
  const statusEl = panel.querySelector('[data-auth-status]');

  const emitPhase = (phase) => {
    // Drive Chiefmonkey via the existing custom-event channel; character.js
    // maps phase -> clip with graceful fallback.
    window.dispatchEvent(new CustomEvent('onboarding:anim', { detail: { phase } }));
    if (statusEl) {
      const msg = {
        prompting: 'Waiting for your signer…',
        success: 'Verified. You hold the admin npub.',
        failure: statusEl.dataset.err || 'Signing failed. Try again.',
      }[phase];
      if (msg) statusEl.textContent = msg;
    }
  };

  const setErr = (reason) => {
    if (statusEl) statusEl.dataset.err = reason;
  };

  const finish = (result) => {
    if (result.ok) {
      // Advance the deck to step 2 on success.
      window.dispatchEvent(new CustomEvent('onboarding:advance', { detail: { from: 1 } }));
    } else {
      setErr(result.reason);
      emitPhase('failure');
    }
  };

  if (signBtn) {
    signBtn.addEventListener('click', async () => {
      signBtn.disabled = true;
      const result = await loginWithNip07({ onPhase: emitPhase });
      signBtn.disabled = false;
      finish(result);
    });
  }

  if (altBtn && nip46Row) {
    altBtn.addEventListener('click', () => {
      const open = nip46Row.hasAttribute('hidden');
      if (open) nip46Row.removeAttribute('hidden');
      else nip46Row.setAttribute('hidden', '');
      if (open && nip46Input) nip46Input.focus();
    });
  }

  if (nip46Go) {
    nip46Go.addEventListener('click', async () => {
      const bunkerUri = nip46Input ? nip46Input.value : '';
      nip46Go.disabled = true;
      const result = await loginWithNip46({
        bunkerUri,
        transport: window.__toriiNip46Transport || null,
        onPhase: emitPhase,
      });
      nip46Go.disabled = false;
      finish(result);
    });
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initStep1());
  } else {
    initStep1();
  }
}
