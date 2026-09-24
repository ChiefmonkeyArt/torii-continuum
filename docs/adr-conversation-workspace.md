# Conversation-first workspace and private session history

Date: 2026-09-24. Release: v0.2.187-alpha. Scope: navigation, durable history and pins, project workspace layout.

## Decision

Keep the existing vanilla-JavaScript application and amber design system. Make New chat, conversation search, pins, projects and recent history the primary navigation. Move existing administrative and secondary tools into a native, keyboard-accessible upward-opening profile menu. Preserve old tool routes, authentication, update confirmation and theme controls.

Use the same chat controller and payment pipeline in both floating and full workspace layouts. Reparent the live composer rather than mounting a duplicate. A project workspace combines its conversation with Context, Tasks, Files and Chats; the existing Overview and Board remain linked routes. Mobile project details collapse so the composer remains available.

New independent conversations use random UUID identifiers. Existing page/project thread keys remain readable. A conversation's optional title, pin and project association are additive fields inside the existing NIP-44 sealed session blob, not plaintext server index fields. Version-1 blobs without metadata still decrypt. List results expose only the same ID, timestamps, size and digest as before. Search operates on browser-decrypted titles, not a new external index.

Server writes serialize per owner to prevent concurrent session-index loss. New clients send the last ciphertext digest, or null for a new ID; a mismatch returns HTTP 409 and preserves the newer server copy. Legacy clients remain accepted when that field is absent. Reads use the same serialization boundary. A corrupt index fails closed on writes.

Client save/delete operations serialize per session. Delete waits for pending writes and prevents later saves from recreating the deleted session within the current library lifetime. Sign-out/identity changes invalidate delayed decrypt and write results. Sealing checks signer identity against the authenticated public key. Pins and titles show success only after server acknowledgement.

The private-history cache follows the public key, original login time and local auth epoch, not the rotating token bytes. Normal authenticated renewal retains history; sign-out, a fresh login or an owner change invalidates it. This cache key grants no authority: all transport requests still require agent-verified tokens.

## Privacy and compatibility

- No human password, private key, seed, signer key or decrypted conversation is added to server persistence.
- Production chat no longer creates a plaintext localStorage transcript. Any pre-existing legacy cache is left untouched for recovery, but not treated as an authoritative cross-owner history source.
- If the signer cannot decrypt a stored session, keep it locked and never replace its ciphertext with an empty conversation. Show save failures instead of pretending history persisted.
- The existing 100-message client history bound, 200-session server quota and sealed-blob byte limit are unchanged. Large conversations can still hit the byte limit; preserve the tab and report save failure.
- This is still the existing single-owner agent. Team navigation is preserved, but no new multi-user authorization, shared session access or live collaboration is claimed.
- No new paid tests, retries, wallet writes, provider changes, reasoning-mode changes or spending-limit changes are part of this release.
- New-install chat templates select `deepseek-v4-flash`. Standalone and Suite installs copy the example config; Ansible renders its matching template. Existing config and saved model overrides are not migrated. Existing provider fallback policy is unchanged.

## Rollback checkpoint

Before edits, fetched main and all tags and checked the newest tag against main. Both were `f81ae2ad8a30e937ef9bd9b4c8141d0ecc5e0177`, tagged `v0.2.186-alpha`; live health also reported `0.2.186-alpha`. Its release artifact remains available.

The preferred rollback is a reviewed revert PR followed by the next free release version, preserving main/tag/live equality. An emergency deployment of the existing v0.2.186-alpha artifact can restore the prior interface; report the temporary version divergence and then reconcile through a revert PR. Do not reset production Git or delete session data.

No destructive storage migration is introduced. Before any rollback, retain the deployment's current encrypted session directory as well as config/state backups. The older serializer understands messages but can drop the new optional pin/title metadata when subsequently rewriting a conversation, so an old-binary rollback is not a substitute for a retained encrypted backup.

## Acceptance and rollout

Test real route boot, old blobs, independent new conversations, project association, pin/unpin after reload, stale-tab conflicts, concurrent server creates, delayed sign-out results, and delete-after-save ordering. Exercise desktop/mobile, dark/light, profile menu, search, tabs, todo toggles, missing project, missing signer, and unauthenticated endpoints. All model/provider calls in local UI testing use synthetic transport fixtures; do not imply those checks spent funds or used the production signer.

Ship through a PR, passing CI, merged-commit tag and release artifact, then deploy that tag. Independently verify health, agent commit, frontend tag, auth boundaries and unchanged existing model/caps. Record runtime results on the release PR.
