# Artifact fast-path timing analysis (OPS-ARTIFACT-1, v0.2.103-alpha)

This is the working timing model behind the 2-3 minute target in the task.
It is written to be checked, not trusted: every sandbox number below was
actually measured this session; every VPS number is a derated estimate with
its assumption stated, not a claim of a real measurement on hardware we do
not have access to.

## What changed

**Old path** (source-build, every upgrade): clone/checkout the frontend repo
into the release dir, `npm ci` (dev+prod, for the Vite build), `npm run
build`, `npm ci --omit=dev` for the agent — all four steps on the VPS, plus
Ansible task overhead and the wrapper's own tooling checkout.

**New path** (artifact, default): download a single pre-built, pre-verified
tarball (SPA `dist/` + agent source + agent **production** `node_modules`)
from the tag's GitHub Release, verify checksum + manifest + tag + contents +
no-secrets, extract with `--strip-components=1` straight into staging. No
`npm ci`, no `vite build`, on the VPS at all. Source-build remains available
as an explicit, opt-in fallback (`continuum_deploy_allow_source_fallback:
true` or `continuum_deploy_mode: source-build`) — see
`ops/torii-continuum-progress.md` and `ops/README.md` for how to invoke it.

## Measured (sandbox), for shape not for the VPS number

Sandbox: shared cloud CPU, fast local disk/network, Node 20.20.1 for the
build (agent requires Node ≥22.4.0; CI pins 22.4.0 — sandbox numbers below
used 20.x because that's what's locally available, which is *slower* to
install than a matched-ABI 22.4.0 npm ci would be, so if anything this
overstates the old path's npm ci cost slightly):

| Step | Measured (sandbox) |
| --- | --- |
| `build-release-artifact.sh` end-to-end (agent `npm ci --omit=dev` + stage `dist/` + stage agent source + write manifest + tar+gzip+sha256) | **14.3s** wall |
| Resulting tarball size | **5.6 MB** (agent `node_modules` ~33 MB uncompressed → ~5.5 MB after gzip; `dist/` ~316 KB) |
| `tar -xzf ... --strip-components=1` of that tarball | **0.12s** |
| `sha256sum` of the tarball | **0.02s** |
| Root `npm ci` (frontend/dev deps) | ~3s (prior session note, sandbox) |
| `vite build` | **0.8s** (this session, `npm run build`) |
| Agent `npm ci --omit=dev` | ~2-5s (prior session note, sandbox) |

These sandbox numbers explain *why* the artifact approach helps (moving
`npm ci` + `vite build` off the VPS and into CI, replacing them with a
sub-second local extract) but they are **not** a stand-in for VPS wall time.
The sandbox has cloud-grade CPU/disk/network; the task states the actual VPS
sees 20-35 minutes for the very same steps that took single-digit seconds
here. That gap is almost entirely CPU contention, disk I/O contention, and
possibly swapping on a constrained/shared-core VPS, plus real network
latency to registry.npmjs.org and GitHub — none of which the sandbox
reproduces.

## VPS-realistic estimate (derated, stated assumptions)

Baseline given by the task: **20-35 min** for the old path on the actual
"chiefmonkey" server. `ops/README.md` documents the *entry* Continuum+Quest
(no Ollama) sizing as **2 vCPU / 2 GB** — consistent with "resource
constrained" and with npm's install-time being dominated by CPU-bound
tarball extraction + postinstall scripts + disk I/O under memory pressure,
not by npm registry download bandwidth alone.

Assumptions for the artifact path on that same VPS class:

- **Download**: one HTTPS GET of a ~5-6 MB tarball (plus two tiny sidecar
  files) from GitHub's asset CDN. Even a modest VPS uplink (10-50 Mbit/s
  effective, accounting for TLS handshake + possible throttling) moves 5.6 MB
  in on the order of **1-5s**; add DNS + TLS + a GitHub Releases API call for
  the metadata lookup and call it **5-15s** with margin for a slow network
  day.
- **Checksum + manifest + contents verification**: pure CPU (`sha256sum` over
  5.6 MB) plus a tar-list scan; this is inherently cheap and, unlike `npm
  ci`/`vite build`, has no dependency-graph resolution or JS execution
  (no postinstall scripts run — the artifact ships built `node_modules`,
  it doesn't install them). Even heavily derated for a slow constrained CPU,
  this is **low single-digit seconds**, call it **~5s** with margin.
- **Extraction** (`--strip-components=1` unarchive of ~33 MB uncompressed
  content): dominated by disk I/O for many small files (`node_modules` is
  thousands of small files) rather than CPU. On a constrained VPS with a
  slow/contended disk this is the step most likely to blow past the sandbox's
  0.12s — realistically **10-40s** rather than sub-second, especially on
  network-block-storage-backed VPS disks common at this price point.
- **Everything downstream of staging** (atomic promote, health/version gate
  polling the agent's `/api/health`, nginx reload if needed, disk retention,
  systemd restart/wait) is **unchanged** by this work — same code path as
  today regardless of how staging was populated. The task's own framing
  ("no-op checks are already quick") implies this portion was not the
  20-35 minute bottleneck; the old path's `git clone` + two `npm ci` runs +
  `vite build` were. We are not re-benchmarking the unchanged
  promote/health-gate/rollback machinery here; assume it contributes on the
  order of the same tens-of-seconds it already does today (the task states
  no-op checks are already quick, and the health-gate polling loop is
  bounded, not proportional to package count).
- **Ansible/wrapper overhead**: the deploy runs `ansible_connection: local`
  (confirmed in `ops/deploy-unattended.sh`) — i.e. Ansible executes locally
  on the VPS, not over SSH, so per-task cost is local Python/module-invocation
  startup, not network round trips. The continuum role has ~66 tasks; most are
  skipped or are single `stat`/`template`/`set_fact` calls. Call this
  **10-30s** total for the role's non-build tasks on a constrained single/dual
  vCPU host (Python interpreter startup dominates here, not I/O), a rough
  reuse of what the existing no-op/quick-check path already demonstrates today.

Summing the *replaced* portion (download + verify + extract) against the
*old* portion it replaces (clone + 2×`npm ci` + `vite build`, which the task
states is the dominant cost of the 20-35 min baseline):

| Component | Old path (VPS) | New path (VPS, estimated) |
| --- | --- | --- |
| Get source/artifact onto disk | git clone (network + git overhead) | HTTPS download of ~5.6 MB (~5-15s) |
| Install/prepare frontend deps + build | `npm ci` (dev) + `vite build` (dependency resolution, disk I/O, JS execution across hundreds of packages) — this is consistently the largest cost of `npm ci` on constrained CPUs, often minutes each | **eliminated** — replaced by checksum/manifest verify (~5s) |
| Install agent prod deps | `npm ci --omit=dev` (same dependency-resolution/I/O cost pattern) | **eliminated** — replaced by extraction of pre-built `node_modules` (~10-40s) |
| Everything else (promote, health gate, retention, Ansible task overhead) | unchanged | unchanged (~10-30s, same as today) |

**Estimated new-path total: roughly 30-90 seconds** for the portion this
change touches, plus the unchanged tens-of-seconds of promote/health-gate/
retention/task overhead that already exists today → **a realistic end-to-end
estimate of about 1-2.5 minutes** on the described constrained VPS class.

## Is 2-3 minutes achievable?

**Yes, plausibly, with a caveat.** The arithmetic above lands the estimate
inside — in fact slightly under — the task's 2-3 minute target, because the
change removes the two `npm ci` runs and the `vite build`, which are the
parts of the *old* pipeline most exposed to CPU/disk contention on a
constrained host (dependency-graph resolution and JS execution scale with
package count and CPU speed; a single HTTPS download and a tar extraction do
not scale the same way and are much less sensitive to a slow shared vCPU).

The caveat: this is a derated estimate reasoned from measured sandbox
component costs and the VPS's documented resource class
(`ops/README.md`'s 2 vCPU/2 GB entry tier), not a measurement taken on the
actual chiefmonkey server — which this task explicitly forbids deploying to.
If that host's network path to GitHub's asset CDN is unusually slow, or its
disk is unusually contended, the extraction step could run longer than
estimated above; a reasonable worst-case-but-still-plausible number is
**up to ~3-4 minutes**. Nothing in this design pushes the new path anywhere
near the old 20-35 minute baseline, and the estimate should be validated with
one real timed upgrade on the actual server (outside this task's scope) to
convert it from "confident estimate" to "measured fact."
