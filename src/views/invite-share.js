/**
 * One invite link, ready to hand over: Copy, and a QR code to scan with a
 * phone (torii-teams ADR 0012 §1). The QR is drawn in the browser by the
 * bundled encoder (qr.js); the link never leaves the page.
 */
import { h } from './util.js';
import { renderQR } from './qr.js';

/** A canvas QR for `url`, or a short note when this browser cannot draw it. */
export function inviteQr(url, size = 200) {
  try {
    const canvas = renderQR(url, { size, ecl: 'M' });
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'QR code for the invite link');
    canvas.className = 'invite-qr';
    canvas.style.cssText = `width:${size}px;max-width:100%;height:auto;border-radius:6px;display:block;`;
    return canvas;
  } catch {
    return h('div', { class: 'muted invite-qr', style: 'font-size:12px;', text: 'Could not draw a QR code here. Copy the link instead.' });
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/**
 * A row for one link: Copy link, Show QR (toggles), and the raw link for
 * copying by hand. `onCopied(ok)` reports the copy.
 * @param {{url:string, label?:string, onCopied?:(ok:boolean)=>void, qrOpen?:boolean}} o
 */
export function inviteShare({ url, label = 'Invite link', onCopied, qrOpen = false }) {
  const field = h('input', { type: 'text', readonly: 'readonly', value: url, 'aria-label': label, style: 'flex:1 1 220px;min-width:0;font-family:var(--font-mono, monospace);font-size:12px;' });
  field.addEventListener('focus', () => field.select());
  const qrBox = h('div', { class: 'invite-qr-box', style: 'margin-top:8px;' });
  const qrBtn = h('button', { class: 'ghost', type: 'button', 'aria-expanded': 'false' }, ['Show QR']);
  const setQr = (open) => {
    qrBox.replaceChildren(...(open ? [inviteQr(url), h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px;', text: 'Scan with a phone camera to open the link.' })] : []));
    qrBtn.textContent = open ? 'Hide QR' : 'Show QR';
    qrBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  qrBtn.addEventListener('click', () => setQr(qrBtn.getAttribute('aria-expanded') !== 'true'));
  const copyBtn = h('button', { class: 'ghost', type: 'button', onClick: async () => onCopied?.(await copyText(url)) }, ['Copy link']);
  setQr(qrOpen);
  return h('div', { class: 'invite-share' }, [
    h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;' }, [field, copyBtn, qrBtn]),
    qrBox,
  ]);
}
