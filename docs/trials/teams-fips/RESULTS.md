# Teams FIPS trial: results (2026-10-29)

Run: `fips-trial.yml action=trial` from `main` after PR #243 (GitHub Actions
run 40974579664). VPS side: the existing Torii Suite FIPS node (fips 0.5.1),
second machine: a throwaway GitHub runner (fips 0.5.3). Mixed versions
interoperate (no wire change in 0.5.2/0.5.3).

| Question | Result |
|---|---|
| Q1 services over the mesh | **Pass.** `<npub>.fips` and the FIPS shortname resolve (then `torii-team.fips`; renamed `torii-teams.fips` on 2026-10-31). Chat: group created, member joined, messages both ways, outsider cannot read. Git: maintainer created a private repo and pushed, member cloned and opened a `pr/` branch, outsider clone refused. |
| Q2 nothing on the public address | **Pass.** 7334, 10547, 5354 and 8443 closed on the public address. |
| Q3 routed session via test-uk01 | **Inconclusive.** No routed session formed within the timeout. Removing the device's firewall rule still blocked it. On a Suite host there is no peer ACL, so admission rests on the `fips0` firewall either way. Not needed for direct-peer teams. |
| Q4 firewall is the gate | **Pass.** A linked peer without an allow rule is refused on 7334 and 10547; re-admitting restores access. |

## Findings

- One FIPS identity per host: the trial reuses the Suite node and only adds
  tagged runtime rules, re-applied by `fips-trial-admit.service` on a Suite
  firewall reload. Durable version: a Suite `fips.d` include (TEAMS-2d step 3).
- ngit v3.0.5 truncates URLs at `npub1`, breaking `<npub>.fips` git hosts.
  Workaround: FIPS shortname. Upstream issue drafted, awaiting approval.
- cordn-server cannot dial bracketed IPv6 relay URLs. Workaround: hostname.
- Suite FIPS is on 0.5.1; upgrading to 0.5.3 is a separate Suite change.

## Consequence for TEAMS-2d step 3

The roster's fourth projection is the per-device `fips0` allow list (device
npub to mesh address), written into the Suite firewall through a reviewed
include, plus the git member list. No FIPS peer ACL is needed for a team of
up to 12 that links directly to the team node.
