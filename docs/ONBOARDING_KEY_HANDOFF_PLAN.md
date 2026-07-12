# Continuum Onboarding: Key Generation & Handoff

**Date:** 2026-07-07  
**Status:** Design document  
**Problem:** First-time Continuum users need a Nostr keypair to log in, but requiring them to already have a browser signer extension + understand key management creates unacceptable friction.

---

## 1. Current State

```
User arrives with no Nostr setup
        │
        ▼
Must install nos2x-fox or Plebeian Signer
Must generate/manage their own Nostr keys
Must know their npub to configure agent
        │
        ▼
Login works, but setup is 3 steps with steep learning curve
```

The agent currently expects `admin_npub: "npub1..."` in config.yaml at boot. If it's the example placeholder, the agent refuses to start. This means the user must:
1. Know what a Nostr keypair is
2. Generate one (via extension or CLI)
3. Extract the npub and put it in config.yaml

This is a non-starter for non-technical users.

---

## 2. Design Goals

1. **Zero pre-requisites** — user needs only a browser and internet
2. **Ends with key sovereignty** — user controls their nsec in their own signer
3. **No permanent VPS key custody** — nsec on VPS is a temporary trust window, deleted after handoff
4. **Backward-compatible** — existing admin_npub config still works
5. **Amber-ready** — same onboarding can produce a bunker:// URL for NIP-46

---

## 3. Proposed Flows (Ranked by Security)

---

### A. VPS-Generated Entropy Handoff (User's Proposal)

**How it works:**

```
Deploy time (Ansible)
    │
    ├── Generate nsec from /dev/urandom (openssl rand -hex 32)
    ├── Derive npub from nsec (nostr-tools getPublicKey)
    ├── Write nsec to /opt/continuum/provisioning.key (mode 600)
    ├── Write npub to config.yaml admin_npub (temporary)
    └── Set provisioning.mode = "handoff" in config
    
First boot (agent)
    │
    ├── Agent sees provisioning.mode = "handoff"
    ├── Serves onboarding page at /onboard
    ├── Onboarding page shows nsec + import instructions
    │   ├── Text: "Copy this secret key into your signer"
    │   ├── QR code for Amber (bunker:// URL)
    │   └── "I've imported the key" button
    │
    └── User clicks "I've imported"
        │
        ├── Agent issues challenge
        ├── Browser signs with NIP-07 (user's extension now has key)
        ├── Agent verifies signature matches admin_npub
        ├── If match:
        │   ├── shred -u provisioning.key (secure delete)
        │   ├── Set provisioning.mode = "locked"
        │   ├── Issue session token
        │   └── Redirect to /#/projects
        └── If no match:
            └── Show error: "Key not imported correctly. Try again."
```

**Security tradeoffs:**

| Dimension | Assessment | Severity |
|-----------|-----------|----------|
| **Trust window** | nsec exists on VPS from deploy until handoff completes | Medium |
| **Proof of deletion** | None — user can't verify shred actually ran | High |
| **Network tx** | nsec transmitted over HTTPS to browser | Low-Medium |
| **Logs** | nsec could appear in server/nginx logs if request is logged | High |
| **Memory exposure** | nsec in VPS RAM during generation + serving | Low (requires kernel exploit) |
| **VPS compromise** | If VPS compromised during window, attacker has key permanently | Critical |
| **Key rotation** | User must re-run entire provisioning to rotate key | High |
| **Backup** | User has the nsec in their extension, but may not have a backup copy | Medium |
| **UX friction** | User must copy nsec manually (12+ words or 64 hex chars) | Medium |

**Mitigations:**
1. Never log the /onboard response body or provisioning.key contents
2. Use `response.setHeader('Cache-Control', 'no-store')` on the onboarding page
3. Generate key at deploy time, not at agent boot (Ansible handles it, agent only reads)
4. Use `/dev/urandom` via `openssl` for proper entropy
5. After handoff, restart agent to clear any in-memory copy
6. Display nsec as **BIP39 mnemonic phrase** (12 words) instead of hex — easier to copy

**Critical unsolved problem:** Trust. The user must take the VPS operator's word that the key was deleted. There is no cryptographic proof of deletion. A malicious VPS could copy the nsec before "deleting" it and retain the ability to impersonate the user forever.

---

### B. Browser-Generated Key (Recommended)

**How it works:**

```
User opens Continuum for first time
        │
        ├── Agent detects admin_npub is empty → redirect to /onboard
        │
        ▼
Browser loads onboarding page + runs JavaScript
        │
        ├── crypto.getRandomValues() generates 32 bytes → nsec
        ├── nostr-tools derives npub + pk
        │
        ▼
Page displays:
  ┌─────────────────────────────────────┐
  │ Welcome to Continuum                 │
  │                                      │
  │ Your new Nostr identity:             │
  │                                      │
  │ [BIP39 Mnemonic: 12 words]          │
  │ ┌───────────────────────────────┐   │
  │ │ abandon ability able ...      │   │
  │ └───────────────────────────────┘   │
  │                                      │
  │ [Download encrypted backup]         │
  │ [Copy nsec to clipboard]            │
  │                                      │
  │ Step 2: Import into your signer     │
  │ [Install nos2x-fox (Firefox)]       │
  │ [Install Amber (Android)]           │
  │                                      │
  │ Step 3: [✓ I've imported the key]   │
  └─────────────────────────────────────┘
        │
        ├── User backs up mnemonic
        ├── User imports key into extension
        ├── User clicks "Verify"
        │
        ▼
Browser sends ONLY npub to agent:
  POST /api/provision/register { npub }
        │
        ├── Agent stores npub in admin_npub
        ├── Agent locks provisioning mode
        │
        ▼
Standard login flow:
  Challenge → sign with NIP-07 → verify → session
```

**Security tradeoffs:**

| Dimension | Assessment |
|-----------|-----------|
| **Trust window** | Zero — nsec never leaves the browser |
| **Proof of deletion** | Not needed — VPS never had the key |
| **Network tx** | Only npub transmitted (public by design) |
| **Logs** | Only npub in logs — acceptable (it's public) |
| **Memory exposure** | nsec only in browser memory |
| **VPS compromise** | Attacker gets npub (public), cannot impersonate |
| **Key rotation** | Same as any key: user generates new one, updates config |
| **Backup** | User has mnemonic + browser extension |
| **UX friction** | Medium — user must still copy nsec and import manually |
| **Sovereignty** | Key generated on user's device from user's entropy |

**Advantages over approach A:**
1. No trust window — VPS never sees the nsec at any point
2. No proof-of-deletion problem — nothing to prove
3. No transmission of secret over network
4. No risk of VPS compromise leaking the key
5. User's browser generates entropy from its own CSPRNG (same as every Bitcoin wallet)

**Disadvantages:**
1. User must still manually copy nsec into extension (12 words is better than 64 hex chars)
2. If user closes the page before backing up, key is lost (same as any wallet)
3. Browser CSPRNG quality depends on the browser (all modern browsers are fine here)

---

### C. Amber / NIP-46 Phone-Generated (Most Sovereign)

**How it works:**

```
User opens Continuum for first time
        │
        ├── Agent detects unprovisioned → redirect to /onboard
        │
        ▼
Onboarding page offers Amber option:
  ┌─────────────────────────────────────┐
  │ Connect with Amber                   │
  │                                      │
  │ 1. Install Amber on your phone       │
  │ 2. Open Amber → "Add account"        │
  │ 3. Scan this QR code:                │
  │    ┌───────────────────────────┐    │
  │    │ [QR: bunker://...]       │    │
  │    └───────────────────────────┘    │
  │    Or paste this URL:               │
  │    bunker://npub1...?relay=...      │
  │                                      │
  │    [✓ Connected! Waiting for you to  │
  │     approve from your phone...]      │
  └─────────────────────────────────────┘
        │
        ├── User opens Amber on phone
        ├── Amber generates keypair on phone (nsec stays on phone)
        ├── Amber connects to Continuum via NIP-46
        ├── Continuum requests public key
        ├── Amber sends npub
        │
        ├── Continuum registers npub with agent
        ├── Challenge → Amber signs on phone → verify → session
        │
        ▼
        Agent stores npub, locks provisioning
        Key never existed on VPS or in browser
```

**Security tradeoffs:**

| Dimension | Assessment |
|-----------|-----------|
| **Trust window** | Zero — key never leaves the phone |
| **Network tx** | Only npub transmitted |
| **VPS compromise** | Attacker gets npub only |
| **Phone compromise** | Key on separate device, better isolation |
| **UX friction** | Medium — needs Amber installed + phone nearby |
| **Mobile support** | Android only for Amber |

---

### D. Hybrid Approach (All Three)

Let the user choose at onboarding time:

```
Onboarding page:
  ┌─────────────────────────────────────┐
  │ Welcome to Continuum                 │
  │                                      │
  │ How would you like to set up?        │
  │                                      │
  │ [A] Generate a new key in this       │
  │     browser  (fastest, recommended)  │
  │                                      │
  │ [B] Connect via Amber on your phone  │
  │     (most secure, Android only)      │
  │                                      │
  │ [C] I already have a signer          │
  │     (advanced: paste your npub)      │
  │                                      │
  │ [D] I'll set up later (demo mode)    │
  └─────────────────────────────────────┘
```

Each option leads to the appropriate flow above.

---

## 4. Implementation Plan

### Phase 1: Agent Provisioning Mode

**Files to modify:**
- `agent/core/config.mjs` — add `provisioning.mode` config option
- `agent/core/auth.mjs` — add provisioning endpoint, accept registration
- `agent/index.mjs` — add `/api/provision/*` routes, provisioning check

**Config changes:**
```yaml
# config.yaml additions
provisioning:
  mode: "handoff"    # "handoff" | "register" | "locked" | "disabled"
  # mode=handoff: VPS generates key (approach A)
  # mode=register: browser-generated key (approach B)
  # mode=locked: provisioning complete, reject all /api/provision/* calls
  # mode=disabled: legacy mode, admin_npub must be set at boot
```

**New agent endpoints:**
```
GET  /api/provision/status
  → { mode: "handoff"|"register"|"locked"|"disabled", npub: "..."|null }

POST /api/provision/register
  body: { npub: "npub1..." }
  → Agent stores npub to config.yaml
  → Agent transitions to mode=pending_verification
  → { ok: true }

POST /api/provision/verify
  body: { event: signedNip42Event }
  → Same as auth verify, but for provisioning
  → On success: writes npub to config permanently, sets mode=locked
  → On failure: { ok: false, reason: "..." }
```

**Provisioning state machine:**
```
UNINITIALIZED ──(register npub)──> PENDING_VERIFICATION
       │                                  │
       │ (user navigates to                │ (first successful login)
       │  /onboard)                        ▼
       │                              LOCKED (provisioning complete)
       ▼
  Serve onboarding page
```

### Phase 2: Onboarding Page

**New file:** `src/views/onboard.js`

The onboarding page needs:
1. **Generate key section** (approach B):
   ```javascript
   import { generateSecretKey, getPublicKey, nip19, mnemonic } from 'nostr-tools';
   
   const sk = generateSecretKey(); // crypto.getRandomValues
   const pk = getPublicKey(sk);
   const npub = nip19.npubEncode(pk);
   const nsec = nip19.nsecEncode(sk);
   const words = mnemonic.encode(sk); // BIP39 12 words
   ```

2. **Display section**: 
   - BIP39 mnemonic (12 words, large readable font)
   - "Copy to clipboard" button
   - "Download encrypted backup" (encrypt with password)
   - npub for reference

3. **Import instructions**:
   - nos2x-fox: Settings → "Import key" → paste nsec
   - Plebeian Signer: Add account → Import
   - Amber: QR code (bunker:// URL)

4. **Verify button**: triggers standard NIP-42 challenge flow

5. **Already-have-key option**:
   - npub input field
   - "I'll set up the signer myself, just register my npub"

### Phase 3: Amber/NIP-46 Connection (separate phase)

**New dependency:** `nostr-tools/nip46`

The onboard page would:
1. Generate a bunker:// URL from the agent
2. Show as QR code
3. User scans with Amber
4. NIP-46 WebSocket connection established
5. Amber signs challenges from the phone

This is the same NIP-46 flow already documented in `AMBER_NIP46_INTEGRATION.md`.

### Phase 4: Ansible Deploy Changes

**Modify `ansible/roles/identity/`** to support provisioning mode:

```yaml
# ansible/roles/identity/tasks/main.yml additions
- name: Generate provisioning keypair
  command: >
    node -e "
      const {generateSecretKey,getPublicKey,nip19} = require('nostr-tools');
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);
      const npub = nip19.npubEncode(pk);
      const nsec = nip19.nsecEncode(sk);
      console.log(JSON.stringify({nsec,npub}));
    "
  register: provisioning_keypair
  when: continuum_provisioning_mode == 'handoff'

- name: Write provisioning key
  copy:
    content: "{{ provisioning_keypair.stdout.nsec }}"
    dest: /opt/continuum/provisioning.key
    mode: '0600'
    owner: continuum
  when: continuum_provisioning_mode == 'handoff'

- name: Set initial admin_npub
  lineinfile:
    path: /opt/continuum/config.yaml
    regexp: '^admin_npub:'
    line: "admin_npub: \"{{ provisioning_keypair.stdout.npub }}\""
  when: continuum_provisioning_mode == 'handoff'
```

---

## 5. Tradeoff Summary

| | A: VPS-Generated | B: Browser-Generated | C: Amber/NIP-46 |
|---|---|---|---|
| **Key location at all times** | VPS → browser → extension | Browser only → extension | Phone only |
| **Trust window** | Minutes/hours | Zero | Zero |
| **Proof of deletion** | Impossible | Not needed | Not needed |
| **Network secret tx** | Yes (nsec over HTTPS) | No (only npub) | No (only npub) |
| **Log exposure risk** | Critical | None | None |
| **VPS compromise impact** | Permanent key theft | npub only | npub only |
| **UX friction** | Low (copy nsec) | Low (copy nsec) | Medium (phone needed) |
| **Backup** | User must save manually | User must save manually | On phone |
| **Key rotation** | Re-provision | Re-generate browser-side | Re-generate on phone |
| **Implementation** | 1-2 days | 1-2 days | 3-5 days |
| **Sovereignty** | Low (VPS entropy) | High (browser entropy) | Highest (phone entropy) |

---

## 6. Recommendation

**Implement approach B (Browser-Generated) as the primary flow.**

Rationale:
1. Zero trust window — VPS never holds the key at any point
2. No proof-of-deletion problem (the hard unsolved problem in approach A)
3. Same UX as approach A — user sees mnemonic, copies it, imports into extension
4. Key generated from user's own browser CSPRNG (same as any Bitcoin/crypto wallet)
5. Future Amber support adds approach C as an option, not a replacement

Approach A (VPS-generated handoff) has one unsolvable problem: **the user can never verify the VPS actually deleted the key**. A malicious VPS can claim deletion while retaining the nsec, and the user has no way to detect this. For a "sovereignty-first" product like Continuum, this contradicts the brand promise.

**Implementation order:**
1. Agent provisioning mode + endpoints (Phase 1, 2 days)
2. Onboarding page with browser key generation (Phase 2, 2 days)
3. Amber/NIP-46 QR code option (Phase 3, 3-5 days later)
4. Ansible deploy automation (Phase 4, 1 day)

---

## 7. Open Questions

1. **Should the onboarding page require the user to pass a "backup test"?** (e.g. re-enter words 3, 7, and 11 to prove they saved the mnemonic)
   - Pro: Prevents user from closing the page without backup
   - Con: Adds friction to a flow that's supposed to be welcoming

2. **Should the agent allow multiple admin npubs?** (from `AMBER_NIP46_INTEGRATION.md` Option B)
   - This is independent of provisioning — multi-admin is useful regardless
   - The provisioning flow just writes the first npub; others can be added via the config file

3. **Demo mode vs provisioning:** When should the agent allow skipping provisioning?
   - If provisioning fails or user chooses "set up later," the agent should still serve the SPA
   - Chat, wallet, and Routstr return "unconfigured" until provisioning completes

4. **What happens if the user loses their key after provisioning?**
   - Same as any Nostr app: they need to regenerate via a VPS operator action
   - The provisioning flow can be re-run by the VPS operator (with `continuum-provisioning-reset` ansible command)

5. **Encrypted backup:** Should the onboarding page offer to encrypt the nsec with a password and download as a file?
   - Good UX for non-technical users
   - Implement with Web Crypto API (AES-GCM with PBKDF2 key derivation)
   - The encrypted file can be re-imported later
