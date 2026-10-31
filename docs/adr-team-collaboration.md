# Team collaboration: Cordn group chat, private GRASP code and roster-scoped clankers

Date: 2026-10-29. Status: **Proposed** — design plus a completed isolated sandbox trial (below). No Continuum code, release, tag or VPS change. Supersedes nothing; it gives TEAMS-2 (see `torii-continuum-todo.md`) a concrete architecture.

## Context

Continuum Teams means "team vibe coding": a handful of people (maximum 12) plus their clankers (AI agents) working on one project's code and graphics, chatting about it, and shipping it through ngit. TEAMS-1 (v0.2.53-alpha) gave Continuum a local operator roster (kind 30093) that carries no authority. TEAMS-2 was defined as server-side operator auth, relay sync and an invite handshake, but without a messaging or code-hosting choice.

The requirements, in priority order:

1. **Sovereign.** Each team runs on an operator's own node (VPS or Start9-like), under Torii Base. No central workspace provider.
2. **One roster.** Who may read chat, read code and push/merge must come from one owner-signed membership list, not three hand-maintained ones.
3. **Private where it matters.** Chat content is end-to-end encrypted; private code is unreadable to non-members.
4. **Clankers are members, not superusers.** Agents have their own npubs, act only on authorised humans' requests, open PRs and never merge.
5. **Interoperable.** Use NIP-34/GRASP for code so ngit, GitWorkshop and Budabit work; use a chat protocol with more than one client.
6. **Light.** Fit a small VPS next to Quest, Hibiki and Layercraft; prefer SQLite to new database servers.

## Options considered

| | Buzz (Block) | Zzub (Buzz fork) | GRASP + Cordn + ContextVM (chosen) |
|---|---|---|---|
| Topology | One workspace relay; no gossip or replication ([Buzz architecture](https://github.com/block/buzz/blob/main/ARCHITECTURE.md)) | Inherits Buzz's server | Private ngit-grasp + Cordn coordinator on the owner's node; coordinator is movable |
| Server weight | Rust relay + Postgres + Redis + S3 ([RepoCloud](https://www.repocloud.io/details/Buzz/)) | Same | Two Rust binaries; LMDB/SQLite |
| Nostr fit | 81 custom kinds, 13 Buzz-only NIP drafts ([Hyphae analysis](https://github.com/iDoris-ai/Hyphae/blob/main/docs/buzz-comparison-analysis.md)) | Moving chat to Cordn ([Nostr Compass](https://nostrcompass.org/en/newsletters/2026-10-21-newsletter/)) | Standard NIP-34, GRASP-01/08, NIP-42, NIP-98; Cordn over ContextVM |
| Code hosting | Buzz's own git backend, not GRASP ([ngit](https://ngit.dev/ecosystem/)) | Built-in git client and PR review ([Nostr Compass](https://nostrcompass.org/en/newsletters/2026-09-23-newsletter/)) | ngit-grasp private mode (GRASP-08) |
| Chat privacy | Relay-readable | Cordn (MLS) | Cordn (MLS); coordinator sees opaque blobs only |
| Agents | Agent keypair + owner attestation, ACP harness ([nowline](https://nowline.net/reports/block-ships-buzz-open-source-slack-git-built-for-ai-agents)) | Inherits | Agent npub as Cordn member; inbox/outbox daemon; PRs via NIP-34 |
| Licence | Apache-2.0 | Apache-2.0 (unconfirmed canonical source) | ngit-grasp/ngit MIT; cordn-rs, cordn-web, @cordn/cli MIT; ContextVM SDK LGPL-3.0; Cordn core repo licence **not declared** |

Also considered: NIP-29 relay groups (Flotilla, Budabit) — simple and widely supported, but the relay reads every message; Marmot (MLS over relays) — no ordering authority, which is the problem Cordn's coordinator solves; Concord (Armada) — named by ngit's roadmap for future access management, worth tracking; Iris double ratchet — good 1:1 DMs, but O(members) group fan-out and deniable messages suit a team record poorly.

## Decision

Adopt **GRASP + Cordn + ContextVM** as Continuum's team architecture, and borrow Buzz's ideas rather than its code:

- **Workspace = owner's node.** It runs a private `ngit-grasp` (GRASP-08: NIP-42 for the relay, NIP-98 for Git HTTP) and a `cordn-rs` coordinator, both behind Torii Base. ngit-grasp supports `NGIT_BASE_PATH`, so it can mount at e.g. `/grasp` on the existing domain.
- **One roster, three projections.** The owner-signed project roster (TEAMS-1's kind 30093 members, made load-bearing) is the single source. Continuum derives: Cordn group membership (add/remove), `NGIT_PRIVATE_MEMBERS` (read access) and the repository announcement's maintainers (merge/push). Roles: Owner, Maintainer, Contributor, Viewer, Agent-of(<human npub>).
- **One project = one Cordn group + its repos.** Branch channels (Buzz's best idea) come later as extra Cordn groups named after `pr/` branches.
- **Clankers.** Each agent has its own npub, is listed on the roster as Agent-of a human, runs on its owner's machine or node, and reaches Cordn through the CLI daemon's inbox/outbox queues. It acts only on messages from roster humans, is rate-limited, dedupes by cursor, ignores other agents (no loops), opens `pr/` branches and never merges. Its signing key should move to a NIP-46 remote signer (`ngit --nbunksec`) before real use.
- **Graphics.** SVGs and other text assets live in git with normal review. Large raster/video lives in Blossom (Cordn already supports encrypted media); the repo stores hash manifests.
- **Approval boundary unchanged.** Agent work is a proposal; a human maintainer merges. Merges and roster changes are signed, public-to-the-team events, so decisions stay attributable even though chat is encrypted.

## Trial (2026-10-29, isolated sandbox, test keys only)

Reproducible scripts: `docs/trials/teams-cordn-grasp/`. Identities: alice (owner), bob (contributor), clanker (agent of alice), outsider (not on roster). All services bound to loopback; nothing published to public relays.

| # | Test | Result |
|---|---|---|
| 1 | Alice creates a Cordn group; invites bob and clanker by pubkey; encrypted transport required | **Pass.** Cordn identity = the member's own Nostr pubkey. Messages arrive in coordinator order. |
| 2 | Coordinator and relay never see plaintext | **Pass.** Zero plaintext hits in SQLite, WAL and logs. Coordinator stores key-package publishers, welcome targets, opaque messages and counters, but no per-message sender. |
| 3 | Remove bob, post, bob syncs | **Pass.** Bob keeps old history; new message unreadable; group marked inactive for him. Re-invite works and does not reveal what he missed. |
| 4 | Move the group to a second coordinator | **Pass with caveat.** Requires the group to declare fallbacks first (library `updateGroupMetadata`; the CLI has no command). Members follow automatically. **Defect:** cursors restart on the new coordinator. CLI 0.9.0 does not save `group.stream` in its session snapshot, so after a process restart its echo guard drops any new message whose cursor equals one of the member's own pre-handoff sends. This hits both history and the daemon inbox; a process that follows the handoff live without restarting is fine. Reported upstream as [cordn-web #51](https://github.com/Cordn-msg/cordn-web/issues/51) with a two-line fix, verified locally. |
| 5 | Private ngit-grasp (GRASP-08) with members alice, bob, clanker | **Pass.** Anonymous Git HTTP → 401; anonymous relay REQ → nothing; outsider authenticates → `restricted: … not whitelisted`; bob clones; outsider's clone fails. |
| 6 | Clanker loop: bob writes `@clanker note: …` in chat | **Pass.** Alice's unaddressed message ignored; clanker cloned, committed, pushed `pr/clanker-3` and replied in chat. PR author = clanker npub, description names the requesting human. |
| 7 | Clanker pushes directly to `master` | **Refused**: "not a confirmed maintainer". |
| 8 | Alice reviews and merges | **Pass.** `ngit merge` + push; PR status becomes `applied`. |
| 9 | Remove bob from `NGIT_PRIVATE_MEMBERS` | **Pass** after a restart: bob's fetch fails, alice's still works. |

Footprint (resident memory): ngit-grasp 27.5 MB, each cordn-server ~15 MB, Cordn CLI daemon 122 MB (Node), clanker loop 45 MB. Binaries: ngit-grasp 27.6 MB (≈3.5 min release build on 2 cores), cordn-server 10.3 MB.

Operational findings for packaging:

- **Private repo discovery lives on the user's relays.** ngit publishes an encrypted kind-10318 relay list to the member's own write relays; the private GRASP correctly rejects it. Each member needs a normal outbox relay (the Torii node relay can serve).
- **Relay owners can become members.** GRASP-08 membership = `NGIT_PRIVATE_MEMBERS` ∪ NIP-11 owners of relays listed in accepted announcements. Team repos must list only the private GRASP (`--repo-relay-only`), or another operator is silently admitted.
- **Outbound lookups.** Even in private mode, ngit-grasp contacted `purplepag.es`, `index.hzrd149.com` and `indexer.coracle.social` to look up participants' relay lists, which can reveal member pubkeys to those indexers. Set `NGIT_USER_INDEX_RELAYS` to the Torii node relay.
- **Membership changes need a restart** in v3.0.10 (environment-configured). Continuum's roster projector must restart the service, or a dynamic membership source must land upstream.
- **ngit defaults to TLS** for a bare `localhost:7334`; use `ws://` explicitly in development. In production Torii Base terminates TLS.
- **Agent hygiene.** `--private-key-file` and ngit's file store hold raw keys; give clankers a NIP-46 signer before real use. The Cordn daemon needed SIGKILL when its relay had already gone; use a service manager with a stop timeout.

## Addendum: TEAMS-2a slice 1 (v0.2.191-alpha)

- **Roster kind.** The owner-signed project roster uses a new addressable kind **30098** with `d` = project slug, not TEAMS-1's 30093 (one local record per member). One event per project carries the whole team, so it can be verified and replaced atomically. Tags: `["p", hex, "maintainer"|"contributor"|"viewer"]` and `["p", hex, "agent", <human hex>]`. The owner is the signer and is never listed. Content is empty.
- **Trust rules (agent/lib/roster.mjs).** Signer must be the Continuum owner from the verified session; signature verified on a rebuilt seven-field event (nostr-tools caches a verified flag that object spread copies onto tampered copies); `d` must equal the route slug; `created_at` strictly newer than the stored roster and at most 10 minutes ahead; at most 12 people and 32 entries; no duplicates; agents must belong to a listed human and cannot chain.
- **Roles.** Owner: manage + merge + propose + chat + read. Maintainer: merge and below. Contributor: propose and below. Viewer: chat + read. An agent gets min(its human's role, Contributor), so it never merges or manages.
- **Projections.** Cordn members and `NGIT_PRIVATE_MEMBERS` = everyone on the roster; announcement maintainers = owner + maintainers.
- **Not yet.** Roster members cannot sign in to Continuum, nothing is relay-published, NIP-17 invite/accept and applying the projections to running services are the next slices.

## Amendment: FIPS private mode and the Teams napplet (proposed 2026-10-29)

Status: **Proposed**, docs only. Nothing is built, packaged or deployed.

**Decision.**

- **Napplet for the interface, FIPS underneath.** Teams ships as a napplet, `nap-torii-team@1`: chat panel, roster, PR list and clanker status, mounted sandboxed (`srcdoc`, `sandbox="allow-scripts"`, no network). It receives snapshots and proposes actions. The Continuum shell signs (NIP-07/NIP-46), asks for consent and checks every action against the roster (`can()` in `agent/lib/roster.mjs`). This follows the existing napplet rule: keys and FIPS daemons stay outside the napplet. FIPS publishes no browser or WebAssembly support, so the napplet could not use it directly anyway ([FIPS v0.5.0](https://github.com/jmcorgan/fips/releases/tag/v0.5.0)).
- **FIPS is an optional private mode, not a requirement.** The node's cordn-server, ngit-grasp and relay also listen on the FIPS `fips0` IPv6 adapter, so members reach `<node-npub>.fips` with unmodified software ([FIPS README](https://github.com/jmcorgan/fips)). HTTPS and relays remain the fallback, so a member without FIPS still works. Cordn and ngit need no code changes. The native datagram API waits: it is off by default, its surface may change, and it gives no retransmission, ordering or flow control ([FIPS v0.5.0](https://github.com/jmcorgan/fips/releases/tag/v0.5.0)).
- **Device keys, not personal npubs, on the mesh.** Each machine runs FIPS with its own node key, so mesh presence and IP-level traffic are not tied to a person's identity. FIPS v0.5.2 fixed a similar linkage of a node key to traversal traffic on relays ([Nostr Compass podcast](https://podcast.nostrcompass.org/rss.xml)). The roster gains a device entry, `["p", <node hex>, "device", <human hex>]`, with the same rules as agents: the human must be listed, no chaining, and removing the human removes their devices. A device grants network reach only, never a role.
- **Fourth projection: mesh access.** Besides Cordn members, `NGIT_PRIVATE_MEMBERS` and maintainers, the roster projects to FIPS peer admission (per-npub allow/deny) and a drop-in for the default-deny `fips0` firewall that opens the service ports only to roster devices ([FIPS README](https://github.com/jmcorgan/fips)). Application auth stays on: Cordn MLS membership and GRASP NIP-42/NIP-98 still decide access, because FIPS is a permissionless mesh and cannot be the only gate.
- **Continuum becomes a napplet host.** The napplet architecture's v0 is Quest-only. This amendment proposes that Continuum hosts napplets too, starting with Teams, by porting Quest's sandboxed runtime (nonce-bound channel, parent/source checks, network-denying CSP) rather than adopting a third-party runtime. Quest's napplet decision records need a matching note in the torii-quest repo; that is a separate change.

**Risks.**

- FIPS is pre-1.0 (v0.5.3, [release](https://github.com/jmcorgan/fips/releases/tag/v0.5.3)). Its protocol and APIs are not yet stable, and an audit of its cryptographic protocols is still listed as a priority ([FIPS README](https://github.com/jmcorgan/fips)). That is why it stays optional.
- To verify in the trial: whether peer admission covers sessions routed through other mesh nodes or only direct links. If only direct links, the firewall drop-in, keyed on each device's `fd00::/8` address, is the real network gate.
- Every member must install FIPS. Packages exist for Linux, macOS, Windows and OpenWrt; Android support is only an embedded crate upstream, with the third-party [fips2go](https://github.com/fr34aky/fips2go) app.
- The IPv6 adapter needs `CAP_NET_ADMIN`. The isolated sandbox used for the first trial has no root, so the FIPS trial needs the owner's VPS plus one other machine, with explicit approval.
- FIPS is MIT-licensed, so there is no licence concern.

**Order.** (1) This amendment. (2) A FIPS trial on the VPS and one other machine, needing approval: two daemons, services bound to `fips0`, the admission and firewall behaviour above, and Cordn + git over `.fips` names. (3) Roster device entries and the fourth projection. (4) Suite packaging, folded into TEAMS-2b. (5) The Continuum napplet host and the `nap-torii-team@1` draft. (6) The Teams napplet UI, merging with TEAMS-2c.

## Addendum: TEAMS-2b packaging (Torii Suite v0.9.26-alpha, 2026-10-31)

Status: **Accepted** for the Suite PR; no Continuum code or VPS change.

- **Reach (owner choice 2026-10-31): chat public, git mesh-only.** The Cordn coordinator talks only to the node's loopback strfry (`ws://127.0.0.1:7777`); members' apps use the existing `wss://relay.<domain>`, since an https page cannot open `ws://`. Chat content stays MLS-encrypted, so a public relay exposes only the metadata already listed below. ngit-grasp runs in private mode bound to the node's FIPS address on port 7334, with no nginx route; `NGIT_BASE_PATH` stays `/` until a public git option is approved.
- **Two network gates for git.** GRASP-08 membership (`/etc/torii/teams/git-members`) plus a per-device firewall allow list (`member-nodes`, rendered into a new `members` chain of the Suite FIPS firewall through `/etc/torii/fips/fips.d/*.nft`). This is step (3)'s firewall drop-in; TEAMS-2a-4 will write both files from the signed roster.
- **Git host name.** The FIPS shortname `torii-teams.fips:7334`, never `<npub>.fips` (ngit truncates URLs at the first `npub1`).
- **Binaries.** Pinned SHA-256s. cordn-server v0.5.1-next.3 from the Cordn release; cordn-rs is MIT, which settles the bundling question for the server (the Cordn core licence question in cordn-web #51 still matters for the app). ngit-grasp v3.0.10 (MIT) has no binary release, so a Suite workflow builds it at the pinned commit and publishes an attested prerelease; no compiler on any VPS.
- **Keys.** The coordinator key is a service identity generated on the node, root-only, passed with systemd `LoadCredential`, never replaced on rerun. No person's nsec is involved.
- **Backups.** Daily root-only tarball of the key, member lists and both data directories, with a brief service stop for consistency and 7-day retention.
- **FIPS** moves to v0.5.3 in the Suite (the trial's version).
- **Rollout.** The trial also binds :7334, so the installer refuses while it runs. Deploy to chiefmonkey.art only after the Plebeian test and trial teardown, with owner approval; the trial coordinator key can be carried over to keep its groups.

## Consequences and risks

- **Server-visible code.** GRASP-08 controls who can read, but the operator's server holds plaintext repositories ([ngit](https://ngit.dev/self-host/ngit-grasp/private-service/)). The owner's node is the team's trust boundary for code; chat is protected even from it.
- **Coordinator metadata.** Cordn's coordinator stores key-package publishers and welcome targets (pubkeys), group IDs, message counts and timing. It cannot read content or see who sent each message. Teams should know the coordinator learns who was invited.
- **Agents hold group keys.** A compromised clanker can read its group's chat and push `pr/` branches. Keep agents to their own project group; maintainer rules stop it merging.
- **Removal is forward-only.** A removed member keeps what they already received.
- **Service-wide private scope.** GRASP-08 membership covers the whole ngit-grasp instance, so one instance per team (or per trust domain), not one per repository.
- **Young dependencies.** Cordn is pre-1.0 (CLI 0.9.0, server v0.5.1-next.3) and its core repo declares no licence; confirm with gzuuus before bundling. Pin versions and verify release checksums.
- **Identity custody.** The Cordn CLI and ngit accept raw keys; human members must use a browser signer (NIP-07/NIP-46) through Continuum or cordn-web, never paste an nsec into Continuum.

## Next steps (each needs its own approval)

1. Confirm the Cordn core licence and whether cordn-web supports NIP-07/NIP-46 signers.
2. ~~Report the post-handoff defect to Cordn~~ — filed as [cordn-web #51](https://github.com/Cordn-msg/cordn-web/issues/51) (2026-10-29), which also asks the core licence. Until fixed: one coordinator per team, no handoff, or persist `stream` in Continuum's own @cordn/core integration.
3. TEAMS-2a: make the roster load-bearing (signed roster event, NIP-17 invite/accept), with Continuum projecting it to Cordn and ngit-grasp.
4. TEAMS-2b: Torii Suite packaging for ngit-grasp (private mode, base path) and cordn-rs, with backups for both data directories. Built in Suite v0.9.26-alpha (see the addendum); deploy pending.
5. TEAMS-2c: in-app team chat panel and the clanker harness with a remote signer and an LLM in place of the trial's scripted change.
6. TEAMS-2d: FIPS private mode and the Teams napplet (see the amendment above); starts with a VPS trial.
