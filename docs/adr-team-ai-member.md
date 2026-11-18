# A project AI member in the team chat

Date: 2026-11-18. Status: **Accepted** 2026-11-18 after the local review
("Yes and do all the things still to do"). Proposed by the owner (2026-11-18: "@mentions first,
both model options with the label, and Owners and Maintainers only to begin
with." / "Let's go with this"). Ships in Continuum `0.2.214-alpha`,
torii-teams `0.6.1-torii.28` (its ADR 0024) and Suite `v0.9.79-alpha`
(its ADR 0007). Builds on `adr-team-collaboration.md` (the owner-signed roster,
whose `agent` role already exists) and `adr-teams-membership-signals.md`
(ready signals let the owner's Teams add someone without a coordinator round
trip).

## Context

Teams chats are end-to-end encrypted Cordn (MLS) groups. The owner wants an AI
in a project's chat that people can ask questions. It has to:

- be a real chat member, so it can read the messages it is asked about without
  any server-side decryption shortcut;
- answer only when asked, and only for people the owner trusts with it;
- say which model answered, because Local (Ollama on this node) keeps the
  text on the server and Routstr sends it out.

A spike (2026-11-17) ran `@cordn/cli` 0.10.0 headless against Teams torii.27:
it published a last-resort key package, the owner's Teams added it from the
ready signal, it accepted the welcome and replied to an @mention.

## Decision

1. **One AI identity per node.** A fresh key in the secret store
   (`team_ai_key`, encrypted like the other agent secrets). Its Cordn state is
   `memory/team-ai/session.state` (encrypted by the library, key file 0600,
   folder 0700). It signs its own kind 0 ("Continuum AI", `bot: true`), served
   through `/api/team/profiles` so names show without a relay publish.
2. **The roster decides.** The owner adds it on the Team page ("Add to the
   chat"), which signs the roster with `['p', ai, 'agent', owner]`. Teams then
   adds it to the chat like anyone else. "Take out of the chat" signs it off
   the roster and Teams removes it. Nothing else can put it in a chat.
3. **When it answers.** Text messages only, live only (at most 120 s old, so
   the history replayed on joining is ignored), once per message, when its
   npub or a `p` tag mentions it, in a chat whose admin is the project owner
   and whose roster lists it as an agent, from a person (not an agent) whose
   roster role is owner or maintainer. Six answers a minute and sixty a day per
   project. Everyone else is ignored silently; Teams tells them before they
   send (Teams ADR 0024).
4. **What it sees and does.** A short system note, up to the last 20 text
   messages (8,000 characters) with names, and the question. No tools, files,
   actions or project changes. Replies are capped at 3,000 characters.
5. **Models, per project.** Local (`ollama_only`, `cfg.ollama.model`) is the
   default; Routstr (`routstr_only`, the owner's chat model) is opt-in with a
   warning that messages leave the server. The roster reply carries
   `ai: {pubkey, name, model, label}` so Teams shows "AI · Local · model" on
   its messages. If Local is off, it says so instead of failing quietly.
6. **Config.** `teams.coordinator` (hex) and `teams.relay` (wss, or ws on
   loopback only) in `config.yaml`, written by the Suite installer. Without
   them the AI is off and the Team page shows nothing. The Cordn link must be
   transport-encrypted (`transportEncryption: 'required'`).
7. **Vendored library.** `agent/vendor/cordn-session.mjs` is an esbuild
   bundle of `@cordn/cli` 0.10.0's `openPersistentSession` and
   `welcomeIdentifier` (1.4 MB), rebuilt by
   `agent/scripts/build-cordn-bundle.sh` from a pinned lock. Adding the package
   as a dependency would add about 87 MB of node_modules to an agent that is
   33 MB today. The bundle also exports the CLI's own seal helpers and the
   few ts-mls and nostr-tools pieces item 8 needs (157 bytes more).
8. **People who join while the owner is away.** Teams seals that join commit
   with its own join key (Teams ADR 0011 §5), which the stock library can't
   open; without help the AI skips it and can't read anything after. The
   AI's session runs incoming messages through `lib/team-ai-join.mjs` first:
   it opens the join seal, runs the same check every Teams member runs
   (owner-signed roster or grant, the joiner's own binding for this group,
   epoch and leaf, the member-list floor, ExternalInit only), and only then
   re-seals the commit under the epoch key for the library. A commit that
   fails is left alone, so the AI rejects exactly what the people reject.
9. **Never takes the agent down.** If the chat server is slow or down at
   start, the AI retries with backoff (5 s doubling to 5 min) and the agent
   carries on.

## API

- `GET /api/projects/:slug/ai` (owner): `{enabled, ready, pubkey, npub, name,
  model, label, local_available, error}`.
- `PUT /api/projects/:slug/ai` (owner, rate limited): `{model:'local'|'routstr'}`.
- `GET /api/projects/:slug/roster`: adds `ai` when the AI is listed.

## Consequences

- People see who answered and with which model; the owner controls both.
- One identity across projects: removing it from one roster does not affect
  the others. A per-project identity can come later if wanted.
- The bundle is updated deliberately (rerun the script, bump the header);
  a test checks the pinned version and its exports.
- Not yet: answering contributors, tool use, actions from chat, threads,
  voice notes or attachments.
