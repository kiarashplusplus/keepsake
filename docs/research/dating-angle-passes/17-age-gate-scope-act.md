# Pass 17 — Bottleneck: what a no-account gifting site must do about age, in Texas and generally

*Web research pass, 2026-09-09. Sonnet subagent, WebSearch + WebFetch only; no repository access. Bottleneck named in the brief: neither the terms nor the site state a minimum age; pass 15 flagged the SCOPE Act's "known minor" standard, Texas Penal Code §33.021, and 17-year-old first-years in any college pilot. Not legal advice. Report reproduced verbatim below. **Premise note (added after the pass ran):** the brief said "no accounts"; the accurate model is a persistent, email-verified giver identity without a profile, and an email-only requester — see the folder README's premise correction and passes 27–28.*

---

# Age & Minors Research: No-Account Gifting Marketplace (Keepsake)

## Verdict

Keepsake most likely falls **outside** the SCOPE Act's substantive coverage as currently drafted — Tex. Bus. & Com. Code §509.002(a) triggers coverage only for services that combine (1) user-to-user social interaction, (2) public/semi-public **profiles**, and (3) user-posted content viewable by others, and Keepsake has no accounts and no profiles — but this is an unlitigated edge case, not a safe harbor, especially once the site *knows* (via the college pilot) that some users are 17-year-old first-years, because Texas's "known minor" standard is **actual knowledge OR willful disregard** (Tex. Bus. & Com. Code §509.001(4), §509.051(e)), a lower bar than federal COPPA's actual-knowledge-only test. The single strongest source for what to do: pair a plain 18+ (or parental-involvement) line in the Terms — the pattern every comparable no-account site (Craigslist, Buy Nothing, Olio) already uses — with the FTC's own guidance that a *neutral* age question is a prospective, good-faith shield for reliance on false answers, **not** a defense once the operator has actual knowledge or is willfully blind to a specific known-minor population (FTC, "Complying with COPPA: FAQs," ftc.gov). Keepsake must not treat an "I am 18+" checkbox as curing the college-pilot problem — it doesn't, once the operator knows 17-year-olds are being onboarded.

## Findings

**1. SCOPE Act scope**
- "Digital service" = a website/application/program/software that collects or processes personal identifying information with internet connectivity; "digital service provider" = one who owns/operates it and determines the purpose/means of collecting such data. Tex. Bus. & Com. Code §509.001. [verified by fetch, tcss.legis.texas.gov]
- Coverage trigger (§509.002(a)) is conjunctive: the service must (i) let users socially interact, (ii) let a user create a public/semi-public profile, and (iii) let a user post content viewable by other users. [verified by fetch, tcss.legis.texas.gov] — this is the load-bearing fact for Keepsake: no profiles, no on-platform messaging.
- "Known minor" = a person the provider knows is a minor; a provider "is considered to have actual knowledge" per §509.051(e); other secondary sources paraphrase the standard as actual knowledge **or willful disregard** of age (SCOPE Act, en.wikipedia.org/wiki/SCOPE_Act, undated). [search snippet only — could not independently confirm "willful disregard" appears verbatim in the codified text vs. legislative/analyst paraphrase]
- Exemptions include small businesses (SBA-defined as of 9/1/2024), FERPA/education entities, HIPAA entities, financial institutions, and services where interactive features are "incidental" to news/sports/commerce content. [verified by fetch, tcss.legis.texas.gov]
- Enforcement: AG Paxton opened investigations into 15 tech companies (Dec. 2024) and sued TikTok (Jan. 2025) citing SCOPE Act conduct — [MoFo, mofo.com/resources/insights/241112-texas-privacy-enforcement-heats-up, Nov 2024; KXAN, kxan.com/news/texas/paxton-suing-tiktok-referencing-scope-act-violations, undated]. A federal court (W.D. Tex.) preliminarily enjoined the content-monitoring/filtering, targeted-advertising, and age-verification provisions (§§509.053, 509.055–.057) on First Amendment/vagueness grounds, Feb. 7, 2025 [Hunton, hunton.com/…/district-court-blocks-enforcement-of-scope-act-requirements]. No enforcement action was found against a no-account marketplace. [could not verify any exists]

**2. Comparable no/light-account sites**
- Craigslist: "you represent and warrant... you are of sufficient age and capacity to use CL" — no explicit "18" numeral found in the current live clause text I could fetch, though secondary sources describe an 18+ practice [craigslist.org/about/terms.of.use/en — verified by fetch for the quoted clause; the "18" number itself is search-snippet only].
- Buy Nothing Project: users must be 18+ per its terms [buynothingproject.org/terms — search snippet only].
- Olio: "not intended for anyone under 18... does not knowingly collect data from anyone under 18," using under-18 as prohibited use [help.olioapp.com/article/300-acceptable-use-policy — search snippet only].
- Nextdoor, Karrot, Trash Nothing, Freecycle: no minimum-age clause could be located in search results. [not found]
- FTC/COPPA: actual knowledge exists when a site asks for and receives age info showing a user is under 13; a **neutral** age gate ("How old are you?" not "Are you 18+?") lets an operator rely prospectively on inaccurate answers, but this is a COPPA (under-13) doctrine, not a general "checkbox = compliance" rule [ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions, undated; FTC COPPA age-verification policy statement, Feb. 2026, ftc.gov/news-events/news/press-releases/2026/02/...]. No age-gate case law specific to non-COPPA "actual knowledge" defenses was found. [could not verify]

**3. Other state laws (2026 status)**
- Utah Minor Protection in Social Media Act: preliminarily enjoined Sept. 2024, on appeal to 10th Cir. [firstamendment.mtsu.edu, undated; hunton.com]
- Arkansas Social Media Safety Act (as amended, Act 900 of 2025): permanently enjoined April 2026 [sheppard.com/insights/blogs/arkansas-kids-social-media-law-another-one-bites-the-dust]
- Florida HB3: 11th Circuit stayed the injunction Nov. 25, 2025; AG has moved to enforce; under-14 ban itself still separately enjoined [ccianet.org/articles/floridas-hb3-…, undated — search snippet only, not independently fetched]
- Mississippi HB 1126: upheld, can stand pending appeal [biometricupdate.com/202508/mississippi-age-assurance-law-can-stand…, Aug. 2025]
- Louisiana: identified only an adult-content (pornography) age-verification law as active; no general social-media minors law confirmed [recordinglaw.com/us-laws/age-verification-laws, undated — search snippet only]
- California AADC: 9th Circuit narrowed the injunction (Mar. 12, 2026; mandate issued Apr. 3, 2026) — coverage definition and age-estimation requirement now likely enforceable; data-use/dark-patterns provisions remain enjoined as unconstitutionally vague [cooley.com/news/insight/2026/…, Mar. 2026]. All of these define "covered service" by design features (recommendation feeds, addictive design, social features) — none found to require user accounts as a precondition, so a no-account marketplace is not obviously exempt by that fact alone. [could not verify a clean carve-out for account-free services in any of these]

**4. Freshman age data** — I could not find NCES Digest Table 303.40 or IPEDS broken out specifically for "first-time full-time freshmen under 18." The closest verified proxy: NCES Table dt21_303.40 shows 1,455,000 of 19,630,000 total fall-2019 postsecondary enrollees (~7.4%) were under 18 — but this is **all** enrolled students of all types, not first-time freshmen specifically [nces.ed.gov/programs/digest/d21/tables/dt21_303.40.asp — verified by fetch, but wrong population]. A separately surfaced figure ("~10.4% of undergrads are 17 or younger") could not be traced to a citable NCES/College Board source. [could not verify — treat as unsupported]

**5. Canada/OPC** — PIPEDA guidance treats consent from anyone under 13 as requiring a parent/guardian; for minors 13+, consent can be "meaningful" if maturity is accounted for in the consent design; no account-free-service carve-out or explicit minimum-age-gate requirement was found [priv.gc.ca/…/gl_omc_201805, May 2018 guidelines — search snippet only].

## What a lawyer must confirm
- Whether Keepsake's "leave a note" + email-relay feature counts as "social interaction between users" under §509.002(a) despite having no profiles or general messaging — this single interpretive question decides SCOPE Act coverage.
- Whether operating a college pilot that foreseeably includes 17-year-old first-years constitutes "willful disregard" under Texas's known-minor standard even with an 18+ terms line, and what internal knowledge (recruiting materials naming "first-years") could be used as evidence of it.
- Current in-force status (not just today, but at each state launch) of Florida HB3, Mississippi HB1126, California AADC, and any newly enacted 2026 state laws, since injunctions are shifting monthly.
- Whether Texas Penal Code §33.021 (online solicitation of a minor) has any realistic application to a non-sexual gifting relay, or is a non-issue here.
- Whether an operator this small actually qualifies for the SCOPE Act small-business/SBA exemption, and what threshold applies.
- Precise current text of Craigslist's, Buy Nothing's, and Olio's minimum-age clauses (verify against live pages, not summarized snippets) before modeling Keepsake's own terms on them.

Not legal advice.
