# v0.2.189 reliability acceptance

Payment acceptance: a provider HTTP 402 or restricted-mint/fee/floor failure must not show an empty-wallet Top Up action. Local total shortfall can offer Top Up. Retain refund state, selected model and request caps.

QVAC regression: signed-in Routstr → Local AI · QVAC → short question → streamed plain text; unavailable never sends to Routstr. Close or change session to clear the dialog. General chat, wallet top-up and project AI routes retain their original model settings.

Baseline: public v0.2.188 sign-in inspected in a fresh browser; authenticated
Routstr supplied by owner screenshot. Further private UI checks use synthetic
signer/API fixtures, never a real wallet or paid chat.

- Sign-in/signed-out route remains protected; demo remains labelled.
- New chat, session history and project workspace navigation remain reachable.
- Routstr loads a live balance without stale browser balance or mock connection.
- Top Up opens Lightning invoice dialog; Cancel closes it; Cashu fallback remains.
- Model search/save/refresh retains the real API and DeepSeek selection.
- Advanced expands NWC, usage and local preferences; local guides aren't caps.
- Old top-ups are absent from the main wallet screen. Expanding Advanced loads the recovery controls once; it never redeems or deletes a quote by itself.
- Main chat: a fully refunded eligible rejection can reach one other host for the same model; pending or partial settlement cannot trigger that retry. No paid probe in release acceptance.
- Auth failure, balance failure and missing values never imply zero/ready.

## Local acceptance evidence (2026-10-29)

- Automated frontend: 74 files / 1,160 tests passed before final version bump.
- Automated agent: 728 tests passed before the separately approved capped probe
  additions; those additions have their own wallet/fee/no-provider tests.
- Browser synthetic owner fixture, 1440x1000 and 375x812: live and unavailable
  balance, retained recovery warning, unpaid quote wording, model search/save/
  refresh, Advanced/NWC, Top Up/QR/close, Projects/project workspace, Sessions and
  Settings/Connections checked. No horizontal overflow at 375px or page errors.
- Real paid acceptance is separate: use the explicit `deepseek_recovery` target,
  single wallet writer and durable run-id. Do not equate fixture QA with spending
  or real provider acceptance.
- Main flows were checked against the existing mounted app. No new public app
  copy or unrelated Project artifact was created.
- Desktop 1440 and mobile 375: no overflow; keyboard accessible controls.
- Stream fixtures: partial abort stays failed; completed finish marker terminates;
  timeout classification stays terminal after funding; no second deposit.
- Live final verification: tag/main/agent/frontend match, protected APIs reject
  anonymous callers, model/caps and retained recovery ciphertext unchanged.
