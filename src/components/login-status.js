/**
 * The login status line, with recovery affordances (CONT-LOGIN-1).
 *
 * ONE renderer, used by both surfaces that can start a login (the public login
 * card and the sidebar control). They previously had separate implementations,
 * and the sidebar's rendered plain text only — so the same failure gave the
 * operator install links on one surface and a dead sentence on the other. A
 * duplicated renderer that drifts is exactly the class of bug the last release
 * was spent on, so the two now share this.
 *
 * The contract: a status object may name a `recovery`, and this turns each one
 * into something the operator can actually press. Nothing here decides WHAT the
 * recovery should be — that lives in the pure model (src/login-stages.js) — so
 * a new failure mode cannot reach the screen without one.
 */
import { h, clear } from '../views/util.js';

const INSTALL_LINKS = [
  ['Chrome', 'https://chromewebstore.google.com/detail/plebeian-signer-nostr-ide/ijbiankmnehjephbkfdgphckcdgbgoho'],
  ['Firefox', 'https://addons.mozilla.org/en-US/firefox/addon/plebeian-signer/'],
];

/**
 * @param {HTMLElement|null} el status container
 * @param {object|null} s status from startLogin's onStatus sink
 * @param {{baseClass?: string, onRetry?: () => void, onCancel?: () => void}} [opts]
 */
export function renderLoginStatus(el, s, opts = {}) {
  if (!el) return;
  const base = opts.baseClass || 'login-inline-status';
  clear(el);

  if (!s || !s.message) { el.className = base; return; }

  el.className = `${base}${s.error ? ' error' : ''}${s.done ? ' done' : ''}${s.slow ? ' slow' : ''}`;
  el.appendChild(h('span', { class: 'login-inline-msg', text: s.message }));

  // Which stage of three, shown only while an attempt is actually running. It
  // costs one span and turns "something is happening, maybe" into a position in
  // a sequence that visibly advances.
  if (s.step && !s.error && !s.done) {
    el.appendChild(h('span', { class: 'login-inline-step', text: s.step }));
  }

  const actions = [];

  // Cancel is offered for the one stage that waits on a human. This is the way
  // out of a signer popup that never appeared or was dismissed by reflex —
  // previously a 60-to-90-second wait with nothing to press.
  if (s.cancellable && typeof opts.onCancel === 'function') {
    actions.push(h('button', {
      type: 'button',
      class: 'login-inline-btn',
      'data-login-cancel': '',
      onClick: (e) => { e.stopPropagation(); opts.onCancel(); },
    }, ['Cancel']));
  }

  if (s.retryable && typeof opts.onRetry === 'function') {
    actions.push(h('button', {
      type: 'button',
      class: 'login-inline-btn primary',
      'data-login-retry': '',
      onClick: (e) => { e.stopPropagation(); opts.onRetry(); },
    }, ['Try again']));
  }

  if (actions.length) {
    el.appendChild(h('div', { class: 'login-inline-actions' }, actions));
  }

  // A missing extension is the one failure a button cannot fix.
  if (s.signerMissing || s.recovery === 'install-signer') {
    el.appendChild(h('div', { class: 'login-inline-links' },
      INSTALL_LINKS.flatMap(([label, href], i) => [
        i ? h('span', { class: 'login-links-sep', 'aria-hidden': 'true' }, [' · ']) : null,
        h('a', { href, target: '_blank', rel: 'noopener' }, [label]),
      ]).filter(Boolean),
    ));
  }
}
