# Routstr falls back automatically

Date: 2026-11-11. Status: **Accepted** 2026-11-11 (owner request: "take out the
local ai llm for now and make it optional... we are better off (for now) making
a more routstr solution so that it doesn't just try and use the main provider
but can jump to the other routstr providers when we need a fallback,
automatically"). Target: Continuum `v0.2.209-alpha`, with Suite
`v0.9.64-alpha` (Ollama optional, Suite docs/adr-0003-ollama-optional.md).

Amends `docs/adr-routstr-streaming-payment.md` (§2 only: when a second
provider may be paid in the same turn) and `docs/adr-routstr-turns-dont-hang.md`
(§2: a failed provider no longer waits for the next message). Supersedes one
clause of `docs/adr-live-chat-model-selection.md`: "An unavailable explicitly
chosen model returns a clear error rather than silently selecting…". The
clear error stays when the fallback is turned off; with it on (the default),
another model answers and the reply says so. Nothing is ever switched
silently.

## Evidence

- Live catalog check, 2026-11-11: two providers (routstr.otrta.me and
  api.nonkycai.com) serve `deepseek-v4-flash` and `deepseek-v4.1-flash`;
  roustr.nobios.ai and api.routstr.com (the onboarding default) returned 502.
- The candidate loop already walks every provider serving the chosen model,
  cheapest first, with failing ones resting (v0.2.208). But in bearer mode any
  failure returned `payment_recovery_required` with `retryable: false`, so the
  turn stopped at the first provider even when its refund had fully settled.
- `fallbackLadder()` existed but was never called, and was off by default.
- An open claim at one provider blocked every new deposit at every provider,
  so a single stuck provider stopped all chat.
- The wallet holds minibits and coinos. Providers list their accepted mints at
  `GET /v1/info`; neither live provider takes coinos. Payments were sent from
  whichever mint came first, so a coinos token could go to a provider that
  cannot redeem it.
- The local Ollama fallback costs 1.8 GB of disk on a 15 GB server and is
  slower and weaker than any Routstr model.

## Decision

1. **Order of attempts.** The chosen model on every provider that serves it
   (cheapest first, resting providers last), then each model in
   `routstr.fallback.chat` (default `deepseek-v4.1-flash`,
   `deepseek-v4-flash`, at most 4 ids) on every provider that serves it. At
   most **6 paid attempts per turn**. The existing turn budget and the sats
   allowance (one per-request ceiling per attempt) still apply. Fallback is on
   by default; `routstr.fallback.enabled: false` restores the old behaviour.
2. **When the next provider may be paid in the same turn.** Only when all of:
   no part of the reply has been shown to the owner; the failure was the
   provider's (timeout, stall, 5xx, empty, network); and, in bearer mode, the
   balance at the failed provider settled (refunded or confirmed empty). A
   payment that never left the wallet (wallet short, mint mismatch, rollback
   before dispatch) also allows the next provider. An unsettled claim stops
   the turn as before.
   An open claim at a provider blocks new deposits **at that provider only**.
   Deposits elsewhere are allowed while at most **2** open claims exist at
   other providers, and never past the existing cap of 8 records. This bounds
   sats held by providers at 2 × `max_sats_per_request` beyond the current
   turn.
3. **Mint-aware payment.** The catalog read also reads `GET /v1/info` (same
   timeout, no redirects, 64 KiB cap, up to 20 mints). A provider that lists
   mints and shares none with the wallet is skipped before any payment. Payment
   to a provider that lists mints is drawn only from those mints. A provider
   that does not say is treated as before.
4. **Honest replies.** When a reply comes from a different provider or model
   than the first choice, the result carries `routstr_fallback {model,
   provider, from_model, from_provider}` and the chat shows "answered by X via
   Y — Z was unavailable". Provider names come from untrusted Nostr
   announcements and are reduced to plain text (letters, digits, `. _ : / -`,
   60 characters) on the agent and again in the browser.
5. **Local model optional.** `ollama.enabled` defaults to false in
   `config.example.yaml`. The Suite installs Ollama only when
   `INSTALL_OLLAMA=1` and can remove it with the `ollama_remove` stage, which
   also writes `INSTALL_OLLAMA=0` so no later deploy reinstalls it.

## Consequences

- One stuck or slow provider no longer ends a turn when another can answer.
- Up to 2 extra open claims can exist at once; their sats stay recoverable by
  the existing minute-tick settle and the Routstr page.
- The first catalog read makes one extra small request per provider.
- The owner-chosen model can be answered by another model; the note says so
  every time.

## Tests

`agent/test/routstr-provider-fallback.test.js`,
`agent/test/wallet-send-mints.test.js`, updated cases in
`provider-quarantine.test.js`, `routstr-payment.test.js`,
`routstr-turns.test.js`, and `src/chat-routstr-fallback.test.js`.
