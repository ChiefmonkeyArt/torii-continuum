# Every project has its team chat, on the project page

Date: 2026-11-10. Status: **Accepted** 2026-11-10 after a local review of the build (owner chose the full-width Team tab over the right-hand panel). Proposed (owner, 2026-11-10: "the Teams screen
is confusing... I don't think we need the chat panel there"; "When I create a
project i want it to create a group too... and the group chat should than
appear in the tab on the project page"). Target: Continuum `v0.2.205-alpha`
with torii-teams `0.6.1-torii.18` (its ADR 0017) and Suite `v0.9.56-alpha`
(pin only). Amends `adr-teams-membership-signals.md` (the optional "Team chat"
step after creating a project) and torii-teams ADR 0010 §2 (where the one
Teams frame is docked). Keeps `adr-team-collaboration.md` (one owner-signed
member list per project) and torii-teams ADR 0005 (the member list is the
chat membership).

## Context

- **Project first, not team first.** A Teams group is already built from one
  project's signed member list, and everything else hangs off the project:
  tasks, files, the board, the private git and the computers allowed to
  reach it (torii-teams ADR 0016). People move between projects with
  different roles, so a separate "team" object would add a second list that
  can disagree with the first. The project stays the thing you create; its
  group follows.
- **The group is optional today.** Creating a project offers a "Team chat"
  step that can be skipped. Skipped projects have no member list, so no
  group, no git access and nothing in Teams.
- **The chat lives on the wrong page.** The Team page embeds the whole Teams
  app: a list of every project's chat, the open chat, and "Your computers",
  above the member lists. It reads as an app inside an app, and Continuum's
  floating "Ask Continuum anything" bar sits over the chat's message box.
- **The project page has no team chat.** Its "Chats" tab lists only your
  conversations with the assistant.

## Decision

1. **Creating a project creates its group.** "Create project" signs a member
   list holding just the owner, in the same step (one signer prompt). The
   owner's running Teams frame then creates the encrypted chat as it does
   today (claim, create, record). The "Team chat" step is removed; adding
   people is "Add people" on the project's Team tab, using the same people
   picker and invite links. When Teams isn't installed, or signing is
   refused, the project is still created and the Team tab offers "Start team
   chat".
2. **A "Team" tab on every project.** The project tabs become Workspace,
   Team, Overview, Board (`#/projects/<slug>/team`). It shows, full width:
   - a short header: the people on the project (avatars, "n not joined yet"),
     "Add people" and "Open in full window";
   - the project's chat in the one Teams frame (ADR 0010 §2), docked into
     this tab, showing only this project (torii-teams ADR 0017);
   - without a group yet, one line and "Start team chat" (one signature);
   - without Teams installed, one line saying so and nothing else.
   Continuum's floating assistant bar is hidden on this tab.
3. **The "Chats" tab points to it.** The right-hand "Chats" tab on the
   Workspace gets a first row, "Team chat", that opens the Team tab, above
   the assistant conversations. It stays "Chats" because it now holds both.
4. **The Team page is people and roles only.** The embedded chat is removed.
   Each project keeps its member list, roles, invite links and waiting
   queue, plus an "Open chat" link to that project's Team tab. "Card
   assignees" stays as it is. The Teams frame keeps running hidden on every
   page (ADR 0010 §2), so newcomers are still added while Continuum is open.
5. **Existing projects without a group** show "Start team chat" on their Team
   tab. Nothing is signed until the owner presses it: no signer prompt just
   for opening a page.

## Consequences

- One project, one group, from the first minute; git access and "Your
  computers" work for every new project without an extra step.
- One more signer prompt when creating a project with an extension signer.
- The Team page gets shorter and no longer competes with the chat for
  space; managing people and talking are on different screens.
- Members keep using the Teams app itself, which still lists all their
  projects' chats. This ADR changes only the owner's Continuum view.
- No new routes, files or permissions: the member-list, invite and chat
  routes are the existing ones.

## Tests

- New project: the owner-only member list is signed once; the Team tab
  opens; signing refused or Teams absent still creates the project and
  shows "Start team chat"; no "Team chat" step appears.
- Team tab: frame docked full width and showing only that project; the
  assistant bar is hidden there and back on other tabs; "Add people" opens
  the picker; "Start team chat" for a project without a group.
- "Chats" tab: "Team chat" row first, opening the Team tab.
- Team page: no chat frame; each project has "Open chat"; member lists,
  roles, invites and the waiting queue unchanged; the frame still runs
  hidden and still answers roster changes (ADR 0015).

## Implementation (v0.2.205-alpha)

- `src/lib/team-nav.js`: `openTeamFor` / `takeTeamProject` (Team page
  project pick), `markNewProject` / `takeNewProject` (memory only), and
  `startProjectChat` (signs the owner-only list with `signAndPutRoster`,
  `rows: []`, then sends `continuum:roster-changed`; `stale` counts as done).
- `src/views/project-team.js`: route `/projects/:slug/team` (and the demo
  stub). Offline, no Teams and not-owner lines; "Start team chat" when the
  project has no list (starts by itself once for a new project); otherwise
  faces, "n people · n not joined yet", "Add people", "Open in full window"
  and the docked frame (`dockTeamsFrame(dock, {projectSlug})`).
- `src/views/projects.js`: Create opens the Team tab when the node has Teams
  and you are the owner; the old "Team chat" step (`team-chat-setup.js`) is
  gone.
- `src/views/projectHome.js` Team tab; `src/views/workspace.js` "Team chat"
  row first in Chats; `src/views/team.js` and `team-roster.js` lose the
  frame and gain "Open chat"; `workspace.css` hides the assistant bar on
  the Team tab only.
- Tests: `src/views/project-team.test.js` (6),
  `src/views/projects-create.test.js` (3),
  `src/views/workspace-team-chat.test.js` (1), `src/views/team-roster.test.js`
  (+2, −2); `team-chat-setup.test.js` removed with its view.
- Found in the local review: the route renders twice while the project
  hydrates, so the new-project mark is taken only when the Team tab is about
  to draw "Start team chat" (covered by the tests above).

## Amendment (v0.2.211-alpha, 2026-11-12)

Teams ADR 0021 (torii-teams `docs/torii/adr-0021-continuum-look.md`, Accepted 2026-11-12): framed Teams uses Continuum's colours and follows its mode (`&mode=`, `torii:theme`). Continuum's strip is the only header: it shows the counts Teams reports (`torii:members`, numbers only) in place of its own estimate, and Your computers opens the panel inside the frame (`torii:open-computers`). At 640 px or less, Your computers and Open in full window move into a More popover.

## Amendment (v0.2.212-alpha, 2026-11-12)

`docs/adr-seamless-team-chat.md` (Accepted 2026-11-12, with Teams ADR 0023): the Team tab opens at the latest message, shows unread counts on the tab and the sidebar, has a Search button and voice notes, waits behind a loading ring until the frame says it is ready, and a reload shows "Loading project" rather than "No project with that slug". The strip shows only the counts Teams reports, never an estimate.
