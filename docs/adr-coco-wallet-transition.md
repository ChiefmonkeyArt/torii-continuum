# Coco wallet transition and chat recovery

Status: preparation only. No funds, seeds, proofs or wallet format migrate in
v0.2.189. Existing payment approvals, request limits and recovery guards remain.

## Diagnosis and immediate boundaries

The 2026-10-28 DeepSeek V4 Flash attempt lasted 45,450 ms against a 45,000-ms
configured timeout. A new encrypted 1-sat Bartly claim remains alongside the
two explicitly quarantined historical claims. The old error discarded the
underlying failure category, so this evidence cannot distinguish provider
silence from an incomplete stream. Do not claim that replacing the wallet fixes
upstream inference. The baseline is v0.2.188-alpha at
88f064a148754379a17bdec2000eca2e31df16a1.

Runtime evidence:
https://github.com/ChiefmonkeyArt/torii-quest/actions/runs/40791078188

Preserve encrypted claims and disputed funds; never delete a recovery record
to unblock chat. Keep the global unresolved-payment guard until explicit
operator-approved isolation or verified recovery. Never auto-resend after
an ambiguous funded request. On 2026-10-29 the owner approved isolating Bartly
while preserving its claim and one same-model probe with a gross 2-sat ceiling
including fees. This is not a wallet migration or an unlimited test budget.

## Immediate reliability changes

Completed SSE answers get a bounded 100-ms tail for optional usage, rather than
waiting for a proxy to close its socket. Incomplete answers still fail. Funded
timeouts remain non-retryable; sanitized failure categories and recovery counts
improve diagnosis without revealing credentials or replies. Encrypted payment
journals use the existing atomic write mode.

The one-shot recovery probe inherits daemon isolation and durable run-id
protection. It makes at most one 1-sat deposit and rejects unknown or excessive
mint input fees before swapping, using a conservative total-debit ceiling of
2 sats. These changes do not alter the live model, human keys or normal budget.

## Target architecture

Use Coco as the shared Cashu engine, not a second independent copy of the same
spendable proofs. Align with Plebeian's reviewed version and storage/recovery
contracts once its lifecycle branch is accepted:
https://github.com/PlebeianApp/market/pull/1387
https://cashubtc.github.io/coco/starting/start-here.html

- Human wallet: owner-controlled Coco wallet with Lightning mint/melt support.
  The npub labels and authorizes the owner; it is not a spend secret or recovery
  seed. Human nsec, wallet seed and passwords never enter the clanker's context.
- Agent allowance: a separate, explicitly funded, bounded Cashu balance for
  normal approved chat. Signing in does not authorize unlimited withdrawals
  from the human wallet. Retain per-request caps and expose an enforceable
  period allowance before enabling automatic top-ups.
- Storage: browser IndexedDB is not a VPS wallet database. Select and test a
  Coco-supported durable server adapter, atomic transactions, single-writer
  locking, restart recovery and private backups before replacing the current
  server JSON store. Do not copy browser proofs onto a server.
- Recovery: distinct user-visible states for spendable funds, pending Lightning
  top-ups, active reservations, provider refunds and retained disputes. A zero
  balance or timeout must never erase pending obligations.
- Transport: Cashu and Lightning compatibility is necessary but not sufficient.
  Test provider bearer funding, deterministic identity, sub-sat dust,
  reservations, refund replay, shortened keysets and mint fees separately.
- Portability: engine/storage adapters independent of VPS service management,
  Start9 packaging and mobile UI. Each operator owns configuration and approves
  updates; no shared developer credentials or mandatory hosted wallet service.

## Migration gates

1. Pin/review the same Coco release as Plebeian; keep changes to Plebeian read-only.
2. Define adapter contract: balance, mint quote/status/claim, receive,
   prepare/commit send, reservation state, recover and export inventory.
   Distinguish not-dispatched rollback from uncertain post-dispatch recovery.
3. Offline fault tests: interrupted write/restart, duplicate claim, concurrent
   tabs/processes, stale quote, mint offline, fees, spent proofs, provider timeout,
   replayed refund and dust. No unknown outcome may become spendable twice.
4. Read-only inventory and encrypted backup of current wallet and every claim.
   Verify restoration in isolation before an owner-approved transfer.
5. Canary with separately approved small funds, then reconcile per mint and
   outstanding obligations. Never run two spend engines over the same proofs.
6. Cut over only after acceptance. Rollback must restore code safely without
   resurrecting spent proofs; reconciliation, not copying an old wallet file,
   is the recovery boundary.

## Routstr screen

Primary: live Balance, Top Up, current Model and enforced per-request limit.
Secondary Advanced: Lightning connection, usage and clearly labelled local
preferences. Recovery stays discoverable; remove mock connection/disconnect
controls from the real wallet. Coco controls appear only once implemented.
