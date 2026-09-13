/**
 * OWNER-UI-5 — chat polish ("less chrome, cleaner message flow"). Source-
 * structure guards pinning the Perplexity-like treatment: messages render
 * without per-turn avatar chrome, assistant turns are flat text (no bubble
 * border), and the conversation log stays an accessible live region.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const chat = readFileSync(join(here, 'chat.js'), 'utf8');
const css = readFileSync(join(here, 'styles', 'chat.css'), 'utf8');

describe('chat polish (less chrome)', () => {
  it('renders messages without the per-turn "you"/"AI" avatar chrome', () => {
    expect(chat).not.toContain('class="avatar"');
    expect(chat).not.toMatch(/avatar/);
  });

  it('renders assistant turns as flat text — no bubble border/background', () => {
    expect(css).toMatch(/\.chat-msg\.ai \.bubble\s*\{[\s\S]*?border:\s*none/);
  });

  it('keeps the conversation log an accessible live region', () => {
    expect(chat).toContain('aria-live="polite"');
  });
});