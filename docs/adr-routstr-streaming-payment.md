# ADR: opt-in per-request bearer payment for real streaming

Status: prepared for v0.2.181-alpha; not activated on production.
Date: 2026-09-23.

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
  in-flight, dust, unknown and malformed responses remain pending.

Known limits: wallet allocation already has a crash window between removing
proofs and returning its token; this change does not claim to eliminate it.
A crash after a successful wallet import but before record deletion can leave
an already-redeemed refund requiring reconciliation. An unknown deposit,
provider-version mismatch, or unrefundable dust remains blocked for operator
review rather than silently risking another payment. DNS-resolution policy is
the existing provider boundary, not a new DNS-pinning claim.

## UI and acceptance

Replace the tiny waiting dot with a contrasting status panel, real elapsed
seconds, motion respecting reduced-motion settings, explicit no-text-yet
feedback, and a disabled duplicate-submit button. Completion, errors and
sign-out restore normal controls. Progress is descriptive, not a percentage.

Mocked contract tests must prove text before EOF and refund, unchanged
DeepSeek identifier, one deposit, independent refund, no post-dispatch
rollback/redeposit, encrypted recovery, restart recovery, bounded responses,
unsafe-target rejection and duplicate settlement protection. Existing auth,
thread isolation, legacy payment, refund and ops tests must remain green.

Production remains v0.2.180-alpha until a separate reviewed rollout.
Before activation, confirm the selected provider supports POST balance/create
and replayable bearer refunds. Live paid acceptance must be an owner-initiated
chat or an explicitly approved bounded test, never inferred from mocks.
