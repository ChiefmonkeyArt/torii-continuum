# Live owner-controlled chat-model selection

Date: 2026-09-24. Release: v0.2.186-alpha.

The owner asked to select DeepSeek V4 Flash through Routstr. The old browser
picker was not authoritative for agent calls. A live server-backed choice is
needed; installing this functionality does not itself change their model.

## Boundary

Admin-gated GET `/api/routstr/models` returns the effective chat selection, up
to 500 deduplicated priced model options, provider counts and minimum declared
input/output rates. Quarantined providers are excluded. Current/V4 Flash IDs
are prioritized before the existing per-provider 200-entry catalog output cap;
body/time/provider/concurrency limits are unchanged.

Admin-gated POST `/api/routstr/model` accepts exactly one valid model ID offered
by the current eligible catalog. It performs no funding/inference. Saves are
serialized, written privately through fsync/atomic rename, and only then applied
in memory. Failure cannot claim an unsaved selection is active. Selection lives
in the preserved `memory/chat-model.json`, not browser storage or root config.

The next chat snapshots the owner selection once. In-flight chat remains on
its existing model. Coding and other explicitly configured skills are unchanged.
An unavailable explicitly chosen model returns a clear error rather than
silently selecting a cheaper/different remote model. Existing local fallback
policy and request caps remain unchanged.

## UX and speed tests

The real Routstr card shows current model, search, a native keyboard-accessible
selector, declared rates, existing cap, explicit Save action and honest
loading/error/success states. The demo is not wired to production settings.
Selecting/saving is free; sending the next normal chat incurs existing charges.

The owner values fast complete responses over mandatory animation and accepts
the observed 7.2-second V4 Flash response. No fake typing is added. The approved
no-thinking diagnostic sets `reasoning.enabled:false` only on two known
successful provider/model pairs, at most2 sats each plus mint fees. It retains
all existing stop-on-failure, quarantine, isolation and run-idempotence controls.
Reasoning compatibility and latency must be observed, not inferred from the
parameter name. Saved model and ordinary request bodies remain unchanged.
