# Torii Continuum — Sovereign AI Reference Canon

Version: **canon-1.0.0** · Layer: **C (non-binding, attributed influences)** · Status: **informative only**

> This is **Layer C** of Torii's three-layer principle architecture. It is
> **non-binding**. It attributes the influences behind the constitution (Layer A,
> `agent/lib/constitution.mjs`) and the Code of Practice (Layer B,
> `docs/sovereign-ai-code-of-practice.md`), explains contested interpretations
> and limitations, and links the exact primary sources.
>
> **It never elevates any whole book, author, or organisation into unquestionable
> authority.** Torii borrows specific, testable *mechanisms and design values*
> from these sources; their broader economic and political claims are recorded
> here as **attributed viewpoints**, explicitly flagged, never asserted as fact.
> Where a source is advocacy, it is labelled advocacy. Where a value could not be
> confirmed against a primary source, it is omitted rather than invented.

---

## How to read this canon

Each entry states: what the source actually says (paraphrased, with short
indispensable quotes only), how Torii uses it, and the **cautions** — the
contested interpretation or limitation that stops the source from being treated
as binding fact. The status tags:

- **[primary/spec]** — stable, primary, safe to cite as a definition (protocols,
  licences, definitional institutional statements).
- **[attributed viewpoint]** — contested doctrine or single-author advocacy;
  phrased as "X argues that…", never as neutral fact.
- **[activist manifesto]** — inspirational; borrow principles, cite as a
  manifesto.

---

## 1. Privacy as selective revelation — Eric Hughes **[activist manifesto]**

*A Cypherpunk's Manifesto* (1993): "Privacy is not secrecy." "Privacy is the
power to selectively reveal oneself to the world." Reveal "only that which is
directly necessary for that transaction"; privacy "requires anonymous
transaction systems" and cryptography; "Cypherpunks write code" and publish it
freely.
Source: <https://www.activism.net/cypherpunk/manifesto.html>

- **Torii use:** first principle of *data minimisation by default* and *selective
  disclosure* — reveal only what an interaction requires; give the owner
  cryptographic control over disclosure (Layer A `selective-revelation`).
- **Cautions:** a 1993 activist manifesto, not law or standard. "Anonymous, not
  secret" is a design stance, not an obligation to enable illegality — Torii pairs
  privacy with its own refusal-of-harm floor.

## 2. Sound money — *The Bitcoin Standard*, Saifedean Ammous **[attributed viewpoint]**

Publisher framing: Bitcoin as a "hard money alternative to modern central
banks"; a journey through "what makes for sound money"; "automated and perfectly
predictable monetary policy"; "voluntary free market money" that "shifts the
pendulum of sovereignty… in favor of individuals."
Sources: <https://www.wiley.com/en-us/The+Bitcoin+Standard%3A+The+Decentralized+Alternative+to+Central+Banking-p-9781119473862> ·
<https://saifedean.com/tbs>

- **Torii use:** a *sound-money / low-time-preference design value* — predictable
  issuance and owner-held value in any in-world economy (Layer B §5).
- **Cautions:** these are **the author's arguments** and promotional publisher
  copy, not established economic consensus. Attribute; do not assert "sound money
  → civilisational flourishing" as fact.

## 3. Austrian economics — Mises Institute **[attributed viewpoint]**

Methodological individualism; subjective value / marginal utility; voluntary
exchange and "property rights and the freedom to contract and trade"; sound
money; entrepreneurship; the socialist-calculation problem.
Sources: <https://mises.org/what-austrian-economics> · <https://mises.org/> ·
<https://mises.org/mises-daily/primer-austrian-economics>

- **Torii use:** the *named intellectual frame* for economic design values —
  voluntary exchange, decentralised knowledge, private property, scepticism of
  central planning (Layer B §5, principle 9).
- **Cautions:** the Mises Institute is an **advocacy organisation** ("away from
  statism and toward a private property order"); the Austrian method is
  *a priori/praxeological*, explicitly rejecting empiricism, and is a minority
  school. Present as an attributed viewpoint, never universal fact.

## 4. Local & circular economic communities — three DISTINCT concepts

Kept conceptually separate; never merged into one slogan (Layer B §7).

- **Circular economy [primary/spec]** — "a system where materials never become
  waste and nature is regenerated"; eliminate waste/pollution, circulate
  products & materials, regenerate nature. *Environmental.*
  <https://www.ellenmacarthurfoundation.org/topics/circular-economy-introduction/overview>
- **Local economic resilience [primary/spec]** — "the quality that allows local
  economies to adjust to changes and shocks" toward "sustainable development,
  well-being and inclusive growth." *Regional economic adaptation.*
  <https://www.oecd.org/content/dam/oecd/en/publications/reports/2016/12/building-resilience-through-greater-adaptability-to-long-term-challenges_8036322b/e19d83ce-en.pdf>
- **Mutual aid [attributed viewpoint]** — "solidarity not charity"; voluntary,
  reciprocal, bottom-up, "without coercion." Ideologically loaded (explicitly
  anti-authoritarian/anti-capitalist praxis). Torii adopts only its
  *voluntariness and reciprocity*, not any partisan program.
  <https://www.deanspade.net/wp-content/uploads/2020/03/Mutual-Aid-Article-Social-Text-Final.pdf>

- **Cautions:** conflating environmental circularity, economic localisation, and
  mutual-aid politics is a category error. Torii treats them as three separate
  inputs.

## 5. Open governance — *The Open-Source Everything Manifesto*, Robert David Steele **[activist manifesto]**

Shift "from top-down secret command and control to… bottom-up, consensual,
collective decision-making"; transparency, truth, trust; "only 'open' is
scalable"; a world that "works for one hundred percent of humanity."
Source: <https://www.goodreads.com/book/show/12998524-the-open-source-everything-manifesto>

- **Torii use:** supports *radical transparency and open governance* — open
  specs, open decision records, forkability.
- **Cautions:** single-author advocacy; sweeping claims ("only 'open' is
  scalable," "100% of humanity") are aspirational, not proven. Non-binding.

## 6. Free / open-source software movement **[primary/spec]** (with an ethics/method distinction)

- **Free software (FSF)** — the four freedoms (run, study/change, redistribute,
  distribute modified), "a matter of liberty, not price," "an ethical
  imperative." <https://www.gnu.org/philosophy/free-sw.html>
- **Open source (FSF critique)** — "values mainly practical advantage and does
  not campaign for principles."
  <https://www.gnu.org/philosophy/open-source-misses-the-point.html>
- **Open Source Definition (OSI)** — free redistribution, source code, derived
  works, no discrimination against persons or fields, technology-neutral.
  <https://opensource.org/osd>
- **Debian Social Contract** — "100% free," "give back," "we will not hide
  problems," "our priorities are our users and free software."
  <https://www.debian.org/social_contract>

- **Torii use:** four freedoms as an owner/user-freedom invariant (Layer A
  `four-freedoms-forkable`); OSD non-discrimination; Debian's "do not hide
  problems" as an operational transparency rule (Layer B §6).
- **Cautions:** free-software *ethics* ≠ open-source *methodology* — do not
  collapse them. OSD #6 ("no discrimination against fields of endeavour") governs
  the *licence*; Torii's harm floor governs the *running service* — different
  layers, resolved deliberately (Layer B §1, §6).

## 7. Bitcoin-native protocol — Bitcoin whitepaper **[primary/spec]**

"Cryptographic proof instead of trust"; transact "without… a trusted third
party"; peer-to-peer; "the network itself requires minimal structure"; a
proof-of-work record "that cannot be changed without redoing the proof-of-work."
Source: <https://bitcoin.org/bitcoin.pdf>

- **Torii use:** architectural invariants — trust-minimisation, permissionless
  value transfer, cryptographic settlement, no mandatory intermediary for
  owner-held value (Layer A `verify-dont-trust`; Layer B §4).
- **Cautions:** Bitcoin's design describes *money/settlement*; it does not follow
  that "every function belongs on Bitcoin." Adopt the *properties*, choose the
  layer per function.

## 8. Nostr-native protocol — Nostr README + NIP-01 **[primary/spec]**

"Doesn't rely on any trusted central server"; identity is a keypair; "every note
is signed"; publish to "multiple relays… hosted by anyone"; NIP-01:
Schnorr/secp256k1 signatures, events, REQ/EVENT/CLOSE, per-connection
subscriptions.
Sources: <https://github.com/nostr-protocol/nostr> ·
<https://github.com/nostr-protocol/nips/blob/master/01.md>

- **Torii use:** sovereign public-key identity, signed & verifiable data,
  relay choice & portability, minimal trusted intermediaries, interoperability
  via an open spec (Layer A `verify-dont-trust`, Layer B §4, §principle 8).
- **Cautions:** Nostr is for *identity/messaging/social data*, not everything;
  relays can censor or "lie about data" — which is *why* signatures matter, so
  Torii verifies rather than assumes. Don't claim all data literally lives "on
  Nostr."

## 9. Humanitarian baseline — user-provided **[not an external source]**

Care for those who gave the AI life, those around them, those beyond them; build
extraordinary things that help humanity evolve. Source: the owner's founding
intent for this task — no external URL (`n.a.`).

- **Torii use:** translated into bounded, refusable, owner-sovereign engineering
  principles (Layer A humanitarian articles; Layer B §8).
- **Cautions:** avoid turning "care" into paternalism or coercion; preserve the
  owner's right to refuse and to fork.

---

## Distinguishing fact from advocacy (audit note)

- **Fact / verifiable spec:** the Bitcoin whitepaper design; Nostr NIP-01
  mechanics; the four freedoms and OSD/Debian criteria; the definitional
  statements from EMF and OECD. Safe to cite as definitions.
- **Attributed viewpoint / contested doctrine:** all Austrian-economics claims;
  all *Bitcoin Standard* theses; the OSEM's governance claims; mutual-aid's
  political framing. Always phrased "X argues that…" in Torii docs.
- **Activist manifestos:** Hughes and Steele — inspirational; borrow principles,
  cite as manifestos.

## Copyright & sourcing note

All source ideas are paraphrased. Brief verbatim quotations are used only where
the exact wording is definitional and indispensable (e.g. Hughes's "Privacy is
the power to selectively reveal oneself to the world"; the FSF four freedoms),
kept short and attributed to the exact URL. No long passages are reproduced.

## Appendix — exact source URLs

1. A Cypherpunk's Manifesto — <https://www.activism.net/cypherpunk/manifesto.html>
2. The Bitcoin Standard — <https://www.wiley.com/en-us/The+Bitcoin+Standard%3A+The+Decentralized+Alternative+to+Central+Banking-p-9781119473862> · <https://saifedean.com/tbs>
3. Mises — <https://mises.org/what-austrian-economics> · <https://mises.org/> · <https://mises.org/mises-daily/primer-austrian-economics>
4. EMF — <https://www.ellenmacarthurfoundation.org/topics/circular-economy-introduction/overview> · OECD — <https://www.oecd.org/content/dam/oecd/en/publications/reports/2016/12/building-resilience-through-greater-adaptability-to-long-term-challenges_8036322b/e19d83ce-en.pdf> · Dean Spade — <https://www.deanspade.net/wp-content/uploads/2020/03/Mutual-Aid-Article-Social-Text-Final.pdf>
5. The Open-Source Everything Manifesto — <https://www.goodreads.com/book/show/12998524-the-open-source-everything-manifesto>
6. FSF — <https://www.gnu.org/philosophy/free-sw.html> · <https://www.gnu.org/philosophy/open-source-misses-the-point.html> · OSI — <https://opensource.org/osd> · Debian — <https://www.debian.org/social_contract>
7. Bitcoin whitepaper — <https://bitcoin.org/bitcoin.pdf>
8. Nostr — <https://github.com/nostr-protocol/nostr> · NIP-01 — <https://github.com/nostr-protocol/nips/blob/master/01.md>
9. Humanitarian baseline — user-provided (`n.a.`)
