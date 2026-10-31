# Teams FIPS trial: joining as a team member

You get private team chat (Cordn, MLS-encrypted) and a private git server
(ngit) that only exist on the FIPS mesh. Nothing is reachable from the public
internet. The owner sends you three values in a private channel:

| Placeholder | What it is |
|---|---|
| `VPS_NPUB` | the team node's FIPS identity (`npub1…`) |
| `VPS_DOMAIN` | the team node's public hostname, for the UDP link only |
| `COORD_PK` | the chat coordinator's public key (64 hex characters) |

Linux (amd64) is the tested path. macOS works with the `.pkg`; config lives in
`/usr/local/etc/fips/` instead of `/etc/fips/`.

## 1. Install FIPS 0.5.3 and make your device key

```bash
curl -fLO https://github.com/jmcorgan/fips/releases/download/v0.5.3/fips_0.5.3_amd64.deb
echo "6edd18e67c4f4c47d9d8c7366aacc6505d11df79c1c4b1b1d63246fa66e3e8a3  fips_0.5.3_amd64.deb" | sha256sum -c
sudo apt install ./fips_0.5.3_amd64.deb
sudo fipsctl keygen --dir /etc/fips
sudo cat /etc/fips/fips.pub        # your DEVICE npub: send this to the owner
```

## 2. Point FIPS at the team node

Write `/etc/fips/fips.yaml` (template: `fips-m2.yaml` in this folder):

```yaml
node:
  identity:
    persistent: true
  rendezvous:
    nostr:
      enabled: false
tun:
  enabled: true
  name: fips0
  mtu: 1280
dns:
  enabled: true
  bind_addr: "::1"
  port: 5354
transports:
  udp:
    outbound_only: true
peers:
  - npub: "VPS_NPUB"
    alias: "torii-teams"
    addresses:
      - transport: udp
        addr: "VPS_DOMAIN:2121"
    connect_policy: auto_connect
```

Add the team shortname, then start the node:

```bash
echo "torii-teams VPS_NPUB" | sudo tee -a /etc/fips/hosts
sudo systemctl enable --now fips
ping -6 -c3 torii-teams.fips
```

Ping works before the owner admits you. The chat and git ports stay closed
until they do.

## 3. Make a trial identity (keep your main nsec out of this)

```bash
curl -fLo nak https://github.com/fiatjaf/nak/releases/download/v0.22.0/nak-v0.22.0-linux-amd64
echo "f4cb05c42e2cab2d85f436c42aece1f6e10499e1166b6e0ad1fd3e3973b70712  nak" | sha256sum -c && chmod +x nak
mkdir -m 700 -p ~/torii-teams
(umask 077; ./nak key generate > ~/torii-teams/me.sk)
./nak encode npub "$(./nak key public "$(cat ~/torii-teams/me.sk)")"   # your NOSTR npub: send this too
```

Send the owner both npubs: the device npub (step 1) and the Nostr npub (step 3).
They run `action=admit` with them. Wait for "you're in" before step 4.

## 4. Team chat (Cordn CLI 0.9.0, patched)

```bash
cd ~/torii-teams && mkdir cli && cd cli
base=https://raw.githubusercontent.com/ChiefmonkeyArt/torii-continuum/main/ops/fips-trial/cordn-cli
for f in package.json package-lock.json stream.patch; do curl -fsSLO "$base/$f"; done
npm ci --ignore-scripts --no-audit --no-fund && patch -p0 < stream.patch
chat() { ~/torii-teams/cli/node_modules/.bin/cordn --private-key-file ~/torii-teams/me.sk \
  --server-pubkey COORD_PK --relay ws://torii-teams.fips:10547 --transport-encryption required \
  --state-file ~/torii-teams/chat.json --command "$*"; }
```

Everyone publishes a key package once:

```bash
chat gen-kp me && chat publish-kp me
```

The group creator (one person) runs:

```bash
chat create-group torii-teams
chat add-member torii-teams <member hex pubkey>     # once per member
```

Each other member joins:

```bash
chat fetch-welcomes && chat welcomes                # copy keyPackageRef=…
chat accept-welcome <keyPackageRef> torii-teams
```

Daily use:

```bash
chat send-to torii-teams "message"
chat sync torii-teams && chat messages torii-teams
```

## 5. Private git (ngit v3.0.5)

```bash
curl -fLO https://github.com/DanConwayDev/ngit-cli/releases/download/v3.0.5/ngit-v3.0.5-x86_64-unknown-linux-musl.tar.gz
echo "d908fd2e8b818ad3c2427b54245c4dc98e765f4840846a321c98343ff3a773ba  ngit-v3.0.5-x86_64-unknown-linux-musl.tar.gz" | sha256sum -c
mkdir -p ~/.local/bin && tar -xzf ngit-v3.0.5-*.tar.gz -C ~/.local/bin ngit git-remote-nostr
ngit account login --offline --secret-storage file -n "$(cat ~/torii-teams/me.sk)" --alias team
```

Use `torii-teams.fips`, never `<npub>.fips`, as the git host (ngit v3.0.5 cuts
URLs at `npub1`; see README "Upstream findings").

A maintainer creates a repo once:

```bash
ngit init --name team-art --identifier team-art --description "Team art" \
  --grasp-server ws://torii-teams.fips:7334 --private --repo-relay-only -d
git push origin master
```

Members clone the `nostr://…` URL the maintainer shares, then propose changes:

```bash
git clone nostr://<maintainer npub>/ws%3A%2F%2Ftorii-teams.fips%3A7334/team-art
git push origin HEAD:refs/heads/pr/<short-name>
```

Only maintainers can push to `master`; everyone else opens `pr/` branches.

## Leaving

Delete `~/torii-teams`. To leave the mesh entirely:
`sudo systemctl disable --now fips`. The owner removes your device from the
admit list, which closes chat and git to you immediately.
