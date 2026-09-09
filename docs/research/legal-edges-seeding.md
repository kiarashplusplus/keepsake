# Legal edges of the seeding plan — research, 2026-09-09

**Not legal advice.** Research assembled by an AI agent from public statutes, agency guidance,
platform terms, and web search, to prep a lawyer conversation — not a substitute for one. Sourced
where possible; reasoning/inference is flagged as such. This environment's egress proxy blocks
direct fetches of `statutes.capitol.texas.gov`, so Texas statutory citations rest on secondary
summaries (Justia, texas.public.law, FindLaw), not primary text read end to end.

Grounded against `docs/legal-considerations.md`, `docs/legal-entity-and-insurance.md`,
`docs/seeding-and-distribution.md` §§3/5, and `apps/site/public/terms.html`.

---

## 1. Texas estate law: who may give away a decedent's things

An independent executor may distribute estate property **without court approval only after
letters testamentary are issued** (Est. Code §402.002) [texas.public.law, Justia]; before that,
nobody named in a will has distribution authority. A **small-estate affidavit** (Est. Code ch. 205)
only works for intestate estates ≤$75,000 and requires *every* distributee's sworn signature, not
majority or informal consent [texas.public.law]. Absent one of these, a single heir or a hired
liquidator giving away an item has no statutory shelter.

Search found no Texas case squarely on a third-party liquidator's or platform's exposure when an
heir later objects — **unverified**. By reasoning: the tort is conversion (wrongful dominion over
another's property), and title vests in heirs/devisees at death subject to administration, so
handling an item without authority from all interested parties risks conversion regardless of who
ends up with it. **A gift doesn't cure this** — conversion doesn't turn on profit, and giving away
something that wasn't yours to give may be a *worse* fact pattern than a sale (no proceeds trail,
no "at least the estate got paid" argument).

**What this means for the plan.** The estate-liquidator channel should require a written
attestation before listing — executor acting under letters, a signed small-estate affidavit, or
documented heir sign-off — the same shape as the individual "you have to own it" clause.

**Question for the lawyer.** Does a written attestation from a liquidator business meaningfully
shift conversion exposure for Keepsake or the business, or is it worth no more than the individual
ownership checkbox already is?

---

## 2. Agency: who is "the giver," and does a business listing wobble gifting-only

Whoever clicks "post" is the giver of record for `terms.html`'s indemnity and age gate — an
employee of a liquidator or move-manager, not the estate. That's contractually workable but worth
naming as a deliberate choice.

**DTPA:** Texas courts read "consumer" broadly — a plaintiff need not have paid, only have
benefited from goods/services forming the basis of a claim (*Kennedy v. Sale* line)
[silblawfirm.com, texaslegal.guide]. That's already true for individual givers; a business posting
doesn't change it. **Sales-tax nexus:** correctly irrelevant — no consideration, no taxable sale.
**Secondhand-dealer/pawn statutes:** every regime found — pawnshops (Fin. Code ch. 371), metal
recyclers (Occ. Code ch. 1956), Houston's licensed secondhand-reseller category — is built around
**buying, selling, or trading** used goods [Justia; houstonpermittingcenter.org; Municode]. A free
transfer isn't a purchase, sale, or trade, so these plausibly don't reach a liquidator giving items
away for $0 — but this is a pattern-based inference, not a direct read of Houston's or Harris
County's actual ordinance text.

**What this means for the plan.** A business-authored listing doesn't obviously change DTPA
exposure (already present for any factual claim in a listing) or trigger secondhand-dealer
licensing (gift, not sale/trade) — but that conclusion should be confirmed against the actual local
ordinance, not left as inference.

**Question for the lawyer.** Does any Texas or Harris County secondhand-dealer/pawn ordinance reach
a business giving away a client's goods for $0, given the business (unlike an ordinary giver) is
professionally in the business of handling other people's property?

---

## 3. Operator posting on behalf of a partner: Section 230 and moderation

Section 230 immunity turns on whether the operator is "responsible, in whole or in part, for the
creation... of" content [CRS R46751; EFF]. If Keepsake's own admin account authors a listing for a
partner, **Keepsake is the author of that listing** — 230 wouldn't shield the false-description or
ownership-claim risk in that specific listing's content, though immunity for every other,
user-authored listing is unaffected. Courts have rejected imputing authorship to a platform merely
because independent "volunteers/contractors" posted [CRS R46751] — the exposure here is narrowly
for content the operator's own account actually types.

The fail-closed/human-hold moderation posture exists to catch what a stranger might misrepresent;
an operator-authored listing removes that independent check on the operator's own errors. The fix
is procedural: route operator-authored listings through the same human queue, and mark them
distinctly in the audit trail.

**What this means for the plan.** If built, this route should keep the operator as *scrivener*
transcribing a partner's written representations, not an independent author — logged that way,
still human-reviewed — which is a better 230 posture even if not airtight.

**Question for the lawyer.** Does contemporaneously documenting "operator transcribed the partner's
own representations" meaningfully preserve 230 treatment, or does typing it into the form make
Keepsake a co-author regardless of whose words they are?

---

## 4. Cross-posting disclosure

Nothing found bars a *user* from listing the same item elsewhere. Craigslist's cross-posting rule
is scoped to posting the same ad on multiple **Craigslist** city sites, not other platforms
[craigslist.org; smallbusiness.chron.com]; Nextdoor's anti-repost rule is about duplicates *within*
Nextdoor [Moderator Academy]. `seeding-and-distribution.md` §4 reaches the same conclusion
independently. **Confirmed: no cross-platform ToS conflict.** An "also offered elsewhere" flag is a
disclosure that helps a requester and, if anything, reduces DTPA-style misrepresentation risk
rather than creating any.

**What this means for the plan.** Ship the flag; no further ToS review needed here.

**Question for the lawyer.** None — record as "checked, low risk."

---

## 5. Facebook Page mirror: content-licence chain

`terms.html`'s content licence is scoped to six named uses (store, display on Keepsake, thumbnail,
share card, sitemap, search embedding) and says explicitly: "Not in adverts, not on another site...
if we ever wanted to use a listing to show people what Keepsake is, we'd ask you first." **A
Facebook Page mirroring a giver's photo and story is republication on another site and isn't
covered today** — not a close call; the clause was drafted narrowly on purpose to avoid exactly
this kind of broad grant without asking first.

Separately, once posted to a Keepsake-run Page, Meta's own Terms attach: a "non-exclusive,
transferable, sub-licensable, royalty-free, worldwide license" to host, use, distribute, and make
derivative works, lasting until deletion (surviving further shares) [facebook.com/terms; TLDRLegal].
Keepsake would be handing Meta a second, broader licence over the photo that the giver never
separately agreed to.

**What this means for the plan.** The Page mirror can't ship on the current terms. It needs an
explicit, separate opt-in at listing time ("also share this on Keepsake's Facebook Page"), naming
that Meta's own licence then applies — consistent with the clause's own stated principle of naming
real uses and asking before going broader, rather than quietly widening the blanket grant.

**Question for the lawyer.** Is checkbox-level consent to a Facebook share sufficient notice that
Meta's broader licence then attaches, or must that downstream effect be spelled out in the consent
itself?

---

## 6. Events: library, church, and Repair Café handoffs

HCPL and Houston Public Library both offer meeting rooms free to community groups with no
insurance requirement found in either policy, but HCPL's policy puts liability squarely on the
**using group**: "The individual and group as a whole shall be liable for any noncompliance... to
include any and all damage" [hcpl.net]. Room use "does not constitute endorsement" by the library.

Church liability coverage typically protects people serving *that* church's own activities, not a
third party running its own event on the premises [Insurance Board; Donegan]. Texas's charitable-
immunity statute (Civ. Prac. & Rem. Code ch. 84) shields *volunteers of a charitable organization*
— Keepsake isn't a charity and its operator isn't a volunteer of the church's or Repair Café's own
org merely by setting up a table [Justia; FindLaw]. Texas premises-liability duties (invitee vs.
licensee) run from the property owner to visitors, not from Keepsake as a guest to the people it
invites — nothing found gives Keepsake any liability shield by being a guest of a library or
church.

`legal-entity-and-insurance.md`'s insurance framing is written entirely around "a user was hurt
meeting another user we introduced" — a one-to-one handoff. It says nothing about organized public
events, and its own flagged exclusions (professional services, assault/battery, "meetings arranged
between users") were written with that one-to-one case in mind. An event is a different exposure —
more people, a publicized time/place, Keepsake as visible host — and shouldn't be assumed covered
by the same policy language once bought.

**What this means for the plan.** Before running an event: get a written understanding with the
venue on who's responsible for what; add "does this cover a public event, not just a 1:1 meetup" to
the broker questions in `legal-entity-and-insurance.md`; never represent to a venue that Keepsake
carries coverage until it does (today: none).

**Question for the lawyer.** Does hosting a recurring public table at a library or church create
exposure beyond an ordinary 1:1 meetup, and does the sole-proprietor/no-LLC posture need revisiting
specifically for event activity ("running a stall" vs. "arranging a meetup")?

---

## 7. Texas-specific: registration and scope confirmations

**Charitable registration: confirmed inapplicable.** Texas generally doesn't require charitable-
solicitation registration for most nonprofits at all; the narrow exceptions cover law-enforcement,
public-safety, and veterans' organizations soliciting by phone [cogencyglobal.com; ballotpedia.org].
Keepsake is neither the kind of organization nor doing the kind of activity (soliciting donations to
itself) this regime reaches.

**INFORM Consumers Act: confirmed out of scope.** "High-volume third party seller" is defined by
**sales** — 200+ discrete sales and $5,000+ in gross revenue processed through the marketplace's own
payment system in a 12-month window [ftc.gov]. A $0 gift with no payment processing generates
nothing to count under either prong — a clean textual confirmation, not an inference. No other
Texas online-marketplace statute reaching a free-exchange platform was found beyond what
`legal-considerations.md` already catalogues under state privacy law.

**What this means for the plan.** No product or process change needed; this confirms seeding
activity doesn't trip a registration or high-volume-seller regime as volume grows.

**Question for the lawyer.** None — record as "checked, no exposure found."

---

## Proposed additions to `terms.html` / the docs

| What | Why | Where |
|---|---|---|
| Business/liquidator attestation (executor under letters, signed small-estate affidavit, or documented heir consent) before a business listing publishes | Closes the estate-authority gap in §1; mirrors the individual "you have to own it" clause | `terms.html`, gated in give flow for business-tagged listings |
| Explicit opt-in for "share on Keepsake's Facebook Page," naming that Meta's own licence then applies | Current content licence doesn't cover republication elsewhere and says so | `terms.html` licence section (new named use or separate consent) + give-flow UI |
| Note in insurance section flagging organized public events as distinct from 1:1 meetups, to raise explicitly with the broker | Current framing (§6) is written around introducing two strangers, not hosting a table | `docs/legal-entity-and-insurance.md`, insurance ask-in-order list |
| Written per-event checklist: who's responsible for what with the venue; no coverage misrepresented | No current process exists; venue policies put liability on the using group | New `docs/runbooks/` entry, referenced from `seeding-and-distribution.md` §3 |
| Internal note: operator-authored listings ("post on behalf of a partner") still route through human moderation and are tagged distinctly in the audit trail | Preserves the operator-as-scrivener vs. operator-as-author distinction for §230 | `docs/seeding-and-distribution.md` §5 |
| Confirm (ideally with counsel) that Houston/Harris County secondhand-dealer ordinances are scoped to buy/sell/trade and don't reach $0 transfers by a business | Currently inference from statutory pattern, not a direct read of the local code | Note in `docs/legal-considerations.md`, flagged unverified |

---

## Sources

- Texas Estates Code §402.002: [texas.public.law](https://texas.public.law/statutes/tex._est._code_section_402.002), [Justia](https://law.justia.com/codes/texas/estates-code/title-2/subtitle-i/chapter-402/subchapter-a/section-402-002/)
- Texas Estates Code ch. 205, small estate affidavits: [texas.public.law](https://texas.public.law/statutes/tex._est._code_title_2_subtitle_e_chapter_205), [Texas Law Help](https://texaslawhelp.org/article/small-estate-affidavits)
- Texas DTPA consumer status without purchase: [silblawfirm.com](https://silblawfirm.com/business-law/the-texas-deceptive-trade-practices-consumer-protection-act/), [texaslegal.guide](https://texaslegal.guide/guides/texas-consumer-protection/dtpa-basics/)
- Texas Finance Code ch. 371 (pawnshops): [Justia](https://law.justia.com/codes/texas/2005/fi/004.00.000371.00.html)
- Texas Occupations Code ch. 1956 (metal recycling): [texas.public.law](https://texas.public.law/statutes/tex._occ._code_title_12_subtitle_b_chapter_1956)
- Houston secondhand-dealer/reseller licensing: [Houston Permitting Center](https://www.houstonpermittingcenter.org/aracpe1060), [Municode](https://library.municode.com/tx/houston/codes/code_of_ordinances)
- Section 230 / information content provider: [Congress.gov CRS R46751](https://www.congress.gov/crs-product/R46751), [EFF](https://www.eff.org/issues/cda230)
- INFORM Consumers Act, high-volume seller definition: [FTC](https://www.ftc.gov/business-guidance/resources/what-third-party-sellers-need-know-about-inform-consumers-act)
- Craigslist Terms of Use: [craigslist.org](https://www.craigslist.org/about/terms.of.use/en)
- Nextdoor duplicate-post rule: [Moderator Academy](https://www.nextdoorneighborhoodteams.com/public/resources/moderator-academy-for-sale-and-free)
- Meta Terms of Service, content licence: [facebook.com/terms](https://www.facebook.com/terms/), [TLDRLegal summary](https://www.tldrlegal.com/license/facebook-terms-of-service-statement-of-rights-and-responsibilities)
- Harris County Public Library meeting room policy: [hcpl.net](https://hcpl.net/meeting-study-room-policy/)
- Houston Public Library meeting room policy: [houstonlibrary.org/policies](https://houstonlibrary.org/policies)
- Texas premises liability (invitee/licensee): [Enjuris](https://www.enjuris.com/texas/premises-liability/), [Morrow & Sheppard](https://www.morrowsheppard.com/blog/understanding-premises-liability-in-texas-what-kind-of-guest-are-you/)
- Texas Civil Practice & Remedies Code ch. 84, charitable immunity: [Justia](https://law.justia.com/codes/texas/civil-practice-and-remedies-code/title-4/chapter-84/), [FindLaw §84.004](https://codes.findlaw.com/tx/civil-practice-and-remedies-code/civ-prac-rem-sect-84-004/)
- Texas charitable solicitation registration (largely not required): [CogencyGlobal](https://www.cogencyglobal.com/blog/soliciting-charitable-donations-in-texas-heres-what-you-need-to-know/), [Ballotpedia](https://ballotpedia.org/Nonprofit_regulation_in_Texas)
- Internal: `docs/legal-considerations.md`, `docs/legal-entity-and-insurance.md`, `docs/seeding-and-distribution.md` §§3, 5, `apps/site/public/terms.html`
