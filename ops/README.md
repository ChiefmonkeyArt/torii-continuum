# Continuum ops

Everything you need to run Torii Continuum on your own VPS instead of on
`pplx.app`.

Two paths are supported:

- **Full box (Ansible)** — provisions a whole host: torii-base, the
  Continuum frontend + agent, TLS, and optionally Ollama. Start here for a
  fresh server.
- **Agent only (`install-agent.sh`)** — drops just the hardened agent +
  systemd unit + optional same-origin `/api/` proxy onto a host you already
  run. See [Standalone agent install](#standalone-agent-install-install-agentsh).

Contents:

- `ansible/` — full playbook that installs [torii-base](https://github.com/ChiefmonkeyArt/torii-base),
  Continuum (frontend + agent), and optionally Ollama.
- `install-agent.sh` — standalone, idempotent agent installer.
- `systemd/torii-continuum-agent.service` — hardened systemd unit for the
  standalone install.
- `nginx/torii-api.conf` — same-origin `/api/` reverse-proxy snippet for the
  standalone install.
- `nginx/continuum.conf.template` — annotated source for the nginx fragment
  the Ansible installer renders.

---

## Why a VPS?

The published `pplx.app` build of Continuum is static-only. It's great for
trying the UI, but three key pieces don't run in that sandbox:

- **Routstr chat** — needs a persistent Cashu float on-server.
- **Character memory** — encrypted at rest, decrypted at runtime.
- **Ollama local models** — needs a background daemon on the same host.

Running Continuum on a small VPS with `torii-base` gives you all three, on
a domain you control, sharing one nostr identity with the other Torii apps
mounted next to it (Plebeian, Quest).

---

## What the installer does

```
Ubuntu 22 / 24 host
├── torii-base
│   ├── nginx  (Let's Encrypt TLS)
│   ├── launcher at /
│   └── sidecar (127.0.0.1:8780)
├── continuum
│   ├── /continuum/ (static SPA, served from public webroot /var/www/torii/continuum)
│   ├── /continuum/api/ → 127.0.0.1:8787 (agent)
│   └── continuum-agent.service (systemd, hardened)
└── (optional) ollama
    └── 127.0.0.1:11434, models pulled per config
```

Everything runs as unprivileged users. The agent binds to loopback only —
external traffic never bypasses nginx.

---

## VPS sizing

Continuum agent alone is tiny (~100 MB RAM). Ollama is the dominant cost.

| Config                                        | RAM   | Disk  | vCPU | Rough £/mo (Hetzner) |
| --------------------------------------------- | ----- | ----- | ---- | -------------------- |
| Continuum + Quest, no Ollama                  | 2 GB  | 30 GB | 2    | £4–6                 |
| + Ollama 3B (llama3.2:3b)                     | 6 GB  | 50 GB | 2–3  | £8–10                |
| + Ollama 8B (llama3.1:8b) or 7B (qwen2.5:7b)  | 12 GB | 60 GB | 4    | £18–25               |
| + Ollama 14B (qwen2.5:14b, CPU-only)          | 16 GB | 80 GB | 4–6  | £30+                 |

Recommended starting point: **Hetzner CPX21** (3 vCPU, 8 GB, 80 GB) at
around £8/mo. Comfortably runs Continuum + Quest + Ollama 3B, with headroom
for one more small app.

Rough Ollama throughput on shared-CPU VPSes (Q4_K_M quant):

- 3B model: ~15 tok/s on 2 vCPU. Chat is fluid.
- 7B model: ~7 tok/s on 4 vCPU. Chat is tolerable, reflection is fine.
- 8B model: ~5 tok/s on 4 vCPU.
- 14B model: ~2 tok/s on 4 vCPU. Reflection only — don't use for chat.

For 8B+ chat on a live UI, get a GPU box (Hetzner GEX44 or a dedicated
Nvidia server); numbers above assume CPU-only.

---

## Quickstart (Ansible)

**On your workstation** (any OS with Ansible 2.14+):

```bash
git clone https://github.com/ChiefmonkeyArt/torii-continuum.git
cd torii-continuum/ops/ansible

cp inventory.yml.example inventory.yml
cp group_vars/all.yml.example group_vars/all.yml
cp group_vars/vault.yml.example group_vars/vault.yml

# Fill in inventory (your VPS IP/user), all.yml (your domain, models),
# and vault.yml (admin_npub, session_secret, cashu mints).

ansible-vault encrypt group_vars/vault.yml
ansible-playbook -i inventory.yml site.yml --ask-vault-pass
```

That's the whole installer. Re-running it is idempotent — the playbook is
safe to re-run to update Continuum, rotate config, or add Ollama later.

To enable Ollama on an existing deployment:

```bash
# edit group_vars/all.yml:  torii_enable_ollama: true
ansible-playbook -i inventory.yml site.yml --ask-vault-pass --tags ollama,continuum
```

---

## Adopting a standalone install with Ansible (v0.2.40-alpha)

If a box already runs the **standalone** agent (`install-agent.sh` →
`/opt/torii/continuum-agent`, unit `torii-continuum-agent.service`, port 8787)
and you now want Ansible to manage it, the continuum role adopts it **safely and
without ever asking you to display, copy, or paste `session_secret`,
`admin_npub`, or any key**. You do not touch secrets at all.

What the role does, in order, on `--tags continuum`:

1. **Detects** the layout (`fresh` | `adopt-standalone` | `partial-adoption` |
   `existing-ansible`) via `ops/lib/continuum-adopt.sh`. A real git-backed Ansible
   layout always wins — adoption never runs on top of it. A non-git app dir that
   carries state is a `partial-adoption` to be recovered, not built on top of.
2. **Backs up** `config.yaml` + `memory/` + `ciphertexts/` + `pending/` from
   both layouts to a **timestamped root-only `0700`** dir under
   `/root/continuum-backup-<UTC>/` *before any mutation*. This is **fail-closed**:
   if the backup can't be written, the play aborts and nothing is changed.
3. On **adopt-standalone**: stops + disables `torii-continuum-agent.service`
   (freeing port 8787 so the two units never double-bind), then **migrates the
   existing `config.yaml` and encrypted state verbatim** into
   `/home/continuum/app/agent/`. The live `session_secret` is copied
   byte-for-byte — never regenerated — so the funded Routstr key stays decryptable.
4. **Never overwrites** an existing `config.yaml` on a routine deploy. A fresh
   config is rendered from vault **only** on a genuinely fresh install. If your
   vault `session_secret` differs from the live one, the role **preserves the
   live config** and prints a safe `differ` notice that reveals **no value**.
5. Wraps the service + nginx cutover in a transactional block; on failure it
   prints the backup path and an exact recovery command instead of leaving a
   half-migrated box.

Run it exactly like a normal deploy — no extra flags, no secret handling:

```bash
cd torii-continuum/ops/ansible
ansible-playbook -i inventory.yml site.yml --ask-vault-pass --tags continuum
```

### Vault-free adoption / redeploy (v0.2.41-alpha)

Adopting or redeploying an **existing** install preserves `config.yaml`
byte-for-byte, so it needs **no `group_vars/vault.yml`, no `admin_npub`,
`session_secret`, or `cashu_mints`, and no vault password**. From v0.2.41-alpha
the role guards the drift diagnostic (which would otherwise render a candidate
config referencing those vault vars) behind their presence and simply **skips**
it when they are absent — no undefined-variable error, no clobber. On a fresh
public clone of the current live standalone box you can therefore run:

```bash
cd torii-continuum/ops/ansible

# inventory.yml — localhost over a local connection, no SSH, no secrets
cat > inventory.yml <<'YAML'
all:
  children:
    torii:
      hosts:
        localhost:
          ansible_connection: local
YAML

# group_vars/all.yml — non-secret vars only
mkdir -p group_vars
cat > group_vars/all.yml <<'YAML'
torii_domain: chiefmonkey.art
continuum_version: v0.2.41-alpha
YAML

# No vault.yml, no --ask-vault-pass. Adoption preserves the live config.
ansible-playbook -i inventory.yml site.yml --tags continuum
```

The role detects `adopt-standalone` (or `existing-ansible`), backs up
fail-closed, migrates state verbatim, preserves the live `session_secret`, and
prints a notice that the drift diagnostic was skipped for lack of vault vars.

Only a **fresh** install or an **explicit rotation** needs the vault vars: when
they are absent in those modes the play **fails closed** with a clear,
non-secret message *before* writing any config or mutating any state.

**Deliberate secret rotation (rare, dangerous).** Rotating `session_secret`
re-encrypts nothing and *orphans an already-funded Routstr key*. It is therefore
OFF by default. Only when you truly intend it, opt in per-run:

```bash
ansible-playbook -i inventory.yml site.yml --ask-vault-pass --tags continuum \
  -e continuum_allow_config_rotation=true
```

### Transactional cutover + partial-adoption recovery (v0.2.42-alpha)

An earlier adoption failed because it migrated live state *into*
`/home/continuum/app/agent` and only *then* tried to `git clone` into
`/home/continuum/app` — cloning into a directory already populated with runtime
state. That left the box with the **original standalone layout intact** *and* a
**partial, non-git `/home/continuum/app`** holding a copy of the state. From
v0.2.42-alpha the role is fully transactional and recovers from exactly that
state, idempotently:

1. **Detects `partial-adoption` explicitly** — agent dir has state but the app
   dir has no `.git` while the standalone is still present. It is never mistaken
   for a valid Ansible install, and the **untouched standalone** remains the
   authoritative state source (not the partial copy).
2. **Builds in a clean staging dir** (`/home/continuum/app.staging`) — the
   `git checkout` + `npm ci` + `vite build` all happen there while the **old unit
   keeps serving traffic**. A clone/build failure leaves the running install
   completely untouched.
3. **Copies authoritative state in only after a successful build**, then stops
   the old unit (freeing 8787 for the shortest possible window) and **atomically
   swaps** staging into `/home/continuum/app`. Any pre-existing app dir — a valid
   Ansible tree *or* the partial non-git tree — is **moved to a timestamped
   `app.quarantine-<UTC>` dir, never deleted**.
4. On **any cutover or health-check failure** the `rescue` stops the new unit,
   rolls an existing-Ansible tree back from quarantine (or re-enables the
   original standalone unit for adopt/partial), and prints the backup +
   quarantine paths with an exact, **secret-free** recovery command.

To recover the **current partial-adoption VPS** (original standalone still
serving, partial non-git `/home/continuum/app` present), run the vault-free
invocation above with `continuum_version: v0.2.42-alpha`. The role will detect
`partial-adoption`, back up both layouts, build in staging while the standalone
keeps running, migrate the standalone's live config + funded key verbatim, and
atomically promote — quarantining the partial tree. Re-running after any failure
is safe and idempotent.

Adoption tunables live in `roles/continuum/defaults/main.yml`
(`continuum_standalone_dir`, `continuum_standalone_service`,
`continuum_backup_root`, `continuum_allow_config_rotation`,
`continuum_release_dir`, `continuum_quarantine_dir`) and rarely need changing.
The logic is unit-tested in `ops/test/continuum-adopt.test.sh`.

### Live-discovered corrections (v0.2.43-alpha)

The v0.2.42-alpha cutover succeeded manually, but three environment realities on
the live box had to be worked around by hand. v0.2.43-alpha encodes all three
permanently so a clean re-run needs no manual steps.

1. **Torii CLI `register` takes flags, not positionals.** The installed CLI is
   `torii register <name> [--display …] [--desc …] [--version …]`; the old
   positional form failed with `unknown flag: Continuum`. The role now calls
   `torii register continuum --display "Continuum" --desc "App builder + agent"
   --version 0.2.43-alpha` (the bare semver is derived from `continuum_version`
   with its leading `v` stripped). Names/labels are `continuum_register_*` vars.
2. **`MemoryDenyWriteExecute` must stay off for Node.** Node 22's V8 JITs with
   W^X memory; `MemoryDenyWriteExecute=yes` makes the kernel refuse the mprotect
   and V8 aborts on startup (fatal `SetPermissions` / errno 12 / `SIGTRAP`). The
   rendered unit now sets `MemoryDenyWriteExecute=no` **and documents why**, while
   keeping every other compatible directive (`NoNewPrivileges`, the `Protect*`
   set, `RestrictNamespaces`, `LockPersonality`, empty `CapabilityBoundingSet`,
   …). The role also runs a **Node V8 JIT smoke test** under the rendered
   `MemoryDenyWriteExecute` value (via a transient `systemd-run` scope) *before*
   starting the real service, so a reintroduced `=yes` fails fast with a clear
   message instead of a crash-loop.
3. **nginx cannot traverse `/home/continuum`.** The `0750` home plus the agent
   unit's `ProtectHome` mean www-data cannot descend into it, so aliasing the SPA
   out of `/home/continuum/app/dist` returned HTTP 500. The build is now published
   to a **public webroot `/var/www/torii/continuum`** (root-owned, dirs `0755` /
   files `0644`) via an atomic staged swap that keeps the prior webroot as a
   timestamped backup for rollback. Only the static bundle is copied out — the
   app/agent **source and encrypted state stay private** under
   `/home/continuum/app`. A **single** `location /continuum/` prefix alias serves
   both the SPA entry and the hashed `assets/*` bundle. The earlier nested
   `location /continuum/assets/` block re-mapped the path and returned 404 for the
   hashed `.js`/`.css` (a black page); it has been removed so `try_files` on the
   parent alias serves assets directly and only genuine misses fall back to
   `index.html`. No regex-alias, no `/home` traversal.

The cutover `rescue` now also **rolls the webroot back** from its backup and
reloads nginx on failure. Re-running against the now-live v0.2.42 Ansible layout
is idempotent: it re-detects `existing-ansible`, **preserves** config (never
rotates `session_secret`, never touches the funded key), and re-publishes the
webroot while keeping the prior bundle as a backup.

New tunables in `roles/continuum/defaults/main.yml`: `continuum_webroot`,
`continuum_webroot_parent`, `continuum_webroot_stage`, `continuum_webroot_backup`,
and `continuum_register_name` / `_display` / `_desc`.

**Upgrade the now-live v0.2.42 Ansible box to v0.2.43-alpha** (vault-free; the
live config + funded key are preserved byte-for-byte).

On the live box the v0.2.42 checkout sits at `/opt/deploy/torii-continuum-v0.2.42-alpha`
and the promoted app lives at `/home/continuum/app`. Rather than mutating that
checkout in place, do a **fresh, version-specific clone** of the final tag (after
this PR merges and `v0.2.43-alpha` is tagged) into a parallel dir, then run the
same localhost, vault-free `existing-ansible` redeploy. The role re-detects the
live layout and preserves state; a fresh dir keeps the previous release intact for
an instant rollback.

```bash
# After merge + tag. (Pre-merge, replace `--branch v0.2.43-alpha` with
# `--branch hardening-live-corrections-v0.2.43-alpha`.)
SRC=/opt/deploy/torii-continuum-v0.2.43-alpha
sudo git clone --depth 1 --branch v0.2.43-alpha \
  https://github.com/ChiefmonkeyArt/torii-continuum.git "$SRC"
cd "$SRC/ops/ansible"

# Localhost, no SSH, no vault. NO vault.yml is created or referenced.
cat > inventory.yml <<'YAML'
all:
  children:
    torii:
      hosts:
        localhost:
          ansible_connection: local
YAML
mkdir -p group_vars
cat > group_vars/all.yml <<'YAML'
torii_domain: chiefmonkey.art
continuum_version: v0.2.43-alpha
YAML

# existing-ansible redeploy: preserves config + funded key, republishes the
# public webroot (prior bundle kept as a timestamped backup), registers via flags.
sudo ansible-playbook -i inventory.yml site.yml --tags continuum

# validate
sudo nginx -t && sudo systemctl status continuum-agent --no-pager
curl -sf http://127.0.0.1:8787/api/health
curl -sf https://chiefmonkey.art/continuum/api/health
```

### Root-app selector correction (v0.2.44-alpha)

A live v0.2.43 rerun surfaced one more exact bug: the shipped default
`torii_root_app: launcher` made the role run `torii set-root launcher`, and the
installed CLI/API answered **404 `{error: app_not_installed, name: launcher}`** —
so the whole cutover rolled back. The Torii Suite launcher that owns `/` is **not
a registered app**; the CLI represents it as the sentinel **`none`**. (The correct
manual rerun is `-e torii_root_app=none`; the rollback itself worked.)

v0.2.44-alpha fixes this permanently:

- `group_vars/all.yml.example` now defaults to **`torii_root_app: "none"`** (launcher
  at root), with a comment that a registered app name is only for deliberate use
  and that Continuum-as-root is discouraged.
- The role no longer calls `set-root` raw. It goes through
  `continuum-adopt.sh set-root-safe`, which **normalizes** legacy/empty/`launcher`
  (and synonyms `torii`/`base`/`root`/`home`/`homepage`/`default`) to `none`, sources
  the admin token from `/opt/torii/env` silently, **skips** the call when the root
  already matches (`torii get-root`), and returns 0 for the default so a normal
  install can never trip the rescue rollback. An explicit **registered** app name
  still passes through unchanged; pointing the root at `continuum` emits a
  discouraged-choice warning but is honoured when set deliberately.
- **Continuum is never made the root by its own installer** — the launcher keeps `/`.

No override is needed anymore for a default install; `set-root none` is idempotent.
The `continuum-adopt` test suite grew to **219** assertions, including a mock CLI
that reproduces the exact live 404 and proves `launcher` normalizes to `none`.

---

### Restart-before-readiness + version-asserting health gate (v0.2.48-alpha)

The systemd unit is deliberately version-independent (`ExecStart=/usr/bin/node
index.mjs`, no version in the path), so a **code-only** promotion (new tree, same
unit file) previously left the old `node` process running while readiness accepted
any HTTP 200 — a stale process could serve the old release and still pass. OPS-DEPLOY-1
fixes this so every promotion restarts the agent exactly once before readiness, and
readiness now proves the live process serves the deployed release:

- Handlers are flushed mid-play so a unit-file change restarts the agent (via the
  `restart continuum-agent` handler, after `reload systemd`) **before** readiness.
- A code-only promotion (unit unchanged) fires an explicit `state: restarted`,
  guarded so a unit-change deploy never restarts twice.
- Readiness (`/api/health`) now requires **HTTP 200 AND** `json.version ==
  continuum_version` with the leading `v` stripped, retried 15×2s. A stale process
  reporting the old version fails the gate and trips the existing rescue rollback.

**`continuum_version` must be a v-prefixed semantic release tag in production.**
It does double duty: it is both the git checkout ref (`ansible.builtin.git`'s
`version:`) **and** the expected live version the readiness gate asserts against.
`/api/health` returns `agent/package.json`'s version (e.g. `0.2.48-alpha`), so the
gate passes only when the ref string (minus a leading `v`) equals that version —
which holds exactly when you deploy the matching tag, e.g.:

```
continuum_version: v0.2.48-alpha
```

A **branch** (`main`) or a **commit SHA** checks out fine but will never match the
package version, so the deploy **intentionally fails closed** and rolls back. This
coupling is deliberate for this release (no separate expected-version variable was
introduced); use branch/SHA refs only for local/dev experiments where a readiness
rollback is acceptable. Keep the git tag and both `package.json` versions in lockstep.

The `deploy-restart` test suite adds **25** hermetic assertions covering the
restart wiring in all unit/promote combinations, handler/daemon-reload ordering, the
stale-version-fails / correct-version-passes gate logic, and secret hygiene.

---

### Unattended deployment — server-side pull (OPS-DEPLOY-2, v0.2.50-alpha)

The redeploy above still needs a human to run `ansible-playbook` on the box. If
your local automation **cannot make outbound SSH** and the VPS SSH login
**prompts for a password**, a push deploy is impossible. OPS-DEPLOY-2 adds a
**server-side pull**: a small, root-owned wrapper the VPS runs on a timer, which
**delegates to the same hardened role** (it never reimplements backup, the atomic
cutover, the health/version gate, rollback, or cleanup — those stay in the role).

Components (all under `ops/`):

- **`deploy-unattended.sh`** → installed as `/usr/local/sbin/torii-continuum-deploy`.
  Validates the target tag against a strict `v<semver>` grammar (branches, SHAs,
  and every shell/YAML metacharacter are refused), checks an optional allowlist,
  optionally verifies a GPG-signed tag (`git tag -v`), **no-ops if the live
  `/api/health` version already matches**, clones the tag into a fresh
  `/opt/deploy/torii-continuum-<tag>`, runs the localhost vault-free
  `--tags continuum` redeploy, independently re-verifies the live version, and
  prunes old release dirs (keeping the newest N and never the live one).
  `flock`-guarded and fail-closed at every step. **No secret is read or logged**
  — the vault-free path preserves `config.yaml` / `session_secret` / the funded
  key byte-for-byte.
- **`systemd/torii-continuum-deploy.{service,timer}`** — the SSH-free trigger.
  The timer fires the wrapper every ~5 min; it is a cheap no-op until the pin
  file names a new tag. **No inbound SSH, no open ports.**
- **`sudoers/torii-continuum-deploy.example`** — OPTIONAL, for a remote/CI
  trigger. Grants a locked, non-login principal (`toriideploy`) `NOPASSWD` on
  **exactly the wrapper and nothing else** — never general passwordless sudo.
- **`deploy-bootstrap.sh`** — the idempotent, fail-closed one-time installer.

**One-time bootstrap** (the only time you need the interactive SSH password):

```bash
# On the VPS, from a torii-continuum checkout, as root:
sudo ops/deploy-bootstrap.sh
# (optional remote/CI trigger path, with a dedicated key + scoped sudo:)
# sudo ops/deploy-bootstrap.sh --with-ssh-key
```

Then edit the root-only pin file to authorize a release — this is the **only**
action needed for every subsequent unattended deploy:

```bash
sudo sed -i \
  -e 's/^CONTINUUM_TARGET_TAG=.*/CONTINUUM_TARGET_TAG=v0.2.50-alpha/' \
  -e 's/^CONTINUUM_DOMAIN=.*/CONTINUUM_DOMAIN=chiefmonkey.art/' \
  /etc/torii/continuum-deploy.conf
# converges within ~5 min on the timer, or trigger it now:
sudo systemctl start torii-continuum-deploy.service
journalctl -u torii-continuum-deploy -f          # watch it (no-op unless tag changed)
```

Because the wrapper asserts the live `/api/health` version equals the pinned tag
(on top of the role's own gate) and the role rolls back on any failure, a bad
release **fails closed and self-reverts** without human intervention. Once you
publish **signed** tags and install the signing pubkey, set
`CONTINUUM_REQUIRE_SIGNED_TAGS=1` in the pin file to add supply-chain
verification. The `deploy-unattended` test suite adds **55** hermetic assertions
(tag grammar incl. injection strings, version gate, allowlist fail-closed,
prune-keeps-live, scoped-sudo/no-general-sudo, 0600 pin file, root-only wrapper).

---

## Standalone agent install (`install-agent.sh`)

The Ansible playbook above provisions a whole box. If you already have a
gateway host with nginx + TLS (your Torii, your gateway) and just want to
drop the **agent** onto it as a hardened service, use the standalone
installer instead. It touches only the agent, its systemd unit, and an
optional same-origin `/api/` nginx proxy — nothing else on the host.

### Prerequisites

- A Linux host you control with `node` (**>= 22.4.0**), `npm`, `rsync`,
  `openssl`, `systemctl`, and `getent` on `PATH`. **Node 22 LTS is a hard
  deployment prerequisite, not a recommendation** — the installer refuses to
  run on anything older and stops before touching any user, service, or file.
  The Cashu money-path dependency (`@cashu/cashu-ts` v3-lts) declares
  `engines.node >=22.4.0` across its whole line; an `EBADENGINE` warning during
  `npm ci` is **not** an acceptable production state for a wallet. If your host
  is on Node 20, upgrade it to the Node 22 LTS line first — this is a
  coordinated prerequisite step, not something to defer.
- Root (the installer creates a system user and writes to `/opt` and
  `/etc/systemd`).
- Optional: `nginx` (for the same-origin proxy) and `curl` (for the health
  proof). Both are auto-skipped if absent.

### Install / upgrade

From a checkout of this repo, as root:

```bash
sudo ./ops/install-agent.sh
```

To also wire the `/api/` proxy into an existing server block automatically,
first drop a one-line marker **inside the correct HTTPS `server { … }` block**
(the one for your Console's domain, `listen 443 ssl`):

```nginx
# TORII_API_INCLUDE
```

then point the installer at that site file:

```bash
sudo TORII_NGINX_SITE=/etc/nginx/sites-available/torii ./ops/install-agent.sh
```

The installer replaces **only** that marker line with
`include snippets/torii-api.conf;`, preserving indentation, and leaves a
`.torii.bak` of the file. It never guesses which `server{}` block to edit — a
site file often has both an HTTP→HTTPS redirect server and the real TLS server,
and wiring `/api/` into the redirect block would 301 the API. If you set
`TORII_NGINX_SITE` without placing the marker, the installer **fails with an
instruction** rather than editing the wrong block. (Already having the literal
include line in place is detected and left alone — the wiring is idempotent.)

Environment overrides (all optional):

| Variable            | Effect                                                          |
| ------------------- | -------------------------------------------------------------- |
| `TORII_NGINX_SITE`  | server-block file whose `# TORII_API_INCLUDE` marker is swapped for `include snippets/torii-api.conf;` |
| `SKIP_NGINX=1`      | install agent + systemd only, skip all nginx steps             |
| `SKIP_HEALTHCHECK=1` | skip the final `/api/health` probe (e.g. air-gapped test)     |

The same command upgrades an existing install: re-running is idempotent. It
re-syncs code (`rsync --delete`), re-asserts ownership + permissions,
re-runs `npm ci --omit=dev`, and restarts the service — but it **never**
touches persistent state (`memory/`, `pending/`, `ciphertexts/`) or an
existing `config.yaml`.

### What it lays down

```
/opt/torii/continuum-agent/            # 0750, owned by continuum:continuum
  index.mjs, core/, scripts/, ...      # agent code (read-only to the service)
  node_modules/                        # production deps (npm ci --omit=dev)
  config.yaml                          # 0600, generated once, never clobbered
  memory/  memory/wallet/              # 0700, persistent — Cashu float + logs
  pending/  ciphertexts/               # 0700, persistent

/etc/systemd/system/torii-continuum-agent.service
/etc/nginx/snippets/torii-api.conf                 # same-origin /api/ proxy
/etc/nginx/conf.d/torii-api-ratelimit.conf         # http-context rate-limit zone
```

The service account `continuum` is a locked, non-login system user
(`--shell /usr/sbin/nologin`, `passwd --lock`).

### Config generation

On a first install the script renders `config.yaml` from
`config.example.yaml`, injecting a fresh 32-byte hex `session_secret`
(`openssl rand -hex 32`) and leaving `admin_npub` empty. The secret is
written straight into a `0600` file and never echoed. If `config.yaml`
already exists it is preserved untouched. The generated config is then
parsed by the agent's own loader before the service is (re)started, so a
bad config fails the install instead of crash-looping the service.

### nginx: contexts matter

Two files, two contexts — this is deliberate and required by nginx:

- `snippets/torii-api.conf` holds the `location /api/ { ... }` block and
  **must be included inside a `server { ... }` block** — your gateway's
  HTTPS server for the Console's domain.
- `conf.d/torii-api-ratelimit.conf` holds the `limit_req_zone` directive,
  which is only valid in the **http context**. Debian/Ubuntu's stock
  `nginx.conf` auto-includes `conf.d/*.conf`, so it lands in the right
  place automatically.

The zone name (`torii_api_limit`) is deliberately specific so it won't
collide with a generic global zone. The installer refuses to write the zone
fragment if a zone of that name is already declared anywhere under
`/etc/nginx`, and always runs `nginx -t` before reloading — it never
reloads a broken config. If you wire the include yourself, add this inside
your HTTPS (`listen 443 ssl`) server block:

```nginx
include snippets/torii-api.conf;
```

(Or place the `# TORII_API_INCLUDE` marker there and let the installer swap it
in via `TORII_NGINX_SITE` — see [Install / upgrade](#install--upgrade). Either
way, put it in the TLS server block, not an HTTP→HTTPS redirect block.)

The agent listens on `127.0.0.1:8787` only; nothing reaches it except
through this proxy. nginx is the single hop in front, on the same host, so
`$remote_addr` is the real client and is passed as `X-Real-IP` — that is
the agent's rate-limit bucket key. Do not add another proxy in front
without revisiting that assumption.

### Rate limiting (defence in depth)

Two independent layers:

1. **In-process** — the agent rate-limits its auth surface with
   `@fastify/rate-limit` (since v0.2.14-alpha). This is the source of truth
   for per-route auth limits and `Retry-After`.
2. **At the edge** — the nginx `limit_req` (30 r/s, burst 60, `nodelay`)
   sheds a scripted flood before it reaches Node. Far above any human
   sign-in cadence.

### First-touch admin claim

A freshly installed agent boots with an empty `admin_npub` — **unclaimed**.
The first caller to complete a valid NIP-07 challenge/verify against
`/api/auth/verify` atomically claims admin: their npub is persisted into
`config.yaml` (canonical `npub1…` form, `0600`) and every later caller is
rejected unless their pubkey matches.

> ⚠️ **Claim the box the moment it is reachable.** Between first boot and your
> first sign-in, *anyone* who can reach `/api/auth/verify` can claim admin.
> On an internet-exposed gateway that window is a race you can lose. Do your
> first Console sign-in **immediately** after the installer prints
> `agent healthy ✓`, and confirm `/api/health` then shows
> `"admin_claimed": true`.
>
> **Higher-assurance option — pre-pin the admin.** To skip the claim window
> entirely, set your own npub in `config.yaml` *before* first start:
>
> ```bash
> sudo -u continuum sed -i 's/^admin_npub:.*/admin_npub: "npub1yourkey…"/' \
>   /opt/torii/continuum-agent/config.yaml
> sudo systemctl restart torii-continuum-agent
> ```
>
> A pre-pinned npub means the box is never in a claimable state — only that
> key can ever authenticate. Recommended for any host exposed beyond your LAN.

Normal (first-touch) flow:

1. Install the agent, then immediately open the Console and sign in with
   your own NIP-07 signer — **you** become admin.
2. `/api/health` reports `"admin_claimed": true` once the claim lands.
3. The claim is race-safe (two simultaneous first verifies → exactly one
   wins) and **fails closed** — if the config write fails, no session token
   is issued and the box stays claimable rather than half-claimed. The write
   is `fsync`ed before the token is returned, so a crash right after the claim
   can't lose it.

To reset the admin (hand the box to a different signer), stop the service,
clear `admin_npub` back to `""` in `config.yaml`, and restart:

```bash
sudo systemctl stop torii-continuum-agent
sudo -u continuum sed -i 's/^admin_npub:.*/admin_npub: ""/' /opt/torii/continuum-agent/config.yaml
sudo systemctl start torii-continuum-agent
```

### Service management

```bash
sudo systemctl status  torii-continuum-agent
sudo systemctl restart torii-continuum-agent
sudo journalctl -u torii-continuum-agent -f          # follow logs
curl -sf http://127.0.0.1:8787/api/health            # local liveness
```

Logs are structured and privacy-preserving: pubkeys, challenges, and IPs
are only ever emitted as short prefixes, never in full; the session secret
is never logged.

### Security model

- Dedicated locked `continuum` system user; no shell, no login, no
  capabilities (`CapabilityBoundingSet=` empty).
- `ProtectSystem=strict` makes the entire filesystem read-only to the
  service **except** the paths in `ReadWritePaths`: the agent's `memory/`
  directory and the single `config.yaml` file (writable only so the
  one-time first-touch claim can persist your npub). Code and
  `node_modules` are read-only even to the service that runs them.
- `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, `ProtectHome`,
  `ProtectKernelTunables/Modules/Logs`, `ProtectControlGroups`,
  `ProtectClock`, `ProtectProc=invisible`, `RestrictNamespaces`,
  a `@system-service` syscall filter, and
  `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` (the only families the
  runtime needs to reach loopback nginx and outbound Routstr/mints/Ollama).
- `MemoryDenyWriteExecute` is deliberately **not** set: V8 (Node's JIT) maps
  code pages writable then `mprotect`s them executable, which MDWE forbids, so
  the service would abort on startup (it could only be kept alongside
  `node --jitless`, at a large performance cost). Availability wins; the JIT
  surface is mitigated by `NoNewPrivileges` + the syscall filter above.

### Upgrade / rollback / uninstall

- **Upgrade**: `git pull` the repo and re-run `sudo ./ops/install-agent.sh`.
  State is preserved; only code + deps are refreshed and the service
  restarts.
- **Rollback**: check out the previous tag and re-run the installer. Your
  `config.yaml` and `memory/` are untouched across the downgrade.
- **Unclaimed installs stay bootable on v0.2.26+.** An empty `admin_npub` is a
  valid, first-class boot state **from v0.2.26-alpha onward** (the config loader
  accepts `""` as "unclaimed"), so an unclaimed agent survives an upgrade, or a
  rollback to any first-touch-aware version, and comes back still claimable —
  the re-run never invents or clears an npub. **Caveat:** rolling an *unclaimed*
  box back to a **pre-v0.2.26** tag runs the older loader, which rejects an
  empty `admin_npub` and refuses to start (`process.exit(1)`). Before any such
  downgrade, pre-pin a valid `admin_npub` (or restore a config that has one) —
  see the pre-pin recipe under **First-touch admin claim** above. If you rolled
  back *after* claiming, the persisted npub in `config.yaml` is preserved, so
  you stay admin and the service boots on any version.
- **Uninstall**:

  ```bash
  sudo systemctl disable --now torii-continuum-agent
  sudo rm /etc/systemd/system/torii-continuum-agent.service
  sudo rm -f /etc/nginx/snippets/torii-api.conf /etc/nginx/conf.d/torii-api-ratelimit.conf
  sudo systemctl daemon-reload
  # remove the include line from your server block, then: sudo nginx -t && sudo systemctl reload nginx
  # Back up first if you want to keep the wallet/characters:
  sudo rm -rf /opt/torii/continuum-agent
  sudo userdel continuum   # optional
  ```

  Deleting `/opt/torii/continuum-agent` destroys the Cashu float in
  `memory/wallet/` and your encrypted characters in `ciphertexts/` — back
  those up first (see **Backups** above).

### Troubleshooting

- **Health probe fails at install end** — inspect
  `journalctl -u torii-continuum-agent -n 50 --no-pager`. Most often a
  config error; the installer validates config before restart, so this
  usually means a port clash or a missing dependency.
- **`nginx -t` fails after wiring** — a duplicate `limit_req_zone` name or
  the include landing outside a `server{}` block. The installer leaves a
  `.torii.bak` of your site file next to the original.
- **Can't claim admin** — confirm `/api/health` shows
  `"admin_claimed": false`; if it's already `true`, someone (or a previous
  session) claimed it. Reset as above.

---

## What lives where

```
/opt/torii/                              # torii-base state
  env                                    # admin token, domain
  registry.json                          # which apps are mounted where
  root_app.conf                          # nginx include for `/`
  launcher/                              # launcher static assets
  nginx-fragments/
    continuum.conf                       # dropped by the continuum role

/home/continuum/
  app/                                   # git checkout of torii-continuum
    dist/                                # vite build output (served by nginx)
    agent/
      config.yaml                        # rendered by ansible, chmod 600
      memory/
        wallet/                          # Cashu proofs (like cash — back it up)
        panic-key-nudge.json             # one-time console hint state
        costs.jsonl                      # per-request accounting (no PII)
        audit.jsonl                      # auth events (no PII)
      ciphertexts/                       # encrypted character/memory events
      pending/                           # draft nostr events awaiting your signature

/etc/systemd/system/
  torii-base-sidecar.service             # 127.0.0.1:8780 launcher API
  continuum-agent.service                # 127.0.0.1:8787 agent
  ollama.service.d/override.conf         # binds ollama to 127.0.0.1:11434 (optional)

/etc/nginx/sites-available/torii         # single server block; includes all fragments
```

---

## Backups

The two things you must back up:

1. `/home/continuum/app/agent/memory/wallet/` — the Cashu float. Losing
   this is losing sats.
2. `/home/continuum/app/agent/ciphertexts/` — encrypted character memory.
   Losing these means the agent forgets who you told it to be.

Everything else is regeneratable from the git repo + your nostr keys.
A weekly rsync of `/home/continuum/app/agent/{memory,ciphertexts}` to a
different host or backup service is plenty.

---

## Verifying the install

On the VPS:

```bash
sudo torii doctor
```

Should show all `ok`, with routstr and ollama either `ok` (if enabled) or
`warn` (if you skipped Ollama or Routstr is unreachable from your network).

From your laptop:

```bash
curl https://your-domain.com/                             # launcher (or your promoted app)
curl https://your-domain.com/continuum/                   # continuum SPA
curl https://your-domain.com/continuum/api/health          # agent
```

The last one returns `{"ok":true,"service":"torii-continuum-agent","version":"<agent-version>",...}` — the version string is read from `agent/package.json` at boot, so it always matches the shipped release.

Chat needs you to sign in via NIP-07 on the Console (`/continuum/`),
top up the Cashu wallet from your signer, and post a first message. See
`agent/README.md` for the full end-to-end walkthrough.

---

## Ollama fallback (CONT-AGENT-1b)

When `torii_enable_ollama: true`, the agent config gets:

```yaml
ollama:
  enabled: true
  endpoint: "http://127.0.0.1:11434"
  models:
    chat: "llama3.2:3b"
    reflect: "llama3.2:3b"

model_router:
  strategy: "routstr_first"
```

`routstr_first` (the recommended default) means:

1. Chat turns hit Routstr first — you get frontier models, paid in Cashu.
2. If Routstr returns 402 (float empty) or is unreachable, the agent
   falls back to Ollama automatically. Chat keeps working, offline and free.
3. When the wallet has sats again, the next turn goes back to Routstr.

Other strategies:

- `ollama_first` — Ollama first, Routstr as fallback. Cheap and slow by default.
- `ollama_only` — never call Routstr. Fully offline mode.
- `routstr_only` — never call Ollama. Original behaviour (pre-1b).

The Console's `/api/health/models` endpoint reports which providers are
enabled, reachable, and which models are loaded.

---

## License

MIT — matches Continuum.
