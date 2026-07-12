# Browser Keygen + Extension Migration — Hybrid Onboarding Plan

> **Path:** Hybrid (browser vault first, optional extension migration later)  
> **Goal:** Instant onboarding with zero setup, optional security upgrade path to self-custody.  
> **Users get:** No-extension-required login on first visit, with a clear path to better security.

---

## 1. User Flow

```
First Visit (Browser Keygen)                               │ Later (Optional Upgrade)
─────────────────────────────────────────────────────     │ ───────────────────────────────
┌─────────────────────────────────────────────────────┐   │ ┌─────────────────────────────┐
│ Welcome to Continuum                                  │   │ │ 🔑 Secure Your Identity       │
│                                                      │   │ │                         │
│ Generate a new Nostr key in this browser?           │   │ │ Your key is stored in this  │
│ [✓] Yes, generate key now                           │   │ │ browser. For better security,│
│                                                      │   │ │ move it to a signer extension│
│ [Choose Password]                                   │   │ │ like nos2x-fox or Amber.    │
│ • 12-word backup phrase shown                       │   │ │                         │
│ • nsec/npub displayed                               │   │ │ [Show My Key]              │
│ [Download Encrypted Backup]                          │   │ │ [Migrate to Extension]     │
│                                                      │   │ │ [Keep in Browser]          │
│ Click "Continue" → logged in                         │   │ └─────────────────────────────┘
└─────────────────────────────────────────────────────┘   │
```

---

## 2. Technical Architecture

### 2.1 Browser Key Generation (First Visit)

**When user opens Continuum with no existing key:**

```typescript
// src/stores/keyVault.ts — browser vault + NIP-07 shim
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

export class KeyVault {
  private static instance: KeyVault;
  private db: IDBDatabase | null = null;
  private nsecHex: string | null = null;
  private npubHex: string | null = null;
  private sessionKey: CryptoKey | null = null;

  // Generate new keypair in browser
  static async generate(password: string): Promise<KeyVault> {
    // 1. Generate entropy using Web Crypto
    const nsecBytes = crypto.getRandomValues(new Uint8Array(32));
    const nsecHex = bytesToHex(nsecBytes);
    const npubHex = getPublicKey(nsecBytes);
    
    // 2. Derive encryption key from password (PBKDF2)
    const encKey = await KeyVault.deriveKey(password);
    
    // 3. Encrypt nsec for storage
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-256-GCM', iv },
      encKey,
      nsecBytes
    );
    
    // 4. Store in IndexedDB
    const vault = new KeyVault();
    await vault.initDB();
    await vault.storeEncryptedKey({
      npub: npubHex,
      encrypted: arrayBufferToBase64(encrypted),
      iv: arrayBufferToBase64(iv),
      salt: arrayBufferToBase64(salt),
      createdAt: Date.now()
    });
    
    // 5. Keep in memory for session
    vault.nsecHex = nsecHex;
    vault.npubHex = npubHex;
    
    return vault;
  }
  
  // NIP-07 shim — sign with stored key
  public get nostr(): Nostr {
    return {
      getPublicKey: () => this.npubHex!,
      signEvent: async (event: NostrEvent) => {
        if (!this.nsecHex) throw new Error('No key loaded');
        return signEventWithPrivateKey(event, this.nsecHex);
      },
      getRelays: () => {},
    };
  };
}
```

### 2.2 Onboarding UI Components

**First-visit onboarding screen (`src/views/Onboarding.svelte`):**

```svelte
<script lang="ts">
  import { KeyVault } from '$lib/stores/keyVault';
  import { fly } from 'svelte/transition';

  let step: 'welcome' | 'password' | 'backup' | 'complete' = 'welcome';
  let password = '';
  let confirmPassword = '';
  let vault: KeyVault | null = null;
  let backupPhrase: string[] = [];
  let nsec = '';
  let npub = '';
  let showNsec = false;

  async function generateVault() {
    // Validate password
    if (password.length < 8) {
      error('Password too short');
      return;
    }
    
    // Generate key
    vault = await KeyVault.generate(password);
    const mnemonic = generateMnemonic(vault.nsecHex!);
    backupPhrase = mnemonic;
    nsec = vault.nsec!;
    npub = vault.npub!;
    
    step = 'backup';
  }

  async function completeOnboarding() {
    // 1. Register pubkey with agent
    await registerPubkey(npub);
    
    // 2. Install NIP-07 shim
    installNostrShim(vault!);
    
    // 3. Redirect to app
    step = 'complete';
    setTimeout(() => navigate('/projects'), 1000);
  }

  function downloadBackup() {
    const encrypted = await vault!.exportEncrypted();
    const blob = new Blob([JSON.stringify(encrypted)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `continuum-backup-${npub.slice(0,8)}.json`;
    a.click();
  }

  // UI shown below...
</script>

<!-- Step 1: Welcome -->
{#if step === 'welcome'}
<div class="onboarding-card" transition:fly={{ y: -20 }}>
  <h2>Welcome to Continuum</h2>
  <p>No extensions needed. Generate a secure identity right here in your browser.</p>
  
  <label>Choose a password to encrypt your key:</label>
  <input type="password" bind:value={password} placeholder="At least 8 characters" />
  <input type="password" bind:value={confirmPassword} placeholder="Confirm password" />
  
  <button 
    class="primary" 
    on:click={generateVault}
    disabled={password !== confirmPassword || password.length < 8}>
    Generate My Key
  </button>
  
  <p class="small">You'll see a backup phrase next. Save it somewhere safe!</p>
</div>

<!-- Step 2: Backup Phrase -->
{:else if step === 'backup'}
<div class="onboarding-card" transition:fly={{ y: -20 }}>
  <h2>Your Recovery Phrase</h2>
  <p class="warning">This is the ONLY way to recover your key if you lose it. Write it down.</p>
  
  <div class="mnemonic-grid">
    {#each backupPhrase as word, i}
      <div class="mnemonic-word">
        <span class="number">{i+1}.</span>
        <span class="word">{word}</span>
      </div>
    {/each}
  </div>
  
  <label class="checkbox">
    <input type="checkbox" bind:checked={$saved} />
    I have saved my recovery phrase somewhere safe
  </label>
  
  <button 
    class="primary" 
    on:click={completeOnboarding}
    disabled={!$saved}>
    Continue
  </button>
  
  <div class="backup-options">
    <button on:click={downloadBackup}>📥 Download Encrypted Backup</button>
    <button on:click={() => showNsec = !showNsec}>
      {showNsec ? 'Hide Private Key' : 'Show Private Key'}
    </button>
  </div>
  
  {#if showNsec}
    <div class="nsec-display">
      <label>Your Private Key (nsec):</label>
      <code class="nsec">{nsec}</code>
      <button on:click={() => copyToClipboard(nsec)}>📋 Copy</button>
    </div>
  {/if}
</div>

<!-- Step 3: Complete -->
{:else if step === 'complete'}
<div class="onboarding-complete" transition:fly={{ y: -20 }}>
  <h2>🎉 Welcome to Continuum!</h2>
  <p>Your identity is ready. You can now use all features.</p>
  
  <div class="stats">
    <div class="stat">
      <strong>{npub}</strong>
      <span>Your public key</span>
    </div>
  </div>
  
  <button on:click={() => navigate('/projects')}>Start Using Continuum</button>
</div>
{/if}
```

### 2.3 Agent: Dynamic Pubkey Registration

**Agent must accept ANY registered pubkey as admin (not just hardcoded):**

```yaml
# config.yaml additions
bootstrap:
  # Onboarding mode: 'closed' | 'open' | 'admin-only'
  mode: 'open'
  # Max registered pubkeys (0 = unlimited)
  max_pubkeys: 0
```

```go
// agent/routes/onboarding.go
func RegisterPubkeyHandler(w http.ResponseWriter, r *http.Request) {
    // 1. Check if onboarding is open
    if config.Bootstrap.Mode != "open" {
        http.Error(w, "Onboarding is closed", 403)
        return
    }
    
    // 2. Auth: the requester must be an existing admin (first user is always admin)
    if !isAuthenticated(r) && !isAdminEmpty() {
        http.Error(w, "Authentication required", 401)
        return
    }
    
    // 3. Parse request
    var req struct {
        Pubkey    string `json:"pubkey"`
        SignEvent *Event  `json:"sign_event"` // Optional: prove pubkey ownership
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid request", 400)
        return
    }
    
    // 4. Verify signature if provided (proves pubkey ownership)
    if req.SignEvent != nil {
        if !req.SignEvent.Verify() {
            http.Error(w, "Invalid signature", 400)
            return
        }
        if req.SignEvent.Pubkey != req.Pubkey {
            http.Error(w, "Pubkey mismatch", 400)
            return
        }
    }
    
    // 5. Add to admin pubkeys
    if err := config.AddAdminPubkey(req.Pubkey); err != nil {
        http.Error(w, err.Error(), 400)
        return
    }
    
    // 6. Reload config
    config.Reload()
    
    json.NewEncoder(w).Encode(map[string]string{
        "status": "ok",
        "pubkey": req.Pubkey,
    })
}

// In auth verification, check if pubkey is in the admin list
func verifyAdminPubkey(pubkey string) bool {
    for _, admin := range config.AdminPubkeys {
        if admin == pubkey {
            return true
        }
    }
    return false
}
```

### 2.4 Extension Migration Flow

**Later, user clicks "Migrate to Extension" (`src/views/KeyMigration.svelte`):**

```svelte
<script>
  let step = 'show';
  let nsec = '';
  let imported = false;
  
  async function showKey() {
    const vault = KeyVault.getInstance();
    nsec = await vault.getNsec();
  }
  
  async function verifyImport() {
    // 1. Check if extension is available
    if (!window.nostr) {
      error('No NIP-07 signer detected. Please install nos2x-fox first.');
      return;
    }
    
    // 2. Get pubkey from extension
    const extPubkey = await window.nostr.getPublicKey();
    
    // 3. Compare with browser key
    if (extPubkey !== vault.npubHex) {
      error('Extension has a different key. Please import the key shown above.');
      return;
    }
    
    // 4. Sign a challenge to prove control
    const challenge = await signChallenge();
    imported = true;
    step = 'complete';
  }
  
  async function completeMigration() {
    // 1. Delete key from browser
    await KeyVault.getInstance().delete();
    
    // 2. Reload the page to use extension
    window.location.reload();
  }
</script>

<div class="migration-card">
  {#if step === 'show'}
    <h3>Move Your Key to a Signer Extension</h3>
    <p>For better security, store your key in nos2x-fox instead of this browser.</p>
    
    <button on:click={showKey}>Show My Private Key</button>
    
    {#if nsec}
      <div class="nsec-display">
        <label>Copy this private key:</label>
        <code>{nsec}</code>
        <button on:click={() => copyToClipboard(nsec)}>📋 Copy</button>
      </div>
      
      <div class="instructions">
        <h4>For nos2x-fox (Firefox):</h4>
        <ol>
          <li>Click the nos2x-fox icon in your toolbar</li>
          <li>Go to Preferences → Private Key</li>
          <li>Paste the key above</li>
          <li>Click Save</li>
        </ol>
        
        <h4>For Amber (Android):</h4>
        <ol>
          <li>Open Amber</li>
          <li>Tap the + button → Add Account</li>
          <li>Scan the QR code below</li>
        </ol>
        <QRCode text={nsec} />
      </div>
      
      <button class="primary" on:click={verifyImport}>
        ✓ I've Imported It
      </button>
    {/if}
    
  {:else if step === 'verify'}
    <p>Verifying your extension has the key...</p>
    <button disabled>Checking...</button>
    
  {:else if step === 'complete'}
    <h3>✓ Migration Complete!</h3>
    <p>Your key is now stored in your extension for enhanced security.</p>
    
    <button class="primary" on:click={completeMigration}>
      Finish Setup
    </button>
  {/if}
</div>
```

---

## 3. Recovery: Encrypted Backup

**Users MUST be able to recover if they lose the browser. Solution: encrypted backup.**

```typescript
// KeyVault export/import
export class KeyVault {
  // Export for backup
  async exportEncrypted(password: string): Promise<EncryptedBackup> {
    const encKey = await KeyVault.deriveKey(password, this.salt);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-256-GCM', iv: this.iv },
      encKey,
      hexToBytes(this.nsecHex!)
    );
    
    return {
      npub: this.npubHex!,
      encrypted: arrayBufferToBase64(encrypted),
      iv: arrayBufferToBase64(this.iv),
      salt: arrayBufferToBase64(this.salt),
      version: '1',
      created_at: Date.now()
    };
  }
  
  // Import from backup
  static async importEncrypted(backup: EncryptedBackup, password: string): Promise<KeyVault> {
    // 1. Derive key from password + salt
    const encKey = await KeyVault.deriveKey(password, backup.salt);
    
    // 2. Decrypt nsec
    const nsecBytes = await crypto.subtle.decrypt(
      { name: 'AES-256-GCM', iv: hexToBytes(backup.iv) },
      encKey,
      hexToBytes(backup.encrypted)
    );
    
    // 3. Create vault
    const vault = new KeyVault();
    vault.nsecHex = bytesToHex(nsecBytes);
    vault.npubHex = backup.npub;
    vault.iv = backup.iv;
    vault.salt = backup.salt;
    
    // 4. Store in IndexedDB
    await vault.initDB();
    await vault.storeEncryptedKey(backup);
    
    return vault;
  }
}
```

**Restore flow (`src/views/Restore.svelte`):**

```svelte
<script>
  let backupFile: File | null = null;
  let password = '';
  let error = '';
  
  async function restore() {
    if (!backupFile) {
      error = 'Please select a backup file';
      return;
    }
    
    try {
      const text = await backupFile.text();
      const backup: EncryptedBackup = JSON.parse(text);
      const vault = await KeyVault.importEncrypted(backup, password);
      
      // Install NIP-07 shim and redirect
      installNostrShim(vault);
      navigate('/projects');
    } catch (e) {
      error = 'Invalid backup file or wrong password';
    }
  }
</script>

<div>
  <h3>Restore from Backup</h3>
  <input type="file" accept=".json" on:change={(e) => backupFile = e.target.files[0]} />
  <input type="password" bind:value={password} placeholder="Backup password" />
  <button on:click={restore}>Restore My Key</button>
  {#if error}<p class="error">{error}</p>{/if}
</div>
```

---

## 4. File Changes Summary

### New Files

```
src/lib/stores/keyVault.ts          // Browser key vault + NIP-07 shim
src/views/Onboarding.svelte         // First-visit keygen flow
src/views/KeyMigration.svelte      // Extension migration flow
src/views/Restore.svelte           // Backup restore flow
src/lib/nostrShim.ts               // NIP-07 polyfill for browser keys
src/lib/cryptoUtils.ts             // Web Crypto utilities

agent/routes/onboarding.go          // Pubkey registration endpoint
agent/config/bootstrap.go           // Bootstrap config management
```

### Modified Files

```
src/auth.js                         // Detect onboarding vs existing key
src/App.svelte                      // Route: /onboarding → /onboarding
src/routes.js                       // Add /restore route
agent/config.yaml                   // Add bootstrap.mode, admin_pubkeys list
agent/routes/auth.go                // Accept dynamic admin pubkeys
```

### Build Configuration

```typescript
// vite.config.ts
export default defineConfig({
  build: {
    // Include crypto polyfill for older browsers
    rollupOptions: {
      output: {
        manualChunks: {
          // Web Crypto is large, extract for better caching
          'webcrypto': ['crypto', 'crypto/webcrypto']
        }
      }
    }
  }
});
```

---

## 5. Security Considerations

### 5.1 Threat Model

| Threat | Browser Keygen | Mitigation |
|--------|---------------|------------|
| XSS steals key from memory | Possible (during session) | CSP headers; short session timeouts; key encrypted in IndexedDB |
| Malicious extension steals key | Possible (if user installs bad extension) | Document risk; recommend only well-known extensions |
| Device forensic recovery | Possible (SSD wear-leveling) | Encrypt at rest (PBKDF2 + AES-GCM); offer secure delete on logout |
| User loses browser without backup | Key gone forever | **Mandatory encrypted backup download** during onboarding |
| Same pubkey registered twice | Unintended admin access | Agent checks pubkey not already registered |

### 5.2 Best Practices

1. **Always encrypt at rest:** Never store nsec plaintext in IndexedDB
2. **Memory hygiene:** Zeroize key buffers after use
3. **Short sessions:** Expire auth tokens after 24h, force re-auth
4. **Secure delete:** On logout/upgrade, overwrite IndexedDB entries
5. **Backup enforced:** Block logout until user has downloaded encrypted backup or confirms they have an external backup

### 5.3 Privacy Considerations

- Key generation happens entirely in browser — no server involvement
- Pubkey registration is the only network call
- No telemetry about key generation/usage
- Migration is opt-in and local-only

---

## 6. Testing Strategy

### Playwright Tests

```typescript
// tests/playwright/onboarding.spec.ts
test.describe('Browser Keygen Onboarding', () => {
  test('Complete keygen → login → migration flow', async ({ page }) => {
    // 1. Visit onboarding
    await page.goto('/onboarding');
    
    // 2. Generate key
    await page.fill('input[type="password"]', 'test-password-123');
    await page.click('button:has-text("Generate My Key")');
    
    // 3. Save backup phrase
    await page.waitForSelector('.mnemonic-grid');
    await page.click('input[type="checkbox"]');
    await page.click('button:has-text("Continue")');
    
    // 4. Verify logged in
    await page.waitForURL('/projects');
    await expect(page.locator('[data-testid="session-button"]')).toHaveText('Sign out');
    
    // 5. Start migration
    await page.click('button:has-text("Migrate to Extension")');
    await page.click('button:has-text("Show My Key")');
    
    // 6. Mock extension
    await page.context().grantPermissions(['clipboard-read']);
    await page.evaluate(() => {
      (window as any).nostr = {
        getPublicKey: () => 'npub...',
        signEvent: (evt) => ({ ...evt, sig: '...' })
      };
    });
    
    // 7. Complete migration
    await page.click('button:has-text("✓ I\'ve Imported It")');
    await page.click('button:has-text("Finish Setup")');
  });
  
  test('Restore from backup', async ({ page }) => {
    // Generate backup file
    // Test restore flow with correct password
    // Test error with wrong password
  });
});
```

---

## 7. Migration Path for Existing Users

**For current Continuum deployments with hardcoded `admin_npub`:**

1. **Keep existing admin keys** in the config
2. **Add `bootstrap.mode: 'admin-only'`** — no new pubkey registration
3. **Browser keygen becomes opt-in** — add "Generate New Key" button in settings for admins who want browser-only access
4. **Extension migration** works the same — shows existing nsec for export

```yaml
# config.yaml for existing deployment
bootstrap:
  mode: 'admin-only'  # Only existing admins can register devices
admin_pubkeys:
  - "npub1existingadmin..."
  - "npub1anotheradmin..."
```

---

## 8. Effort Estimate

| Component | Effort | Notes |
|-----------|--------|-------|
| KeyVault class + crypto utils | 1 day | Web Crypto + IndexedDB + NIP-07 shim |
| Onboarding UI (3 screens) | 1.5 days | Responsive design, animations, error states |
| Agent: pubkey registration | 0.5 day | Simple endpoint, config update |
| Migration UI | 1 day | Key display, instructions, verification |
| Backup/restore flow | 0.5 day | Import/export, password validation |
| Tests (Playwright) | 0.5 day | Happy path, edge cases, error cases |
| Documentation | 0.5 day | User guide, security notes |
| **Total** | **~5 days** | Full end-to-end implementation |

---

## 9. Rollout Plan

### Week 1: Core Implementation
- [ ] KeyVault class with browser keygen
- [ ] Basic onboarding UI (welcome → password → complete)
- [ ] Agent pubkey registration endpoint
- [ ] Playwright tests for happy path

### Week 2: Migration + Backup
- [ ] Extension migration flow
- [ ] Encrypted backup/restore
- [ ] Settings page integration
- [ ] Migration tests

### Week 3: Polish + Documentation
- [ ] Responsive design fixes
- [ ] Error handling edge cases
- [ ] User documentation
- [ ] Deployment guide

---

## 10. Success Metrics

- **Onboarding completion rate:** >90% of first-time users
- **Extension migration rate:** Track opt-in via analytics (if added)
- **Support tickets:** "Lost key" incidents should decrease with encrypted backup
- **Engagement:** More daily active users due to lower friction

---

## Conclusion

Browser keygen with optional extension migration delivers the best of both worlds:

- **Zero friction at first login** — no setup required
- **Clear upgrade path** to better security when users are ready
- **Self-custody from day one** — key never touches server
- **Recovery friendly** — encrypted backup prevents key loss

This is the standard approach for modern web3 apps (Snort, Coracle, etc.). It aligns with user expectations for instant access while preserving the ability to "level up" to proper hardware-level security.