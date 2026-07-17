/**
 * Dependency-free Bech32 npub codec (NIP-19).
 *
 * The root frontend carries NO runtime dependencies (vite + vitest only), so
 * this is a hand-rolled Bech32 (BIP-173) implementation scoped to what the
 * operator-roster input needs: decode `npub1…` to a 64-hex pubkey (verifying
 * the checksum) and accept a raw 64-hex pubkey as-is. Encoding (`toNpub`) is
 * provided so `shortNpub` can show a friendly `npub1…` form.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const HEX64_RE = /^[0-9a-f]{64}$/;

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk >>> 0;
}

// Expand the human-readable part into the value list the checksum runs over.
function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function verifyChecksum(hrp, data) {
  return bech32Polymod([...hrpExpand(hrp), ...data]) === 1;
}

function createChecksum(hrp, data) {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(values) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}

// General power-of-two base conversion (used for 8<->5 bit regrouping).
function convertBits(data, fromBits, toBits, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    return null;
  }
  return out;
}

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/**
 * Parse an operator identifier. Accepts a Bech32 `npub1…` (checksum-verified)
 * or a raw 64-hex pubkey. Returns { ok: true, hex } with the canonical
 * lowercase 64-hex pubkey, or { ok: false, reason }.
 */
export function parseNpub(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, reason: 'Enter an npub or 64-hex public key.' };

  if (/^npub1/i.test(raw)) {
    const lower = raw.toLowerCase();
    const pos = lower.lastIndexOf('1');
    const hrp = lower.slice(0, pos);
    const dataPart = lower.slice(pos + 1);
    if (hrp !== 'npub') return { ok: false, reason: 'Not an npub (wrong prefix).' };
    if (dataPart.length < 6) return { ok: false, reason: 'npub is too short.' };
    const data = [];
    for (const ch of dataPart) {
      const idx = CHARSET.indexOf(ch);
      if (idx === -1) return { ok: false, reason: 'npub has invalid characters.' };
      data.push(idx);
    }
    if (!verifyChecksum(hrp, data)) return { ok: false, reason: 'npub checksum is invalid.' };
    const bytes = convertBits(data.slice(0, -6), 5, 8, false);
    if (!bytes || bytes.length !== 32) return { ok: false, reason: 'npub does not decode to a 32-byte key.' };
    return { ok: true, hex: bytesToHex(bytes) };
  }

  const hex = raw.toLowerCase();
  if (!HEX64_RE.test(hex)) {
    return { ok: false, reason: 'Enter a valid npub (npub1…) or 64-hex public key.' };
  }
  return { ok: true, hex };
}

/**
 * Encode a 64-hex pubkey to a Bech32 `npub1…`. Returns null on bad input.
 */
export function toNpub(hex) {
  const h = String(hex == null ? '' : hex).trim().toLowerCase();
  if (!HEX64_RE.test(h)) return null;
  const data = convertBits(hexToBytes(h), 8, 5, true);
  if (!data) return null;
  const combined = [...data, ...createChecksum('npub', data)];
  let out = 'npub1';
  for (const d of combined) out += CHARSET[d];
  return out;
}

/**
 * Friendly shortened display form. Given a 64-hex pubkey, renders the
 * `npub1…` and truncates it; falls back to a hex prefix if encoding fails.
 */
export function shortNpub(hex) {
  const np = toNpub(hex);
  if (np) return `${np.slice(0, 12)}…${np.slice(-6)}`;
  const h = String(hex == null ? '' : hex);
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}
