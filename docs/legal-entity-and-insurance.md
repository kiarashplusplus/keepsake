# Entity form and insurance — the decision, and what it costs

**Not legal advice, and not the hour of professional time issue #108 asked for.** No lawyer and no
accountant was consulted. This is a research pass written *after* the decision was made, so it
records reasoning and prices a follow-through; it does not pretend to be an opinion from counsel.

**Method limit, stated up front because it is the same one
[`legal-open-questions-research.md`](legal-open-questions-research.md) carries.** Direct fetches of
`statutes.capitol.texas.gov`, `comptroller.texas.gov` and `law.justia.com` were all refused by this
environment's egress proxy, so every statutory citation below rests on search-result summaries of
primary sources rather than on the statute text read end to end. Claims that matter are marked
**[summary-sourced]** where that is all they are. Treat this document the way the research document
asks to be treated: a starting point for a real conversation, not a substitute for one.

---

## The decision

**Keepsake stays a sole proprietorship. No LLC, not now.** Decided by Kiarash on 2026-09-07,
closing #108. Posture: conservative — which, with no entity in the way, means the protection has to
come from somewhere else, and the rest of this document is about where.

**Operator of record:** Kiarash Adl, a United States citizen resident in Texas, doing business as
Keepsake. Principal place of business: Harris County (Houston). The street address is recorded in
["Where the address goes"](#where-the-address-goes-and-where-it-deliberately-does-not) below, along
with the reasoning for keeping it off the website.

This does not change what the site says, because what the site says is already true: `privacy.html`
names an individual controller and `terms.html`'s footer says "not a company." What changed is that
those sentences are now a decision rather than a default, and `terms.html` gained a
**Who you're agreeing with** section naming the legal person the disclaimers actually run to.

---

## Why: an LLC would buy less here than #108 assumes

This is the finding that made the decision easy, and it is the one to check first if an hour of
professional time is ever bought.

**A member of a Texas LLC is not shielded from liability for their own conduct.** The shield
(TBOC §101.114) protects a member from the *company's* obligations — its contracts, its debts, the
torts of its employees. It does not turn something a person did into something someone else did.
Kiarash is the only person who screens a listing, writes the copy, answers `hello@keepsake.ing` and
decides who gets banned. The claim #108 identifies as the realistic bad day — an injured stranger
arguing the platform was negligent in putting two people in a room together — is a claim about acts
that only one human performed, and it would name that human whether or not a certificate of
formation exists. **[summary-sourced, and the single most important claim in this document.]**

So the honest ledger:

| | Sole proprietorship | Texas LLC |
|---|---|---|
| Claim that Kiarash was personally negligent | Reaches personal assets | Still reaches personal assets |
| Claim arising from someone *else's* act (an employee, a contractor, a co-maintainer) | Reaches personal assets | Shielded — but there is nobody else |
| Contract/vendor debt in the business's name | Personal | Shielded |
| A defendant to sue that is not a person | No | Yes — real settlement-posture value |
| Formation cost | $0 | $300 to the Secretary of State (Form 205), plus ~2.7% if paid by card |
| Annual upkeep | $0 | Public Information Report (Form 05-102) every 15 May, plus a registered agent if not himself |
| Franchise tax at this revenue | Not a taxable entity at all — Tax Code §171.0002 excludes a sole proprietorship not organized so as to limit liability | $0 owed (2026 no-tax-due threshold is $2.65M), **but the report is still due** |
| Failure mode of forgetting the paperwork | None | Forfeiture of the right to transact business, and reinstatement work to undo it |

The LLC's protection is real but narrow: it covers the column that is empty today (someone else's
acts) and not the column that isn't (his own). Against that, it is a permanent annual obligation
whose failure mode — miss a report, forfeit the entity — is itself a way to end up personally
exposed, quietly, having paid for a shield that lapsed.

**What actually protects against the claim that names him personally is insurance**, because what
that claim costs on the realistic bad day is a defence, not a judgment. So the choice was never
"LLC or nothing." It is: sole proprietorship **plus cover**, rather than an entity instead of cover.
An LLC remains available the day one of the triggers below fires.

---

## Insurance: what to ask for, in what order

The disclaimers on `terms.html` and the indemnity in it are worth what the other party can pay,
which is usually nothing — the research document's own Q8(a) says so plainly. The thing that pays
for a lawyer on the bad day is a policy with a **duty to defend**, which is broader than the duty to
indemnify and applies even to a suit the insurer thinks is groundless. That, not the coverage limit,
is the point of buying it at this size.

**Today there is no cover at all.** A homeowner's or renter's policy will not answer a Keepsake
claim: personal policies exclude "business pursuits," which courts in most states read broadly
enough to reach a recurring online activity carried on for gain. **[summary-sourced]** Whether
zero-revenue Keepsake is a "business pursuit" is exactly the kind of argument nobody wants to be
having for the first time after an incident. Assume no coverage until a policy is bound.

Ask a **broker**, not an online quote form, and ask in this order:

1. **Will anyone write it?** #108 raises this first and it is the right first question. A
   zero-revenue, one-person marketplace whose product is arranging in-person meetings between
   strangers is not a standard class code. A decline is information about the risk, not about the
   broker — record it here if it happens.
2. **Which policy answers "a user was hurt meeting another user we introduced"?** A commercial
   general liability (CGL) policy covers third-party bodily injury and property damage; a claim that
   the *screening* was inadequate is closer to a professional-services claim, which is where a CGL's
   professional-services exclusion can bite and where tech E&O / media liability is the answer.
   Make the broker say which of the two responds, rather than assuming CGL covers everything.
   **[summary-sourced]**
3. **Read three exclusions before price:** professional services; assault and battery; and anything
   excluding claims arising out of meetings arranged between users. The third one would exclude the
   entire product, and a cheap policy carrying it is worse than no policy, because it would be
   mistaken for protection.
4. **Then price.** Published averages, not a quote: small businesses average roughly **$45/month**
   for general liability; sole proprietors sit at the low end of the distribution (one published
   dataset puts them ~47% below the average); annual policies commonly run **$250–$3,000** depending
   on class. Use **$300–$800/year** as the number a quote for this shape should be sanity-checked
   against, and treat a much larger number as the underwriter telling you something about the risk.

Standard small-business limits are $1M per occurrence / $2M aggregate. Buying the cover is tracked
as a follow-up issue; it is not done, and nothing in this document should be read as though it were.

---

## The assumed-name certificate — the one filing that is actually required

"Keepsake" is an assumed name: it is not Kiarash Adl's surname. Texas Business & Commerce Code
ch. 71 requires an unincorporated person doing business under an assumed name to file an assumed
name certificate with the county clerk where the business is conducted. **[summary-sourced]**

The reason to care is §71.201. Failing to file does **not** invalidate any contract, and does not
stop him defending a suit — but he **may not maintain** an action in a Texas court arising out of a
contract or act in which the assumed name was used until the certificate is filed, and a court may
award the other side the costs, including attorney's fees, of locating and serving him. Keepsake's
terms *are* a contract in the assumed name. So the filing is the difference between being able to
enforce them and not, which is precisely the conservative case for doing it rather than leaving it.

- **Where:** Harris County Clerk. Form 02-07 (1–3 owners). Signed before a notary or a deputy clerk.
- **Term:** ten years from filing.
- **Cost:** the statutory fee in ch. 71 is nominal and the county adds recording fees — tens of
  dollars, not hundreds. **[unverified figure — no county fee schedule was read]**
- **Consequence worth knowing before filing:** the certificate is a public county record and carries
  an address. Whether a mailbox or other business address may be used instead of the residence is a
  question for the clerk or a lawyer, not something to assume. **[unverified]**

---

## Where the address goes, and where it deliberately does not

**Kiarash Adl, 2004 San Sebastian Ct, Apt 2318, Houston, Texas 77058** (Harris County).

That is the address of record for: the assumed-name certificate, an insurance application, a bank
account in the assumed name, and service of process.

**It is not published on the website, and that is a decision rather than an omission.** Issue #26
established that nothing in the law that reaches Keepsake today asks for a postal address on the
privacy page — PIPEDA's accountability principle wants a named person and a working way to reach
them, Rhode Island's RIDTPPA §6-48.1-3(a) wants disclosure content, and the Texas and Nebraska
small-business exemptions want nothing; the one regime that did require an address, UK GDPR Art. 13,
has had no data subject here since the UK block. Against a legal requirement of zero sits a specific
harm: this product arranges meetings between strangers, its moderation decisions make people
unhappy, and the operator is one person at a home address.

So the conservative answer is not "publish everything" — it is **name the person in full and don't
obstruct legal notice.** `privacy.html` now does exactly that: it names Kiarash Adl as controller
rather than a first name, and says an address for a legal notice is available on request. That
answers the accountability point the address requirement exists to serve, without printing where he
sleeps on a page that anyone he has ever banned can read.

Revisit if Keepsake ever serves a jurisdiction that requires publication — carried in the trigger
table below and on `runbooks/uk-reentry-checklist.md` for the UK case specifically.

---

## What "conservative" commits us to

The decision is only conservative if these hold. They are the compensating controls for not having
an entity, and dropping one silently is how the posture becomes a word rather than a fact.

1. **Buy the cover before the site is promoted.** Tracked as a follow-up issue to #108; until it is
   bound, the honest description of Keepsake's insurance position is "none."
2. **File the assumed-name certificate**, for the §71.201 reason above.
3. **Keep the terms naming the legal person.** `terms.html`'s "Who you're agreeing with" section
   exists because "Keepsake" is not a legal person, and a disclaimer running to a name that isn't
   anybody is an ambiguity the other side gets to argue. If a later edit drifts back to writing
   "Keepsake" as though it were a company, that is a substantive change, not a copy edit.
4. **Don't take money.** Revenue moves three things at once: the "commercial website" gate that
   RIDTPPA applicability turns on (#31), franchise-tax status, and insurance underwriting. The
   consent-gated Google Ads tag with zero spend is already the closest thing to a counterexample and
   is deliberately kept that way.
5. **Don't add a second person with production access or a moderation role** without revisiting
   this. Someone else's acts are exactly the slice an LLC shields and a sole proprietorship does
   not, so a co-maintainer flips the ledger above.
6. **Keep the safety copy and the screening as they are.** Every disclaimer is worth what the facts
   behind it are worth, and the "Meeting up safely" section plus real pre-publication screening are
   those facts.
7. **Say "no company" plainly, everywhere, and keep it true.** The site's claim to be one person is
   an asset here, not a liability: it is what makes the individual-controller designation and the
   one-directional indemnity coherent.

---

## Triggers that reverse the decision

Not a schedule — a list of things that, if they happen, mean this document is out of date the same
week.

| Trigger | Why it matters | What to do |
|---|---|---|
| First dollar of revenue — ad payout, a fee, a donation | Moves the RIDTPPA "commercial" gate (#31), franchise-tax status, and underwriting, all at once | Form the LLC; revisit #31 |
| A second person with production access, or doing moderation | Their acts are the slice the shield covers and the sole proprietorship doesn't | Form the LLC before they start |
| A demand letter, an injury reported from a handoff, or any insurance claim | The abstract has become concrete | A lawyer, immediately — not another research pass |
| Every broker approached declines to write it | The compensating control this decision leans on doesn't exist | The LLC becomes the fallback, and the trade re-opens |
| Serving a jurisdiction that requires a published address or a local representative | The address decision above was scoped to US/CA | Revisit publication; see `runbooks/uk-reentry-checklist.md` |
| Volume past a few hundred listings a month, or press attention | Volume turns a rare bad outcome into an expected one | Re-read this whole document |

---

## What was not done

- **No lawyer or accountant was consulted.** #108 asked for an hour and this is not it. If that hour
  is ever bought, spend it on two things: whether an LLC would in fact shield a solo operator from a
  claim that he personally screened negligently, and the three exclusions in the insurance section.
- **No quotes were obtained.** Every price here is a published average or a statutory fee, not an
  application.
- **Income tax was not researched.** A sole proprietorship reports on the individual return; at zero
  revenue there is nothing to report yet, but the hosting and domain spend is the thing that would
  make it worth asking an accountant whether any of it is worth deducting. Out of scope for #108,
  which was about liability.
- **Nothing on the site's copy was changed on the basis of an LLC**, because there is no LLC. #108
  explicitly asked that the controller/counterparty copy not be changed pre-emptively, and it wasn't
  — the only site changes are the two this decision *makes* true: naming the legal person in
  `terms.html`, and naming him in full in `privacy.html`.

---

## Status note, 2026-09-08 — three of the unverified marks now have answers

Appended rather than edited into the sections above, so this stays a record of what was known when
the decision was made. Full working, and the same egress caveat that applies to everything else
here, in [`legal-next-actions-research.md`](legal-next-actions-research.md).

- **The assumed-name fee is $15.00** for one owner if the form is already notarized ($0.50 for each
  additional owner; add $1.00 per owner in witnessing fees if it is signed in front of a deputy
  clerk instead). That replaces the `[unverified figure]` in
  ["The assumed-name certificate"](#the-assumed-name-certificate--the-one-filing-that-is-actually-required)
  above, which guessed "tens of dollars, not hundreds" and was right. Harris County files
  unincorporated assumed names at ten walk-in locations; the term is ten years, and re-registering
  before it ends is a second diary entry.
- **The mailbox question has a provisional answer: yes, if it is a real street address.** A Texas
  DBA needs a physical street address rather than a P.O. box, and a commercial mail-receiving agency
  that provides one appears to satisfy that. Still worth one sentence to the deputy clerk at the
  counter rather than taking this paragraph's word for it.
- **A second, unrelated filing wants the same address, and publishes it.** If the copyright gap in
  `terms.html` is ever closed with a registered DMCA agent, that registration publishes the service
  provider's full legal name **and street address** in a public directory — which is precisely what
  ["Where the address goes"](#where-the-address-goes-and-where-it-deliberately-does-not) declines to
  do. A P.O. box needs a waiver on demonstrable-personal-safety grounds; a **mail-forwarding
  service's street address needs no waiver** where the provider is a natural person operating from a
  private residence. So the same commercial mail address serves the DBA, that registration, and an
  insurance application. Getting one is the cheapest way to keep this document's address decision
  intact as more filings arrive.

**And one correction to the insurance section's question 2.** It tells the broker to say *which* of
CGL or tech E&O responds to "a user was hurt meeting another user we introduced". The better-informed
answer is **neither, cleanly**: tech E&O carries a standard exclusion for bodily injury, assault and
battery outright — it is for financial harm — while CGL has the right trigger but is where the
professional-services and assault-and-battery exclusions bite. The coverage that names this exposure
is **marketplace trust-and-safety wording**, as a specialist policy or an endorsement, described in
terms close to this fact pattern (negligent screening or vetting, harm arising from user
interactions the platform facilitated) and commonly excluded without it. Ask for it by name. The
$300–$800/year sanity check above was for plain small-business CGL and should be expected to move
once that wording is on the table.

---

## Sources

All of these are search-result summaries. Every attempt to fetch a primary source — the Texas
statutes site, the Comptroller, Justia — was refused by this environment's egress proxy, which is
the same limitation the original research pass hit and the reason for the **[summary-sourced]** marks
above.

- [Texas LLC filing fees (ZenBusiness)](https://www.zenbusiness.com/texas-filing-fees/) — $300
  Certificate of Formation
- [Texas franchise tax 2026 PIR rules (RapidRegisteredAgent)](https://rapidregisteredagent.com/texas/texas-franchise-tax-2026-pir-oir-registered-agent/)
  — $2.65M no-tax-due threshold, PIR still due below it
- [Tax Code §171.0002 definition of taxable entity (FindLaw)](https://codes.findlaw.com/tx/tax-code/tax-sect-171-0002.html)
  — sole proprietorship not a taxable entity
- [Bus. & Com. Code §71.201, civil action; sanction (Texas Public Law)](https://texas.public.law/statutes/tex._bus._and_com._code_section_71.201)
  — cannot maintain an action until filed
- [Assumed-name filing mechanics, Harris County (Chamber of Commerce)](https://www.chamberofcommerce.org/dba/texas/)
- [General liability insurance cost (Insureon)](https://www.insureon.com/small-business-insurance/general-liability/cost)
  and [sole-proprietor insurance cost (MoneyGeek)](https://www.moneygeek.com/insurance/business/best-business-insurance-sole-proprietors/)
- [Business-pursuits exclusion (Digital Media Law Project)](https://www.dmlp.org/legal-guide/insurance-exclusions-business-pursuits)
- [Duty to defend in the CGL policy (IRMI)](https://www.irmi.com/articles/expert-commentary/duty-to-defend-in-the-cgl-policy)
