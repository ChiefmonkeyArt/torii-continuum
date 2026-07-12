# Kanban Board: Browser Keygen Hybrid Onboarding

## Project: continuum-ui (Frontend)

### Phase 1: Core Implementation (Ready)
- [ ] Task 1: KeyVault class implementation
  - Description: Implement browser key vault using Web Crypto API
  - File: `src/lib/stores/keyVault.ts`
  - Worker: worker-ts-browser
  - Priority: High
  - Story points: 3

- [ ] Task 2: Crypto utilities
  - Description: Helper functions for encryption, key derivation, hex conversion
  - File: `src/lib/cryptoUtils.ts`
  - Worker: worker-ts-browser
  - Priority: High
  - Story points: 2

- [ ] Task 3: KeyVault tests
  - Description: Unit tests for key generation, encryption, NIP-07 shim
  - File: `tests/unit/keyVault.test.ts`
  - Worker: worker-ts-browser
  - Priority: Medium
  - Story points: 2

### Phase 2: UI Implementation (Ready)
- [ ] Task 4: Onboarding welcome screen
  - Description: First visit onboarding UI with password input
  - File: `src/views/Onboarding.svelte`
  - Worker: worker-ts-browser
  - Priority: High
  - Story points: 3

- [ ] Task 5: Backup phrase screen
  - Description: 12-word backup phrase display and verification
  - File: `src/views/Onboarding.svelte` (continued)
  - Worker: worker-ts-browser
  - Priority: High
  - Story points: 2

- [ ] Task 6: Complete onboarding flow
  - Description: Final screen with redirect to app
  - File: `src/views/Onboarding.svelte` (continued)
  - Worker: worker-ts-browser
  - Priority: Medium
  - Story points: 1

### Phase 3: Migration & Backup (Ready)
- [ ] Task 7: Extension migration UI
  - Description: Screen to show private key and guide import to extension
  - File: `src/views/KeyMigration.svelte`
  - Worker: worker-ts-browser
  - Priority: Medium
  - Story points: 3

- [ ] Task 8: Encrypted backup flow
  - Description: Export/import encrypted backup functionality
  - Files: `src/views/Restore.svelte`, `src/lib/backup.ts`
  - Worker: worker-ts-browser
  - Priority: Medium
  - Story points: 2

- [ ] Task 9: Settings integration
  - Description: Add key management options to settings page
  - File: `src/views/Settings.svelte`
  - Worker: worker-ts-browser
  - Priority: Low
  - Story points: 1

---

## Project: continuum-agent (Backend)

### Phase 1: Core Implementation (Ready)
- [ ] Task 10: Dynamic pubkey registration
  - Description: Endpoint to register user pubkeys as admins
  - File: `agent/routes/onboarding.go`
  - Worker: worker-rust-agent
  - Priority: High
  - Story points: 2

- [ ] Task 11: Bootstrap configuration
  - Description: Config management for bootstrap mode and admin pubkeys
  - File: `agent/config/bootstrap.go`
  - Worker: worker-go-config
  - Priority: Medium
  - Story points: 1

---

## Worker Profiles

### worker-ts-browser
- **Skills**: TypeScript, Svelte, Web Crypto API, IndexedDB, Nostr tools
- **Specialization**: Frontend browser cryptography and state management
- **Task Types**: UI implementation, crypto utilities, browser storage
- **Capacity**: 3 tasks in parallel
- **Working Hours**: 09:00-17:00 UTC

### worker-rust-agent
- **Skills**: Rust, Actix Web, Nostr protocol, database operations
- **Specialization**: Backend API endpoints and business logic
- **Task Types**: API routes, request handling, verification logic
- **Capacity**: 2 tasks in parallel
- **Working Hours**: 09:00-17:00 UTC

### worker-go-config
- **Skills**: Go, YAML parsing, configuration management, system integration
- **Specialization**: Configuration file handling and system-level operations
- **Task Types**: Config file management, environment integration
- **Capacity**: 1 task at a time
- **Working Hours**: 09:00-17:00 UTC

---

## Task Assignment Rules

1. **worker-ts-browser** picks up tasks from `continuum-ui` project
2. **worker-rust-agent** picks up Task 10 from `continuum-agent`  
3. **worker-go-config** picks up Task 11 from `continuum-agent`
4. Tasks are picked based on priority (High > Medium > Low)
5. When multiple tasks have same priority, oldest task is picked first
6. Workers mark tasks as "In Progress" when starting, "Done" when completed
7. Daily standup at 10:00 UTC to review progress

---

## Current Status

**Total Tasks:** 11  
**Ready Tasks:** 11  
**In Progress:** 0  
**Completed:** 0  
**Blocked:** 0

**Next Actions:**
1. All workers should pick up their first task by EOD today
2. Phase 1 completion target: End of Week 1
3. Full implementation target: End of Week 3

---
*Last updated: 2026-07-07*