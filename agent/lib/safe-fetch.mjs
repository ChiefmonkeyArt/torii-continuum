/**
 * safe-fetch.mjs: GET an UNTRUSTED https URL (profile avatars, NIP-05 files).
 * docs/adr-teams-membership-signals.md, "hostile-input fetches":
 *   https, default port, no credentials; DNS checked AT CONNECT TIME through
 *   the socket lookup hook (no check-then-use gap); IP literals checked too;
 *   ≤ 3 redirects, each re-checked; timeout; size cap while streaming.
 */
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { isUnsafeHostname, isUnsafeIPv4, isUnsafeIPv6 } from '../core/routstr-discovery.mjs';

const unsafeIp = (ip) => (isIP(ip) === 4 ? isUnsafeIPv4(ip) : isIP(ip) === 6 ? isUnsafeIPv6(ip) : true);

/** dns.lookup wrapper that refuses any non-public answer. Exported for tests. */
export function guardedLookup(hostname, options, cb) {
  const opts = typeof options === 'object' && options ? options : {};
  dnsLookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [];
    if (!list.length || list.some((a) => unsafeIp(a.address))) {
      const e = new Error('refusing a non-public address');
      e.code = 'EUNSAFEADDR';
      return cb(e);
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

/** Static URL check (exported for tests). Returns a URL or null. */
export function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  if (isUnsafeHostname(u.hostname)) return null;
  return u;
}

/**
 * @returns {Promise<{ok:true, body:Buffer, type:string}|{ok:false, reason:string}>}
 */
export async function safeGet(raw, { maxBytes = 512 * 1024, timeoutMs = 5000, redirects = 3, accept = '*/*', request = https.request } = {}) {
  let url = checkUrl(raw);
  for (let hop = 0; url && hop <= redirects; hop++) {
    const res = await once(url, { maxBytes, timeoutMs, accept, request });
    if (!res.ok || !res.location) return res;
    url = checkUrl(new URL(res.location, url).href);
  }
  return { ok: false, reason: url ? 'too many redirects' : 'unsafe url' };
}

function once(url, { maxBytes, timeoutMs, accept, request }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const req = request(url, {
      method: 'GET',
      lookup: guardedLookup,
      headers: { accept, 'user-agent': 'torii-continuum' },
      timeout: timeoutMs,
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        return finish({ ok: true, location: String(res.headers.location) });
      }
      if (code !== 200) { res.resume(); return finish({ ok: false, reason: `http ${code}` }); }
      const len = Number(res.headers['content-length'] || 0);
      if (len > maxBytes) { res.destroy(); return finish({ ok: false, reason: 'too large' }); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { res.destroy(); finish({ ok: false, reason: 'too large' }); return; }
        chunks.push(c);
      });
      res.on('end', () => finish({ ok: true, body: Buffer.concat(chunks), type: String(res.headers['content-type'] || '') }));
      res.on('error', () => finish({ ok: false, reason: 'read error' }));
    });
    const timer = setTimeout(() => { req.destroy(); finish({ ok: false, reason: 'timeout' }); }, timeoutMs);
    req.on('timeout', () => { req.destroy(); finish({ ok: false, reason: 'timeout' }); });
    req.on('error', (e) => finish({ ok: false, reason: e.code === 'EUNSAFEADDR' ? 'unsafe address' : 'network error' }));
    req.end();
  });
}

/** Identify an image by its first bytes. SVG is never accepted. */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
