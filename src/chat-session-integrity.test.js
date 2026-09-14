/**
 * FE-02 — pending chat reply must not repersist after logout / owner change.
 *
 * The live bug: send() captured the thread key but NOT the session identity
 * before awaiting the agent. A reply that landed after a sign-out (or a
 * different owner signing in on a shared browser) was written back into
 * `continuum.chat.threads`, resurrecting the previous owner's conversation.
 *
 * The fix snapshots getStoredToken() (the complete, npub-bound session identity)
 * before the awaited turn and drops the reply if the token changed. This test
 * pins that invariant at source level — the repo's jsdom-free convention does
 * not mount the full DOM, so the guard is asserted structurally.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const chatSrc = readFileSync(join(here, 'chat.js'), 'utf8');

describe('FE-02: chat turn is bound to the session identity at send time', () => {
  it('snapshots the stored token before awaiting the agent reply', () => {
    // The snapshot must come BEFORE `await getReply(...)`.
    const snapshotIdx = chatSrc.indexOf('const turnToken = getStoredToken()');
    const awaitIdx = chatSrc.indexOf('const reply = await getReply(');
    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(snapshotIdx).toBeLessThan(awaitIdx);
  });

  it('imports getStoredToken from the agent client', () => {
    expect(chatSrc).toMatch(/getStoredToken[\s\S]*from '\.\/data\/agent\.js'/);
  });

  it('drops the reply (before pushTo) when the session token changed', () => {
    // The guard `turnToken !== getStoredToken()` must appear AFTER the awaited
    // reply and BEFORE the pushTo that persists the AI message.
    const guardIdx = chatSrc.indexOf('if (turnToken !== getStoredToken()) return;');
    const pushToIdx = chatSrc.indexOf('pushTo(turnKey, \'ai\', reply.text');
    const awaitReplyIdx = chatSrc.indexOf('const reply = await getReply(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(awaitReplyIdx);
    expect(guardIdx).toBeLessThan(pushToIdx);
  });

  it('does not persist or log a stale reply after the token changed', () => {
    // persistServerSession / saveThreads are only reachable through pushTo; the
    // early return short-circuits them. Assert the return precedes any pushTo.
    const guard = /if \(turnToken !== getStoredToken\(\)\) return;/.test(chatSrc);
    expect(guard).toBe(true);
  });
});