# Bootstrap Signer Onboarding — Key Custody Handover for Continuum

**Goal:** Allow a first-time user to log into Continuum with zero setup (no browser extension), receive the generated nsec, import it into their own signer, and have the server delete its copy so the user has sole custody.

**Context:** Continuum currently requires a browser extension (nos2x-fox, Plebeian Signer) and a pre-configured nsec. Setting this up is bad UX — the user must install an extension, generate/import a key, and configure it before they can even try the app. The bootstrap flow eliminates this friction.

---

## 1. The Bootstrap Flow (User's Perspective)

```
Step 1                  Step 2                 Step 3                   Step 4                  Step 5
┌─────────┐             ┌─────────┐            ┌─────────┐              ┌─────────┐             ┌─────────┐
│ Click   │             │ "Create │            │ Save    │              │ Import  │             │ Login   │
│ Login   │ ──────────► │ My      │ ──────────►│ Your    │ ────────────►│ into    │ ────────────►│ with    │
│         │             │ Identity│            │ Key!    │              │ Signer  │             │ Signer  │
│ no ext  │             │ "       │            │ (1-time)│              │         │             │         │
└─────────┘             └─────────┘            └─────────┘              └─────────┘             └─────────┘
                                                      │                       │                       │
                                                 Server generates        User saves nsec         User signs challenge
                                                 keypair, stores         in extension,            from extension,
                                                 temporarily in          returns to               agent verifies,
                                                 memory                  Continuum                 agent deletes key
```

### Detailed Walkthrough

**Step 1 — First Visit:**
- User arrives at Continuum. No `window.nostr` detected.
- Login button is visible. User clicks it.
- Normally: "Signer not found" modal with "install a browser extension" message.
- **NEW**: A third button appears: "Create my identity (no signer needed)"

**Step 2 — Key Generation:**
- User clicks "Create my identity"
- Agent generates a fresh Nostr keypair (nsec + npub)
- Key lives **only in server memory** (RAM) — never written to disk, never in logs
- Set a TTL: 15 minutes. If not claimed within 15 min, key is wiped.
- Returns npub to frontend

**Step 3 — One-Time Key Display:**
- Full-screen overlay with:
  - 🟡 **Your nsec (secret key):** `nsec1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
  - ⚠️ **This is the ONLY time you'll see this key. Save it now.**
  - Three actions:
    1. **Copy to clipboard** (nsec + npub together, formatted)
    2. **Download as encrypted JSON** (password-protected with AES-GCM — user chooses password)
    3. **Show as QR code** (for Amber/mobile import)
  - A checkbox: "I have saved my key securely"
  - Button: "Continue" (disabled until checkbox is checked)

**Step 4 — User Imports Key:**
- User opens their browser signer (nos2x-fox, Plebeian Signer)
- Pastes or imports the nsec
- Returns to Continuum tab

**Step 5 — Prove Custody:**
- User clicks "Login" button again
- This time, `window.nostr` IS available (extension now has the key)
- Normal NIP-07 login flow executes:
  - Agent sends challenge
  - Extension signs it
  - Agent verifies signature
- **Agent checks**: does this pubkey match the one we generated in Step 2?
  - YES → signature is valid AND pubkey matches → user has proven custody
  - Agent marks the key as "claimed + migrated"
  - **Agent deletes the nsec from memory** → user now has sole custody
  - Session token issued, user is logged in
  - NO → signature doesn't match → reject

**After Migration:**
- Every subsequent login uses the normal NIP-07 flow
- The server has no copy of the nsec
- The user's key is only in their browser extension

---

## 2. Two Architecture Options

### Option A: Direct Key Handover (No NIP-46 Bunker)

Simplest path. No WebSocket, no NIP-46 protocol complexity.

**Architecture:**
```
┌──────────────────────┐      REST API           ┌──────────────────┐
│  Continuum SPA       │ ─────────────────────►   │  Agent (Go)      │
│                      │ POST /auth/bootstrap     │                  │
│  1. Show key to user │     generate             │  generateKey()   │
│  2. User saves it    │ ◄── { npub, nsec } ──   │  storeInMemory() │
│  3. User imports     │                         │  TTL=15min       │
│  4. Login via NIP-07 │ POST /auth/challenge     │  verifyAndDelete()│
│     (normal flow)    │ ──► sign via ext ◄──    │                  │
└──────────────────────┘                         └──────────────────┘
```

**Changes needed:**
- Agent: 1 new endpoint (`POST /api/auth/bootstrap`), ~50 lines
- Frontend: 1 new Svelte component (key display view), ~100 lines
- Frontend: modify `auth.js` bootstrap flow, ~30 lines
- **No NIP-46 implementation needed**

**Pros:**
- Simple: 1 REST endpoint + 1 component
- No WebSocket complexity
- No NIP-46 protocol implementation
- Key never leaves the server until user explicitly sees it
- Minimal attack surface

**Cons:**
- User cannot login WITHOUT importing into extension first
  - They must have a NIP-07 extension installed at import time
  - If they don't want an extension, this doesn't help
- Key display is a one-time event — if they close the tab before saving, key is lost
- The "install extension" step is still required (just later in the flow)

### Option B: Temporary NIP-46 Bunker (Login First, Migrate Later)

A temporary NIP-46 WebSocket bunker lets the user login IMMEDIATELY after key generation, without any extension. The migration to NIP-07 happens in the background.

**Architecture:**
```
Phase 1: Bootstrapping (no extension needed)
┌──────────────┐  WebSocket (NIP-46)   ┌──────────────────┐
│  Continuum   │ ◄──────────────────►  │  Agent Bunker     │
│  SPA         │   signEvent()         │                   │
│              │   getPublicKey()      │  temp_key in mem   │
└──────────────┘                       └──────────────────┘
        │ User can USE Continuum immediately
        │
        ▼
Phase 2: Key migration
┌──────────────┐                       ┌──────────────────┐
│ User installs │  Imports nsec        │  Agent            │
│ extension     │ ──────────────────►  │                   │
│               │  Signs challenge     │  verifies custody │
│ NIP-07 now   │  from extension       │  deletes temp_key│
└──────────────┘                       └──────────────────┘

Phase 3: Normal NIP-07 (permanent)
┌──────────────┐  POST /auth/verify    ┌──────────────────┐
│  Extension    │ ──────────────────►   │  Agent            │
│  signs        │                      │  normal verify     │
│  everything   │                      │  no temp key       │
└──────────────┘                       └──────────────────┘
```

**Changes needed:**
- Agent: NIP-46 WebSocket endpoint (`/api/nip46`), ~200 lines
- Agent: key lifecycle management (generate, TTL, custody check, delete), ~100 lines
- Frontend: NIP-46 WebSocket client in `agent.js`, ~80 lines
- Frontend: key display UI, ~100 lines
- Frontend: migration prompt (banner: "Claim your key!"), ~50 lines

**Pros:**
- **Zero setup:** User can use Continuum immediately after clicking "Create my identity"
- Key migration is asynchronous — user can do it when convenient
- Migration prompt can reappear ("You haven't claimed your key yet!")
- Best UX for first-time users
- The bunker is temporary per-key (not a permanent service)

**Cons:**
- More complex: NIP-46 WebSocket, encryption, key lifecycle
- Larger code surface for a bootstrap feature
- During Phase 1, the server holds the key AND is actively using it to sign
- The user might never migrate (key stays on server indefinitely)

---

## 3. Tradeoffs Analysis

### Security Tradeoffs

| Concern | Option A (Direct) | Option B (Bunker) | Mitigation |
|---------|-------------------|--------------------|-----------|
| Key exposed on server | Yes, 15 min TTL | Yes, until migrated | In-memory only, never on disk |
| VPS compromise during window | Attacker gets key | Attacker gets key + can sign | Short window, user trusts operator |
| Key in logs | Never log nsec | Never log nsec | Sanitize all log output |
| Key recovery after deletion | User's responsibility | User's responsibility | Encrypted download option |
| Server signing without user knowledge | N/A (no bunker) | Possible during Phase 1 | Audit log, user can force-delete bunker key |
| Clipboard/QR code interception | Possible during display | Same | Encrypted download is safer |
| Backup compromise | Key never persisted | Key never persisted | TTL ensures automatic cleanup |

**Key insight about trust:** The user is already trusting the VPS operator (who deployed Continuum) with their data. A short-lived signing key is a reasonable extension of that trust. The migration closes the window permanently.

### UX Tradeoffs

| Aspect | Option A (Direct) | Option B (Bunker) |
|--------|-------------------|--------------------|
| First login speed | ~30s (generate + save + import) | Instant (click → logged in) |
| Browser extension needed | Yes (before first login) | No (install whenever convenient) |
| Cognitive load at first visit | Medium (key management) | Low (just use the app) |
| Migration UX | Must do before using app | Prompted later ("Claim your key") |
| Risk of key loss | High (one-time display) | Lower (can re-display from bunker) |
| User education needed | "Save this key!" warning | "Claim your key for security" prompt |
| Non-technical users | Might be intimidated by nsec | Can defer migration indefinitely |

### Complexity Tradeoffs

| Aspect | Option A (Direct) | Option B (Bunker) |
|--------|-------------------|--------------------|
| New endpoints | 1 REST endpoint | 1 WebSocket + lifecycle |
| Lines of code | ~200 total | ~500 total |
| NIP-46 protocol | Not needed | Must implement (or use library) |
| Testing effort | 2-3 hours | 6-8 hours |
| Long-term maintenance | Nearly zero | Bunker code must be maintained |
| Failure modes | Few (TTL expiry, user loses key) | More (WebSocket disconnect, encryption errors) |

---

## 4. Recommended Approach: Hybrid (Option B Skeleton + Option A Simplicity)

**Core insight:** The user wants the key migrated off the VPS. The NIP-46 bunker is a temporary bootstrap tool, not a permanent signer. We can get 90% of the value with Option A's simplicity.

**Recommendation: Do Option A (Direct) first, add bunker later if needed.**

Rationale:
- 200 lines vs 500 lines to achieve the same end state (user has key, server doesn't)
- The "login immediately" value of the bunker is real, but the user specifically wants key custody
- A direct handover + extension import is a well-understood pattern (every crypto wallet does this)
- The bunker can be added in Phase 2 as an optimization

### If we choose Option A

The flow is clean:
1. Click "Create my identity"
2. Server generates key
3. One-time display (with encrypted download as safety net)
4. User imports into extension
5. Login via NIP-07 (already working)
6. Server deletes key on successful verification

### If we want the best possible UX (Option B)

The flow is:
1. Click "Create my identity"
2. Server generates key, starts temporary NIP-46 bunker
3. User is immediately logged in via bunker
4. User can use Continuum right away
5. Persistent banner: "🔑 Claim your key — download your nsec so your key is yours"
6. User clicks, sees key, imports into extension
7. On next login, NIP-07 is used, bunker deletes key for that user

---

## 5. Key Design Decisions

### 5.1 Key Storage: In-Memory Only

**Never write the generated nsec to disk.** Not to a file, not to a database, not to a config. The nsec lives in a Go `map[string][]byte` in the agent process.

```go
// In-memory key store
var pendingKeys = sync.Map{} // npub_hex → { nsec: []byte, expiresAt: time.Time }
```

If the agent restarts, ALL pending keys are lost. This is intentional:
- A restart during the bootstrap window means the user must start over
- Better than having stale keys lying around on disk
- The user hasn't proven custody yet, so nothing is lost (they haven't done anything yet)

### 5.2 TTL: 15 Minutes

Keys expire after 15 minutes. A background goroutine sweeps expired keys every 60 seconds:
- After 15 min: key is deleted from memory
- User sees: "Your bootstrap session has expired. Please click 'Create my identity' again."

### 5.3 Encrypted Download

The one-time display is the primary channel, but the encrypted download is a safety net:
- User chooses a password (displayed as a strength meter)
- nsec is encrypted with AES-256-GCM, password-derived key (PBKDF2, 100k iterations)
- Downloaded as `continuum-identity-<npub-prefix>.json`
- Format: `{ "npub": "...", "nsec_encrypted": "<base64>", "salt": "<base64>", "iv": "<base64>" }`
- Server never sees the password — encryption happens client-side in JS

### 5.4 Verification = Normal Login

The "prove custody" step IS the login flow. We don't need a separate verification endpoint:
1. User imports key into extension
2. User clicks "Login"
3. `startLogin()` → `requestChallenge()` → extension signs → `verifyChallenge()`
4. Agent receives the signed event, checks the pubkey
5. If pubkey matches a pending key: delete the pending key, issue session token
6. If pubkey matches a known admin (not pending): normal login
7. If pubkey doesn't match: reject

### 5.5 Multi-Key Support

The agent should support multiple pending keys (one per browser session). The `sync.Map` handles concurrent access naturally. Each key is identified by its npub hex.

---

## 6. Implementation Plan (Option A — Direct)

### Phase 1: Agent Changes

**Task A1: Add in-memory key store**

File: `agent/services/bootstrap.mjs` (NEW)

```javascript
// agent/services/bootstrap.mjs
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';

const pendingKeys = new Map(); // hex_pubkey → { nsec_hex, expiresAt }
const TTL_MS = 15 * 60 * 1000; // 15 minutes
const SWEEP_INTERVAL_MS = 60 * 1000;

// Background sweep
setInterval(() => {
  const now = Date.now();
  for (const [pubkey, entry] of pendingKeys) {
    if (entry.expiresAt <= now) {
      pendingKeys.delete(pubkey);
    }
  }
}, SWEEP_INTERVAL_MS);

export function generatePendingKey() {
  const sk = generateSecretKey();
  const hex = bytesToHex(sk);
  const pubkey = getPublicKey(sk);
  
  const entry = {
    nsecHex: hex,
    nsecBech32: nsecFromHex(hex),
    npub: npubFromHex(pubkey),
    expiresAt: Date.now() + TTL_MS,
  };
  
  pendingKeys.set(pubkey, entry);
  return entry;
}

export function claimAndDelete(pubkeyHex) {
  const entry = pendingKeys.get(pubkeyHex);
  if (!entry) return false;
  pendingKeys.delete(pubkeyHex);
  return true;
}

export function isPendingKey(pubkeyHex) {
  return pendingKeys.has(pubkeyHex);
}
```

**Task A2: Add bootstrap endpoint**

File: `agent/routes/auth.mjs` (MODIFY)

```javascript
// New endpoint: POST /api/auth/bootstrap
router.post('/api/auth/bootstrap', async (req, reply) => {
  const key = generatePendingKey();
  return {
    ok: true,
    npub: key.npub,
    nsec: key.nsecBech32,  // ONE-TIME delivery
  };
});
```

**Key security: The nsec is returned ONCE in the HTTP response.**
- The frontend MUST render and immediately discard it
- The browser does NOT store it (no localStorage, no sessionStorage)
- If the user refreshes the page, the nsec is gone — they must use the encrypted download or regenerate

**Task A3: Modify verifyChallenge for pending keys**

File: `agent/routes/auth.mjs` (MODIFY)

```javascript
// In verifyChallenge handler:
const pubkey = event.pubkey;

// Check if this is a pending bootstrap key
if (isPendingKey(pubkey)) {
  claimAndDelete(pubkey); // Delete our copy — user has proved custody
  // Continue with session token generation (same as normal login)
  const token = generateSessionToken(pubkey);
  return { ok: true, token };
}

// Existing admin check
const adminHexes = cfg.admin_npubs.map(npub => ...);
if (!adminHexes.includes(pubkey)) {
  return { ok: false, reason: 'pubkey is not an admin npub' };
}
```

### Phase 2: Frontend Changes

**Task B1: Add key display component**

File: `src/views/BootstrapKey.svelte` (NEW)

```svelte
<script>
  import { onMount } from 'svelte';
  import { bootstrapGenerate } from '../data/agent.js';
  
  let step = 'generating'; // generating | display | imported
  let npub = '';
  let nsec = '';
  let savedCheckbox = false;
  let error = '';
  
  onMount(async () => {
    try {
      const result = await bootstrapGenerate();
      if (result.ok) {
        npub = result.npub;
        nsec = result.nsec;
        step = 'display';
      } else {
        error = result.reason;
      }
    } catch (e) {
      error = e.message;
    }
  });
  
  function copyKey() {
    navigator.clipboard.writeText(`nsec: ${nsec}\nnpub: ${npub}`);
  }
  
  function downloadEncrypted() {
    // Client-side AES-GCM encryption with user-chosen password
    // ... (implement client-side encryption)
  }
  
  function proceed() {
    step = 'imported';
    // Clear nsec from memory immediately
    nsec = '';
  }
</script>

<div class="bootstrap-overlay">
  {#if step === 'generating'}
    <p>Generating your Nostr identity...</p>
  {:else if step === 'display'}
    <div class="warning-banner">
      ⚠️ SAVE THIS KEY NOW. It will never be displayed again.
    </div>
    
    <div class="key-display">
      <label>Your Secret Key (nsec)</label>
      <code class="nsec">{nsec}</code>
      <button on:click={copyKey}>📋 Copy</button>
    </div>
    
    <div class="key-display">
      <label>Your Public Key (npub — share freely)</label>
      <code>{npub}</code>
    </div>
    
    <div class="actions">
      <button on:click={downloadEncrypted}>🔒 Download Encrypted Backup</button>
    </div>
    
    <label class="checkbox">
      <input type="checkbox" bind:checked={savedCheckbox} />
      I have saved my secret key in a safe place
    </label>
    
    <button disabled={!savedCheckbox} on:click={proceed}>
      I've saved my key — Continue
    </button>
  {:else if step === 'imported'}
    <p>Now import your key into your browser signer, then click Login.</p>
    <p>Your key has been deleted from the server.</p>
    <button on:click={() => window.location.reload()}>Go to Login</button>
  {/if}
</div>
```

**Task B2: Add bootstrapGenerate to agent.js**

File: `src/data/agent.js` (MODIFY)

```javascript
// Add:
export async function bootstrapGenerate() {
  return req('POST', '/api/auth/bootstrap');
}
```

**Task B3: Modify signer-not-found modal**

File: `src/auth.js` (MODIFY)

In the signer-not-found modal, add a third option alongside the existing extension links:
```javascript
// In the "no NIP-07 signer" handler:
{
  label: "Create my identity",
  description: "The server generates a key for you. You save it, server deletes it.",
  action: () => showBootstrapFlow()
}
```

### Phase 3: Verification & Testing

**Task C1: Agent tests**

File: `agent/test/bootstrap.test.mjs` (NEW)

```javascript
// Test: key generation
// Test: TTL expiry
// Test: claimAndDelete after verify
// Test: double-claim fails
// Test: concurrent key generation
```

**Task C2: Playwright tests**

File: `tests/playwright/bootstrap.spec.ts` (NEW)

- Test: "Create my identity" button appears when no NIP-07
- Test: Key display shows nsec and npub
- Test: Copy to clipboard works
- Test: Encrypted download works
- Test: After checkbox + continue, login button shows
- Test: Full flow (generate → show → import mock → login via NIP-07 stub)

**Task C3: Security tests**

- Test: nsec is NOT in localStorage or sessionStorage after display
- Test: nsec is NOT in agent logs
- Test: TTL expiry removes key
- Test: Agent restart removes ALL pending keys
- Test: Same nsec cannot be used to login twice (claim is one-time)

---

## 7. Edge Cases & Failure Modes

### User closes tab during key display
- **Problem:** User never saved the key. Server still has it (until TTL expires).
- **Fix:** User clicks "Create my identity" again → new key is generated → old key is orphaned (TTL cleans it up). User loses the old key, but there was nothing on it.

### User saves key but never imports into extension
- **Problem:** Key is pending in server memory, user has it saved but never completes the flow.
- **Fix:** TTL (15 min) cleans up the pending key. User must regenerate. They have their saved copy, so they can import at any time — but the server-side pending key is gone after TTL. They still prove custody on first NIP-07 login.

### User imports key AFTER server-side TTL expired
- **Scenario:** Server generated key at T+0, user saved it, but came back at T+30min.
- **Behavior:** The pending key in server memory is gone (TTL cleanup). User imports into extension, clicks Login.
- **Agent sees:** A valid signature from an unknown pubkey. Not in admin list, not in pending keys.
- **Result:** "pubkey is not an admin npub" error.
- **Fix:** The agent needs to accept a signature from ANY pubkey that matches a key it generated — even if the TTL expired. We should keep the pubkey (NOT the nsec) indefinitely in an "allowed" set.

**Design change:** Store only the pubkey (not the nsec) in a persistent "generated once" set:
```javascript
const generatedPubkeys = new Set(); // pubkeys the server created, persisted
```
This way even after TTL, the user can still claim their key. The nsec is only in memory for 15 min; the pubkey is persisted forever. Once claimed, the pubkey is removed from the set.

### User loses their saved key
- **Problem:** One-time display, user didn't download encrypted backup.
- **Fix:** They must generate a new identity. The old one is orphaned. If they hadn't claimed it yet, it's harmless. If they HAD claimed it (verified custody), the server deleted it — user is locked out. They'd need to generate a new identity and the admin would need to add the new npub to the admin list.

### Multiple users bootstrap simultaneously
- **Problem:** Two browser sessions each generate keys.
- **Fix:** Keys are per-session, identified by pubkey. The `sync.Map` handles concurrent access. Each key is independent.

### Man-in-the-middle intercepts the HTTP response with the nsec
- **Problem:** The nsec is transmitted over HTTPS in the API response.
- **Fix:** This IS encrypted by TLS. The same channel carries the session token in normal login. Standard web security applies.

### User never migrates (Option B only)
- **Problem:** Key stays on server indefinitely. If the VPS is compromised, attacker can sign as the user.
- **Fix:** 
  - Aggressive migration prompting ("Your key is still on the server")
  - Optional auto-migration deadline (server forces migration after 30 days)
  - Audit log shows when server-side signing was used

---

## 8. Summary: Recommended First Step

**Do Phase 1 (Option A) first — Direct Key Handover.**

Why:
- 200 lines of code
- No NIP-46 complexity
- Achieves the core goal: user gets key, server deletes key
- The "Create my identity" flow is intuitive (every crypto wallet does this)
- Can add NIP-46 bunker in Phase 2 if users want "login immediately" convenience

**Key architectural decision:** Keep a persistent set of "server-generated pubkeys" (no nsecs, just pubkeys) so users can claim their key even after the in-memory TTL expires. The nsec itself is never persisted.

**Total effort:** ~4-6 hours for implementation, ~2 hours for testing.

---

## 9. Files Changed Summary

| File | Change | Effort |
|------|--------|--------|
| `agent/services/bootstrap.mjs` | NEW — key generation, pending store, TTL sweep | 1h |
| `agent/routes/auth.mjs` | MODIFY — add bootstrap endpoint + modify verify for pending keys | 1h |
| `agent/config.example.yaml` | MODIFY — add `bootstrap_enabled: true` (toggle) | 5min |
| `src/data/agent.js` | MODIFY — add `bootstrapGenerate()` | 15min |
| `src/views/BootstrapKey.svelte` | NEW — key display component | 1h |
| `src/auth.js` | MODIFY — add "Create my identity" button in signer modal | 30min |
| `src/router.js` | MODIFY — add route for bootstrap view | 15min |
| `agent/test/bootstrap.test.mjs` | NEW — unit tests | 1h |
| `tests/playwright/bootstrap.spec.ts` | NEW — Playwright tests | 1h |
| `docs/BOOTSTRAP_SIGNER_PLAN.md` | NEW — this document | Done |
