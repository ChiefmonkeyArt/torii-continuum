/**
 * Secret-safe scrub for the ONLY error field we log (its message).
 *
 * Mirrors onboarding.mjs's sanitizeReason (redact long hex runs — 64-hex NWC
 * secrets and wallet pubkeys) and additionally redacts nostr+walletconnect
 * URIs, then truncates. Kept as its own tiny module so the app-level error
 * handler in index.mjs can log a bounded, secret-free message AND so the
 * redaction can be unit-tested without booting the Fastify server.
 *
 * We never log the raw error object or its stack — only scrub(err.message).
 */
export function scrub(s) {
  const raw = typeof s === 'string' && s ? s : 'unknown error';
  return raw
    .replace(/nostr\+?walletconnect:\/\/\S+/gi, '[nwc-uri-redacted]')
    .replace(/[0-9a-f]{16,}/gi, '[redacted]')
    .slice(0, 200);
}
