# Suite-owned chat proxy deadline and explicit installer rollout

Status: accepted for the v0.2.178-alpha / Suite v0.9.23-alpha release pair.

## Evidence and decision

The live Suite-generated `/agent/` proxy closed `POST /agent/api/chat` at
60 seconds on 2026-09-22. The agent's configured total budget is 100 seconds
and the browser waits 115 seconds. Updating the separate root `/api/` proxy
does not change the `/agent/` route used by this frontend.

Suite owns this nginx fragment. Its v0.9.23-alpha installer supplies connect
5s, read 120s and send 120s. Continuum's model selection, payment policy,
provider timeouts, credentials and owner data remain unchanged.

The manual Continuum deployment workflow accepts an optional explicit
`suite_tag`. It invokes the tested `ops/lib/select-suite-release.sh` helper
through the existing host-key-pinned SSH connection. The helper requires the
canonical HTTPS Suite origin, a clean tracked working tree, an immutable tag
fetch, tag ancestry in main, and an exact tag/VERSION match. It selects the
commit without force/reset/clean; ignored `.env` data is preserved. Existing
deployments without `suite_tag` retain their current installer.

## Verification and limits

Suite's tests render the actual fragment and exercise real nginx with a delayed
response beyond the former cutoff, at a 1:100 timing scale. Continuum's helper
tests reject invalid/injected tags, foreign origins, local edits, failed
fetches, unmerged tags, version mismatches and untracked checkout collisions.

After deployment verify Suite checkout SHA/tag, Continuum agent health,
frontend version, and the effective `/agent/` proxy deadlines. A successful
health check or mocked proxy test does not prove an owner's paid chat response.
No paid inference is issued as part of these tests.

This change does not install the missing in-app update consumer or clear its
existing queued request. That remains a separately recorded operational issue.
