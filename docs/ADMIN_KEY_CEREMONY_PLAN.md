# Admin Key Ceremony — Onboarding Plan

**Problem:** The agent is deployed with a randomly-generated `admin_npub`/`nsec` that the user doesn't have in their browser signer. The user gets "pubkey is not admin npub" on login.

**Goal:** Design an onboarding flow where the VPS-generated signing key is handed to the user securely, validated, then deleted from the VPS — leaving only the user's browser signer as the canonical key holder.

---

## Current Architecture

```
┌─────────────┐                              ┌──────────────┐
│  Browser    │    POST /api/auth/challenge   │  Agent (VPS) │
│  (nos2x-fox)│  ──────────────────────────►  │              │
│             │    ←── { challenge } ────     │  config:     │
│  signEvent  │                              │  admin_npub: │
│  with nsec  │    POST /api/auth/verify      │  npub1XXXX   │
│  (user's)   │  ──── { signed event } ────►  │              │
│             │    ←── { token } ────────     │  (nsec never │
└─────────────┘                              │   stored)    │
                                             └──────────────┘
```

**The gap:** The agent knows `npub1XXXX` (from Ansible-generated config). The user has `nsec1YYYY` in their signer. These don't match → login fails at `event.pubkey !== adminHex`.

---

## Proposed Onboarding Flow (3 Options)

### Option A: VPS Generates → Onboarding Page → User Imports → VPS Deletes

```
Ansible deploy
  │
  ├─► Generate nsec/npub pair
  ├─► Write to: /etc/continuum/agent/setup/identity.json
  ├─► Set admin_npub in agent config
  │
  ▼
First visit by user
  │
  ├─► GET /setup → returns identity.json (served ONCE)
  │   ├─► Displays nsec in big text + QR code
  │   ├─► "Save this key. It will be deleted from the server."
  │   └─► User copies nsec into nos2x-fox
  │
  ├─► User clicks "I've saved the key. Verify."
  │   └─► Browser signs challenge with imported key
  │       └─► Agent verifies → confirms user controls the admin key
  │
  ├─► Agent deletes /etc/continuum/agent/setup/identity.json
  │   └─► /setup endpoint returns 410 Gone
  │
  └─► User is logged in. Only copy of nsec is in browser signer.
```

**Tradeoffs:**
- ✅ Simple implementation
- ✅ User can't get locked out if they follow instructions
- ✅ Nsec deleted from VPS after verification
- ❌ Nsec transmitted over HTTPS (in body of /setup response) — but HTTPS is encrypted
- ❌ Nsec visible on screen (shoulder surfing)
- ❌ If user closes page without saving → admin key is lost (VPS already deleted it)
- ❌ /setup must be IP-locked or token-gated to prevent unauthorized access

### Option B: Browser Generates → Onboarding UI → Npub Sent to Agent

```
User visits /setup
  │
  ├─► Browser generates keypair using window.crypto.subtle
  │   └─► nsec stays in browser memory, never sent to server
  │
  ├─► Displays nsec: "Save this key immediately."
  ├─► User imports nsec into nos2x-fox
  │
  ├─► User clicks "Verify"
  │   └─► Browser signs a challenge → agent verifies the signature
  │       └─► If valid: agent adds the npub to admin_npubs[]
  │
  └─► Session established. VPS never saw the nsec.
```

**Tradeoffs:**
- ✅ Best security: nsec never touches the VPS
- ✅ Works without Ansible changes (key generation is client-side)
- ✅ No cleanup needed (nothing stored on VPS to delete)
- ✅ /setup endpoint doesn't need to serve secrets — just needs a challenge/verify endpoint
- ❌ Web Crypto API for nostr key generation needs `nostr-tools` in the browser (already bundled)
- ❌ Same "user must save immediately" problem as Option A
- ❌ Requires the onboarding page to generate valid nostr keys (nostr-tools can do this)

### Option C: Hybrid — VPS Generates, QR Transfer, Paper Backup

```
Ansible deploy
  │
  ├─► Generate nsec/npub pair
  ├─► Render a ONE-TIME printable HTML page
  │   ├─► nsec as QR code (scan with phone)
  │   ├─► nsec as text blocks (copy-paste)
  │   ├─► npub as QR code (for sharing without exposing nsec)
  │   └─► "Print this page. Store in safe. Then click Confirm."
  │
  ├─► User imports into nos2x-fox (or Amber on phone via QR)
  │
  ├─► Verification challenge → agent validates
  │
  └─► VPS deletes the stored identity + serves 404 on /setup
```

**Tradeoffs:**
- ✅ QR code = easy mobile transfer (Amber can scan QR to import key)
- ✅ Paper backup means user can recover from browser wipe
- ✅ VPS deletes nsec after verification
- ❌ More implementation work (QR code rendering, printable HTML)
- ❌ Paper backup is a physical security risk (lock it up)
- ❌ Same shoulder-surfing risk

---

## Comparison

| Criterion | Option A (VPS gen → serve) | Option B (Browser gen) | Option C (Hybrid + QR) |
|-----------|---------------------------|----------------------|----------------------|
| VPS sees nsec? | Yes (in transit + at rest) | **Never** | Yes (in transit + at rest) |
| Implementation effort | 2-3 days | 1-2 days | 3-4 days |
| User-friendly? | OK (copy-paste) | OK (copy-paste) | **Best** (scan QR) |
| Recovery without backup | Impossible | Impossible | Paper backup |
| Ansible changes needed | Yes (generate + deploy key) | **Minimal** (just config) | Yes (generate + deploy + render) |
| Shoulder-surfing risk | High (text on screen) | High (text on screen) | **Lower** (QR, small) |
| Cleanup required | Delete file | **None** | Delete file |

---

## Recommended: Option B (Browser Generates) + Option C Recovery Features

**Best security + simplest implementation.** Key generation happens in the browser using `nostr-tools` (already a dependency of the agent, can be loaded client-side). The VPS never sees the nsec.

### Flow Detail

#### Precondition: Agent has an empty or default admin_npubs list
```yaml
# agent config — initially empty, populated on first verified login
admin_npubs: []
admin_setup_pending: true   # allows /api/setup endpoints
```

#### Step 1: User visits /setup

```javascript
// onboarding.js (new view file)
import { generatePrivateKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

async function renderSetup(mount) {
  // 1. Generate keypair in browser
  const nsecBytes = generatePrivateKey();  // 32 random bytes
  const npubHex = getPublicKey(nsecBytes);
  const nsecBech32 = nip19.nsecEncode(nsecBytes);
  const npubBech32 = nip19.npubEncode(npubHex);

  // 2. Display nsec with urgency
  mount.innerHTML = `
    <div class="setup-card">
      <h2>Your Admin Identity</h2>
      <p class="warning">⚠ Save this key NOW. It will never be shown again.</p>

      <div class="key-display">
        <label>Private key (nsec):</label>
        <code class="mono">${nsecBech32}</code>
        <button onclick="copyKey()">Copy</button>
      </div>

      <div class="key-display">
        <label>Public key (npub):</label>
        <code class="mono">${npubBech32}</code>
      </div>

      <div class="steps">
        <h3>Next steps:</h3>
        <ol>
          <li>Copy the nsec above</li>
          <li>Open your browser signer (nos2x-fox / Plebeian Signer)</li>
          <li>Import the key</li>
          <li>Come back here and click <strong>Verify</strong></li>
        </ol>
      </div>

      <button class="primary" onclick="verifyAdmin()">
        I've imported the key. Verify.
      </button>
    </div>
  `;

  // Store temporarily for verification step
  window.__setupNsec = nsecBech32;
  window.__setupNpub = npubBech32;
}
```

#### Step 3: Verification

```javascript
async function verifyAdmin() {
  // Sign a challenge with the generated key
  const challenge = await fetch('/api/setup/challenge').then(r => r.json());
  const signedEvent = await window.nostr.signEvent({
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    content: challenge,
    tags: [['challenge', challenge], ['relay', window.location.origin]],
  });

  // Agent verifies + adds npub to admin_npubs
  const result = await fetch('/api/setup/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: signedEvent }),
  }).then(r => r.json());

  if (result.ok) {
    // Admin identity locked in. Clear browser memory.
    window.__setupNsec = null;
    window.__setupNpub = null;

    // Redirect to app
    window.location.hash = '#/projects';
  }
}
```

#### Agent-side changes

```javascript
// New endpoints in index.mjs

// One-time challenge for the setup flow
app.post('/api/setup/challenge', async (req, reply) => {
  if (!cfg.admin_setup_pending) {
    return reply.code(410).send({ error: 'setup already completed' });
  }
  const { challenge, expires_in } = auth.issueChallenge(req.ip);
  return { challenge, expires_in, kind: 22242 };
});

// Verify the setup challenge + lock in the admin npub
app.post('/api/setup/verify', async (req, reply) => {
  if (!cfg.admin_setup_pending) {
    return reply.code(410).send({ error: 'setup already completed' });
  }
  const event = req.body?.event;
  if (!event) return reply.code(400).send({ error: 'body.event required' });

  // Verify the signature (same as regular auth)
  const result = auth.verifyChallenge(event, req.ip);
  if (!result.ok) {
    return reply.code(401).send({ error: result.reason });
  }

  // Add the verified npub to admin_npubs
  cfg.admin_npubs.push(event.pubkey);
  cfg.admin_setup_pending = false;

  // Write updated config to disk
  await writeConfig(cfg);

  // Issue session token
  const token = auth.issueSessionToken();
  return { token: token.token, expires_at: token.expiresAt, admin_npub: nip19.npubEncode(event.pubkey) });
});
```

#### Cleanup

No VPS-side cleanup needed — the nsec was never on the VPS. The `cfg.admin_setup_pending` flag prevents re-running setup. The user's nsec lives only in their browser signer (and any backup they made).

---

## Security Analysis

### Attack: Someone intercepts the /setup page

If an attacker can MITM the HTTPS connection, they could inject JS that sends the generated nsec to their server. **Mitigation:** HSTS + the user should verify the certificate. This is the same risk as any web app.

### Attack: Someone views the nsec over the user's shoulder

The nsec is displayed as text on screen. **Mitigation:** Option C's QR code is harder to read from a distance. Also: the user can dim the screen, or the page could include a "blur" toggle that hides the nsec until hovered.

### Attack: User loses the nsec (browser data wiped)

If the user clears browser data without backing up the nsec, they lose admin access. **Mitigation:** Multiple strategies:

1. **Paper backup (recommended):** Print the setup page. Store in a safe.
2. **Encrypted backup:** Option to download an encrypted backup (password-protected) of the nsec
3. **Recovery npub:** During setup, the user can optionally provide a "recovery npub" — a second key that can also authenticate
4. **VPS recovery:** The Ansible deploy logs contain the original generated nsec. If the user has SSH access to the VPS, they can retrieve it from the deploy logs. **This is a security tradeoff** — anyone with SSH access can extract the key.

### Attack: Attacker re-runs /setup

The `/setup` endpoint must be gated by `cfg.admin_setup_pending`. After verification, it returns 410 Gone. Even if someone requests it again, the agent refuses.

### Attack: Attacker has SSH access to VPS

If the VPS is compromised, the attacker can modify the agent config, read the session_secret, forge tokens. **Mitigation:** The nsec was never on the VPS (Option B), so the attacker cannot sign as the admin from another device. They could only impersonate within the compromised session.

---

## Implementation Plan

### Phase 1: Multi-admin npub support (1-2 hrs)

| # | Task | Details |
|---|------|---------|
| 1 | Change config schema | `admin_npub: string` → `admin_npubs: string[]` + `admin_setup_pending: bool` |
| 2 | Update config validation | Accept array, validate each npub, default `admin_setup_pending: false` |
| 3 | Update `auth.mjs` | `verifyChallenge()` checks `adminHexes.includes(pubkey)`, `verifySessionToken()` checks `adminHexes.includes(pk)` |
| 4 | Update Ansible template | `admin_npubs: []` by default, `admin_setup_pending: true` |

### Phase 2: Onboarding page (2-3 days)

| # | Task | Details |
|---|------|---------|
| 5 | Create `src/views/setup.js` | Key generation UI + verification flow |
| 6 | Add `/setup` route to router | `route('/setup', () => renderSetup(mainContent()))` |
| 7 | Add `nostr-tools` to frontend deps | Already in agent deps; add `nostr-tools/pure` to frontend |
| 8 | Create agent endpoints | `POST /api/setup/challenge` + `POST /api/setup/verify` |
| 9 | Wire verification flow | Browser signs → agent validates → adds to admin_npubs |
| 10 | Add "print" + "download encrypted backup" options | For recovery |
| 11 | Test full flow | Deploy fresh → visit /setup → import key → verify → logged in |

### Phase 3: Optional — QR transfer + Amber support (3-5 days)

| # | Task | Details |
|---|------|---------|
| 12 | Add QR code rendering | Use `qrcode.js` library to render nsec as QR |
| 13 | Add Amber/NIP-46 pairing option | Connect via Amber as alternative to browser extension |
| 14 | Test with Amber scan | User scans QR from Amber → verification passes |

### Phase 4: Cleanup and hardening (1 day)

| # | Task | Details |
|---|------|---------|
| 15 | Rate-limit /setup endpoints | Prevent brute-force |
| 16 | IP-lock /setup to first visitor | Only the first IP that hits /setup can complete it |
| 17 | Add /setup status endpoint | `GET /api/setup/status` returns `{ completed: bool }` |
| 18 | Update Ansible to skip setup if already done | Don't re-generate on re-deploy |

---

## Total Effort

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1 (multi-admin npub) | 1-2 hrs | None — can be done now |
| Phase 2 (onboarding page) | 2-3 days | Phase 1 |
| Phase 3 (QR + Amber) | 3-5 days | Phase 2 |
| Phase 4 (hardening) | 1 day | Phase 2 |

**Minimum viable:** Phase 1 + Phase 2 = **~3 days** from start to working onboarding flow.

---

## Decision Matrix

| Factor | Option A (VPS gen) | Option B (Browser gen) | Option C (Hybrid) |
|--------|-------------------|----------------------|-------------------|
| VPS sees nsec? | Yes | **No** | Yes |
| User effort | Copy-paste into signer | Copy-paste into signer | **Scan QR** |
| Recovery | None (unless backup) | None (unless backup) | **Paper backup** |
| Implementation | 2-3 days | **1-2 days** | 3-4 days |
| Ansible impact | **Low** (generate + deploy) | **None** | Medium |
| Security posture | Good | **Best** | Good |

**Recommended: Option B (Browser generates)**, with a printed backup page (Option C's recovery feature) as a UX improvement in Phase 3.
