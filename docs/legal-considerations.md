# Legal considerations for `keepsake.ing`

**Not legal advice.** I am not a lawyer, and this is research assembled by an AI agent from public
statutes, regulator guidance, and web search — not a legal opinion, and not a substitute for one.
Where I could not verify something with a primary source in the time available, it is marked
**unverified** rather than smoothed over. Treat every "this doesn't apply at your size" conclusion
below as a starting point for a real lawyer conversation, not a final answer, especially before
spending money on ads or growing past a handful of users.

Grounded against the live `apps/site/public/privacy.html` and `terms.html` (last updated September
2026) and `docs/runbooks/launch-audit.md` §7, as of 2026-09-06. Product facts assumed: free
gifting marketplace, photo + story listings, in-person handoff, no accounts (device token +
optional verified email), AI moderation + human queue + report button, serves US/Canada/UK,
operated by one individual in Texas (not a company), zero revenue, a handful of users, Google Ads
and a consent banner being added now.

---

**Status update (2026-09-06), left in place rather than edited into the research above so this
stays an honest record of what was found and when:**

- **UK Online Safety Act (recommendation 3): resolved by geo-blocking the UK**, not by completing
  the assessments. Kiarash decided against taking on the risk assessment / children's-access
  assessment / complaints-procedure work for now. See
  [`docs/runbooks/uk-block.md`](runbooks/uk-block.md) for the decision record and what would have
  to be true to reverse it. The product now serves **US/Canada only** — every "serves US/Canada/UK"
  line above should be read as historical context for why the research covered UK law at all, not
  as the current product surface.
- **Minimum age (recommendation 1): done.** 18+, self-attested, required on both create-listing and
  create-request (`@keepsake/contracts/common`'s `AgeAttestationSchema`/`MINIMUM_AGE`), recorded
  server-side (`age_attested_at`), and stated in `terms.html`.
- **Prohibited items (recommendation 6): done.** The table below is now in `terms.html`, with the
  statute-vs-hazard-only column preserved.
- **Privacy page overclaims (recommendations 4-5): done** — see `apps/site/public/privacy.html`'s
  IP-hash, email-forwarding, and GPC sections.
- **Controller name and postal address (recommendation 2): blocked on Kiarash.** The page names him
  as controller; the postal address is a `TODO(kiarash)` placeholder in the HTML, not invented.
- **Requester data removal (launch-audit's open item, not numbered above): done.** See
  `POST /api/requests/withdraw` and `docs/design/identity.md`'s "Request withdrawal" section.
- Everything else below — Rhode Island/Montana, in-person safety copy, the Article 27
  representative question, the eight lawyer questions — is **still open**, unchanged from the
  original research.

---

## What I would do before launch (or before turning ads on)

### Legal requirements — do these regardless of size or budget

1. **Add a minimum age to the terms and a self-declared age gate at listing/request time.**
   Neither page currently mentions age. This is the single gap every stream flagged. See
   [Minimum age](#minimum-age).
2. **Name a controller and give a postal address**, not just `hello@keepsake.ing`. UK GDPR Art. 13
   requires the controller's identity and contact details wherever the product is offered to UK
   users, which it is. A sole proprietor's registered or business address is enough; it does not
   need to be a company.
3. **Complete a UK Online Safety Act illegal-content risk assessment and a children's access
   assessment, in writing, and stand up a complaints procedure.** These have no small-service
   carve-out — see [UK Online Safety Act](#uk-online-safety-act). This is very likely the largest
   single piece of unfinished compliance work and the biggest gap the earlier research left open.
4. **Fix the privacy page's own false or overclaiming statements** before the ads/consent work
   ships, per launch-audit §7: the "hash can't be reversed" line overclaims for a stable or
   short-window salted hash, and the giver's email being forwarded to a chosen requester needs its
   own sentence (right now the page discloses only that the giver's address is never shown
   *publicly*, which reads as "never shared" to someone who hasn't traced the choose-flow code). A
   consent banner sitting on top of an inaccurate policy is the exact fact pattern the CCPA's
   Healthline enforcement action punished as deceptive, under unfair-competition law that does not
   care about California's revenue thresholds.
5. **Do not claim GPC compliance is legally required at this scale** — it isn't, for a Texas sole
   proprietor below every state's revenue/volume threshold — but if the privacy page says it is
   honoured (it does, today), keep the code honest with that claim or soften the claim. A promise
   made voluntarily is still enforceable as a false statement if broken.
6. **Adopt the prohibited-items table below into the terms**, distinguishing "this is illegal to
   give away" (statute-backed) from "we won't allow this because it's dangerous" (hazard-backed,
   no statute). See [Prohibited items](#prohibited-items).

### Strongly advised — not clearly mandatory at this scale, but the exposure is real and cheap to close

7. **Rhode Island and Montana:** review the Montana minors duty-of-care sections and Rhode
   Island's threshold-free "commercial website" language against the actual site (see
   [US state privacy law](#us-state-privacy-law)). Neither requires a large engineering lift; both
   are unresolved enough that a lawyer's five-minute read is worth more than my inference here.
7. **In-person meeting safety copy.** Add explicit safe-meeting guidance (public place, tell
   someone, bring a friend, use the in-app request flow instead of moving to text/email) to the
   give/request flow and terms, and add a mutual indemnification clause modeled on what Olio
   already runs (see [In-person safety](#in-person-safety)). The current terms disclaim
   responsibility for what happens after a meet-up but don't proactively coach either party.
8. **Sole-proprietor / individual-controller disclosure discipline**: the UK GDPR Art. 27
   representative question is genuinely unresolved for a hobbyist-scale operator with an ongoing
   (not occasional) UK-facing service — see [UK GDPR / PIPEDA](#uk-gdpr--pipeda-for-an-individual-controller).
   Get a lawyer's read before this scales past "a handful of users," and definitely before it scales
   past free.
9. **Keep every notification email (`chosen`, "someone asked for your keepsake") strictly
   transactional** — no promotional content, no newsletter copy folded in — so it stays exempt
   under CAN-SPAM, CASL, and PECR regardless of the ads rollout. See [Email](#email).

### Nice to have

10. Publish a short "why we ask your age" and "why we don't sell data" FAQ entry; it costs nothing
    and pre-empts the exact question a journalist or regulator asks first.
11. A visible last-reviewed date on the terms page tied to *legal* review, separate from the
    existing "last updated" date tied to copy edits.
12. A one-line "we are not a company" disclosure near the Texas footer credit — it's already
    implied by "Made in Texas" but stating it plainly heads off a "who do I sue" question.

---

## US state privacy law

**Bottom line: no state's comprehensive privacy law volume threshold is remotely close at this
scale** — thresholds run 25,000–175,000 state residents or $25M–$1B in revenue, and Keepsake has a
handful of users and zero revenue. Five provisions are the exception because they carry **no
volume threshold at all**, and are the only ones that could realistically reach an operator this
small:

- **Texas** (Bus. & Com. Code §541.002(a)(3)): SBA-small-business operators are exempt from the
  whole chapter except §541.107, which still bars *selling sensitive data* without prior consent.
  Texas is the founder's home state and the cleanest exemption in the country — Keepsake doesn't
  sell data at all, so this is moot in practice, but keep the "we don't sell or share data"
  language accurate as the site grows.
- **Nebraska** (§87-1118): same structure as Texas.
- **Montana** (§§30-14-2811, -2818, -2819): minors' duty-of-care provisions apply to anyone
  targeting Montana residents, with **no volume floor**. A product that lets any visitor post a
  photo, a free-text story, and arrange to meet a stranger is worth reading these sections against
  directly, even without evidence of Montana-specific traffic. **Unverified**: whether "duty of
  care to minors" attaches based on incidental Montana visitors to a US-wide site, or only to
  services that target minors specifically — the statute's targeting language matters and I did
  not fully resolve it.
- **Connecticut** (post-July-2026 amendments): processing *any* sensitive data or selling *any*
  personal data brings an operator into scope with **no volume floor**. This is flagged as the
  single biggest exposure for a small operator generally. Keepsake doesn't sell data, and its
  sensitive-data footprint is thin (no accounts, no special-category data collected by design),
  but a lawyer should confirm that photos of physical objects plus free-text stories don't
  incidentally sweep in anything Connecticut treats as sensitive (e.g., a story that mentions a
  parent's death, a disability, a child).
- **Rhode Island** (§6-48.1-3(a)): reaches "any commercial website... with customers in Rhode
  Island," no threshold. Whether a zero-revenue hobby site with an ads pilot starting is
  "commercial" is **genuinely unsettled** — I found no case or guidance resolving it, and adding
  Google Ads this week tips the fact pattern toward "commercial" in a way it wasn't before.

**Independent of thresholds:** falling below a state's volume threshold does not immunize a false
statement about honoring an opt-out signal. California's Healthline enforcement ran under the
Unfair Competition Law, not the CCPA itself, precisely because deceptive claims about consent
handling are actionable outside the privacy-law-specific thresholds. This is directly relevant
because a consent banner is shipping now — see recommendation 4 above.

## GPC and universal opt-out

Twelve states require honoring an opt-out preference signal, and GPC is the only recognized
mechanism in Colorado. In every statute checked, the GPC duty lives inside the same
substantive-duties chapter as the general applicability threshold — it is not a free-standing,
threshold-free mandate. A Texas SBA small business (which Keepsake qualifies as) owes no state law
duty to honor GPC today.

Enforcement is real and rising even against much larger players: a joint CA/CO/CT sweep on GPC in
September 2025, CPPA actions naming opt-out-signal handling against Tractor Supply, PlayOn, and
Ford, and settlements against Disney ($2.75M) and GM ($12.75M). None of those are comparable to
Keepsake's scale, but they establish that regulators treat a *broken or dishonest* opt-out
mechanism as an independent violation, separate from whether the underlying privacy law applies.
California's AB 566 (operative January 1, 2027) puts the opt-out-signal burden on *browser makers*,
not websites — it doesn't create a new site-side duty.

**The privacy page already says Keepsake honors GPC everywhere, not just where required** — that's
a voluntary commitment, which is good practice, but it converts an optional feature into a
promise a regulator or plaintiff could hold to the same "don't lie about it" standard as a
legally-mandated one. Keep the code matching the claim.

## Prohibited items

The Consumer Product Safety Act's prohibited verbs are **sell / offer for sale / manufacture for
sale / distribute in commerce / import** — "give away" appears nowhere. The only plausible hook for
a free, in-person, one-to-one, intrastate-or-cross-border-within-the-served-countries gift is
"distribute in commerce," and **no case, adjudication, or interpretive rule resolves whether that
covers this fact pattern.** But CPSC's own Resellers Guide asserts in writing that its rules reach
"individuals holding yard sales" and that "persons who give away used products for free cannot
sell or donate products that do not meet the requirements of the law." That is a citable, honest
basis for a platform-level ban regardless of how the underlying legal question would eventually be
decided — it's CPSC's stated position, not an invented one.

**The drafting rule that matters most: where there is no law but a real hazard, say so as a
hazard.** Writing "illegal" next to a free bike helmet would be a false statement in the terms and
would undermine every other row that *is* backed by a real statute.

| Item | Rule | Basis | Statute or hazard-only |
|---|---|---|---|
| Cribs manufactured before June 28, 2011, and all drop-side cribs | Do not give away | CPSC: "should not resell, donate or give away" | Statute-adjacent (CPSC written guidance interpreting the crib safety rules; not a give-away-specific statute) |
| Inclined sleepers and crib bumpers | Banned hazardous product | Pub. L. 117-126 — bumpers banned regardless of manufacture date | Statute |
| Children's products with lead exceeding federal limits (except metal jewelry) | Generally allowed once used, if donor has no actual knowledge of a violation | 15 U.S.C. §1278a(b)(7) exempts used children's products from lead limits even when donated, but defines "seller" to include a person who lends or donates, and carves out children's metal jewelry and anything the donor actually knows violates the limits | Statute |
| Children's metal jewelry (used) | Do not give away without verifying lead content | Carved out of the §1278a(b)(7) used-goods exemption | Statute |
| Car seats | Allow, but require the giver to disclose age/crash history; do not represent as legally restricted | Not federally restricted once first sold — 49 U.S.C. §30112(b)(1) | Hazard-only (unverifiable crash/recall history), not a legal ban |
| Helmets (bike, sports) | Allow, but require the giver to disclose age/impact history; do not represent as legally restricted | No federal give-away restriction found | Hazard-only |
| Radioactive antiques (vaseline glass, Fiestaware) | Allow, with a "not for food or drink contact" notice | Expressly exempt under 10 CFR §§30.15/40.13 | Statute (exemption, not a ban — allow, don't over-restrict) |
| Weapons, ammunition, explosives | Do not give away | Varies by item/jurisdiction; several categories require a licensed transfer | Statute (jurisdiction-dependent — keep the terms' existing general "anything illegal to give away where you live" catch-all) |
| Drugs, controlled substances | Do not give away | Federal and state controlled-substances law | Statute |
| Live animals | Do not give away via this platform | Product/hazard fit (animal welfare, transport, no verification of care) plus many state/local transfer rules | Mixed — hazard-only as a platform-fit call, statute-backed in many specific jurisdictions |
| Recalled products generally (beyond the specific categories above) | Do not give away if the giver has actual knowledge of the recall | Mirrors the §1278a(b)(7) "actual knowledge" standard as a platform-wide principle, not a universal statute | Hazard-only as a general rule; statute-backed for the specific recalled categories above |

Texas repealed its own bedding/used-mattress law in 2015 — don't cite Texas law for
bedding-specific restrictions; rely on the federal categories above instead.

## UK Online Safety Act

**This is the largest single unresolved obligation and was the biggest gap going into this
document.** Findings from targeted searches (Ofcom guidance, legislation.gov.uk, and law-firm
summaries as of September 2026):

- **No size-based exemption for the base duties.** The Online Safety Act's "regulated service"
  definition is broad — any user-to-user service with a link to the UK (a target market, a
  significant number of UK users, or a material risk of significant harm to UK individuals) is in
  scope. Keepsake explicitly serves the UK, so it clearly meets this test. The Category 1 / 2A / 2B
  thresholds (tens of millions of UK monthly users) only add *further* duties on top of the base
  ones — they do not create a floor below which the Act doesn't apply at all.
- **Illegal content risk assessment**: required of every in-scope user-to-user service, in
  writing, regardless of size. A small service that documents a "suitable and sufficient"
  assessment and concludes risk is low across all 17 priority-content categories faces
  proportionate, not eliminated, obligations — the assessment itself is still mandatory.
- **Children's access assessment**: required of every in-scope user-to-user and search service; the
  original deadline was 16 April 2025 for all providers already operating, meaning any service
  launching now should treat this as immediately due, not a future milestone. There is **no
  evidence of a small-service exemption** in anything found — Ofcom's own guidance states that
  "not seeming appealing to children" does not exempt a service; the provider needs affirmative
  evidence that a significant number of children are not using it, or must complete the assessment.
  A photo-upload, free-text, meet-a-stranger product cannot credibly claim children aren't using
  it without an age gate to point to — which loops back to recommendation 1.
- **Complaints procedure**: required of all regulated user-to-user services — easy to access, easy
  to use (including by children), and transparent, with appropriate action taken on complaints.
  Keepsake's existing report button is a start; it should be paired with a documented complaints
  process and response commitment, not just a report action with no visible SLA.
- **Record-keeping**: providers must keep written records of risk assessments and of measures taken
  to comply with applicable codes of practice. Ofcom can exempt specific *descriptions* of provider
  from *some* duties by published exemption, but I found no standing "small provider" record-keeping
  carve-out in force — **unverified** whether any such Ofcom exemption exists that would cover a
  service this size; worth a direct question to a lawyer or to Ofcom's own guidance pages rather
  than relying on this document.
- **Enforcement posture in 2026**: Ofcom's largest fines to date (8579 LLC, £1.35M; a forum
  operator, £950,000) have targeted pornography/age-assurance failures and a platform tied to over
  160 UK deaths — not micro-scale general marketplaces. That is a real mitigating factor for
  prioritization (Ofcom is not going to open with a solo operator), but it is not a legal exemption,
  and it says nothing about what happens if a Keepsake meetup goes wrong and draws attention.

**Practical read:** treat the risk assessment, children's access assessment, and a documented
complaints procedure as due now, not deferred — they're inexpensive to produce for a service this
size (a few pages, honestly assessing "low risk, small scale, human-reviewed queue, report button")
and the absence of a paper trail is the actual exposure, more than the underlying risk level.

## Minimum age

- **COPPA**: applies to services directed at children under 13, or to any operator with *actual
  knowledge* a specific user is under 13. Self-declared age gates remain usable for *general*
  audience sites to establish actual knowledge (if someone declares under 13, that's actual
  knowledge and access must be blocked/data not collected) — but the FTC's 2025 COPPA amendments
  (effective June 23, 2025; compliance required by **April 22, 2026**, already past as of this
  writing) tightened rules specifically for *mixed-audience* sites, restricting reliance on pure
  self-declaration without an age-screening mechanism before collecting personal information. A
  photo-and-story marketplace open to all ages is closer to "general audience" than "mixed
  audience" unless it's shown or marketed as attracting children specifically; **unverified**
  whether Keepsake's specific age-screen design (a one-time declaration versus a screen at every
  session) satisfies the amended rule's mechanics — a lawyer should confirm the exact UX needed to
  keep relying on self-declaration.
- **Given the in-person meetup mechanic**, the honest floor to set is higher than COPPA's 13 — a
  self-declared "18 and over" gate is the right minimum for *both* givers and requesters, not
  because a lower age would create liability the platform doesn't already have, but because a
  self-declared age gate's real function here isn't age verification (it can't verify anything) —
  it's a documented basis for banning an account/token the moment there's actual knowledge a user
  is a minor, and a plain, honest signal to families that this product is not built or screened
  for minors meeting strangers.
- **UK Age Appropriate Design Code (Children's Code)**: applies to any service "likely to be
  accessed by children" under 18, enforced by the ICO, independent of the Online Safety Act. There
  is no confirmed small-service or self-declared-age-gate carve-out in what I found — the ICO's own
  guidance frames age-gating as *one* possible measure a provider can take to argue it is *not*
  likely to be accessed by children, but the provider must document that reasoning, not just add a
  checkbox. **Unverified**: whether an 18+ self-declaration gate alone, with no further
  verification, is sufficient documentation to take Keepsake out of scope — this is exactly the
  kind of judgment call that benefits from a lawyer's five-minute read rather than an inferred
  answer.

## Email

All three regimes checked treat a purely transactional notification — "someone asked for your
keepsake" — favorably, **as long as it stays purely transactional**:

- **CAN-SPAM**: a message is transactional/relationship mail, exempt from the opt-out/unsubscribe
  requirements that apply to commercial email, if its primary purpose is transactional and it
  contains no promotional material. A request notification qualifies cleanly today.
- **CASL (Canada)**: purely transactional messages that facilitate, complete, or confirm something
  the recipient already engaged with are exempt from CASL's consent requirement, but identification
  and (for commercial messages generally) unsubscribe requirements still apply once any promotional
  content is mixed in. Keep the notification emails free of anything promotional.
- **UK PECR**: the same logic — a genuine service email stays outside PECR's marketing-consent
  rules; adding a promotional banner or ad copy to it converts it into direct marketing and pulls
  in consent/soft-opt-in requirements.

**Turning on Google Ads does not, by itself, reclassify the notification emails** — ad targeting
lives in a separate channel (the web tag), not the email content. The risk is purely operational:
if a "grow the marketplace" instinct later adds a line like "check out what else is available" to a
transactional email, that one line converts the whole message into marketing under all three
regimes, and self-inflicts a consent problem that doesn't exist today. Recommendation 9 above
exists specifically to head that off.

## UK GDPR / PIPEDA for an individual controller

- **UK GDPR Article 27 representative**: required for any non-UK controller processing UK
  residents' data under Article 3(2) (offering goods/services to, or monitoring, UK data subjects —
  which Keepsake does by design). There is a narrow exemption for processing that is (a) occasional,
  (b) not large-scale special-category or criminal-offence data, and (c) unlikely to create a risk
  to individuals' rights — **all three must hold together**. Keepsake's UK-facing processing is
  ongoing (it's the core service, not occasional), which is the element most likely to knock the
  exemption out even though the volume is tiny and no special-category data is collected by design.
  **This is a genuinely close call for an operator this size and I could not resolve it with
  confidence** — guidance I found leans toward "when in doubt, appoint a representative," but a
  representative is a paid, ongoing service, which is a real cost for a zero-revenue project.
  Flag for a lawyer explicitly; don't guess past this.
- **UK GDPR Article 13 privacy notice**: requires, at minimum, the controller's identity and
  contact details, the purposes and legal basis for processing, retention periods (or the criteria
  used to set them), and the data subject's rights (access, erasure, objection, complaint to the
  ICO). See the checklist below for what's already on the page.
- **PIPEDA (Canada)**: applies based on a "real and substantial connection" to Canada, not
  incorporation location — actively serving Canadian users and holding their data is enough, and
  courts have applied it to entities with no Canadian presence at all. The gating question for
  Keepsake is PIPEDA's own "commercial activity" threshold: as a free, zero-revenue service, is it
  engaged in commercial activity? **Unverified and worth a direct answer**: adding Google Ads
  arguably tips a previously-arguable "not commercial" service toward commercial activity, since ad
  revenue (even nascent) is a commercial purpose layered onto the same data flows. Don't assume
  free-to-users means PIPEDA doesn't apply once ads are live.

## In-person safety

What comparable platforms actually do, as a reference point for what's realistic for one person to
maintain:

- **Craigslist / police-department "safe exchange zones"**: the dominant pattern across the sources
  found is meeting in a well-lit, public, camera-covered location — commonly a police station
  lobby or parking lot — never at a home, and bringing another person or telling someone the time
  and place in advance. Several US cities maintain formal, indexed "safe exchange zone" locations.
- **Facebook Marketplace / OfferUp**: the same core advice (public place, keep communication
  in-app rather than moving to personal contact info, tell someone where you're going), delivered
  as safety-tips content rather than a hard requirement.
- **Olio**: explicitly supports no-contact/doorstep pickup as a lower-friction safety option, tells
  users to keep communication on-platform and to stop/step away/report if something feels unsafe,
  and — notably — carries an indemnification clause where the person giving an item indemnifies
  Olio against claims arising from their dealings with the other party, alongside a blanket
  disclaimer of liability for user behavior.
- **Buy Nothing Project**: same public-place/bring-a-friend guidance, community-guideline based
  rather than contractual.

**Concrete gap for Keepsake**: the current terms disclaim responsibility after the fact ("use good
judgment when arranging to meet a stranger") but don't proactively coach either party the way every
comparable product does, and don't carry an indemnification clause. Given the product's explicit
premise — a stranger comes to your door or a meeting point for something with sentimental framing,
which likely makes the request note *more* personal than a "want a used couch" listing, not less —
adding explicit meeting-safety copy in the request/choose flow (not just the terms) and a mutual
indemnification clause is worth doing regardless of what any statute requires.

## Privacy notice checklist

Checked against `apps/site/public/privacy.html` as it reads today (last updated September 2026).

| Element | Required by | Present today? |
|---|---|---|
| Controller identity (name of the responsible person/entity) | UK GDPR Art. 13(1)(a) | **No** — only an email address, no name |
| Controller contact details / postal address | UK GDPR Art. 13(1)(a) | **No** |
| UK representative (if Art. 27 applies) | UK GDPR Art. 27(1) | **No** — and whether one is required is itself unresolved, see above |
| Purposes of processing | UK GDPR Art. 13(1)(c) | **Yes** — device key, optional email, request contact info, photos, screening, rate limiting are each described |
| Legal basis for processing | UK GDPR Art. 13(1)(c) | **No** — no lawful-basis language (e.g., legitimate interest, consent) is used anywhere |
| Categories of recipients / third parties | UK GDPR Art. 13(1)(e) | **Partial** — Cloudflare (R2, AI screening, analytics) and Google (ads) are named; Turnstile, Sentry, Resend are used per the code but not named on the page (per launch-audit §7) |
| Retention periods or criteria | UK GDPR Art. 13(2)(a) | **Partial** — photos: "as long as the listing exists, plus a short grace period"; other categories (email, request contact info) have no stated retention |
| Data subject rights (access, erasure, objection, portability) | UK GDPR Art. 13(2)(b) | **Partial** — deletion is described (listing/photos self-serve, everything else via email request); access/portability/objection are not named as rights |
| Right to complain to a supervisory authority (ICO) | UK GDPR Art. 13(2)(d) | **No** |
| Whether provision of data is a legal/contractual requirement | UK GDPR Art. 13(2)(e) | **No**, but low-stakes here since almost everything is optional by design |
| Existence of automated decision-making | UK GDPR Art. 13(2)(f) | **Partial** — AI screening is disclosed as a safety gate; the code's separate use of AI to *generate a title/category* (per launch-audit §7, `suggest/suggest.ts:85`) is not disclosed |
| Minimum age / children's provisions | Best practice, OSA/AADC-adjacent | **No** — see [Minimum age](#minimum-age) |
| Disclosure that giver's email is shared with a chosen requester | Accuracy / UK GDPR Art. 13(1)(c) purpose specificity | **No** — the page discloses only that the email is never shown *publicly*, per launch-audit §7 |
| GPC / do-not-sell-or-share handling | CCPA-style honesty requirement (voluntary here) | **Yes**, and reasonably detailed — described as honored everywhere, not just where legally required |
| Accuracy of technical claims (IP hash reversibility, analytics status) | General "don't lie in your privacy policy" | **Needs a second look** — the IP-hash sentence ("can't be reversed back into one") is the kind of absolute claim launch-audit §7 flagged as an overclaim for a salted-but-narrow-keyspace hash; confirm the current wording matches what the code actually does before treating it as fixed |

## Open questions for a lawyer

1. Is a UK GDPR Article 27 representative actually required here, given ongoing (not occasional)
   UK-facing processing at negligible volume and no special-category data by design? What does a
   representative cost at this scale, and is there a cheaper compliant alternative?
2. Does PIPEDA's "commercial activity" gate apply once Google Ads goes live on a still-free
   product, or does "free to users" keep it out of scope regardless of ad revenue?
3. Does Rhode Island's threshold-free "commercial website" language reach a zero-revenue product
   running ads, and does Montana's minors duty-of-care section require anything specific given
   Keepsake's fact pattern (any US visitor, no Montana-specific targeting)?
4. Is an 18+ self-declared age gate, undocumented beyond the declaration itself, sufficient to
   avoid "likely to be accessed by children" status under the UK Age Appropriate Design Code, or
   does the ICO expect a written rationale on file even for a service this size?
5. Does the FTC's 2025 COPPA amendment's tightened treatment of "mixed audience" sites require
   anything beyond a one-time self-declared age gate for a product like this?
6. Is Keepsake's Online Safety Act record-keeping duty subject to any Ofcom-published exemption for
   providers of this size — I found the general exemption mechanism in the statute but no specific
   published exemption I could confirm covers this scale.
7. Does the "distribute in commerce" hook under the Consumer Product Safety Act carry any
   meaningfully different risk for a platform (versus an individual giver) given that Keepsake
   screens, hosts, and facilitates the exchange rather than merely being a bulletin board?
8. Should the terms carry a mutual indemnification clause (modeled on Olio's) given the in-person,
   stranger-meeting mechanic, and does Texas law (as the stated governing law) treat such a clause
   any differently for an individual operator than it would for an LLC?
