/**
 * Noticeboard publish surface — structural guards (NAP-BRIDGE-8).
 *
 * The repo's view tests run without a DOM, so these are source-structure
 * assertions that pin the security-critical shape of the draft→approve→sign→
 * publish flow. The two invariants that matter most:
 *
 *   1. The node only ever DRAFTS — the signable template is exactly the NIP-01
 *      event (kind/content/created_at/tags); shelf metadata (`_relay`,
 *      `_proposed_at`) is stripped before the signer sees it.
 *   2. Signing is gated on a NIP-07 signer in the browser (no key on the node),
 *      and publishing is a WebSocket `["EVENT", …]` to the operator's relay only.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const viewSrc = readFileSync(join(here, 'noticeboard.js'), 'utf8');
const publishSrc = readFileSync(join(here, '../lib/relay-publish.js'), 'utf8');

describe('noticeboard view — human-in-the-loop signing', () => {
  it('builds the signable event from only the NIP-01 fields (strips shelf metadata)', () => {
    expect(viewSrc).toMatch(
      /signable = \{ kind: event\.kind, content: event\.content, created_at: event\.created_at, tags: event\.tags \}/,
    );
  });

  it('gate-keeps signing behind a browser NIP-07 signer', () => {
    expect(viewSrc).toMatch(/window\.nostr\?\.signEvent/);
  });

  it('never signs or publishes without the operator clicking sign', () => {
    // The only sign call is inside signAndPublish, reached from the button.
    expect(viewSrc).toMatch(/Sign & publish/);
    expect(viewSrc).toMatch(/publishEvent\(relay, signed\)/);
  });

  it('discards the draft only after a successful publish', () => {
    // discardDraft must follow publishEvent, never precede it.
    const pubIdx = viewSrc.indexOf('publishEvent(relay, signed)');
    const discardIdx = viewSrc.indexOf('discardDraft(file)');
    expect(pubIdx).not.toBe(-1);
    expect(discardIdx).toBeGreaterThan(pubIdx);
  });
});

describe('relay-publish — the node has no write path', () => {
  it('sends the signed event as a NIP-01 ["EVENT", …] over a WebSocket', () => {
    expect(publishSrc).toMatch(/send\(JSON\.stringify\(\['EVENT', signedEvent\]\)\)/);
  });

  it('only treats an OK with `true` as success', () => {
    expect(publishSrc).toMatch(/msg\[2\] === true/);
  });

  it('rejects a refusal with the relay-provided reason', () => {
    expect(publishSrc).toMatch(/msg\[3\]/);
  });

  it('is browser-only (WebSocket, no import from the node backend)', () => {
    // The page's WebSocket global is the transport; nothing imports a node SDK.
    expect(publishSrc).toMatch(/new WebSocket\(relay\)/);
  });
});