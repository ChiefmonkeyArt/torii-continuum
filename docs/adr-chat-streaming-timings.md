# ADR: authenticated chat previews and phase timing

Date: 2026-09-22. Release: v0.2.179-alpha. Scope: Continuum owner chat only.

## Decision

Keep `POST /api/chat` and its existing admin authentication. A request with
`stream: true` receives server-sent events over the authenticated POST fetch.
Requests without it retain the JSON response contract. Do not use EventSource
or put bearer credentials in URLs.

The agent emits `phase`, `reset`, `delta`, and one terminal `done` or `error`
event. Heartbeats keep idle connections active, but do not extend the browser
deadline. `Cache-Control: no-store` and `X-Accel-Buffering: no` prevent cached or
nginx-buffered previews. Suite v0.9.23-alpha already supplies the correct
120-second proxy timeout; this release does not alter Suite.

Routstr's existing upstream SSE is consumed incrementally. Ollama uses its
OpenAI-compatible SSE mode for streaming chat, retaining JSON for other callers.
Only `choices[0].delta.content` is displayed: hidden reasoning is never exposed.
UTF-8 and line boundaries may split anywhere. Malformed/error/truncated streams
fail instead of becoming a successful partial answer. A completion requires
`[DONE]` or a nonempty `finish_reason`; the response byte bound is 2 MiB.

## Preview is not a committed action

All code-fenced output, including split opening backticks, is held from the
preview until the existing final store-action parser has validated it. Complete
replies remain authoritative for action application and session persistence.
No partial reply is saved or sealed. The original thread and session identity
are checked for every browser event and final write. Logout aborts the browser
stream. A disconnected streaming response skips subsequent project-store
actions, but already-applied actions are not rolled back.

Provider failover emits a reset so text from two models is never stitched
together. Interruption replaces the preview with an error. No browser retry
is automatic, and no claim that an interrupted paid request was free is added.

Payments remain committed at dispatch. Stream failure never restores
potentially spent proofs; the existing refund-reclaim path is preserved.
Closing the browser does not cancel upstream accounting: existing provider
deadlines continue to bound inference while settlement can finish. No model,
provider ordering, pricing ceiling, wallet, credential or operator configuration
is changed.

## Measurements

Each request returns agent-side numeric timings and logs one `chat.timing`
record, without prompts, replies, owner identifiers, credentials or endpoints:

- `prepare_ms`: constitution resolution.
- `discovery_ms`: provider/catalog selection, including cache hits.
- `payment_ms`: wallet allocation before dispatch.
- `provider_wait_ms`: request-to-headers plus waiting for first content.
- `generation_ms`: first content until stream completion, not hidden reasoning.
- `settlement_ms`: refund receive/reclaim.
- `first_text_ms`: request-handler start to first safe preview text.
- `total_ms`: handler start to terminal result; also includes unclassified
  prompt preparation, logging, reflection and final store-write work.
- `attempts`, `provider`: number of provider attempts and most recent family.

Stage sums aggregate all attempts and need not equal total. First text includes
an earlier failed attempt if it emitted preview text; a reset makes that visible.
These are server timings, not browser/network round-trip measurements. Legacy
JSON callers have no visible preview, so first-text timing is null.

The dock shows concise phase labels while waiting and a timing breakdown beneath
the completed answer or structured failure. Rendering is coalesced to at most
20 updates per second. Streaming improves time-to-visible-text, not the
provider's underlying inference speed.

## Verification and limits

Tests use synthetic prompts, mocked providers and wallets, and a real local
HTTP socket through the actual Fastify route. They cover partial-before-final,
UTF-8 fragmentation, authentication-before-stream, error/truncation, action-fence
suppression, deferred actions, provider reset, zero-cost Ollama, refund handling,
legacy JSON, client deadline, navigation and logout isolation.

Desktop and 375px browser checks exercise the real chat dock with an explicitly
synthetic delayed stream. No paid production request is made for acceptance.
Production acceptance is the owner's next deliberately sent turn, inspecting
first text, total, phase timings and any fallback count.

The in-app update-consumer issue remains separate. Model switching, racing paid
providers, prompt compression and fast-chat routing are not part of this release.
