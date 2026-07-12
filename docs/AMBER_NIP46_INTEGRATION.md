# Amber / NIP-46 Signer Integration Analysis

**Date:** 2026-07-07  
**Context:** Login flow now works (Content-Type fix deployed), but user needs to configure their npub as admin. Considering whether to integrate Amber as an embedded signer.

---

## Current State

- **Login flow:** Challenge → sign with NIP-07 (nos2x-fox/Plebeian Signer) → verify → session token
- **Problem:** User must have a browser extension installed AND configure their npub in the agent config
- **Error after fix:** "Agent rejected signature: pubkey is not admin npub" — the login flow works, but the agent doesn't recognize the signing key

---

## What is Amber?

[Amber](https://github.com/greenart7c3/Amber) is an Android app that acts as a **NIP-46 remote signer**. It:

- Stores nsec on the user's phone (never leaves the device)
- Exposes a `bunker://` URL for web apps to connect to
- Signs events when prompted (user sees a confirmation dialog on their phone)
- Supports multiple accounts
- Works offline (no server needed — phone and browser communicate locally)

Amber implements **NIP-46** (Nostr Remote Signing), not NIP-07 (browser extension API).

---

## Amber vs NIP-07 Browser Extension

| Aspect | NIP-07 (nos2x-fox / Plebeian Signer) | NIP-46 (Amber) |
|--------|---------------------------------------|-----------------|
| Where key lives | Browser extension storage | Phone app |
| User interaction | Extension popup | Phone notification |
| Setup | Install extension + import key | Install app + import key + pair with browser |
| Multiple apps | Works on any site automatically | Each app pairs separately |
| Security | Key in browser = same attack surface as browser | Key on separate device = better isolation |
| Mobile support | Desktop only (extension) | Android native |
| Connection | Same device | Local network (phone ↔ browser) |

---

## Integration Options

### Option A: Amber/NIP-46 Integration

**What this means:** Add a NIP-46 client to the Continuum SPA so users can connect via Amber (or any NIP-46 signer) without needing a browser extension.

**Required changes:**
1. Add NIP-46 client library (nostr-tools already has NIP-46 support)
2. Add "Connect via Amber" button in the login modal
3. Bunker connection flow: QR code or paste `bunker://` URL → local WebSocket → phone signs → verify → session
4. Fall back to NIP-07 if no Amber connection available

**Estimated effort:** 3-5 days
**Pros:** Better security, no extension dependency, phone as canonical signing device
**Cons:** Android-only, phone must be on same network, NIP-46 still evolving, adds latency

### Option B: Multi-admin npub support (quick fix)

**What this means:** Change the agent to accept multiple admin npubs as an array instead of a single value.

**Required changes:**
1. `admin_npub: "npub1..."` → `admin_npubs: ["npub1...", "npub2..."]` in config
2. Update `auth.mjs` to iterate over the array for verification
3. Update `config.mjs` validation to accept both formats

**Estimated effort:** 1 hour
**Pros:** Trivial, unblocks user immediately, backward-compatible
**Cons:** Doesn't solve the extension-dependency problem for new users

### Option C: Direct nsec entry (most common Nostr pattern)

**What this means:** Add a "paste your nsec" option in the login flow. Users paste their nsec directly into the browser. The key stays in localStorage and signs events client-side — never sent to the server.

**Required changes:**
1. Add nsec input field in the login modal
2. Generate keys client-side and implement `window.nostr` in-app
3. Store encrypted key in localStorage (optional: PIN-protected)
4. Sign challenges using the stored key instead of NIP-07

**Estimated effort:** 1-2 days
**Pros:** Works without ANY extension, most Nostr apps do this (Snort, Coracle, etc.)
**Cons:** Key lives in browser JS context — defeats some of NIP-07's security isolation

---

## Recommendation

**Short-term (this week):** Option B — multi-admin npub support. Fix is trivial, unblocks the user immediately.

**Medium-term (next sprint):** Option A (Amber/NIP-46) + Option C (direct nsec entry). Many Nostr web apps support BOTH: paste nsec for convenience AND NIP-46 bunker for mobile signing. Let the user choose.

**Not recommended long-term:** NIP-07-only. Requiring a browser extension creates too much friction for new users. The extension should be the advanced option, not the only option.

---

## Code Changes for Option B (Quick Fix)

### Config change

```yaml
# config.yaml
# Before (single npub):
admin_npub: "npub1REPLACE..."

# After (array — accepts single npub too for b/c):
admin_npubs:
  - "npub1REPLACE_WITH_YOUR_NPUB"
```

The loader should accept BOTH `admin_npub` (string, legacy) and `admin_npubs` (array).

### Auth change (auth.mjs)

```javascript
// Before (line 46-52):
const decoded = nip19.decode(cfg.admin_npub);
if (decoded.type !== 'npub') throw new Error('not an npub');
adminHex = decoded.data;

// After:
const adminHexes = [];
if (Array.isArray(cfg.admin_npubs)) {
  for (const npub of cfg.admin_npubs) {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') throw new Error(`not an npub: ${npub}`);
    adminHexes.push(decoded.data);
  }
} else if (cfg.admin_npub) {
  const decoded = nip19.decode(cfg.admin_npub);
  adminHexes.push(decoded.data);
}
```

```javascript
// Before (verifyChallenge, line 74):
if (event.pubkey !== adminHex) return { ok: false, reason: 'pubkey is not admin npub' };

// After:
if (!adminHexes.includes(event.pubkey)) return { ok: false, reason: 'pubkey is not an admin npub' };
```

```javascript
// Before (verifySessionToken):
if (pk !== adminHex) return { ok: false, reason: 'not admin pubkey' };

// After:
if (!adminHexes.includes(pk)) return { ok: false, reason: 'not an admin pubkey' };
```

---

## Amber/NIP-46 Architecture (Option A)

```
┌──────────────┐     NIP-46 bunker      ┌──────────────┐
│  Continuum   │ ◄──── WebSocket ────►  │ Amber (Phone)│
│  SPA (browser)│                        │ (nsec stored)│
│              │     sign challenge      │              │
│  auth.js     │ ────► signEvent ────►  │ signEvent()  │
│              │ ◄─── signed event ◄──  │              │
└──────┬───────┘                        └──────────────┘
       │
       │ POST /api/auth/verify {event}
       ▼
┌──────────────┐
│  Agent (VPS) │
└──────────────┘
```

### Implementation steps
1. Add NIP-46 client — handles bunker connection, encryption, event signing. `nostr-tools` already supports `Nip46`.
2. Add Amber connection UI — text input for `bunker://` URL or QR code scanner
3. Modify `auth.js startLogin()` — add Amber path alongside NIP-07 path
4. Handle connection state — Amber may disconnect; show reconnection UI
5. Fallback logic — if no Amber and no NIP-07, show both options + direct nsec entry

### NIP-46 client example (pseudocode)

```javascript
import { Nip46 } from 'nostr-tools/nip46';

async function loginWithBunker(bunkerUrl) {
  const signer = new Nip46(bunkerUrl, {
    clientName: 'Continuum',
    clientUrl: window.location.origin,
  });
  await signer.init();

  const pubkey = await signer.getPublicKey();
  const challenge = await requestChallenge();
  const signed = await signer.signEvent({
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    content: challenge,
    tags: [['challenge', challenge], ['relay', window.location.origin]],
  });

  const verified = await verifyChallenge(signed);
  if (verified.ok) {
    // Session established
  }
}
```
