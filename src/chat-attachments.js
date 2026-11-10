/**
 * The assistant bar's "+" (docs/adr-one-assistant-bar.md §4).
 *
 * Turns picked or pasted files into what /api/chat accepts:
 *   { kind:'image', name, type:'image/jpeg', data:<base64> }  (shrunk here)
 *   { kind:'text',  name, text }
 * The agent checks every limit again; these checks exist so the owner hears
 * "too big" before anything is sent or paid for. Pure helpers are exported
 * for tests; the canvas work is isolated in shrinkImage().
 */

export const MAX_ITEMS = 4;
export const MAX_SIDE = 1568;
export const MAX_TEXT_BYTES = 100 * 1024;
export const MAX_TEXT_TOTAL = 200 * 1024;
export const MAX_IMAGE_BYTES = 700 * 1024;
/** Under nginx's 1 MB with room for the message, page context and JSON. */
export const MAX_PAYLOAD = 900 * 1024;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm',
  'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'svelte', 'vue', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'java',
  'kt', 'swift', 'sh', 'bash', 'zsh', 'sql', 'log', 'ini', 'conf', 'env', 'diff', 'patch']);

/** The picker's accept list: images plus the text types above. */
export const ACCEPT = [...IMAGE_TYPES, 'text/*', ...[...TEXT_EXT].map((e) => '.' + e)].join(',');

/** 'image' | 'text' | null for a file's name and MIME type. */
export function classifyFile(name, type) {
  const t = String(type || '').toLowerCase();
  if (IMAGE_TYPES.has(t)) return 'image';
  if (t.startsWith('image/')) return null; // svg, heic, tiff...: not supported
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (t.startsWith('text/') || t === 'application/json' || t === 'application/xml' || TEXT_EXT.has(ext)) return 'text';
  return null;
}

/** Scale (w, h) so the long side is at most `max`, never upscaling. */
export function fitWithin(w, h, max = MAX_SIDE) {
  const long = Math.max(w, h);
  if (!(long > max)) return { width: w, height: h };
  const k = max / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Approximate bytes an item adds to the request body. */
export function itemBytes(item) {
  return item.kind === 'image' ? item.data.length : new TextEncoder().encode(item.text).length;
}

/**
 * Can `item` join `list`? Returns an error sentence or ''.
 */
export function checkAdd(list, item) {
  if (list.length >= MAX_ITEMS) return `Up to ${MAX_ITEMS} images or files per message.`;
  if (item.kind === 'text') {
    const size = itemBytes(item);
    if (size > MAX_TEXT_BYTES) return `${item.name} is larger than 100 KB.`;
    const total = list.filter((i) => i.kind === 'text').reduce((n, i) => n + itemBytes(i), 0) + size;
    if (total > MAX_TEXT_TOTAL) return 'Files can be up to 200 KB in total.';
  }
  const payload = list.reduce((n, i) => n + itemBytes(i), 0) + itemBytes(item);
  if (payload > MAX_PAYLOAD) return 'That is too much to send in one message. Remove something first.';
  return '';
}

/** "Attached: a.png, notes.md" — the only trace kept in history (ADR §6). */
export function attachedLine(list) {
  return list.length ? 'Attached: ' + list.map((i) => i.name).join(', ') : '';
}

/** What /api/chat receives. */
export function toPayload(list) {
  return list.map((i) => (i.kind === 'image'
    ? { kind: 'image', name: i.name, type: i.type, data: i.data }
    : { kind: 'text', name: i.name, text: i.text }));
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Shrink an image to MAX_SIDE and re-encode as JPEG on a white background
 * (transparency becomes white, GIFs keep their first frame). Steps the quality
 * down until it fits MAX_IMAGE_BYTES.
 */
export async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  for (const q of [0.85, 0.7, 0.55, 0.4]) {
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));
    if (!blob) break;
    if (blob.size <= MAX_IMAGE_BYTES) return base64(new Uint8Array(await blob.arrayBuffer()));
  }
  throw new Error('too large');
}

/**
 * One File -> one item, or { error }. `shrink` is injectable for tests.
 */
export async function readFile(file, { shrink = shrinkImage } = {}) {
  const name = String(file?.name || 'pasted image').split(/[\\/]/).pop().slice(0, 120);
  const kind = classifyFile(name, file?.type);
  if (!kind) return { error: `${name}: only images (PNG, JPEG, WebP, GIF) and text files can be added.` };
  if (kind === 'image') {
    try {
      const data = await shrink(file);
      const jpgName = name.replace(/\.(png|webp|gif|jpe?g)$/i, '') + '.jpg';
      return { item: { kind: 'image', name: jpgName, type: 'image/jpeg', data } };
    } catch { return { error: `${name}: this image could not be read or made small enough.` }; }
  }
  if (file.size > MAX_TEXT_BYTES) return { error: `${name} is larger than 100 KB.` };
  const text = await file.text();
  if (text.includes('\u0000')) return { error: `${name} is not a text file.` };
  return { item: { kind: 'text', name, text } };
}
