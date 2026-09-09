# How estates actually get catalogued and cleared — research for the bulk upload flow

Research date 2026-09-09. Companion to `docs/design/bulk-upload.md` (never driven by a real
person) and `docs/seeding-and-distribution.md` §3 (Houston liquidator contacts already identified
as the flow's intended first users).

## 1. Tools they use

The industry has converged on purpose-built cataloguing software treating **speed across a whole
house** as the product.

**MaxSold** photographs a house in place and turns a draft catalog around in **72 hours**, full
cycle (cataloguing to pickup) 11–14 days [MaxSold](https://support.maxsold.com/hc/en-us/articles/203144744-How-soon-will-my-items-be-listed-online). Cataloguing is "Seller Managed" (app or
fill-in sheet) or "MaxSold Managed" (their crew) [MaxSold](https://support.maxsold.com/hc/en-us/articles/203144414-What-does-cataloging-mean). Its **Smart Cataloging** has a human just
take photos while AI drafts title/description for review [MaxSold PDF](https://aclearpath.net/wp-content/uploads/2024/07/MaxSold-Cataloging-1.pdf); the app supports multiple
simultaneous catalogers per auction [MaxSold](https://support.maxsold.com/hc/en-us/articles/1260801036670-How-do-I-use-the-MaxSold-app-with-multiple-catalogers), lets a cataloguer shoot in-app or pull from the
existing gallery, and enforces a hard **minimum of 3 photos per lot** before publish [MaxSold](https://support.maxsold.com/hc/en-us/articles/1260801036610-How-do-I-use-the-Maxsold-Seller-App). A
"lot" is usually several related items sold together — the biggest structural gap from Keepsake,
where every listing is one object to one recipient.

**EstateSales.net** is a directory, not a cataloguer: sellers upload sale photos and free text
[EstateSales.net](https://www.estatesales.net/advertise/sale); the real cataloguing for many of its 9,000+ listed companies happens in the paid
**EstateFlow**, which pulls comps from Google Lens/eBay, drafts descriptions with AI, and pushes
photos/prices straight into an EstateSales.net draft [EstateFlow](https://joinestateflow.com/).

**CTBids** (Caring Transitions) runs $1-start auctions, ships winning items, and claims a **95%
sell-through rate** [Caring Transitions](https://www.caringtransitions.com/shop-ctbids) across 614,000+ members [Caring Transitions](https://www.caringtransitionsfranchise.com/ct-bids) — far above a walk-in tag sale (§2).

**Everything But The House (EBTH)** takes physical custody: staff **sort keep/sell/donate/trash
first**, then a dedicated crew removes, transports, catalogs and photographs items at a central
warehouse [EBTH](https://www.ebth.com/about/) [Antique Trader](https://www.antiquetrader.com/art/find-what-you-didnt-know-you-wanted-at-ebth) — triage is done by staff, not family, in this model.

**Estate-auction software** (Selling Lane, Gavelist, EstateSail, AuctionMethod) is the closest
analog to a bulk-upload tool. Selling Lane's bulk path handles ~100 items at a time with **photos
auto-matched to lot numbers by filename**, categories auto-suggested [Selling Lane](https://www.sellinglane.com/estate-sale-auction-software/); its CSV path imports
400 items in minutes [Selling Lane](https://www.sellinglane.com/estate-sale-auction-software/). Gavelist likewise detects lot assignment from filenames and can push
to HiBid/LiveAuctioneers or export CSV [Gavelist](https://gavelist.com/estate-sale-software). **Filename-to-lot matching is the load-bearing
convention across this category**: shoot a folder named/numbered to match a spreadsheet row,
import both together — not one photo at a time through a web form.

General inventory apps are adjacent, not built for liquidation: **Sortly** now targets business
inventory (from $39/mo) with QR labels and explicit "digitize your old Excel sheet" positioning
[HomeProof](https://homeproofvault.com/blog/best-home-inventory-apps-compared/); **Encircle** is built for property-restoration/insurance documentation [HomeProof](https://homeproofvault.com/blog/best-home-inventory-apps-compared/);
**HomeZada** bundles inventory with maintenance/budgeting [HomeProof](https://homeproofvault.com/blog/best-home-inventory-apps-compared/). One review states spreadsheets
work under ~20 items but an app pays off past 30 [Hippo](https://www.hippo.com/blog/home-inventory-apps) — a threshold an estate crosses in its
first hour. **Artifcts** and **Heriteo** are closest to Keepsake's "story attached to an object"
idea but are for *keeping*, not giving away: Artifcts attaches photo/video/audio/story to an object
with named legacy contacts [Family Tree Magazine](https://familytreemagazine.com/preservation/heirlooms/artifcts-save-stories/) [Legacy Tree](https://www.legacytree.com/blog/how-to-preserve-family-heirlooms-in-a-digital-era-an-interview-with-artifcts/); Heriteo catalogs assets and assigns them to
named heirs [Heriteo](https://heriteo.com/). Neither has a "give to a stranger" outlet — Keepsake's opening.

## 2. Throughput

The 2023 EstateSales.net Industry Survey found most sales run **1,000–1,999 items** (23.17%),
250–999-item sales nearly as common (17.77% each), and 8.01% exceed 5,000 [Survey](https://www.estatesales.net/surveys/2023-industry-survey-blog) — one to two
orders of magnitude past bulk-upload.md's "fifty objects," because a sale counts every fork while
Keepsake wants only story-worthy objects. Move managers frame the job by square footage, not item
count: NASMM guidance describes 1,500–3,500 sq ft of belongings compressed into a 300–600 sq ft
unit [NASMM](https://www.nasmm.org/NASMM/document-server/?cfp=NASMM%2Fassets%2FFile%2Fpublic%2Feducation%2FGuide_To_Rightsizing_and_Relocating.pdf).

A specific items/lots-per-hour figure could not be verified for any named tool — one Glassdoor
review mentioned a single job of "over 1500 shots" with no time-on-site given — so this should be
sourced from a contacted liquidator, not assumed. What is confirmed is the *cycle*: MaxSold turns a
whole house into a live draft in 72 hours [MaxSold](https://support.maxsold.com/hc/en-us/articles/203144744-How-soon-will-my-items-be-listed-online).

Sources converge on **20–40% of items going unsold** at a typical walk-in sale [Dropcurb](https://dropcurb.com/blog/estate-sale-cleanout), against
CTBids' 95% sell-through for curated online lots [Caring Transitions](https://www.caringtransitions.com/shop-ctbids) — the gap is walk-in browsing versus
a pre-filtered "worth listing" bar. Cleanout typically runs a **3–5 day window** after the sale,
ending in a paid **"buyout"**: a liquidation/junk company takes what's left for a lump sum or flat
fee ($79–$4,000 depending on volume; full-home junk removal averages $500–$2,000) [Dropcurb](https://dropcurb.com/blog/estate-sale-cleanout). This
window is directly resonant with bulk-upload.md's own local-only pickup-deadline reminder.

## 3. Sequence and decision points

Sentimental triage happens once, early, and mostly **excludes the liquidator**. Guidance for
family-run sales is blunt: "pull out family heirlooms... first — once a sale starts, items move
fast," marking anything staying as **"Not for Sale"** before inventory even starts [Senior Care Questions](https://seniorcarequestions.com/estate-liquidation-senior-move-help/).
The **decision-maker is the family/executor**; the liquidator's stated role is neutral facilitation
and value assessment, not unilateral choice [Senior Care Questions](https://seniorcarequestions.com/estate-liquidation-senior-move-help/).

Practical consequence: by the time a liquidator's crew photographs a house, the sentimental layer
has usually already been pulled and dispersed among family — it never reaches the sale or a
give-away platform. What remains unsold is a *second-order* pile: unchosen, not valuable enough to
sell, not sentimental enough to have been claimed, but not something anyone wants trashed outright.
That is thinner and later than bulk-upload.md's "houseful of keepsakes" framing implies — it
surfaces post-sale, in the leftovers, decided by whoever runs the 72-hour cleanout, which by then
is as often the liquidator or a junk crew as the family. EBTH is the exception: full-service intake
puts the keep/sell/donate/trash sort in the company's own hands, before any photographer arrives
[Antique Trader](https://www.antiquetrader.com/art/find-what-you-didnt-know-you-wanted-at-ebth) — a liquidator *can* be the decision-maker when hired for full service.

## 4. Family-side: the emotional workflow

The recurring friction: an object and its memory get treated as one thing, so letting go of the
object feels like losing the memory; advice tries to split them (photograph an item before parting
with it) [AARP/RFD-TV](https://www.rfdtv.com/decluttering-can-take-an-emotional-toll-aarp-experts-share-where-to-begin) [Method Seattle](https://www.methodseattle.com/decluttering-your-parents-home-after-theyve-passed/). A named mistake: assuming your children want specific pieces without
asking directly [Method Seattle](https://www.methodseattle.com/decluttering-your-parents-home-after-theyve-passed/) — a lot of "keep it in the family" stock has no taker inside the family
either. Organizer guidance funnels that stock outward on a ladder: relatives/friends with real
space and want → nonprofit → a Buy Nothing group [Apartment Therapy](https://www.apartmenttherapy.com/declutter-forever-home-37551554) — Keepsake sits as a more
deliberate rung between "community group" and landfill.

No canonical duration for "clearing a parent's house" was found; guidance frames it by
task-breakdown (start with a low-emotion room) rather than a timeline [AARP/RFD-TV](https://www.rfdtv.com/decluttering-can-take-an-emotional-toll-aarp-experts-share-where-to-begin) [Method Seattle](https://www.methodseattle.com/decluttering-your-parents-home-after-theyve-passed/) — stated
as unverified, not invented. **Swedish death cleaning (döstädning)**, from Margareta Magnusson's
*The Gentle Art of Swedish Death Cleaning*, gives the clearest existing vocabulary for Keepsake's
purpose: give things away *while alive*, on purpose, so the giver sees who values the object,
rather than leaving that sorting as "an awful burden" for survivors [Wikipedia](https://en.wikipedia.org/wiki/Swedish_death_cleaning) [MD-Update](https://md-update.com/2025/09/the-gentle-art-of-swedish-death-cleaning/).
Her diagnostic — "will anyone you know be happier if you save this?" — is functionally the test a
keepsake-worthy item has to pass on Keepsake, just answered by a stranger. The book frames this as
*responsibility*, not mortality: sorting while capable, "rather than leaving the job to relatives
who won't know what any of it meant" [The Conversation](https://theconversation.com/the-swedish-concept-of-dostadning-or-death-cleaning-is-about-more-than-just-getting-rid-of-things-279030) — close to bulk-upload.md's own "a form that refuses
to save an incomplete thought loses the thought." No source used the exact phrase "someone who'll
care"; "cherish," "love it," "value and enjoy" were the words actually found [Apartment Therapy](https://www.apartmenttherapy.com/declutter-forever-home-37551554)
[The Conversation](https://theconversation.com/the-swedish-concept-of-dostadning-or-death-cleaning-is-about-more-than-just-getting-rid-of-things-279030) — worth matching product copy against rather than inventing new language.

## 5. What a bulk tool needs to be adopted by a liquidator

**CSV/spreadsheet import** is table stakes, not a nice-to-have — Selling Lane and Gavelist both
treat it as a primary intake path [Selling Lane](https://www.sellinglane.com/estate-sale-auction-software/) [Gavelist](https://gavelist.com/estate-sale-software), and it's already named in bulk-upload.md's own
deferred list. **Filename-to-item matching on batch photo upload** is the category's dominant
convention with no analog in bulk-upload.md's manual "group as one item" flow. **Per-lot/QR
labels** for physical-to-digital tracking (Sortly) match bulk-upload.md's own deferred "printable
lot labels" — multi-person crews need a tag on the object itself, not only a database field. **A
client sign-off distinct from the uploader** exists in spirit already (review.tsx's per-item cards
and preview are functionally self-sign-off) but no searched tool exposes a distinct "executor
approves a hired liquidator's batch" gate — MaxSold's closest equivalent is the seller reviewing
their own draft before it goes live [MaxSold](https://support.maxsold.com/hc/en-us/articles/15116620794011-How-do-I-review-my-Maxsold-Managed-Catalog); this is a genuinely open gap for a *hired* liquidator, not
yet proven as something families ask for directly. **A hard pickup deadline is an industry norm**
(3–5 day post-sale clocks ending in a paid buyout [Dropcurb](https://dropcurb.com/blog/estate-sale-cleanout)) — a real tension against bulk-upload.md's
deliberately soft, wire-absent reminder, since gifting makes no delivery-by-date promise.

## Gaps between bulk-upload.md and real practice

| Practice | What the flow does today | Gap | Effort guess |
|---|---|---|---|
| CSV/spreadsheet intake as first-class path (Selling Lane, Gavelist) [Selling Lane](https://www.sellinglane.com/estate-sale-auction-software/) | Not built; named in bulk-upload.md's deferred list | Liquidators expect to reuse a spreadsheet they keep, not retype 50–200 rows | Large — import parser, mapping UI, validation against `DraftItemFields`, dedup |
| Filename-to-item auto-matching on bulk photo upload (Selling Lane, Gavelist) [Gavelist](https://gavelist.com/estate-sale-software) | Manual only: add photos, then explicit "group as one item"/"one item per photo" | A phone folder of 300 named shots must be hand-sorted; no pre-grouping by filename pattern | Medium — filename-parsing pass ahead of the existing grouping reducer, opt-in |
| Minimum photos per lot (MaxSold requires 3 to publish) [MaxSold](https://support.maxsold.com/hc/en-us/articles/1260801036610-How-do-I-use-the-Maxsold-Seller-App) | No minimum; an item is "ready" per `CreateListingInput` with whatever photos it has | Right for a grieving individual giver, but a pro liquidator may want a soft nudge | Small — review.tsx warning badge, no schema change, keeps "draft is permissive" |
| Printable lot/QR labels (Sortly; industry lot-numbering norm) [HomeProof](https://homeproofvault.com/blog/best-home-inventory-apps-compared/) | `room_label`/`lot_label` text fields only, no physical output | Crews sorting a truckload need a tag on the object, not just a database field | Medium — print-view generator over existing batch/item data, no new field |
| Second-party sign-off (uploader ≠ decision-maker; seed-catalogue.md §5 already names this shape) | `submit.tsx`: one age check, select-ready-items, all by the same authenticated device | No "hired liquidator acting for an executor" role — no way to route review to the family before submit | Large — new role/permission model, invite/share link to a read-only or comment-only view |
| Hard operational deadline with consequences (72-hour/3–5 day cleanout clocks) [Dropcurb](https://dropcurb.com/blog/estate-sale-cleanout) | `pickupDeadline.ts` is local-only, non-binding, deliberately off the wire | Fine for a family giver; under-serves a liquidator whose truck/dumpster is booked | Medium — could stay client-side (countdown against moderation SLA already in Observatory) without breaking the "no promise" rule |
| Sentimental triage happens once, pre-sale, mostly by family before a liquidator ever sees the house [Senior Care Questions](https://seniorcarequestions.com/estate-liquidation-senior-move-help/) | Flow assumes "someone clearing a house" photographs it themselves, sitting by sitting | Not a code gap: seeding-and-distribution.md §3 targets liquidators for outreach, but liquidators typically see the *post-triage* leftovers, not the sentimental layer — the better-fit user may be the family member before they call a liquidator | N/A — product-decisions question, not engineering |
| Moderation turnaround vs. cataloguing turnaround (MaxSold catalogs a house in 72h) [MaxSold](https://support.maxsold.com/hc/en-us/articles/203144744-How-soon-will-my-items-be-listed-online) | Moderation deliberately paced: bounded items per runner pass, shared FIFO queue, up to an hour before search embedding | A liquidator against a dumpster deadline may find submission-to-live slower than their own cataloguing was | Small–medium — already flagged in bulk-upload.md as a known, deferred fairness gap; per-owner cap per pass is the named fix |

## Sources

- MaxSold: [Listing timeline](https://support.maxsold.com/hc/en-us/articles/203144744-How-soon-will-my-items-be-listed-online) · [What is cataloging](https://support.maxsold.com/hc/en-us/articles/203144414-What-does-cataloging-mean) · [Seller App](https://support.maxsold.com/hc/en-us/articles/1260801036610-How-do-I-use-the-Maxsold-Seller-App) · [Multiple catalogers](https://support.maxsold.com/hc/en-us/articles/1260801036670-How-do-I-use-the-MaxSold-app-with-multiple-catalogers) · [Reviewing a Managed Catalog](https://support.maxsold.com/hc/en-us/articles/15116620794011-How-do-I-review-my-Maxsold-Managed-Catalog) · [Cataloging PDF](https://aclearpath.net/wp-content/uploads/2024/07/MaxSold-Cataloging-1.pdf)
- EstateSales.net / EstateFlow: [List Your Private Estate Sale](https://www.estatesales.net/advertise/sale) · [EstateFlow](https://joinestateflow.com/) · [2023 Industry Survey](https://www.estatesales.net/surveys/2023-industry-survey-blog)
- CTBids / Caring Transitions: [Shop CTBids](https://www.caringtransitions.com/shop-ctbids) · [CTBids overview](https://www.caringtransitionsfranchise.com/ct-bids)
- Everything But The House: [About](https://www.ebth.com/about/) · [Antique Trader feature](https://www.antiquetrader.com/art/find-what-you-didnt-know-you-wanted-at-ebth)
- Estate auction software: [Selling Lane](https://www.sellinglane.com/estate-sale-auction-software/) · [Gavelist](https://gavelist.com/estate-sale-software) · [AuctionMethod](https://www.auctionmethod.com/estate-sale-software)
- Inventory apps: [HomeProof comparison](https://homeproofvault.com/blog/best-home-inventory-apps-compared/) · [Hippo](https://www.hippo.com/blog/home-inventory-apps)
- Legacy/heirloom apps: [Artifcts — Family Tree Magazine](https://familytreemagazine.com/preservation/heirlooms/artifcts-save-stories/) · [Artifcts — Legacy Tree](https://www.legacytree.com/blog/how-to-preserve-family-heirlooms-in-a-digital-era-an-interview-with-artifcts/) · [Heriteo](https://heriteo.com/)
- Unsold items / cleanout: [Dropcurb](https://dropcurb.com/blog/estate-sale-cleanout)
- Senior move management / triage: [Senior Care Questions](https://seniorcarequestions.com/estate-liquidation-senior-move-help/) · [NASMM Guide](https://www.nasmm.org/NASMM/document-server/?cfp=NASMM%2Fassets%2FFile%2Fpublic%2Feducation%2FGuide_To_Rightsizing_and_Relocating.pdf)
- Family-side emotional guidance: [RFD-TV/AARP](https://www.rfdtv.com/decluttering-can-take-an-emotional-toll-aarp-experts-share-where-to-begin) · [Method Seattle](https://www.methodseattle.com/decluttering-your-parents-home-after-theyve-passed/) · [Apartment Therapy](https://www.apartmenttherapy.com/declutter-forever-home-37551554)
- Swedish death cleaning: [Wikipedia](https://en.wikipedia.org/wiki/Swedish_death_cleaning) · [The Conversation](https://theconversation.com/the-swedish-concept-of-dostadning-or-death-cleaning-is-about-more-than-just-getting-rid-of-things-279030) · [MD-Update](https://md-update.com/2025/09/the-gentle-art-of-swedish-death-cleaning/)
- Internal: `../design/bulk-upload.md` · `../seeding-and-distribution.md` §3
