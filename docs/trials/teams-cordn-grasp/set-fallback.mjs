import { openPersistentSession } from "/tmp/trial/cli/node_modules/@cordn/cli/dist/lib/index.js";
import { readFileSync } from "node:fs";
const k = n => readFileSync(`/tmp/trial/keys/${n}`, "utf8").trim();
const relays = ["ws://127.0.0.1:10547"];
const ps = await openPersistentSession({
  stateFile: "/tmp/trial/state/alice/session.json", privateKey: k("alice.sk"),
  serverPubkey: k("coord.pk"), relays, transportEncryption: "required",
  coordinators: { [k("coord2.pk")]: { serverPubkey: k("coord2.pk"), relays } },
});
const s = ps.session; const g = s.getGroup("torii-team");
const routing = { active: { pubkey: k("coord.pk"), relayUrls: relays }, fallbacks: [{ pubkey: k("coord2.pk"), relayUrls: relays }], boundaryTips: [] };
await s.updateGroupMetadata("torii-team", { ...(g.metadata ?? {}), name: "Torii team trial", coordinatorRouting: routing });
await ps.persist(); await ps.close();
console.log("fallback roster set:", JSON.stringify(s.getGroup("torii-team").metadata?.coordinatorRouting?.fallbacks));
process.exit(0);
