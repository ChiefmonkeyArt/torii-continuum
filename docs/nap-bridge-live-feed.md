# NAP-BRIDGE — read-only world noticeboard (single replaceable event)

Status: **decided + read path AND publish surface implemented** (NAP-BRIDGE-8,
v0.2.122 read path, v0.2.124 publish surface). The operator owns publishing via the
Continuum draft → review → sign → publish flow; Nakama only reads. Follows
NAP-BRIDGE-7 (the lore layer).
The static `WORLD.md` + `TORII_LORE.md` layers give Nakama the *stable* context; this
adds the *changing* context — auctions, sales, and events — without ever letting
Nakama publish anything.

## Intent

Give Nakama current world data (upcoming auctions, sales, events) as **read-only
context** it can relay to players, while keeping a hard rule from day one: **Nakama
never publishes.** The owner is the only person who publishes; Nakama is the only
thing that reads. This inverts the normal "bot feeds the world" shape into "the world
feeds the bot, on demand."

## The one core idea: a single replaceable notice per world

Instead of a stream (many events that accumulate), each world keeps **one replaceable
noticeboard event**. When the owner wants to announce something, they *edit that one
event in place* — the new version supersedes the old. There is always exactly one
up-to-date noticeboard per world, never a growing pile.

This is the same pattern Nostr uses for profiles and for the existing gateway
heartbeat (kind `30078`, NIP-78 application-data), so the shape is already in the
crate.

## Why this cannot be spam

The four properties that kill the spam concern:

1. **Nakama never publishes** — it only *subscribes to and reads* the noticeboard. Its
   only outbound writes are its NIP-17 gift-wrapped DM replies to whoever messaged it.
2. **The operator publishes only on purpose** — a human signs an event only when there
   is something to announce. No cron, no automation, no "post every X".
3. **One replaceable event, not a stream** — editing replaces the old event; there is
   never a pile of stale announcements, and relays store one current copy, not a feed.
4. **It publishes where the owner chooses** — the owner's own world relay (and
   optionally a small directory relay), not the broad public relays. It is a local
   notice, not a broadcast to everyone's feed.

## Event shape (v1 draft)

A NIP-33 parameterized-replaceable event, author = the **operator's npub**, kind
`30078` (NIP-78 application data), `d` tag = `"noticeboard"`:

```json
{
  "kind": 30078,
  "tags": [["d", "noticeboard"]],
  "content": "{\"version\":1,\"updated_at\":1730000000,\"notices\":[ ... ]}",
  "pubkey": "<operator npub>"
}
```

`content` (a JSON object, kept small):

```json
{
  "version": 1,
  "updated_at": 1730000000,
  "notices": [
    {
      "id": "a1",
      "kind": "auction",
      "title": "Sticker pack — Torii launch set",
      "body": "Opening bid 21 sats. Closes in 48h.",
      "starts_at": 1729990000,
      "ends_at": 1730160000,
      "url": "https://chiefmonkey.art/plebeian/auction/a1"
    },
    {
      "id": "s2",
      "kind": "sale",
      "title": "Character skin — Kitsune",
      "body": "Fixed price 500 sats.",
      "price_sats": 500,
      "url": "https://chiefmonkey.art/plebeian/listing/s2"
    }
  ]
}
```

Notes for the build:

- `notices` is a small array (the noticeboard, not an archive). Old items are removed
  at edit time.
- `kind` is a free string to start (`auction`, `sale`, `event`, `announcement`) — do
  not over-spec a taxonomy before the first real data exists.
- `url` is optional but recommended: Nakama should point players at the actual listing,
  not describe a whole marketplace in a 1b model's words.

## Trust boundary: only the operator is truth

Nakama trusts **exactly one author** for the noticeboard: the operator's npub (the
same identity that owns the world). Any other event with the same `d` tag is ignored,
so an attacker cannot inject a fake "everything is on sale" notice. This mirrors the
allowlist discipline already in the gateway (NAP-BRIDGE-1).

## Publish flow (operator side)

- The operator (via Continuum/their signer, or a future operator tool) composes the
  noticeboard, signs it with their npub, and publishes to the world relay.
- Replacing the old event is automatic NIP-33 semantics: same kind + `d` + author → new
  event supersedes old.
- Nothing here runs on the nap-bridge. The nap-bridge has no publish path.

## Read flow (Nakama side)

- The nap-bridge **does not load the noticeboard at boot** (unlike the static lore,
  which is read once at startup). It fetches on demand:
  - when a player asks about auctions/sales/events, Nakama queries the relay for the
    operator's current `kind 30078` `d="noticeboard"` event, and answers from it; or
  - a small in-memory cache with a short TTL (e.g. 60s) holds the last fetch so a burst
    of questions hits the relay once, not once each.
- If no noticeboard exists, Nakama honestly says there is nothing currently listed
  (never a hallucinated auction).

## Privacy and relay targeting

The noticeboard is public-by-default (anyone on the relay can read it). If the owner
wants a private/limited audience, the natural lever is **where it publishes** — the
world's own self-hosted relay, not the public relays. Gift-wrapping the noticeboard is
possible but conflicts with "Nakama reads it freely"; keep v1 public-on-own-relay and
treat private audiences as a later concern.

## Settled decisions (NAP-BRIDGE-8)

1. **kind `30078`, `d="noticeboard"`, author = operator npub.** One replaceable
   noticeboard per operator — the author scopes the world, so there is exactly one
   truth source. Locked in code as `NOTICEBOARD_KIND` / `NOTICEBOARD_D`, with a test
   pinning both values.
2. **The operator publishes**, via the same draft → human-approve → sign discipline as
   everything in Continuum. The publish surface is the Continuum **Noticeboard** view:
   the node only *drafts* the unsigned event (`POST /api/noticeboard/draft` validates +
   writes it to the pending shelf), the operator reviews it and signs it in the browser
   (NIP-07 — no key on the node), the signed event is published over a WebSocket to the
   operator's relay, and the draft is discarded on success. **The read path is
   publish-agnostic**: Nakama trusts exactly the operator's npub (configured as
   `NPC_NOTICE_AUTHOR`) and ignores every other author.
3. **Cache = in-memory, 60s TTL.** There is only one noticeboard per operator, so the
   cache key is nothing more than the configured author. Fetched lazily on first need,
   injected into the system context on every reply when present; empty when absent or
   disabled. `NPC_NOTICE_TTL_MS` overrides the TTL.

## Implemented read path (NAP-BRIDGE-8)

- `npc-gateway.mjs` reads `NPC_NOTICE_AUTHOR` (unset ⇒ disabled) and
   `NPC_NOTICE_TTL_MS` (default 60000); fetches the operator's latest `30078`
   `d="noticeboard"` event under a 5s timeout and formats it via a cached
   `getNoticeboard()`.
- `npc-bridge.mjs` appends the noticeboard text to the system turn when non-empty
   (pure helpers `parseNoticeboard` / `formatNotices` / `createNoticeboardCache`), and
   degrades to "answer without notices" if the fetch fails — never drops the reply.

## Implemented publish surface (NAP-BRIDGE-8, v0.2.124)

The operator's Continuum web app carries the only write path, shaped as
**draft → review → sign → publish**. The node stays drafting-only throughout:

- `noticeboard-contract.mjs` is the single source of `NOTICEBOARD_KIND` / `NOTICEBOARD_D`,
   shared by the greeter read path and the operator write path so the kind and `d` tag
   cannot drift.
- `noticeboard.mjs` (pure) validates + normalises the notices (`normalizeNotices`, capped
   note/body/url lengths, price must be a finite non-negative integer) and builds the
   unsigned event (`composeNoticeboard`). No key, no signing, no relay — drafting only.
- `POST /api/noticeboard/draft` (admin-gated, rate-limited) composes the event and writes
   `noticeboard.draft.json` (event + `_relay` + `_proposed_at` metadata) onto the existing
   `pending` shelf, returning `{file, event, relay}`. `GET/DELETE /api/pending[/:file]`
   already served the shelf for other drafts.
- The **Noticeboard** view reuses that shelf: compose notices, review the rendered board,
   sign with a NIP-07 signer in the browser (no `nsec` on the VPS), publish the signed
   event to the operator's relay over a WebSocket (`["EVENT", …]`), and discard the draft
   on success. Shelf metadata (`_relay`, `_proposed_at`) is stripped before signing — the
   signer sees exactly `{kind, content, created_at, tags}`.
- The relay is `noticeboard.relay` in `config.yaml` (fallback `NOTICEBOARD_RELAY`, then
   `wss://relay.chiefmonkey.art`) — the same relay Nakama reads, so the board lands where
   the greeter actually looks.

Nakama still has **no publish path** — nothing to spam, ever.

## What is explicitly deferred

- No Nakama→relay publish path of any kind.
- No autonomous posting; no scheduled feed — the operator publishes on purpose only.
- No marketplace taxonomy beyond the free-string `kind` field.
- No private/encrypted noticeboard (revisit only if the owner asks for a gated audience).
- (optional) intent-gating — only fetch/inject the noticeboard when the message is
   about auctions/sales rather than on every reply. The 60s cache makes the
   always-inject approach cheap enough that this is not needed yet.

## Relationship to the rest of NAP-BRIDGE

- **NAP-BRIDGE-7 (this slice's predecessor)** loads static lore once at boot; this
  feed is the *dynamic* counterpart loaded on demand. They deliberately read
  differently: static = process start, dynamic = per query / cached.
- **NAP-BRIDGE-5 (rate limiter)** bounds how often a spammer can make Nakama hit the
  relay reading the noticeboard.