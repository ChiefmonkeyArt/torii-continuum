/**
 * View-semantics guardrails for the Genesis view (GENESIS-1). Source-structure
 * assertions (the repo's tests run without a DOM/jsdom), so they read the module
 * as text and lock in the security + honesty decisions that must not regress:
 *
 *   1. The creation form NEVER collects or sends an owner pubkey — authority
 *      comes from the verified session server-side. So the view must not contain
 *      a pubkey/npub input, and must go through genesisCreate() (which itself is
 *      pubkey-free, proven in data/agent.test.js).
 *   2. Rendering is XSS-safe: h() with textContent only, no innerHTML / html:.
 *   3. LoRA + RAG are honestly labelled as subsequent stages, never faked.
 *   4. The constitution digest is surfaced (visible provenance) and tamper
 *      evidence (constitution_ok / manifest_digest_ok) is shown.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'genesis.js'), 'utf8');

describe('genesis view — no owner-key collection (authority from session)', () => {
  it('sends creation through genesisCreate() with only display fields', () => {
    expect(src).toMatch(/genesisCreate\(\{/);
    expect(src).toMatch(/display_name:/);
  });

  it('never renders an input/placeholder soliciting a pubkey or npub', () => {
    expect(src).not.toMatch(/placeholder:[^)]*npub/i);
    expect(src).not.toMatch(/placeholder:[^)]*pubkey/i);
    // No pubkey/owner keys are ever added to the create payload here.
    expect(src).not.toMatch(/pubkey:\s*/);
    expect(src).not.toMatch(/ownerNpub:/);
  });
});

describe('genesis view — XSS-safe rendering', () => {
  it('uses the h() builder and never innerHTML or an html: attribute', () => {
    expect(src).toMatch(/\bh\(/);
    expect(src).not.toMatch(/innerHTML/);
    expect(src).not.toMatch(/\bhtml:/);
  });
});

describe('genesis view — honest about subsequent stages', () => {
  it('labels LoRA and RAG as subsequent / not active stages', () => {
    expect(src).toMatch(/LoRA/);
    expect(src).toMatch(/RAG/);
    expect(src).toMatch(/subsequent stage/i);
  });
});

describe('genesis view — visible provenance + tamper evidence', () => {
  it('surfaces the constitution digest', () => {
    expect(src).toMatch(/digest/i);
    expect(src).toMatch(/con\.digest/);
  });

  it('reflects tamper-evidence flags from the read response', () => {
    expect(src).toMatch(/constitution_ok/);
    expect(src).toMatch(/manifest_digest_ok/);
  });

  it('distinguishes an earlier-but-valid covenant from tampering', () => {
    expect(src).toMatch(/constitution_is_current/);
    expect(src).toMatch(/constitution_current_version/);
  });
});

describe('genesis view — layered principles provenance (Layer B + C)', () => {
  it('renders a layers card from the constitution layers block', () => {
    expect(src).toMatch(/layersCard\(/);
    expect(src).toMatch(/con\.layers/);
  });

  it('names the Code of Practice and Reference Canon docs', () => {
    expect(src).toMatch(/Code of Practice/);
    expect(src).toMatch(/Reference Canon/);
  });

  it('surfaces the normative hierarchy for conflict resolution', () => {
    expect(src).toMatch(/normative_hierarchy/);
    expect(src).toMatch(/hard refusal of clear harm/i);
  });

  it('renders doc references as plain text, never as navigable links', () => {
    // No anchor tags and no href/window.open — provenance is text-only, so the
    // layers card adds no external-navigation or XSS surface.
    expect(src).not.toMatch(/href/i);
    expect(src).not.toMatch(/window\.open/);
    expect(src).not.toMatch(/h\('a'/);
  });

  it('shows the genesis-1.1.0 sovereignty invariants', () => {
    expect(src).toMatch(/invariants/);
    expect(src).toMatch(/Sovereignty invariants/i);
  });
});
