/**
 * View-semantics guardrails for the Memory console (MEMORY-1). Source-structure
 * assertions (the repo's tests run without a DOM), reading the module as text to
 * lock in the security + consent invariants that must not regress:
 *
 *   1. XSS-safe rendering: h() with textContent only, no innerHTML / html:.
 *   2. Ciphertext-only at rest: proposals are sealed (NIP-44) in the browser at
 *      creation; review DECRYPTS the stored ciphertext client-side and verifies
 *      its canonical hash; approval posts only the reviewed hash + nonce. The
 *      view never posts plaintext OR re-sends ciphertext, and never handles a key.
 *   3. Nothing is auto-saved: proposals & imports require explicit owner action,
 *      and the console says so.
 *   4. Portability signs the manifest digest in the browser (NIP-07), attaches
 *      the signature, and downloads — it never publishes to a relay.
 *   5. Import lands in QUARANTINE, never straight into live memory.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'memory.js'), 'utf8');

describe('memory view — XSS-safe rendering', () => {
  it('uses the h() builder and never innerHTML or an html: attribute', () => {
    expect(src).toMatch(/\bh\(/);
    expect(src).not.toMatch(/innerHTML/);
    expect(src).not.toMatch(/\bhtml:/);
  });
});

describe('memory view — ciphertext-only at rest; review decrypts, approval re-sends nothing', () => {
  it('seals proposal payloads in the browser at creation (NIP-44 encrypt)', () => {
    expect(src).toMatch(/window\.nostr\.nip44\.encrypt/);
    expect(src).toMatch(/sealProposalPayload/);
  });

  it('decrypts the stored ciphertext client-side for review (NIP-44 decrypt)', () => {
    expect(src).toMatch(/window\.nostr\.nip44\.decrypt/);
    expect(src).toMatch(/memoryApprove\(/);
  });

  it('verifies the decrypted payload against the reviewed canonical hash', () => {
    expect(src).toMatch(/canonicalSha256Hex/);
    expect(src).toMatch(/hashVerified/);
  });

  it('binds approval to the exact reviewed payload hash + single-use nonce', () => {
    expect(src).toMatch(/payload_sha256:\s*p\.payload_sha256/);
    expect(src).toMatch(/approval_nonce:\s*p\.approval_nonce/);
  });

  it('approval re-sends neither plaintext nor ciphertext to the agent', () => {
    // Approval forwards only the hash + nonce — never a payload or ciphertext.
    expect(src).not.toMatch(/memoryApprove\([^)]*payload:/);
    expect(src).not.toMatch(/memoryApprove\([^)]*ciphertext:/);
  });

  it('requires a NIP-44-capable signer and fails closed without one', () => {
    expect(src).toMatch(/nip44/);
    expect(src).toMatch(/required/i);
  });
});

describe('memory view — nothing is auto-saved (explicit consent)', () => {
  it('states that proposals are not stored until approved', () => {
    expect(src).toMatch(/until you approve/i);
  });

  it('offers an explicit reject path', () => {
    expect(src).toMatch(/memoryReject\(/);
  });
});

describe('memory view — portability is browser-signed and never published', () => {
  it('signs the manifest digest via NIP-07 signEvent with the detached bundle kind', () => {
    expect(src).toMatch(/BUNDLE_SIG_KIND\s*=\s*30099/);
    expect(src).toMatch(/window\.nostr\.signEvent/);
    expect(src).toMatch(/manifest_digest/);
  });

  it('export requires a signer and downloads locally, and says it is not published to a relay', () => {
    expect(src).toMatch(/memoryExport\(/);
    expect(src).toMatch(/downloadJson\(/);
    // Honesty statement to the owner: the bundle is not relay-published.
    expect(src).toMatch(/published to a relay/i);
  });

  it('import verifies + quarantines (never straight into live memory)', () => {
    expect(src).toMatch(/memoryImport\(/);
    expect(src).toMatch(/quarantine/i);
  });
});

describe('memory view — owner-facing state handling', () => {
  it('handles offline, session-expired, and no-bot states', () => {
    expect(src).toMatch(/offline/i);
    expect(src).toMatch(/401/);
    expect(src).toMatch(/403/);
  });

  it('surfaces which constitution/COP covenant is live (provenance)', () => {
    expect(src).toMatch(/memoryWorkingValues\(/);
    expect(src).toMatch(/Constitution/);
    expect(src).toMatch(/Code of Practice/);
  });
});
