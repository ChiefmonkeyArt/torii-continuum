# Teams trial: Cordn + private ngit-grasp + one clanker

Reproduces the 2026-10-29 sandbox trial behind `docs/adr-team-collaboration.md`. Throwaway keys only; everything binds to `127.0.0.1`. Not part of the Continuum build or tests.

## Pinned inputs

| Component | Version | Source |
|---|---|---|
| Cordn coordinator | `cordn-server` v0.5.1-next.3, x86_64 (SHA256SUMS verified) | https://github.com/Cordn-msg/cordn-rs/releases |
| Cordn CLI | `@cordn/cli` 0.9.0 (MIT) | `npm i --prefix /tmp/trial/cli @cordn/cli@0.9.0` |
| ngit | v3.0.5 musl | https://github.com/DanConwayDev/ngit-cli/releases |
| ngit-grasp | v3.0.10 built from `https://ngit.dev/ngit-grasp.git` | `cargo build --release --locked` |
| Test relay | `nak serve` v0.22.0 (in-memory) | https://github.com/fiatjaf/nak/releases |

## Layout

- `/tmp/trial/bin` — `nak`, `ngit`, `git-remote-nostr`, `cordn-server`.
- `/tmp/trial/keys/<name>.sk|.pk` — `nak key generate` for `coord coord2 alice bob clanker outsider`, mode 600.
- `c.sh NAME "cordn command"` — one-shot Cordn CLI as NAME.
- `g.sh NAME cmd…` — git/ngit as NAME with an isolated HOME and git config. Keeps ngit account state out of the host's `~/.gitconfig`, and points ngit's default relay sets at the trial relays.
- `run-*.sh` — relay, coordinators, private ngit-grasp, clanker daemon and clanker loop.
- `clanker.mjs` — the agent loop (authorised senders, dedupe, rate limit, PR only). `set-fallback.mjs` — declares coordinator 2 as a fallback so the group can move.

## Order

1. `run-relay.sh`, `run-coord.sh`; key packages for bob/clanker; alice `create-group torii-team`, `add-member` both; they `fetch-welcomes` and `accept-welcome`.
2. `remove-member` bob, send, bob syncs (must not read); re-add.
3. `run-coord2.sh`, `node set-fallback.mjs`, everyone syncs, alice `switch-coordinator`.
4. `run-grasp.sh`; ngit login per identity via `g.sh`; alice `ngit init --grasp-server ws://localhost:7334 --private --repo-relay-only -d`; save `git remote get-url origin` to `/tmp/trial/repo.url`.
5. `run-clanker-daemon.sh`, `run-clanker-agent.sh`; bob sends `@clanker note: …`; alice `ngit pr list`, `ngit merge <id>`, `git push`.
6. Drop bob from `NGIT_PRIVATE_MEMBERS`, restart ngit-grasp, bob's fetch must fail.
