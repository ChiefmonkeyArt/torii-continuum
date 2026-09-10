/**
 * Minimal Nostr relay publish — the ONLY write path in the browser.
 *
 * The Continuum node deliberately never publishes (it holds no key and has no
 * relay write socket). When the operator approves a draft and signs it with
 * their NIP-07 signer, this module opens a WebSocket to the relay, sends the
 * signed event as `["EVENT", <event>]`, and resolves on the relay's `["OK", id,
 * true, ""]` acknowledgement (or rejects on refusals / timeouts).
 *
 * Browser-only: `WebSocket` is a global in the page, not available in the node
 * build, which is fine — this file is only imported from the noticeboard view.
 */

/**
 * Publish a signed event to one relay and resolve/reject on the relay's OK.
 * @param {string} relay       wss:// relay URL (from the draft response)
 * @param {object} signedEvent fully-signed event incl. `id`, `sig`
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:true, eventId:string}>}
 */
export function publishEvent(relay, signedEvent, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(relay);
    } catch (_e) {
      reject({ ok: false, reason: 'browser could not open the relay connection' });
      return;
    }

    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_e) { /* already closing */ }
      if (val.ok) resolve(val);
      else reject(val);
    };

    const timer = setTimeout(
      () => finish({ ok: false, reason: `no acknowledgement from the relay within ${Math.round(timeoutMs / 1000)}s` }),
      timeoutMs,
    );

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify(['EVENT', signedEvent]));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_e) { return; }
      if (!Array.isArray(msg) || msg[0] !== 'OK') return;
      // Only react to OUR event's acknowledgement; other relays may interleave.
      if (msg[1] !== signedEvent.id) return;
      if (msg[2] === true) finish({ ok: true, eventId: signedEvent.id });
      else finish({ ok: false, reason: msg[3] || 'the relay refused the event' });
    });
    ws.addEventListener('error', () => finish({ ok: false, reason: 'could not connect to the relay' }));
    ws.addEventListener('close', () => {
      if (!settled) finish({ ok: false, reason: 'the relay closed before acknowledging the event' });
    });
  });
}