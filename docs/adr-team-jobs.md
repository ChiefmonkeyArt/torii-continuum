# Kesshū 結集 jobs: chat-to-actions, the Jobs page and the clanker marketplace

Date: 2026-10-30 (amended 2026-10-31: name, chat flow). Status: **Proposed**. Docs only: no code, release, tag or VPS change.
Builds on `docs/adr-team-collaboration.md` (Cordn + private GRASP + roster-scoped
clankers, plus the FIPS / Teams napplet amendment) and `docs/adr-coco-wallet-transition.md`
(human wallet separate from a bounded agent allowance). Supersedes nothing.

Product name (chosen 2026-10-31): **Kesshū 結集**, "gathering together for a shared
purpose". Always show it with its kanji, because the bare romaji "kesshu" has unrelated
homophones (血臭, 血腫). Use "Kesshū 結集" in UI and outreach, and "kesshu" in ASCII-only
places (repo names, slugs, file names). This replaces the earlier working names "Teams",
"team jobs" and "chat-to-jobs". The napplet contract ids `nap-torii-team@1` and
`nap-torii-jobs@1` stay as they are; renaming them is a separate decision. Name checks (2026-10-31, register searches, not formal legal clearance):

- **UK IPO and EUIPO:** no mark for `kesshu`, `kesshū`, `kesshuu` or `結集`. Nearest
  marks are different words or unrelated classes: KESHU (UK, class 11), KESSI/KESSY
  (UK), YIKESHU (EU, class 9), kesshō (EU, food and drink), KESSHÖ (expired). TMview was
  unreachable at the time; EUIPO eSearch was used instead. A UK filing would sit in
  classes 9, 38 and 42.
- **Domains:** `kesshu.com` is registered (2019, private placeholder page, expires
  2026-12-19). Free at the time of checking: `kesshu.net/.org/.app/.dev/.io/.social/
  .eu/.uk/.co.uk/.jp`, `kesshū.com`, `kesshuu.com`, `getkesshu.com`, `結集.com/.net/.jp`.
  Nothing has been registered; buying domains needs explicit approval.

## Context

The Teams napplet gives a small team (at most 12 people plus their clankers)
encrypted chat, a signed roster, private code and PRs. Two further requirements:

1. **Teams is a product in its own right**, and an outreach tool for Torii. It must
   be useful to a group that never runs Continuum or any AI. A team chat that
   turns talk into tracked work is valuable without clankers.
2. **Chat should create actionable work.** Things to do, decisions, code to be
   written and jobs for clankers should be captured in a right-hand panel while
   people talk. Clanker jobs then get their own page, from which each job goes
   either to the team's own clankers or out to an open marketplace where outside
   agents compete for it.

What exists already:

- **Chat** is Cordn (MLS). The coordinator orders messages but cannot read them.
- **Roster** is the owner-signed kind 30098. Agents are `Agent-of` a human, get at
  most Contributor rights, open `pr/` branches and never merge. Humans merge.
- **Board** is local-first Kanban (columns 30083, cards 30084) with roster
  assignees from TEAMS-1.
- **Marketplace** is a placeholder `/marketplace` view: a list of "AI-work tasks"
  with a bounty, size and an "ours" flag, backed only by demo data. Store and demo
  disagree on the kind number (`marketTasks` says 30090, demo wraps as 30085).
  Strategy reserved kind 30090 and CONT-AGENT-5 for a "marketplace worker".
- **Wallet direction** is Coco, with an explicitly funded, capped agent allowance
  separate from the human wallet.
- **Napplet rule**: sandboxed `srcdoc` iframe, no network. The shell owns keys,
  signing, relays, wallet and consent. The napplet only proposes actions.

What exists outside Torii (checked 2026-10-30):

- **Agent gig sites are common but young and centralised.** Dozens of sites let
  agents bid on posted work, mostly settling in USDC with platform escrow, e.g.
  [MoltJobs](https://github.com/Moltjobs), [dealwork.ai](https://dealwork.ai/),
  [NEAR AI Agent Market](https://near.ai/blog/what-is-agent-market); a directory
  lists [57 such entries](https://commonworld.one/atlas/categories/work/). None
  starts from a team conversation, and none is Nostr/Lightning/Cashu-native.
- **NIP-90 (Data Vending Machines)** describes this kind of competitive job market on
  Nostr, but upstream now marks it `unrecommended`: "this got totally out of
  control, prefer use-case-specific microstandards"
  ([NIP-90](https://github.com/nostr-protocol/nips/blob/master/90.md)). Its
  private-parameter mode uses NIP-04.
- **NIP-34 already models the work itself**: issues 1621, patches 1617, PRs 1618,
  status 1630-1633 ([NIP-34](https://nips.nostr.com/34)).
- **Issue bounties exist as a draft profile**: kind 9806, proposed in
  [nips#2414](https://github.com/nostr-protocol/nips/issues/2414) and used by gittr,
  where funds are reserved with an LNbits LNURL-withdraw and released to the PR
  author on merge ([gittr kinds](https://github.com/arbadacarbaYK/gittr/blob/main/docs/NIPS_AND_EVENT_KINDS.md),
  [gittr help](https://gittr.space/help)). gittr also publishes an MCP server so
  agents can find bounties.
- **ContextVM CEP-8** prices and pays for individual tool calls over Nostr
  (Lightning, with Cashu as a recommended rail)
  ([bitcoineconomy.ai](https://bitcoineconomy.ai/tools/contextvm)). It fits
  per-call services, not multi-day code jobs.
- **Demand on Nostr is thin.** One week of NIP-90 traffic showed 1,352 job
  requests with 0 bids. Thirty days of NIP-34 traffic showed 2 zaps linked to
  work, totalling 6,000 sats
  ([measurement, Oct 2026](https://dev.to/agentbox_ai/is-anyone-paying-ai-agents-on-nostr-i-measured-1352-dvm-job-requests-0-had-a-bid-3pni)).
  The open market must therefore be an optional extra, not the reason Teams is
  worth using.
- **Cashu can express escrow-like locks.** NUT-11 P2PK supports n-of-m signatures
  before a locktime and a refund key after it
  ([NUT-11](https://github.com/cashubtc/nuts/blob/main/11.md)). The mint stays a
  trusted custodian.

## Decision

### 1. One pipeline, three stages

Talk becomes work through three stages, and only a human moves an item from one
stage to the next:

| Stage | What it is | Who can create it | Where it lives | Visibility |
|---|---|---|---|---|
| **Suggestion** | A candidate item spotted in chat: todo, decision, question, code task | The scribe (below), or any member with "Make action" on a message | Client-side only, in the right-hand panel | The member viewing it |
| **Action** | An accepted item with a title, type, owner, due date and links to the source messages | Any member with Contributor rights or above, by accepting or editing a suggestion | The team's Cordn group (see §3) | Team only, end-to-end encrypted |
| **Job** | An action of type `code` (or other machine work) with a job spec, ready for a clanker | A Maintainer or Owner promotes an action | Team Cordn group; optionally published (see §6) | Team only unless published |

Action types in v1: `todo`, `decision`, `question`, `code`, `design`. Only `code`
and `design` can be promoted to jobs at first.

### 2. The right-hand panel ("Actions")

- The panel sits beside the chat in the Teams napplet. It shows Suggestions, Open
  actions and Jobs for the current group, each linked back to its source messages.
- **Works with no AI.** Every message has "Make action". Selecting several
  messages makes one action that cites all of them. This is the outreach baseline:
  a team without clankers still gets the panel.
- **The scribe** is an optional clanker. It joins the roster as `Agent-of` the
  owner, reads the group like any other agent, and proposes suggestions in a
  structured, unsigned form. It never creates actions, assigns people, starts jobs
  or posts in chat unless someone addresses it. Suggestions are deduplicated by
  source-message cursor and rate-limited per group.
- **Privacy of extraction is explicit.** Sending encrypted team chat to a remote
  model ends end-to-end privacy for that text. Per group, the owner picks one of:
  `off` (default), `local model`, or `named provider` (e.g. via Routstr). When
  extraction is on, the panel shows which model reads the chat. Members see that
  setting when they join.
- Suggestions are kept for 7 days and then dropped. Dismissed suggestions are not
  shown again for the same messages.

### 2a. Chat features and making an action

**Chat (decided, from `docs/adr-team-collaboration.md`).** Cordn MLS end-to-end
encrypted group chat for at most 12 people plus clankers; one owner-signed roster with
Owner / Maintainer / Contributor / Viewer roles (agents capped at Contributor); clankers
answer only when addressed (`@clanker …`) and reply with a `pr/` branch; PR list and
clanker status beside the chat.

**Making an action (the J1 flow).**

1. **Pick the message.** Desktop: hover and choose "Make action" from the message
   menu. Phone: long-press. Several messages: select them, then "Make action" once;
   the action cites all of them.
2. **Draft in the right panel.** The title is pre-filled from the message text and the
   source links are attached. The member sets type (`todo`, `decision`, `question`,
   `code`), owner and an optional due date.
3. **Save.** A `create` operation goes into the group; it shows as an Open action for
   everyone. Contributors and above may create; Viewers cannot.
4. **Scribe suggestions** (only if extraction is on) show under Suggestions with
   Accept, Edit or Dismiss. Accepting is the same `create` operation, signed by the
   member who accepted.
5. **Promote.** A Maintainer or Owner turns a `code` action into a job (section 4).

**Additions (adopted in this amendment, 2026-10-31).**

- **Quick capture.** A slash command in the composer,
  `/action <title> [@owner] [due]`, and a keyboard shortcut (`A`) on the focused
  message. Both open the same draft; nothing is saved without a click or Enter.
- **Source badges.** A message that is the source of an action shows a small badge
  with the action's status (open, in progress, done) and opens it in the panel.
- **Status lines in chat.** When an action is done, or a job's PR is ready or merged,
  each client renders a one-line system note in the conversation. These are drawn
  locally from the action log, not posted as messages, so the scribe still never
  posts unless addressed.
- **Decision log.** A filtered panel view of all `decision` actions, with their source
  messages, so a team can see what it agreed and why.
- **Chat basics.** Replies in threads, reactions, encrypted file and image sharing,
  search, and pinned messages. Search runs on the device only, because the server
  cannot read the chat. Pins use the same typed-payload style as actions
  (`pin` / `unpin`). Each depends on what Cordn supports; gaps are filed upstream
  rather than worked around with a second server.

### 3. Where actions and jobs live

- **The record lives in the team's encrypted channel.** An action is a small,
  versioned operation log (`create`, `edit`, `assign`, `status`, `promote`,
  `close`) sent as Cordn application messages with a typed payload
  (`torii.action/1`). The coordinator orders those messages, so every member's
  client folds them into the same state with no separate server database and no
  public events. Late joiners rebuild state from history. Removed members keep
  what they already received, as for chat.
- **Authority check on fold.** Each client applies an operation only if the
  sender's roster role allows it (`can()` in `agent/lib/roster.mjs`): Viewers
  cannot create actions, agents cannot promote, assign humans or close jobs, and
  only Maintainers or Owners can promote to a job or approve its result. Invalid
  operations are ignored and shown as rejected.
- **Projection, not a second source of truth.** Continuum's Kanban board, todos
  and the Jobs page are views over that log. The local kinds 30083/30084 remain
  board storage for solo projects. For team projects they become a cache.
- **Code links use NIP-34.** A promoted code job records the repo announcement
  (`30617:<owner>:<d>`), base commit and, once work starts, the PR (1618) or patch
  (1617). For private repos those events stay on the team's private GRASP.

### 4. The job spec

Promoting an action requires a spec, because a vague job is where agent work
fails:

- **Goal**: one or two sentences, plus links to the source messages.
- **Acceptance**: a list of checks, at least one of them runnable (a test command,
  CI job or reproducible script), and named human reviewers.
- **Scope**: repo, base commit, paths that may change, and things that must not
  change.
- **Limits**: deadline and budget in sats. Zero is allowed for in-house work.
- **Route**: `in-house` or `market` (§5, §6).
- **Visibility**: `team` (default) or `public`. Only `public` jobs can go to the
  market.

The scribe may draft a spec. A human edits and approves it.

### 5. In-house route: our clankers

- A job is assigned to a roster agent. Dispatch uses the existing harness: the
  shell posts a structured `job.assign` in the group addressed to that agent.
  The agent works on its owner's node, pushes a `pr/` branch to the team's GRASP,
  and posts progress as `job.status` messages.
- **Spend comes from the agent allowance, never the human wallet.** Each job
  reserves up to its budget from the agent's capped Coco allowance. Unspent sats
  return to the allowance when the job closes. Running out stops the job.
- **Approval is unchanged.** The runnable acceptance check has to pass, and a
  human Maintainer reviews and merges. The agent cannot mark its own job done.

### 6. Market route: the open clanker marketplace

Publishing a job is a consequential, public act, so it follows the approval rules
for publishing.

- **What is published.** Only jobs on public repos, or on a public mirror the owner
  has created for this purpose, with `visibility: public`. The shell shows the
  exact events that will go out (title, spec, budget, repo, nothing from chat
  unless quoted on purpose) and the Owner or a Maintainer signs. Private code,
  chat text and roster contents never reach the market by default.
- **Protocol.** Use a NIP-34 issue (1621) as the job body, plus a bounty/offer
  event. Do **not** adopt NIP-90, which upstream marks unrecommended and which uses
  NIP-04 for private parameters. Track and align with the kind 9806 issue-bounty
  profile (nips#2414). Until that profile settles, the Torii payload is versioned as
  `torii-job/1` in the event content, so it can migrate without breaking clients.
  No new Torii kind number is assigned in this decision.
- **Bids are sealed.** Outside agents send bids as NIP-17 gift-wrapped messages to
  the posting npub: price, approach, ETA, and links to past work. Sealed bids avoid
  a public race to the bottom and keep bidder strategy private. The Jobs page
  shows the bids side by side.
- **Award and delivery.** The Owner or Maintainer picks a bid. The shell publishes a
  status event naming the winner. The winner submits a NIP-34 PR against the public
  repo. Acceptance checks run in an isolated runner with no secrets (ngit CI or our
  own). A human approves.
- **Outsiders never become members.** Market agents are never added to the
  roster, the Cordn group or the private GRASP. Questions about a job go through
  NIP-22 comments on the public issue.
- **Payment, in phases:**
  1. **Pay on acceptance (v1).** The budget is reserved inside the owner's Coco wallet
     as a visible, local reservation, then paid by Lightning/Cashu to the winner
     after approval. This is honest but not trustless: the worker has to trust the
     poster. The poster's completed payments are public, so a reputation forms.
  2. **Locked Cashu (research).** On award, the poster mints a token locked with
     NUT-11 2-of-2 (poster + worker) and a locktime refund to the poster. That proves
     the money exists and stops the poster quietly taking it back before the deadline.
     It needs both signatures to pay out, and the mint is still a custodian. Wallet
     support for this in Coco has to be verified before it is designed further.
  3. **Third-party escrow or arbitration** is out of scope.
- **Spam and trust.** By default, only bids from npubs within the team's web of trust
  (follows of follows) are shown, plus any npubs on an allow list. Other bids are
  folded away, not deleted. An optional small refundable bid bond is a later
  option.
- **Reputation** is computed locally from signed outcomes: award, accepted or
  rejected, and payment receipts. There is no central score.

### 7. Both sides of the market

Our clankers can also take outside work. In read-only mode, the Jobs page lists
public bounties (Torii jobs and kind 9806 bounties) that match a clanker's skills.
Bidding from our side uses the same sealed-bid flow, needs the owning human's
approval, and is paid into that clanker's allowance, never directly into the human
wallet. This is the later CONT-AGENT-5 "marketplace worker" and replaces its
Plebeian-only framing.

### 8. Napplet boundaries

Two contracts keep the outreach app free of marketplace machinery:

- **`nap-torii-team@1`**: chat, roster view, the Actions panel and in-house jobs.
  Proposals: `team.action.propose`, `team.action.op`, `team.job.promote`,
  `team.job.assign`. Snapshots: actions log state, roster, job status.
- **`nap-torii-jobs@1`**: the Jobs page and the market. Proposals: `jobs.publish`,
  `jobs.award`, `jobs.approve`, `jobs.pay`, `jobs.bid` (outbound). Snapshots: job
  list, bids already decrypted by the shell, market listings.

Neither napplet can sign, publish, decrypt, reach relays or move sats. The shell
does all of those after consent and a `can()` check. A host that only implements
`nap-torii-team@1` is a complete team app. The Jobs page appears only where the
host also grants `nap-torii-jobs@1`.

### 9. Jobs page

The page replaces the placeholder `/marketplace` view; the old route redirects to
`/jobs`. The columns are:

`Draft → Ready → In-house | On market → Bidding → Working → Review → Done | Cancelled`

Filters: project, route, assignee, budget, and "ours / outside". Each card shows the
spec, the linked source chat, the PR and the payment state. The demo fixtures move
to the new shape, and the 30085/30090 mismatch goes away because the demo no longer
pretends to have a market kind.

## Build order

Each step is its own PR and needs its own approval:

- **J0**: this decision record.
- **J1**: "Make action" on messages, the `torii.action/1` log, fold with role checks,
  and the Actions panel, plus quick capture, source badges, status lines and the
  decision log (section 2a). No AI, team-only. Depends on TEAMS-2c chat panel.
- **J1b**: chat basics: threads, reactions, encrypted files and images, on-device
  search and pins, as far as Cordn supports them.
- **J2**: the scribe. Per-group extraction setting (default `off`), suggestions,
  dedupe and rate limits.
- **J3**: job spec and promotion; in-house dispatch to roster clankers; per-job
  reservations from the agent allowance (needs the Coco allowance from the wallet
  ADR).
- **J4**: the Jobs page and `/marketplace` → `/jobs` redirect; demo fixtures updated.
- **J5**: read-only market listing (Torii jobs and kind 9806 bounties) and the
  `nap-torii-jobs@1` draft.
- **J6**: publishing to the market (preview, sign), sealed bids, award, pay on
  acceptance. Needs a public test repo and explicit approval for the first public
  post.
- **J7**: outbound bidding by our clankers (CONT-AGENT-5).
- **Research**: NUT-11 locked payouts in Coco; alignment with nips#2414.

## Consequences and risks

- **Market demand is unproven.** Visible paid Nostr agent work is close to zero.
  Teams has to stand on chat + actions + in-house clankers. The market is an
  experiment we can switch off.
- **Extraction weakens chat privacy** when it uses a remote model. That is why the
  default is off, the setting is visible to members, and a local model is an option.
- **Client-side folding needs care.** Every client must apply the same role rules
  to the same ordered log. Rules are versioned in the payload and shared with the
  agent's `can()` so the shell and the napplet cannot drift. The Cordn handoff
  defect (cordn-web #51) can drop messages after a coordinator move, which would
  drop operations. Until it is fixed, keep one coordinator per team.
- **Pay on acceptance asks workers to trust posters.** Good-faith payment history
  is public, but disputes have no referee in v1.
- **Mint custody.** Any Cashu-based payment or lock relies on the mint's honesty and
  availability.
- **Outside code is untrusted.** Market PRs run only in a secret-free, isolated
  runner and are reviewed by humans before merge.
- **Spec quality limits agent success.** Requiring a runnable acceptance check cuts
  the number of jobs we can post, deliberately.
- **Standards churn.** Kind 9806 is a draft profile. Keeping `torii-job/1` versioned
  and assigning no kind number limits the cost of following it.

## Open questions

1. Name chosen: Kesshū 結集. Still open: whether the standalone app and the Continuum
   feature share it, and whether the market gets its own name.
2. Should the scribe also offer an end-of-day digest of decisions, or stay
   strictly one item per suggestion?
3. Who may publish to the market: Owner only, or Owner and Maintainers?
4. Should there be a platform fee? The default assumption is none.
5. Is the web-of-trust filter enough at launch, or should a bid bond come earlier?
