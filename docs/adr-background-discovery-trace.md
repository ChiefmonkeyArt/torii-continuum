# ADR: preload provider discovery and trace response batching

Date: 2026-09-22. Release: v0.2.180-alpha.

## Observed problem

The owner's first v0.2.179-alpha turn showed 44.9 seconds total: discovery
27.8 seconds, payment 0.4 seconds and model waiting 16.7 seconds. The next turn
showed 8.6 seconds total, discovery 0.0 and model waiting 7.9. Both first-text
times matched total, with generation rounded to 0.0 seconds. These observations
locate much of the cold delay in discovery and suggest text reached the agent
together. They do not by themselves identify which upstream service buffered it.

## Background discovery first

- Production calls `routstr.startDiscovery()` after the HTTP listener starts.
  `buildApp()` remains free of automatic network activity in tests.
- Preloading and periodic refresh read only relay/provider/model metadata.
  They never call chat completion endpoints or allocate Cashu proofs.
- Refresh begins at 75% of the configured validity interval, default 7.5 minutes
  into a 10-minute TTL. Fresh data remains available during refresh.
- A single in-flight promise joins concurrent requests. Startup is idempotent;
  unreferenced timers stop on application close and cannot reschedule after stop.
- Failed/empty refresh retains an existing catalogue only for its original TTL.
  Expired entries are never silently returned for pricing. Failed lookups have a
  10-second negative cache; background failures retry after 30 seconds.
- Invalid refresh intervals fall back to 10 minutes; minimum is one minute.
- `ollama_only` does not start unused remote discovery.
- Cold startup before the first successful preload, an expired catalogue or
  prolonged network failure may still require discovery during a turn. Do not
  promise zero discovery latency under every condition.

No model identifier, provider ordering, payment ceiling, credential, prompt or
operator configuration is changed. Existing provider URL/redirect bounds and
catalogue concurrency limits remain in force.

## Trace the actual delivery path

Each provider attempt records bounded numeric metadata:

- Number of upstream transport reads with bytes and parsed content events.
- Time from dispatch to first body chunk and first content.
- Milliseconds between the first and last content event.
- Whether the stream reached a valid completion boundary.

The agent exposes at most 16 sanitized attempt records, plus its emitted-delta
count. The browser separately records request-to-first-event, request-to-first-text,
text-arrival spread, event count and total. No response text, reasoning,
credentials, owner identifiers or provider endpoint is added to diagnostics.

Interpretation:

- Several content events in one upstream transport chunk, with near-zero
  upstream spread: text was already grouped when Continuum consumed it.
- Upstream spread is substantial, browser spread near zero: investigate
  transport/proxy/browser buffering after the agent.
- Both spreads are substantial: progressive delivery is working.
- One short answer can genuinely arrive in one event. Do not infer deliberate
  buffering or fake a typing animation from that alone.

`Timing details` keeps the default chat view compact. Its first-text and total
summary remain visible; opening it exposes the phase and transport details.
The waiting label displays real elapsed seconds, not fabricated progress.

## Verification

Hermetic tests cover startup, deduplication, refresh-ahead timing, fresh reads
during a pending refresh, failure cooldown, expiry and shutdown. Parser tests
contrast batched and staggered chunks with deterministic clocks. Browser
measurements preserve server metrics and session guards.

A real local nginx test runs the actual streaming helper through a buffered
proxy and proves `X-Accel-Buffering: no` delivers preview before final. It skips
only where nginx is unavailable; it ran successfully in the development sandbox.
That is not a claim about a paid production provider's streaming behaviour.

Production acceptance: verify catalogue readiness after deployment, then inspect
the owner's next deliberate chat turn. No automated paid probe is required.
