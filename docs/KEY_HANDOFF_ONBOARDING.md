# Key Handoff Onboarding — VPS-Generated Entropy → Browser Self-Custody

> **Goal:** Zero-friction first login (no extension required) with a clean path to full self-custody. The VPS generates entropy, the user "graduates" to their own browser signer, and the VPS crypto-shreds the key once handoff is validated.

---

## 1. The Core Idea

```
┌─────────────────────────────────────────────────────────────┐
│  Phase 1: BOOTSTRAP (VPS has key)                           │
│  ┌─────────┐    nsec generated at deploy time               │
│  │   VPS   │    agent accepts this pubkey as admin           │
│  │ signer  │    browser ←→ VPS NIP-07 shim → signs challenge │
│  └─────────┘    User logs in. No extension needed.           │
├─────────────────────────────────────────────────────────────┤
│  Phase 2: HANDOFF (user imports key)                        │
│  User installs nos2x-fox / Amber                             │
│  Continuum displays nsec (one-time, authenticated view)     │
│  User copies nsec → pastes into extension settings          │
│  Extension now handles window.nostr.signEvent()             │
├─────────────────────────────────────────────────────────────┤
│  Phase 3: VALIDATION + DELETION                             │
│  VPS sends fresh challenge                                  │
│  Browser signs via NIP-07 extension (NOT VPS shim)          │
│  VPS verifies signature from extension path                 │
│  VPS crypto-shreds nsec                                     │
│  Pure self-custody. VPS is keyless.                         │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Why NIP-07 Import Is Manual (The Hard Constraint)

NIP-07 defines exactly four methods:

```js
window.nostr.getPublicKey()        // → hex pubkey
window.nostr.signEvent(event)      // → signed event
window.nostr.nip04.encrypt(pubkey, plaintext)  // → ciphertext
window.nostr.nip04.decrypt(pubkey, ciphertext) // → plaintext
```

**There is no `importKey()`, `setPrivateKey()`, or `generateKey()`.**

This is deliberate. If web pages could inject keys into signer extensions, any malicious site could overwrite a user's identity. The security model requires the user to manually manage key material inside the extension's own settings UI.

**Implication:** "Handing entropy to the browser signer" always requires the user to:

1. See the nsec (Continuum displays it once)
2. Copy it
3. Open their extension's settings
4. Paste it
5. Save

We can make this smoother (QR code for mobile/Amber, clear instructions, password-encrypted key file download), but we cannot skip it.

---

## 3. Detailed Phase-by-Phase Architecture

### Phase 1: Bootstrap (VPS-Custodial, Time-Limited)

**At deploy time:**

```bash
# deploy/continuum-deploy.sh additions
NSEC=$(nostril --generate-secret)
NPUB=$(echo "$NSEC" | nostril --secret-to-pubkey)

# Write to agent config (encrypted at rest)
echo "admin_npub: $NPUB" >> /etc/continuum/config.yaml
echo "bootstrap_nsec_enc: $(encrypt_with_machine_key "$NSEC")" >> /etc/continuum/config.yaml
echo "bootstrap_expires: $(date -d '+72 hours' +%s)" >> /etc/continuum/config.yaml

# nsec NEVER written to disk in plaintext
# Only exists in: encrypted config + agent process memory
unset NSEC
```

**VPS NIP-07 shim (temporary signer service):**

A lightweight endpoint on the agent that acts as a remote signer ONLY during bootstrap:

```
POST /api/bootstrap/sign
  Body: { event: <unsigned NIP-42 challenge event> }
  Response: { event: <signed event> }
```

The frontend detects: `if (!window.nostr && bootstrapActive) → use /api/bootstrap/sign`.

**Security controls:**
- Bootstrap signer bound to `127.0.0.1` only (behind Caddy auth)
- Rate-limited: max 5 signs per session
- Auto-disables after 72h regardless
- Logs every sign attempt

**User experience:**
1. User opens `continuum.orangesync.tech`
2. Clicks Login
3. Frontend: no `window.nostr` detected → uses bootstrap signer
4. Challenge signed by VPS → user logged in
5. **Banner appears:** "You're using a server-managed key. Import it into your own signer for full self-custody. [Show Key] [Dismiss]"

### Phase 2: Handoff (Key Transfer)

**When user clicks "Show Key":**

```js
// Frontend requests the nsec from agent (authenticated session required)
const resp = await fetch('/api/bootstrap/reveal', { method: 'POST' });
const { nsec, npub, expires_at } = await resp.json();

// Display in a secure, copyable, one-time modal
showKeyHandoffModal({
  nsec,
  npub,
  instructions: [
    '1. Open nos2x-fox settings (Add-ons → nos2x-fox → Preferences)',
    '2. Paste this private key into the "Private Key" field',
    '3. Click Save',
    '4. Refresh this page',
    '5. Click "I\'ve imported it" below',
  ],
  qrCode: generateQR(`nsec1...`),  // For Amber mobile scan
  warning: 'This is shown ONCE. Save it somewhere safe. It will be deleted from the server after you confirm import.',
});
```

**After user clicks "I've imported it":**

```js
// Frontend checks if extension is now present
if (window.nostr) {
  const extPubkey = await window.nostr.getPublicKey();
  if (extPubkey === npub) {
    // Extension has the right key!
    await fetch('/api/bootstrap/confirm-handoff', { method: 'POST' });
    showSuccess('Key imported! Verifying...');
  } else {
    showError(`Extension has a different key. Expected ${npub.slice(0,8)}..., got ${extPubkey.slice(0,8)}...`);
  }
} else {
  showError('No NIP-07 signer detected. Install nos2x-fox and try again.');
}
```

### Phase 3: Validation + Crypto-Shredding

**Agent-side handoff confirmation:**

```rust
// POST /api/bootstrap/confirm-handoff
// 1. Send a NEW challenge (different from login challenge)
// 2. Browser must sign it via window.nostr.signEvent() (extension path)
// 3. Verify the signature is valid AND came from the extension
//    (frontend sets a flag: signed_via = "extension")

async fn confirm_handoff(req: HandoffRequest) -> Result<()> {
    // req contains a challenge event signed by the browser extension
    let event = verify_signature(&req.signed_event)?;
    
    if event.pubkey != config.bootstrap_npub {
        return Err("Wrong pubkey");
    }
    
    // Critical: verify this was signed LOCALLY, not via bootstrap shim
    // The bootstrap shim logs every sign. If this challenge ID was
    // signed by the shim, reject — user is cheating/faking handoff.
    if shim_logger.was_signed(&req.challenge_id)? {
        return Err("This challenge was signed by server, not extension");
    }
    
    // Handoff confirmed → crypto-shred
    crypto_shred_bootstrap_key().await?;
    
    // Update config: remove bootstrap_nsec_enc, set bootstrap_completed = true
    remove_from_config("bootstrap_nsec_enc")?;
    set_config("bootstrap_completed", "true")?;
    set_config("bootstrap_completed_at", now().to_string())?;
    
    Ok(())
}

async fn crypto_shred_bootstrap_key() -> Result<()> {
    // 1. Overwrite encrypted key blob with zeros
    let key_path = config_path("bootstrap_nsec_enc")?;
    overwrite_with_random_bytes(&key_path, 4096)?;
    remove_file(&key_path)?;
    
    // 2. Zero the machine-key-derived encryption key in memory
    // (agent restart clears process memory fully)
    zero_memory(&mut machine_key);
    
    // 3. Remove from config.yaml
    remove_config_key("bootstrap_nsec_enc")?;
    remove_config_key("bootstrap_expires")?;
    
    // 4. Restart agent to clear any cached key material
    spawn("systemctl restart continuum-agent");
    
    Ok(())
}
```

---

## 4. Tradeoffs

### 4.1 Security Tradeoffs

| Concern | Risk | Mitigation |
|---------|------|------------|
| **VPS compromised during bootstrap window** | Attacker gets admin nsec | 72h max TTL; alert if not handed off; crypto-shred on handoff |
| **Past exposure is irreversible** | If nsec was captured during window, deletion doesn't undo it | Accept: this is inherent to any custodial bootstrap. Browser-keygen avoids it entirely. |
| **nsec displayed in browser** | XSS could exfiltrate | CSP headers; nsec only in DOM for the modal duration; cleared on close; one-time fetch |
| **nsec in transit** | MITM (even over HTTPS, cert compromise) | One-time fetch; HTTPS pinning; short-lived session token |
| **SSD wear-leveling** | "Deleted" data persists in flash cells | Crypto-shred: encrypt at rest with machine key, destroy machine key = data unrecoverable even from raw flash |
| **Backups/snapshots** | VPS image taken during window contains encrypted key | Encrypt all disk; document: snapshots are risk surface |
| **Process memory** | nsec in agent RAM until restart | Restart agent after shred; use mlock + zeroize for key buffers |

### 4.2 UX Tradeoffs

| Aspect | VPS Handoff | Browser Keygen (alternative) | Permanent VPS Signer (nsecBunker) |
|--------|-------------|------------------------------|-----------------------------------|
| **First login friction** | Zero (works immediately) | Zero (auto-generates) | Zero |
| **Requires extension?** | Not initially; yes for handoff | Auto-detects; optional | Never |
| **Manual nsec paste** | Yes (unavoidable for NIP-07) | No | No |
| **Self-custody** | Yes (after handoff) | Yes (from t=0) | No (custodial forever) |
| **Recovery if browser lost** | nsec was shown once — if user didn't save, key is gone | Same risk | VPS always has it (custodial safety net) |
| **Multi-device** | Re-import nsec to each device | Re-import to each device | Works everywhere (VPS signs) |
| **Scary for non-technical users** | "Paste this secret string" is intimidating | Transparent | Invisible (but they don't own their key) |

### 4.3 Implementation Complexity

| Component | Effort | Notes |
|-----------|--------|-------|
| Bootstrap nsec generation in deploy script | Low | `nostril --generate-secret`, 10 lines |
| Encrypted-at-rest storage in config | Medium | Machine-key-derived encryption (LUKS or app-level AES-256-GCM) |
| VPS NIP-07 shim endpoint | Medium | New agent endpoint, rate-limited, 127.0.0.1-only |
| Frontend: detect extension vs shim | Low | `if (window.nostr)` check, 20 lines |
| Frontend: key reveal modal + QR | Medium | One-time fetch, secure display, instructions UI |
| Agent: handoff validation endpoint | Medium | New challenge, verify extension-path signature, reject shim-signed |
| Agent: crypto-shred routine | Medium | File overwrite + config cleanup + agent restart |
| Expiry watchdog cron | Low | Check `bootstrap_expires`, alert/delete if past TTL |
| **Total** | ~2-3 days | Full stack: deploy + agent (Rust) + frontend (JS) |

---

## 5. Alternative Approaches (and why they're worse)

### Alternative A: Browser Keygen Only (no VPS key)

```
Browser generates nsec on first visit → stores in IndexedDB (encrypted)
→ Continuum registers pubkey with agent → user logs in
```

**Pros:** Key never touches VPS. Best security. No handoff needed.
**Cons:** If user clears browser data, key is lost permanently (unless they export). No recovery path without a separate backup mechanism.

**Verdict:** This is what I'd recommend as the DEFAULT, with VPS-handoff as an OPTIONAL upgrade path for users who want a managed initial experience.

### Alternative B: nsecBunker (NIP-46, permanent VPS signer)

```
VPS runs nsecBunker → user pairs via NIP-46 connection string
→ bunker signs all events → nsec never leaves VPS
```

**Pros:** Works on all devices. No manual import. "Invisible" UX.
**Cons:** Permanently custodial. If VPS compromised, key stolen. Extra service to run/maintain. NIP-46 adds latency to every sign.

**Verdict:** Only acceptable for fully trusted VPS operators (self-hosted by the user themselves). Not suitable for a hosted Continuum service.

### Alternative C: Amber (Android-only)

```
Android user installs Amber → Amber intercepts NIP-07 in browser
→ self-custody on phone from day one
```

**Pros:** Best mobile UX. Self-custody. No VPS key.
**Cons:** Android only. Desktop users still need nos2x-fox. Doesn't solve the general problem.

**Verdict:** Recommend Amber for Android users in the docs. Not a complete solution.

---

## 6. Recommended Architecture: Hybrid

Combine the best of all approaches:

```
┌──────────────────────────────────────────────────────────────┐
│                    USER OPENS CONTINUUM                       │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  Is window.nostr present? (extension/Amber detected)         │
│  │                                                           │
│  ├─ YES → Use extension. Register pubkey with agent.        │
│  │        SELF-CUSTODY FROM T=0. Done.                      │
│  │                                                           │
│  └─ NO → Is browser.keygen enabled?                          │
│           │                                                  │
│           ├─ YES → Generate nsec in browser (Web Crypto).    │
│           │        Store encrypted in IndexedDB.             │
│           │        Register pubkey with agent.               │
│           │        SELF-CUSTODY FROM T=0.                    │
│           │        Offer "export to extension" upgrade path. │
│           │                                                  │
│           └─ NO → Use VPS bootstrap signer (Phase 1).        │
│                    Show "import key" banner.                 │
│                    User graduates to extension.              │
│                    VPS crypto-shreds on handoff.             │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

**Priority order:**
1. **Extension detected** → use it (best: user already has a signer)
2. **Browser keygen** → transparent self-custody (second best)
3. **VPS bootstrap** → fallback for users who refuse extensions (acceptable, time-limited)

This gives every user zero-friction login while maximizing self-custody.

---

## 7. Recovery Considerations

The hardest problem with any self-custody approach: **what happens when the user loses their browser data?**

| Scenario | Recovery |
|----------|----------|
| User has nos2x-fox, backed up nsec externally | Re-import to new browser. Works. |
| User has browser keygen, no backup | Key is gone. Must re-register new key with agent (requires admin access — chicken/egg). |
| User did VPS handoff, didn't save nsec externally | Key gone from VPS (shredded). Same as above. |

**Solution: mandatory encrypted backup during keygen/handoff.**

```
During key creation or handoff:
  → Prompt: "Download encrypted backup? (recommended)"
  → User sets a password
  → nsec encrypted with password (AES-256-GCM via PBKDF2)
  → Downloaded as continuum-key-backup.json
  → User can restore on any device with password
```

This is the Snort model (`Export encrypted key`). Adds one step but solves recovery.

---

## 8. Implementation Roadmap

### Phase 1: Browser Keygen (highest value, lowest risk) — Week 1
- [ ] Frontend: Web Crypto nsec generation
- [ ] Frontend: IndexedDB encrypted storage (password-derived key)
- [ ] Frontend: NIP-07 shim (sign from IndexedDB if no extension)
- [ ] Agent: `POST /api/auth/register-pubkey` endpoint
- [ ] Agent: accept any registered pubkey (not just hardcoded admin_npub)
- [ ] Frontend: encrypted backup download/restore

### Phase 2: VPS Bootstrap Signer (for zero-extension path) — Week 2
- [ ] Deploy script: generate bootstrap nsec, encrypted-at-rest
- [ ] Agent: `POST /api/bootstrap/sign` endpoint (rate-limited, 127.0.0.1)
- [ ] Agent: `POST /api/bootstrap/reveal` endpoint (one-time, authenticated)
- [ ] Frontend: bootstrap detection + key reveal modal + QR
- [ ] Agent: `POST /api/bootstrap/confirm-handoff` with crypto-shred
- [ ] Expiry watchdog cron (72h TTL)

### Phase 3: Polish — Week 3
- [ ] UI: onboarding wizard (detect → recommend → guide)
- [ ] Docs: signer setup guide (nos2x-fox, Amber, browser keygen)
- [ ] Tests: full handoff flow Playwright tests
- [ ] Migration path for existing throwaway-key deployments

---

## 9. Threat Model Summary

| Threat | Browser Keygen | VPS Handoff | nsecBunker |
|--------|---------------|-------------|------------|
| VPS compromised | ✅ Safe (key never on VPS) | ⚠️ Risk during window | ❌ Key always on VPS |
| XSS on Continuum | ⚠️ Key in IndexedDB (CSP mitigates) | ⚠️ Key in modal (CSP mitigates) | ✅ Key never in browser |
| User loses browser | ❌ Key gone (backup needed) | ❌ Key gone (backup needed) | ✅ VPS has key |
| MITM on network | ✅ Key never transmitted | ⚠️ Key fetched once (HTTPS) | ✅ Key never transmitted |
| SSD forensic recovery | ✅ Key never on disk | ✅ Crypto-shredded | ❌ Key on disk forever |

**Winner: Browser keygen** — best security, zero VPS exposure, only weakness is recovery (solved by encrypted backup).

**VPS handoff is the fallback** for users who specifically want a "managed" initial experience and are willing to accept the bootstrap-window risk.

---

## 10. Conclusion

The VPS-key-handoff model you described is **technically sound** and provides a genuine zero-friction → self-custody path. The main tradeoff is the **bootstrap security window** (72h) during which the VPS holds the nsec.

However, **browser keygen achieves the same zero-friction UX with strictly better security** (key never touches VPS). The only advantage of VPS-handoff over browser-keygen is the "managed" feel — some users trust a server-generated key more than a browser-generated one (psychological, not technical).

**Recommendation:** Implement browser keygen as the default. Offer VPS-handoff as an optional deployment mode for operators who want it. Both paths lead to self-custody; browser-keygen just gets there faster and safer.
