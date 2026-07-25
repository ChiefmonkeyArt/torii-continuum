/**
 * Chat dock — no canned replies in a production build + structured error copy
 * (v0.2.90-alpha, CONT-FALLBACK-1).
 *
 * The live bug: when a signed-in turn failed, the dock fell through to
 * `mockReply()` and served canned demo prose. The operator could not tell a
 * fabricated string from their sovereign bot's answer, so a Routstr outage
 * looked like a working chat. A configured agent now means a production build:
 * every failed turn reports a structured, sanitised error instead.
 *
 * `mockRepliesAllowed` and `chatErrorMessage` are the pure contracts; the rest
 * are source-structure assertions matching the repo's jsdom-free convention.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mockRepliesAllowed, chatErrorMessage } from './chat.js';

const here = dirname(fileURLToPath(import.meta.url));
const chatSrc = readFileSync(join(here, 'chat.js'), 'utf8');

/** Simulate a build with an agent URL baked in (i.e. a production install). */
function withAgentConfigured(url, fn) {
  const had = 'window' in globalThis;
  const prev = globalThis.window;
  globalThis.window = { __CONTINUUM_AGENT_URL__: url };
  try { return fn(); } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
}

afterEach(() => { delete globalThis.window; });

describe('mockRepliesAllowed — mocks are demo-build only', () => {
  it('forbids canned replies once an agent is configured', () => {
    withAgentConfigured('https://agent.example', () => {
      expect(mockRepliesAllowed()).toBe(false);
    });
  });

  it('permits canned replies in the agent-less demo build', () => {
    expect(mockRepliesAllowed()).toBe(true);
  });
});

describe('chatErrorMessage — structured provider codes', () => {
  it('explains a timeout and states nothing was charged', () => {
    const m = chatErrorMessage({ ok: false, code: 'upstream_timeout' });
    expect(m).toMatch(/timed out/i);
    expect(m).toMatch(/charged/i);
  });

  it('explains an HTML error page without rendering markup', () => {
    const m = chatErrorMessage({ ok: false, code: 'upstream_html', reason: 'routstr returned a non-JSON HTML error page (http 520)' });
    expect(m).toMatch(/error page/i);
    expect(m).not.toContain('<');
  });

  it('explains an upstream 5xx', () => {
    expect(chatErrorMessage({ ok: false, code: 'upstream_5xx' })).toMatch(/server errors/i);
  });

  it('explains an empty completion', () => {
    expect(chatErrorMessage({ ok: false, code: 'upstream_empty' })).toMatch(/empty response/i);
  });

  it('explains a network failure', () => {
    expect(chatErrorMessage({ ok: false, code: 'network' })).toMatch(/could not reach/i);
  });

  it('tells the operator to enable a local model when no provider is available', () => {
    expect(chatErrorMessage({ ok: false, code: 'provider_disabled' })).toMatch(/local Ollama|local model/i);
  });

  it('frames a malformed request as a bug, not an outage', () => {
    expect(chatErrorMessage({ ok: false, code: 'bad_request' })).toMatch(/bug/i);
  });

  it('never fabricates an assistant answer for an unknown code', () => {
    const m = chatErrorMessage({ ok: false, code: 'something_new', reason: 'upstream weirdness' });
    expect(m).toMatch(/could not be completed/i);
    expect(m).toContain('upstream weirdness');
  });

  it('reports an unreachable agent honestly rather than serving a canned reply', () => {
    const m = chatErrorMessage({ ok: false, offline: true });
    expect(m).toMatch(/unreachable/i);
    expect(m).toMatch(/no canned reply/i);
  });

  it('degrades to the sanitised reason when there is no code', () => {
    expect(chatErrorMessage({ ok: false, reason: 'routstr: http 503' })).toContain('routstr: http 503');
  });

  it('does not throw on a missing/empty result', () => {
    expect(chatErrorMessage(null)).toMatch(/unknown error/);
    expect(chatErrorMessage({})).toMatch(/unknown error/);
  });
});

describe('chat.js — production mock removal (source structure)', () => {
  it('gates every mock path on mockRepliesAllowed()', () => {
    expect(chatSrc).toMatch(/if\s*\(mockRepliesAllowed\(\)\)\s*return mockReply/);
  });

  it('routes a failed live turn to chatErrorMessage, never to mockReply', () => {
    expect(chatSrc).toMatch(/return chatErrorMessage\(r\)/);
    // The old shape prefixed a mock with an "(agent error…)" note.
    expect(chatSrc).not.toMatch(/agent error[^)]*\)[\s\S]{0,80}mockReply/);
  });

  it('asks a signed-out visitor to sign in rather than answering as the bot', () => {
    expect(chatSrc).toMatch(/does not answer with canned replies in a live install/);
  });

  it('discloses when the free local model answered instead of the paid provider', () => {
    expect(chatSrc).toMatch(/fell_back_from/);
    expect(chatSrc).toMatch(/answered by the local/);
  });

  it('derives mock permission from agent configuration, not the session', () => {
    expect(chatSrc).toMatch(/isAgentConfigured/);
    expect(chatSrc).toMatch(/return !isAgentConfigured\(\)/);
  });
});
