/**
 * store.js — server-backed mirror (OWNER-UI-2). Source-structure guards that
 * pin the trust-relevant shape: the document mirrors to / hydrates from the
 * server, both are gated on a live agent session (the demo build and a
 * signed-out visitor never touch the server), and localStorage remains the
 * instant in-browser cache.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'store.js'), 'utf8');

describe('store.js — server-backed shared store', () => {
  it('mirrors mutations to the server and hydrates the authoritative copy', () => {
    expect(src).toMatch(/putStore\(state\)/);
    expect(src).toMatch(/getStore\(\)/);
  });

  it('gates all server traffic on a live agent + session (no token, no phone-home)', () => {
    expect(src).toMatch(/isAgentConfigured\(\)/);
    expect(src).toMatch(/getStoredToken\(\)/);
    // Both the mirror and the hydrate return early before `serverStoreAvailable`.
    expect(src).toMatch(/if \(!serverStoreAvailable\(\)\) return;/);
  });

  it('keeps localStorage as the instant, demo-build cache', () => {
    expect(src).toMatch(/localStorage\.setItem\(STORAGE_KEY/);
  });
});