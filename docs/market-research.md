# Market context and competitor research — 2026-09-09

What Keepsake is, in the terms that matter competitively; who else is in the free-gifting and
"objects with a story" space in the US and Canada; where Keepsake is genuinely alone; and where it
is exposed. Written from the repository at HEAD plus public sources fetched on 2026-09-09. Every
external number is attributed; where a page could not be reached or two sources disagree, that is
said in place rather than smoothed over.

Companion to [`product-decisions.md`](./product-decisions.md): that file records why Keepsake is
shaped the way it is, this one records what it is shaped *against*. Before reopening a decision
because "competitor X does it differently," read both.

---

## 1. Keepsake, as a competitor would see it

From `README.md`, `AGENTS.md`, `docs/design/*` and `docs/product-decisions.md`:

| Trait | Keepsake today | Why it matters competitively |
|---|---|---|
| **Free only** | No prices, no bidding, no reservations. `terms.html`: "Gifting only, never sales." Estate bulk upload keeps this. | Puts it in the Buy Nothing / Freecycle ring, not the Marketplace ring. |
| **No accounts** | Giver = device-bound secret token + a (now mandatory) email used only for notifications and recovery. Requester = a note + an email, confirmed before it reaches the giver. | Every direct competitor requires signup to post *and* to ask. Most require it to browse. |
| **Browse without anything** | Root domain *is* the feed. Postcode + radius over US and Canada from a bundled GeoNames table. | Only Nextdoor Free Finds, Craigslist, Kijiji and Trash Nothing's web view come close. |
| **Story-first** | One line of the story in Fraunces italic is the load-bearing element of every card ("what makes the feed feel like a collection of stories rather than a marketplace grid"). Story min 20 chars, enforced at submission. | No free-gifting platform surfaces provenance. The platforms that do (Artifcts, Heirloominary) don't rehome. |
| **Giver chooses** | Multiple people can say "I'd love this"; the giver reads the notes and picks one. Contact reveals only on choose, both directions. | Buy Nothing groups do this socially ("gifter's choice"); no app enforces it as the mechanic. |
| **Pre-screened by models, held for a human** | Llama Guard text + vision pass; borderline → `needs_review`; fail-closed. Three reports auto-hide. One human (Kiarash) clears the queue. | Incumbents rely on volunteer admins (Buy Nothing, Freecycle, Freegle/Trash Nothing) or platform-scale ML (Facebook, Nextdoor). Nobody small does model-first + human-hold. |
| **Search** | FTS5 + semantic (Vectorize) with aspect shelves; category assigned by the model. | Freecycle/Trash Nothing are keyword-and-group; Buy Nothing 3.0's location filtering was broken at launch. |
| **Estate mode** | Bulk upload: drafts outside `listings`, many items across several sittings, still free. API + web screens exist; not yet driven by a real person. | No free platform has an estate flow. The estate platforms (MaxSold, EBTH) are auctions. |
| **Web only, no messaging** | Static Expo export; contact is an email relay, not in-app chat. No native app yet. | Every competitor except Craigslist/Kijiji leads with a native app and in-app chat. |
| **Geography** | US + Canada (CA at FSA granularity). UK geo-blocked on purpose (Online Safety Act). | Freegle, Olio and Trash Nothing's densest communities are UK; Geev is France, Givore is Spain. The US/CA free-only field is thinner than it looks from Europe. |
| **Operator** | One person, sole proprietorship, Cloudflare bill, no VC. | Same shape as Trash Nothing (one owner, 13 years) and Bunz (one owner, dying). Not the same shape as Olio ($51M raised) or Buy Nothing (PBC with a paid tier). |

Categories (`packages/contracts/src/category.ts`): books & letters, jewelry & watches, clothing &
accessories, home & kitchen, furniture & decor, photos/art/handmade, toys & games, sport &
outdoors, tools & DIY, electronics, music & instruments, other. The first, second and sixth of
those are where "sentimental" lives; the rest overlap fully with every general free-stuff feed.

---

## 2. The landscape in three rings

```
                     ┌──────────────────────────────────────────────┐
                     │  Ring 3 · "objects with a story" (no rehoming)│
                     │  Artifcts · Heirloominary · Heriteo ·         │
                     │  Heirloom Vault · Remento/StoryWorth          │
   ┌─────────────────┴──────────────────────────────────────────────┴───────────────┐
   │  Ring 2 · general local marketplaces with a Free section, and their aggregators │
   │  Facebook Marketplace + local Facebook gifting groups · Craigslist "free" ·     │
   │  Nextdoor Free Finds · Kijiji Free Stuff (CA) · Karrot · OfferUp ·              │
   │  Freebie Alerts (aggregator) · MaxSold / EBTH (estate, paid)                    │
   │   ┌─────────────────────────────────────────────────────────────────┐          │
   │   │  Ring 1 · free-only gifting platforms                            │          │
   │   │  Buy Nothing (app + trademark) · Freecycle · Trash Nothing /     │          │
   │   │  Freegle · Olio · Geev (FR) · Givore (ES) · Bunz (cashless trade)│          │
   │   │                        ┌──────────┐                              │          │
   │   │                        │ Keepsake │  free + no accounts + story  │          │
   │   │                        └──────────┘                              │          │
   │   └─────────────────────────────────────────────────────────────────┘          │
   └────────────────────────────────────────────────────────────────────────────────┘
```

Keepsake is the only thing that sits in Ring 1 *and* Ring 3 at once. That is the position; the
rest of this document is about whether anyone can take it and whether it is worth having.

---

## 3. Ring 1 — free-only gifting platforms

### Buy Nothing Project (app + Facebook groups)

- **What.** Started 2013 on Bainbridge Island as Facebook groups with a hyperlocal "gift economy"
  ethos (gives, asks, gratitude; "gifter's choice"). Standalone app since 2022, now a Public
  Benefit Corporation. **Buy Nothing 3.0** launched the week of 2026-01-19 with a Gives/Asks
  toggle and a rebuilt feed.
- **Scale.** Self-reported "14M+ members, 50+ countries"; Wikipedia's figure is 7.5M across 4,000+
  volunteer-led groups. Either way most of that is Facebook, not the app: the US App Store shows
  **~2.1K ratings** (4.3★) as of 2026-09-02's v3.1.5.
- **Model.** Free tier: unlimited gives/asks, one location, basic messaging. **Paid**: Sustaining
  Member ($5.49/mo or $54.99/yr) and a newer **Buy Nothing Pro** ($3.99 / $29.99 in-app prices)
  gating extra saved locations, a 100-mile radius, post bumps, saved searches/wishlists, group
  messaging and a Pro badge.
- **2025–26 state.** Two self-inflicted wounds. (1) **Trademark enforcement, late Oct 2025**:
  independent Facebook groups using "Buy Nothing" were taken down; the 116K-member San Francisco
  group came back as "Buy Not a Thing No Rules San Francisco", others became "Buy Absolutely
  Nothing", "Gifting in the Bay Area", "BN". SF Standard's read: the paid app "struggled attracting
  users, while independent Facebook groups remained popular." (2) **The 3.0 launch was rough**:
  password-reset bug, "Create an Account" shown to existing users, location filter showing other
  cities; store reviews call the update "a million times worse" and complain about a paywall.
- **Moderation.** Volunteer admins per group, with documented burnout ("some administrators have
  quit after about a year, tired of handling personal disputes"). The app's own reporting tools
  are a recurring review complaint.
- **Read for Keepsake.** The biggest brand in the space is currently spending community trust. The
  renamed independent groups are exactly Keepsake's audience, are on Facebook, and are annoyed.
  But the same story is a warning: Facebook groups beat a dedicated app *twice* here (2022 and
  2026) because "Facebook groups serve the purpose well enough" and "getting a lot of people onto
  an app is always hard."

### Freecycle (The Freecycle Network)

- **What.** 2003, Tucson; 501(c)(3). ~5,300 local "Town" groups run by volunteers; posts are OFFER
  / WANTED / TAKEN; email digests plus a web UI and an app (v2.1.7, updated late Aug 2026).
- **Scale.** 11M members, 121 countries (Wikipedia, Dec 2023; the site says 110). Annual budget
  ~$275K from donations, grants, sponsorship and ad royalties.
- **Weaknesses everyone names.** Email-driven workflow feels dated; browsing is slow; no story,
  no photos required historically; group-by-group rather than radius. The official iOS app has
  **2 ratings** on the US store — the audience is on the web and email, not the app.
- **History that rhymes.** 2009 Freegle split (UK moderators vs. central control); lost its
  trademark in 2010 for "naked licensing", regained a narrower one in 2012. Trademark fights are
  apparently an occupational hazard of running a gift economy.

### Trash Nothing (+ Freegle, Full Circles)

- **What.** One-person independent site (Andrew Trusty) since ~2013 that **federates** Freecycle,
  Freegle and its own "Free" groups into a single modern feed: post once to several groups,
  distance filter, map view, in-app messaging. Posts to Freegle groups still go through Freegle's
  volunteer moderators.
- **Scale signals.** iOS app v3.6.4 updated 2026-09-09, **105 ratings, 3.3★**; complaints centre
  on Freecycle credential linking and the app showing fewer items than the email digests. Its own
  "8 best free-stuff apps 2026" guide and help pages **returned 403 to this container**, so the
  member count could not be verified here.
- **Read for Keepsake.** The closest structural twin (solo operator, web-first, radius-based). Its
  survival strategy was to *aggregate* other communities rather than seed its own. Also the
  clearest evidence that a solo-run free-stuff site can last a decade without VC.

### Olio

- **What.** UK, 2015. Food-sharing first; "non-food" (books, clothes, furniture) is a secondary
  section. Mobile only (iOS 16+, Android 7+), no web, 18+, must have an account to do anything.
- **Scale.** ~7M registered users (May 2023), 49–51 countries; **$51.2M raised** (Accel, Octopus,
  VNV). Revenue comes from supermarket surplus-collection contracts (Tesco, Sainsbury's,
  Morrisons, Iceland), not from users.
- **Safety posture worth copying.** Explicit no-contact/doorstep pickup as an option, "keep it
  on-platform", and a **one-way giver-indemnifies-Olio clause** — which Keepsake already adopted
  (`legal-considerations.md`, #63).
- **US/Canada.** "Available anywhere"; no evidence of density in North America. Not a real
  competitor there for non-food.

### Geev (France) and Givore (Spain)

- **Geev** is "#1 app for giving items between individuals in France", free, actively updated
  through mid-2026. **Givore** is a 2025-era Spanish free-only app (Madrid, Barcelona, Valencia)
  with real-time notifications, a map and giveaway-specific chat; its own comparison blog dismisses
  Freecycle and Trash Nothing as "underused"/"weak coverage" in Spain and Wallapop/Facebook as
  lacking "a dedicated giveaway feed."
- **Read.** Dedicated free-only feeds do win at national scale — but each is one country, and none
  has crossed into North America. There is no Geev-of-the-US; the closest is the Buy Nothing app,
  which is stumbling.

### Bunz (Toronto) — the cautionary tale

- **What.** 2013 Facebook bartering group → 2016 app; cashless trading, peaked >120K members; 2020
  crypto (BTZ) pivot triggered an exodus. Rebuilt Dec 2025 with a Silicon Valley design firm.
- **2026.** Owner Firat Eren published DAU daily from May 15: **<200 DAU in June**, mostly
  Toronto. He committed to shut down 2026-09-01 unless any city hit 1,000 DAU. **Outcome after the
  deadline could not be confirmed** from sources reachable today; BetaKit's last report ("The
  problem is not Bunz. The problem is me.") was pre-deadline.
- **Read.** A no-cash community app with a beloved brand, a fresh redesign and a decade of history
  could not hold 200 daily users in Canada's largest city. Design quality and mission were not the
  constraint; trust and liquidity were.

---

## 4. Ring 2 — general marketplaces with a Free section, and aggregators

| Platform | Free-items mechanic | Account needed to browse? | to contact? | Geography | Notes (2026) |
|---|---|---|---|---|---|
| **Facebook Marketplace** | Price = $0 filter; plus thousands of local gifting groups (formerly "Buy Nothing", now renamed) | Mostly yes | Yes | Global | Stats sites claim ~1.2B MAU (unverified). Where the liquidity actually is. Scam guidance is safety-tips content, not enforced. |
| **Craigslist "free"** | Dedicated `/zip` (free) section per city | No | No (anonymised email relay) | US/CA | ~50M US monthly users, down from 80M in 2015 (secondary source). Still cited as leading for free and large/odd items. Closest to Keepsake's *no-account, email-relay* mechanic. |
| **Nextdoor Free Finds** | Free-only view of the "Finds" marketplace, launched June 2021 | **No** — explicitly browsable by non-members | Yes | US, CA, UK, EU, AU | At launch ¼ of Finds listings were free. 2025–26 platform pivot is toward a news/alerts feed and AI search; Finds is not the headline. Moderation: neighbour reports + volunteers + ops team + automation. |
| **Kijiji "Free Stuff"** (CA) | A category | No | Yes | Canada | Low thousands of national listings on the day checked (two Kijiji pages disagreed: 749 vs 6,472). The default Canadian answer to "where do I give this away." |
| **Karrot (Daangn)** | None distinct — "type 'free' in search" | Yes | Yes | NA launch: Toronto, Vancouver, NYC | 30M+ users globally, super-app ambitions (jobs, real estate, payments). Buy/sell first. |
| **OfferUp** | $0 listings | Yes | Yes | US | Sale-first; aggregated by Freebie Alerts. |
| **Freebie Alerts** (aggregator) | Pulls free listings from Nextdoor, OfferUp, Trash Nothing, Letgo, its own; keyword watchlists | No | Redirects out | US | **245K ratings, 4.8★** on iOS — two orders of magnitude more than any gifting app. $9.99 Gold to remove ads. Last update Mar 2025. |
| **MaxSold / Everything But The House** | Estate *auctions*, most lots from $1 | No | Yes (to bid) | US + CA | Turnkey estate liquidation for a percentage. The only players with an "estate" flow — and it is a sale. |

**Two things this table says.** First, "browse free stuff without an account" is a proven pattern
(Nextdoor, Craigslist, Kijiji), so Keepsake's root-domain feed is not exotic — it is table stakes
for the *browsing* side. Second, the aggregator has the users. Freebie Alerts' rating count says
demand is for *one feed of everything free nearby*, not for a new community to join. Keepsake is
today one more source such a feed does not index.

---

## 5. Ring 3 — the "story" side, none of which rehomes

| Product | What it does | Pricing | Gives things away? |
|---|---|---|---|
| **Artifcts** | Photograph an object, record its story/video, QR-link the physical item to the record. Explicitly markets to downsizers: "the memories will be here even if you rehome, recycle, or donate." | Free ≤5 items; $45/yr; $99/yr pro | **No** — documents, then you dispose elsewhere |
| **Heirloominary** (Seattle, 2026) | Artist Melissa Cable's site: a form for the story and photos of a keepsake, built after her in-laws downsized | Not stated | **No** — stories only |
| **Heriteo** | Family asset catalogue for estate planning; heirs mark Keep / Sell / Donate / No opinion | Free ≤49 objects; paid tiers | No — planning, not transfer |
| **Heirloom Vault** | Online memory book per item, share with chosen people | Free | No |
| **Remento / StoryWorth** | Memory preservation (interviews → books) | Paid | No |

Every one of these has found that people will *write the story* of an object when they are about
to let it go. None of them has a place for the object to go. Artifcts' own copy — "even if you
rehome, recycle, or donate" — is Keepsake's give flow described as someone else's problem.

---

## 6. Feature matrix

`●` yes · `◐` partial · `○` no · `?` not verifiable today

| | Keepsake | Buy Nothing app | FB groups | Freecycle | Trash Nothing | Olio | Nextdoor Free Finds | Craigslist free | Kijiji free |
|---|---|---|---|---|---|---|---|---|---|
| Free-only by design | ● | ● | ● (group rules) | ● | ● | ● | ● (a filter) | ◐ (a section) | ◐ (a category) |
| Browse without account | ● | ○ | ○ | ◐ (web) | ◐ (web) | ○ | ● | ● | ● |
| Post without account | ● | ○ | ○ | ○ | ○ | ○ | ○ | ◐ (email verify) | ○ |
| Story is the primary field | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Giver picks the recipient | ● (enforced) | ◐ (norm) | ◐ (norm) | ◐ (norm) | ◐ | ○ | ○ | ○ | ○ |
| Requests confirmed by email before delivery | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Model pre-screen + human hold, fail-closed | ● | ? | ○ (admins) | ○ (mods) | ○ (mods) | ? | ◐ (automation + ops) | ○ (flagging) | ◐ |
| Postcode radius search, no geocoding API | ● | ◐ (broken at 3.0 launch) | ○ (group boundary) | ○ (group) | ● | ● | ● | ◐ (city) | ● |
| Semantic search | ● | ○ | ○ | ○ | ○ | ○ | ◐ (AI search, US) | ○ | ○ |
| "Asks" / wanted posts | ○ | ● | ● | ● | ● | ● | ○ | ◐ | ○ |
| In-app messaging | ○ (email relay) | ● | ● | ◐ | ● | ● | ● | ○ (relay) | ● |
| Native app | ○ | ● | ● | ● | ● | ● | ● | ○ | ● |
| Estate / bulk flow, still free | ● (untested) | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Paid tier | ○ | ● | ○ | ○ (donations) | ○ | ○ (B2B) | ○ (ads) | ○ | ○ (ads) |
| US + Canada coverage | ● | ● | ● | ● | ◐ | ◐ | ● | ● | CA only |

---

## 7. What is genuinely Keepsake's, and what is exposed

### Whitespace nobody else occupies

1. **Story-first free gifting.** Ring 1 has no provenance; Ring 3 has no handoff. The combination
   is unclaimed in every market checked, not only North America.
2. **Zero-signup on both sides.** No platform lets a stranger both browse and ask without an
   account. Craigslist is the nearest and is email-verified per post. This is the friction
   advantage; it is also why the confirm-then-forward step and the mandatory giver email exist —
   Keepsake pays for no-accounts with email hops instead.
3. **Enforced "giver chooses."** Buy Nothing's culture, as a product mechanic. It is what makes
   the story field *do* something: the note is how a requester earns the object.
4. **Model-first moderation with a human hold, run by one person.** The volunteer-admin model is
   burning out at Buy Nothing and is Freecycle's whole cost base; the platform-ML model needs
   Facebook's budget. Nobody in Ring 1 runs Keepsake's shape.
5. **Estate mode without a sale.** MaxSold and EBTH own "clear a house" and both charge a cut of an
   auction. `bulk-upload.md` is the only free version of that flow found — and it is unshipped.

### Where Keepsake loses today

1. **Liquidity.** Every story in this document — Buy Nothing's app vs. its own Facebook groups,
   Bunz's 200 DAU after a redesign, Freecycle's 2-rating app — says the dedicated app loses to
   wherever the neighbours already are. Keepsake has no groups, no network to federate, and a
   catalogue that, per `seed-catalogue.md`, is partly seeded.
2. **Not indexed by the aggregators.** Freebie Alerts and Trash Nothing are where people who
   want free things nearby actually look. Keepsake's sitemap is for Google; nothing feeds a
   free-stuff aggregator.
3. **No asks, no chat, no app.** Three things every Ring 1 product has. "Asks" in particular are
   half the Buy Nothing feed and the mechanism that makes a group feel alive between gives.
   (`product-decisions.md` records web-only as settled; asks and chat are not decided anywhere.)
4. **The niche might be narrow.** "Sentimental" is Keepsake's differentiator and its ceiling.
   Nine of twelve categories overlap fully with Kijiji's free section, where the story is a
   liability (nobody writes 20 characters about a treadmill). No measurement yet says how much of
   the catalogue is genuinely sentimental versus free-stuff-with-a-required-paragraph.
5. **Single-operator risk is visible to users.** `product-decisions.md` §3 ("nothing wakes
   anyone up") and the moderation "watch" rows are the same exposure Bunz's owner named.

---

## 8. Lessons the 2026 market is offering for free

- **Do not spend trust to monetise.** Buy Nothing's paid tier plus trademark enforcement produced
  renamed groups, angry admins and a 4.3★ app with 2.1K ratings against a claimed 14M community.
  Keepsake has no paid tier; `product-decisions.md` should keep it that way until there is
  something to protect.
- **Browse-without-account for free items is proven** (Nextdoor made it a press release in
  2021). The root-domain feed decision (#44) is aligned with the market, not against it.
- **Federate or be federated.** Trash Nothing lasted by aggregating; Freebie Alerts grew by
  aggregating. The cheapest liquidity Keepsake can get is to be *a source* for those feeds (a
  public RSS/JSON feed of approved listings costs nothing and needs no partnership), and possibly
  to cross-post to the renamed ex-Buy-Nothing groups by hand during launch.
- **Location must work on day one.** Buy Nothing 3.0's worst reviews are about the radius filter
  showing other cities. Keepsake's GeoNames-in-D1 approach with FSA-level Canada is the right bet;
  Canadian radius complaints are the named trigger in `geo.md`.
- **Safety copy converges.** Craigslist, Facebook, Olio and Buy Nothing all say the same three
  things (public place, bring someone, keep it on-platform). Keepsake's terms already carry them
  (#32); Olio's *doorstep / no-contact* option is the one idea not yet reflected.
- **The story is the wedge, not the product.** Artifcts charges $45/yr for the act of writing it;
  Heirloominary launched a whole site around it in 2026. People want to tell it. The question
  Keepsake alone can answer is whether a stranger's note in reply is enough of a reason to let go.

---

## 9. Open questions this research raises (not decisions)

1. Should Keepsake publish a machine-readable feed of approved listings so aggregators can index
   it? Cost: one route, and a policy on which fields (never the giver's contact). Trigger for
   deciding: launch, since it is cheapest before anyone is looking.
2. Are "asks" (wanted posts) in scope? Every Ring 1 product has them; they are also the spammiest
   surface and would double the moderation queue that one person clears. Not in
   `product-decisions.md` at all today.
3. What fraction of the live catalogue is sentimental? A one-off read of stories against
   categories would say whether the 20-character floor is producing keepsakes or captions.
4. Should the no-contact / doorstep pickup option Olio offers be a listing flag? It changes the
   in-person-safety posture the terms describe and is worth a row in `legal-considerations.md`
   before it is built.

---

## 10. Sources

Fetched 2026-09-09. Pages that returned 403 to the agent container are marked; their claims are
carried only where a second source repeats them.

**Buy Nothing** — [buynothingproject.org/about](https://buynothingproject.org/about) ·
[3.0 update, 2026-01-26](https://buynothingproject.org/announcements/an-update-on-our-new-app-we%E2%80%99re-on-it) ·
[Buy Nothing Pro](https://buynothingproject.org/pro) ·
[App Store listing](https://apps.apple.com/us/app/buynothing/id1557679959) ·
[Wikipedia](https://en.wikipedia.org/wiki/Buy_Nothing_Project) ·
[SF Standard, 2025-11-07, trademark takedowns](https://sfstandard.com/2025/11/07/buy-nothing-group-facebook-taken-down-trademark-infringment/) ·
[LessWrong thread on the app vs. Facebook groups](https://www.lesswrong.com/posts/v3EfCmegqjzQTfFTP/buy-nothing-day-is-a-great-idea-with-a-terrible-app-why-has) ·
[DCist on admin burnout](https://dcist.com/story/23/02/21/buy-nothing-capitol-hill-take-my-sht-group-drama/)

**Freecycle** — [About](https://www.freecycle.org/pages/about) ·
[Wikipedia](https://en.wikipedia.org/wiki/The_Freecycle_Network) ·
[Publift case study (budget, ad royalties)](https://www.publift.com/case-studies/freecycle) ·
[App Store listing](https://apps.apple.com/us/app/freecycle/id6444136692)

**Trash Nothing / Freegle** — [Freegle wiki: Trash Nothing](https://wiki.ilovefreegle.org/Trash_Nothing) ·
[App Store listing](https://apps.apple.com/us/app/trash-nothing-freecycle/id680743557) ·
[Best free-stuff apps 2026 (403 from container)](https://trashnothing.com/free-stuff-guides/best-free-stuff-apps-compared) ·
[MSE Freecycle/Freegle guide](https://www.moneysavingexpert.com/shopping/freecycle/)

**Olio** — [Wikipedia](https://en.wikipedia.org/wiki/Olio_(app)) ·
[Help: where and how to access Olio](https://help.olioapp.com/en/articles/12149055-where-and-how-can-i-access-olio) ·
[Interreg Europe good-practice note](https://www.interregeurope.eu/good-practices/olio-app)

**Geev / Givore / Bunz / Karrot** — [Geev](https://www.geev.com/en) ·
[Givore: best apps to give away stuff (2026)](https://givore.com/blog/best-app-give-away-stuff/) ·
[Bunz press release, 2026-06-11](https://www.prnewswire.com/news-releases/after-ten-years-bunz-owner-seeks-a-simple-answer-continue-or-end-it-302797177.html) ·
[BetaKit on Bunz](https://betakit.com/the-problem-is-me-bunz-owner-brings-in-gen-z-pranksters-to-save-dying-platform/) ·
[Karrot about](https://karrotmarket.com/about/)

**General marketplaces and aggregators** — [Nextdoor Free Finds press release](https://about.nextdoor.com/press-releases/nextdoor-expands-its-buy-sell-and-give-feature-with-the-launch-of-free-finds) ·
[Nextdoor 2025 transparency report](https://about.nextdoor.com/press-releases/nextdoor-publishes-2025-transparency-report) ·
[Kijiji Free Stuff, Canada](https://www.kijiji.ca/b-free-stuff/canada/c17220001l0) ·
[Craigslist vs. modern marketplaces (secondary)](https://dealhunter.io/blog/craigslist-vs-modern-marketplaces) ·
[Facebook Marketplace stats (secondary, unverified)](https://scoop.market.us/facebook-marketplace-statistics/) ·
[Freebie Alerts App Store listing](https://apps.apple.com/us/app/freebie-alerts-free-stuff-app/id1458308488) ·
[MaxSold](https://maxsold.com/m/jc464g0/about-maxsold) · [EBTH](https://www.ebth.com/)

**Story-side adjacents** — [Artifcts](https://artifcts.com/) ·
[Heirloominary (Seattle Refined, 2026-04-21)](https://seattlerefined.com/lifestyle/heirloominary-celebrates-the-stories-behind-cherished-keepsakes-seattle-family-memories-tradition-melissa-cable-pnw) ·
[Heriteo](https://heriteo.com/) · [Heirloom Vault](https://heirloomvault.net/) ·
[Remento (Wikipedia)](https://en.wikipedia.org/wiki/Remento)
