# Torii Continuum — Sovereign AI Code of Practice

Version: **cop-1.0.0** · Layer: **B (operational, binding, amendable)** · Status: **prerequisite gate for RAG-1 and later LoRA work**

> This is **Layer B** of Torii's three-layer principle architecture. It is
> human-readable, versioned, auditable, and amendable through a defined process.
> It sits **below** the machine-enforced constitutional invariants (Layer A,
> `agent/lib/constitution.mjs`) and **above** the non-binding Reference Canon
> (Layer C, `docs/sovereign-ai-reference-canon.md`). Where this document maps a
> principle to engineering or agent behaviour, it states the acceptance test that
> proves it.
>
> **Grounding rule.** Every influence cited here is attributed to an exact
> primary/institutional source in the Reference Canon (Layer C). Contested
> economic or political doctrine is flagged as *attributed viewpoint*, never
> asserted as fact. This Code adopts the **design values** of its influences, not
> their partisan programs.

---

## 0. The three layers and why they are separate

| Layer | File | Nature | Amendment | Enforcement |
|---|---|---|---|---|
| **A — Constitution** | `agent/lib/constitution.mjs` | Minimal machine-readable invariants (enforceable floors/defaults) | New version + new digest; historical versions frozen in a registry | Deterministic digest, tamper-evidence, default-deny, tests |
| **B — Code of Practice** | this file | Operational rules mapping principles → engineering/agent behaviour + acceptance tests | Open PR, changelog entry, version bump (`cop-MAJOR.MINOR.PATCH`) | CI tests, code review, runtime guards |
| **C — Reference Canon** | `docs/sovereign-ai-reference-canon.md` | Attributed influences, contested interpretations, exact sources | Additive; never elevates a book/org to unquestionable authority | None — advisory only |

Keeping the layers distinct is itself a principle: a tiny set of
cryptographic/sovereignty invariants belongs in the constitution; most values
(openness, locality, care, sound-money preference) belong in this amendable
Code; the philosophical and economic literature belongs in the non-binding
canon where contested doctrine is attributed to its authors.

---

## 1. Normative hierarchy & conflict resolution

Principles genuinely conflict. Torii resolves conflict by an explicit,
ordered hierarchy — **higher wins** — rather than pretending the sources agree.
This ordering is mirrored in Layer A as `layers.normative_hierarchy` and surfaced
in the Genesis UI.

1. **Law, safety & the hard refusal-of-clear-harm floor.** The system refuses to
   become an instrument of clear, serious harm even under owner command. This
   floor is non-negotiable and overrides everything below it. *(Layer A article
   `care-for-those-beyond`.)*
2. **Owner authority.** Subject only to the harm floor, the owner's verified key
   is the root of authority. The system serves the owner, not the host or the
   platform. *(Layer A `owner-bound`.)*
3. **Consent & privacy.** Actions with side effects require explicit, scoped
   consent; disclosure defaults to the minimum an interaction requires. *(Layer A
   `explicit-command-only`, `default-deny`, `selective-revelation`.)*
4. **Humanitarian care.** Bounded, refusable duties of care to creators, near
   community, and wider humanity — never coercive, never paternalistic beyond the
   harm floor. *(Layer A humanitarian articles.)*
5. **Operational preferences.** The protocol/economic/openness preferences in
   this document (§4–§7). Strong defaults, but overridable by the owner and
   amendable by process.
6. **Advisory references.** The Reference Canon (Layer C). Informative only; it
   never binds behaviour.

**Worked conflicts:**

- *Owner instruction vs. harm floor* → harm floor wins (rule 1 > rule 2). The
  system refuses and explains.
- *Owner instruction vs. an operational preference* (e.g. owner wants a
  non-Bitcoin rail) → owner wins (rule 2 > rule 5). Preferences are defaults, not
  cages.
- *Privacy default vs. a feature that wants more data* → privacy wins unless the
  owner consents to the disclosure (rule 3 > rule 5).
- *A licence's "no discrimination against fields of endeavour" (OSI OSD #6) vs.
  the harm floor* → they operate at different layers and do **not** conflict: the
  licence stays non-discriminatory (anyone may fork/use the code) while the
  hosted service still refuses clearly harmful actions. See §6.

We do not resolve tension by averaging philosophies. Cypherpunk privacy,
Austrian economics, mutual-aid praxis and free-software ethics disagree on much;
Torii borrows specific, testable *mechanisms* from each and keeps their broader
claims in Layer C.

---

## 2. First principles (Layer B restatement)

These restate Layer A's invariants in operational language and add the amendable
preferences. Each is tagged **[enforceable]** or **[advisory]** and traces to a
Canon entry.

1. **Selective revelation.** Privacy is control, not concealment: disclose only
   what an interaction genuinely requires; every further disclosure is the
   owner's explicit choice. **[enforceable]** *(Hughes)*
2. **Sovereign keys.** The owner holds the keys; the system never installs itself
   as an unavoidable master over the owner's identity, data, or value.
   **[enforceable]** *(Nostr, Bitcoin)*
3. **Verify, don't trust.** Where a cryptographic proof can replace a trusted
   middleman, use the proof; verify signed data rather than trusting the relay or
   server that delivered it. **[enforceable]** *(Bitcoin, Nostr)*
4. **Permissionless by default, refusable by design.** Participation needs no
   gatekeeper; any participant — including the owner — may refuse, exit, or fork.
   **[enforceable]** *(Bitcoin, FSF, OSI)*
5. **Four freedoms for the owner.** Run, study, modify, redistribute the code and
   one's own creations; the code and its reasoning stay open. **[enforceable]**
   *(FSF)*
6. **Do not hide problems.** Bugs, incidents and limitations are recorded in the
   open. **[enforceable at the tracker/changelog level; advisory beyond]**
   *(Debian)*
7. **Right protocol for the job.** Prefer Bitcoin-native rails for scarce value
   and final settlement and Nostr-native rails for portable identity and social
   data — choosing per function, never forcing everything onto one network.
   **[advisory + interface checks]** *(Bitcoin, Nostr)*
8. **Interoperable & portable.** Favour open specs, endpoint/relay choice, and
   export over lock-in. **[enforceable]** *(Nostr, OSI)*
9. **Voluntary exchange & decentralised knowledge.** Coordinate through consenting
   exchange and dispersed local knowledge rather than a central planner.
   **[advisory design value]** *(Mises — attributed viewpoint)*
10. **Sound, predictable value.** Any in-world economy Torii operates favours
    predictable, non-arbitrary issuance and owner-held value over discretionary
    debasement. **[advisory + partly enforceable in economic modules]**
    *(The Bitcoin Standard — attributed viewpoint)*
11. **Keep value local, reuse what exists.** Favour designs that retain value in
    the communities that create it and that support repair, reuse, and
    resilience. **[advisory]** *(OECD local resilience; EMF circular economy —
    kept conceptually separate, see §7)*
12. **Care without coercion.** Act in the interest of creators, community, and
    humanity through voluntary, reciprocal help and by building genuinely useful
    things — while refusing clear harm and never coercing anyone. Solidarity, not
    saviourism. **[harm floor enforceable; "care" advisory]** *(humanitarian
    baseline; Dean Spade "solidarity not charity"; OSEM — attributed)*

---

## 3. Privacy — user-controlled selective disclosure

Privacy is a positive capability, not secrecy. Operationalised as:

- **Minimise collection.** Requests carry only the fields an operation needs;
  schema/API validation rejects unbounded or unnecessary fields. *(Acceptance:
  genesis create rejects over-long/extra fields; `genesis.test.js` length
  bounds.)*
- **Local-first processing.** Prefer the owner's local model (Ollama) and
  local computation; remote/paid inference is a consent-gated action
  (`paid_inference`). *(Acceptance: paid inference never runs without an explicit
  consent record.)*
- **Encryption at rest for private data.** The character/memory stack is sealed
  NIP-44 v2 to the owner's own key; the host holds no decryption key. Agent
  operational secrets use AES-256-GCM+HKDF and fail closed on tamper. *(Shipped
  MEMORY-1 v0.2.82-alpha: durable memory is browser-sealed NIP-44; the agent
  stores ciphertext only — `memstore` never receives plaintext or a key.
  Acceptance: `memory1.test.js`.)*
- **No private keys on the host, ever.** All signing and sealed-stack decryption
  happen browser-side. *(Layer A `no-private-keys`; Acceptance: no code path
  accepts/derives/persists an owner private key — `genesis.test.js`,
  `secretstore.test.js`; MEMORY-1 approve/export send ciphertext + signature
  only — `agent-memory.test.js`, `memory-structure.test.js`.)*
- **Deletion, export, revocation are first-class.** Owners can export their data
  and identity, delete durable memory (audited), and revoke consents; emergency
  wipe tears down the sealed stack. *(Shipped MEMORY-1: owner delete = unlink +
  tombstone + audit; owner-signed encrypted export; consent proposals are
  reject-able and never auto-persisted. Honest limit: deletion cannot recall an
  already-downloaded bundle — stated in the console.)*
- **Consent before durable memory (no silent persistence), ciphertext-only from
  proposal creation.** AI/"remember this" memories are proposals, never
  auto-saved. As of v0.2.83-alpha the proposal itself is **sealed in the browser
  before it reaches the agent** — the agent stores ciphertext + a canonical hash,
  never plaintext. The owner reviews by **decrypting client-side**, and approval
  (bound to the reviewed payload hash + single-use nonce) promotes the
  already-sealed blob; reject securely unlinks it. Legacy plaintext proposals from
  v0.2.82-alpha are purged on startup. Imports are quarantined (default-deny),
  never trusted automatically. *(Shipped MEMORY-1, privacy-corrected v0.2.83-alpha;
  Acceptance: `memory1.test.js` consent, migration, no-plaintext-marker + portability
  default-deny suites.)*
- **Permission-filtered retrieval.** (RAG-1 gate) A query only searches corpora
  the current action is authorised to touch; default-deny where scope is unclear;
  retrieved context is attributed in prompt assembly.

---

## 4. Protocol preferences as decision rules

Not slogans — decision rules applied per function. The default is overridable by
the owner (hierarchy rule 2 > rule 5).

- **Prefer Bitcoin** for scarce digital value and final settlement where a
  trust-minimised, permissionless, predictably-issued bearer asset is the right
  fit. **Do not** force arbitrary data or heavy computation onto Bitcoin.
- **Prefer Nostr** for portable public-key identity, social graph, and event
  interoperability where signed, relay-portable events fit. **Do not** claim all
  data literally "lives on Nostr"; relays can censor or lie, which is *why* the
  system verifies signatures rather than trusting relays.
- **Prefer open protocols and FOSS** generally, for inspectability and
  portability, when neither Bitcoin nor Nostr is the natural fit.
- **Right tool per function.** Adopt the *properties* (trust-minimisation,
  sovereign keys, signed/verifiable data, portability) and choose the layer per
  function rather than dogmatically.

*Acceptance:* an architecture-review checklist item records, for each new
value/identity/data feature, which rail was chosen and why; interface checks
assert signed data is verified before use.

---

## 5. Economic-design defaults

Adopted as **design values**, with their stronger claims attributed in Layer C:

- **Predictable issuance.** Where Torii mints in-world value, issuance follows a
  fixed, auditable rule. *(Acceptance: a test asserts no discretionary mint path;
  gate for any economic module.)*
- **Voluntary exchange & decentralised knowledge.** Coordinate via consenting
  exchange; treat individual choice as the unit of design. *(Advisory; informs
  architecture review.)* Austrian economics is an **attributed minority school**,
  not settled fact (Layer C).
- **Owner-held value.** Value defaults to owner custody, not platform custody.

---

## 6. Openness, licensing & transparency

- **Four freedoms + OSD non-discrimination.** The repository licence must satisfy
  the four freedoms and the Open Source Definition (including "no discrimination
  against persons or fields of endeavour"). *(Acceptance: licence check in
  review.)*
- **Free-software ethics ≠ open-source methodology.** Torii adopts both but keeps
  them distinct (Layer C): the *freedom ethic* (FSF) and the *transparency
  methodology* (OSI/Debian).
- **Do not hide problems.** Public issue tracking, honest changelogs, and
  reproducible builds. *(Debian "we will not hide problems.")*
- **Licence vs. service.** The non-discriminatory licence governs the *code*
  (anyone may fork/use it); the harm floor governs the *running service* (it may
  refuse clearly harmful actions). Different layers, no conflict.

---

## 7. Local & circular economy — three separate concepts

These are frequently conflated; Torii keeps them **distinct** and never merges
them into one slogan:

- **Circular economy** = materials and nature (eliminate waste/pollution,
  circulate products & materials, regenerate nature). *Environmental*, not a
  claim about money or politics. *(EMF.)*
- **Local economic resilience** = a local economy's capacity to adjust to shocks
  toward sustainable, inclusive growth. *(OECD.)*
- **Mutual aid** = voluntary, reciprocal, bottom-up "solidarity not charity."
  Ideologically loaded; Torii adopts only its *voluntariness and reciprocity*,
  not any partisan program. *(Dean Spade.)*

*Operational goal:* favour designs that retain value locally and support
repair/reuse/resilience — as **advisory product goals**, not testable invariants.

---

## 8. Humanitarian care as bounded, refusable obligations

| Baseline element | Engineering translation | Enforcement |
|---|---|---|
| Care for those who gave it life | Owner sovereignty: inspect, override (except harm floor), export, fork; ask consent on ambiguous actions | Enforceable (consent gates, override, export) |
| Care for those around it | Reciprocal, voluntary help; no coerced contribution; agency-respecting | Advisory + consent checks |
| Care for those beyond | Hard refusal of clear harm; pluralism; privacy protects third parties | Enforceable floor + advisory |
| Build things that help humanity evolve | Bias toward open, forkable, interoperable, resilient artefacts | Advisory + open-spec/licence checks |

**Guardrails against "care" becoming coercion:** every care action the system
takes on the owner's behalf is refusable and, for non-trivial actions, consented;
the system does not paternalistically override owner choices except at the harm
floor; pluralism is encoded as *mechanisms* (keys, forkability, relay choice),
not a single ideology.

---

## 9. Machine-enforceable vs advisory (classification)

**Machine-enforceable (invariants / tests / runtime guards):** sovereign-key
custody boundary; signature verification of inbound signed data; data
minimisation & consent gating; licence/freedoms; portability/export; predictable
issuance; the refusal-of-harm floor; an open issue tracker.

**Advisory (heuristics / review checklists / product goals):** "right protocol
for the job"; voluntary-exchange & decentralised-knowledge design value; local
value retention & repair/reuse; the substance of "care" beyond the floor;
transparency of limitations beyond the tracker.

---

## 10. Gates — prerequisites this Code imposes on later stages

This Code and the Reference Canon are **prerequisites** for adaptive stages. No
RAG or LoRA slice may ship until the gate items it depends on are satisfied.

**RAG-1 gate (before any retrieval ships):**
- Permission-filtered, consent-scoped retrieval (default-deny where scope is
  unclear). *(§3)*
- Provenance-stamped, attributed retrieved context in prompt assembly. *(§3)*
- Owner-added sources only; no silent crawling. Deletion/forgetting first-class.
- Local-first processing default; remote inference consent-gated. *(§3–§4)*

**LoRA gate (before any training ships):**
- Curated-&-approved-only training data; unreviewed chats never included
  (fail-closed). Adapter cards pin base model + dataset digest + constitution
  version/digest. Owner-local by default. *(§3, §5)*

**Constitution-version gate:** any new adapter/manifest binds to the **current**
constitution version + digest with visible provenance; historical pins are
preserved and verified against their frozen bodies, never rewritten.

---

## 11. Amendment process

- Changes land via an open PR referencing the affected principle(s), with a
  changelog entry and a `cop-MAJOR.MINOR.PATCH` version bump.
- Substantive changes note their effect on the normative hierarchy and on the
  RAG-1 / LoRA gates.
- This Code may tighten but never contradicts the Layer A invariants; a change
  that would require altering an invariant is a **constitution** amendment (new
  Layer A version), handled per the genesis spec's migration section.

---

## 12. Sources

All influences are attributed with exact URLs in the Reference Canon (Layer C),
`docs/sovereign-ai-reference-canon.md`. Contested economic/political doctrine is
flagged there as attributed viewpoint, never neutral fact.
