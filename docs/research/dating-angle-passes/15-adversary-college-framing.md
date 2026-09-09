# Pass 15 — The adversary, college version: what goes wrong and where the legal edges are

*Web research pass, 2026-09-09. Sonnet subagent, WebSearch + WebFetch only; no repository access. Brief: "Be the adversary for the COLLEGE version specifically. Find evidence of what goes wrong and what the legal edges are." Not legal advice. Report reproduced verbatim below.*

---

# College Framing Risk Assessment — Adversarial Research

**Verdict:** A college framing with an explicit or implied "meet people" undertone is a **non-starter as currently scoped**, not merely risky. The single strongest piece of evidence: Texas Penal Code §33.021(c) makes it a felony to solicit a minor online with intent that an in-person meeting occur "with the intent that the minor will engage in sexual contact" — and it is **not a defense that the meeting didn't happen**. A gifting platform that (a) markets itself on a campus with a substantial 17-year-old freshman population, (b) has no accounts and thus no reliable age gate, and (c) explicitly frames its note-and-choose mechanic as a way to meet people, sits directly in the fact pattern regulators, plaintiffs' lawyers, and university general counsel are primed to scrutinize — even though Keepsake's actual mechanic is objects, not dating. The "low-stakes way to meet" pitch is the one edit that converts an unrelated liability profile into one that resembles the platforms already being sued or banned.

## Findings

**1. Minors on campus / legal exposure**
- NCES / Hechinger / CCRC snippets: dual-enrollment growth means a meaningful share of "college students" are under 18; one figure cited was "1 in 5 community college students under age 18" in 2021. [search snippet only] — https://hechingerreport.org/proof-points-dual-enrollment-national-analysis/
- A precise national percentage of *first-time four-year freshmen* under 18 was **not found** in NCES fast-facts pages searched; NCES Digest Table 303.40 was suggested as the primary source but not fetched. [could not verify]
- Texas contract law: minors' contracts are voidable at the minor's election up to age 18; an adult cannot enforce a contract against a minor. [search snippet only] — https://texaslawhelp.org/article/understanding-contracts-houston-bar-association
- Texas Penal Code §33.021(c): felony to solicit a minor online to meet for sexual purposes; meeting need not occur; 3rd-degree felony (2–10 yrs), 2nd-degree if minor <14. [search snippet only] — https://law.justia.com/codes/texas/penal-code/title-7/chapter-33/section-33-021/
- SCOPE Act (HB 18): "known minor" = actual knowledge or willful disregard of a minor's age; obligations chiefly attach to services with accounts + social-interaction/profile features. A no-account service would have a harder time being deemed to have "actual knowledge," but marketing explicitly at a campus (where a known fraction of users are minors) could support a "willful disregard" theory. [search snippet only] — https://fpf.org/wp-content/uploads/2024/05/FPF-Knowledge-Standard-Resource-Youth-Privacy-May-2024.pdf
- SCOPE Act litigation status (fetched, dated July 25, 2026): content-filtering/monitoring provisions remain enjoined (5th Circuit affirmed 2-1, July 2026, on Section 230 preemption grounds); age-verification and parental-consent provisions for covered services took effect Sept 1, 2024 and remain in force. [verified by fetch] — https://en.wikipedia.org/wiki/SCOPE_Act
- COPPA's 13+ actual-knowledge standard is largely irrelevant here since the target population (college-age) is over 13; the operative exposure is state minor-contract law, Texas §33.021, and SCOPE Act, not COPPA. [search snippet only]

**2. Campus anonymous/social-app harms**
- Yik Yak: banned or blocked on at least half a dozen campuses 2014–2015 amid mass-violence threats, race-based harassment (Colgate, Eastern Michigan, Univ. of Mary Washington "rape and kill" threats against a feminist club president), and a felony charge at Missouri S&T; shut down 2017. [search snippet only] — https://www.fire.org/news/futility-banning-yik-yak-campus ; https://reason.com/2017/09/22/no-campuses-cant-ban-students-from-using/
- Fizz (Stanford): 2021 vulnerability let three student researchers deanonymize posts and access phone numbers/emails via an exposed Firestore DB; Fizz threatened the researchers legally, EFF intervened; became public in 2022. [search snippet only] — https://stanforddaily.com/2022/11/01/opinion-fizz-previously-compromised-its-users-privacy-it-may-do-so-again/
- Sidechat: used to doxx and harass a Jewish student at Columbia (dorm location shared, encouraged vandalism), per a 114-page complaint; Harvard's then-president called it "poisonous" in April 2024 congressional testimony; UNC system banned Fizz/Sidechat campus-wide. [search snippet only] — https://www.insidehighered.com/news/tech-innovation/2024/01/24/harvard-seeks-oversight-sidechat-app-after-antisemitic-posts
- Confession/crush pages: repeatedly generate harassment; universities have requested platform takedowns (e.g., Bond University); hard to fully suppress due to anonymity. [search snippet only] — https://spectrummagazine.org/news/how-student-confessions-affect-campus-life/
- No Title IX/Clery case naming an outside platform as facilitating a specific assault was found. [could not verify]

**3. University trademark/vendor policy**
- Rice University: requires a license for any use of its name/marks; unaffiliated organizations/individuals may not register domains or use marks in commerce or advertising; approval required from Public Affairs or Athletics. [search snippet only] — https://brand.rice.edu/policies
- Precedent for enforcement against confusingly-named entities: Texas A&M System cease-and-desist (2025) to "TexAM University" for name confusion — illustrates universities act even against non-competing, non-malicious naming similarity. [search snippet only] — https://www.kcentv.com/article/news/local/texas-am-issues-cease-desist-order-trademark-infringement/
- **Implication:** any campus-branded name, "Rice," "UH," "TSU," "Cougar," "Owl" imagery, or campus-specific landing pages would need clearance or risk a C&D even absent bad intent.

**4. In-person handoffs / campus-adjacent crime**
- Campus police "Safe Exchange Zones" are a well-established norm for online marketplace meetups (UH, ASU, CU Boulder, UNL, UIC) — a mitigation pattern, not just a warning. [search snippet only] — https://www.uh.edu/police/community-services/safe-trade-location/
- UH: violent crime rate low relative to peer flagships (7.7/10,000 in 2024) but UH fast-tracked an $18M security project (lighting/cameras) after a 2024–2025 crime spike; Third Ward rated "moderate" safety. [search snippet only] — https://www.houstonpublicmedia.org/articles/news/education-news/2025/02/25/514711/
- Rice Village: a Nov. 2024 armed robbery/shooting of a couple; a 2026 multi-business burglary spree nearby. [search snippet only] — https://www.click2houston.com/news/local/2024/11/18/
- National marketplace-meetup violence pattern (Facebook Marketplace/OfferUp) is active and ongoing in 2026 reporting (Portland: 10+ incidents since start of 2026; Seattle armed OfferUp robberies; multiple 2026 murder cases tied to Marketplace meetups). [search snippet only] — https://tualatinlife.com/local-news/tualatin-online-marketplace-shooting-part-of-trend/

**5. Romance/sextortion scams**
- FBI IC3 2025: 23,159 romance/confidence-fraud complaints, $929.3M in losses (+38% YoY); FTC recorded 55,604 romance-scam reports in first 9 months of 2025 (+22% YoY, >$1.16B). [search snippet only] — https://www.techlicious.com/blog/fbi-online-scam-losses-2025/
- Sextortion: FBI received 75,000+ sextortion submissions in 2025, 11,000 from people under 20; AI-generated fake intimate images increasingly used to build fake profiles. [search snippet only] — same source.
- No source directly confirms a "sentimental story + note" gifting format as an identified scam vector; the mechanism (a stranger's note + email, no verification) is structurally similar to romance-scam contact-initiation patterns. [could not verify — inference, not evidence]

**6. Insurance**
- No underwriting document was found that names "college-targeted" or "in-person stranger meetups" as a distinct rating factor. General P2P-marketplace commentary confirms insurers/marketplaces build identity verification, escrow, and review systems specifically because meeting strangers is an acknowledged uninsured/underinsured risk category. [search snippet only] — https://www.kreezalid.com/blog/78399-what-insurance-do-you-need-to-manage-risk-on-a-peer-to-peer-marketplace
- Dating-app litigation (Tinder/Hinge, Dec. 2025; Grindr abduction/death claim, 2025) shows the plaintiffs'-bar theory now being tested against platforms that facilitate stranger meetups — Section 230 is the platforms' main defense but is being actively challenged. [search snippet only] — https://19thnews.org/2025/12/dating-app-rape-survivors-lawsuit-hinge-tinder/

## Mitigations Suggested by the Evidence

- **Drop the "meet people" framing entirely** for the college pilot; keep the product framed strictly as object rehoming with incidental human connection, never marketed as a social/dating mechanic.
- **No campus branding/marks** (school names, mascots, colors) without a written trademark license — treat every campus as requiring clearance first.
- **Add an age gate or affirmation** even without full accounts, and document a policy for "actual knowledge" of a minor (e.g., a report flags someone as under 18) — a lawyer must confirm whether any affirmative click-through changes SCOPE Act/actual-knowledge exposure for a no-account model.
- **Route handoffs to official Safe Exchange Zones** (UH, city PD stations) as the default recommended meeting location; make this a product nudge, not just a tip.
- **Confirm requester email before any note reaches giver** (already in place) — extend this to a same-domain or verified-adult-email heuristic for campus rollouts if feasible; lawyer must check whether any age representation creates liability if false.
- **Lawyer must check**: (1) whether SCOPE Act's "willful disregard" prong could attach given campus-targeted marketing; (2) sole-proprietor personal liability exposure given no LLC and no insurance bound; (3) whether current GL quotes exclude "facilitation of in-person meetings between strangers" as a class, and whether campus-marketing changes that underwriting answer; (4) Texas §33.021 exposure is aimed at sexual solicitation, not object exchange, but a lawyer should confirm the college "meet people" copy doesn't itself read as facilitating solicitation.

Not legal advice. Where marked "not found" or "could not verify," treat as an open research gap rather than an assumption of safety.
