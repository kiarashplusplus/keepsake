# Research pass on the actions that still look outstanding (2026-09-08)

**Not legal advice, and no lawyer was consulted.** This is a web-research pass over the four things
that still look like they need doing after the 2026-09-08 pass over `privacy.html` and `terms.html`
(recorded in [`legal-considerations.md`](legal-considerations.md)'s status block of that date). It
exists for the same reason [`legal-open-questions-research.md`](legal-open-questions-research.md)
does: so that whoever eventually buys an hour of professional time spends it on the parts that
actually need it.

**Method limit, and it is the same one every legal document in this repo carries.** Direct page
fetches are refused by this environment's egress proxy — `copyright.gov` was tried first and
blocked, exactly as `statutes.capitol.texas.gov` and `law.justia.com` were during #108. So every
statutory and regulatory claim below rests on **search-result summaries** of primary sources, not on
the primary text read end to end. Claims that matter carry **[summary-sourced]**. Two of the numbers
here are the kind a person will act on directly — a filing fee, a registration fee — and both should
be confirmed on the agency's own page before anybody writes a cheque.

---

## Summary

| # | Action | Status | Who can do it |
|---|---|---|---|
| 1 | Content terms: a licence grant, an ownership representation, a copyright-complaint route | **Not started.** Largest gap. Nothing in `terms.html` covers what the product does with uploaded photos | Drafting: an afternoon. The DMCA registration half is a filing |
| 2 | Limitation of liability and a forum clause | **Not started.** The disclaimer carries this alone today | Drafting, and a decision about how far to go |
| 3 | Section 230 posture | **Nothing to do, and worth knowing why** — it is the single largest thing standing between this product and the claim #108 identifies, and it appears nowhere in this repo | Reading only |
| 4 | #142 — bind cover, file the DBA | **Open, unchanged, and now cheaper to act on**: the fee is known, the address problem has an answer, and the insurance ask has a better name | Kiarash, off the computer |

**One errand unblocks three of these.** A commercial mail-receiving street address — not a P.O.
box — serves the assumed-name certificate, the DMCA agent registration, and an insurance
application, and keeps the home address off all three public records. See
[§5](#5-the-errand-that-unblocks-three-things).

---

## 1. Content terms — the licence, the representation, and the copyright route

### What is missing

`terms.html` has no content terms of any kind. People upload photographs and write stories;
Keepsake stores them, derives a thumbnail, publishes them in a feed, renders them into OG and share
cards, lists them in a sitemap and in schema.org structured data, and embeds their text for
semantic search. Nothing on the page grants permission for any of that, and nothing asks the
uploader to represent that the photograph is theirs to post — "You have to own it" is about the
*object*, not the picture of it.

There is also no copyright-complaint route. `REPORT_REASONS`
(`packages/contracts/src/report.ts`) is `illegal` / `not_a_keepsake` / `spam` / `harassment` /
`personal_info` / `other`, so a rights holder's only paths are "other" and the inbox, neither of
which is signposted as the place to send an infringement notice.

### What the DMCA safe harbour would actually require

Section 512(c)'s safe harbour is **opt-in and conditional**, not automatic. Three things carry the
weight:

- **A designated agent registered with the Copyright Office.** The fee is **$6** per designation,
  amendment or resubmission. A designation **expires three years after registration** unless it is
  renewed by amending or resubmitting it — and each renewal starts a fresh three years. There is no
  separate renewal fee; the $6 resubmission *is* the renewal. **Any lapse in registration is a lapse
  in safe-harbour protection for that period**, which makes this a recurring calendar obligation,
  not a one-time filing. **[summary-sourced]**
- **A repeat-infringer policy under §512(i)**: adopt one, allow termination of repeat infringers in
  appropriate circumstances, and **inform users of it**. The bar as courts have applied it is not
  perfection — *Ventura Content v. Motherless* is cited for the policy needing to work a reasonable
  amount of the time — and the details need not be written down, but users do have to be told the
  policy exists. Where a policy exists only on paper, courts have denied safe harbour for the period
  it was unenforced and left the platform exposed to secondary liability. **[summary-sourced]**
- **Expeditious removal on notice**, which Keepsake already does operationally — every listing is
  screened, anyone can report, and `POST /admin/owners/:id/ban` and
  `POST /api/admin/requests/:id/remove` are real.

The repeat-infringer half is close to free here: the product already bans device tokens and hides
listings, so the policy is a paragraph describing what the admin runbook already does. The agent
registration is the part with an ongoing cost and a trap in it.

### The trap: registering an agent publishes a street address

This collides directly with the decision in
[`legal-entity-and-insurance.md`](legal-entity-and-insurance.md)'s "Where the address goes", which
deliberately keeps the operator's home address off any page a banned user can read.

Registering a designated agent requires the service provider's **full legal name and physical street
address — not a post office box** — and **those are the fields visible to the public** in the
Copyright Office's directory. A P.O. box requires a waiver granted only in exceptional
circumstances, specifically a demonstrable threat to personal safety such that publishing a street
address would be dangerous. **[summary-sourced]**

**There is a documented way through it that needs no waiver.** Where the service provider is a
natural person operating the service from a private residence, the street address of a **mail
forwarding service** qualifies as the "physical street address of the service provider", and may be
used in place of the home address without applying for a waiver. **[summary-sourced, and this is
the load-bearing claim in this section — confirm it against the Copyright Office's own FAQ before
relying on it.]**

### What this adds up to

The licence grant, the ownership representation and a named copyright-complaint route are **cheap
and unconditional** — they are what makes the product's own behaviour authorised, and none of them
depends on the safe harbour. They should not wait on the registration decision.

The registration is a separate, smaller decision with a recurring obligation attached: $6 every
three years, a diary entry that must not be missed, and a public street address that has to be a
mail-forwarding one. Its value is a defence against a copyright claim that has not happened, in a
product where every photograph is of the uploader's own possession, so the realistic infringement
risk is low — but it is not zero (a story quoting a poem, a photo of a photo, a listing of a print),
and **Section 230 does not help here at all**: the statute's own carve-out excludes intellectual
property claims from its protection, which is what makes this the one content-liability area §3
below does not cover.

---

## 2. Limitation of liability, releases, and where a dispute is heard

`terms.html` today has a warranty disclaimer, the one-way indemnity (#63), and a Texas governing-law
line. It has no cap on damages, no release, and nothing about where a dispute is heard.

The good news is that **the drafting standard is the one already met once on this page.** Texas's
two-part fair-notice doctrine reaches a limitation of liability and a pre-injury release the same
way it reaches an indemnity:

- **Express negligence** — the intention to be relieved of the consequences of one's own negligence
  must be stated clearly and unequivocally within the four corners of the contract. A generic "you
  will not hold us liable for any claims" does not reach Keepsake's own negligence, which is the
  scenario the clause is most wanted for. **[summary-sourced]**
- **Conspicuousness** — borrowing the UCC standard: a heading in capitals equal to or larger than
  surrounding text, or contrasting type, font or colour; body language in larger type, contrasting
  type/font/colour, or set off by symbols or marks. In practice: capitals, bold, a separately
  captioned section, or contrasting colour. **[summary-sourced]**

The `.indemnity` treatment already in `terms.html` — a captioned section, a bordered box, bold body
text, and a sentence naming Keepsake's own negligence specifically — is exactly this pattern, and is
the thing to copy rather than re-derive.

**Three limits worth knowing before drafting:**

1. **Gross negligence and intentional misconduct cannot be waived.** Texas courts consistently
   refuse to enforce a release of those, and — the part that matters for drafting —
   **overbroad language can taint the enforceability of the ordinary-negligence release along with
   it**. A clause that reaches for everything can end up reaching for nothing. **[summary-sourced]**
2. **Consumer and adhesion contracts get greater scrutiny** than the commercial and construction
   contracts most of this doctrine was developed in. `terms.html` is an adhesion contract offered to
   consumers, so the margin for a clause that is merely arguable is thinner here than the case law's
   usual setting. **[summary-sourced]**
3. Nothing found addressed how these requirements apply to **online** terms of use specifically —
   whether browsewrap/clickwrap assent changes the conspicuousness analysis. That is a genuine gap
   in what search could settle, and it is the question a lawyer would answer quickly.

**A note on what a cap is worth here.** The realistic bad day in this product is a personal-injury
claim by someone who met a stranger through it. That claimant is not a party to the terms in any way
they would concede, the release cannot reach gross negligence, and the indemnity is worth what the
other user can pay. So the honest ranking is the one #108 already reached: **insurance is the
protection and the clause is the belt to its suspenders**. That is an argument for drafting it
carefully rather than for drafting it broadly — and for not letting a new clause become a reason to
feel covered.

---

## 3. Section 230 — nothing to do, and the reason is worth writing down

**This is the largest thing standing between Keepsake and the claim #108 identifies as the realistic
bad day, and it is mentioned nowhere in this repo.** Recording it because a future reader deciding
how much to spend on §2 above should know it exists.

- **The closest case on the facts is _Doe v. Grindr_ (9th Cir., February 2025).** A 15-year-old who
  told the app he was over 18 was matched with adults, met four of them in person, and was raped;
  three were prosecuted. He sued for defective design, negligence and under the TVPRA. The Ninth
  Circuit held §230 barred the state-law claims because they necessarily implicated Grindr's role as
  a publisher of third-party content, following *Dyroff v. Ultimate Software* — features, functions
  and algorithms that analyse user content and recommend connections are "tools meant to facilitate
  the communication and content of others". **Enabling users to communicate does not make the
  platform answerable for what they do offline.** **[summary-sourced]**
- **Texas sits in the Fifth Circuit, which reads §230 more narrowly**, and that is the reading that
  would govern a suit here. It has said §230 "does not provide a general immunity against all claims
  derived from third-party content", and that providers "may be held liable for speech or conduct
  that is properly attributable to them, even if third-party speech exists somewhere upstream" —
  distinguishing liability reliant on the harm done by third-party content (preempted) from
  liability based on the provider's own conduct (not). *A.B. v. Salesforce.com* (5th Cir. 2024) is
  the shape of the exception: knowing participation in illegality is not protected.
  **[summary-sourced]**
- **The Fifth Circuit is not hostile to the immunity as such**: in July 2026 it held 2–1 that §230
  preempts Texas's own mandate that platforms screen and remove content from minors' feeds.
  **[summary-sourced]**

**Where that leaves Keepsake, and the one place it is worth being careful.** Screening listings does
not forfeit §230 — that is what the Good Samaritan provision exists for, and in the Amazon/CPSA
analysis in [`legal-open-questions-research.md`](legal-open-questions-research.md) screening was
likewise not the factor that mattered. The fact pattern that *does* attract the Fifth Circuit's
narrower line is content "properly attributable to" the provider.

That is worth naming precisely, because there is exactly one place where Keepsake authors listing
content rather than hosting it: **`apps/api/src/suggest/suggest.ts` reads the uploaded photo and
produces the title, the category and the tags, and those are saved to the listing.** The category in
particular has no picker in the give flow, so the model's answer is the one stored unless someone
writes in asking for it to be changed. `privacy.html`'s "Autofill from your photo" section already
discloses this accurately, and the give flow lets a giver type over the title. This is not a reason
to change the feature — it is a reason to keep the human's edit path real and visible, and to be
able to say the giver chose what was published. Whether an AI-suggested field a user accepted is
"the provider's own content" is not something search can settle, and it is a better use of a
lawyer's five minutes than most of what is on the open-questions list.

---

## 4. #142 — the two errands, now with numbers

[`legal-entity-and-insurance.md`](legal-entity-and-insurance.md) left three things marked unverified
that this pass can put numbers or names to. The decision itself is unchanged.

### The assumed-name certificate

- **Fee: $15.00 for the first owner, plus $0.50 for each additional owner** if the form is already
  notarized; **plus $1.00 witnessing fee per owner** if it is not. One owner, notarized: **$15.00**;
  signed in front of a deputy clerk instead: **$16.00**. **[summary-sourced]** This replaces the
  document's "tens of dollars, not hundreds. **[unverified figure]**", which was the right order of
  magnitude.
- **Where:** the Harris County Clerk files unincorporated assumed names, at **ten walk-in
  locations**, Monday–Friday, 8:00–16:30. Term is **ten years**, and it must be re-registered before
  the term ends to avoid a lapse — a second diary entry, alongside the DMCA one if that is done.
  **[summary-sourced]**
- **The address question is answered, provisionally.** The document flagged "whether a mailbox or
  other business address may be used instead of the residence" as **[unverified]**. A Texas DBA
  requires a **physical street address, not a P.O. box**, and a commercial mail-receiving agency
  (CMRA) that provides a real street address can satisfy that where there is an agreement with the
  provider. **[summary-sourced — and this is a question a deputy clerk will answer in one sentence
  at the counter, which is worth more than this paragraph.]**

### The insurance ask, sharpened

`legal-entity-and-insurance.md`'s question 2 tells the broker to say **which** of CGL or tech E&O
responds to "a user was hurt meeting another user we introduced". The research suggests the honest
answer is **neither, cleanly**, and that asking it that way invites a policy that looks like cover
and is not:

- **Tech E&O generally excludes bodily injury outright** — the standard exclusion language reaches
  "any actual or alleged bodily injury, sickness, humiliation, mental anguish, emotional distress,
  assault, battery, disease, death..." Tech E&O is for financial harm, not physical harm.
  **[summary-sourced]**
- **CGL covers third-party bodily injury**, which is the right trigger — but the two exclusions
  the document already names as must-reads are exactly the ones that bite here: a
  **professional-services exclusion** for a claim that the *screening* was inadequate, and an
  **assault-and-battery exclusion**, which is present often enough that "even when bodily injury
  exists, an assault exclusion may still bar coverage". **[summary-sourced]**
- **The category that names this exposure has a name: marketplace "trust and safety" cover**,
  whether as a specialist policy or as an endorsement onto a CGL/media tower. The described scope is
  strikingly close to this fact pattern: claims arising from user interactions facilitated by the
  platform, including **negligent screening or vetting**, failure to moderate, inadequate identity
  verification, and liability where a transaction leads to injury. The recurring caveat in the same
  material is that **standard policies exclude these without a marketplace-specific endorsement**.
  **[summary-sourced]**

**So the ask changes from a question to a requirement:** ask for CGL **with affirmative
trust-and-safety wording**, or a marketplace endorsement, and read the professional-services and
assault-and-battery exclusions before price — a cheap policy carrying either is the "worse than no
policy" case the document already warns about. At least one insurer positions itself specifically at
marketplace platforms with affirmative trust-and-safety wording (Corgi); a mainstream broker is
still the right first call, but this gives the ask a name to use. **No quote was obtained and none
of this is an endorsement of any insurer.** The document's $300–$800/year sanity-check figure was
for plain small-business CGL and should be expected to move once trust-and-safety wording is on the
table — treat a much larger number as underwriting information rather than a mistake, which is what
the document already says.

---

## 5. The errand that unblocks three things

Three separate obligations each want a **physical street address that is not a P.O. box**, and each
of the first two publishes it:

| Needs an address | Is it public? | P.O. box allowed? |
|---|---|---|
| Harris County assumed-name certificate | Yes — a public county record | No; CMRA street address appears acceptable |
| DMCA designated-agent registration | Yes — name and street address are the public fields | No, absent a safety waiver; a mail-forwarding street address needs no waiver |
| Insurance application | No | n/a |

**One commercial mail-receiving address serves all three**, and is the only way to do §1's
registration at all without either publishing a home address or applying for a waiver on
personal-safety grounds. It also removes the last practical objection to the DBA, which is the
filing §71.201 makes the difference between being able to enforce `terms.html` and not.

If the mail address is obtained, get it **before** the DBA is filed rather than after — amending a
filed certificate is a second trip.

---

## 6. Checked, and no action follows

- **US state privacy law, 2026–27.** Nothing new reaches a zero-revenue, no-ads, US/CA-only operator
  that was not already recorded. Texas and Nebraska still exempt SBA-small businesses from the
  substantive chapters; Indiana and Kentucky took effect 1 January 2026 on the Virginia template
  with ordinary thresholds; Rhode Island's RIDTPPA took effect the same day and is already handled
  by the designated "Categories of information we collect" section (#60); Alabama follows May 2027
  and Oklahoma January 2027. The applicability gate under RIDTPPA is if anything weaker than when it
  was last assessed, since there are now demonstrably no ads. **[summary-sourced]**
- **Ofcom's small-provider exemption (open question Q6).** Still not found. The exemption *power*
  under s.23(7) is real and Ofcom must publish any exemption it grants; the published posture toward
  small services remains proportionality rather than exemption, and the 2026 activity is around the
  categorised-services register rather than any carve-out. Unchanged from
  `legal-open-questions-research.md`, and moot while the UK block holds. **[summary-sourced]**

---

## What was not done

- **No lawyer, again.** Every open question this pass touches is still open in the sense that
  matters.
- **No primary source was read.** `copyright.gov` was fetched first and refused by the egress proxy,
  so the DMCA mechanics — the $6 fee, the three-year expiry, the mail-forwarding-address allowance —
  are all search summaries of the Copyright Office's own material rather than that material. Confirm
  the mail-forwarding point in particular before acting on it; the whole shape of §1's
  recommendation rests on it.
- **Nothing was drafted.** No licence grant, no repeat-infringer paragraph, no limitation of
  liability, no forum clause. §1 and §2 describe what they would have to contain and why; the
  decision to add them is the owner's.
- **No issue was filed.** #50 tracks legal work and #142 tracks the two errands; the DMCA
  registration, if it is wanted, is a third errand with a recurring three-year renewal and belongs
  next to them rather than in this file.
- **Nothing was checked against the live site**, for the same egress reason — `keepsake.ing` is
  refused by the proxy too.

---

## Sources

All search-result summaries; no primary source was reachable from this environment.

- [DMCA Directory FAQs, U.S. Copyright Office](https://www.copyright.gov/dmca-directory/faq.html) —
  $6 fee, three-year expiry, renewal by amendment or resubmission
- [Renewing a Designation, U.S. Copyright Office tutorial](https://www.copyright.gov/onlinesp/tutorials/transcripts/renew.pdf)
- [The Time is Now: Renew DMCA-Designated Agent Registrations (Lexology)](https://www.lexology.com/library/detail.aspx?g=ecf32c38-ee5c-4161-b9cc-7a7a1bd6624b) —
  a lapse in registration is a lapse in protection
- [DMCA Designated Agent Post Office Box Waiver Request Process (Federal Register, 2020)](https://www.federalregister.gov/documents/2020/02/27/2020-03260/dmca-designated-agent-post-office-box-waiver-request-process) —
  the exceptional-circumstances standard, and the mail-forwarding-service allowance for a natural
  person operating from a residence
- [Designation of Agent To Receive Notification of Claimed Infringement (Federal Register, 2016)](https://www.federalregister.gov/documents/2016/11/01/2016-26257/designation-of-agent-to-receive-notification-of-claimed-infringement) —
  which fields are public
- [The Physical Street Address Requirement for DMCA Agent Registrations](https://www.dmcaagentservice.com/the-physical-street-address-requirement-for-dmca-agent-registrations/)
- [DMCA Repeat Infringer Policy (Jones IPL)](https://www.jonesipl.com/article/dmca-safe-harbor-weak-repeat-infringer-policies/) and
  [DMCA Safe Harbor (Copyright Alliance)](https://copyrightalliance.org/education/copyright-law-explained/the-digital-millennium-copyright-act-dmca/dmca-safe-harbor/) —
  §512(i), *Ventura Content v. Motherless*, consequences of a paper policy
- [DMCA Safe Harbor Provisions: A Legal Overview (CRS, congress.gov)](https://www.congress.gov/crs-product/IF11478)
- [The Express Negligence Doctrine (FindLaw)](https://corporate.findlaw.com/litigation-disputes/the-contract-you-thought-you-made-the-express-negligence.html)
- [Conspicuous and Clear: Making an Indemnity Clause Enforceable in Texas (The Bassett Firm)](https://www.thebassettfirm.com/blog/2024/11/conspicuous-and-clear-making-an-indemnity-clause-enforceable-in-texas/)
- [Limitation of Liability Clauses in Texas Commercial Contracts (Mundaca Law)](https://mundacalaw.com/limitation-of-liability-clauses-in-texas-commercial-contracts-a-dallas-business-law-attorneys-guide-to-what-holds-up-and-what-gets-carved-out/)
- [Pre-Injury Release Laws in Texas](https://www.thetexasattorney.com/blog/pre-injury-release-laws-texas/) and
  [Texas — The Waiver Society Project](https://www.waiversociety.org/texas) — gross negligence
  cannot be waived; overbroad language can taint the release
- [Ninth Circuit Says Section 230 Preempts "Defective Design" Claims — Doe v. Grindr (Eric Goldman)](https://blog.ericgoldman.org/archives/2025/02/ninth-circuit-says-section-230-preempts-defective-design-claims-doe-v-grindr.htm) and
  [EFF on Doe v. Grindr](https://www.eff.org/deeplinks/2025/02/ninth-circuit-correctly-rules-dating-app-isnt-liable-matching-users)
- [Section 230 in 2026: How Platform Immunity Is Changing (Dynamis LLP)](https://www.dynamisllp.com/knowledge/section-230-immunity-changes) —
  the Fifth Circuit's narrower framing; *A.B. v. Salesforce.com*
- [§ 230 Preempts Texas Mandates on Social Media Platforms (Volokh/Reason, July 2026)](https://reason.com/volokh/2026/07/27/%C2%A7-230-preempts-texas-mandates-on-social-media-platforms-fifth-circuit-holds-by-2-1-vote/)
- [Harris County Clerk — Personal Records](https://www.cclerk.hctx.net/PersonalRecords.aspx) and
  [File a DBA in Harris County (crowdspring)](https://www.crowdspring.com/dba-state-requirements/file-a-dba-in-texas/harris-county-dba/) —
  $15.00 first owner, $0.50 each additional, $1.00 witnessing if not notarized, ten locations,
  ten-year term
- [Texas CMRA & business address guidance](https://www.justanswer.com/consumer-protection-law/ss47d-want-use-texas-commercial-mail-receiving-agency.html) and
  [Form 503 instructions, Texas SOS](https://www.sos.state.tx.us/corp/instructions/503.shtml)
- [Bodily Injury Exclusions In E And O Policies (Barnes & Thornburg)](https://btlaw.com/en/insights/blogs/policyholder-protection/2019/bodily-injury-exclusions-in-e-and-o-policies) and
  [Technology E&O: What's Covered, What's Not (Jencap)](https://www.jencapgroup.com/insights/cyber-liability/technology-eo-professional-liability-whats-covered-whats-not)
- [Marketplace Startup Insurance: Scaling Trust & Safety (Corgi)](https://www.corgi.insure/market) and
  [Insurance for Online Marketplaces (Sharetribe)](https://www.sharetribe.com/academy/insurance-for-online-marketplaces/) —
  trust-and-safety scope, and the marketplace-endorsement caveat
- [US State Privacy Laws 2026 tracker (Enzuzo)](https://www.enzuzo.com/blog/us-state-privacy-laws) and
  [State Privacy Laws for Small Business Websites (Nerd Stack)](https://www.thenerdstack.com/posts/state-privacy-laws-small-business-websites)
- [Illegal content duties under the Online Safety Act (Ofcom)](https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/illegal-content-duties-under-the-online-safety-act) and
  [Online Safety Act 2023, s.23 (legislation.gov.uk)](https://www.legislation.gov.uk/ukpga/2023/50/section/23)
