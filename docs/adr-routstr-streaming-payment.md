# ADR: opt-in per-request bearer payment for real streaming

Status: v0.2.181-alpha deployed; fractional-remainder amendment v0.2.182-alpha.
Date: 2026-09-24.

## Evidence

The owner's expanded timings showed provider search 0.0s, payment 0.4s,
provider waiting 13.5s, 54 content events in 5 transport chunks, and upstream
and browser text spread rounded to 0.0s. This locates batching before agent
consumption, not in the dock's token painting.

Routstr's published X-Cashu chat handler calls `response.aread()` before
calculating a refund and replaying the response lines. This matches the symptom;
the exact deployed remote provider revision is not established.
[Routstr upstream implementation](https://github.com/Routstr/routstr-core/blob/50d5601547b7aa01860c2ef950ef059bbf63fbea/routstr/upstream/base.py)

The alternate contract creates a balance, authenticates completions with its
bearer key, and withdraws remaining funds separately. POST creation avoids
tokens in query strings.
[Balance/refund contract](https://github.com/Routstr/routstr-core/blob/50d5601547b7aa01860c2ef950ef059bbf63fbea/routstr/balance.py)

## Decision

Add explicit `routstr.payment_mode: ephemeral_bearer`. Absent mode and
`x_cashu` retain current behavior. No automatic config migration, model change,
provider switch, human secret collection, or paid test is part of preparation.

For each ordinary signed-in chat, allocate no more than the existing request
ceiling and wallet floor permit. Create a separate provider balance with that
token, validate the returned deterministic `sk-sha256(token)` identity, stream
the unchanged model using bearer authentication, then refund the balance.
Never retain a reusable funded balance across normal turns or automatically
top it up. Sign-in authorizes ordinary chat under these existing limits; no
new per-question confirmation dialog is added. This does not authorize
unattended test inference, raising limits, signing actions or other purchases.

The legacy path and explicit mode make this a staged payment-protocol rollout,
not a cosmetic trick. No fake typing is introduced.

## Recovery and security boundary

Before remote funding, persist and flush an encrypted recovery record under
`memory/secrets/rrefund_*.enc` using the existing AES-GCM secret store and at-rest
key. Files are 0600, directory 0700. Records contain bot-owned allocated ecash,
the derived provider claim key, endpoint and amount. They are not human
passwords, Bitcoin private keys, Nostr private keys, or session login tokens.
The derived key and token remain secrets; neither may enter logs/browser/API.
Use the existing dedicated `secretstore_key` for rotation-safe deployments.
Keeping claims in the existing secret-store directory preserves its gitignore,
backup, health-check and key-rotation boundaries.

- Pre-dispatch persistence failure may roll back. After dispatch, never roll
  back, replay funding, switch payment modes, or silently try another paid call.
- Refund attempts are bounded; redirect following is disabled; JSON response
  size is capped; remote endpoints require safe HTTPS without credentials,
  query strings, or fragments.
- Provider refunds are replayable. Failed imports retain the encrypted claim.
  Active requests are excluded from background recovery; settlement is
  single-flight. Recovery only withdraws/imports existing funds.
- Recovery runs after startup and every minute, at most eight records per
  pass. Pending older records block new deposits. Corrupt records fail closed.
- A successful answer may show a pending-refund warning in timing details.
  The displayed spent amount remains conservative until settlement.
- No-balance is accepted only for the contract's exact HTTP 400 message;
  in-flight, unknown and malformed responses remain pending. Verified dust
  follows the amendment below.

Known limits: wallet allocation already has a crash window between removing
proofs and returning its token; this change does not claim to eliminate it.
A crash after a successful wallet import but before record deletion can leave
an already-redeemed refund requiring reconciliation. An unknown deposit,
provider-version mismatch, or unverified dust remains blocked for operator
review rather than silently risking another payment. DNS-resolution policy is
the existing provider boundary, not a new DNS-pinning claim.

## UI and acceptance

On 2026-09-23 the operator approved the one-time rollout, not paid automated
test messages. VPS-side discovery found DeepSeek on GitHappens2Routstr and
Privacy Maxi. Both rejected empty POST balance creation with the expected 422
missing `initial_balance_token`, and unauthenticated refunds with 401; no funds
or credentials were supplied. The primary provider's published OpenAPI reports
`0.4.7+g2e9f550`, POST body creation and bearer refunds. Source at its declared
revision confirms the deterministic balance identity, separate incremental
bearer streaming and persisted refund replay. These checks validate the
declared contract, not a paid end-to-end acceptance test.
[Provider preflight](https://github.com/ChiefmonkeyArt/torii-quest/actions/runs/35804718931)
[Declared revision](https://github.com/Routstr/routstr-core/commit/2e9f550e344922acd86772fe1cd2c8a6d4cd2e9e)

The primary provider describes itself as experimental and recommends X-Cashu
for immediate refunds. The bearer flow therefore retains fail-closed recovery;
API presence does not remove third-party custody or operational risk.

The release workflow's optional payment-mode input uses a reviewed helper:
reject unknown modes, YAML errors, symlinks and public backup directories;
back up the entire private configuration outside git; compare all non-mode
fields; preserve ownership; atomically replace and flush. Restart/health
failure restores the previous mode. No in-app per-question approval is added.

Replace the tiny waiting dot with a contrasting status panel, real elapsed
seconds, motion respecting reduced-motion settings, explicit no-text-yet
feedback, and a disabled duplicate-submit button. Completion, errors and
sign-out restore normal controls. Progress is descriptive, not a percentage.

Mocked contract tests must prove text before EOF and refund, unchanged
DeepSeek identifier, one deposit, independent refund, no post-dispatch
rollback/redeposit, encrypted recovery, restart recovery, bounded responses,
unsafe-target rejection and duplicate settlement protection. Existing auth,
thread isolation, legacy payment, refund and ops tests must remain green.

Production reached v0.2.181-alpha through merged PR #217 and its matching tag.
The selected providers' declared POST creation/refund contracts have been
checked without payment. Live paid acceptance must be an owner-initiated
chat or an explicitly approved bounded test, never inferred from mocks.

## Fractional remainder amendment (v0.2.182-alpha)

Read-only inspection found the owner-triggered request had left 617 msats from
a 1-sat allocation, zero reserved, one model request and 383 msats spent.
The recurring refund returned unrefundable dust and every later turn was
blocked before payment. This was a protocol-model mismatch: a whole-sat
Cashu wallet cannot import less than one sat.
[Live balance evidence](https://github.com/ChiefmonkeyArt/torii-quest/actions/runs/36023790441)

Only HTTP 400 with exact `Balance too small to refund` plus GET
`/v1/balance/info` confirming the same derived API identity, reserved exactly
zero and safe-integer balance 1–999 msats permits archival. Any other status,
body, missing field, identity mismatch, reservation or balance remains pending.
The balance lookup uses the existing credential at its recorded HTTPS endpoint,
with redirects disabled, timeout and response-size bounds; it does not fund.

Write and fsync `rdust_<same-id>.enc` in the existing encrypted secret store,
including the original claim, amount and archive timestamp, before removing
the active `rrefund_` entry. Any storage failure keeps the active claim blocking.
Archived claims remain in backups and the existing at-rest-key/health boundary.
They are not polled every minute, topped up, reused, or automatically deleted.
No human private keys or passwords are introduced.

Cost accounting deliberately keeps the entire unrefunded allocation as spent.
The UI separately labels the exact fractional remainder as unrefundable with
claim retained. This is not a promise that a third-party provider preserves
balances forever or can later redeem them. Per-request ceilings and floors
remain unchanged; no new automatic payment or per-question prompt is added.

Tests include the live 617-msat case, restart recovery without spending,
encrypted archive permissions, archive/removal failures, invalid identity and
amounts, unknown info errors, sequential owner turns and preserved DeepSeek.
Paid end-to-end streaming acceptance remains outstanding.
