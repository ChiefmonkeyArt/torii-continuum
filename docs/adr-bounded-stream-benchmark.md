# ADR: bounded operator-approved streaming comparison

Date: 2026-09-24. Scope: diagnostic tooling only.

## Approved disputed-provider isolation, v185

After v184, refund decoding succeeded but the mint reported the retained
two-sat refund proof SPENT and wallet credit was not observed. Its spender/time
are unknown. The owner explicitly approved isolating the failed provider,
preserving its claim and finishing this comparison with DeepSeek unchanged.

`routstr.quarantined_providers` contains at most eight validated public HTTPS
origins. It defaults empty. An explicit hold prevents routing, deposits and
automatic refund polling to the origin, including path variants and legacy
fallback. Existing encrypted claims remain untouched, count toward the same
eight-record cap, and are never reported recovered. Only validated held-origin
records may be excluded from the global new-funding blocker. Unknown/corrupt
records and any non-held pending payment remain fail-closed. No automatic
quarantine, paid retry, top-up, dispatched-proof rollback or write-off is added.

The guarded config helper takes an explicitly approved origin, saves a private
exact backup, preserves unrelated fields/ownership and atomically replaces only
the quarantine list. Removing a hold requires an explicit reviewed config
change; it must not silently resume after a restart or successful catalog fetch.

The Llama control was not a measurement: it ran zero calls because the model
was at index443 in a582-model catalog capped at200 entries. Targeted benchmark
IDs now filter before the existing output cap; body/time/provider/concurrency
caps remain. Empty/incomplete benchmark plans fail instead of returning success.

The follow-up selects available priced `deepseek-v4-flash` and `qwen3-5-9b`
providers excluding held origins, alternating two trials per model. Four calls
maximum, added to the two prior paid attempts, remains within the original
six-call/12-sat allocation authorization. No claim of equal answer intelligence,
robust latency guarantees, or proven browser rendering follows from these tests.

The owner explicitly requested a speed test while retaining DeepSeek's
intelligence and low cost as a priority. Prior consent excluded unattended paid
test inference; this request authorizes this bounded comparison, not ongoing
benchmarks, a new default model, or higher spending limits.

## Method

Discover the current provider catalogue without spending. Select at most two
safe HTTPS providers serving `deepseek-v3.2`, with a priced estimate within the
diagnostic cap, and alternate two trials per provider. Use the same synthetic
120-word garden prompt, output ceiling up to the existing 2,048 tokens and no
owner memory, conversation or credentials in the prompt.

If every successful DeepSeek result is slow to first text (>3 seconds) or has
less than 200 ms of text spread, optionally test the cheapest priced
`llama-3.1-8b-instruct` provider twice. This is a speed control, not proof that
its intelligence equals DeepSeek's. Two samples are a diagnostic snapshot,
not a statistically robust service-level guarantee.

Maximum six allocations, at most min(2, configured request cap) sats each,
12 sats allocated in aggregate; mint fees may add to the wallet debit.
Existing wallet floor remains in force. Unknown prices/unsafe targets are
skipped. The normal bearer adapter performs payments and preserves encrypted
refund/dust recovery. Any failed turn or pending refund halts further tests;
there are no automatic paid retries.

Report total time, first reply-text time, text-event spread/count, underlying
transport timings, output token count, allocation/refund/dust, and wallet
before/after. A pass-through observer counts reasoning events and arrival times
without recording or displaying reasoning content. No fake typing is introduced.
No response body or private model thought text is logged in the report.

## Operational safety

Only the manual deploy workflow's explicit `benchmark: true` runs this.
Normal deploys and startup never run paid tests. The existing pinned-host SSH
deployment credentials remain inside Actions. No new key is collected.

The wallet lock is in-process, so the workflow stops `continuum-agent.service`
before running the benchmark as the `continuum` OS user, and restores service
in an EXIT trap. A six-minute outer timeout bounds interruption. This is
deliberate temporary maintenance, not a second wallet writer racing live chat.
Reports live privately in `memory/benchmarks`. A flushed exclusive run-ID marker
prevents rerunning the same workflow from charging again after partial failure.
The script requires both explicit approval and isolation environment gates.

Saved configuration, selected default model, provider strategy, spending caps,
and other applications remain unchanged. Tests exercise limits, isolation,
idempotence, redaction, sequential stopping and untouched stream bytes without
funding. Production acceptance comes from the explicitly approved live report.

A provider-direct result establishes that provider/agent segment only; it does
not prove the user's browser/proxy renders progressively. Prefer a genuinely
streaming DeepSeek provider if the measurements support it. Obtain an explicit
decision before changing a saved model or routing policy.

## First live result and follow-up

The first DeepSeek trial on GitHappens2Routstr produced 156 reasoning events,
first at 6.9 seconds and ending at 19.8 seconds. Reply text began at 19.8 seconds
and then genuinely streamed through 114 events over 7.4 seconds; total was
27.8 seconds, one sat allocated, with 731 msats retained as encrypted dust.
This identifies reasoning latency in the tested provider/agent path; it does
not exclude an additional issue in the owner's browser. One sample is limited.

The Redshift DeepSeek trial failed before completion. Its separate refund
returned a valid two-sat Cashu-B token from the configured Minibits mint using
a shortened v2 keyset identifier. Continuum's pre-whitelist decoding did not
yet have the mint keyset map and rejected it; the encrypted claim correctly
blocked further paid tests.

v0.2.184 changes only that compatibility boundary: inspect mint/unit through
metadata (which does not require keyset expansion), enforce whitelist and sat
unit, load the mint, then let its wallet decode shortened IDs against its full
keyset set and perform normal proof validation/swap. Unknown mints, non-sat
units, unmappable keysets and mint failures still reject and retain recovery.

After recovery, the benchmark's `fast_control` target runs only the cheapest
priced Llama control twice. This avoids repeating DeepSeek trials, keeps the
same prompt/metrics and does not change the saved DeepSeek model.
[First benchmark](https://github.com/ChiefmonkeyArt/torii-continuum/actions/runs/36031165417)
[Refund diagnosis](https://github.com/ChiefmonkeyArt/torii-quest/actions/runs/36032506087)
