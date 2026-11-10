/**
 * Chat attachments (docs/adr-one-assistant-bar.md §4–6).
 *
 * The assistant bar's "+" sends up to four images or plain-text files with a
 * message. The browser already shrinks images and checks limits; this module
 * re-checks everything, because the agent never trusts the client:
 *   - images: PNG/JPEG/WebP/GIF as base64, magic bytes must match the type;
 *   - text: UTF-8, no NUL bytes, fenced as untrusted data in the prompt.
 * Nothing here is stored: callers keep only names for history and logs.
 */

export const MAX_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 700 * 1024; // the whole request stays under 1 MB
export const MAX_TEXT_BYTES = 100 * 1024;
export const MAX_TEXT_TOTAL_BYTES = 200 * 1024;
/** Prompt-token estimate per image for pre-payment pricing (ADR §7). */
export const IMAGE_TOKEN_ESTIMATE = 1600;

const IMAGE_TYPES = {
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8',
  'image/webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Display-safe file name: no paths, no control characters, bounded. */
export function safeName(raw) {
  const base = String(raw ?? '').split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f`]/g, '').trim().slice(0, 120);
  return clean || 'file';
}

/**
 * Validate the request's `attachments` array.
 * @returns {{ok:true, images:{name:string,type:string,dataUrl:string,bytes:number}[], texts:{name:string,text:string}[]} | {ok:false, error:string}}
 */
export function parseAttachments(raw) {
  if (raw === undefined || raw === null) return { ok: true, images: [], texts: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'attachments must be a list' };
  if (raw.length > MAX_ATTACHMENTS) return { ok: false, error: `at most ${MAX_ATTACHMENTS} attachments` };
  const images = [], texts = [];
  let textTotal = 0;
  for (const a of raw) {
    if (!a || typeof a !== 'object') return { ok: false, error: 'bad attachment' };
    const name = safeName(a.name);
    if (a.kind === 'image') {
      const type = String(a.type || '').toLowerCase();
      const check = IMAGE_TYPES[type];
      if (!check) return { ok: false, error: `${name}: images must be PNG, JPEG, WebP or GIF` };
      const data = typeof a.data === 'string' ? a.data : '';
      if (!data || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 || !BASE64.test(data)) {
        return { ok: false, error: `${name}: image too large or not base64` };
      }
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: `${name}: image too large` };
      if (!check(bytes)) return { ok: false, error: `${name}: file is not a ${type.slice(6).toUpperCase()} image` };
      images.push({ name, type, dataUrl: `data:${type};base64,${data}`, bytes: bytes.length });
    } else if (a.kind === 'text') {
      const text = typeof a.text === 'string' ? a.text : '';
      const size = Buffer.byteLength(text);
      if (size > MAX_TEXT_BYTES) return { ok: false, error: `${name}: file larger than 100 KB` };
      if (text.includes('\u0000')) return { ok: false, error: `${name}: not a text file` };
      textTotal += size;
      if (textTotal > MAX_TEXT_TOTAL_BYTES) return { ok: false, error: 'files larger than 200 KB in total' };
      texts.push({ name, text });
    } else {
      return { ok: false, error: `${name}: unsupported attachment` };
    }
  }
  return { ok: true, images, texts };
}

/** Names only, for history and the episodic log (ADR §6). */
export function attachmentNames(parsed) {
  return [...(parsed?.images || []), ...(parsed?.texts || [])].map((a) => a.name);
}

/** True when any message carries an image part (vision models only, ADR §5). */
export function messagesHaveImages(messages) {
  return Array.isArray(messages) && messages.some((m) => Array.isArray(m?.content)
    && m.content.some((p) => p?.type === 'image_url'));
}

/** Character length of a message's text, for token estimates; images counted separately. */
export function contentStats(content) {
  if (typeof content === 'string') return { chars: content.length, images: 0 };
  let chars = 0, images = 0;
  if (Array.isArray(content)) {
    for (const p of content) {
      if (p?.type === 'text' && typeof p.text === 'string') chars += p.text.length;
      else if (p?.type === 'image_url') images += 1;
    }
  }
  return { chars, images };
}
