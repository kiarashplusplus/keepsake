# Research pass on the eight open legal questions (issue #34)

**Not legal advice, and this does not close issue #34.** That issue asks for answers from a lawyer.
This document is what a second research pass — web search against regulator guidance, statutes, and
law-firm commentary, September 2026 — can and cannot settle on its own. It exists so that whoever
does eventually pay for counsel pays for the three questions that actually need counsel, rather
than for eight.

**Method and its limits.** Direct page fetches were blocked by the network egress policy in the
environment this was written in, so every finding below rests on search-result summaries of primary
sources rather than on the primary text read end to end. Statutory quotes are reproduced as the
search layer returned them. Where that matters — where a conclusion turns on exact statutory
wording I could not read directly — it is marked **[unverified text]**. Treat those as leads, not
findings.

**What changed since `legal-considerations.md` was written.** The UK is now geo-blocked at the edge
(`apps/api/src/middleware/ukBlock.ts`, HTTP 451; `GB` removed from `@keepsake/contracts/geo`'s
`COUNTRIES`) — see [`runbooks/uk-block.md`](runbooks/uk-block.md). Three of the eight questions
(1, 4, 6) are UK-law questions, and the block moots all three as live obligations. They are answered
below anyway, because the block is reversible and the answers are what the reversal decision needs.

---

## Summary

| # | Question | Answer | Still needs a lawyer? |
|---|---|---|---|
| 1 | UK GDPR Art. 27 representative | **Not required while the UK block holds** — Art. 27 rides on Art. 3(2), and a geo-block is affirmative evidence of not targeting | No, while blocked |
| 2 | PIPEDA "commercial activity" with ads live | **Assume it applies.** Free-to-users is not the test; ad revenue is commercial character | No — but it creates real work |
| 3 | Rhode Island "commercial website" / Montana minors | RI: comply, don't litigate the definition. MT: duty is knowledge-triggered, and the 18+ attestation largely answers it | No |
| 4 | AADC 18+ gate sufficiency | Moot while blocked. On the merits: a bare declaration is the configuration ICO guidance most clearly rejects — the fix is a written rationale, not better verification | No |
| 5 | FTC 2025 COPPA "mixed audience" | **Doesn't reach Keepsake** — mixed-audience presupposes child-directed, which Keepsake is not. General-audience actual-knowledge standard applies | No |
| 6 | Ofcom record-keeping exemption | Moot while blocked. The exemption *power* exists (s.23(7)); **no published exemption for small providers was found** | No |
| 7 | CPSA "distribute in commerce", platform vs. individual | Different, but Keepsake sits on the safe side — the CPSC/Amazon line is possession and sale control, neither of which Keepsake has | Optional |
| 8 | Mutual indemnification under Texas law | Enforceability is **entity-neutral**; what entity form changes is who pays when it fails. The real question is LLC vs. sole proprietor | **Yes — highest value item here** |

Three questions (1, 4, 6) are moot under the UK block. Two (5, 6) resolve on definitions and
published guidance. Two (2, 3) resolve into "do the cheap compliance work instead of buying an
answer." One (8) contains a genuinely consequential decision that has nothing to do with the clause
it asks about.

---

## Q1 — UK GDPR Article 27 representative

**Answer: not required while the UK block holds, and the "occasional processing" debate never gets
reached.**

Article 27 attaches only where Article 3(2) does — offering goods or services to, or monitoring the
behaviour of, people in the UK. Recital 23 and the EDPB's territorial-scope guidance make this an
*intention* test read off objective evidence: naming a country, currency, language, delivery
destinations, paid search targeting. The recital is explicit that mere accessibility of a website
from a territory, or use of a language common to the operator's own country, is **not** sufficient
evidence of intent to offer services there.

A hard edge block that returns 451 to UK IPs, plus `GB` removed from the accepted country list, is
affirmative evidence pointing the other way — it is close to the strongest fact available short of
never having launched. So the analysis stops at Art. 3(2); the three-part narrow exemption in
Art. 27(2) (occasional / no large-scale special-category data / low risk), which
`legal-considerations.md` correctly flagged as a close call, is not reached at all.

**What this leaves open:**

- **Pre-block data.** Any UK personal data collected before the block still needs lawful handling
  and, in principle, still sits under UK GDPR. Worth confirming that no GB listings or UK-resident
  emails exist in production — they should not, since the product has never been publicly launched,
  but "should not" is not "checked."
- **The block has to actually hold.** It reads off Cloudflare's `request.cf.country`, which a client
  cannot spoof, and `apps/api/test/ukBlock.test.ts` covers it. A leaky block reopens the question.
- **If the block is ever lifted**, the question returns exactly as originally written, and the
  guidance in this area does lean toward "when in doubt, appoint."

**Cost, since the question asked.** UK Article 27 representative services run roughly **£950–£1,500
per year** at the mainstream end, with budget providers around €490/year and subscription options
near £99/month. Call it $600–$2,000/year. For a zero-revenue project that is a real number, and is
itself an argument for keeping the block until there is a reason not to.

## Q2 — PIPEDA's "commercial activity" gate once ads are live

**Answer: "free to users" does not keep Keepsake out of PIPEDA, and turning on Google Ads makes
that materially harder to argue. Assume PIPEDA applies.**

PIPEDA's trigger is collection, use, or disclosure of personal information "in the course of
commercial activity," which the Act defines as any transaction, act, or conduct — or regular course
of conduct — **of a commercial character**. There is no revenue threshold and no employee-count
exemption. The OPC has repeatedly found organizations in scope despite non-profit or free-to-user
status: a non-profit membership organization was found to engage in transactions of a commercial
character, and a non-profit daycare partially subsidized by a municipality was likewise found to be
engaged in commercial activity.

The closest analogue is **Globe24h** (PIPEDA Report of Findings #2015-002; upheld in
*A.T. v. Globe24h.com*, 2017 FC 114). A site that was free to read was held commercial because it
carried advertisements, actively solicited advertising, and monetized the personal information it
held. Keepsake now shares the first of those and, through the ad tag, the third in a weaker form.
The doc's original hedge — "adding Google Ads arguably tips a previously-arguable 'not commercial'
service toward commercial" — should be firmed up to: it tips it, and the safe planning assumption is
that PIPEDA applies today.

Canada is still served (the block covers `GB`/`JE`/`GG`/`IM` only), so unlike Q1 this is live.

**What that actually costs.** PIPEDA is principles-based and the burden is modest — most of it is
already met by the existing privacy page. Gaps against the ten fair-information principles as the
page reads today:

- **Accountability (Principle 1)** — PIPEDA expects a designated individual accountable for
  compliance. This is the same gap as issue #26, which the UK block otherwise made look optional.
  It is not optional under PIPEDA. **This is the main reason #26 should still be finished.**
- **Individual access (Principle 9)** — access and portability are not named as rights on the
  privacy page today (deletion is described; access is not).
- **Limiting retention (Principle 5)** — retention criteria are stated for photos only.
- **Breach reporting** — PIPEDA requires reporting breaches of security safeguards posing a "real
  risk of significant harm" to the OPC and to affected individuals, and keeping records of all
  breaches. `docs/runbooks/incident.md` has no step for this. **[unverified text]** — the
  record-keeping duration and report form specifics were not read directly.

## Q3 — Rhode Island and Montana

### Rhode Island

RIDTPPA §6-48.1-3(a) took effect **1 January 2026** — it is in force now, not pending. It requires
"any commercial website or internet service provider conducting business in Rhode Island or with
customers in Rhode Island or otherwise subject to Rhode Island jurisdiction" to disclose, in a
designated section of its policy: the categories of personal information collected, the third
parties to whom that information is or may be sold, and to designate a controller. The volume
thresholds (35,000 consumers, or 10,000 plus 20% of revenue from data sales) gate the *rest* of the
chapter, not this subsection. §6-48.1-3(d) exempts state and municipal bodies — irrelevant here.

The act **does not define "commercial website"**, which is precisely why the original research
called this unsettled. It still is; no case or AG guidance resolving it turned up.

**The recommendation is to stop trying to answer it.** The obligation is a disclosure, not a
registration, a fee, or an architectural change. Adding two lines to the privacy page — the
categories collected (already largely there) and "we do not sell personal information to third
parties" — plus naming the controller satisfies §6-48.1-3(a) under either reading of "commercial."
That is under an hour of HTML. Buying a lawyer's opinion on whether a zero-revenue ad-supported
hobby site is "commercial" costs more than compliance and produces a hedged answer. Comply and move
on.

Note the overlap: the controller-designation half is, again, issue #26.

### Montana

The original doc's unresolved question was whether the duty of care "attaches based on incidental
Montana visitors to a US-wide site, or only to services that target minors specifically." The
answer is **neither, exactly** — it separates into applicability and trigger, and the trigger is the
part that matters.

- **Applicability**: the minors provisions apply to controllers that conduct business in Montana or
  deliver commercial products or services intentionally targeted to Montana residents, and —
  importantly — they apply **without** the volume thresholds that gate the rest of the MTCDPA. So
  the applicability half is real for a US-wide site.
- **Trigger**: §30-14-2811 imposes the duty of care as to a consumer "whom the controller **actually
  knows or willfully disregards** is a minor." It is a knowledge standard, not a targeting standard
  and not a strict one. The duty is to use reasonable care to avoid a heightened risk of harm —
  defined by reference to reasonably foreseeable risk of unfair or deceptive treatment; financial,
  physical, or reputational injury; unauthorized disclosure via a breach; or offensive intrusion
  upon a minor's solitude or private affairs. **[unverified text]** — the statutory text was read
  through search summaries, not fetched; the "rebuttable presumption" in the section heading was
  not resolved and may provide an age-determination safe harbour worth checking.

Keepsake's existing 18+ attestation (`AgeAttestationSchema` / `MINIMUM_AGE`, recorded server-side as
`age_attested_at`, required on both create-listing and create-request) already does most of the
work here: it means there is no actual knowledge of minors, and a recorded attestation is reasonable
evidence against "willful disregard."

Three concrete gaps, none of them large:

1. **Write down the takedown rule.** "Actual knowledge that a user is under 18 → remove the listing
   and ban the device token" currently exists as an implication of the age gate, not as a moderation
   policy anyone could point to. Willful disregard is exactly the failure mode of having the signal
   and not acting on it. This belongs in the moderation runbook.
2. **Targeted advertising.** Montana requires consent for targeted advertising, data sale, or
   profiling of minors. Not currently implicated — the Google Ads integration is contextual, not
   keyed to a known user — but it is a constraint on any future ad-targeting change.
3. **Geolocation.** Montana restricts processing a minor's precise geolocation without necessity and
   a visible signal during collection. Keepsake stores postcode plus lat/lng; worth confirming the
   lat/lng is a postcode centroid (coarse) rather than device-precise. If it is a centroid, this is
   a non-issue and worth a line in the privacy page saying so.

## Q4 — AADC and the 18+ self-declared gate

**Answer: moot while the UK is blocked. On the merits, the configuration the question describes —
a declaration with nothing documented behind it — is the one ICO guidance most clearly rejects, and
the fix is the written rationale, not stronger verification.**

The Children's Code applies to information society services "likely to be accessed by children" in
the UK. No UK users, no code — the same structural answer as Q1.

If the block is ever lifted, ICO guidance is reasonably clear and the answer is cheaper than the
question suggests:

- Where a provider concludes children are **not** likely to access the service, the provider should
  **document that decision and provide evidence**. The ICO's own examples of acceptable evidence are
  market research, current evidence on user behaviour, the user base of similar or existing services
  and service types, and testing of access-restriction measures.
- The ICO expects that record to be **kept under review** — the assessment is ongoing, not one-time.
- A service that **fails to carry out the assessment at all** will be treated as likely to be
  accessed by children. Doing nothing is the worst available option; it forfeits the argument rather
  than deferring it.
- Where an age-gating mechanism is **effective** at preventing under-18 access, the code does not
  apply. "Effective" is carrying the weight in that sentence, and a self-declaration checkbox is not
  effective in the age-assurance sense the ICO uses elsewhere.

So the direct answer to the question as posed: the declaration alone is not sufficient, but the gap
is documentary, not technical. Two or three pages honestly reasoning "this service is not appealing
to under-18s because [subject matter, 18+ terms, in-person adult handoff, no child-oriented design],
here is what our user base looks like, here is the gate we run, reviewed [date]" is what the ICO is
asking for. That is an afternoon, not an age-verification vendor.

## Q5 — FTC 2025 COPPA amendments and "mixed audience"

**Answer: the mixed-audience rules do not reach Keepsake. It is a general-audience service, and the
one-time self-declared gate requires nothing further under COPPA.**

This question dissolves on a definition. Under the amended rule, a **"mixed audience"** service is
one that **is "directed to children"** under COPPA's multi-factor test but does not have children as
its *primary* audience. Mixed audience is a subset of child-directed — not a middle category that
any all-ages service falls into.

The "directed to children" test weighs subject matter, visual and audio content, use of child models
or child celebrities, child-oriented activities and incentives, advertising directed to children,
and competent evidence about actual audience composition. Keepsake — sentimental second-hand
objects, free-text personal stories, an in-person adult handoff, 18+ terms, no child-oriented design
— does not meet any factor. It is a **general audience** service.

Consequences:

- General-audience services are **not required to run an age screen at all** under COPPA. The
  obligation is the actual-knowledge standard: if the operator learns a specific user is under 13,
  COPPA attaches to that user's data and it must not be collected (or must be deleted).
- The amendments' tightened mechanics — neutral age screening before collecting personal
  information from mixed-audience users — attach to mixed-audience services. They do not create a
  new obligation for Keepsake.
- The April 22, 2026 compliance deadline has passed, but nothing on the other side of it applies
  here.

**One drafting note worth taking anyway.** The amended rule requires that where age information *is*
collected, it be collected "in a neutral manner that does not default to a set age or encourage
visitors to falsify age information." An "I am 18 or over" checkbox arguably fails neutrality — it
states the answer that grants access. That rule is aimed at mixed-audience screens, so it is not
binding here. But the gate is being asked to do evidentiary work in *other* regimes (Montana's
willful-disregard standard, the AADC rationale above), and a neutral date-of-birth entry is
meaningfully better evidence than a checkbox whose only possible answer is "yes." Cheap to change if
the give flow is being touched anyway.

## Q6 — Ofcom record-keeping exemption for small providers

**Answer: moot while the UK is blocked. On the underlying question, the exemption power is real but
no published exemption covering providers of this size was found — the original "unverified" should
be upgraded to "probably does not exist."**

Online Safety Act 2023 **s.23** sets the record-keeping duties: a written record, in an easily
understandable form, of every aspect of every risk assessment including how it was carried out and
what it found; and a written record of measures taken or in use to comply with a relevant duty that
are described and recommended in a code of practice. **s.23(7)** lets Ofcom provide that particular
*descriptions* of providers of user-to-user services are exempt from any or all of those duties, and
requires Ofcom to publish details of any exemption, and reasons for revoking one.

Searches surfaced the power, Ofcom's dedicated "helping small services navigate the Online Safety
Act" support material, and an active **enforcement programme monitoring compliance with the
illegal-content risk assessment and record-keeping duties** — but **no exemption instrument covering
small or micro providers**. Ofcom's published posture toward small services is *proportionality*
rather than exemption: what a small, low-risk service must record scales down, but the duty itself
does not switch off.

That is a negative established from search summaries rather than from Ofcom's own exemptions
listing, which the egress policy blocked. It is strong enough to plan around and not strong enough
to be certain. If the UK is ever re-enabled, this is a ten-minute check of Ofcom's published
exemptions page — not a question worth a lawyer's hourly rate.

## Q7 — CPSA "distribute in commerce": platform vs. individual giver

**Answer: yes, platform status carries different risk than an individual giver's — but the line the
CPSC has actually drawn is possession and control of the sale, and Keepsake has neither. Screening
is not what put Amazon on the wrong side of it.**

The statutory definition, 15 U.S.C. §2052(a)(7): "distribute in commerce" means **to sell in
commerce, to introduce or deliver for introduction into commerce, or to hold for sale or
distribution after introduction into commerce.** All three prongs run through *commerce* and two
through *sale*.

The controlling recent data point is the CPSC's **Decision and Order of July 29, 2024**, which
unanimously found Amazon a "distributor" under the CPSA as to roughly 400,000 hazardous items sold
by third-party sellers through Fulfilled by Amazon, and ordered it to run the recalls. The
Commission's stated basis: Amazon **warehoused** third-party goods for subsequent delivery, and
controlled all facets of the sale — screening products for the program, formatting sales
information, communicating with customers about returns and exchanges, and pricing. A final order
on remediation followed in 2025.

Mapping Keepsake onto those factors:

| CPSC's Amazon factor | Keepsake |
|---|---|
| Warehoused the goods | Never takes possession; handoff is person-to-person |
| Delivered / fulfilled | No shipping, no fulfilment |
| Controlled pricing | There is no price |
| Handled returns and exchanges | No returns path; the transfer is final and in person |
| Screened products for the program | **Yes** — AI moderation plus a human queue |

Keepsake shares exactly one factor, and it was not the one the Commission leaned on. Screening
appeared in the Amazon analysis as evidence of *control over the sale*, alongside pricing, returns,
and fulfilment — not as an independent hook. Add that a free one-to-one gift is a poor fit for all
three statutory prongs, none of which describes a platform that never touches the object and never
participates in a sale, and Keepsake's facts sit well clear of the line as currently drawn.

**What this does not resolve.** Nothing forecloses an argument that hosting, screening, and
facilitating amounts to "delivering for introduction into commerce." It is untested for this fact
pattern, as the original research said. The Amazon decision raises the ceiling on platform exposure
generally even though its reasoning does not reach here.

**And the drafting rule in `legal-considerations.md` stands regardless.** CPSC's Resellers Guide
asserts in writing that its rules reach individuals holding yard sales and that people who give away
used products for free cannot donate products that fail to meet the law. That remains a citable,
honest basis for the platform-level prohibited-items bans, whatever the answer to the legal question
turns out to be — and it is why the terms should keep distinguishing statute-backed rows from
hazard-only rows.

**The exposure that actually matters is not CPSC.** CPSC enforcement targets recalls at scale; it is
not going to open a docket on a solo operator. The realistic bad day is a private tort claim after
someone is injured by a given-away crib or car seat. That is an insurance-and-entity question, which
is Q8.

## Q8 — Mutual indemnification, Texas, individual vs. LLC

The question bundles two things. Separating them changes the answer.

### (a) Should the terms carry an indemnification clause?

Yes. It is standard for this product shape, Olio runs one, and it costs nothing to add. But be
clear-eyed about what it buys: an indemnity from an arbitrary user is worth whatever that user can
pay, which is usually nothing. Its practical value is deterrence and settlement posture, not
recovery.

One correction to the framing in issue #34 and #32, both of which say "mutual." **Olio's clause is
one-directional** — the giver indemnifies Olio. A genuinely mutual clause, in which Keepsake also
indemnifies users, *adds* exposure and is not the model being cited. If the intent is to be fair
between the two people meeting, the clause that actually fits is user-to-user: each party
indemnifies the other for claims arising from their own conduct at the meetup, with Keepsake
separately indemnified by both. Decide which of those three shapes is wanted before drafting.

### (b) Does Texas treat it differently for an individual operator than an LLC?

**No. Enforceability is entity-neutral.** What Texas cares about is drafting, through the two-part
**fair notice** doctrine, and both parts apply identically whether the indemnitee is Kiarash
personally or Keepsake LLC:

1. **Express negligence.** An indemnity does not cover the indemnitee's *own* negligence unless it
   says so, specifically, within the four corners of the agreement. A generic "you will indemnify us
   from all claims" does **not** reach Keepsake's own negligence — which is the scenario the clause
   is most wanted for.
2. **Conspicuousness.** The provision cannot be buried in body text. It needs capitalization, bold,
   a heading, or larger type — something that makes it stand out visually. A clause failing this is
   unenforceable absent the other party's actual knowledge of it.

Texas courts developed both in commercial and construction contexts, and treat indemnifying a party
for its own negligence as an extraordinary shifting of risk requiring unmistakable notice. A clause
dropped into `terms.html` in the same 14px paragraph style as everything around it is the exact
pattern that fails the second prong.

### (c) The decision actually hiding inside this question

Entity form does not change whether the clause is enforceable. It changes **who pays when the clause
fails** — and against an injured stranger who never meaningfully assented to anything, it will
sometimes fail.

A sole proprietorship is not a separate legal person: the business and the owner are the same, and a
judgment reaches personal assets. An LLC puts a layer between a claim arising from a user meetup and
Kiarash's own bank account. Today, `terms.html` names Texas as governing law with an individual
operator behind it, which means every disclaimer and limitation on that page is currently protecting
a person rather than an entity.

**So the priority ordering is the inverse of how the question is posed.** Forming an LLC — or
pricing general-liability insurance, or both — is the substantive risk decision. The indemnification
clause is the cheap belt to that suspenders, and drafting it well matters less than having something
between a bad outcome and personal assets. This is the one item in the whole list where an hour of
professional time is clearly worth buying, and it is a conversation with a Texas business lawyer or
accountant, not the privacy-and-platform specialist the other seven questions imply.

---

## Where this leaves issue #34

| Question | Disposition |
|---|---|
| Q1 UK Art. 27 | Answered — moot under the block; revisit only before lifting it |
| Q2 PIPEDA | Answered — assume in scope; do the accountability/access/breach-reporting work |
| Q3 RI / MT | Answered — comply cheaply rather than resolve the definition; write down the minor-takedown rule |
| Q4 AADC | Answered — moot under the block; the fix is a documented rationale |
| Q5 COPPA | Answered — general audience, no further obligation |
| Q6 OSA record-keeping | Answered — moot under the block; no small-provider exemption found |
| Q7 CPSA | Answered on the facts — untested in the abstract, favourable here |
| Q8 Indemnity / entity | **Not answered — and it is the one worth paying for.** The clause question is answered (entity-neutral, fair-notice drafting); the LLC-vs-sole-proprietor question underneath it is a real decision |

Follow-on work this suggests, none of it currently tracked:

- Finish #26 (name a controller / accountable individual) — PIPEDA Principle 1 and RI §6-48.1-3(a)
  both want it, independently of the UK block that made it look optional.
- Add PIPEDA breach reporting to `docs/runbooks/incident.md`.
- Name access and portability as rights on the privacy page; state retention criteria beyond photos.
- Write the "actual knowledge a user is under 18" takedown rule into the moderation runbook.
- Confirm stored lat/lng is a postcode centroid, and say so on the privacy page.
- Decide the shape of the indemnity clause (Keepsake-only, mutual, or user-to-user) before #32
  drafts it.

---

## Status note, 2026-09-07 — where #34 and this document's follow-ons ended up

Appended rather than folded into the analysis above, so this stays a record of what was found and
when.

**#34 is closed and no lawyer answered any of it.** This document, the PR that shipped it (#58) and
the comment posted on the issue all say explicitly that it does not close #34 and that the
checkboxes stay unticked. All eight are still unticked in the issue body. The issue was closed as
"completed" a second after #58 merged, and GitHub records it as closed by that PR. The disposition
table above is a research disposition, not a set of answers from counsel — nothing in the closure
changes that, and the method limit in this document's opening note still applies to every row.

**Q8 now has its own issue: #108** — "Decide LLC vs. sole proprietor, and price general-liability
insurance." The clause half of Q8 is finished (#63 picked the one-directional shape; ea2329e added
it to `terms.html` and closed #32), so #108 is scoped to the substantive half only. Two facts that
have landed since this document was written sharpen it: `privacy.html`'s "Who runs this" section now
names Kiarash personally as controller, "not through a company or any other entity," and
`terms.html` carries a comment beside the indemnity clause recording the individual-vs-LLC question
as unresolved. The site does not merely operate as a sole proprietorship — it says so publicly,
which is the fact pattern §Q8(c) above identifies as making the entity decision the substantive one.

**The follow-on list above is no longer untracked** — all six were filed and are closed: #26
(controller), #59 (PIPEDA breach reporting), #60 (privacy-page rights/retention/RI disclosure), #61
(under-18 takedown rule), #62 (postcode centroid), #63 (clause shape). #31 remains open and advisory
for the Montana/Rhode Island applicability question Q3 could not settle, and the three UK questions
(Q1, Q4, Q6) are carried on `runbooks/uk-reentry-checklist.md` §§4–6 rather than here, so that
lifting the block cannot quietly skip them.
