# CHANGELOG

## v0.1.22-preview - self-hosted fonts, zero third-party requests

Housekeeping release. **No auth, payment/NWC, Routstr, deck logic, character or
animation behaviour changed** — the only functional difference is where the
type faces come from.

**Fonts pulled local.** `index.html` and `inspect/index.html` no longer load the
`api.fontshare.com` stylesheet. Five faces (Cabinet Grotesk 500/700, Satoshi
400/500/700) now ship as `fonts/*.woff2` declared in a local `fonts.css`, and
the two above-the-fold faces are preloaded. That was the deck's last external
host, so the preview now makes **zero third-party requests**, matching the
production rule for `src/`. Self-hosting is permitted under the ITF Free Font
Licence. woff2 only: any browser that can run this deck (WebGL2 + ES modules)
supports woff2, so the CDN's woff/ttf fallbacks were dead weight. Font payload
is 114 KB, served from the same origin as everything else — one fewer DNS
lookup, one fewer TLS handshake, and no third party sees a visitor request.

**Mono role unchanged.** The Fontshare CDN never served JetBrains Mono (not an
ITF family), so `--font-mono` has always resolved to the system monospace
fallback. Rendering is identical before and after; nothing is self-hosted for it.

**Repository pruning (not part of the deployed artifact).** `preview-assets/`
dropped from 378 MB to 13 MB: `onboarding-v0.1.0` … `onboarding-v0.1.20` and the
obsolete `releases/` tarballs (superseded since v0.1.12, when the version
directory itself became the artifact) were removed. Current and previous
previews are retained; every deleted version remains recoverable from its
annotated release tag.

## v0.1.21-preview - "Sign in with browser extension", clearer numbered step states, README version fix

The preview half of Continuum/agent **v0.2.51-alpha**. A focused copy + wayfinding
pass on Step 1 and the step-dot navigation. **No auth, payment/NWC, Routstr, or
character/animation behaviour changed** — the v0.1.20 claimed-Routstr terminal
state (single Continue, duplicate-pay impossible) and the post-onboarding routing
to the app dashboard (`CONTINUUM_HOME = /continuum/#/dashboard`) are preserved
in `onboarding-client.js` logic.

**Step-1 signer button copy.** The primary control now reads exactly
**"Sign in with browser extension"** (was "Sign with Plebeian Signer"). The panel
lede names the extension category — Plebeian Signer, nos2x, Alby — so the
browser-extension (NIP-07) context is unambiguous, and the ghost button now reads
"Use a remote signer instead" to distinguish the NIP-46 bunker path. The
signer-not-found message is reworded to "No browser extension signer found —
install a NIP-07 extension (e.g. Plebeian Signer, nos2x or Alby)". No tracking,
no CDN, no key handling changed: secrets still never touch storage/URL/logs.

**Numbered step states.** Completed dots are now **bronze-filled** (`--bronze`,
dark numerals at 5.7:1 AA contrast) instead of a flat grey, and the current dot
gets a **brighter, thicker ring** (`--amber-bright`, 3px) plus glow so it is
unmistakably the strongest element in the strip. A dedicated
`.step-dot:focus-visible` amber outline makes keyboard focus explicit. Wayfinding
now uses three non-colour cues at once — size, fill, and ring — so it survives
colour-blindness. Desktop and mobile dot-strips both updated; no new animation,
so `prefers-reduced-motion` behaviour is unchanged.

**README version header fixed.** The v0.1.20 dir's README still read
`Version: 0.1.19-preview`; this dir's README correctly states `0.1.21-preview`.

## v0.1.20-preview - claimed Step-3 shows only Continue, duplicate-pay impossible, completion lands in the app

The preview half of Continuum/agent **v0.2.39-alpha**. A focused fix pass over
Step 3 (Routstr) and onboarding completion. No character/animation/CDN/provider
behaviour changed, and no payment/NWC semantics changed. The funded Routstr key
and all prior encrypted agent state are preserved.

**Claimed Step 3 now renders exactly one control: Continue.** The v0.1.19
`collapseStep3Setup` set `el.hidden = true` on the two path cards, both forms,
the confirm card, the progress bar, and the setup CTAs — but author CSS gave
those elements an explicit `display` (`.btn-primary{inline-flex}`,
`.wallet-choices/.routstr-paths{flex}`, `.choice-card{grid}`) which outranks the
UA `[hidden]{display:none}` in the cascade, so hiding silently did nothing and a
verified operator still saw "Verify & connect", "Request an invoice", and the
`0s` scanning bar next to the green summary. A single canonical
`[hidden]{display:none !important}` rule in `shared.css` restores the invariant.
The `routstr/status`-only resume path (which previously rendered a bare summary
without collapsing setup or offering Continue) now routes through the same
`renderSuccessAdvance` terminal render as every other verified path.

**Duplicate invoice/payment is now impossible in the claimed state.** Reaching
the verified terminal render stamps the panel `data-claimed`; the quote, key-
connect, and pay-confirm handlers all refuse to act when it is set, closing the
stale-UI / double-click race in addition to the existing permanent disable of
the one pay-confirm button.

**Completion lands in the actual app, not the marketing page.** `CONTINUUM_HOME`
and the curtain fallback link now target `/continuum/#/dashboard` (the hash-
router app dashboard) instead of the bare `/continuum/` marketing/landing
surface. Same-origin override validation is unchanged.

## v0.1.19-preview - claimed-state cleanup, correct balance units, inline key reveal, deterministic curtain

The preview half of Continuum/agent **v0.2.38-alpha**. A focused live UX/
completion pass over the wizard. No character/animation/CDN/provider-pinning
behaviour changed, and no payment/NWC semantics changed beyond how balances are
*displayed* and how the full key is safely *retrieved*. The funded Routstr key
and all prior state are preserved.

**Balance now shows real sats (was showing millisats).** Routstr denominates
wallet balances in MILLISATS, but `extractBalanceSats` surfaced the raw
`balance` field verbatim, so a 10,000-sat funded key read as "10000000 sats".
The provider adapter now converts msat fields down to whole sats (explicit
`*_sats` fields are trusted as-is). Stored envelopes written before the fix hold
msats under `balance_sats` with no unit marker; a marker-guarded
`displayBalanceSats` migration divides those by 1000 on read, while new
envelopes carry `balance_units:'sat'` and are used verbatim. Every balance is
rendered through `formatSats` (grouped, e.g. `10,000 sats`).

**Step 3 collapses to one action once verified.** When the key is claimed,
encrypted, connected and verified, the two setup-choice cards, both input
forms, the invoice-confirm card, the progress/scanning bar and all three setup
CTAs (Verify & connect / Request an invoice / Disconnect) are hidden
(`collapseStep3Setup`). What remains is one concise green verified summary
(redacted key id + correctly-labelled balance) and a SINGLE **Continue** button
placed OUTSIDE the summary box. Per the latest guidance this supersedes the old
auto-advance countdown — there is no timer; the operator steps through when
ready. Advancing stays idempotent.

**Step 5 recovery kit: branded inline reveal, no browser modals.** The old
unbranded "Reveal full Routstr key (one-time)" button and its `window.confirm`
flow (which never actually revealed the key) are gone. The ROUTSTR KEY row now
carries branded inline show/hide (eye) + copy controls. Revealing or copying
fetches the full key over the existing admin-authenticated, no-store export
endpoint; the key lives only in memory while shown and is never written to
localStorage/sessionStorage/URL/logs. It re-masks on eye toggle, on leaving the
step, on tab hide, on session loss, and after a conservative timeout
(`shouldMaskReveal` / `REVEAL_TIMEOUT_MS`). Copy gives branded inline feedback,
not a browser dialog. The **Download recovery kit** click is itself the explicit
confirmation and now embeds the full key in the saved file (treat it like cash)
while still excluding the NWC connection secret.

**Final curtain no longer hangs.** The previous curtain only `console.log`'d a
commented-out redirect, so "Your Torii is open. Stepping through…" spun forever.
`initCurtain` now navigates deterministically to the resolved same-origin
Continuum home (`/continuum/`; a `window.__toriiContinuumHome` override is
accepted only when same-origin, guarding against open redirects), reveals a real
**Open Continuum now** fallback link on a bounded timer, honours
`prefers-reduced-motion`, and drops the spinner shortly after the navigation
attempt so the screen can never appear to hang.

## v0.1.18-preview - payment progress state machine, refresh-resume, real recovery kit

The preview half of Continuum/agent **v0.2.37-alpha**. Fixes a live onboarding
incident: an operator connected NWC, paid 10,000 sats to fund a Routstr
session, and the UI said "payment confirmed" but never surfaced the key,
never auto-advanced, and the Recovery Kit "download" was a no-op that just
stepped the deck. No character/animation/CDN/provider-pinning behaviour
changed; Step 2 stays NWC-only and Step 3 stays the two-path Routstr setup.

**Payment/claim state machine (`ONBOARD_PHASES`, `PHASE_META`).**

- A single accessible progress region (role=status, aria-live) with a fill +
  scanning bar and an elapsed timer drives connect → quote → pay → claim →
  verify. The bar is fed exclusively from `phaseMeta()` so it can never
  desync from the state.
- **SUCCESS is reached ONLY when the agent reports `key_stored === true`**
  (key claimed, encrypted, AND verified). `classifyPayResult` /
  `classifyRecoverResult` map a bare "paid"/"recoverable" result to a
  retryable `PAID_UNCLAIMED` phase — the UI never claims success while the key
  is unissued. This is the root-cause fix for the incident.
- Clear success renders the redacted key, then auto-advances after a short
  countdown with an immediate **Continue now**. Advancing is idempotent.

**Duplicate-payment prevention.** The invoice Confirm button is the one payment
boundary; once clicked it is permanently disabled, so a double/late click can
never mint or pay twice.

**Refresh/restart resume (no re-payment).** On load, Step 3 reads the redacted
`recovery/state` snapshot; when `claimable` is true it finishes the claim
automatically via the idempotent `routstr/recover` (empty body → the agent
supplies the stored bolt11) — the sats are never re-spent.

**Working Recovery Kit + one-time key export.**

- The Download button now builds a real text bundle (`buildRecoveryKit`) and
  saves it via a Blob object URL — no more deck-advance no-op.
- The **default kit excludes every secret**: no NWC connection secret, no full
  Routstr key. It carries redacted previews, fingerprints, provider host,
  admin npub, and restoration instructions.
- The full key is included **only** when the operator takes the explicit,
  confirmed one-time "Reveal full Routstr key" action, which hits the admin-
  gated, rate-limited, `Cache-Control: no-store` export endpoint.
- Step 5 markup no longer statically prints secret-adjacent values.

## v0.1.17-preview - new Chiefmonkey asset, dedicated step animations + click reactions

Swaps in a new, higher-fidelity Chiefmonkey model and rebuilds the character
animation layer around a dedicated, **forbidden-safe** per-step state machine
plus interactive click reactions. This is the preview half of Continuum/agent
**v0.2.36-alpha**. No auth/wallet/Routstr behaviour changed — Step 2 stays
NWC-only and Step 3 stays the two-path Routstr setup.

**New production asset (`assets/chiefmonkey-onboarding.glb`).**

- A new source GLB (different rig + clip set) replaces `chiefmonkey6.glb`.
- Crushed by a reproducible local optimizer (`tools/optimize-glb.mjs`):
  dedup → weld → resample → WebP texture conversion (q82, ≤1024², browser-native,
  no runtime decoder) → second dedup (merges the base-colour/emissive maps that
  only become byte-identical after WebP) → prune → Draco mesh compression
  (edgebreaker, fidelity-safe quantization; joints kept lossless-ish so skin
  weights don't drift). **9,298,852 → 2,347,780 bytes (74.75% reduction).**
- No third-party runtime CDN introduced: Draco decodes via the vendored wasm
  decoder under `three-libs/draco/`, WebP by the browser itself.
- Ships a `chiefmonkey-onboarding.glb.manifest.json`: byte sizes, %reduction,
  a deterministic **SHA-256** (`0253d5e1…9e2fcb`), rig/skin/texture counts and
  the retained + dropped-forbidden clip inventory (with durations). The build
  is deterministic — re-running on the same source yields byte-identical output.

**Forbidden-clip filter (single source of truth).**

- `isForbiddenClip` / `filterForbidden` / `FORBIDDEN_CLIP_TOKENS` normalise a
  clip name to bare lowercase alphanumerics and reject every walk / run / jog /
  sprint / knock-down / fall-down spelling (robust to spaces/underscores/
  camelCase). The build DROPS these from the shipped asset (`Walking`, `Running`,
  `Clapping_Run`, `Stylish_Walk_inplace`, `Knock_Down`) using the **same**
  predicate the runtime filters every pool through — the asset and the runtime
  can never disagree, and locomotion/knock-down clips are unselectable end to end.

**Dedicated per-step animations.**

- Each live step now has one dedicated, loop-friendly clip resolved from
  `STEP_CLIPS` via `selectStepClip(step, availableClips)` against the clips the
  GLB actually ships (primary + ordered fallbacks, `Idle_10` as the universal
  floor): 1 Verify → `Talk_with_Hands_Open`, 2 Wallet → `Agree_Gesture`,
  3 Routstr → `mage_soell_cast_3`, 4 Welcome → `Gentlemans_Bow`, 5 Recovery kit
  → `Idle_10`, 6 Curtain → `Victory_Cheer`. Camera framing stays per-step in
  `character.js`; the clip choice is shared with the build and the tests, so no
  anim literal is hard-coded in the frame tables anymore.
- The step clip plays deterministically on entering/restoring a step and loops.
  Step-1 auth phases (`prompting`/`success`/`failure`) are transient overrides
  that always resolve back to the **current** step's clip, so an async
  auth/wallet/Routstr outcome or the model load order can't race or permanently
  overwrite the live step state.

**Click reactions (raycast hit-test).**

- Clicking directly on Chiefmonkey (raycast against the model in NDC space —
  not arbitrary page clicks) plays one random one-shot from a curated pool
  (`CLICK_POOL`/`pickClickReaction`: playful dance/gesture/celebration clips, no
  locomotion, no knock-down, no severe damage, never the base idle), then
  crossfades back to the current step's dedicated clip on the mixer `finished`
  event. No immediate repeat of the last reaction; ignores click-spam while a
  reaction is active; respects `prefers-reduced-motion`; and never steals a click
  aimed at a UI control (guarded via `closest('button, input, …')`). Because
  `#character` is `pointer-events:none`, the handler hit-tests a window-level
  `pointerdown` rather than relying on the canvas receiving the event.

**Tests.** The suite now parses the shipped optimized GLB and proves: every
referenced step/phase/click clip exists, clip names survive optimization,
skin/mesh/animation counts are non-zero, the manifest matches the asset, the
SHA-256 is reproducible, the size budget (≤3MB) and ≥60% reduction hold, and no
forbidden clip can ever be selected by any pool. Deterministic tests cover the
step mapping, click hit/no-hit gate, spam guard, reduced-motion, no-immediate-
repeat, and the character.js wiring.

## v0.1.16-preview - existing-wallet NWC connect + two-path Routstr setup

Reworks Step 2 (Wallet) and Step 3 (Routstr) around real, secret-safe agent
flows, replacing the earlier "spin up a local wallet / import an LNbits admin
key" mockup with a wallet-agnostic connection model. This is the preview half
of the Continuum/agent **v0.2.35-alpha** onboarding slice.

**Step 2 — connect an existing Lightning wallet (NWC only).**

- Removed the "spin up a local wallet" and "Import LNBits Admin Key" paths.
  Copy is now wallet-agnostic ("Connect your Lightning wallet", Alby / Mutiny /
  Zeus / Coinos…) and the single input takes a Nostr Wallet Connect
  (`nostr+walletconnect://…`) string.
- The NWC input is `type="password"` with an explicit **reveal opt-in**
  (`wireReveal` toggles `password`↔`text` + `aria-pressed`) and is **cleared
  from the box the instant a connect attempt returns** — success or failure —
  so the secret is never left echoed in the DOM.
- The agent validates URI structure, connects via NIP-47, calls `get_info`,
  and reports supported methods; the client renders a **capability matrix**
  (`capMatrixHtml`) and surfaces whether the wallet advertises `pay_invoice`.
  A wallet missing optional caps is *not* rejected, but Routstr **funding**
  stays gated on `pay_invoice` (`can_fund_routstr`).

**Step 3 — Routstr setup, two paths.**

- **Use an existing Routstr key**: paste an `sk-…` key (`type="password"` +
  reveal) → sent over the authenticated same-origin link; agent verifies
  balance/models/info before marking ready; only a redacted key id/fingerprint,
  balance and capability metadata come back.
- **Fund a new Routstr session**: choose sats within provider-configured
  bounds; the agent quotes a Lightning invoice via the source-grounded
  `POST /lightning/invoice` (`purpose: "create"` — fund a fresh session, no key
  yet, mints one on payment); the client renders an explicit **invoice
  confirmation boundary** (`renderConfirm` → `data-routstr-pay-confirm`) and
  pays via the connected NWC **only** after the operator confirms.
  `payRoutstrInvoice` refuses to send unless `confirm === true`, mirroring the
  agent's hard boundary. After payment the agent polls
  `GET /lightning/invoice/{id}/status` to claim the minted `sk-…` key. If the
  poll times out the sats are **not** lost: the client surfaces a recoverable
  state and a **Claim key** retry (`recoverRoutstrInvoice` →
  `POST /lightning/recover`), and routstr-core's server-side watcher credits the
  invoice regardless. The `501 { blocked: true }` degrade path remains only for
  a provider whose operator has explicitly disabled the invoice endpoint; the
  existing-key path is then used instead.

**Secret handling (client invariants).** The NWC URI and Routstr key are only
ever sent over the authenticated same-origin API and are **never** written to
`localStorage`/`sessionStorage`, the URL, logs, errors or analytics. All new
client helpers (`validateNwcUriShape`, `validateRoutstrKeyShape`,
`validateTopupAmount`, `bearerFromSession`, `connectWallet`, `walletStatus`,
`disconnectWallet`, `connectRoutstrKey`, `quoteRoutstrTopup`,
`payRoutstrInvoice`, `routstrStatus`, `disconnectRoutstr`) are pure and
dependency-injected (fetch / token / storage / bounds), so the whole flow is
unit-testable offline with no sockets or DOM. Shape validation fails closed and
`validateNwcUriShape` returns only a 12-char wallet-pubkey prefix and relay
count — never the secret.

Everything else is byte-for-byte preserved from v0.1.15: the character↔deck
sync state machine, session restore, the desktop-only gate, the self-hosted
Three.js / font policy (no production CDNs), the `onboarding-client.js`
import-free guardrail, and all prior auth-phase behavior. New offline
regressions cover NWC/key/amount validation, secret redaction, the
no-persistence invariant, the confirm boundary, the invoice quote/pay/recover
flow (including the recoverable-after-timeout path and the disabled-provider
degrade), and Step 2/3 markup guardrails.

## v0.1.15-preview - deterministic character↔deck sync (Chiefmonkey after soft reload)

v0.1.14 restored Step 2 on reload and made the GLB loader retry on error, but
Chiefmonkey still *intermittently* stayed absent after an ordinary Cmd+R soft
refresh (a hard Cmd+Shift+R always worked), even though Step 2 session restore
succeeded. A live browser diagnostic ruled out the assets: every file served
200, the GLB parsed with all 19 clips (incl. `Idle_03`), and the canvas existed
full-viewport at opacity 0. The remaining variable was **startup ordering**.

Root cause — a script/load-ordering race, not bad assets. `character.js` (an
ES module) and `deck.js` (a classic script) are injected together and execute
in a non-deterministic order relative to each other and to the async GLB load.
`deck.js` announces the desired step (including the restored Step 2) via an
`onboarding:step` CustomEvent. When that fired *before* the GLB finished
loading, the old `character.js` dropped it (its `actions` map was still empty)
and then, in `onLoaded`, hard-applied `applyStep(1)` — so the restored Step 2
and its `Idle_03` were silently reverted, and because the intended ready-state
was lost the stage could stay dark. Whether the event landed before or after
the load was pure timing, which is exactly why it reproduced only sometimes and
why a hard refresh (different fetch/preload timing) masked it.

Fix (client-only; no server, schema, validation-endpoint, or asset change):

- A tiny **pure, injectable sync state machine** in `onboarding-client.js`
  (`createCharacterSync` / `recordStep` / `resolveReadyStep` /
  `markCharacterFailed`), alongside the existing `nextLoadAttempt` /
  `selectAnimation` helpers, so the "which step to show once the model is
  ready" decision is order-independent and unit-testable with no DOM/WebGL.
- `character.js` now records every `onboarding:step` into that state. Before
  readiness the step is remembered, not dropped; on load, `onLoaded` calls
  `resolveReadyStep(sync, window.__toriiRestoredStep)` — honouring a step the
  deck already broadcast, else the restored session step (2..5) read *at ready
  time* so a late-evaluating `onboarding-client.js` is still picked up, else
  Step 1. The hard-coded `applyStep(1)` is gone. A step that arrives *after*
  readiness applies immediately. The two paths together are fully
  order-independent.
- **Explicit readiness + terminal-failure state/events**: on successful load
  `window.__toriiCharacterReady = true` and an `onboarding:model-loaded` event
  fire; on terminal give-up (retry already spent) `window.__toriiCharacterFailed
  = true` and `onboarding:model-error` fire and the sync is marked failed so no
  further step is ever applied. No artificial delay, and the UI is never hidden
  beyond the character canvas itself.

Everything else is byte-for-byte preserved: the single cache-busted retry and
`nextLoadAttempt` policy, the same-origin no-`crossorigin` preload hints
(v0.1.11), `restoreSession`/`isSessionValid` fail-closed logic, the NIP-07
primary / browser-client NIP-46 secondary flows, the "Sign with Plebeian
Signer" wording, the `localStorage['torii.session']` shape, and the three
auth-phase clips (`HandGesture_00` / `Idle_03` / `Confused_02`). New offline
regressions exercise both orderings (restore-before-load and load-before-
restore), ordinary reload / cache-hit (resolves to Step 1, no revert), and the
terminal failure branch (no step applied after give-up).

## v0.1.14-preview - restore Step 2 on reload + Chiefmonkey reappears after refresh

After a successful NIP-07 sign the deck advances to Step 2, but a plain page
refresh dropped the operator back to Step 1 and left Chiefmonkey invisible.
Two independent root causes, fixed together (client-only; no server, schema,
or validation-endpoint change):

1. **No session restore on load (Step 2 → Step 1 on refresh).**
   `onboarding-client.js` wrote `localStorage['torii.session']` on success but
   nothing ever read it back on load, and `deck.js` always hard-started at
   Step 1. Fix: `restoreSession()` reads and validates the stored session at
   module load and, when valid, sets `window.__toriiRestoredStep`; `deck.js`
   opens directly on that step. A `onboarding:advance` dispatch covers the
   reverse script-execution order, so restore is independent of the async
   module/classic load race. Validation is **fail closed** and adds no server
   surface: there is no dedicated session-validation endpoint, so
   `isSessionValid()` enforces every non-secret invariant the agent's own
   `verifySessionToken` (agent/core/auth.mjs) enforces — the exact
   `iat.exp.pubkey.sig` token shape, numeric timestamps, a not-yet-elapsed
   expiry, and that the pubkey baked into the token matches the stored
   identity. Invalid/expired/tampered sessions are removed and the operator
   restarts cleanly at Step 1. The HMAC secret is never needed or exposed in
   the browser.

2. **Chiefmonkey invisible after refresh (loader gave up on error).**
   v0.1.11 added a watchdog that retried the GLB once on an 8s *stall*, but a
   reload could make the preloaded same-origin fetch *error* outright — and
   the old `onErr` merely hid the canvas and cancelled the watchdog, so the
   retry never ran. Fix: both stall and error now route through the pure
   `nextLoadAttempt()` policy — first failure (either kind) gets one
   cache-busting retry, a second gives up rather than looping. The preload
   hints are untouched, so the v0.1.11 same-origin (no-`crossorigin`) fix that
   avoids the CORS cache mismatch is preserved.

Carries forward the v0.1.13 empty-JSON-header fix unchanged (the bodyless
`/api/auth/challenge` POST still sends no `Content-Type`). NIP-07 stays the
primary path, browser-client NIP-46 the secondary; the "Sign with Plebeian
Signer" wording, `localStorage['torii.session']` shape, and the three
auth-phase clips (`HandGesture_00` / `Idle_03` / `Confused_02`) are all
preserved. New offline regressions prove: a valid stored session restores
Step 2; an invalid/expired session fails closed to Step 1 and is cleared; and
the loader retries on both stall and error while the same-origin preloads
carry no `crossorigin`.

## v0.1.13-preview - fix "agent challenge failed (400)" on Sign with Plebeian Signer

Operator clicked "Sign with Plebeian Signer"; Chiefmonkey animated but no
signer prompt opened and the panel reported `agent challenge failed (400)`.

Root cause was in `onboarding-client.js`'s `postJson` helper, not the agent.
It always sent `Content-Type: application/json`, even for the **bodyless**
`POST /api/auth/challenge` call. The agent runs Fastify v5, whose JSON
content-type parser rejects an empty body carrying that header with
`400 FST_ERR_CTP_EMPTY_JSON_BODY` — so the very first step of the auth flow
failed before any signer was ever invoked (the NIP-07 window.nostr prompt
comes only *after* a challenge is fetched).

Fix (client-only, no server or validation change):

- `postJson` now sets `Content-Type: application/json` and serialises a body
  **only when a body is actually provided**. The challenge call goes out with
  no body and no content-type (→ 200); the verify call is unchanged and still
  sends the JSON event body.

No change to the agent, its schema, or its validation. NIP-07 stays the
primary path, browser-client NIP-46 the secondary; `localStorage['torii.session']`,
the "Sign with Plebeian Signer" wording, and the three auth-phase clips
(`HandGesture_00` / `Idle_03` / `Confused_02`) are all preserved. A new
offline regression test asserts the challenge POST carries no body and no
JSON content-type while the verify POST still does.

## v0.1.12-preview - onboarding step 1: live NIP-07/NIP-46 auth

Step 1 ("Prove you're the operator") now talks to the live same-origin
agent API instead of just advancing the deck on click.

New self-contained `onboarding-client.js` (ES module, no build step, no
third-party CDN):

- Primary path is **NIP-07** via `window.nostr` (Plebeian Signer). The
  button reads "Sign with Plebeian Signer". Flow: `POST /api/auth/challenge`
  -> build + sign the exact kind-22242 auth event the agent expects
  (`content == challenge`, `['challenge', challenge]` + `['relay', origin]`
  tags) -> `POST /api/auth/verify` -> store the session. Fails closed on
  malformed challenge/verify responses, expired challenges, pubkey mismatch,
  a signed challenge that doesn't match, or an absent token.
- Secondary path is **NIP-46** with the browser as the client (architecture
  per github.com/dsbaars/bunker46), revealed by "Use a different signer".
  The operator pastes a `bunker://` connection string; the browser parses it
  and asks the remote signer to sign the same 22242 event over the bunker's
  relay. There is **no server bunker-connect endpoint** and no key or
  connection secret is ever sent to the agent — only the final signed event
  reaches `/api/auth/verify`. It never silently falls back to NIP-07.
- Session is written to exactly `localStorage['torii.session']` as JSON:
  `{ token, expires_at, pubkey, method, created_at }` — session token +
  public identity metadata only, no secrets.

Chiefmonkey reacts to the auth phase via the existing animation channel:
`HandGesture_00` while prompting/signing, `Idle_03` on success,
`Confused_02` on failure — each with an ordered fallback to a clip that
exists in the shipped GLB, so a missing clip keeps the current animation
rather than freezing.

Preserves the desktop-only gate and every prior performance fix (self-hosted
Three.js/Draco, WebP scenes, Draco wasm preload, renderer compile,
same-origin preload cache behaviour). Terminology unchanged: "Your Torii,
your gateway"; never "Wallet" on the signer button; never "VPS" in the UI.

## v0.1.11-preview - fix reload stall + preload cache

Operator reported first-load worked fast, but browser refresh left
Chiefmonkey invisible while the scene rendered. Root cause was a
preload cache mismatch: `<link rel=preload as=fetch crossorigin>` for
same-origin assets uses CORS credentials mode, but GLTFLoader and
DRACOLoader fetch without CORS. On reload the cached preload could
not be matched to the actual request and either double-fetched or
stalled.

Fixes:
- Removed `crossorigin` from same-origin preload hints (glb, wasm).
  Added `type` attributes for accurate MIME matching.
- Removed modulepreload for GLTFLoader.js and DRACOLoader.js. Those
  import `three` by bare specifier and the raw modulepreload probe
  ran before the importmap could resolve it, throwing a harmless but
  noisy console error.
- Added a load watchdog: if the GLB stalls >8s, retry once with a
  cache-buster query so the user never sees an empty stage.

Local render times: first 1.29s, reload 1 270ms, reload 2 113ms,
reload 3 60ms.

## v0.1.10-preview - Draco wasm decoder + shader precompile

Operator reported Chiefmonkey still lagged ~10s after scene paint even
after v0.1.9's preload work. Two remaining culprits:

1. Draco was using `type: 'js'` - the pure-JS decoder, 3-10x slower than
   the wasm decoder for skinned meshes. The wasm binary was already
   shipped and preloaded, just not used.
2. First frame after model add triggered synchronous WebGL shader
   compilation for skinning (visible as tab freeze).

Fixes:
- `draco.setDecoderConfig({ type: 'wasm' })` and `draco.preload()` so
  the wasm decoder is instantiated before the GLB arraybuffer arrives.
- `<link rel=preload as=script>` for draco_wasm_wrapper.js added.
- `renderer.compile(scene, camera)` before opacity flip - shaders
  compile during the fade window, not the first animation frame.
- Fade transition 900ms -> 400ms so the character is visible sooner
  after decode.

Local render 1.85s -> 1.31s. On slow networks the improvement is larger
because wasm decode scales with mesh size while JS decode does the
whole thing on the main thread.

## v0.1.9-preview - fast load: WebP scenes + parallel preload

Operator reported the scene painted in 3 chunks and the character
appeared 30s later. Two root causes:

1. Scene PNGs were 3MB each x 5 = 14.5MB total, painted progressively.
2. Character load was serial: three.module.js (1.3MB) -> GLTFLoader ->
   DRACOLoader -> draco_decoder.wasm (188KB) -> chiefmonkey6.glb (1.2MB)
   -> decode. Every step waited for the previous.

Fixes:
- Scenes converted PNG -> WebP q82. 14.5MB -> 1.3MB total (91% smaller).
  Visually indistinguishable at page scale.
- `<link rel="preload">` for scene 1 (fetchpriority=high), the GLB,
  and the Draco wasm - all fetch in parallel with the HTML parse
  instead of after the JS import chain.
- `<link rel="modulepreload">` for three.module.js, GLTFLoader,
  DRACOLoader, and character.js - browser starts fetching modules
  before the deferred body script runs.
- Fontshare stylesheet loads with media="print" onload swap so it
  fetches without blocking first paint. Falls back cleanly via
  <noscript>.
- PNG originals moved out of the shipped tree (kept in workspace
  scenes-orig-backup-continuum for source).

Local end-to-end render measured at ~1.9s (was likely 5-10x that).

## v0.1.8-preview - character re-centered (CHAR_X_DESKTOP -0.9 -> -0.5)

Operator felt Chiefmonkey sat too far left at -0.9 world units on the
onboarding first page. Nudged to -0.5 so he lands in the left third
with breathing room to both sides while still leaving the panel clear.

## v0.1.7-preview - character canvas widened to 100vw, no more edge clipping

Chiefmonkey's canvas was `width: 50vw` on desktop, so wide-armed poses
(Idle_03 stretch, walk swings) got clipped at the 720px canvas boundary
- looking like a hand "disappearing behind" something invisible.

Fix:
- `#character` canvas now spans 100vw x 100vh
- Chiefmonkey repositioned in 3D via `CHAR_X_DESKTOP = -0.9` world units
  so he stays framed in the left third instead of centered
- `.panel` gets `z-index: 5` so hands can no longer occlude UI - if a
  gesture swings into panel space, the panel correctly sits on top
- Mobile keeps character at x=0 (already used a 100vw canvas + bottom sheet)
- `resize()` re-anchors the base x on portrait <-> landscape swaps

## v0.1.6-preview - main onboarding gets same opaque fix

The v0.1.5 opaque-material patch only landed in `/inspect/`. The main
onboarding at `/onboarding-preview/` still used the broken `character.js`
loader. Same 4-line fix applied there.

## v0.1.5-preview - clip inspector opaque-material fix

Reason 100% of clips looked shredded: the inspector wasn't patching the GLB
materials the same way torii-quest does. Chiefmonkey6's GLB ships with
`alphaMode:BLEND` on the skinned meshes; without an opaque override the
transparent pipeline draws faces out of order and the model appears to
disintegrate.

Now matches torii-quest `src/napNpc.js` v0.2.111 fix:

- `material.transparent = false`
- `material.depthWrite = true`
- `material.alphaTest = 0`
- `mesh.frustumCulled = false`

## v0.1.4-preview - clip inspector

Added `/inspect/` diagnostic page for auditing all 19 GLB animation clips.

- New page at `/onboarding-preview/inspect/` with dropdown of all clips
- Neutral grid floor + 3-light setup for even inspection
- Camera controls: distance, height, orbit yaw (sliders + mouse drag + wheel zoom)
- Playback speed 0.1x to 2.0x
- Keep / Flag verdict per clip, persisted to localStorage
- "Copy report to clipboard" exports markdown audit
- Desktop-only (shares the mobile gate from v0.1.3)
- Reuses parent Three.js from `../three-libs/`

## v0.1.3-preview — desktop-only gate

Continuum onboarding is a desktop-only flow (self-hosted Torii setup + a
desktop-only game). Rather than fight iOS WebGL quirks for a use case that
does not exist, small screens and coarse pointers are now blocked at the
door with a friendly notice.

- Added desktop-only splash shown when `matchMedia('(max-width: 899px)')` or
  `matchMedia('(pointer: coarse)')` matches
- Splash sets `data-desktop-only="blocked"` on `<html>` before any scripts
  load, so Three.js, GLTFLoader, DRACOLoader, and the character GLB are
  never fetched on mobile — respects data allowance and battery
- Reverted the v0.1.2 in-browser diagnostic overlay in `character.js` back
  to the clean v0.1.1 baseline (no `#char-diag`, no `window.error` handler)
- Self-hosted Three.js retained from v0.1.1 (privacy standing rule)
- `VERSION` bumped 0.1.1-preview → 0.1.3-preview
  (0.1.2 was diagnostic-only, never deployed)

## v0.1.1-preview — self-hosted Three.js + mobile framing attempt
- Vendored Three.js core + GLTFLoader + DRACOLoader under `three-libs/three/`
- Portrait-aware `STEP_FRAMES_MOBILE` + `orientationchange` handler
- Bolder current step dot (amber ring + soft glow)
- Root cause: even with self-hosted Three.js, GLB render still failed on
  iOS Brave. Discovery in v0.1.3: mobile is not a target use case for
  onboarding, so we gate it out instead of debugging further.

## v0.1.0-preview — first deploy
- Painterly cross-fade backdrops
- Chiefmonkey GLB per-step framing (desktop only, undiscovered)
- Frosted glass panels, amber accent, 5-step deck + curtain
- Self-hosted via nginx atomic-release-dir + symlink at
  `/var/www/torii/onboarding-preview`
