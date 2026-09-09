# Seeding Houston and distributing listings — research, 2026-09-09

Companion to [`market-research.md`](./market-research.md) (who else is in the space) and
[`runbooks/seed-catalogue.md`](./runbooks/seed-catalogue.md) (why production cannot be seeded with
a script). This file answers two operator questions asked on 2026-09-09:

1. Facebook Marketplace's **Free** category shows "No free items available in your area right now"
   in Houston. Is that selective or unavailable, and what are the alternatives for getting
   Keepsake listings in front of people — Nextdoor and the rest?
2. Who in the Houston metro could **seed real gifts** — people and small operators who regularly
   have sentimental objects to rehome and can meet up to hand them over?

Four parallel research passes fed this: Facebook (Marketplace + Houston gifting groups), the
other channels and any feed/API integration, Houston seed partners, and how comparable platforms
seeded their first city. Every claim carries a source; "could not verify" is said in place.

**The constraint everything below respects.** `seed-catalogue.md`'s honesty rule: on `keepsake.ing`
every listing must be an object in somebody's house that a real person will hand over. Turnstile
enforces it — there is no unattended path to production. So distribution channels are for
*listings that already exist*; the seed has to come from people.

---

## 1. Facebook: the Free category, and what is actually possible

### Why Houston's Free tab is empty — unresolved, not settled

- **Confirmed:** Meta shipped a large Facebook redesign around 2026-08-08; since March 2026 new
  Marketplace sellers must pass government-ID verification before listing; since ~April 2026
  new or low-trust seller accounts sit in a probationary tier (capped listings, held for review).
  All of this is account-level, not Texas-level. Marketplace itself is not documented as
  unavailable anywhere in the US.
- **Unverified:** one Medium post claims the Free category "is disappearing gradually" on mobile
  as Meta shifts toward "AI-driven discovery." No Meta statement, news report or reproducible
  pattern corroborates it. No independent report of the exact "No free items available in your
  area" message as a known bug or rollback was found.
- **Not related:** the EU "unbundling" (Marketplace dropped from DMA gatekeeper list April 2025;
  designation annulled June 2026) concerns business-vs-consumer listings in the EEA only.

Read: plausibly a caching/geofence hiccup or thin supply that day. Retest from a second account
and from the web before assuming a policy. Either way it does not change the plan, because:

### There is no legitimate programmatic route into Marketplace or Groups

| Route | Status 2026 | Usable by Keepsake? |
|---|---|---|
| Marketplace listing API | Never existed; Marketplace is consumer-to-consumer | No |
| Commerce Manager catalog → Marketplace | Built for paid, shippable e-commerce; Meta removed auto/real-estate inventory in Jan 2023 to keep business listings out of the private-party feed; no evidence $0 items are supported | No |
| Marketplace Partner Program | Feb 2025, **EEA-only**, approved classifieds businesses (eBay, Catawiki…) — an antitrust remedy | No |
| Groups API (`publish_to_groups`) | Discontinued 2024-04-22 (Graph v19) | No |
| Pages API | Still works: schedule/publish posts to a Page you own | **Yes** — a Keepsake Page mirroring approved listings |
| `sharer.php` + Open Graph tags | No auth, no API key; the listing page's OG tags control the card | **Yes** — a "Share to Facebook" button on every item page |
| Auto-poster browser extensions / scrapers | Banned by Meta's automated-collection terms; 2026 enforcement reported as portfolio-wide (profile + Page + ad account) | No — the risk is the operator's personal account |

### Houston gifting groups (names confirmed; member counts not — Facebook login-walls the fetch)

Buy Nothing Montrose and Midtown Houston · Buy Nothing Montrose – Houston · Buy Nothing Heights
(Northeast)/Lindale · Buy Nothing Bellaire/Maplewood · Buy Nothing Houston · Buy Nothing Spring
Branch · FreeStuff The Woodlands · Buy Nothing Kingwood · Original Free Things Houston. Named
groups for Sugar Land, Katy, Pearland, West U, Cypress, Clear Lake were **not** found by search;
a logged-in Facebook search is needed for those and for counts. Group IDs are in the sources.

Rules, universal across the format: no selling/bartering, no business promotion, moderators
delete external links, "gifter's choice" is a norm not a feature. **No Houston group was found
that permits external links.** Assume a link ban per group until its rules tab says otherwise.
Since the late-Oct-2025 trademark takedowns, many groups run under renamed banners and are, per
`market-research.md` §3, annoyed at the Buy Nothing app — a warm audience, not a channel.

### Facebook playbook for one operator

1. Join the Houston groups as a person; post individual keepsakes as normal member activity,
   story in the post text, link only where the rules allow. Zero ToS risk, does not scale.
2. Run a Keepsake **Page** that mirrors approved listings (Pages API is the one compliant
   automation). Modest reach; durable; safe.
3. Put a share button on every item page. Let givers and requesters carry listings into their
   own groups — that is the one route into a Group that Meta still permits.
4. Do not touch catalogs, partner programs or extensions for this use case.

---

## 2. The other channels, ranked

| Channel | Automatable, legitimately | Houston reach | Fit for free + sentimental | ToS risk | Notes |
|---|---|---|---|---|---|
| **Nextdoor Free Finds** | No — manual per item; Search API is read-only beta, Public Agency Feed API is for governments; Business Pages not shown to list into For Sale & Free | **High — Houston's free page is live with real listings** (unlike Facebook's) | High — browsable without account, photo-first | Low manual; high scripted | The best manual channel today. Nextdoor requires true identity; posting "on behalf of" needs proof of affiliation |
| **Craigslist Houston `free`** | No — bulk posting interface is case-by-case, high-volume, **paid categories only**; ToS bans scripts | Medium-high — ~200 active listings with real turnover on the day checked | Medium — anonymous email relay matches Keepsake; no story field | High if automated or linked; low if manual and linkless | URLs are stripped/flagged in free posts |
| **Freecycle Houston** | No — member-only, volunteer-moderated | High — **Houston Town group: 16,380 members**, plus Houston-Westchase and Heights/Montrose groups | Medium — free-only ethos, keyword feed | Low | Post per group; some ask a day's wait before reposting elsewhere |
| **Trash Nothing** | **Read: yes** — public API v1.4 (`/posts`, `/posts/search` by lat/lng/radius, `api_key` param). **Write: could not verify** — a search summary claimed OAuth + CRUD; the OpenAPI spec I fetched exposes only GET | High — federates the Freecycle groups above | Medium | Low (read) | Keepsake could *read* nearby free listings; publishing in is unconfirmed |
| **OfferUp** | No public posting API | Unverified for Houston | Low-medium — sale-first | Medium | Price 0 auto-labels "Free"; ~200 free postings/month cap is a fee limit, not a $0 ban |
| **Freebie Alerts** (aggregator) | No self-serve source submission found; it scrapes Nextdoor, Craigslist, Marketplace, OfferUp, Trash Nothing | High, indirectly, if it chose to scrape Keepsake | High conceptually | n/a | Becoming a source is their decision; a clean public feed makes it cheap for them |
| **Reddit r/houston** | No | Medium-high, but no r/HoustonFree found | Low-medium | Medium-high | Rules page 503'd; assume self-promo limits |
| **Karrot** | n/a | **Likely none** — NA presence is Toronto/Vancouver/NYC | n/a | n/a | |
| **Self-hosted JSON-LD/RSS feed** | **Yes** — fully Keepsake's | Low today — no aggregator confirmed to ingest it | High | Low | Prerequisite for any of the above ever indexing Keepsake |
| **Google Merchant Center** | Policy-excluded | n/a | Low | n/a | `price: 0` allowed only for physical-goods *subscriptions* in listed categories; "free listings" means unpaid placement, not $0 goods |

**Read across the table.** Nothing accepts a machine-pushed free listing from a third party.
Every channel with reach is a human posting one item at a time. The only build that pays back is
on Keepsake's side: `schema.org/Product` + `Offer` (`price: 0`, `availability` flipping on
choose, `PostalAddress` at postcode granularity, never the giver) on every item page, a JSON/RSS
feed of approved listings, and share buttons — so that a person, a scraper, or a search engine can
carry a listing outward without Keepsake touching anyone's ToS.

---

## 3. Houston seed partners

Full tables with contact routes are in the research pass; this is the ranked cut. Names appear
only where a public source names them. Phone numbers were deliberately left in the sources
(NASMM directory, company sites) rather than copied here.

### Top ten to contact first

| # | Who | Why | Meetup |
|---|---|---|---|
| 1 | **Steve Stelzer**, City of Houston Green Building Resource Center — coordinates the **Transition Houston Repair Café** series at HCPL branches | Recurring, public, library-hosted events where people already bring sentimental objects they are deciding about. A named, reachable public contact | High — the events exist; ask for a table |
| 2 | **Gallery One Estate Sales & Auctions** (Conroe/Houston), founder Keesha (surname not public) | States post-sale leftovers are donated. The leftover pile after an estate sale is the single clearest seed | High — already hands over household goods daily |
| 3 | **Gina Powell**, Caring Transitions of Houston Metro & Sugar Land | Senior downsizing + liquidation in one business; on record with press | High |
| 4 | **Leo Brito**, Zero Waste Houston | Founder-led reuse brand with Houston Food Bank partnership; plausible first co-promotion partner and launch quote | Medium |
| 5 | **Samantha "Sammie" Davis**, Think Outside the Closet | Houston professional organizer already blogging donation-pickup routes; a natural early lister | Medium |
| 6 | **Blue Moon Estate Sales – NW Houston** | Standing charity relationships for unsold items (Montgomery County Women's Center, Days for Girls, Creative Outreach Ministries); ask for the sentimental-but-unsellable pieces | Medium — cleanout crews on site |
| 7 | **Courtney Hoffman**, A Changing Home (NASMM member) | Hands-on senior moves; the in-home "what do we do with this" moment | High |
| 8 | **Becky & Mark Hamilton**, Hamilton Transitions (NASMM, Houston/Sugar Land) | Same | High |
| 9 | **Houston Furniture Bank** | High daily donation volume with scheduled pickups; ask about items they cannot place | High infra, mission fit uncertain |
| 10 | **Habitat for Humanity ReStore Houston** (2 stores + NW Harris Co.) | Same logic; pickup infrastructure exists (ReSupply partnership elsewhere) | Same |

### The rest of the bench

- **Senior move managers (NASMM, Houston):** Gulf Coast Moves (Laurie Maggio), New Thresholds
  (Ellen Voigt & Katherine Rush), AmareVida Move Managers (Tiffany Craig & Ryan Beals, Kingwood;
  also runs New Chapter Estate Sales). NAPO Houston chapter: ~30 organizers; current officers
  could not be verified (chapter page errored).
- **Estate sale operators, owner names not public:** Elite Estate Sales (Spring), My Estate to
  Liquidate (Katy), and ~12 more on the EstateSales.net Houston directory (Margie Beegle, LK,
  Judy Robinson Gallery, Texmax, HTX Estate Sales, River Oaks Estate Sales, Town and Country…).
  Pattern across all sources: unsold sentimental items go to charity or junk removal after the
  sale — that moment is the seed.
- **Referral partners rather than suppliers:** The Heritage Society (turns away most offered
  heirlooms via a donation-review form), Clayton Library Friends (family papers it cannot
  accession), Houston History Alliance (connector to dozens of history orgs). Each could point a
  declined donor at Keepsake.
- **Grief and hospice:** Houston Hospice bereavement program; Three Oaks Hospice's "Memory Box"
  program. Mission-aligned, not logistics-ready; approach with care and no volume expectation.
- **Standard charity intake with pickup:** St. Vincent de Paul Houston, Salvation Army, Purple
  Heart Foundation, Arms of Hope.
- **Adjacent nonprofit:** Magpies & Peacocks (textile upcycling design house, new storefront).
- **Not found, and searched for:** a Houston startup founder squarely in decluttering, vintage
  resale, or memory-preservation-with-rehoming (InnovationMap, HBJ, Houston Exponential). That is
  a gap in the market, not in the search. Also unverified: current admins of the Houston Buy
  Nothing and Freecycle groups (the one named Freecycle moderator is from a 2005 article), The
  Houston Clothing Swap's organizer, any Houston library "keepsake swap" (Austin's is the nearest
  analog).

### Venues for many handoffs in one place

HCPL Repair Café dates (recurring, free, indoor) · Sweet Salvage monthly market at POST Houston ·
The Houston Flea Market · Cole's Antique Village (weekly, 1,300+ vendor spaces) · Urban Harvest
Saturday Farmers Market (vendor interest form; no gifting precedent) · a library room or church
hall (the format every "Free Store" precedent uses, because it needs no city permit).

---

## 4. What the precedents say about the first 90 days

- **Nobody seeded with a script; several seeded with a group.** Buy Nothing (one Facebook group,
  2013-07-07, the founders' own households), Geev ("Adopte un objet" Facebook group a year before
  the app), Bunz (private FB barter group → 12,000 members in ~18 months → app), Craigslist
  (a 240-address email list for a year before a site). Olio 1.0 was a WhatsApp group of 12
  neighbours in one postcode for two weeks. Freecycle's first email went to 30–40 friends and
  "snowballed from 60 to 800 members overnight."
- **One district first.** Karrot launched to Pangyo Tech Valley IT workers only (2015) and went
  national in 2018. Nextdoor treated each neighbourhood as "its own tiny startup" and mailed
  USPS-verified postcards to the un-signed-up neighbours. Olio: one North London borough.
- **The founder's own labour beat every ambassador programme.** Airbnb's founders rented a camera
  and re-shot New York listings door to door; bookings doubled. Etsy sold sellers in person at
  craft fairs. Poshmark and Depop ambassadors get recognition, early access and event hosting,
  never money. Olio's Food Waste Heroes are a *supply* volunteer force, added in year two.
- **Supply partners want three things:** pickup within hours to ~48h, a paper receipt, and no
  negotiation. Dignity and speed over price — which is Keepsake's model already. Habitat
  ReStore outsourced residential pickup to ReSupply for exactly this; EBTH is a paid consignment
  relationship, not a donation one.
- **Cross-posting the same item is discouraged inside a platform, undocumented across them.**
  Freecycle requires one post per Town group and some groups ask a day's wait; Buy Nothing's rule
  is "one group, the most local." No platform's terms ban a user from also listing on a rival
  site. The real cost is social: whoever is chosen first must be told, and givers call that
  awkward. A visible "also offered on…" note on the Keepsake listing would make it honest.
- **Turnout numbers for pop-up formats could not be verified** (Really Really Free Markets,
  Swap-o-rama-rama, Buy Nothing bazaars). Indoor hosted venues avoid permits; outdoor public
  space invites them.

### Ten tactics, ranked by listings per operator hour

1. **Call the estate-clearance and senior-move people in §3 first.** One call to a business that
   sorts a "won't sell, won't dump" pile every week can yield a dozen photographed items in a
   sitting, and it is the estate bulk flow's intended user.
2. **Photograph and write up 15–20 of your own and family's keepsakes in one weekend.** The
   Airbnb move: prove the product before asking anyone else to trust it.
3. **Post by hand into the renamed Houston gifting groups**, story in the text, a link only where
   rules allow. Minutes per group per week; warm, local audience.
4. **Cross-post single sentimental items to Nextdoor Free Finds and Craigslist free**, disclose it,
   pull the others once a requester is chosen. Drop it once Keepsake has its own liquidity.
5. **One give-away afternoon at an HCPL Repair Café or a library/church room.** Demo the
   phone-photo-and-post flow on the spot; 10–30 listings in an afternoon; not a daily lever.
6. **Ask 3–5 friends to list 5 items each.** The literal Buy Nothing/Olio origin.
7. **A standing "leftover lot" arrangement with one estate-sale company** — slower to set up
   than #1, compounds weekly.
8. **A regular Nextdoor post cadence** in the operator's own neighbourhood.
9. **Ask Houston Furniture Bank / ReStore about overflow they decline.** Uncertain payoff, slow
   cycle.
10. **An outdoor free-market event** — highest single-day ceiling, highest setup; month 2–3.

---

## 5. What this asks of the product (open, not decided)

Each is a `product-decisions.md` row if taken. None is a workaround of the honesty rule.

1. **Share buttons + Open Graph on item pages** (Facebook sharer, X, WhatsApp, copy link). The
   one route into Facebook Groups that Meta still permits is a person sharing. OG tags already
   exist (`seo-audit.md`); the button does not.
2. **`schema.org/Product` + `Offer` with `price: 0` and a public JSON/RSS feed of approved
   listings.** Nobody will ingest it on day one; it is the precondition for Freebie Alerts, Trash
   Nothing or a search engine ever doing so, and it costs one route. Postcode-level geo only.
3. **An "also offered elsewhere" flag on a listing**, shown to requesters. Cross-posting is the
   cheapest early tactic and the one with a social cost; disclosure is what makes it honest.
4. **A Keepsake Facebook Page mirror** via the Pages API. Small, compliant, schedulable. Decide
   whether the Page posts every approved listing or a daily digest.
5. **Reading Trash Nothing's API for Houston** — not to republish, but to know what free supply
   looks like nearby and whether Keepsake's sentimental slice is real. Read-only, `api_key`.
6. **An operator-side "post on behalf of a partner" path** for the estate partners in §3: the
   giver is a business owner clearing a client's house, the handoff is real. `seed-catalogue.md`
   already names the shape (an admin-authenticated create route) and says nobody has asked for
   it. If #1–#3 in §4 land, someone will.

---

## 6. Sources

**Facebook.** [Facebook redesign, Aug 2026 (GCN)](https://gcn.com/facebook-overhauls-feed-redesign-five-changes/20667/) ·
[Marketplace restrictions 2026 — ID verification, probation (CARVID, secondary)](https://www.carvidapp.com/dealer-questions/why-is-my-facebook-marketplace-account-restricted/) ·
[Why Marketplace isn't available (Red Sand)](https://www.redsandmarketing.com/why-dont-i-have-facebook-marketplace/) ·
["Free Stuff category is gone" (Medium, unverified)](https://medium.com/@goldenv_37344/the-free-stuff-loophole-that-made-facebook-marketplace-so-good-for-flipping-is-gone-a5e5cc381038) ·
[EU gatekeeper list (MLex)](https://www.mlex.com/mlex/amp/articles/2326780) · [EU court, June 2026 (Euronews)](https://www.euronews.com/next/2026/06/03/eu-court-partially-sides-with-meta-in-a-blow-to-the-european-commission) ·
[Meta on the EC decision](https://about.fb.com/news/2024/11/our-response-to-the-european-commissions-decision-on-facebook-marketplace/) ·
[No Marketplace API (SociaVault)](https://sociavault.com/blog/facebook-marketplace-api-alternative) ·
[Auto/real-estate catalog listings ended (Click Here Digital)](https://www.clickheredigital.com/insights/is-facebook-discontinuing-marketplace-vehicle-listings) ·
[Marketplace Partner Program, EEA (AIM Group)](https://aimgroup.com/2025/05/27/vendoras-classified-listings-available-on-facebook-marketplace/) ·
[Groups API discontinued (Smash Balloon)](https://smashballoon.com/doc/facebook-api-changes-affecting-groups-april-2024/) · [TechCrunch](https://techcrunch.com/2024/02/05/meta-cuts-off-third-party-access-to-facebook-groups-leaving-developers-and-customers-in-disarray/) ·
[Pages API still works (Multiple Group Poster)](https://multiplegroupposter.com/blog/facebook-groups-api-discontinued/) ·
[Automation enforcement 2026 (BrowserAct)](https://www.browseract.com/blog/why-facebook-suspended-my-account--how-to-fix-it) ·
Houston groups: [Montrose & Midtown](https://www.facebook.com/groups/296183082349486/) · [Montrose](https://www.facebook.com/groups/920831092573800/) · [Heights NE/Lindale](https://www.facebook.com/groups/1616039968676434) · [Bellaire/Maplewood](https://www.facebook.com/groups/530596077080857/) · [Buy Nothing Houston](https://www.facebook.com/groups/505206923368862/) · [Original Free Things Houston](https://www.facebook.com/groups/freethingshouston/) ·
[Click2Houston on Houston free-exchange groups, 2025-05-23](https://www.click2houston.com/news/local/2025/05/23/families-save-thousands-through-houstons-free-exchange-groups/) ·
[Buy Nothing group finder](https://buynothingproject.org/facebookgroups) · [Buy Nothing rules (The Cool Down)](https://www.thecooldown.com/green-home/buy-nothing-groups-facebook-rules/) · [Buy Nothing 10 Rules](https://buynothingproject.org/10-rules)

**Other channels.** [Nextdoor Free Finds press release](https://about.nextdoor.com/press-releases/nextdoor-expands-its-buy-sell-and-give-feature-with-the-launch-of-free-finds) · [Free Finds Houston](https://nextdoor.com/marketplace/houston--tx/free/) · [Nextdoor For Sale & Free help (503 on fetch)](https://help.nextdoor.com/s/article/Best-practices-For-Sale-Free?language=en_US) · [Nextdoor Search API](https://developer.nextdoor.com/docs/overview-copy-1) · [Nextdoor Public Agency Feed API](https://developer.nextdoor.com/docs/trending-posts-api-copy) · [Nextdoor Business Page](https://business.nextdoor.com/en-us/getting-started/business-page) · [Nextdoor ad policy](https://business.nextdoor.com/en-us/nam/nextdoor-ads-manager/ad-policy) ·
[Craigslist terms](https://www.craigslist.org/about/terms.of.use/en) · [Craigslist bulk posting interface](https://www.craigslist.org/about/bulk_posting_interface) · [CL bulk API summary (Redwood)](https://www.redwoodtechnologysolutions.com/all-you-need-to-know-about-craigslists-bulk-posting-api/) · [Craigslist posting fees](https://www.craigslist.org/about/help/posting_fees) · [Craigslist Houston free](https://www.craigslist.org/search/area/houston?cat=zip) · [CL link guidance (Chron)](https://smallbusiness.chron.com/craigslist-guidelines-28291.html) ·
[Trash Nothing developer (403 on fetch)](https://trashnothing.com/developer) · [Trash Nothing OpenAPI v1.4](https://trashnothing.com/api/v1.4/trashnothing-openapi.yaml) · [Trash Nothing Houston free](https://trashnothing.com/houston-free) ·
[Freecycle Houston Town group](https://freecycle.org/town/HoustonTX/info) · [Freecycle multi-Town posting](https://freecycle.helpscoutdocs.com/article/137-post-to-multiple-town-groups) · [Freecycle moderator manual](https://wiki.freecycle.org/Moderator_Manual:Common_Issues) ·
[OfferUp free listing limits](https://help.offerup.com/hc/en-us/articles/13072929390228-About-free-listing-limits) · [Freebie Alerts](https://freebiealerts.app/) · [Reddit giveaway norms (secondary)](https://rdtpicker.com/blog/reddit-giveaway-rules) ·
[Google Merchant Center price attribute](https://support.google.com/merchants/answer/6324371) · [Google free listings](https://support.google.com/merchants/answer/13889434) · [Google merchant-listing structured data](https://developers.google.com/search/docs/appearance/structured-data/merchant-listing) ·
[Marketplace cross-posting etiquette (Hopewell Homestead)](https://thehopewellhomestead.substack.com/p/the-unofficial-guide-to-facebook)

**Houston partners.** [Gallery One — about](https://galleryoneestatesales.com/about-us/) · [Gallery One FAQs](https://galleryoneestatesales.com/faqs/) · [Blue Moon NW Houston](https://bluemoonestatesales.com/nwhouston/) · [Elite Estate Sales](https://www.eliteestatesalesinc.com/) · [My Estate to Liquidate](https://myestatetoliquidate.com/houston-estate-sale.html) · [EstateSales.net Houston companies](https://www.estatesales.net/companies/TX/Houston) · [HomeLight Houston estate sale companies](https://www.homelight.com/blog/estate-sale-companies-houston/) ·
[Gina Powell, Caring Transitions (Voyage Houston)](https://voyagehouston.com/interview/meet-gina-powell-caring-transitions-metro-houston-central-houston/) · [NASMM Texas directory](https://www.nasmm.org/find-a-move-manager/list/?state=TX&country=US) · [Sencarta Houston senior move managers](https://sencarta.com/senior-move-manager/houston-tx) ·
[Samantha Davis, Think Outside the Closet (Voyage Houston)](https://voyagehouston.com/interview/meet-samantha-davis-of-think-outside-the-closet/) · [her donation-pickup post](https://www.thinkoutsidetheclosethouston.com/blog/easy-donation-pickup-local-services-for-hassle-free-giving) · [NAPO Houston](https://www.napo.net/page/houston) ·
[Houston Furniture Bank](https://houstonfurniturebank.org/get-involved/donate-items/) · [Houston Habitat ReStore](https://www.houstonhabitat.org/restore/) · [Habitat pickup](https://www.habitat.org/stories/does-habitat-offer-furniture-donation-pickup) · [ReSupply partnership (Habitat Portland)](https://habitatportlandregion.org/restores-pick-up-partnership-makes-donating-items-simple-and-easy/) ·
[Zero Waste Houston (Community Impact)](https://communityimpact.com/houston/the-woodlands/business/2025/08/19/zero-waste-houston-turns-food-scraps-into-compost-for-greener-communities/) · [Houston Food Bank partnership](https://www.houstonfoodbank.org/blog/houston-food-bank-partners-with-zero-waste-houston-to-continue-sustainability-efforts/) ·
[Houston Repair Café (Code Green Houston)](https://www.codegreenhouston.org/houstons-repair-cafe) · [HCPL Repair Café schedule](https://hcpl.net/news/reduce-reuse-recycle-and-repair-hcpls-2025-repair-cafe-schedule-announced/) ·
[Houston Freecycle 2005 profile (Chron)](https://www.chron.com/life/article/Freecycle-makes-one-man-s-trash-another-s-treasure-1654646.php) ·
[Houston Hospice bereavement](https://www.houstonhospice.org/what-we-do/services/bereavement-support/) · [Three Oaks Hospice](https://www.threeoakshospice.com/hospice-grief-and-bereavement/) · [Heritage Society donations](https://www.heritagesociety.org/collection-donations) · [Clayton Library Friends](https://claytonlibraryfriends.org/about-us) · [Houston History Alliance (TSHA)](https://www.tshaonline.org/handbook/entries/houston-history-alliance) · [Houston charities that pick up (CultureMap)](https://houston.culturemap.com/news/city-life/08-14-19-charities-houston-pick-up-donations-from-home/) ·
[Magpies & Peacocks (InnovationMap)](https://houston.innovationmap.com/houston-nonprofit-thats-upcycling-textiles-and-clothing-opens-new-store-2638586623.html) ·
[Houston flea markets (Houston on the Cheap)](https://www.houstononthecheap.com/flea-markets-in-houston-tx-local-market/) · [Urban Harvest Saturday market](https://www.urbanharvest.org/farmers-market/saturday/)

**Cold-start precedents.** [Buy Nothing at 10 (Seattle Times)](https://www.seattletimes.com/life/on-buy-nothings-10th-anniversary-10-tales-of-gratitude-and-community/) · [NPR](https://www.npr.org/transcripts/613270172) · [DCist](https://dcist.com/story/23/02/21/buy-nothing-capitol-hill-take-my-sht-group-drama/) · [Buy Nothing academy, events](http://buynothingproject.org/academy/lesson4) ·
[Tessa Clarke interview (Mintel)](https://www.mintel.com/insights/food-and-drink/female-founded-an-interview-with-tessa-clarke-ceo-and-co-founder-of-olio/) · [Olio nationwide (The Flexitarian)](https://theflexitarian.co.uk/eco-lifestyle/green-living/olio-app-the-food-sharing-revolution-now-available-nationwide/) · [Food Waste Heroes](https://olioapp.com/business/food-waste-heroes-programme/) ·
[Geev at 7 (Kedge)](https://entrepreneurship.kedge.edu/actualites/geev-7-ans) ·
[Nextdoor launch](https://about.nextdoor.com/press-releases/corporate-announcements/nextdoor-launches-the-first-private-social-network-for-neighborhoods) · [Nextdoor invitation teardown (CloudSponge)](https://www.cloudsponge.com/blog/nextdoor-invitation-experience-teardown/) · [Nextdoor postcard](https://swiped.co/file/postcard-referral-invite-from-nextdoor/) ·
[Craig Newmark story](https://lmot.substack.com/p/craigslist-founder-craig-newmark-story) ·
[Bunz origin (BetaKit)](https://betakit.com/how-bunz-transformed-from-a-grassroots-community-to-an-up-and-coming-startup/) · [Bunz (The Logic)](https://thelogic.co/news/the-big-read/trading-places-how-bunz-went-from-cashless-bartering-community-to-cryptocurrency-flameout/) ·
[Karrot origin (KoreaTechDesk)](https://koreatechdesk.com/korean-startup-danggeun-markets-app-karrot-for-second-hand-goods) ·
[Freecycle background](https://wiki.freecycle.org/Background) · [Trash Nothing (Green Talk)](https://www.green-talk.com/trashnothing-reduces-freecycle-email-clutter-without-losing-the-deal/) ·
[Etsy history (Speedwell)](https://www.speedwellmemos.com/p/etsy-business-history) · [Airbnb photography (Product Habits)](https://producthabits.com/how-two-designers-created-airbnb-and-turned-it-into-a-30-billion-company/) · [Bloomberg](https://www.bloomberg.com/features/2017-uber-airbnb-99-billion-idea/) · [Posh Ambassador benefits](https://www.frompenniestoplenty.com/blog/poshmark-ambassador-benefits) · [Depop ambassadors](https://www.valueaddedresource.net/depop-launches-ambassador-program/) · [EBTH about](https://www.ebth.com/about/) ·
[Really Really Free Market](https://en.wikipedia.org/wiki/Really_Really_Free_Market) · [Organizing one (rabble.ca)](https://rabble.ca/economy/organizing-really-really-free-market/) · [How to start a free store (Shareable)](https://www.shareable.net/how-to/how-to-start-a-free-store-in-your-community/) · [Central Lutheran Free Store](https://www.centralmpls.org/free-store/)

Grokipedia pages were used by one research pass for Buy Nothing, Olio and Craig Newmark; each
claim from them is corroborated above by a primary or press source.
