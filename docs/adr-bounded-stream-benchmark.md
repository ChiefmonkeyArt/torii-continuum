# ADR: bounded operator-approved streaming comparison

Date: 2026-09-24. Scope: diagnostic tooling only.

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
