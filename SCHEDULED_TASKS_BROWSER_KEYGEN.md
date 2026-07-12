BROWSER KEYGEN HYBRID ONBOARDING — SCHEDULED TASKS

=====================================================================
PHASE 1: CORE (2 days)
=====================================================================

Task 1.1: KeyVault class (src/lib/stores/keyVault.ts)
• Generate nsec in browser (Web Crypto)
• Encrypt with PBKDF2 + AES-256-GCM
• NIP-07 shim for signing
• IndexedDB storage
• Estimated: 4 hours

Task 1.2: Onboarding UI (src/views/Onboarding.svelte)
• Welcome screen → password → backup phrase → complete
• Responsive design
• Copy/backup/QR code actions
• Estimated: 6 hours

Task 1.3: Agent pubkey registration (agent/routes/onboarding.go)
• Dynamic admin pubkeys (not hardcoded)
• POST /api/onboarding/register
• Config reload
• Estimated: 2 hours

Task 1.4: Happy path tests (tests/playwright/onboarding.spec.ts)
• Keygen → login → complete flow
• Basic error cases
• Estimated: 2 hours

=====================================================================
PHASE 2: MIGRATION + BACKUP (2 days)
=====================================================================

Task 2.1: Extension migration UI (src/views/KeyMigration.svelte)
• Show nsec + import instructions
• Verify extension has the key
• QR code for Amber/mobile
• Estimated: 4 hours

Task 2.2: Encrypted backup/restore (src/views/Restore.svelte)
• Export vault as encrypted JSON
• Import from backup file
• Password validation
• Estimated: 3 hours

Task 2.3: Settings integration + polish
• Add "Migrate to Extension" in settings
• Mobile responsive fixes
• Error states + edge cases
• Estimated: 5 hours

Task 2.4: Comprehensive tests
• Migration flow + backup/restore
• Error cases (wrong password, invalid backup)
• Estimated: 2 hours

=====================================================================
PHASE 3: DOCUMENTATION (1 day)
=====================================================================

Task 3.1: User documentation (docs/onboarding.md)
• Onboarding guide for users
• Security notes (backup importance)
• Troubleshooting
• Estimated: 3 hours

Task 3.2: Developer docs (docs/HYBRID_ONBOARDING_ARCHITECTURE.md)
• Technical architecture decisions
• Security model
• Deployment notes
• Estimated: 2 hours

Task 3.3: Final review + deployment
• Integration testing on VPS1
• Performance review
• Final polish
• Estimated: 3 hours

=====================================================================
TOTAL: ~5 days
=====================================================================

SUCCESS METRICS:
• Onboarding completion rate >90%
• Support tickets for "lost key" reduced by 70%
• Daily active users increase by 30%

DEPENDENCIES:
• None — standalone feature
• Compatible with existing agent
• No breaking changes

NEXT STEPS:
1. Start with Task 1.1 (KeyVault class)
2. Follow order in phases
3. Update this plan as tasks complete

==================================================================
