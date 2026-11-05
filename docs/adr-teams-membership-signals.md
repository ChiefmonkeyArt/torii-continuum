# Teams membership signals, people search and automatic project chats

Date: 2026-11-05. Status: **Accepted** (owner, 2026-11-05: "Go ahead with all
three changes, write the ADR first", plus automatic chats on project creation
and people search by name with avatars). Ships in Continuum `0.2.195-alpha`,
torii-teams `0.6.1-torii.6` (its ADR 0006) and Suite `v0.9.36-alpha`.
Builds on `adr-team-collaboration.md` (one owner-signed roster) and torii-teams
ADR 0005 (the roster is the chat membership).

## Context

The Torii Teams app (framed on the Team page) turns the Continuum roster into
encrypted Cordn chat membership. Two questions are hard for it to answer
cheaply:

1. **Has this teammate opened Teams yet?** Only then can the owner add them.
   The only source today is the node's chat coordinator, and every coordinator
   request is signed and its reply decrypted by the user's signer. With a
   browser extension, each one is a popup. torii.4 asked on every window focus,
   and closing a popup refocused the page, so the popups never stopped. torii.5
   rations the requests (at most every 5 to 30 minutes), which means a teammate
   can wait up to 30 minutes to be added.
2. **Has the roster changed?** Teams reads it once per page load, so roster
   edits in Continuum go unnoticed until a reload.

Two related asks from the owner (2026-11-05):

- **Automatic chats.** Creating a project in Continuum should create its team
  chat automatically, then ask whether to invite teammates.
- **People search.** Adding teammates should allow searching by profile name,
  NIP-05 or npub, and always show the person's avatar and display name, not
  just an npub.

Today the roster editor only takes a raw npub. Teams loads names from public
relays and loads avatars directly from whatever host each profile names.

## Decision

Continuum (which already holds the roster and trusts both the owner's session
and member tokens) also records three small facts that the Teams clients report.
It also looks up profiles for both apps on the server side. Neither needs a
signer, so the Teams clients can poll Continuum freely and only call the
coordinator, which needs the signer, when something has actually changed.

### 1. Membership signals (agent)

Stored in `memory/team/teams-state.json` (0600, atomic write, serialised like
the roster store). No chat content, keys or message data, only public keys,
a group id and timestamps.

| Signal | Written by | Meaning |
|---|---|---|
| `ready[pubkey]` | that person's own Teams client (any team token) | Their key packages are on the node coordinator, so they can be added |
| `chats[slug]` | the project owner's Teams client | `{claimed_at}`, then `{group_id}`: the project's one chat |
| `added[slug][pubkey]` | the project owner's Teams client | The owner's client has added this person to the chat |

Routes (existing team auth: owner session or member token; JSON bodies; rate
limited like the roster routes):

- `POST /api/team/ready`: marks the caller's own pubkey ready. Refused unless
  the caller is on at least one roster. A client can only ever mark itself.
- `POST /api/projects/:slug/teams/chat` (`manage`, so owner only):
  `{op:'claim'}` returns 409 with the current record if a chat exists or
  another claim is under 10 minutes old. `{op:'set', group_id}` records the
  chat (id ≤ 128 chars of `[A-Za-z0-9_.:-]`). `{op:'release'}` drops an
  unfinished claim. The claim is what stops the owner's second device or a
  second tab from creating a duplicate chat.
- `POST /api/projects/:slug/teams/members` (`manage`): `{added:[hex],
  removed:[hex]}`. Only pubkeys on the current roster can be marked added.
- `GET /api/projects/:slug/roster` also returns `teams: {chat, ready, added}`,
  limited to that roster's members (no cross-project oracle).
- `GET /api/team/me` also returns `ready` for the caller, plus `chat` and
  `added` for each of the caller's projects.

Entries for people no longer on a roster are dropped when read and pruned on
the next write.

### 2. Profiles, avatars and people search (agent)

The agent, not the browser, reads Nostr profiles (kind 0). Browsers then make
no requests to public profile relays or to arbitrary avatar hosts, which
removes the "names come from public relays" limit noted in ADR 0005.

- `GET /api/team/profiles?p=<hex,...>` (any team caller, ≤ 50 keys): returns
  each person's `name`, `display_name`, `nip05` (as published, not verified),
  whether they have an avatar, and the signed kind-0 `event` so clients can show
  the name in their own lists.
- `GET /api/team/avatar/:hex` (any team caller): that person's current profile
  picture, fetched by the agent. The client never supplies a URL; it comes only
  from a kind-0 event the agent read itself.
- `GET /api/team/people?q=` (owner session only, query 2–64 chars, ≤ 20
  results):
  - **Exact matches:** an npub, nprofile or 64-hex key resolves directly, and
    `name@domain` resolves through NIP-05.
  - **Names:** matched first against the owner's follow list (kind 3) and those
    profiles, then through NIP-50 search relays.
  - **Results:** each carries a pubkey, names, NIP-05 and an avatar flag.
    Results without any name are kept only for exact matches.
- **Relays.** Profiles come from `teams.profile_relays` (default: the node
  relay from `noticeboard.relay`, then `wss://purplepag.es`,
  `wss://relay.damus.io`, `wss://nos.lol`). Search uses `teams.search_relays`
  (default: `wss://relay.ditto.pub`, `wss://nostr.wine`,
  `wss://search.nos.today`). All three answered a NIP-50 query on 2026-11-05;
  relay.primal.net and relay.nostr.band did not.
- **Caches** (memory only, bounded): profiles 500 entries for 1 hour; follow
  lists 30 minutes; avatars 200 entries, at most 25 MB in total, 6 hours each.

**Avatar and NIP-05 fetches are hostile-input fetches.** Rules:

- `https:` only, default port only, no credentials in the URL.
- DNS is resolved through a lookup hook that refuses loopback, private,
  link-local, CGNAT, multicast, unspecified, ULA and IPv4-mapped addresses, at
  connect time (no check-then-use gap).
- At most 3 redirects, each re-checked; 5-second timeout.
- Size caps: avatars 512 KB, NIP-05 JSON 64 KB, enforced while streaming.
- Avatars must be JPEG, PNG, GIF or WebP, identified by their first bytes, not
  by the remote header. SVG is never served.
- Responses carry the sniffed type, `nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox` and
  `Cache-Control: private, max-age=3600`.

Clients fetch avatars with their bearer token and display them as `blob:` URLs,
showing initials when there is no avatar.

### 3. Teams client behaviour (torii-teams ADR 0006)

- **Polling.** Re-read `/api/team/me` and the rosters every 60 seconds while
  visible, and at once on a `torii:roster-changed` message from the framing
  Continuum page (origin-checked against the configured Continuum host). No
  signer is involved.
- **Owner: creating the chat.** When a project has no chat record and none on
  this device: claim the chat, create it, then record it. A torii.4/5 chat that
  exists only on this device is recorded instead. A 409 response means
  "started on another device".
- **Owner: adding people.** Only roster members marked `ready` who are not yet
  in the chat trigger a coordinator call; then invite and mark them `added`.
  Removals work as in ADR 0005, followed by `removed`.
- **Member.** Once its key packages are on the node coordinator, the client
  posts `ready`. When `added` is set for a project with no chat on this device,
  it looks for the welcome and joins. If the welcome isn't there yet, it
  retries after 1, 2, 4… up to 30 minutes.
- **No background coordinator polling.** Signer prompts happen only on real
  events: the owner creates a chat or adds someone, a member joins, or the page
  loads. "Start project chat" stays only as a retry after a failure.

### 4. Continuum UI

- **People picker in the roster editor.** One search box (name, NIP-05 or
  npub). Results show avatar, display name, NIP-05 or a short npub. Picking
  someone adds a row (role contributor by default). Rows show avatar, display
  name and a short npub. The raw npub field goes; a pasted npub resolves
  through the same search.
- **Status per person:** "In the chat", "Opened Teams, being added" or "Hasn't
  opened Teams yet".
- **New project.** If Teams is installed, creating a project opens a "Team chat
  for <name>" step with the people picker. "Create chat" signs the roster once
  (owner only if nobody was picked), then opens the Team page with
  `/chat/p/<slug>?embed=1` framed, where the chat creates itself. "Skip for
  now" just opens the project, and a chat can be created later from the Team
  page.
- **After a roster save,** the Team page sends `torii:roster-changed` to the
  Teams frame (target origin = the Teams origin).
- **The Teams frame no longer receives the microphone** (Teams has no voice
  notes). Suite's Continuum host headers drop the microphone delegation to
  match.

## Consequences

- **No popup storms.** Teams never asks the signer in the background; it polls
  Continuum instead.
- **Faster adds and joins.** A teammate who opens Teams is added within about a
  minute, and joins about a minute after that, with no reloads, as long as
  the owner has Continuum or Teams open somewhere. This rule is unchanged:
  only the owner's client can add people to an MLS group.
- **Visibility of "opened Teams".** Continuum learns, and shows teammates on
  the same project, that a pubkey has opened Teams. It already knows they
  signed in.
- **The agent makes outbound requests** to the profile and search relays and to
  avatar and NIP-05 hosts named in public profiles. Browsers no longer do.
  The SSRF rules above are mandatory and covered by tests.
- **The roster stays the authority.** These signals never grant access. A
  stale or forged `ready` or `added` value can at worst cause one unneeded
  coordinator call: invites still need a key package on the coordinator, and
  joins still need a welcome from the owner.
- **Delayed chat creation.** The chat is created when the owner's Teams client
  next runs: right away in the new-project flow, otherwise on the Team page.
- **Version markers:** Continuum `0.2.195-alpha`, torii-teams `0.6.1-torii.6`,
  Suite `v0.9.36-alpha`.

## Alternatives rejected

- **Faster coordinator polling.** Every request is a signer prompt.
- **Teammates announce on public relays** (for example a kind-10051 key package
  relay list). This leaks team membership publicly, and the Cordn coordinator
  holds key packages anyway.
- **Avatars loaded directly from their hosts.** This leaks every viewer's IP
  address to arbitrary hosts. A URL-taking proxy was also rejected: it is a
  general SSRF surface. This design only fetches URLs from profiles the agent
  read itself.
- **Continuum creating the chat itself.** Only a Cordn client with the owner's
  MLS state can create the group. Continuum holds no keys.
