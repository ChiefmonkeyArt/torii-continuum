# ADR: FIPS on by default in Continuum

Date: 2026-11-09. Status: **Accepted** 2026-11-10 (owner: "Accept and build"; owner, 2026-11-04: "FIPS on by
default across all apps"; 2026-11-09: "Suite first, then apps", then "Write
the Continuum FIPS ADR"). Builds on Suite ADR 0001 (the FIPS node on every
install, v0.9.47-alpha). Supersedes one part of the 2026-10-29 amendment in
`docs/adr-team-collaboration.md`: devices are no longer owner-signed roster
entries (§2 below). Quest's side is torii-quest ADR-0151; Plebeian waits for
a later stage.

## Context

Every Suite node now runs FIPS with no peers. Continuum uses it in only one
place: Teams' private git listens on the mesh (`torii-teams.fips:7334`)
behind two hand-written root files, `/etc/torii/teams/git-members` (npubs)
and `member-nodes` (device npubs). Nobody writes them from the signed
member list yet (TEAMS-2a-4), so mesh git works only if the operator edits
them over SSH. Quest's peer introductions are also hand-written root JSON.
The operator can't see in Continuum whether FIPS is even running.

Browsers can't use FIPS (no browser or WebAssembly build), so this is about
what the node does and what the operator and members see, never about the
web pages' own connections.

## Decision

1. **The operator sees it.** The node page gets a FIPS card: running or not,
   the number of peers, and this node's FIPS address name (`npub…`, with
   Copy) for introductions. The agent reads only what is already public on
   the node: `systemctl is-active torii-fips.service`, `/etc/torii/fips/
   fips.pub` and the peer count from `peers.json` (both 0644). No mesh IP is
   shown or logged. If FIPS is off, the card says so and how to turn it on.
2. **Members add their own devices.** In Teams' private git panel (and
   Continuum's member view), a member pastes their computer's FIPS name
   (`fipsctl show`) and signs a short device note with their own signer.
   The node accepts it only while that person is on the newest signed list,
   at most 3 devices each. Removing the person drops their devices with no
   extra step. A device grants network reach to git only, never a role.
   This replaces the owner-signed `["p", <node>, "device", <human>]` roster
   entry: the owner shouldn't have to arrange anything.
3. **The list writes the mesh files.** After every roster save, join or
   device change, the agent writes one projection
   (`memory/teams/mesh.json`: per project, members who may use git, and
   their devices). A root-owned Suite path unit validates it (schema,
   npub format, caps: 12 people per project, 3 devices each) and runs
   `torii-teams apply`, which rewrites `git-members`, `member-nodes` and the
   firewall drop-in as today. Hand edits are replaced, so the files say
   "Written from Continuum. Do not edit." Application checks stay on: git
   still checks NIP-98 membership; the firewall is the second gate.
4. **Peer introductions in one paste.** For Quest's peers (ADR-0151), the
   node page makes an introduction card: this node's FIPS name, heartbeat
   signer, owner, zone and world address, signed by the operator. The other
   operator pastes it into their Continuum, which checks the signature and
   that the node's public heartbeat matches before asking the operator to
   confirm. The agent drops an operator-signed request; a root path unit
   checks the signer is this node's admin npub and writes `peers.json`.
   Removing a peer works the same way. Nothing is sent to the other node.
5. **Still optional for people.** Chat and everything else stay on the
   normal web connection. Without FIPS on their computer a member simply
   has no private git; the panel says how to add it.

## Consequences

- Mesh git and Quest peers work without SSH; the signed list stays the only
  source of who is allowed.
- New surface: two root path units in the Suite (strict validation, caps,
  no shell from agent input) and three agent routes (device add/remove,
  introduction create/accept). The agent itself stays unprivileged.
- Ships as Continuum, Suite and Teams releases together; each side alone
  keeps today's behaviour (no projection means the root files stay as
  they are).
- Risks: FIPS is pre-1.0; phones have no FIPS client, so git over the mesh
  is for computers. Private git stays mesh-only.

## Tests

- Status card: running, not running, not installed; never an `fd…` address.
- Device notes: wrong signer, person not listed, fourth device, removed
  person: all refused or dropped; a valid one appears in the projection.
- Projection: schema, caps and npub checks in the root validator; a bad
  file changes nothing; `torii-teams apply` output matches the list.
- Introductions: bad signature, heartbeat mismatch and non-admin signer
  refused; accept writes one peer; remove deletes it.

## Implementation notes

- v0.2.203-alpha (with Suite v0.9.51-alpha, Quest v0.2.939-alpha): §1 and §4.
  Agent `agent/core/fips.mjs`; dashboard card `src/views/fips-card.js`.
  Introduction card = `torii-fips-intro:` + base64url of a kind 27530 event
  (tag `torii-fips-intro`, content `{v:1, transportNpub, beaconPubkey,
  ownerPubkey, zoneId, website}`, signed by the owner). The agent drops the
  full list as an admin-signed kind 27532 event (tag `torii-fips-peers`) at
  `agent/memory/fips/peer-request.json`; the Suite's root `torii-fips-peers`
  re-checks the signature against `/etc/torii/fips/admin.npub`, requires it
  to be newer than the last list and within one day, validates each peer and
  rewrites `peers.json`. Quest re-reads `peers.json` within 30 s.
- v0.2.204-alpha (with Suite v0.9.53-alpha, Teams 0.6.1-torii.17; detail in
  torii-teams ADR 0016): §2, §3 and §5. Device notes are kind 27531 (tag
  `t=torii-teams-devices`, content `{v:1, devices:[{npub, label}]}`, up to 3,
  label up to 32 plain characters), one per person, the full list each time,
  signed by that person and within 10 minutes of the node's clock. The panel
  is in Teams only; Continuum's own member view has none. Routes:
  `GET`/`PUT /api/team/devices` for any team caller (`agent/lib/team-devices.mjs`).
  The projection is `agent/memory/teams/mesh.json` (0600; root reads it):
  `{version:1, projects:[{slug, roster, admitted:[{pubkey, role, grant}]}],
  devices:[notes]}`, rewritten after a roster save, an admit, a device save
  and at start, and only when its bytes change. Notes of people no longer on
  any project are deleted. Root (`torii-teams sync`) verifies every signature
  itself rather than trusting the agent's checks.
