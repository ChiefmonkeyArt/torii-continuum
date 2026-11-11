/** Normalised Cashu mint URL for comparison: lower-case host, no trailing slash. */
export function mintKey(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}

/** Do two mint lists share a mint? Unknown (null/empty) lists never exclude. */
export function mintsOverlap(a, b) {
  if (!Array.isArray(a) || !a.length || !Array.isArray(b) || !b.length) return true;
  const set = new Set(a.map(mintKey).filter(Boolean));
  return b.some(m => set.has(mintKey(m)));
}
