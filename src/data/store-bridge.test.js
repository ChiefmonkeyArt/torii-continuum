/**
 * OWNER-UI-3 — client half of the agent write bridge. Source-structure guards
 * that pin the live-update path: the store exports a hydration hook, and the
 * chat dock re-hydrates the shared document whenever a turn carried
 * `store_writes` (the agent created/updated a milestone or todo).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const storeSrc = readFileSync(join(here, 'store.js'), 'utf8');
const chatSrc = readFileSync(join(here, '..', 'chat.js'), 'utf8');

describe('OWNER-UI-3 — client write bridge', () => {
  it('exposes a hydration hook the chat dock can call after an agent write', () => {
    expect(storeSrc).toMatch(/export async function hydrateFromServer/);
  });

  it('reconciles the browser cache only when the turn reported store writes', () => {
    expect(chatSrc).toMatch(/hydrateFromServer/);
    expect(chatSrc).toMatch(/store_writes/);
    // Fire-and-forget, so a slow hydrate never blocks the reply stream.
    expect(chatSrc).toMatch(/void hydrateFromServer\(\)/);
  });
});