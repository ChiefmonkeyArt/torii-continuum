---
title: Schedule Browser Keygen Hybrid Onboarding Tasks
date: 2026-07-07
---

# Kanban Board: Browser Keygen Hybrid Onboarding

## Scheduled Tasks

Based on the implementation plan in `.hermes/plans/2026-07-07_browser-keygen-hybrid-onboarding.md`

### 🎯 Phase 1: Core Implementation (Week 1)

#### Task 1.1: Implement KeyVault Class
**Description:** Browser key vault with Web Crypto, IndexedDB, and NIP-07 shim
- Generate nsec in browser using crypto.getRandomValues()
- Store encrypted in IndexedDB with password (AES-256-GCM + PBKDF2)
- NIP-07 shim: window.nostr = { getPublicKey, signEvent }
- Key export/import functionality
**Estimated effort:** 1 day
**Dependencies:** None
**Assign to:** @worker-front-end
**Priority:** High
**Status:** To Do

#### Task 1.2: Basic Onboarding UI
**Description:** Three-screen onboarding flow (welcome → password → complete)
- Welcome screen with password input
- 12-word backup phrase display with checkbox confirmation
- "Download Encrypted Backup" option
- Redirect to app on completion
**Estimated effort:** 1.5 days
**Dependencies:** KeyVault class
**Assign to:** @worker-front-end
**Priority:** High
**Status:** To Do

#### Task 1.3: Agent Pubkey Registration Endpoint
**Description:** Agent endpoint to register any pubkey as admin (not just hardcoded)
- `POST /api/auth/register-pubkey`
- Config: `bootstrap.mode: 'open'` and dynamic admin_pubkeys list
- Authentication: first user is admin, subsequent require auth
- Signature verification to prove pubkey ownership
**Estimated effort:** 0.5 day
**Dependencies:** None
**Assign to:** @worker-back-end
**Priority:** Medium
**Status:** To Do

#### Task 1.4: Playwright Happy Path Tests
**Description:** End-to-end tests for onboarding flow
- Generate key → save backup → login → logout
- Test error cases: short password, no checkbox
- Test with actual agent endpoint
**Estimated effort:** 0.5 day
**Dependencies:** Onboarding UI + Agent endpoint
**Assign to:** @worker-qa
**Priority:** Medium
**Status:** To Do

### 🎯 Phase 2: Migration + Backup (Week 2)

#### Task 2.1: Extension Migration Flow
**Description:** UI to migrate browser key to signer extension
- "Migrate to Extension" button in settings
- Key display (nsec) with copy button
- Instructions for nos2x-fox (Firefox) and Amber (Android)
- QR code for mobile scan
- Verification that extension has the key
**Estimated effort:** 1 day
**Dependencies:** KeyVault class
**Assign to:** @worker-front-end
**Priority:** Medium
**Status:** To Do

#### Task 2.2: Encrypted Backup/Restore
**Description:** Export and import encrypted key backups
- KeyVault.exportEncrypted(password)
- KeyVault.importEncrypted(backup, password)
- Restore UI: upload backup file + password input
- Error handling: wrong password, corrupted file
**Estimated effort:** 0.5 day
**Dependencies:** KeyVault class
**Assign to:** @worker-front-end
**Priority:** Medium
**Status:** To Do

#### Task 2.3: Settings Page Integration
**Description:** Integrate key management into existing settings page
- Add "Key Management" section
- Links to migration and restore flows
- Display current pubkey
- Option to generate additional keys (if multi-key support)
**Estimated effort:** 0.5 day
**Dependencies:** Migration + Backup flows
**Assign to:** @worker-front-end
**Priority:** Low
**Status:** To Do

#### Task 2.4: Migration Tests
**Description:** Test extension migration and restore flows
- Test migration: show key → import → verify → complete
- Test restore: upload backup → wrong password → correct password
- Test with mock extension
**Estimated effort:** 0.5 day
**Dependencies:** Migration + Backup UI
**Assign to:** @worker-qa
**Priority:** Medium
**Status:** To Do

### 🎯 Phase 3: Polish + Documentation (Week 3)

#### Task 3.1: Responsive Design Fixes
**Description:** Make onboarding/migration UIs mobile-friendly
- Test on mobile devices
- Adjust layouts for small screens
- Touch-friendly buttons and inputs
- Consistent spacing and typography
**Estimated effort:** 0.5 day
**Dependencies:** All UI components
**Assign to:** @worker-front-end
**Priority:** Low
**Status:** To Do

#### Task 3.2: Error Handling Edge Cases
**Description:** Handle edge cases gracefully
- Network errors during key generation
- IndexedDB quota exceeded
- Corrupted encrypted backup
- Extension not found during migration
- Clear error messages with retry options
**Estimated effort:** 0.5 day
**Dependencies:** All flows
**Assign to:** @worker-front-end
**Priority:** Medium
**Status:** To Do

#### Task 3.3: User Documentation
**Description:** Write user guide for onboarding and key management
- "Getting Started with Continuum" guide
- "Migrating to a Signer Extension" tutorial
- "Restoring from Backup" instructions
- Security best practices
**Estimated effort:** 0.5 day
**Dependencies:** Implementation complete
**Assign to:** @worker-docs
**Priority:** Low
**Status:** To Do

#### Task 3.4: Deployment Guide
**Description:** Document deployment changes for existing installations
- Config changes: bootstrap.mode and admin_pubkeys
- Migration from hardcoded admin_npub
- Rollback procedure
- Monitoring and logging
**Estimated effort:** 0.5 day
**Dependencies:** Agent endpoint complete
**Assign to:** @worker-devops
**Priority:** Low
**Status:** To Do

---

## 📋 Overall Schedule

| Week | Phase | Key Milestones |
|------|-------|----------------|
| Week 1 | Core | KeyVault class, Onboarding UI, Agent endpoint, basic tests |
| Week 2 | Migration/Backup | Migration flow, backup/restore, settings integration |
| Week 3 | Polish | Responsive design, error handling, documentation |

---

## 🎯 Success Criteria

- **Onboarding completion rate:** >90% of first-time users complete keygen and login
- **Extension migration rate:** Track how many users migrate (add analytics if desired)
- **Support tickets:** "I lost my key" incidents should decrease by >50%
- **Engagement:** Daily active users should increase by >20% due to lower friction

---

## 🔄 Dependencies

- Frontend tasks depend on KeyVault class completion
- Agent tasks are independent
- QA tasks depend on corresponding UI/endpoint completion
- Documentation depends on full implementation

---

## 📝 Notes

- All tasks should follow TDD: write failing test first, then implement, then verify
- Commit frequently with clear messages
- Cross-link pull requests to kanban tasks
- Update task statuses as work progresses
- Any blockers or delays should be flagged immediately

---
*Tasks scheduled based on implementation plan: .hermes/plans/2026-07-07_browser-keygen-hybrid-onboarding.md*