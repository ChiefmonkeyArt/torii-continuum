# The team chat feels like part of Continuum

Date: 2026-11-12. Status: **Accepted** 2026-11-12 after a local review of the
build (owner: "Accept and ship"). Proposed (owner, 2026-11-12: "Do all the things
1-9 … make the message say 'Loading Project' … is it worth having a loading
bar or circle … Do a nice animation"; "Cordn's integration must be
seamless"). Target: Continuum `v0.2.212-alpha` with torii-teams
`0.6.1-torii.25` (its ADR 0023) and Suite `v0.9.73-alpha` (its ADR 0006).
Amends `adr-project-team-chat.md`.

## Context

On a phone reload a project page said "No project with that slug." while the
project list was still coming from the agent. The Team tab waited for the chat
to start, showed a "not joined yet" guess before the chat knew, had no unread
count or search, and Continuum's faces did not match the chat's.

## Decision

1. **Loading project.** While the store is loading from the agent, every
   project page (Workspace, Team, Overview, Board) shows "Loading project" with
   one calm loading ring (`components/loader.js`: an amber arc sweeping round a
   faint track; a slow pulse with reduced motion). The page draws itself when
   the project arrives; "No project with that slug." shows only once loading
   has finished.
2. **An instant Team tab.** Any project page points the hidden frame at its
   chat (`warmTeamsFrame`). On the Team tab the dock shows the same ring
   ("Opening team chat") and the frame stays transparent until it says
   `torii:ready {slug}`, then fades in (0.22 s). An older Teams that never says
   ready is shown after 8 s.
3. **Read only while seen.** `torii:visible {on}` on dock and undock (and again
   whenever the frame speaks); a new frame starts with `&hidden=1`.
4. **Unread counts.** `torii:unread {counts}` (numbers only) puts a small badge
   on the Team tab and on the sidebar's project links; 99+ past 99.
5. **No guesses.** The strip shows "N people" and adds "· N not joined yet"
   only once the frame reports (the frame waits until its count has settled).
6. **Search.** A Search button in the strip (and in More on a phone) sends
   `torii:search`, which opens the chat's own search.
7. **Same faces.** Before a picture loads, an avatar is the colour Teams uses:
   the key's first six hex digits (`faceColour`), no initials.
8. **Voice notes.** The frame has `allow="clipboard-write; microphone"`; the
   Suite delegates the microphone to the Teams origin only (Suite ADR 0006).

## Consequences

- All messages keep the exact-origin, exact-source checks in
  `lib/teams-frame.js`; counts and slugs are validated.
- `store.storeLoading()` is true while a server hydrate is in flight; the store
  now notifies when a hydrate ends, even a failed one.
