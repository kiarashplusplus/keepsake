# Canada test city (Toronto) and cautionary-tale status updates — 2026-09-09

Companion to `market-research.md` §3-4 and `seeding-and-distribution.md` §1-2. Fetched
2026-09-09. Every claim carries a source; "could not verify" is stated in place.

---

## A. Toronto as the Canadian test city

### 1. Where Torontonians give things away free today

- **Kijiji "Free Stuff," Toronto/GTA.** Live and active — search snapshots disagreed on the
  exact count (287–531 for City of Toronto depending on sub-filter; 749 vs 6,472 nationally is
  the same disagreement `market-research.md` §4 already notes for Canada overall), but the
  category is unambiguously the default Canadian answer, same as Houston's read on the national
  page. Posting rules: Kijiji's general Prohibited Content and Posting Policies ban "an ad that
  serves no other purpose than to send traffic to a website"; no Free-Stuff-specific link
  carve-out was found, so treat it the same as Houston's Facebook-group assumption — link-averse
  until a listing's own category page says otherwise. No RSS/read API was found for Free Stuff
  specifically (unlike Trash Nothing's public read API in Houston).
- **Facebook Marketplace Free + Toronto Buy Nothing groups.** The Free category page for Toronto
  is live and populated (`facebook.com/marketplace/110941395597405/free/`) — no Houston-style
  "no free items available" gap reported here. Toronto Buy Nothing groups confirmed by name and
  URL: "Buy Nothing Toronto – Yonge and Eglinton," "Buy Nothing Midtown (East), Toronto," "🇨🇦 Buy
  Nothing Canada: DOWNTOWN Toronto." The late-Oct-2025 trademark enforcement (`market-research.md`
  §3) was national, not Houston- or US-specific, so Toronto groups faced the same takedown/rename
  risk; which specific Toronto groups renamed and to what could not be confirmed (Facebook
  login-walls group-history search, same limit hit for Houston).
- **Nextdoor Toronto Free Finds** — active, browsable without an account, at
  `ca.nextdoor.com/marketplace/toronto--on/free/`. Notably, Nextdoor's own engineering hub for
  this feature is Toronto-based, per Nextdoor's 2021 launch material — Free Finds is in a real
  sense a Toronto-built product being used in its own city.
- **Karrot Toronto** — live, and more than "type free in search": Karrot chose **Toronto as its
  North American engineering hub** and planned a 15–20-person team there as of September 2026,
  after crossing 1M registered Canadian users (May 2024) across Toronto, Vancouver and NYC.
  Buy/sell-first, same as the Houston-market read; no Toronto-only usage figure found.
- **Bunz** — see §B.1; as of today the app and homepage show no shutdown notice and still list
  Toronto as an active city, though the 1,000-DAU bar set for 2026-09-01 was, per the last
  reachable pre-deadline reporting, nowhere close.
- **Craigslist Toronto free** — live at `toronto.craigslist.org/search/zip`; furniture, tutoring,
  landscaping materials, firewood spotted. Same no-account, anonymized-email-relay mechanic as
  every other Craigslist city; no Toronto-specific rule difference found.
- **Freecycle Toronto** — strong: the main Toronto Town group has **18,352 members**, roughly
  comparable to Houston's 16,380, plus neighbourhood-specific groups (Toronto~Annex/UofT: 4,111;
  Toronto-Cabbagetown: 3,912) that Houston's tables don't show at that granularity.
- **Trash Nothing Toronto** — live ("Toronto Free," "Recycle Toronto," plus neighbourhood groups),
  federating the Freecycle groups above exactly as it does for Houston; the same public read-only
  API v1.4 applies nationally, so Toronto is queryable by lat/lng/radius the same way Houston is.
- **"Toronto Free Stuff" subreddits/Discords** — **not found.** r/toronto itself surfaces local
  freebie threads occasionally; no dedicated r/TorontoFreeStuff or equivalent Discord was located,
  mirroring the Houston finding that no r/HoustonFree exists. r/FreebiesCanada exists but is a
  national coupon/contest board, not a local gifting feed.

### 2. Programmatic posting

No channel offers legitimate programmatic *write* access into a Toronto free-gifting feed, same
conclusion as Houston. Specifically on Kijiji: the "Kijiji API" that exists is **Dealer
Central** (`dealercentral.kijiji.ca`), an inventory-management tool scoped to paid **Autos
subscription dealers** — nothing comparable exists for private-party Free Stuff, and no consumer
listing API was found. Third-party "Kijiji API" offerings that surface in search are scrapers
(Apify and similar), not sanctioned integrations; using them would carry the same ToS risk noted
for Facebook automation in `seeding-and-distribution.md` §1. Trash Nothing's public read API is
the one confirmed programmatic door, and it is read-only nationally, Toronto included.

### 3. Canada-specific legal/platform friction

- **PIPEDA** — already covered in the repo's legal docs; noted here only for completeness.
- **CASL (Canada's Anti-Spam Legislation)** is materially stricter than CAN-SPAM: CAN-SPAM is
  opt-out (send until asked to stop), CASL is **opt-in** — a commercial electronic message (CEM)
  generally needs express or a narrowly-defined implied consent *before* it is sent (CRTC
  guidance; McInnes Cooper's CASL FAQ). Two places this touches Keepsake:
  - **Confirm-then-forward request emails.** These are user-initiated (the requester submitted
    the form) and non-commercial in character — no sale, lease or barter occurs on Keepsake. CASL
    turns on whether a message promotes "commercial activity"; a free-gifting relay plausibly
    falls outside that definition, and even if a regulator treated it as a CEM, CASL's
    exemption for purely transactional/confirmatory messages without ad content would likely
    apply, though it must still carry sender ID and an unsubscribe (CRTC FAQ; Mailchimp's CASL
    summary). This is a reasonable-but-untested position, not a confirmed safe harbor.
  - **Partner outreach emails** (cold-emailing Toronto estate liquidators, NASMM movers, etc.) are
    more clearly CEMs — they promote Keepsake itself and a potential business relationship — and
    need CASL-valid consent. The practical route: CASL's implied-consent exception for a
    **conspicuously published business/professional email address** without a no-CEM notice,
    where the message is relevant to the recipient's business capacity (CRTC's implied-consent
    guide) — which covers exactly the public company-site contacts `seeding-and-distribution.md`
    §3 already sources from. Cite the exception in outreach templates; don't treat it as
    automatic.
- **Quebec's Law 25** applies the moment personal information of a Quebec resident is processed,
  regardless of business size or language of interaction — no exemption for small operators
  (Fasken; CFIB FAQ). Since Keepsake serves Canada nationally (not just Toronto/Ontario), any
  Quebec giver or requester email/postal-code data brings this in: a named privacy-responsible
  person, a public privacy policy, and (as of Law 25's now-fully-effective 2026 state) breach
  notification obligations, with penalties up to CAD 25M or 4% of global turnover for
  non-compliance (DPLIANCE 2026 guide). This is a real, not hypothetical, obligation the moment
  Canada-wide traffic includes Quebec — worth a `legal-considerations.md` line even though
  Toronto itself is Ontario.
- **Ontario estate executor rules** — brief, as scoped. Under Ontario's Estates Act/Trustee Act,
  an executor holds estate property "in trust" for beneficiaries and has a fiduciary duty; the
  consistent guidance found (Miltons Estate Law, Riopelle Group, Angrove Law) is that an executor
  should not distribute or dispose of estate assets, including sentimental personal property,
  before debts, taxes and probate obligations are settled — premature giveaways can make the
  executor personally liable. No source addressed a free-gifting platform specifically. Practical
  read for Keepsake: an executor listing a *decedent's* keepsakes on Keepsake before estate
  administration is complete carries the executor's own legal risk, independent of Keepsake's
  terms — worth a line of caution in any estate-partner-facing copy, distinct from the
  operator's-side "post on behalf of a partner" flow already flagged in
  `seeding-and-distribution.md` §5.

### 4. Toronto seed partners of the Houston kind

| # | Who | Why | Meetup |
|---|---|---|---|
| 1 | **MaxSold (Toronto/GTA)** | Canadian-headquartered online estate-auction platform, dozens of concurrent Toronto/GTA auctions; same "leftover pile after the sale" seed as Gallery One in Houston, at higher volume and better documentation (own site + Yelp reviews) | High — active auctions listed daily |
| 2 | **NASMM Toronto senior move managers** — Downsizing Diva (Gail Shields, Toronto; Shirley Coughlin, Markham) | Same NASMM directory Houston used; the in-home "what do we do with this" moment | High |
| 3 | **Repair Café Toronto @ Toronto Tool Library, 830 St. Clair West** | A standing weekly venue (Tool Library + Repair Café + The Sharing Depot under one roof) where people already bring sentimental broken objects — a Houston-style "ask for a table" opportunity, but recurring at one fixed address rather than a rotating library schedule | High — weekly, indoor, no permit needed |
| 4 | **Furniture Bank (Toronto)** | The original — founded 1998, the model every other city's furniture bank copied. Caveat not present in the Houston writeup: Toronto's Furniture Bank **charges the donor** a pickup fee (from $150) rather than picking up free, which changes the pitch — Keepsake would be positioned as the free alternative for anything they'd otherwise pay to have hauled away | Medium — fee model means Keepsake competes with, not feeds off, this one |
| 5 | **Toronto Public Library room bookings** | 100+ bookable community rooms and theatres across branches, paid-but-affordable, direct online booking or `roombookingunit@tpl.ca` — a give-away afternoon here is the direct Toronto equivalent of an HCPL Repair Café table, with a firmer booking process than Houston's | Medium-high — needs a booking, not just showing up |

---

## B. Status updates on the two cautionary tales

### 1. Bunz after 2026-09-01

**Outcome could not be confirmed either way.** No press, blog post, or social announcement dated
after 2026-08-31 was found addressing whether Bunz hit 1,000 DAU, shut down, or continued. What
is confirmed:
- The last reachable pre-deadline reporting (BetaKit, 2026-08-31, "The problem is me") states
  Bunz was "nowhere near" 1,000 DAU the day before the deadline, with June 2026's own published
  figure at **<200 DAU, mostly Toronto** — this is the last officially published number found;
  no later daily figure (which Eren had been posting since May 15) was located.
- Fetching `bunz.com` today (2026-09-09, eight days past the deadline) shows **no shutdown
  notice**: the site still markets itself as "the world's largest barter-only platform," lists
  Toronto among active cities, states "we're growing every day," and links live App Store/Google
  Play downloads. The Google Play listing shows an app update as recently as **2026-08-22** —
  before the deadline, not after, so it doesn't resolve the question either.
- Reading between these: Bunz did not visibly pull the plug, but nothing confirms it hit its own
  bar either. The most defensible statement is that Eren's public ultimatum has gone unresolved in
  public view — either quietly abandoned, quietly missed without follow-through, or genuinely
  still being decided. Treat "Bunz shut down" and "Bunz hit 1,000 DAU" as both **unconfirmed**;
  do not repeat either as fact.

### 2. Buy Nothing Project since June 2026

- **App updates.** Version has moved from 3.1.x at the January 2026 3.0 launch to **v3.1.5,
  last updated 2026-09-02** — release notes only claim "squashed a few bugs, turned a few loose
  screws." No feature announcement (e.g., the earlier-cited "Private Communities feed," swipe-back
  navigation) is dated after June.
- **Rating trend — new finding, not in `market-research.md`.** iOS is unchanged at **4.3★ / 2.1K
  ratings** (same figure as the file already cites, confirmed live today). But the **Google Play
  listing shows 1.8★ / 1.25K ratings** — a figure not previously captured. Android reviews found
  describe the app as "clunky, unreliable," citing crashes, broken navigation requiring
  double-taps, ineffective location filtering, and a paywall complaint. This is a real
  cross-platform gap worth adding to `market-research.md` §3: whatever App Store polish exists on
  iOS has not reached Android.
- **Pricing change.** No new tier or price change since June was found; Sustaining Member and Buy
  Nothing Pro pricing match what `market-research.md` already records.
- **Trademark actions / reversal.** No *new* trademark action since June 2026 was found. The
  reversal already on record (SF's "Buy Not A Thing No Rules San Francisco" group reinstated after
  a week of negotiation, per the SF Gazetteer's 2025-11-07 piece) remains the most recent
  resolution located; it is dated November 2025, not new since June, and market-research.md
  already reflects the takedown side of this story — the reinstatement detail (reactivated within
  a week, "activity... immediately returned to its normal pace") is worth folding in as the
  story's ending, not left as an open wound.
- **Press.** August 2026 coverage found is soft/promotional (a "Buy Nothing weddings" feature on
  the org's own site) rather than investigative — no follow-up piece on the 3.0 rollout's
  technical problems or the trademark fallout was found published after June.

### 3. Freecycle, Trash Nothing, Nextdoor Finds, Facebook Marketplace Free — last 90 days

Nothing found in the last 90 days rises to a `market-research.md`-changing fact:
- **Freecycle**: app updated 2026-08-25 ("fixes and improvements," no feature detail); member/Town
  counts unchanged from the file's existing figures.
- **Trash Nothing**: app at v3.6.3–3.6.4 depending on source, last dated update found is
  2026-04-10 to 2026-09-09 (sources disagreed on the exact date, same pattern the file already
  flags for this app); no material feature or scale change found.
- **Nextdoor**: For Sale & Free was rebranded **"Nextdoor Finds"** with new sub-categories
  ("Neighbor Made," "Neighbor Services") and personalized recommendations — this is a real product
  change worth a `market-research.md` §4 update, though no date narrower than "2026" was pinned
  down for the rename, and it wasn't described as replacing Free Finds so much as sitting beside
  it. August 2026 Nextdoor product updates otherwise centered on AI search and local-journalist
  accounts, consistent with the file's existing read that Finds is not the platform's headline
  feature anymore.
- **Facebook Marketplace Free**: no policy change, discontinuation, or geographic pattern was
  found in the last 90 days beyond what's already in the file; Toronto's Free tab is live and
  populated, unlike the empty-Houston-tab question the file leaves open — mild evidence for the
  file's existing "plausibly a caching/geofence hiccup" read rather than a policy rollback.

**Explicitly not found:** any Bunz statement after 2026-08-31; Toronto Buy Nothing group rename
specifics; a Kijiji Free Stuff link policy distinct from its general no-traffic-driving rule; a
precise date for the Nextdoor Finds rebrand; current admins of the Toronto Freecycle or Buy
Nothing groups.

---

## Sources

**Kijiji.** [Free Stuff, City of Toronto](https://www.kijiji.ca/b-free-stuff/city-of-toronto/c17220001l1700273) · [Free Stuff, GTA](https://www.kijiji.ca/b-free-stuff/gta-greater-toronto-area/c17220001l1700272) · [Prohibited Content](https://help.kijiji.ca/helpdesk/basics/prohibited-content) · [Posting Policies](https://help.kijiji.ca/helpdesk/policies/posting-policies) · [Dealer Central](https://dealercentral.kijiji.ca/)

**Facebook.** [Free Stuff, Toronto](https://www.facebook.com/marketplace/110941395597405/free/) · [Buy Nothing Toronto – Yonge and Eglinton](https://www.facebook.com/groups/242531768231941/) · [Buy Nothing Midtown (East), Toronto](https://www.facebook.com/groups/490065161609464/) · [🇨🇦 Buy Nothing Canada: DOWNTOWN Toronto](https://www.facebook.com/groups/646577259318797/) · [SF Standard, 2025-11-07](https://sfstandard.com/2025/11/07/buy-nothing-group-facebook-taken-down-trademark-infringment/) · [SF Gazetteer, "The fight to save Buy Nothing," 2025-11-07](https://sf.gazetteer.co/the-fight-to-save-buy-nothing)

**Nextdoor.** [Free Finds, Toronto](https://ca.nextdoor.com/marketplace/toronto--on/free/) · [Free Finds launch press release, 2021](https://about.nextdoor.com/press-releases/nextdoor-expands-its-buy-sell-and-give-feature-with-the-launch-of-free-finds) · [TechCrunch on Free Finds](https://techcrunch.com/2021/06/03/not-on-nextdoor-you-can-still-grab-your-neighbors-stuff-on-free-finds/) · [Nextdoor product updates blog](https://blog.nextdoor.com/whats-new-on-nextdoor-product-updates-2)

**Karrot.** [Karrot Canada, about](https://karrotmarket.com/ca/about/) · [BetaKit, 1M Canadian users](https://betakit.com/south-koreas-neighbourhood-buy-and-sell-app-karrot-hits-one-million-canadian-users-builds-toronto-engineering-hub/) · [Toronto Global on Karrot's Toronto footprint](https://torontoglobal.ca/media-center/korean-unicorn-startup-karrot-establishes-footprint-in-toronto-region/)

**Bunz.** [bunz.com](https://bunz.com) · [Bunz FAQ](https://bunz.com/faq) · [PR Newswire, 2026-06-11](https://www.prnewswire.com/news-releases/after-ten-years-bunz-owner-seeks-a-simple-answer-continue-or-end-it-302797177.html) · [BetaKit, 2026-08-31](https://betakit.com/the-problem-is-me-bunz-owner-brings-in-gen-z-pranksters-to-save-dying-platform/) · [Bunz on Google Play](https://play.google.com/store/apps/details?id=com.bunz&hl=en_US) · [Bunz on the App Store](https://apps.apple.com/us/app/bunz/id1068061556)

**Craigslist.** [Toronto free/zip](https://toronto.craigslist.org/search/zip) · [Craigslist Toronto area](https://www.craigslist.org/area/toronto)

**Freecycle.** [Toronto Town group](https://www.freecycle.org/town/Toronto/info) · [Toronto ~ Annex/UofT](https://www.freecycle.org/town/TorontoAnnex/info) · [Toronto – Cabbagetown](https://www.freecycle.org/town/TorontoCabbagetownON/info) · [Freecycle app, App Store](https://apps.apple.com/us/app/freecycle/id6444136692) · [Freecycle Newswire](https://newswire.freecycle.org/)

**Trash Nothing.** [Toronto Free](https://trashnothing.com/toronto-free) · [Ontario groups](https://trashnothing.com/groups/canada/ontario/) · [App Store listing](https://apps.apple.com/ca/app/trash-nothing-free-stuff/id680743557)

**Reddit.** [r/toronto](https://reddit.com/r/toronto) (general community, no dedicated free-stuff subreddit found)

**Buy Nothing Project.** [BuyNothing on the App Store](https://apps.apple.com/us/app/buynothing/id1557679959) · [BuyNothing on Google Play](https://play.google.com/store/apps/details?id=com.sharething.app&hl=en_GB) · [buynothingproject.org](https://buynothingproject.org/) · [buynothingproject.org/announcements](https://buynothingproject.org/announcements)

**Canadian law.** [CRTC CASL FAQ](https://crtc.gc.ca/eng/com500/faq500.htm) · [CRTC implied-consent guidance](https://crtc.gc.ca/eng/com500/guide.htm) · [McInnes Cooper, CASL 10 FAQs](https://www.mcinnescooper.com/publications/canadas-anti-spam-legislation-casl-10-faqs/) · [Mailchimp, CASL overview](https://mailchimp.com/help/about-the-canada-anti-spam-law-casl/) · [Fasken, Law 25 resource centre](https://www.fasken.com/en/knowledge/law-25) · [CFIB, Law 25 FAQ](https://www.cfib-fcei.ca/en/tools-resources/law-25-faq) · [DPLIANCE, Law 25 2026 guide](https://dpliance.com/en/blog/quebec-law-25/) · [Miltons Estate Law, executor basics](https://ontario-probate.ca/executor-role/) · [Riopelle Group, estate administration Ontario](https://rglaw.ca/estate-administration-in-ontario-what-executors-need-to-know-before-acting/)

**Toronto seed partners.** [MaxSold, Ontario/GTA](https://pages.maxsold.com/canada/ontario/gta) · [MaxSold Estate Sales Toronto, Yelp](https://www.yelp.com/biz/maxsold-estate-sales-toronto) · [NASMM, Canada/Ontario directory](https://www.nasmm.org/find-a-move-manager/list/?state=ON&country=CA) · [Repair Café Toronto FAQ](https://repaircafetoronto.ca/faq/) · [Toronto Tool Library, Wikipedia](https://en.wikipedia.org/wiki/Toronto_Tool_Library) · [Furniture Bank, what we accept](https://www.furniturebank.org/what-we-accept/) · [Furniture Bank donation guide](https://www.furniturebank.org/a-guide-to-donating-furniture-in-toronto/) · [Toronto Public Library, meeting rooms](https://www.torontopubliclibrary.ca/using-the-library/room-theatre-rentals/meeting-rooms.jsp) · [TPL venue rentals](https://venuerentals.tpl.ca/)
