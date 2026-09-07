# Checklist: re-enabling the UK

`docs/runbooks/uk-block.md` is the record of *why* the UK is geo-blocked and *how* the block is
implemented. This doc is the other half: the actual work-list to execute **before** doing any of
the following —

- adding `"GB"` (or `"JE"` / `"GG"` / `"IM"`) back to `@keepsake/contracts/geo`'s `COUNTRIES`, or
- removing any of those codes from `UK_BLOCKED_COUNTRIES` in
  `apps/api/src/middleware/ukBlock.ts`.

Both of those are now guarded by tests that fail loudly and point back here — see
`packages/contracts/test/geo.test.ts` ("OSA re-entry gate") and
`apps/api/test/ukBlock.test.ts` ("OSA re-entry gate"). **If you're reading this because one of
those tests failed, work through this list before making the test pass by weakening it.** The
test failing is the system working as designed, not a bug to route around.

This is not legal advice, and it is not a substitute for a lawyer. It is a checklist assembled
from public guidance so that whoever picks this up (including a future instance of an AI agent)
has a concrete list of what "do the work first" actually means, instead of a vague sense that
paperwork is owed somewhere.

## 0. Read the context first

- `docs/legal-considerations.md`, "UK Online Safety Act" section — the full research behind this
  decision, including what's verified vs. not.
- `docs/runbooks/uk-block.md` — the decision record and the code-level mechanics of the block
  itself.
- Issue #30 (`kiarashplusplus/keepsake`) — the tracking placeholder this checklist existed to back
  up. **#30 is closed**, and closing it did not answer anything: the block is what closed it. This
  file is now the only tracker for the work in sections 1–6, which is the reason to work from the
  file rather than from a search of open issues.
- Issue #34 — the lawyer-questions tracking issue. Q1 (Article 27 representative), Q4 (Age
  Appropriate Design Code) and Q6 (Ofcom record-keeping exemption) are the three UK questions
  explicitly noted there as moot under the geo-block but live again the moment it's lifted. Q1 is
  section 5 below, Q4 is section 6, Q6 is section 4. **#34 is closed** — see the 2026-09-07 note in
  `docs/legal-considerations.md` for why that closure does not mean these were answered; the
  research behind all three is in
  [`docs/legal-open-questions-research.md`](../legal-open-questions-research.md).

## 1. Illegal-content risk assessment (required regardless of size)

**Verified directly against the statute** (fetched `legislation.gov.uk/ukpga/2023/50/section/9`,
2026-09-06): section 9 of the Online Safety Act 2023 requires every regulated user-to-user service
to carry out "a suitable and sufficient illegal content risk assessment," to keep it up to date
(including whenever Ofcom changes a risk profile), and to redo the relevant part before any design
or operational change that could affect the risk. The section contains **no size-based carve-out**
— the duty applies to the assessment itself; only the thresholds for *additional* Category 1/2A/2B
duties (Schedule 11 designation, tens of millions of UK users) are size-gated, and Keepsake is
nowhere near those regardless.

To do:

- [ ] Assess Keepsake's exposure across all 17 priority-content categories Ofcom's risk-assessment
  guidance sets out (terrorism, CSEA, harassment/stalking, hate, fraud, and others — pull the
  current list from Ofcom's Illegal Content Judgements Guidance at the time this is done, since the
  category list is Ofcom-maintained and could change).
- [ ] Document current mitigations already in place as inputs to the assessment: human-reviewed
  moderation queue (`docs/design/moderation.md`), the existing report button, no direct messaging
  (contact happens over email, not in-product chat), no anonymous browsing of contact details.
- [ ] Write the assessment as an actual document (not just this checklist) — Ofcom's own guidance
  frames "suitable and sufficient" as meaning it's specific to the service's actual functionality
  and user base, not a generic template. A few honest pages is very likely sufficient at this
  scale, per the practical read in `docs/legal-considerations.md`, but "very likely sufficient" is
  not the same as "confirmed" — see the lawyer flag in section 5.
- [ ] File it somewhere durable (this repo, under `docs/legal/` or similar) with a date, so it
  satisfies the record-keeping duty in section 4 by construction.

## 2. Children's access assessment — treat as immediately overdue, not schedulable

**Verified via search of secondary sources summarizing Ofcom's published guidance** (could not
fetch `ofcom.org.uk` directly — it returned HTTP 403 to this environment's fetch tool; see
"What I could not verify" below): for services already operating, the children's access assessment
deadline was **16 April 2025**. For a service that comes into scope *after* that date (which
re-enabling the UK for Keepsake would be, if treated as a fresh launch into that market), Ofcom's
guidance gives **three months from the point of coming into scope**, with annual re-assessment or
re-assessment on significant service change thereafter.

Practical read for Keepsake specifically: because the original fixed deadline has already passed,
there is no clean "we're a new entrant, we get three months" argument available if any UK access
happened before the geo-block (it did — that's the premise of issue #30 existing at all). **Do not
schedule this as future work once GB re-entry is being considered — do it before flipping the
switch back on, as if it is already late**, because by the letter of the guidance, for a
continuously-intending-to-operate service, it is.

To do:

- [ ] Determine whether Keepsake can affirmatively show a significant number of children are not
  using it (an 18+ self-declaration gate is *a* signal Ofcom's guidance treats as relevant, but
  per `docs/legal-considerations.md`'s Minimum age section, "not seeming appealing to children" is
  explicitly **not** sufficient on its own, and there is currently no age gate at all in the
  product — see issue #25). **Correction, 2026-09-07:** the "no age gate at all" clause was true
  when this was written and is not now — issue #25 shipped a self-declared 18+ gate on both
  create-listing and create-request, and #64 replaced the checkbox with a date-of-birth prompt
  (`DateOfBirthSchema`/`MINIMUM_AGE`, recorded as `age_attested_at`). The rest of the bullet stands:
  a self-declaration is a relevant signal, not a demonstration. Section 6 below covers documenting
  what it is and isn't worth.
- [ ] If that can't be shown, treat Keepsake as likely accessed by children and complete the
  associated Children's Risk Assessment and implement Part 3 protection measures before re-opening
  to the UK.
- [ ] Write the assessment down, dated, alongside the illegal-content one.

## 3. Complaints procedure

To do:

- [ ] Write down an actual complaints process, not just "email hello@keepsake.ing": what counts as
  a complaint, an acknowledgment/response-time commitment, and what action gets taken.
- [ ] Pair it with the existing report button so a complaint about illegal content and a general
  complaint about the service both have a clear, easy-to-find path — Ofcom's guidance requires the
  process to be easy to access and use, including by children.
- [ ] Publish it somewhere a UK user would actually find it (terms/privacy page or a dedicated
  page) — that page is owned by another workstream (issues #26/#31/#32); coordinate rather than
  edit `apps/site/public/{privacy,terms}.html` directly from this checklist.

## 4. Record-keeping

To do:

- [ ] Keep the illegal-content risk assessment and children's access assessment (sections 1–2) as
  dated, versioned documents — this repo's git history already gives that for free if they're
  committed as files, which is the recommended approach.
- [ ] Keep a record of whatever compliance measures are actually implemented as a result (age
  gate, moderation changes, complaints process), not just the assessments themselves.
- [ ] **Unverified**: whether any Ofcom-published exemption narrows this duty for a provider
  Keepsake's size. `docs/legal-considerations.md` flags this as unresolved and it's Q6 on the
  lawyer-questions list (issue #34) — do not assume an exemption exists; ask before relying on one.

## 5. UK GDPR Article 27 representative — the genuinely unresolved question

This is **not** an Online Safety Act duty — it's UK GDPR — but it's gated by the same "is the UK
market being served" decision, so it belongs on this list.

**Verified via search of ICO/legal-summary sources** (could not reach `ico.org.uk`'s own guidance
page directly in this pass): Article 27's exemption requires **all three** of (a) processing that
is occasional, (b) not large-scale special-category or criminal-offence data, and (c) unlikely to
create a risk to individuals' rights. Secondary sources describing ICO's own framing say regulators
read "occasional" narrowly, and that most services with an ongoing, functioning product and regular
users fail that prong regardless of volume — which matches `docs/legal-considerations.md`'s own
read that Keepsake's *ongoing* (not occasional) UK-facing processing is the element most likely to
knock the exemption out.

To do:

- [ ] This is Q1 on the lawyer-questions list (issue #34) — get an actual answer before re-enabling,
  not a repeat of this research.
- [ ] If a representative is required, budget for it as an ongoing cost, not a one-time fee — it's
  a paid, continuing service.

## 6. Age Appropriate Design Code — write the "not likely to be accessed by children" rationale down

This is the other UK question the geo-block moots and re-enabling revives: it's Q4 on the
lawyer-questions list (issue #34). Like section 5 it's data-protection law, not the Online Safety
Act, but it's gated by the same "is the UK market being served" decision. It is **not** the same
duty as section 2 — section 2 is the OSA children's *access assessment* Ofcom supervises; this is
the ICO's Children's Code, which attaches to information society services "likely to be accessed by
children" in the UK. They overlap in evidence and can share one document, but they are two regimes
and both have to be satisfied.

**Sourced from search summaries of ICO guidance, not the ICO pages read end to end** — the same
egress limitation recorded in `docs/legal-open-questions-research.md`'s method note and in "What I
verified vs. could not" below applies here. The write-up is in that document's Q4 section.

The important finding, because it changes what the work *is*: the configuration Keepsake runs today
— a self-declared 18+ gate with nothing documented behind it — is, per that research, the one ICO
guidance most clearly rejects, but **the gap is documentary, not technical.** ICO expects a provider
that concludes children are not likely to access the service to record that conclusion with
evidence and keep it under review; a provider that does not assess at all is treated as likely
accessed by children, which is the worst of the three outcomes. So the fix here is a written
rationale, **not** procuring an age-verification vendor. (Note that self-declaration is not
"effective" age assurance in the sense ICO uses when it says an effective age-gate takes a service
outside the code — the rationale route is the one actually available at this scale.)

To do:

- [ ] Write a dated, evidenced rationale for concluding under-18s are not likely to access
  Keepsake. ICO's own listed examples of acceptable evidence are market research, current evidence
  on user behaviour, the user base of similar or existing services and service types, and testing
  of access-restriction measures — reason from Keepsake's actual facts (subject matter, 18+ terms,
  the in-person adult handoff, no child-oriented design, and whatever the user base actually looks
  like at the time), not from a template.
- [ ] Record the age gate as it actually exists at that point as one input, honestly labelled: it
  is a self-declared date-of-birth prompt (`DateOfBirthSchema`/`MINIMUM_AGE` in
  `@keepsake/contracts/common`, recorded as `age_attested_at`), which is evidence, not verification.
- [ ] File it alongside the sections 1–2 assessments and put a review date on it — ICO expects the
  conclusion to be kept under review, not decided once.
- [ ] **Do not treat this as answered by this checklist.** Q4 is one of the eight questions #34
  raised for a lawyer and it was never answered by one; the research narrows what to ask, and the
  hedge above is part of the answer, not decoration.

## 7. Before flipping the code back

Once (and only once) sections 1–6 are actually done, in good faith, and filed somewhere durable:

1. Remove the relevant code(s) from `UK_BLOCKED_COUNTRIES` in
   `apps/api/src/middleware/ukBlock.ts`.
2. Add `"GB"` back to `@keepsake/contracts/geo`'s `COUNTRIES`, `COUNTRY_LABELS`, and
   `COUNTRY_POSTCODE_HINTS`, and restore the GB branch in `normalizePostalCode` — see git history
   around 2026-09-06 for the removed code, or `tools/geodata/build-postal-seed.mjs`, which still
   knows the GB normalization rule.
3. Re-run `tools/geodata/build-postal-seed.mjs --countries GB` if the existing seeded
   `postal_codes` rows are considered stale.
4. Update `apps/site/public/{privacy,terms}.html` and `docs/design/geo.md` for any US/CA-only
   language picked up in the meantime (coordinate with whoever owns those files at the time).
5. Update the two "OSA re-entry gate" test blocks (`packages/contracts/test/geo.test.ts`,
   `apps/api/test/ukBlock.test.ts`) — they're designed to fail the moment any of this starts, on
   purpose. Update them last, after 1–4 are actually true, not first to silence them.
6. Update `docs/runbooks/uk-block.md`'s status line and this file's own status.

## What I verified vs. could not, and how (2026-09-06)

This pass had working web egress (a prior research pass on these same questions, cited in
`docs/legal-considerations.md`, did not and relied on search-summary tools only).

- **Fetched directly and read**: `legislation.gov.uk/ukpga/2023/50/section/9` (illegal content
  risk assessment duty, no size exemption in the statutory text).
- **Could not fetch directly**: `ofcom.org.uk`'s own guidance pages returned HTTP 403 to this
  environment's fetch tool both for the illegal-content risk assessment guidance and the
  children's access assessment guidance pages. The children's-access-assessment deadline (16 April
  2025) and the "three months for new entrants" figure above come from web search summaries of
  secondary sources (law-firm alerts, trade press) describing that Ofcom guidance, not from the
  guidance document itself — treat as **likely correct but not independently confirmed against the
  primary source**.
- **Could not fetch directly**: `ico.org.uk`'s Article 27 guidance. The exemption text quoted above
  was corroborated across multiple independent secondary sources (legal-services sites summarizing
  the same ICO guidance) rather than the ICO page itself.
- **Confirmed via search, multiple independent sources agreeing**: the £1.35M 8579 LLC fine and
  the £950,000 fine against the suicide-forum operator are both real, both reported as Ofcom's
  largest Online Safety Act enforcement actions to date (as of ~2026-07/08), and both concern
  age-assurance/illegal-content failures rather than a general marketplace. One detail in
  `docs/legal-considerations.md` is slightly imprecise: sources vary on the death toll linked to
  the forum (130–164 depending on the report and date), so "over 160" is at the high end of what's
  reported rather than a single confirmed number — directionally correct, not exact.
- **Not attempted this pass**: re-verifying the Schedule 3 timing detail for the illegal-content
  risk assessment's own deadline (as opposed to the children's-access-assessment deadline, which
  was checked). If this checklist is ever executed for real, confirm Schedule 3's actual timing
  requirement directly rather than relying on this note.

None of the above changes the bottom line in `docs/legal-considerations.md` or `uk-block.md`: no
size exemption for the base duties, the children's-access deadline has already passed for any
service that already operated in the UK, and the Article 27 question is a real, unresolved call
that needs a lawyer, not further research.
