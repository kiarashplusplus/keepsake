# Pass 24 — Bottleneck: what moderation load a small community marketplace generates, and how one person survives a burst

*Web research pass, 2026-09-09. Sonnet subagent, WebSearch + WebFetch only; no repository access. Bottleneck named in the brief: one operator, model pre-screening with a human hold queue, and a proposed two-week campus ritual that could produce a burst; passes 13 and 15 noted a solo operator has no moderation staff if a wave arrives. Report reproduced verbatim below.*

---

# Moderation Load Research: Small-Marketplace Burst Capacity

## Verdict

One person, backed by automated pre-screening, can very plausibly hold a two-week campus burst **if** the auto-screen's flag/hold rate stays in the low single digits and review time per item is measured in minutes, not hours — but no source in this research gives a moderation-load benchmark for a *sentimental-object gifting marketplace* specifically, so every estimate below is an analogy borrowed from social-feed or general-marketplace platforms. The strongest single benchmark is **Nextdoor's 2023 Transparency Report**: only 0.29% of all content was ever reported, volunteer moderators cleared 90% of those reports at a median 5.3-hour turnaround, and a small sliver of users (<0.5%) drove ~60% of removals — meaning that at typical report rates, a solo operator's real exposure is a fairly short tail of repeat problem-users and flagged edge cases, not the full listing volume.

## Findings

- **Nextdoor 2023 Transparency Report** — blog.nextdoor.com, Feb 13 2024 — "Reports of harmful content make up less than half a percent (.29%) of all content on Nextdoor"; ~200,000 volunteer moderators reviewed 90% of reported content at a median 5.3-hour removal time; <0.5% of users generated ~60% of removed content. **[verified by fetch]**
- **Nextdoor 2021 data** — about.nextdoor.com — volunteer moderators reviewed 86.9% of reported content (1.8% of all content was reported) and voted to remove 52.5% of what they reviewed. **[search snippet only]**
- **Craigslist staffing/volume** — en.wikipedia.org/wiki/Craigslist — ~28 staff (2009) alongside 2M+ new job listings/month; 50 employees (2017, 2019); ~300,000 postings/day in for-sale+housing across the 23 largest US cities (2011); removal is "automated when a certain number of users flag" a post, with the flag threshold known only to staff. **[verified by fetch]**
- **Llama Guard 3 8B model card** — github.com/meta-llama/PurpleLlama, undated (2024 release) — English response classification: precision 0.947, recall 0.931, F1 0.939, false-positive rate 0.040; multilingual F1 0.834–0.943; tool-use/code-abuse categories much weaker (F1 0.856–0.885, FPR 0.125–0.174). **[verified by fetch]**
- **Independent Llama Guard 3 benchmark (different eval set)** — emergentmind.com / Poly-Guard paper context — precision 0.891, recall 0.623, F1 0.733, FPR 0.052 on prompt classification — notably lower recall than Meta's own card, underscoring that hold-rate depends heavily on which benchmark and content domain is used; no marketplace-image-specific number found. **[search snippet only]**
- **OpenAI Moderation API** — developers.openai.com/api/docs/pricing — the omni-moderation endpoint is free to use as a backstop. **[search snippet only]**
- **Cloudflare Workers AI** — developers.cloudflare.com — Llama Guard 3 8B priced at $0.48/1M input tokens + $0.03/1M output tokens, token-based (not per-item); 10,000 free "Neurons"/day. **[search snippet only]**
- **Reddit moderator labor survey** — arxiv.org/abs/2601.01620 and related NSF-indexed studies — 45.66% of moderators spend <5 hrs/week, 27.96% spend 5–10 hrs/week, 15.01% spend 10–15 hrs/week; a companion dataset of 900+ moderators across 126 subreddits found visible actions undercount true labor. **[search snippet only]**
- **Buy Nothing Project admin guidance** — buynothingproject.org / honestlymodern.com — "at least a few hours each week" minimum per group; add roughly one more co-admin per 150–200 members of growth; one real admin of a ~1,500-member group reports ~1 hr/day (more than typical). **[search snippet only]**
- **Hacker News** — news.ycombinator.com discussion threads ("The Lonely Work of Moderating Hacker News") — dang (Dan Gackle) is effectively the sole full-time public moderator, with 'sctb historically a second; scale of daily comment volume not independently confirmed. **[search snippet only]**
- **MetaFilter** — faq.metafilter.com — 7 paid staff (Aug 2025) against ~47,691 active members (May 2024), i.e., roughly 1 staffer per ~6,800 active members, staffed "around the clock with regularly spaced gaps." **[search snippet only]**
- **Lobste.rs** — lobste.rs/about — single named administrator (pushcx), invite-only registration, and a transparency policy making all moderator actions public (no shadow-banning); no membership or queue-size numbers found. **[search snippet only]**
- **Marriage Pact** — Colgate Maroon-News, undated — one local student plus three Stanford students run ~2 weeks of prep before each campus launches its one-week survey window; 109 campuses and 628,977 cumulative participants as of Nov 2025; no published support-ticket or moderation load. **[search snippet only]**
- **Datamatch** — Harvard Crimson, Sept 2024 — "security concerns linger" reporting on the freshman-matching launch, but no quantified moderation/support load. **not found**
- **Section 230 "Good Samaritan" clause (47 U.S.C. §230(c))** — fbm.com / congress.gov CRS R46751 — protects good-faith content removal/moderation decisions and bars treating a platform as publisher of third-party posts; does **not** cover content the platform itself creates, anticompetitive removal of rivals, federal criminal law, IP claims, or sex-trafficking claims (FOSTA-SESTA 2018 carve-out). **[search snippet only]**
- **DSA/OSA relevance** — no fetch performed; both regimes apply only to services offered to EU/UK users respectively, so a Houston-only marketplace blocking UK and not serving the EU falls outside both — consistent with the operator's existing framing, not independently re-verified here.
- **Vinted** — sadvintedfaces.com (user-advocacy survey, not Vinted's own transparency data) — alleges high-volume false-positive AI bans and broken appeals; **[could not verify]** as platform-reported data, but useful as a cautionary signal against auto-hold-and-ban with no human backstop.
- **Olio** — secondary SEO/blog sources citing a "99.2% fraud-free" figure and a "Nature Sustainability" 42.3% waste-reduction study — sourcing looked unreliable (marketing-style blogs, not Olio's own site or the journal) — **[could not verify]**, excluded from the arithmetic.
- **Freegle ModTools** — wiki.ilovefreegle.org — confirms the existence of a shared volunteer moderator queue tool across local groups; specific volunteer counts or message-volume figures — **not found**.

## Back-of-envelope arithmetic (ESTIMATE — illustrative scenario inputs × sourced rates)

Scenario: a two-week burst averaging **N = 300 listings/day** and **M = 150 request notes/day** (illustrative inputs, not sourced).

| Step | Calculation | Rate source | Result |
|---|---|---|---|
| User-reported listings/day | 300 × 0.29% | Nextdoor 2023 report rate | ~0.9/day (~6/week) |
| Auto-hold listings/day (Llama Guard flag, dominated by FPR since true-unsafe rate is small) | 300 × 4.0% | Llama Guard 3 8B model-card FPR | ~12/day |
| Auto-hold notes/day | 150 × 4.0% | same FPR | ~6/day |
| Total items needing a human look/day | 0.9 + 12 + 6 | sum | ~19/day |
| Two-week burst total | 19 × 14 | | **~266 items over 14 days** |

No source gives a per-item review-minutes figure, so hours cannot be derived directly; as a labor-hours proxy, the closest sourced analogs — Reddit's "<5 hrs/week" modal moderator bucket and Buy Nothing's "few hours/week minimum" per active group — suggest a queue of this order of magnitude (roughly 130–270 items across two weeks) sits within, not far beyond, what a single engaged volunteer moderator or admin already reports handling weekly on comparable platforms.

## Three burst-control patterns

1. **New-poster rate-limiting via trust levels** — Discourse's Trust Level 0/1 system restricts posting/topic-creation for brand-new accounts until they've read/participated, throttling exactly the kind of sudden-wave-of-new-accounts scenario a campus ritual would create.
2. **Staffing-scales-with-size rule** — Buy Nothing Project's explicit guidance to add one more admin per 150–200 members of growth is a documented, numeric burst/scale trigger (unlike a "staged rollout by residential college," which was **not found** documented anywhere in this research — Marriage Pact and Datamatch both launch campus-wide at once).
3. **Pre-staged single point of contact + fixed prep window** — Marriage Pact's model of one dedicated local coordinator plus ~2 weeks of prep before each campus's one-week live window is a precedent for readying capacity ahead of a known burst rather than reacting mid-burst.
