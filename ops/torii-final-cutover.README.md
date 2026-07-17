# Torii final VPS cutover (in-repo operator script)

`ops/torii-final-cutover.sh` is a root-owned, fail-closed cutover for
`chiefmonkey.art`. It is fetched from **one immutable annotated release tag**
and run from a verified clone — never pasted into a shell.

It:

- verifies the exact annotated release tags + version markers **before** mutating
  live state:
  - `torii-base` **v0.1.4**
  - `torii-continuum` **v0.2.52-alpha** (this script's own release tag)
  - onboarding preview **v0.1.21-preview**
- backs up the current Torii base state to a root-only timestamped directory
- redeploys `torii-base` v0.1.4 via its sanctioned bootstrap
  (`TORII_DOMAIN=chiefmonkey.art`, `SKIP_CERTBOT=1`)
- bootstraps + triggers the Continuum OPS-DEPLOY-2 unattended pull, pins the tag
  in the root-only `/etc/torii/continuum-deploy.conf`, and health/version-gates
  the live agent on `http://127.0.0.1:8787/api/health`
- resolves the onboarding-preview live layout **fail-closed**, deploys the
  preview atomically, keeps exactly one `.prev` rollback, and verifies the public
  URL returns HTTP 200 with the exact CTA `Sign in with browser extension`
- prints a summary of service/timer/version/probe/disk state

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

## Run it (from a verified clone, one sudo prompt)

```bash
cd /tmp
rm -rf torii-continuum
git clone --depth 1 --branch v0.2.52-alpha https://github.com/ChiefmonkeyArt/torii-continuum.git
cd torii-continuum
[ "$(git cat-file -t v0.2.52-alpha)" = tag ] || { echo "not an annotated tag"; exit 1; }
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

On a failure after mutation, the `ERR` trap attempts to restore the preview, the
Continuum pin file, and the torii-base backup, in that order. If rollback is
incomplete:

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
health gates, backups, and the no-secrets / no-broad-sudoers invariants.

```bash
bash ops/test/torii-final-cutover.test.sh
```
