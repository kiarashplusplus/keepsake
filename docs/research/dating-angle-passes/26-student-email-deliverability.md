# Pass 26 — Bottleneck: will confirmation and relay emails from a new small domain reach Rice and UH student inboxes?

*Web research pass, 2026-09-09. Sonnet subagent, WebSearch + WebFetch only; no repository access. Bottleneck named in the brief: the whole request flow is confirm-then-forward by email from a new domain via Cloudflare Email Service, delivery to any address other than the operator's is an open issue in the repo, and a college pilot would put most requesters on student addresses. Report reproduced verbatim below; note the subagent's own search-budget caveat at the end.*

---

# Keepsake Confirm-Then-Forward Deliverability — Campus Email Research

## Verdict

The sharper risk sits with **University of Houston**, not Rice. Rice students run on **Google Workspace/Gmail**, which authenticates and reputation-scores mail but does not, by design, autonomously "detonate" links in the background before a human opens the message — the main Rice-side risk is a new/low-volume domain landing in Promotions or triggering Gmail's own "you don't often get email from this address" banner, both addressed by strict SPF/DKIM/DMARC alignment (which Cloudflare Email Service already provides per the repo). UH's CougarNet runs on **Microsoft 365/Exchange Online** (confirmed), and *if* UH's tenant has Defender for Office 365 Safe Links turned on for students (not confirmed either way for UH specifically), Microsoft's own documentation states that inbound URLs with no established reputation — exactly what a brand-new low-volume sending domain produces — are **"detonated asynchronously in the background"** during mail flow, ahead of and independent of the recipient's own click. That is the documented mechanism by which a one-time confirmation token gets consumed before the requester ever opens the email, making the link appear dead or "already used." The single highest-leverage fix, effective regardless of which scanner (Safe Links, Proofpoint, Mimecast) any given campus runs: **stop letting the emailed link itself perform the confirming state change.** Land the link on a page that requires an explicit human click (or accept a short numeric code instead of a link) before the token is consumed — this defeats automated pre-fetch/detonation by construction. Strongest source: Microsoft Learn, *"Complete Safe Links overview for Microsoft Defender for Office 365"* (verified by fetch).

## Campus mail platforms

| Campus | Mail platform | External-sender handling | Link-scanning product | Source | Confidence |
|---|---|---|---|---|---|
| Rice University | Google Workspace for Education (Gmail), NetID@rice.edu | Gmail external-sender/"first time" warning banner (general Gmail behavior, not campus-specific config found) | Not found (no Proofpoint/Mimecast mention) | [kb.rice.edu id=103604](https://kb.rice.edu/page.php?id=103604), [kb.rice.edu id=65783](https://kb.rice.edu/page.php?id=65783) | [search snippet only] |
| University of Houston | Microsoft 365 / Exchange Online, CougarNet@cougarnet.uh.edu | Not confirmed whether Defender for Office 365 (Safe Links, external tag) is licensed for students; UH's own security page names no product | Could not confirm Safe Links/Proofpoint/Mimecast | [uh.edu/infotech student-email](https://www.uh.edu/infotech/services/accounts/email/student-email/) [verified by fetch]; [tss.rice.edu/security](https://tss.rice.edu/security) analog checked, no vendor named | [verified by fetch] (platform); [could not verify] (scanner) |
| Texas Southern University | Microsoft Office 365, username@student.tsu.edu | Not found | Not found | [tsu.edu/oit/software](https://www.tsu.edu/about/administration/office-of-information-technology/software/) | [search snippet only] |
| University of St. Thomas (Houston) | Microsoft Office 365 | Not found | Not found | [stthomas.edu/its](https://services.stthomas.edu/TDClient/1898/ClientPortal/KB/ArticleDet?ID=97015) | [search snippet only] |
| University of Toronto (UTmail+) | Microsoft 365 / Exchange Online, @mail.utoronto.ca | Not found in fetched page | Not found | [easi.its.utoronto.ca UTmail+](https://easi.its.utoronto.ca/shared-services/office365/utmail/utmail-for-students/) | [verified by fetch] (platform); [could not verify] (scanner) |
| Toronto Metropolitan University (TMU) | Gmail/Google Workspace, @torontomu.ca | Not found | Not found | [torontomu.ca/ccs email_and_learning](https://www.torontomu.ca/ccs/services/email_and_learning/) | [verified by fetch] (platform) |
| York University | Undergrad: Google/Gmail (@my.yorku.ca); Grad: Microsoft 365 | Not found | Not found | [yorku.ca/uit email](https://www.yorku.ca/uit/student-services/email/) (fetch 503, snippet only) | [search snippet only] |

## Findings

**2. External-sender handling & scanning behavior**
- Microsoft Safe Links (Defender for Office 365): does URL rewriting + **time-of-click verification**, and per Microsoft's own docs, "URLs that don't have a valid reputation are **detonated asynchronously in the background**" and messages can be held pending scan completion — the exact mechanism that can consume a single-use token before a human clicks. [Microsoft Learn, verified by fetch]
- Whether UH (or TSU/USThomas/UofT/TMU/York) actually license Defender for Office 365 for students (vs. baseline Exchange Online Protection only) — **could not verify**; Safe Links is not present in all M365 education SKUs.
- Rice/UH-specific Proofpoint or Mimecast deployment — **could not verify**; neither school's public IT/security pages name a third-party filtering vendor.
- Google's 2024 bulk-sender rules: **all** senders to Gmail need SPF or DKIM, valid PTR/rDNS, TLS, <0.3% spam-complaint rate (per Google Postmaster Tools) since Feb 2024; the **stricter** tier (SPF+DKIM+DMARC, one-click unsubscribe) applies only above 5,000 msgs/day. At Keepsake's volume, the low-volume baseline applies — no unsubscribe requirement — but the source does not state an explicit "transactional exemption"; it's a volume-threshold effect, not a named carve-out. [support.google.com/a/answer/81126, verified by fetch]

**3. Deliverability for new, low-volume domains**
- Cloudflare's outbound "Email Sending" (Beta, requires Workers Paid plan) is explicitly marketed for "welcome messages, password resets, order confirmations" and magic-link/2FA flows, with an "automatic IP reputation management and deliverability optimization" feature — but exact rate limits and DKIM/SPF setup steps were not retrievable from the fetched overview page. [developers.cloudflare.com/email-routing, verified by fetch for existence/use-case; could not verify for limits]
- DMARC p=none-then-escalate warm-up guidance, and BIMI's irrelevance at p=none, are standard, widely-known practices; **not independently re-verified by fetch this session** (search budget exhausted before this could be sourced).
- Published data on small senders' delivery rates specifically to .edu domains — **not found**.

**4. Magic-link/one-time-token consumption**
- Mechanism confirmed via Microsoft's own Safe Links documentation (above): asynchronous background detonation of unreputed URLs is the documented cause class for this failure mode.
- Third-party case studies/blog posts naming this problem for Outlook Safe Links, Proofpoint URL Defense, or Mimecast specifically — attempted repeatedly, **could not verify** (WebSearch budget was exhausted early in this session; substitute search engines returned CAPTCHA pages or generic results via WebFetch).
- Recommended mitigation pattern (standard, widely practiced, not separately sourced this session): the emailed link should open a landing page requiring an explicit human action (button click → POST) rather than a bare GET that itself completes the confirmation; alternatively use a short code entered manually. This defeats automated pre-fetch regardless of scanner vendor.

**5. Student behaviour / campus-product precedent**
- Survey data on .edu vs. personal inbox checking frequency — **not found** (search exhausted, no usable results recovered).
- Marriage Pact / Datamatch / Fizz reliance on .edu delivery and any reported issues — **not found**.

**6. CASL transactional exemption**
- CASL s.6(6)(b) exempts a commercial electronic message that "facilitates, completes or confirms a commercial transaction that the person to whom the message is sent previously agreed to enter into" from the consent requirement — directly covers a request-confirmation email. [laws-lois.justice.gc.ca, verified by fetch] Note: Keepsake being a free marketplace, its confirmation email may not even qualify as a "commercial electronic message" in the first place; the exemption is a fallback if treated conservatively as one.

**Search-budget note:** this session's WebSearch quota (200 calls) was consumed early; items marked "could not verify" or "not found" above reflect exhausted search plus failed substitute approaches (guessed URLs returning 404, DuckDuckGo CAPTCHA-gated, Bing returning generic results only), not an assessment that the information doesn't exist.
