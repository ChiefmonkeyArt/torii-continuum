# Routstr turns that don't hang

Date: 2026-11-10. Status: **Proposed**. Request (owner, 2026-11-10: "Do the
routstr issue", about the repeated "The AI provider took too long to reply"
errors). Target: Continuum `v0.2.208-alpha`. No Suite or Teams change. Amends
`docs/adr-routstr-streaming-payment.md` (timers and recovery only; its payment
rules stay).

## Evidence

- The owner's screenshot (2026-11-10): two good replies, then three turns in a
  row, including a one-word "gm", ended with "The AI provider took too long to
  reply. No second payment was sent. Payment recovery is pending".
- The live install uses per-request bearer payment. In that mode
  (`callBearerAt`) one timer covers the whole turn: payment, waiting, the
  model's silent thinking and the full written answer, capped at
  `routstr.limits.timeout_ms` (45 s). A reply that is still arriving at 45 s is
  cut off and reported as "took too long".
- The earlier paid benchmark (handoff v0.2.184) measured DeepSeek thinking for
  6.9 to 19.8 s before its first word. Thinking arrives as stream events the
  agent does not count as text. Twenty seconds of thinking plus a longer answer
  passes 45 s, even though the provider is working the whole time.
- Cutting a stream off mid-answer leaves the provider still holding the
  balance for that request, so the refund right after fails. That is the
  "Payment recovery is pending" on every one of those turns.
- A catalog read from here on 2026-11-10 found 50 announced providers, 25 with
  catalogs, and four serving the exact id `deepseek-v4-flash` at 263 to 281
  sats maximum. Candidates are sorted by price only, so every turn picks the
  same cheapest provider. If that provider is slow or stuck, every turn fails
  the same way, and nothing remembers it.
- A pending claim blocks the next payment until background recovery runs,
  which happens only once a minute.

The provider-side timings of those three turns are only on the VPS
(`agent/memory/costs.jsonl`). They are not read here, because this repository's
workflow logs are public.

## Decision

1. **Watch the stream, not the clock.** In bearer mode a turn is stopped only
   when the provider goes quiet:
   - no first stream event (any event, thinking included) within
     30 s (`routstr.limits.first_byte_ms`, and never more than `timeout_ms`);
   - or no new stream event for 20 s once it has started
     (`routstr.limits.idle_ms`).
   While events keep arriving, the answer may run on to the turn budget
   (`model_router.total_budget_ms`, 100 s), less 10 s kept back for the
   refund. The order browser 115 s > budget > nginx stays as it is.
2. **Remember slow providers.** After a paid attempt on a provider and model
   fails by timeout, stall, an incomplete stream, a 5xx or a network error,
   that pair rests for 10 minutes, then 20, 40 and at most 60 on repeat
   failures. One success clears it. Resting pairs move to the end of the
   candidate list, so the next turn goes to the next-cheapest provider. They
   are still used if nothing else serves the model. This is kept in memory
   only and is reset by a restart.
3. **Refund sooner.** After a stopped stream, the refund is retried once 2 s
   later if the first try is still pending. When a new turn finds an earlier
   claim pending, it tries to settle up to two such claims first, instead of
   waiting up to a minute for background recovery. It still refuses to pay
   while a claim is unresolved.
4. **Say what happened.** The error names the phase: "did not start replying
   within 30 s", "went quiet for 20 s" or "ran past the turn limit", plus "Your
   next message will use another provider" when one exists. Timings stay in
   the existing timing details.
5. **Unchanged:** no second payment in the same turn after a deposit (the
   payment ADR), the spending caps, the chosen model, quarantine and the
   legacy X-Cashu path's timers.

## Consequences

- Answers that are slow to finish but still arriving are no longer thrown
  away at 45 s.
- A dead provider is given up on in 30 s instead of 45 s, and the next turn
  avoids it.
- A turn can last up to about 90 s when the provider keeps streaming.
- A failed turn still costs a few seconds before the error, and its refund may
  stay pending as today.
- Later, if wanted: a second provider within the same turn when the first
  refund is confirmed complete. That changes the payment ADR, so it is not
  part of this decision.

## Owner check (private, on the VPS)

```
sudo tail -n 30 /apps/continuum/agent/repo/agent/memory/costs.jsonl | jq -c '{at, model, ok, duration_ms, failure_kind, refund_pending}'
```

## Tests

- A stream that keeps sending past 45 s finishes; one with no first byte stops
  at the first-byte limit; one that goes quiet stops at the idle limit;
  thinking-only events count as activity.
- Health: a failed pair moves last, rests 10 then 20 minutes, is cleared by a
  success, and is still used when it is the only one; the next turn uses
  another provider.
- Refund: one retry after a stop; a pending claim is settled before a new
  payment and the new payment then goes ahead; an unresolved claim still
  blocks.
- The error names the phase and mentions another provider only when there is
  one.
