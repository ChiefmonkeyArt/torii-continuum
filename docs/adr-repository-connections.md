# Repository connections: flow, permission rules and first implementation

Date: 2026-09-25. Target release: v0.2.188-alpha. Status: read-only GitHub foundation; nGit is design-only.

## Goal and layout

Make attaching a repository feel like adding a tool, not configuring a server. Keep Continuum's warm amber styling, current typography and profile menu. Add **Connections** under the bottom-left **Settings & tools** menu, at `#/settings/connections`. Each project's Context panel gets **Connect repository**, which opens the same screen with that project preselected.

The main card is GitHub: a compact status badge, three visible steps, the connection action and linked projects. The adjacent permission panel explains what is allowed and what is not. A quieter nGit card says **Planned**, never Connected. On small screens the cards stack, buttons retain touch-sized targets and repository names wrap. Loading, setup-needed, not-connected, approval-pending, connected, expired, empty-list and retry states are first-class states.

## Connection flow

1. **One-time operator setup.** Register a GitHub App, enable Device flow and expiring user tokens, disable webhooks, and request only Contents read plus automatic Metadata read. No organization/account permissions, write permissions, private key or client secret are required by this slice. Enter the public App ID, public Client ID and slug. The server checks these against GitHub's public app metadata before saving them. The app's metadata must be publicly discoverable for this first setup path; private/unavailable metadata is refused rather than guessed. This does not make selected repositories public. A future manifest-guided registration can remove manual public-field entry.
2. **Select repositories on GitHub.** Install that app using “Only select repositories.” Organization installation may need its administrator. An all-repositories installation is intentionally refused. Installation and account authorization are distinct: signing into Continuum is not automatic GitHub authorization.
3. **Consent and account approval.** The operator checks the read-only/encrypted-token consent box and clicks Connect GitHub. Continuum displays a short-lived code and opens GitHub's fixed verification page. The private device code stays server-side and in memory. Codes supplied through chat or by third parties are never part of this flow.
4. **Confirm access.** Server polling respects GitHub's interval, slowdown and expiry rules, and is bound to the initiating Continuum owner and sign-in. No polling survives page removal; no background approval process runs on its own. GitHub's returned app-user token must expire within eight hours. Verify account identity and installation permissions before saving it.
5. **Attach a repository.** Pick a GitHub account/organization, browse paginated approved repositories, select a Continuum project and choose Link to project. Revalidate permissions and membership immediately before saving the local reference. Replacing an existing link requires confirmation. No clone, source-content read, model call or execution occurs.
6. **Manage and end access.** Refresh/reconnect after expiration or revocation. Disconnect removes the current local token and project links, preserving public setup fields; it does not delete or change GitHub repositories or revoke GitHub's app grant. The screen links to GitHub's settings for full revocation. An encrypted backup may retain an old token until backup expiry; GitHub expiry/revocation is the ultimate authority.

The device flow and token expiry/installation intersection follow [GitHub's app-user-token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app). Public setup validation follows [Get an app](https://docs.github.com/en/rest/apps/apps#get-an-app).

## Permission contract

| Capability | This release | Future approval boundary |
|---|---|---|
| See GitHub account and selected repository metadata | Allowed after connection consent | Renew after expiry or revocation |
| Attach/unlink a local project reference | Owner action; replace/unlink confirmation | Never grants team access |
| Read file contents into Continuum | Not implemented; app Contents permission is read-only groundwork | Explicit repository/file selection |
| Send private code to a remote AI provider | Not implemented by connecting | Separate informed action showing scope/provider |
| Clone or execute repository code/install dependencies | Not implemented | Isolated workspace, resource/network limits and explicit job intent |
| Commit/push/open a PR/merge/publish/delete | No routes and no GitHub write permissions | Later reviewed action with exact repository, branch and changes |
| Sync or mirror GitHub and nGit | Not implemented | Explicit destination and conflict policy; no silent publication |
| Use a human password/private Bitcoin or Nostr key | Never requested or persisted | External signer/credential reference only |
| Share connections across a team | Not implemented | Real server-enforced membership and roles first |

The connector token is a revocable service credential, not a human password or identity private key. It is encrypted by the existing operator credential service with an owner-scoped name and atomic replacement. It never enters model context, project-store payloads, logs, browser storage or API responses. The server necessarily decrypts it to talk to GitHub; encryption at rest is not protection against a compromised running server. No deployment/development connector credentials are bundled into Continuum.

## Architecture and security

- A GitHub App **device-flow user token** is the first self-hosted implementation, rather than installation tokens requiring an app private-key service. It is limited by both user and installation access. This deliberately trades occasional reconnection for avoiding a central credential broker or new private-key custody.
- Expiring user tokens only; discard refresh tokens. Durable unattended access and automatic renewal are explicitly deferred, not silently claimed.
- Fixed `github.com` authorization endpoints and fixed `api.github.com` GETs; no general proxy, caller URL, shell/git command, redirect following or arbitrary header forwarding.
- Bounded 12-second requests, 2 MiB response cap, 100 repositories per page, 100 pages maximum and bounded installations. Failed or truncated responses do not become success.
- Per-owner serialization makes cancel/disconnect safe against in-flight completion and prevents conflicting local writes. Corrupt encrypted state fails closed. Device code exchange is single-use.
- Check only matching app installations, Contents/Metadata read-only permissions, selected-repository mode, suspension and accessible repository membership. A removed grant cannot authorize a fresh link. Linked rows are historical local references, not proof of ongoing GitHub access.
- All API routes use the existing owner bearer gate, rate limits and `Cache-Control: no-store`. A GitHub 401 becomes a connector reconnect state, never a Continuum logout.
- UI text is rendered via `textContent`; repository descriptions are untrusted display data. Repository contents are not fetched or promoted into instructions.
- This remains a single-owner agent. Owner-scoped storage is defense in depth, not a claim that team authorization has shipped.

## nGit next

Design the same connect, select, attach and revoke vocabulary around a NIP-46 remote signer, Git repository transport and Nostr repository announcements. Verify compatibility with the chosen signer before implementation; do not assume the existing browser NIP-07 login transparently supplies a headless Git signer.

[nGit's account documentation](https://ngit.dev/accounts) distinguishes the human identity key from a stored remote-signer connection credential containing a client key. The human key must remain with the signer; the separate client credential still needs explicit scoped authorization, secure custody and revocation. Reject raw nsec import. Public announcements, pushes and mirroring require explicit publication review. Read-only discovery comes before signing or publication.

## Test and rollout gates

Check genuine route authorization, consent, setup identity/permission mismatch, polling interval/slowdown, cancellation, expiry, owner/session changes, credential redaction, encrypted restart persistence, corrupt state, changed permissions, repository membership, conflicting operations and local disconnect. Inspect desktop/mobile and light/dark states. Use synthetic GitHub responses for automated and browser tests; do not claim an owner-authorized live GitHub login until the operator actually approves GitHub.

Baseline before edits: main/tag/live v0.2.187-alpha at `a7500d9f0760760e5dce0448a7260d0cc929f3d7`. Ship only via passing PR, merged-commit tag, release artifact and matching VPS deployment. Preserve prior release and encrypted state for rollback. No existing models, payment settings, balances, refunds, repository contents or human keys are changed.

## Phases after this slice

- **Read context:** bounded file tree/text viewing, provenance and explicit context attachment; no automatic private-code upload.
- **nGit read-only:** signer compatibility and repository discovery without custody of human keys.
- **Project execution:** isolated editing/build/preview, checkpoints and a clear diff.
- **Reviewed publication:** narrowly scoped writes, PRs, signed nGit events and optional mirroring.
- **Teams:** server-enforced roles and per-member grants, never shared owner tokens.
