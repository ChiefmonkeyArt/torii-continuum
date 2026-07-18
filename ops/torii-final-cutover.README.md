# Torii final VPS cutover (in-repo operator script)

`ops/torii-final-cutover.sh` is a root-owned, fail-closed cutover for
`chiefmonkey.art`. It is fetched from **one immutable annotated release tag**
and run from a verified clone — never pasted into a shell.

It:

- verifies the exact annotated release tags + version markers **before** mutating
  live state:
  - `torii-base` **v0.1.4**
  - `torii-continuum` **v0.2.65-alpha** (this script's own release tag)
  - onboarding preview **v0.1.21-preview**
- backs up the current Torii base state to a root-only timestamped directory
- redeploys `torii-base` v0.1.4 via its sanctioned bootstrap
  (`TORII_DOMAIN=chiefmonkey.art`, `SKIP_CERTBOT=1`)
- bootstraps + triggers the Continuum OPS-DEPLOY-2 unattended pull, pins the tag
  in the root-only `/etc/torii/continuum-deploy.conf`, and health/version-gates
  the live agent on `http://127.0.0.1:8787/api/health`
- resolves the onboarding-preview live layout **fail-closed**, deploys the
  preview atomically, keeps exactly one `.prev` rollback, and verifies the public
  URL returns HTTP 200 and serves the onboarding **sign-in CTA** (matched by
  intent, robust to markup/wording — see OPS-CUTOVER-6 below)
- prints a summary of service/timer/version/probe/disk state

## Live cutover status — v0.2.63-alpha shipped to production ✅

The one-time final cutover has been **completed on `chiefmonkey.art`** with
`torii-continuum` **v0.2.63-alpha** (torii-base v0.1.4, onboarding preview
v0.1.21-preview). Live acceptance passed:

- Root launcher returns **HTTP 200**; `nginx`, the torii-base **sidecar**, and the
  **continuum-agent** services are **active**.
- Kanban acceptance passed with the v0.2.63 read-only todo overlay: **Torii Quest**
  6 cards (**3 Todo / 0 Doing / 3 Done**), **Continuum** 7 cards
  (**6 Todo / 0 Doing / 1 Done**).
- Onboarding preview passed.
- The unattended **`torii-continuum-deploy.timer` is enabled and active** (turned
  on only after the successful converge, per OPS-CUTOVER-3).
- The OPS-CUTOVER-5 **free-space preflight** and rollback protections were verified
  in the live run.

The one post-deploy false-failure — the onboarding **CTA probe** rejecting a valid
live page — is fixed in **v0.2.65-alpha (OPS-CUTOVER-6, below)**. Do **not** re-run
the cutover or alter the now-enabled timer for that fix; it ships in the repo and
tests only.

## Why this replaces the pasted-heredoc delivery

The previous delivery pasted a script body straight into an interactive VPS
shell, and the paste **truncated mid-function**. An interactive shell executes
what it has received so far, so a truncated paste can start a partial, dangerous
run. Two structural defenses fix that:

1. **Anti-partial-delivery brace group.** The entire executable body lives inside
   a single `{ ... }` group whose closing brace is the last line. `bash` parses
   to the matching brace before running anything, so a truncated copy is missing
   the brace, fails with a syntax error, and runs **nothing**.
2. **No `exec sudo -- bash "$0"`.** When pasted or sourced, `$0` is the
   interactive shell (e.g. `-bash`), so that idiom re-execs the wrong thing.
   This script instead **requires root** and **refuses to be sourced**. The only
   documented invocation is:

   ```bash
   sudo bash ops/torii-final-cutover.sh
   ```

## v0.2.65-alpha robust onboarding CTA detection (OPS-CUTOVER-6)

The preview probes used to require an **exact substring**
(`Sign in with browser extension`) in the fetched HTML. On the live host the
button label is wrapped in an icon `<svg>`/`<span>`, and the CTA wording can drift
across preview revisions, so the exact match **false-failed a valid, live
onboarding page** after deployment.

Detection is now **intent-based and markup-tolerant**. `normalize_cta_text()`
strips HTML tags to spaces, collapses whitespace, and lowercases the body; then
`text_has_cta()` matches `PREVIEW_CTA_REGEX`
(`sign[ -]?in (with|using)( [a-z0-9]+)* extension`). The public probes
(`url_has_cta` / `wait_url_has_cta`) and the pre-mutation asset check all use this
matcher, so a reworded-but-valid CTA (`Sign in with a browser extension`,
`Sign in using a Nostr extension`) or a label split across `<span>`/`<svg>` still
passes, while a blank/error page (missing the tokens) still **fails closed**. The
canonical `PREVIEW_CTA` string is retained only as a human-readable label for logs
and the acceptance summary — never for matching.

## v0.2.63-alpha disk-safety hardening (OPS-CUTOVER-5)

Two safeguards make the cutover fail closed on a space-starved host **before** it
mutates any live state, complementing the v0.2.62 prune:

1. **Preflight free-space gate.** `preflight_free_space()` runs **first** in
   `main` — before `verify_release_sources` clones anything and before any
   mutation — and dies if any filesystem the cutover clones into, backs up onto,
   or `npm`-installs under (`/root`, `/home`, `/opt`, `/var/www`, deduped by
   mountpoint) has less than `PREFLIGHT_MIN_FREE_MB` (=2048 MiB) free. A starved
   host now fails up front instead of half-applying the cutover and dying
   mid-`npm ci` (the live **`ENOSPC`** failure).
2. **Backup excludes.** The rollback tar now excludes regenerable cache/build
   artifacts (`node_modules`, `.git`, `.cache`, `.npm`, `dist`, `.vite`) via
   `BACKUP_EXCLUDES`, so the backup can't itself exhaust the disk it is meant to
   protect. The excludes are scoped to regenerable artifacts **only** — the tar
   still captures `/opt/torii/env`, `registry.json` and `root_app.conf`
   byte-for-byte, so config/state is preserved for rollback.

## v0.2.62-alpha hotfix (OPS-CUTOVER-4)

Every run creates a fresh timestamped staging dir under
`/root/torii-final-cutover-<UTC_TIMESTAMP>/` (~629M each: a clone plus
`node_modules`), but nothing ever pruned the old ones. Repeated attempts
accumulated 2.5G+ of stale staging dirs on a small host and the unattended deploy
failed with **`ENOSPC` at `npm ci`**. Fixed by a prune step
(`prune_old_staging_dirs`) that runs **last** in `main`, so it is reached only
after a fully successful cutover — a failed run still leaves its newest staging
dir for inspection. It keeps only the newest `KEEP_STAGING_DIRS` (=1) dir, which
always includes the just-created `RUN_ROOT`, and removes the older ones.
Enumeration is explicit and NUL-safe via `find /root -maxdepth 1 -type d -name
'torii-final-cutover-*' -print0` (a bare `rm /root/torii-final-cutover-*` glob
does not reliably expand in every shell). The current `RUN_ROOT` is skipped
unconditionally, and the prune is scoped strictly to that staging namespace — it
never touches `/home/continuum/app` or the live webroot
`/var/www/torii/continuum`.

## v0.2.61-alpha hotfix (OPS-CUTOVER-3)

A live v0.2.59-alpha run got past the torii-base phase and then the Continuum
unattended converge failed at the **first role task** with
`continuum_user is undefined`. Two bugs, both fixed here:

1. **Unattended role vars did not resolve on a pristine checkout.** Manual
   installs copy `group_vars/all.yml.example` → `group_vars/all.yml` (gitignored)
   to supply the role's structural identity vars, but the server-side pull
   (`ops/deploy-unattended.sh`) never created that file — it wrote a two-key
   `group_vars/all.yml` (`torii_domain` + `continuum_version`), so
   `continuum_user`, `continuum_repo`, `continuum_agent_host/port`,
   `continuum_mount_path` and `continuum_vite_agent_url` were all undefined.
   Fixed by shipping those non-secret structural vars as **role defaults**
   (`ops/ansible/roles/continuum/defaults/main.yml`), so a pristine tagged
   checkout converges with **no `group_vars/all.yml` at all**. The wrapper now
   passes only the per-host values (`torii_domain`, `continuum_version`,
   `continuum_repo`) via a validated **`-e @…extra.json`** file — the highest
   Ansible precedence — and no longer writes a gitignored `group_vars/all.yml`.
   `continuum_version` stays **required** (fail-closed, never defaulted). No
   vault requirement is introduced for the existing-ansible redeploy, and live
   `config.yaml` / `session_secret` / funded key are preserved byte-for-byte.
2. **No retry storm after a failed converge.** The recurring deploy timer used
   to be enabled by the bootstrap immediately, so a broken converge would be
   retried every 5 min against a known-bad config. The cutover now installs the
   timer with `--no-enable-timer`, runs the **first converge manually**,
   health-gates it, and enables the timer **only after a fully successful
   cutover**. A failure anywhere leaves the timer installed-but-disabled, and
   rollback cannot resurrect a retry loop.

## v0.2.59-alpha hotfix (OPS-CUTOVER-2)

A live v0.2.58-alpha run surfaced two bugs, both fixed here:

1. **Public webroot served HTTP 403.** The script sets `umask 077` (correct for
   root-only backups/state), but the git checkout inherited it, so the working
   tree arrived as `0600` files / `0700` dirs. `torii-base` copies its launcher
   with mode-preserving `cp -a`, so those private modes landed in
   `/opt/torii/launcher` and nginx answered **403**. Fixed by checking out the
   sources under a **public `umask 022`**, running the sanctioned bootstrap under
   `umask 022` in a subshell, and then **enforcing `0755` dirs / `0644` files on
   the launcher webroot only**. The widening is strictly scoped to
   `/opt/torii/launcher`; `/opt/torii/env`, `registry.json` and `root_app.conf`
   sit above it and are never touched. The onboarding-preview stage (a
   `mktemp -d` created at `0700`) is normalised through the same helper before its
   atomic swap.
2. **A fatal error after mutation did not roll back.** The old `die(){ exit 1; }`
   bypassed the `ERR` trap, so `FATAL: public launcher probe failed with HTTP 403`
   exited with **no rollback**. Rollback is now driven by a single **`EXIT`-trap
   chokepoint** that fires for every exit path — a bare `set -e` abort, a
   `cmd || die` short-circuit, or an explicit `die`/`exit` — and is
   recursion-guarded so it runs exactly once. A failure *before* any mutation is a
   safe no-op.

### Recovery from the interrupted live run

The v0.2.58-alpha run failed in `validate_torii_base`, which runs **before**
`bootstrap_and_deploy_continuum` and `deploy_preview`. By phase order, **no
Continuum pin or onboarding-preview state was mutated** — only `torii-base` was
redeployed. The operator manually restored serving with:

```bash
find /opt/torii/launcher -type d -exec chmod 0755 {} +
find /opt/torii/launcher -type f -exec chmod 0644 {} +
```

which is exactly what `enforce_public_static_modes` now performs automatically.
Re-running this v0.2.61-alpha cutover from the verified clone is idempotent for
the base redeploy and proceeds through the Continuum and preview phases.

## Run it (from a verified clone, one sudo prompt)

```bash
cd /tmp
rm -rf torii-continuum
git clone --depth 1 --branch v0.2.65-alpha https://github.com/ChiefmonkeyArt/torii-continuum.git
cd torii-continuum
[ "$(git cat-file -t v0.2.65-alpha)" = tag ] || { echo "not an annotated tag"; exit 1; }
sudo bash ops/torii-final-cutover.sh
```

## Preflight — confirm the prior truncated paste changed nothing

The earlier paste truncated before any function ran (only top-level `readonly`
assignments and the broken re-exec had a chance to execute), so it should have
made **no** mutations. Confirm that before running the real cutover:

```bash
# Expect: no run dirs, no pin file, no .prev/.next preview siblings, and the
# services in whatever state they were already in (this script created none).
ls -d /root/torii-final-cutover-* 2>/dev/null || echo "OK: no cutover run dirs"
test ! -e /etc/torii/continuum-deploy.conf && echo "OK: no continuum pin file yet" || echo "NOTE: pin file already exists (inspect before running)"
ls -d /var/www/torii/onboarding-preview.prev /var/www/torii/onboarding-preview.next \
      /var/www/torii/continuum/onboarding-preview.prev /var/www/torii/continuum/onboarding-preview.next 2>/dev/null \
      || echo "OK: no half-swapped preview siblings"
systemctl is-active torii-continuum-deploy.timer 2>/dev/null || echo "OK: unattended timer not installed by the paste"
```

If any line reports a pre-existing artifact, inspect it before proceeding — the
cutover is fail-closed and backs up existing state, but you should understand any
artifact that predates this run.

## Rollback

The script creates a root-only run directory:

```text
/root/torii-final-cutover-<UTC_TIMESTAMP>/
```

Inside it:

- `backup/torii-base-backup.tar` — pre-mutation torii-base state
- `backup/torii-base-absent.txt` — paths that were absent (removed on rollback)
- `backup/continuum-deploy.conf.before` — previous Continuum pin file
- `cutover-summary.txt` — final acceptance summary
- `logs/torii-continuum-deploy.service.status.txt`
- `state/preview-nginx-hits.txt`

Preview rollback is kept at exactly one of:

- `/var/www/torii/onboarding-preview.prev`
- `/var/www/torii/continuum/onboarding-preview.prev`

On a failure after mutation, a single recursion-guarded `EXIT`-trap chokepoint
attempts to restore the preview, the Continuum pin file, and the torii-base
backup, in that order — reached from every exit path, including explicit
`die`/`exit` calls that do not fire the `ERR` trap. If rollback is incomplete:

```bash
journalctl -u torii-base-sidecar.service -u torii-continuum-deploy.service \
  -u continuum-agent.service -n 200 --no-pager
```

## Guarantees

- Public HTTPS clones only; no SSH in the deploy loop.
- No secrets read, written, or printed.
- No broad sudoers, no `NOPASSWD`, no auth weakened.
- Existing `config.yaml` / `session_secret` / funded key preserved byte-for-byte
  by the hardened Continuum role (this script delegates, it does not reimplement).
- Fail-closed: ambiguous or missing live state aborts before mutation.

## Tests

`ops/test/torii-final-cutover.test.sh` (no root, no network) asserts the
anti-truncation brace group (including that truncated copies fail `bash -n`), the
root/source guards, the absence of `exec sudo`, the pinned annotated tags +
version markers, fail-closed preview detection, atomic swap + single rollback,
health gates, backups, and the no-secrets / no-broad-sudoers invariants. The
v0.2.59-alpha hotfix adds functional replays: launcher modes forced to
`0755`/`0644` under an initial `umask 077`, a backup→mutate→restore + absent-path
cleanup, and a `die`-after-mutation harness proving the `EXIT`-trap chokepoint
rolls back (with the recursion guard), plus static asserts that mode widening
never reaches `/opt/torii/env`, `registry.json` or `root_app.conf`. The
v0.2.61-alpha hotfix adds asserts that the cutover bootstraps with
`--no-enable-timer` and enables the deploy timer **only after** the converge +
`write_report` (exactly one timer-enable call, never before the first converge).
The v0.2.65-alpha hotfix (OPS-CUTOVER-6) adds asserts that the CTA probes use the
robust matcher (no exact-substring CTA check remains) plus functional replays that
`source` the actual `normalize_cta_text`/`text_has_cta` + `PREVIEW_CTA_REGEX` from
the script and prove markup-wrapped/reworded-but-valid CTAs (including the shipped
`v0.1.21` asset) pass while blank/error pages fail closed.

`ops/test/deploy-unattended.test.sh` additionally proves the wrapper passes
per-host vars via a validated `-e` extra-vars JSON, writes **no**
`group_vars/all.yml`, and that the role's structural identity vars
(`continuum_user`, …) resolve from role defaults on a pristine checkout —
optionally dumping `continuum_user` through `ansible` when it is installed, and
falling back to static assertions otherwise.

```bash
bash ops/test/torii-final-cutover.test.sh
```
