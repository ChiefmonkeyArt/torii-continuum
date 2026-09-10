# NAP-BRIDGE — read-only world noticeboard (single replaceable event)

Status: **proposed (spec only — not built)**. Follows NAP-BRIDGE-7 (the lore layer).
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

## Open decisions (do not build until settled)

- **Exact kind and `d` convention** — `30078` + `d="noticeboard"` is the working
  proposal; confirm it before writing a reader.
- **Who edits it** — via Continuum (a drafted, human-approved signed event) or a
  dedicated operator tool. The "human approves before signing" rule from Continuum
  applies either way.
- **Cache TTL and query key** — shared in-memory cache vs per-request fetch; the
  per-sender rate limiter (NAP-BRIDGE-5) already bounds relay reads from a spammer.

## What is explicitly deferred

- No Nakama→relay publish path of any kind.
- No autonomous posting; no scheduled feed.
- No marketplace taxonomy beyond the free-string `kind` field.
- No private/encrypted noticeboard (revisit only if the owner asks for a gated audience).

## Relationship to the rest of NAP-BRIDGE

- **NAP-BRIDGE-7 (this slice's predecessor)** loads static lore once at boot; this
  feed is the *dynamic* counterpart loaded on demand. They deliberately read
  differently: static = process start, dynamic = per query / cached.
- **NAP-BRIDGE-5 (rate limiter)** bounds how often a spammer can make Nakama hit the
  relay reading the noticeboard.