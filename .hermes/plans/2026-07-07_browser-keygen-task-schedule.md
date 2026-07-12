# Browser Keygen Hybrid Onboarding — Task Schedule

## Overview
Implement Path C: Browser vault first, optional extension migration later.
- **Total tasks**: 24
- **Estimated effort**: 5 days
- **Priority dependencies**: KeyVault first, then UI, then agent backend

---

## Task Schedule by Phase

### Phase 1: Core Implementation (Day 1)
**Priority: CRITICAL — Foundation for everything**

#### Task 1.1: KeyVault Class (browser keygen + NIP-07 shim)
- **Board**: `continuum-ui`
- **Task ID**: `keyvault-core-001`
- **Title**: `Implement KeyVault class with Web Crypto + IndexedDB storage`
- **Assignee**: `worker-ts-browser` (TypeScript frontend worker)
- **Body**: Create KeyVault class that:
- Generates nsec in browser using Web Crypto API
- Encrypts/decrypts with PBKDF2 + AES-256-GCM
- Stores encrypted keys in IndexedDB
- Provides NIP-07 shim (getPublicKey/signEvent)
- Includes memory hygiene (zeroize buffers)
- **Dependencies**: None
- **Toolsets**: `["terminal", "file", "code_execution"]`
- **Status**: `todo` → promote to `ready`

#### Task 1.2: Crypto Utilities
- **Board**: `continuum-ui`
- **Task ID**: `crypto-utils-001`
- **Title**: `Write crypto utility functions for KeyVault`
- **Assignee**: `worker-ts-browser`
- **Body**: Implement helper functions:
- `deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey>`
- `encryptBuffer(key: CryptoKey, data: Uint8Array): Promise<{iv: Uint8Array, encrypted: ArrayBuffer}>`
- `decryptBuffer(key: CryptoKey, iv: Uint8Array, encrypted: ArrayBuffer): Promise<Uint8Array>`
- `generateMnemonic(hexKey: string): string[]` (BIP39)
- **Dependencies**: `keyvault-core-001`
- **Toolsets**: `["terminal", "file", "code_execution"]`
- **Status**: `blocked` → waiting on `keyvault-core-001`

#### Task 1.3: KeyVault Tests
- **Board**: `continuum-ui`
- **Task ID**: `keyvault-tests-001`
- **Title**: `Write unit tests for KeyVault class`
- **Assignee**: `worker-ts-browser`
- **Body**: Test coverage:
- Key generation produces valid npub/nsec
- Encryption/decryption roundtrip
- IndexedDB storage/retrieval
- NIP-07 shim functionality
- Password validation
- **Dependencies**: `keyvault-core-001`, `crypto-utils-001`
- **Toolsets**: `["terminal", "file"]`
- **Status**: `blocked` → waiting on dependencies

---

### Phase 2: Onboarding UI (Day 1-2)
**Priority: HIGH — User-facing components**

#### Task 2.1: Onboarding Welcome Screen
- **Board**: `continuum-ui`
- **Task ID**: `onboarding-welcome-001`
- **Title**: `Create onboarding welcome screen (password input)`
- **Assignee**: `worker-svelte-ui`
- **Body**: Svelte component `Onboarding.svelte` with:
- Welcome message explaining browser keygen
- Password input (min 8 chars)
- Password confirmation
- Validation and error states
- "Generate My Key" button
- Transitions/fly animations
- **Dependencies**: `keyvault-core-001`
- **Toolsets**: `["terminal", "file"]`
- **Status**: `blocked` → waiting on `keyvault-core-001`

#### Task 2.2: Backup Phrase Screen
- **Board**: `continuum-ui`
- **Task ID**: `onboarding-backup-001`
- **Title**: `Create backup phrase display screen`
- **Assignee**: `worker-svelte-ui`
- **Body**: Svelte component with:
- 12-word BIP39 mnemonic grid
- "I have saved my recovery phrase" checkbox
- Encrypted backup download button
- "Show Private Key" toggle
- Copy-to-clipboard functionality
- **Dependencies**: `onboarding-welcome-001`, `crypto-utils-001`
- **Toolsets**: `["terminal", "file"]`
- **Status**: `blocked` → waiting on dependencies

#### Task 2.3: Complete Screen
- **Board**: `continuum-ui`
- **Task ID**: `onboarding-complete-001`
- **Title**: `Create onboarding complete screen`
- **Assignee**: `worker-svelte-ui`
- **Body**: Svelte component with:
- Success message with 🎉 emoji
- Display of user's npub
- "Start Using Continuum" button
- Auto-redirect to /projects after 1s
- **Dependencies**: `onboarding-backup-001`
- **Toolsets**: `["terminal", "file"]`
- **Status**: `blocked` → waiting on dependencies

#### Task 2.4: Routing Integration
- **Board**: `continuum-ui`
- **Task ID**: `onboarding-routing-001`
- **Title**: `Integrate onboarding into app routing`
- **Assignee**: `worker-svelte-ui`
- **Body**: Update routing logic:
- Detect first visit → redirect to /onboarding
- Detect existing key → skip onboarding
- Update nav guards for protected routes
- Add /onboarding route to svelte routes
- **Dependencies**: `onboarding-complete-001`
- **Toolsets**: `["terminal", "file"]`
- **Status**: `blocked` → waiting on dependencies

---

### Phase 3: Agent Backend (Day 2)
**Priority: HIGH — Server-side pubkey registration**

#### Task 3.1: Pubkey Registration Endpoint
- **Board**: `continuum-agent`
- **Task ID**: `agent-pubkey-register-001`
- **Title**: `Create /api/auth/register-pubkey endpoint`
- **Assignee**: `worker-go-backend`
- **Body**: Go endpoint that:
- Accepts POST with `{ pubkey: string, sign_event?: Event }`
- Verifies signature if provided
- Adds pubkey to admin_pubkeys list
- Reloads agent config
- Returns JSON with status
- Validates pubkey format
- **Dependencies**: None
- **Toolsets**: `["terminal", "file", "code_execution"]`
- **Status**: `todo` → promote to `ready`

#### Task 3.2: Dynamic Admin Auth
- **Board**: `continuum-agent`
- **Task ID**: `agent-dynamic-auth-001`
- **Title**: `Update auth to accept dynamic admin pubkeys`
- **Assignee**: `worker-go-backend`
- **Body**: Modify auth middleware:
- Check pubkey against admin_pubkeys list instead of hardcoded
- Support multiple admin pubkeys
- Load pubkeys from config at runtime
- **Dependencies**: `agent-pubkey-register-001`
- **Toolsets**: `["terminal", "file", "code_execution"]`
- **Status**: `blocked` → waiting on `agent-pubkey-register-001`

#### Task 3.3: Bootstrap Config
- **Board**: `continuum-agent`
- **Task ID**: `agent-bootstrap-config-001`
- **Title**: `Add bootstrap mode configuration`
- **Assignee**: `worker-go-backend`
- **Body**: Update config.yaml:
- Add `bootstrap.mode: 'open'` | `'admin-only'`
- Add `bootstrap.max_pubkeys: int`
- Add `admin_pubkeys: [string]` list
- **Dependencies**: `agent-dynamic-auth-001`
- **Toolsets**: `["terminal", "file"]`
- **Status**: `blocked` → waiting on `agent-dynamic-auth-001`

---

### Phase 4: Extension Migration (Day 3)
**Priority: MEDIUM — Optional upgrade path**

#### Task 4.1: Migration UI
- **Board**: `continuum-ui`
- **Task ID**: `migration-ui-001`
- **Title**: `Create key migration UI component`
- **Assignee**: `worker-svelte-ui`
- **Body**: Svelte component `KeyMigration.svelte` with:
- Explanation of extension benefits
- "Show My Key" button (reveals nsec)
- Copy-to-clipboard
- QR code for Amber mobile
- Instructions for nos2x-fox
- "I've Imported It" verification
- "Keep in Browser" option
- **Dependencies**: `onboarding-routing-001`
- **Toolsets**: `["terminal", "file"]`
- **Status**: `blocked` → waiting on `onboarding-routing-001`

#### Task 4.2: Migration Verification
- **Board**: `continuum-ui`
- **Task ID**: `migration-verify-001`
- **Title**: `Implement extension migration verification`
- **Assignee**: `worker-ts-browser`
- **Body**: Add verification logic:
- Check `window.nostr` availability
- Get extension pubkey
- Compare with browser-stored pubkey
- Sign challenge to prove ownership
- Update KeyVault to mark as migrated
- **Dependencies**: `migration-ui-001`
- **Toolsets**: `["terminal", "file", "code_execution"]`
- **Status**: `blocked` → waiting on `migration-ui-001`

#### Task 4.3: Cleanup After Migration
- **Board**: `continuum-ui`
- **Task ID**: `migration-cleanup-001`
- **Title**: `Implement secure deletion after migration`
- **Assignee**: `worker-ts-browser`
- **Body**: Add cleanup functions:
- Delete key from IndexedDB
- Clear memory buffers
- Remove migration flags
- Reload app to use extension
- **Dependencies**: `migration-verify-001`
- **Toolsets**: `["terminal", "file", "code_execution"]`
- **Status**: `blocked` → waiting on `migration-verify-001`

---

### Phase 5: Backup/Restore (Day 3)
**Priority: MEDIUM — Recovery safety**

#### Task 5.1: Encrypted Backup
- **Board**: `continuum-ui`
- **Task ID**: `backup-encrypted-001`
- **Title**: `Implement encrypted backup export`
- **Assignee**: `worker-ts-browser`
- **Body**: Add to KeyVault:
- `exportEncrypted(password: string)` method
- JSON format with version, salt, iv, encrypted nsec
- Browser download with filename `continuum-backup-${npub}.json`
- **Dependencies**: `keyvault-tests-001`
- **Toolsets**: `["terminal", "file", "code_execution"]`
- **Status**: `blocked` → waiting on `keyvault-tests-001`

#### Task 5.2: Restore UI
- **Board**: `continuum-ui`
- **Task ID**: `restore-ui-001`
- **Title**: `Create restore UI component`
- **Assignee**: `worker-svelte-ui`
- **Body**: Svelte component `Restore.svelte` with:
- File upload input
- Password field
- Restore button
- Error handling for wrong password/invalid file
- Success redirect to app
- **Dependencies**: `backup-encrypted-001`
- **Toolsets**: `["terminal", "file"]`
- **Status**: `blocked` → waiting on `backup-encrypted-001`

#### Task 5.3: Restore Route
- **Board**: `continuum-ui`
- **Task ID**: `restore-route-001`
- **Title**: `Add /restore route to app`
- **Assignee**: `worker-svelte-ui`
- **Body**: Update routing:
- Add /restore route
- Update first-visit detection to check for existing key
- Add "Restore from Backup" link on login screen
- **Dependencies**: `restore-ui-001`
- **Toolsets**: `["terminal", "file"]`
- **Status**: `blocked` → waiting on `restore-ui-001`

---

### Phase 6: Testing & Polish (Day 4-5)
**Priority: MEDIUM — Quality assurance**

#### Task 6.1: Playwright Tests
- **Board**: `continuum-ui`
- **Task ID**: `playwright-onboarding-001`
- **Title**: `Write Playwright tests for onboarding flow`
- **Assignee**: `worker-playwright`
- **Body**: Test scenarios:
- Fresh install → complete onboarding
- Backup phrase visibility
- Encrypted backup download
- Extension migration flow
- Restore from backup
- Error states (weak password, wrong backup file)
- **Dependencies**: `restore-route-001`
- **Toolsets**: `["terminal", "file", "code_execution"]`
- **Status**: `blocked` → waiting on `restore-route-001`

#### Task 6.2: Mobile Responsiveness
- **Board**: `continuum-ui`
- **Task ID**: `mobile-responsive-001`
- **Title**: `Make onboarding mobile responsive`
- **Assignee**: `worker-svelte-ui`
- **Body**: Update CSS for:
- Mobile-friendly password inputs
- Responsive mnemonic grid
- Mobile-safe button sizes
- Touch-friendly interactions
- **Dependencies**: `playwright-onboarding-001`
- **Toolsets**: `["terminal", "file"]`
- **Status**: `blocked` → waiting on `playwright-onboarding-001`

#### Task 6.3: Security Audit
- **Board**: `continuum-ui`
- **Task ID**: `security-audit-001`
- **Title**: `Security audit of KeyVault implementation`
- **Assignee**: `worker-security-review`
- **Body**: Review and verify:
- Web Crypto usage best practices
- PBKDF2 iterations (minimum 100,000)
- IV randomness
- Memory zeroization
- IndexedDB security
- CSP headers for XSS prevention
- **Dependencies**: `mobile-responsive-001`
- **Toolsets**: `["terminal", "file", "search_files"]`
- **Status**: `blocked` → waiting on `mobile-responsive-001`

#### Task 6.4: Documentation
- **Board**: `continuum-ui`
- **Task ID**: `docs-onboarding-001`
- **Title**: `Write user documentation for onboarding`
- **Assignee**: `worker-docs`
- **Body**: Create documentation:
- User guide for first-time setup
- Backup instructions
- Extension migration guide
- Troubleshooting section
- Screenshots/GIFs
- **Dependencies**: `security-audit-001`
- **Toolsets**: `["terminal", "file"]`
- **Status**: `blocked` → waiting on `security-audit-001`

---

## Worker Profile Assignments

### Active Worker Profiles
- **`worker-ts-browser`**: TypeScript/frontend specialist for KeyVault and crypto
- **`worker-svelte-ui`**: Svelte component specialist for all UI components
- **`worker-go-backend`**: Go/agent backend specialist for registration endpoints
- **`worker-playwright`**: E2E testing specialist
- **`worker-security-review`**: Security audit specialist
- **`worker-docs`**: Documentation specialist

### Resource Management
- **Concurrent worker limit**: 3 (per kanban-worker-management)
- **Memory threshold**: 1500MB (emergency), 2500MB (recommended)
- **Priority tiers**: 
  - Tier 1: KeyVault implementation (always allow)
  - Tier 2: Agent backend (allow if RAM ≥ 2500MB)
  - Tier 3: Documentation/Polish (block if RAM < 3000MB)

---

## Dispatch Instructions

### Initial Setup (Run immediately)
```bash
# Create kanban boards (one-time)
hermes kanban --board continuum-ui create "Continuum UI Tasks" --body "Browser keygen onboarding UI components"
hermes kanban --board continuum-agent create "Continuum Agent Backend" --body "Agent pubkey registration and auth"

# Promote Tier 1 tasks to ready
hermes kanban --board continuum-ui promote keyvault-core-001
hermes kanban --board continuum-agent promote agent-pubkey-register-001
```

### Daily Dispatch
```bash
# Manual dispatch pass (max 3 workers at a time)
hermes kanban --board continuum-ui dispatch --max 1
hermes kanban --board continuum-agent dispatch --max 1

# Check for completed tasks
hermes kanban --board continuum-ui ls --status done
hermes kanban --board continuum-agent ls --status done

# Promote blocked tasks when dependencies complete
hermes kanban --board continuum-ui promote crypto-utils-001
hermes kanban --board continuum-ui promote onboarding-welcome-001
hermes kanban --board continuum-agent promote agent-dynamic-auth-001
```

### Monitoring
```bash
# Full overview
python3 ~/.hermes/profiles/manager/scripts/kanban_hourly_overview.py

# Stale task check (every 15 minutes via cron)
python3 ~/.hermes/profiles/manager/scripts/kanban_stale_resetter.py

# Blocked task audit (daily at 8 AM)
python3 ~/.hermes/profiles/manager/scripts/blocked_task_audit.py
```

---

## Expected Timeline

| Day | Phase | Expected Progress |
|------|-------|------------------|
| Day 1 | Core Implementation | KeyVault complete, crypto utils done |
| Day 2 | Onboarding UI + Agent Backend | Onboarding screens working, agent pubkey registration ready |
| Day 3 | Extension Migration + Backup | Migration UI ready, backup/restore working |
| Day 4 | Testing | Playwright tests written, mobile responsiveness done |
| Day 5 | Polish | Security audit complete, documentation ready |

**Total estimated completion**: 5 days (with parallel work across boards)

---

## Success Metrics

- **Onboarding completion rate**: >90% of first-time users complete the flow
- **Backup download rate**: >80% of users download encrypted backup
- **Extension migration rate**: Track opt-in (target: 30-40% within first week)
- **Test coverage**: 100% of happy path scenarios
- **Security audit**: Zero high-severity findings

---

## Notes

1. **Worktree isolation**: Each worker gets isolated worktree to prevent git conflicts
2. **Progress streaming**: All implementation workers should write progress to `/tmp/worker-progress-<task>.md`
3. **Resource gating**: Dispatch daemon monitors RAM/CPU and throttles during peak usage
4. **Fallback patterns**: If a worker times out at 300s, salvage partial work before re-dispatching
5. **Testing first**: Each UI component must have Playwright tests before being marked complete

---

*Created: 2026-07-07*
*Last Updated: 2026-07-07*
*Schedule Version: 1.0*