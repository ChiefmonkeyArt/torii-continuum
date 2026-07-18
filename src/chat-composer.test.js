/**
 * Floating chat composer (UI-COMPOSER-1, v0.2.68-alpha).
 *
 * Two halves, matching the repo's jsdom-free convention:
 *   1. Pure-function unit tests for the auto-grow + reserved-space geometry
 *      (chat-layout.js), exercised directly with no DOM.
 *   2. Source- and CSS-structure assertions proving the composer floats, reserves
 *      matching bottom space, preserves keyboard/actions/accessibility, and is
 *      responsive with safe-area handling on mobile.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  clampInputHeight,
  inputShouldScroll,
  reserveSpaceFor,
  CHAT_INPUT_MIN,
  CHAT_INPUT_MAX,
  CHAT_FLOAT_GAP,
} from './chat-layout.js';

const here = dirname(fileURLToPath(import.meta.url));
const chatSrc = readFileSync(join(here, 'chat.js'), 'utf8');
const chatCss = readFileSync(join(here, 'styles', 'chat.css'), 'utf8');
const layoutCss = readFileSync(join(here, 'styles', 'layout.css'), 'utf8');
const themeCss = readFileSync(join(here, 'styles', 'theme.css'), 'utf8');

// ── 1. Auto-grow geometry ────────────────────────────────────────────────────
describe('auto-grow: textarea height clamps between min and max', () => {
  it('never shrinks below the single-line minimum', () => {
    expect(clampInputHeight(0)).toBe(CHAT_INPUT_MIN);
    expect(clampInputHeight(10)).toBe(CHAT_INPUT_MIN);
    expect(clampInputHeight(CHAT_INPUT_MIN - 5)).toBe(CHAT_INPUT_MIN);
  });

  it('grows with content between the bounds', () => {
    const mid = Math.round((CHAT_INPUT_MIN + CHAT_INPUT_MAX) / 2);
    expect(clampInputHeight(mid)).toBe(mid);
    expect(clampInputHeight(CHAT_INPUT_MIN + 20)).toBe(CHAT_INPUT_MIN + 20);
  });

  it('stops growing at the maximum', () => {
    expect(clampInputHeight(CHAT_INPUT_MAX)).toBe(CHAT_INPUT_MAX);
    expect(clampInputHeight(CHAT_INPUT_MAX + 400)).toBe(CHAT_INPUT_MAX);
  });

  it('returns integers and tolerates junk input', () => {
    expect(clampInputHeight(120.4)).toBe(121); // ceil so content always fits
    expect(clampInputHeight(NaN)).toBe(CHAT_INPUT_MIN);
    expect(clampInputHeight(undefined)).toBe(CHAT_INPUT_MIN);
  });

  it('scrolls internally only once content exceeds the max', () => {
    expect(inputShouldScroll(CHAT_INPUT_MAX - 1)).toBe(false);
    expect(inputShouldScroll(CHAT_INPUT_MAX)).toBe(false);
    expect(inputShouldScroll(CHAT_INPUT_MAX + 1)).toBe(true);
    expect(inputShouldScroll(0)).toBe(false);
  });
});

// ── 2. Reserved-space geometry ────────────────────────────────────────────────
describe('reserved space tracks the floating dock height + gap', () => {
  it('reserves dock height plus the float gap', () => {
    expect(reserveSpaceFor(88)).toBe(88 + CHAT_FLOAT_GAP);
    expect(reserveSpaceFor(300)).toBe(300 + CHAT_FLOAT_GAP);
  });

  it('grows as the composer grows so nothing is obscured', () => {
    const small = reserveSpaceFor(64);
    const large = reserveSpaceFor(200);
    expect(large).toBeGreaterThan(small);
  });

  it('falls back to zero (CSS default) when unmeasured', () => {
    expect(reserveSpaceFor(0)).toBe(0);
    expect(reserveSpaceFor(-10)).toBe(0);
    expect(reserveSpaceFor(NaN)).toBe(0);
  });
});

// ── 3. chat.js wiring ─────────────────────────────────────────────────────────
describe('chat.js: keyboard behavior unchanged', () => {
  it('Enter without Shift sends and prevents the newline', () => {
    expect(chatSrc).toMatch(/e\.key === 'Enter' && !e\.shiftKey.*preventDefault\(\).*send\(\)/s);
  });
  it('Shift+Enter is left to insert a newline (no send)', () => {
    // The guard requires !e.shiftKey, so Shift+Enter falls through to default.
    expect(chatSrc).toMatch(/!e\.shiftKey/);
  });
});

describe('chat.js: auto-grow + reserved-space wiring', () => {
  it('autosize uses the shared clamp + internal-scroll helpers', () => {
    expect(chatSrc).toMatch(/clampInputHeight\(scrollH\)/);
    expect(chatSrc).toMatch(/inputShouldScroll\(scrollH\)/);
  });
  it('autosize re-reserves space after a height change', () => {
    expect(chatSrc).toMatch(/function autosize\(\)[\s\S]*reserveSpace\(\)/);
  });
  it('reserveSpace publishes --chat-reserve from the dock height', () => {
    expect(chatSrc).toMatch(/reserveSpaceFor\(dockEl\.offsetHeight\)/);
    expect(chatSrc).toMatch(/setProperty\('--chat-reserve'/);
  });
  it('observes the dock so height changes keep the reserve in sync', () => {
    expect(chatSrc).toMatch(/typeof ResizeObserver !== 'undefined'/);
    expect(chatSrc).toMatch(/new ResizeObserver\(\(\) => reserveSpace\(\)\)/);
    expect(chatSrc).toMatch(/\.observe\(dockEl\)/);
  });
  it('re-reserves on viewport resize (mobile keyboard / rotation)', () => {
    expect(chatSrc).toMatch(/addEventListener\('resize', reserveSpace\)/);
  });
  it('re-reserves when expanding/collapsing', () => {
    expect(chatSrc).toMatch(/function setExpanded\([\s\S]*reserveSpace\(\)/);
  });
});

describe('chat.js: existing controls + actions preserved', () => {
  it('keeps the context chip, page/general scope, send and toggle controls', () => {
    for (const cls of ['chat-context', 'chat-mode', 'chat-send', 'chat-toggle', 'chat-input']) {
      expect(chatSrc).toContain(cls);
    }
  });
  it('keeps send() and the non-sending compose() prefill', () => {
    expect(chatSrc).toMatch(/async function send\(\)/);
    expect(chatSrc).toMatch(/export function compose\(/);
  });
  it('keeps the agent/mock reply path and thinking state', () => {
    expect(chatSrc).toMatch(/isSessionLive\(\)/);
    expect(chatSrc).toMatch(/thinking = true/);
  });
});

describe('chat.js: accessibility preserved/added', () => {
  it('labels the floating panel as a region', () => {
    expect(chatSrc).toMatch(/setAttribute\('role', 'region'\)/);
    expect(chatSrc).toMatch(/setAttribute\('aria-label', 'Continuum chat'\)/);
  });
  it('keeps the live log and labelled input', () => {
    expect(chatSrc).toMatch(/role="log" aria-live="polite"/);
    expect(chatSrc).toMatch(/aria-label="Chat input"/);
  });
});

// ── 4. chat.css: floating, separated, on-brand ────────────────────────────────
describe('chat.css: composer floats as a rounded, separated box', () => {
  it('is position:fixed and no longer occupies the grid row', () => {
    expect(chatCss).toMatch(/\.chat-dock\s*\{[\s\S]*position:\s*fixed/);
    expect(chatCss).not.toMatch(/grid-area:\s*chat/);
  });
  it('is rounded with a restrained shadow and backdrop blur', () => {
    expect(chatCss).toMatch(/border-radius:\s*16px/);
    expect(chatCss).toMatch(/backdrop-filter:\s*blur/);
    expect(chatCss).toMatch(/box-shadow:/);
  });
  it('uses the amber/bronze palette tokens (sidebar bg + primary accent)', () => {
    expect(chatCss).toMatch(/background:\s*hsl\(var\(--sidebar\)/);
    expect(chatCss).toMatch(/hsl\(var\(--primary\)/);
  });
  it('is centered with a sensible desktop max width', () => {
    expect(chatCss).toMatch(/margin-inline:\s*auto/);
    expect(chatCss).toMatch(/max-width:\s*820px/);
  });
  it('honours the bottom safe-area inset', () => {
    expect(chatCss).toMatch(/bottom:\s*calc\(16px \+ env\(safe-area-inset-bottom/);
  });
  it('caps the textarea max-height in sync with CHAT_INPUT_MAX', () => {
    expect(chatCss).toMatch(/max-height:\s*160px/);
    expect(CHAT_INPUT_MAX).toBe(160);
  });
});

describe('chat.css: mobile is full-width-with-margins + safe area', () => {
  it('drops the desktop max-width and pins small side margins under 900px', () => {
    const mq = chatCss.slice(chatCss.indexOf('@media (max-width: 900px)'));
    expect(mq).toMatch(/\.chat-dock\s*\{[\s\S]*left:\s*12px/);
    expect(mq).toMatch(/right:\s*12px/);
    expect(mq).toMatch(/max-width:\s*none/);
    expect(mq).toMatch(/env\(safe-area-inset-bottom/);
  });
});

// ── 5. layout.css / theme.css: reserved space, no layout jump ──────────────────
describe('layout.css: content scroller reserves composer space', () => {
  it('collapses the old chat grid row (single main area)', () => {
    expect(layoutCss).not.toMatch(/"sidebar chat"/);
    expect(layoutCss).toMatch(/grid-template-areas:\s*"sidebar main"/);
  });
  it('pads .main bottom by the live reserve with a static fallback', () => {
    expect(layoutCss).toMatch(/\.main\s*\{[\s\S]*var\(--chat-reserve, 104px\)/);
  });
  it('keeps the reserve on mobile too', () => {
    const mq = layoutCss.slice(layoutCss.indexOf('@media (max-width: 900px)'));
    expect(mq).toMatch(/var\(--chat-reserve/);
  });
});

describe('theme.css: --chat-reserve has a first-paint default', () => {
  it('defines the fallback reserve variable', () => {
    expect(themeCss).toMatch(/--chat-reserve:\s*104px/);
  });
});
