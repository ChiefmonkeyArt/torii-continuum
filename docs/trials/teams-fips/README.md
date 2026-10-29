# Teams FIPS trial plan (TEAMS-2d step 2)

Status: **Planned, not run.** Running it needs the owner's approval for each
machine. Decision context: `docs/adr-team-collaboration.md`, amendment
"FIPS private mode and the Teams napplet".

The trial installs FIPS on the owner's VPS and one second machine, runs
throwaway copies of the team services on the VPS reachable **only** over the
mesh, and answers four questions. Nothing touches the live Continuum agent,
its config, its memory directory or the production nginx sites. Every step
has a matching teardown.

Privacy rule for this file and the results: no IP addresses, hostnames,
device names or real npubs are committed. Use the placeholders below.

## Questions the trial answers

| # | Question | Pass |
|---|---|---|
| Q1 | Do cordn-server, ngit-grasp and a relay work bound only to the VPS mesh address, used from the second machine as `<vps-npub>.fips`? | Chat round-trip and git clone/push both work over `.fips` |
| Q2 | Is nothing new reachable from the public internet or from unlisted mesh nodes? | Public probes of the trial ports fail; mesh probes from a non-roster source are dropped |
| Q3 | Does the peer ACL (`peers.allow` + `ALL` in `peers.deny`) stop a member whose traffic is **routed through another mesh node**, or only direct links? | Recorded either way. Expected from the FIPS docs: routed traffic is not gated by the ACL, so the `fips0` firewall must be the gate |
| Q4 | Does the `fips0` firewall drop-in, keyed on the member's `fd00::/8` address, open the trial ports to that member only, and close them when the member is removed? | Open with the rule, closed within one reload without it |

Also measured: RAM and CPU of the FIPS daemon, ping and git clone time over the
mesh vs direct, and whether `.fips` names resolve on both machines.

## Pinned inputs

| Component | Version | Source |
|---|---|---|
| FIPS | v0.5.3 (MIT) | https://github.com/jmcorgan/fips/releases/tag/v0.5.3 — verify against `checksums-linux.txt` / `checksums-macos.txt` |
| Cordn coordinator | `cordn-server` v0.5.1-next.3 (MIT) | https://github.com/Cordn-msg/cordn-rs/releases (SHA256SUMS) |
| Cordn CLI | `@cordn/cli` 0.9.0 (MIT) | npm, second machine only |
| ngit | v3.0.5 musl | https://github.com/DanConwayDev/ngit-cli/releases, second machine only |
| ngit-grasp | v3.0.10, built from `https://ngit.dev/ngit-grasp.git` | `cargo build --release --locked`; needs glibc ≥ 2.39 when built on Ubuntu 24.04 |
| Relay | `nak serve` v0.22.0 (in-memory) | https://github.com/fiatjaf/nak/releases |

Already checked in the sandbox (2026-10-29): both FIPS templates start the
real v0.5.3 daemon (checksum verified; TUN off, loopback addresses) and the
second-machine node peers with the VPS node using its persistent key;
`fipsctl address <npub>` derives a node's `fd…` address offline. Also: `nak serve --hostname <ipv6>` (bare literal, no
brackets), `NGIT_BIND_ADDRESS=[<ipv6>]:7334` and
`CORDN_RELAY_URLS=ws://[<ipv6>]:10547` all bind or connect over IPv6.

## Placeholders

| Name | Meaning |
|---|---|
| `VPS_PUBLIC` | the VPS public IPv4 address (never committed) |
| `VPS_NPUB`, `VPS_FD` | the VPS **trial** FIPS node npub and its `fd…` mesh address |
| `M2_NPUB`, `M2_FD` | the second machine's trial FIPS node npub and mesh address |
| `ALICE`, `BOB` | throwaway Nostr identities for the chat and git roles (owner and member); both clients run on the second machine, so the VPS needs no Node or ngit |

FIPS node keys in this trial are throwaway device keys, never a personal
npub. They are deleted at teardown.

## Machines

- **VPS** (Ubuntu, systemd, `.deb`). Runs the live Torii stack. Must have about
  300 MB free RAM and 1 GB free disk for the trial (more if ngit-grasp is
  built there; see phase 4).
- **Second machine**, either Linux with systemd (`.deb` or tarball) or macOS
  (`.pkg`, config under `/usr/local/etc/fips/`). It needs Node 20+ for the
  Cordn CLI, and outbound UDP to the VPS.
- **Optional intermediate** for Q3: the public FIPS test mesh node
  `test-uk01` (pre-listed in `/etc/fips/hosts`). It sees that the two trial
  node keys exchange encrypted traffic, nothing else. If that is not
  acceptable, Q3 is deferred until a third own machine is available.

## Phase 0: preflight (read-only, both machines)

```bash
curl -fsSLo /tmp/fips-preflight.sh https://raw.githubusercontent.com/ChiefmonkeyArt/torii-continuum/main/docs/trials/teams-fips/preflight.sh
bash /tmp/fips-preflight.sh
```

It changes nothing. It reports OS and glibc, free RAM and disk, whether UDP 2121,
TCP 8443, UDP/TCP 5354, 7334 and 10547 are already taken, the host firewall
(ufw, nftables, iptables), whether `/dev/net/tun` exists, and, on the VPS,
Continuum agent health. Send the output (it holds no secrets; remove the IP
lines before sharing anywhere public).

**Stop if:** any trial port is already in use, free RAM is under 300 MB, free
disk under 1 GB, or Continuum health is not `ok`.

## Phase 1: install FIPS, firewall first (both machines)

The `.deb` enables `fips` and `fips-dns` but starts neither. **Load the mesh
firewall before the daemon first starts**: until it is active, every service
listening on `[::]` (sshd, nginx) is reachable from the mesh.

```bash
V=0.5.3; A=$(dpkg --print-architecture)
cd /tmp && curl -fsSLO https://github.com/jmcorgan/fips/releases/download/v$V/fips_${V}_$A.deb \
  && curl -fsSLO https://github.com/jmcorgan/fips/releases/download/v$V/checksums-linux.txt \
  && grep " fips_${V}_$A.deb\$" checksums-linux.txt | sha256sum -c - \
  && sudo apt install -y ./fips_${V}_$A.deb \
  && sudo systemctl enable --now fips-firewall.service \
  && sudo nft list table inet fips | head -5
```

Create the throwaway node key, then replace `/etc/fips/fips.yaml` with the matching template from this
folder (`fips-vps.yaml` or `fips-m2.yaml`) and fill in the placeholders. Both
templates: persistent identity, TUN on, DNS on loopback only, Nostr discovery
off, UDP only (no TCP 8443 listener), one static peer.

```bash
sudo fipsctl keygen --dir /etc/fips
sudo systemctl start fips fips-dns && sleep 2 \
  && fipsctl show status | grep -E '"npub"|"ipv6_addr"' \
  && sudo fipsctl acl show
```

On the VPS only, open the FIPS transport in the host firewall:

```bash
sudo ufw allow 2121/udp comment 'FIPS trial'   # if ufw is active
```

The daemon may warn that the UDP buffers were clamped; that is harmless
for the trial (FIPS how-to `tune-udp-buffers.md` covers it).

**Check:** `fipsctl show peers` on both shows the other node, and
`ping -6 -c3 <other-npub>.fips` answers (ICMPv6 echo is allowed by the
baseline).

## Phase 2: lock the VPS peer ACL

```bash
echo 'M2_NPUB' | sudo tee /etc/fips/peers.allow
echo 'ALL'     | sudo tee /etc/fips/peers.deny
sudo systemctl restart fips && sleep 2 && sudo fipsctl acl show
```

`peers.allow` alone is not exclusive; `ALL` in `peers.deny` makes it strict.

## Phase 3: trial services on the VPS, mesh address only

Run as an unprivileged throwaway user in `/opt/fips-trial`, never as root,
never under the Continuum service account:

```bash
sudo useradd --system --create-home --home-dir /opt/fips-trial --shell /usr/sbin/nologin fipstrial
```

Scripts in this folder (`run-relay.sh`, `run-coord.sh`, `run-grasp.sh`) read
`VPS_FD` from `/opt/fips-trial/env` and bind to it only:

- relay: `nak serve --hostname $VPS_FD --port 10547`
- coordinator: `cordn-server`, relay `ws://[$VPS_FD]:10547`, SQLite under `/opt/fips-trial/run`
- git: `ngit-grasp` with `NGIT_BIND_ADDRESS=[$VPS_FD]:7334`,
  `NGIT_DOMAIN=$VPS_NPUB.fips:7334`, `NGIT_PRIVATE_MODE=true`,
  `NGIT_PRIVATE_MEMBERS=ALICE,BOB`, `NGIT_USER_INDEX_RELAYS=ws://[$VPS_FD]:10547`
  (stops the default purplepag.es lookups)

Open those two ports to the second machine only. Its mesh address comes
straight from its npub, no daemon query needed:

```bash
M2_FD=$(fipsctl address M2_NPUB)
sed "s/M2_FD/$M2_FD/" fips.d-teams-trial.nft | sudo tee /etc/fips/fips.d/teams-trial.nft
sudo systemctl reload-or-restart fips-firewall.service
# ufw also filters fips0; if ufw is active add the same scope there:
sudo ufw allow in on fips0 from "$M2_FD" to any port 7334,10547 proto tcp comment 'FIPS trial'
```

**Check:** `ss -ltnp | grep -E ':(7334|10547)'` shows only the `fd…` address.

## Phase 4: ngit-grasp binary

No upstream binary is published. In order of preference:

1. Build on the second machine if it is Linux x86_64 with glibc **≤** the
   VPS's (from phase 0), copy `ngit-grasp` to `/opt/fips-trial/bin/`.
2. Build on the VPS as `fipstrial` with rustup, only if phase 0 shows ≥ 4 GB
   free disk and ≥ 2 GB free RAM; delete `~/.cargo` and the source tree after.
3. Skip ngit-grasp; Q1 is then answered for chat only.

## Phase 5: tests from the second machine

1. **Chat (Q1):** `cordn` as ALICE and as BOB (separate state files),
   relay `ws://VPS_NPUB.fips:10547`: create group, add BOB, both send, both
   read. Repeat with BOB's process restarted.
2. **Git (Q1):** ngit as ALICE `init --private` against
   `ws://VPS_NPUB.fips:7334`; BOB clones, pushes a `pr/` branch; ALICE lists and
   merges. Time the clone.
3. **Public exposure (Q2):** from the second machine over the normal
   internet, `nc -vz -w3 VPS_PUBLIC 7334` and `… 10547` must fail; on the VPS,
   `ss` shows nothing on `0.0.0.0`/`[::]` for those ports.
4. **Firewall gate (Q4):** remove `teams-trial.nft`, reload: BOB's fetch and
   chat must fail within one reload; restore, both work again. Watch
   `sudo nft list chain inet fips inbound` counters.
5. **Routed path (Q3, optional):** on the second machine replace the VPS
   static peer with `test-uk01`; on the VPS add `test-uk01` as a peer and to
   `peers.allow`. Confirm `fipsctl show peers` on the VPS no longer lists
   M2 directly, then repeat test 1. Record whether the session to
   `VPS_NPUB.fips` comes up although M2 is not a direct peer (ACL bypassed by
   routing) and whether the firewall rule still decides access.
6. **Measurements:** `ps -o rss,pcpu -C fips` on both, `ping -6 -c20` over the
   mesh vs direct IPv4 ping, clone time.

**Abort at once if:** Continuum health stops returning `ok`, any trial port
answers on a public address, RAM on the VPS drops below 150 MB free, or the
FIPS daemon logs that the firewall polices another interface.

## Phase 6: teardown (both machines)

```bash
sudo pkill -u fipstrial || true; sudo userdel -r fipstrial 2>/dev/null || true
sudo rm -f /etc/fips/fips.d/teams-trial.nft
sudo systemctl disable --now fips fips-dns fips-firewall
sudo apt purge -y fips && sudo rm -rf /etc/fips /run/fips
sudo ufw delete allow 2121/udp 2>/dev/null; sudo ufw status numbered | grep -i fips
curl -sf http://127.0.0.1:8787/api/health   # VPS: Continuum unchanged
```

On macOS, run the uninstaller shipped in the `.pkg` and delete
`/usr/local/etc/fips`.

## Results

Write `RESULTS.md` in this folder in a later docs PR: answers to Q1 to Q4,
the measurements, any FIPS issues (reported upstream, not forked), and the
consequence for TEAMS-2d step 3 (the roster's fourth projection). No
addresses, hostnames, device names or real npubs.
