# Supply signal: how much of "free near Houston" is genuinely sentimental?

One-day sample, 2026-09-09 (UTC 02:34-02:35). Answers the open question in
[`seeding-and-distribution.md`](../seeding-and-distribution.md) section 2:
*of the free listings already circulating near Houston, what fraction reads as sentimental
rather than generic free stuff?*

**Headline number: 8 of 276 visible listings (2.9%) used sentimental language** (vintage,
family, heirloom, handmade, etc., per the keyword list below) **in their title.** Two of those
eight are arguably false positives (see caveats). By source: Craigslist Houston free 4/204
(2.0%), Nextdoor Houston Free Finds 4/72 (5.6%). This is a title-only, one-day, one-sample
measurement -- treat it as a floor, not a settled answer. See section 6 for why.

Trash Nothing (the one platform Keepsake could plausibly *read from* programmatically) could
not be sampled today: both its public pages and its developer/API-key page are behind a
Cloudflare bot challenge from this container's egress IP. Its OpenAPI spec was fetched and
read in full, so the exact query is documented and ready to paste once a human has a key --
see section 5.

---

## 1. Method

For each source: fetch the public page with `curl` (desktop User-Agent, following redirects,
30s timeout, TLS verified against the standard bundle -- never disabled), record the HTTP
status code and byte size, save the raw response, then extract every visible listing title
using a small Python/regex pass over the saved HTML (not a browser -- see caveats on what a
non-JS fetch can and can't see). Each title was classified into exactly one of Keepsake's
listing categories by keyword match (first matching category wins, priority ordered from most
to least specific -- see the ruleset in section 4), and flagged `sentimental: yes` only if the
title contains one of the literal terms specified for this task: *grandmother, family,
heirloom, vintage, antique, handmade, memories, "belonged to", years owned* (plus the informal
"grandma" as a trivial variant of "grandmother"). No listing was read beyond its title/caption
-- see caveats.

Raw fetches (third-party HTML, ~600 KB) were kept out of the repository; the fetch codes and byte
sizes are in section 2 and the extracted titles in `supply-sample/classification-20260909.csv`.

A reusable fetch-only script (re-run daily, same sources, new timestamp) is at:
`supply-sample/sample-supply.sh`

The classification pass (Python, keyword rules) that turned the saved Craigslist/Nextdoor HTML
into the table in section 4 is reproduced there so a different day's raw HTML can be
re-classified the same way; today's intermediate CSV is at
`supply-sample/classification-20260909.csv`.

---

## 2. What could and could not be fetched

| # | Source | URL | HTTP | Bytes | Usable? |
|---|---|---|---|---|---|
| 1 | Trash Nothing OpenAPI spec | `https://trashnothing.com/api/v1.4/trashnothing-openapi.yaml` | **200** | 73,738 | Yes -- read in full, see section 5 |
| 2 | Trash Nothing developer page | `https://trashnothing.com/developer` | **403** | 5,604 | No -- Cloudflare "Just a moment..." bot-check page, confirmed via both `curl` and a second, independent fetch tool |
| 3 | Trash Nothing developer page (the spec's own link) | `https://trashnothing.com/app/developer` | **403** | -- | No -- same Cloudflare challenge, confirmed the same two ways |
| 4 | Trash Nothing Houston free page | `https://trashnothing.com/houston-free` | **403** | 5,613 | No -- same Cloudflare challenge |
| 5 | Craigslist Houston free (`search/zip`) | `https://houston.craigslist.org/search/zip` | **200** | 106,522 | Yes -- 204 listing titles extracted |
| 6 | Craigslist Houston free, RSS variant | `https://houston.craigslist.org/search/zip?format=rss` | **403** | 248 | No -- Craigslist's own bot-block page ("Your request has been blocked"); the RSS variant no longer works unauthenticated from this egress |
| 7 | Nextdoor Houston Free Finds | `https://nextdoor.com/marketplace/houston--tx/free/` | **200** | 402,661 | Yes -- 72 listing titles extracted from an embedded GraphQL JSON state blob in the server-rendered HTML (no login, no JS execution needed) |
| 8 | OfferUp Houston, `free` search | `https://offerup.com/search/?q=free&location=Houston%2C%20TX` | **403** | 10,235 | No -- Cloudflare bot-check page |
| -- | Kijiji | -- | -- | -- | Skipped per instructions (Canada-only, not relevant to Houston) |

Four of eight sources 403'd. Every 403 above is a bot/anti-scraping challenge page (Cloudflare
"Just a moment..." or a site's own "blocked" page), not a data result -- none of that content
was used for anything below. No login wall was bypassed and no listing was fabricated to fill
a gap.

---

## 3. Per-source counts

| Source | Listings visible | Notes |
|---|---|---|
| Craigslist Houston free | 204 titles extracted (207 `<li class="cl-static-search-result">` markers matched in the raw HTML; 3 could not be cleanly parsed into a title string, likely quoting edge cases inside scam-post titles -- left out rather than guessed at) | Single static page load; no "next page" control was present in this snapshot's markup, so this is either the platform's full current Houston `free` set or just the first page -- could not confirm which (see caveats) |
| Nextdoor Free Finds (Houston) | 72 listings | Extracted from the page's embedded GraphQL state (`FeedItemClassified`/`Classified` objects), i.e. what Nextdoor's server actually sent, deduplicated by caption text |
| Trash Nothing (`houston-free`) | 0 -- page not fetchable (403) | -- |
| OfferUp | 0 -- page not fetchable (403) | -- |
| **Total classified** | **276** | Craigslist 204 + Nextdoor 72 |

---

## 4. Classification

### Category rules (priority-ordered keyword match, first hit wins)

```text
music_instruments      piano, organ, guitar, violin
jewelry_watches        jewelry, watch(es), ring, necklace, bracelet
electronics            tv, phone, macbook, computer, monitor, laptop, vacuum, (key) fob
home_kitchen           kitchen, dish(washer), microwave, refrigerator, freezer, washer,
                        dryer, blender, coffee maker, keurig, humidifier, steamer, oven,
                        range, baking mix, canning jars, sheet cake
furniture_decor        couch, sofa, chair, table, desk, bed(frame/rail), mattress, dresser,
                        cabinet, shelf, bookcase, mirror, lamp, ottoman, recliner, loveseat,
                        headboard, armoire, hutch, bench, shed, waterbed, curtain, window frame
photos_art_handmade    art, painting, canvas, handmade, photo album, framed, wall art,
                        lantern, ceiling...light
toys_games             toy(s), puzzle, scooter, lego, kids bike, balance bike, bicycle
sports_outdoors        basketball hoop, fishing rod, exercise bike, elliptical, workout
                        bench, trampoline, camping
tools_diy              tool(s), saw, drill, lumber, pallet(s), hardware, spiral saw,
                        paper cutter, hole punch
clothing_accessories   clothes, clothing, shirt, dress(es), shoe(s), jacket, bag(s), purse,
                        scarf, uniform(s), sandals, backpack(s)
books_letters          book(s), letter(s), journal, diary, magazine
other                  everything matching none of the above (car parts, tires, plants,
                        pets, moving boxes, scam/spam posts, service ads, livestock, etc.)
```

### Sentimental-language rule

Flagged `yes` only if the title matches one of: `grandmother` (or `grandma`), `family`,
`heirloom`, `vintage`, `antique`, `handmade`, `memor(y|ies)`, `belonged to`, `years owned`.
Titles were not read for tone or backstory beyond this literal match -- see caveats.

### Full classification table (all 276 titles fetched today)

| # | Source | Title | Category | Sentimental? |
|---|---|---|---|---|
| 1 | Craigslist | Xl pit pups | other | no |
| 2 | Craigslist | Large Mirror 48" x 42" | furniture_decor | no |
| 3 | Craigslist | Closet Rod | other | no |
| 4 | Craigslist | Free Giant Tire - Weighs 900 Pounds | other | no |
| 5 | Craigslist | cat | other | no |
| 6 | Craigslist | New born to 9 months baby  female clothes | clothing_accessories | no |
| 7 | Craigslist | Car roller videography | other | no |
| 8 | Craigslist | Rolling Oxygen Tank Cart / Cylinder Holder | other | no |
| 9 | Craigslist | Free rocker recliner missing side handle | furniture_decor | no |
| 10 | Craigslist | Adjustable Rolling IV Pole / IV Stand | other | no |
| 11 | Craigslist | 3 wooden pallets for pick up | tools_diy | no |
| 12 | Craigslist | Classic Mustang Space Saver Spare | other | no |
| 13 | Craigslist | Free Ice Chests & ice packs | other | no |
| 14 | Craigslist | 4 split rim tires from 1967 Kencraft trailer | other | no |
| 15 | Craigslist | Sturdy cushioned bench 9'4" long for indoor use [such as dinner table] | furniture_decor | no |
| 16 | Craigslist | Free couches | other | no |
| 17 | Craigslist | Free bed frame, mattress, box spring | furniture_decor | no |
| 18 | Craigslist | Need my hay cut | other | no |
| 19 | Craigslist | Old tires | other | no |
| 20 | Craigslist | Miscellaneous Items | other | no |
| 21 | Craigslist | FREE PALLETS | tools_diy | no |
| 22 | Craigslist | Free Furniture and Lawn Furniture | other | no |
| 23 | Craigslist | Free twin mattres | other | no |
| 24 | Craigslist | SCAM! "Apple Replacement Phone Free" SCAM! | electronics | no |
| 25 | Craigslist | Couch | furniture_decor | no |
| 26 | Craigslist | Oak leaves | other | no |
| 27 | Craigslist | ENHANCED OAK HUTCH (FREE) | furniture_decor | no |
| 28 | Craigslist | 2009-2013 Toyota small parts | other | no |
| 29 | Craigslist | 2009-2013 Toyota matrix small parts | other | no |
| 30 | Craigslist | Key Rings - 40pcs, various sizes | other | no |
| 31 | Craigslist | Waterbed Headboard | furniture_decor | no |
| 32 | Craigslist | Free couch, loveseat, and tecliner | furniture_decor | no |
| 33 | Craigslist | Peerless slide out swivel tray | other | no |
| 34 | Craigslist | Serta Full-Size Mattress in Excellent Condition | furniture_decor | no |
| 35 | Craigslist | 2 closet doors FREE | other | no |
| 36 | Craigslist | Sofa couch grey | furniture_decor | no |
| 37 | Craigslist | sink and faucet - free | other | no |
| 38 | Craigslist | Plants | other | no |
| 39 | Craigslist | Free Fish Tank Aquarium Stainless 3 Gallon Tall Slate Btm | other | no |
| 40 | Craigslist | FREE Sofa - Love Seat - Couch | furniture_decor | no |
| 41 | Craigslist | Sofa & Loveseat Set FREE | furniture_decor | no |
| 42 | Craigslist | Free Futon | other | no |
| 43 | Craigslist | Free couch | furniture_decor | no |
| 44 | Craigslist | Teak entertainment center | other | no |
| 45 | Craigslist | Free recliner | furniture_decor | no |
| 46 | Craigslist | Headboard queen | furniture_decor | no |
| 47 | Craigslist | Ottoman | furniture_decor | no |
| 48 | Craigslist | 4 old car and light truck tires for some use besides driving on | other | no |
| 49 | Craigslist | Shower chairs and bedside potty | other | no |
| 50 | Craigslist | FREE PALLETS | tools_diy | no |
| 51 | Craigslist | Various hospital/health care items | other | no |
| 52 | Craigslist | Swivel Rocker | other | no |
| 53 | Craigslist | Sofas for free… | other | no |
| 54 | Craigslist | SCAM "Free Mobile Device Clear Display & Good Battery" | other | no |
| 55 | Craigslist | Free rear riding lawn mower tires | other | no |
| 56 | Craigslist | "Free Phone Good Condition" "Free SmartPhone Various Models & Colors" | electronics | no |
| 57 | Craigslist | SCAM!  "Free SmartPhone Various Models $ Colors" | other | no |
| 58 | Craigslist | SCAM "Free Pro 16" — Available" SCAM SCAM SCAM! | other | no |
| 59 | Craigslist | FREE GARAGE / SHOP CLEANOUT – TAKE WHAT YOU CAN USE | other | no |
| 60 | Craigslist | 📦 FREE MOVING BOXES & TAPE – BUSINESS CLOSING | other | no |
| 61 | Craigslist | Free leather sofa bed | furniture_decor | no |
| 62 | Craigslist | FREE Office desk and sofa | furniture_decor | no |
| 63 | Craigslist | Free Couch | furniture_decor | no |
| 64 | Craigslist | 1980s spinet grand paino co. | other | no |
| 65 | Craigslist | POOL TABLE | furniture_decor | no |
| 66 | Craigslist | SCAM! "Free 20 Inch Guardian Girls Bike – Good Comfortable Bike" SCAM! | other | no |
| 67 | Craigslist | "Pro 16" — Free to Good Home" IS ANOTHER SCAM! | other | no |
| 68 | Craigslist | Shower Curtain Hooks, Brushed Nickel - Total 12 hooks | furniture_decor | no |
| 69 | Craigslist | FREE 6-Piece Power Reclining Sectional – You Haul, It’s Yours! | other | no |
| 70 | Craigslist | Reusable Ice Packs | other | no |
| 71 | Craigslist | Free Dishwasher | home_kitchen | no |
| 72 | Craigslist | FREE QUEEN BED AND WASHER AND DRYER | home_kitchen | no |
| 73 | Craigslist | Mirror from Ikea | furniture_decor | no |
| 74 | Craigslist | Free Piano — Must Pick Up | music_instruments | no |
| 75 | Craigslist | Sofa available, Pickup Only | furniture_decor | no |
| 76 | Craigslist | FREE LONG COUCH | furniture_decor | no |
| 77 | Craigslist | FREE - Shoe rack | clothing_accessories | no |
| 78 | Craigslist | White IKEA ALEX Desk with 5-Drawer Unit - Used/Good Condition! | furniture_decor | no |
| 79 | Craigslist | Bixe 16-Inch Aluminum Balance Bike - Used/Good Condition! | toys_games | no |
| 80 | Craigslist | White Wooden Bookcase / 2-Shelf Storage Unit | furniture_decor | no |
| 81 | Craigslist | Large Framed Canvas Wall Art - Modern Abstract Design | photos_art_handmade | no |
| 82 | Craigslist | White Wood China Cabinet – Storage Hutch | furniture_decor | no |
| 83 | Craigslist | Looking for formula similac or enfamil | other | no |
| 84 | Craigslist | 16" MacBook case and Keypad cover | electronics | no |
| 85 | Craigslist | Kids Scooters | other | no |
| 86 | Craigslist | Free desk | furniture_decor | no |
| 87 | Craigslist | Free Moving Boxes | other | no |
| 88 | Craigslist | Free old used motor oil | other | no |
| 89 | Craigslist | backpacks, school bags,  misc bags for giveaway | clothing_accessories | no |
| 90 | Craigslist | women clothing (size: small) giveaway | clothing_accessories | no |
| 91 | Craigslist | premier martial arts uniforms - free giveaway | clothing_accessories | no |
| 92 | Craigslist | Boxes for Moving | other | no |
| 93 | Craigslist | Moving boxes | other | no |
| 94 | Craigslist | 2 shelving units | other | no |
| 95 | Craigslist | Couch with Cushions | furniture_decor | no |
| 96 | Craigslist | Lots of FREE stuff - leather couch, cooler, outdoor heater!!! | furniture_decor | no |
| 97 | Craigslist | Couch Space  Heater Tools | furniture_decor | no |
| 98 | Craigslist | Free Loveseat (pickup from second floor apartment) | furniture_decor | no |
| 99 | Craigslist | 2019- 2026 VW Atlas Mats | other | no |
| 100 | Craigslist | Kenmore Sewing Machine | other | no |
| 101 | Craigslist | Refrigerator / Freezer | home_kitchen | no |
| 102 | Craigslist | Large tiles | other | no |
| 103 | Craigslist | Curb Alert | other | no |
| 104 | Craigslist | Free Office Chair Available | furniture_decor | no |
| 105 | Craigslist | Computer Monitor Available | electronics | no |
| 106 | Craigslist | Curb alert | other | no |
| 107 | Craigslist | free couch! just pick it up | furniture_decor | no |
| 108 | Craigslist | Tufted Storage Bed | furniture_decor | no |
| 109 | Craigslist | Big Ugly C-Band | other | no |
| 110 | Craigslist | Free TV Table | electronics | no |
| 111 | Craigslist | Firewood free | other | no |
| 112 | Craigslist | Kids bikes | toys_games | no |
| 113 | Craigslist | Queen Mattress | furniture_decor | no |
| 114 | Craigslist | FREE black plastic crates | other | no |
| 115 | Craigslist | Wood pallets and misc wood now available for FREE | tools_diy | no |
| 116 | Craigslist | Free 2 seater reclienr to who needs it | other | no |
| 117 | Craigslist | Black Lacquer King bedroom suite FREE | other | no |
| 118 | Craigslist | Free Furniture and Items, Toys, Furniture, Business Equipment | toys_games | no |
| 119 | Craigslist | Free armoire | furniture_decor | no |
| 120 | Craigslist | car toy | toys_games | no |
| 121 | Craigslist | Sofa | furniture_decor | no |
| 122 | Craigslist | Sewing Machine | other | no |
| 123 | Craigslist | Refrigerator / Freezer | home_kitchen | no |
| 124 | Craigslist | Reclaimed lumber | tools_diy | no |
| 125 | Craigslist | Hvac return air grill | other | no |
| 126 | Craigslist | FREE bed rails for Full/Double/ or Queen Mattress (Metal)  (Pearland) | furniture_decor | no |
| 127 | Craigslist | Pair Of Cornhole Boards | other | no |
| 128 | Craigslist | Glass panels and scrap wood | other | no |
| 129 | Craigslist | Free Furniture Pickup - Help Homeless Individuals | other | no |
| 130 | Craigslist | Couches free | other | no |
| 131 | Craigslist | FREE COUCH | furniture_decor | no |
| 132 | Craigslist | FREE Piano | music_instruments | no |
| 133 | Craigslist | Free Pallets | tools_diy | no |
| 134 | Craigslist | FREE PALLETS | tools_diy | no |
| 135 | Craigslist | BEST OEM WHEEL SELECTION FOR CARS AND TRUCKS | other | no |
| 136 | Craigslist | SMALL BOXES | other | no |
| 137 | Craigslist | Urgent Need for Bedroom Furniture!! | other | no |
| 138 | Craigslist | Couch and Loveseat Set | furniture_decor | no |
| 139 | Craigslist | FREE - GE QUIET POWER 3 DISHWASHER - MUST PICK UP TODAY | home_kitchen | no |
| 140 | Craigslist | Free beds, leather recliner | furniture_decor | no |
| 141 | Craigslist | Free Stuff Rodeo Palms Late Night Sunday, recyclables here. | other | no |
| 142 | Craigslist | Free aerosol sprayer | other | no |
| 143 | Craigslist | BDI Executive Desk - Prime Quality | furniture_decor | no |
| 144 | Craigslist | Children's bicycle trailer | other | no |
| 145 | Craigslist | Refregerator- Cabinet Style Hidden Refrigerators | furniture_decor | no |
| 146 | Craigslist | free 15 foot trampoline with net | sports_outdoors | no |
| 147 | Craigslist | Free Sofa chair | furniture_decor | no |
| 148 | Craigslist | pregnancy pillow | other | no |
| 149 | Craigslist | Free glass - 2 pieces - 12.8" x 61" - - - glass only | other | no |
| 150 | Craigslist | Black Lacquer King bedroom suite FREE | other | no |
| 151 | Craigslist | Free Zeon Zoysia Grass Sod 1/4 Palette | other | no |
| 152 | Craigslist | Free Un-Used Check Binders | other | no |
| 153 | Craigslist | Gas fireplace | other | no |
| 154 | Craigslist | Free office furniture | other | no |
| 155 | Craigslist | Free Pendant Lights | other | no |
| 156 | Craigslist | Free Dental Cleaning | other | no |
| 157 | Craigslist | Cardboard | other | no |
| 158 | Craigslist | CURB ALERT - kitchen stuff! | home_kitchen | no |
| 159 | Craigslist | Free twin bunk bed. Does not have ladder. | furniture_decor | no |
| 160 | Craigslist | Computer Monitor Available | electronics | no |
| 161 | Craigslist | Linear garage door opener accessories | other | no |
| 162 | Craigslist | Chaise lounges - free | other | no |
| 163 | Craigslist | Moving Boxes and Paper | other | no |
| 164 | Craigslist | Pool Lounge Chair (Fabric Ripped) | furniture_decor | no |
| 165 | Craigslist | Washing Machine – Clean & Reliable | home_kitchen | no |
| 166 | Craigslist | FREE: Mini Micro Kick Scooter (Parts / Repair Project) | toys_games | no |
| 167 | Craigslist | Wood saw horses | tools_diy | no |
| 168 | Craigslist | Free concrete pile | other | no |
| 169 | Craigslist | California king mattress | furniture_decor | no |
| 170 | Craigslist | Office desk | furniture_decor | no |
| 171 | Craigslist | I have a Midea gas oven/range set uo for propane. | home_kitchen | no |
| 172 | Craigslist | Work table | furniture_decor | no |
| 173 | Craigslist | Wheelchair Ramp for free | other | no |
| 174 | Craigslist | Sub zero / high end fridge | other | no |
| 175 | Craigslist | Vintage pump organ | music_instruments | **yes** |
| 176 | Craigslist | PANASONIC CORDLESS PHONE KX-TG6511 | electronics | no |
| 177 | Craigslist | Free Free slide screen for double side door | other | no |
| 178 | Craigslist | Free Love Seat | other | no |
| 179 | Craigslist | STORAGE BUILDINGS FREE | other | no |
| 180 | Craigslist | FREE high chair and diaper trash cans | furniture_decor | no |
| 181 | Craigslist | Enfagrow Premium Toddler Nutritional Drink | other | no |
| 182 | Craigslist | Vintage Theater Organ | music_instruments | **yes** |
| 183 | Craigslist | Free must pick up tonight | other | no |
| 184 | Craigslist | FREE 2012 JEEP WRANGLER PARTS **must bring own tools** | tools_diy | no |
| 185 | Craigslist | FREE FREE FREE | other | no |
| 186 | Craigslist | Free desk | furniture_decor | no |
| 187 | Craigslist | Free working refrigerator | home_kitchen | no |
| 188 | Craigslist | Tv stand | electronics | no |
| 189 | Craigslist | FREE HAY *FREE HAY*  *FREE HAY* | other | no |
| 190 | Craigslist | Wooden used office desk | furniture_decor | no |
| 191 | Craigslist | FREE FREE FREE! | other | no |
| 192 | Craigslist | Frame for ottoman | furniture_decor | no |
| 193 | Craigslist | CastAway fishing rod | sports_outdoors | no |
| 194 | Craigslist | Free Skids, Plallets | other | no |
| 195 | Craigslist | Twin Bed frame and head boards | furniture_decor | no |
| 196 | Craigslist | Teacher Supplies - Free | other | no |
| 197 | Craigslist | Church Pew Bench, basketball frame and household items | furniture_decor | no |
| 198 | Craigslist | Refrigerator in Good Condition | home_kitchen | no |
| 199 | Craigslist | Pink and Grey Sandals | clothing_accessories | no |
| 200 | Craigslist | 2 16" Doors | other | no |
| 201 | Craigslist | Free Air Optic Contact Lenses | other | no |
| 202 | Craigslist | FREE Modern Red Futon | other | no |
| 203 | Craigslist | SOLD! Vintage Fredrick Ramond Hall Lantern, big 30" mid 20th hexogon brass | photos_art_handmade | **yes** |
| 204 | Craigslist | SOLD! Dome Ceiling Chain Pendant Light with Vintage White Frosted Glass, 5" | photos_art_handmade | **yes** |
| 205 | Nextdoor | Green Baby Lounger | other | no |
| 206 | Nextdoor | Free baby shushed | other | no |
| 207 | Nextdoor | Assorted Planters and Vases | other | no |
| 208 | Nextdoor | Twin Mattress - high density foam | furniture_decor | no |
| 209 | Nextdoor | Free Couch and Loveseat | furniture_decor | no |
| 210 | Nextdoor | FREE Tall Shelf/ Bookcase Dark Wood 25" W x 11.5" D x 72" H | furniture_decor | no |
| 211 | Nextdoor | Wooden Corner Cabinet | furniture_decor | no |
| 212 | Nextdoor | Set of 2 Modern White Chairs | other | no |
| 213 | Nextdoor | Free Shed | furniture_decor | no |
| 214 | Nextdoor | Comfortable Armchair Recliner | furniture_decor | no |
| 215 | Nextdoor | Two Wood Curtains Rods | other | no |
| 216 | Nextdoor | Brown Leather Armchair and Sofa | furniture_decor | no |
| 217 | Nextdoor | Mirror Large | furniture_decor | no |
| 218 | Nextdoor | FREE Candle making jars | other | no |
| 219 | Nextdoor | Granite Countertop remnantsâfree | other | no |
| 220 | Nextdoor | Canning jars (21) | home_kitchen | no |
| 221 | Nextdoor | Set of Green Storage Boxes | other | no |
| 222 | Nextdoor | Wall Hanging Photo Display | other | no |
| 223 | Nextdoor | Vintage Wooden Window Frame | furniture_decor | **yes** |
| 224 | Nextdoor | Cleaning Multiservice | other | no |
| 225 | Nextdoor | Cleaning services | other | no |
| 226 | Nextdoor | Free Wooden Pallet | tools_diy | no |
| 227 | Nextdoor | LOCAL BUSINESS OWNERS & ASPIRING ENTREPRENEURS | other | no |
| 228 | Nextdoor | FREE Wooden Pallet in SW Houston | tools_diy | no |
| 229 | Nextdoor | H-E-B Texas Sheet Cake Baking Mix | home_kitchen | no |
| 230 | Nextdoor | Vintage Glass and Ceramic Insulators | other | **yes** |
| 231 | Nextdoor | Servicios de RemodelaciÃ³n CR | other | no |
| 232 | Nextdoor | Free firewood | other | no |
| 233 | Nextdoor | FREE: Large Dog Bed (36" x 54") â Pickup Only | furniture_decor | no |
| 234 | Nextdoor | Male Neutered, Declawed Indoor Cat | other | no |
| 235 | Nextdoor | Pet Supplies Bundle | other | no |
| 236 | Nextdoor | Dog Door replacement flap | other | no |
| 237 | Nextdoor | Hamsters â Free / Cage & Supplies $50 | other | no |
| 238 | Nextdoor | Security Boss Replacement Part | other | no |
| 239 | Nextdoor | 8 month old female cat | other | no |
| 240 | Nextdoor | Family Dog in Need of a Caring New Home | other | **yes** |
| 241 | Nextdoor | Schwinn 410i Elliptical | sports_outdoors | no |
| 242 | Nextdoor | Stationary Exercise Bike Still Available!!! | sports_outdoors | no |
| 243 | Nextdoor | Lifetime Basketball Hoop - FREE! | sports_outdoors | no |
| 244 | Nextdoor | Free Set of three Fishing Rods and reels | sports_outdoors | no |
| 245 | Nextdoor | Adidas Workout Bench | furniture_decor | no |
| 246 | Nextdoor | Portable Basketball Hoop | sports_outdoors | no |
| 247 | Nextdoor | Free Spalding Basketball Hoop | sports_outdoors | no |
| 248 | Nextdoor | Remington ammo, Christmas decor-204 Munford | other | no |
| 249 | Nextdoor | Giantex Washing Machine | home_kitchen | no |
| 250 | Nextdoor | Vintage Waffle Iron - works | other | **yes** |
| 251 | Nextdoor | â Looking for a Coffee Maker/Keurig Donation | home_kitchen | no |
| 252 | Nextdoor | Compact Refrigerator | home_kitchen | no |
| 253 | Nextdoor | Humidifier/Facial Steamer | home_kitchen | no |
| 254 | Nextdoor | Used General Electric Household Microwave Oven | home_kitchen | no |
| 255 | Nextdoor | Kenmore Side-by-Side Refrigerator Not Working! | home_kitchen | no |
| 256 | Nextdoor | Bissell Vacuum Cleaner | electronics | no |
| 257 | Nextdoor | Free landscaping Stones | other | no |
| 258 | Nextdoor | White Birch lighted trees for Christmas display | other | no |
| 259 | Nextdoor | FREE scented White Butterfly Ginger Plants & Corms | other | no |
| 260 | Nextdoor | Stack of Natural Stone Slabs | other | no |
| 261 | Nextdoor | Mexican Petunias Cut Garden Plants | other | no |
| 262 | Nextdoor | Cinnabar Peach Gingers & White Butterfly sweet scented Gingers:. corms & bare root plants | other | no |
| 263 | Nextdoor | Gray River Rocks for landscaping | other | no |
| 264 | Nextdoor | FREE Year-round Blooming Native & non-native Plants : HURRYL | other | no |
| 265 | Nextdoor | Argento Paper Cutter and Hole Punch | tools_diy | no |
| 266 | Nextdoor | Assorted Wood and PVC Pipes | other | no |
| 267 | Nextdoor | RotoZip Spiral Saw SCS01 | tools_diy | no |
| 268 | Nextdoor | jewelry making quality tools | jewelry_watches | no |
| 269 | Nextdoor | 2011 Camry Floor Mats | other | no |
| 270 | Nextdoor | Spare Tires | other | no |
| 271 | Nextdoor | Adam's Polishes Spray Bottles | other | no |
| 272 | Nextdoor | 2 Free Tires | other | no |
| 273 | Nextdoor | NEED TO FIND - 4x100mm 16-inch OEM 2011-2015 Scion IQ Rims | other | no |
| 274 | Nextdoor | Set of 3 Car Headrests rear seat 2011 Camry | other | no |
| 275 | Nextdoor | Mobile Mechanic | other | no |
| 276 | Nextdoor | Car Key Fob | electronics | no |

---

## 5. Trash Nothing API: what a human must do, and the exact query

### Read access exists; write access does not

The fetched OpenAPI v1.4 spec (`trashnothing.com/api/v1.4/trashnothing-openapi.yaml`, 200 OK,
read in full) defines **12 endpoints, every one of them `GET`** -- confirmed by grepping the
spec for HTTP verbs (`get:` x12, no `post:`/`put:`/`patch:`/`delete:` anywhere). This settles
the open question in `seeding-and-distribution.md` §2's table row for Trash Nothing: **read is
real and documented; write/publish is not exposed by this API at all**, not merely
"unconfirmed."

All 12 endpoints accept a `securityDefinitions.api_key` (an `apiKey`-type key passed as the
`api_key` query parameter) as an alternative to OAuth. The spec's description says this key
"[provides] access to specific public API endpoints which don't require user authorization,"
and several endpoints note that when using an api_key instead of OAuth, `sources=trashnothing`
or `sources=open_archive_groups` becomes **required** together with `latitude`/`longitude`/
`radius` (an api_key request has no logged-in user, so it can't fall back to "your groups").

### Getting a key requires a human, and that page is itself blocked to this session

The spec tells developers to go to **`https://trashnothing.com/app/developer`** ("visit the
Trash Nothing Developer page" to "register your app for use with the API"). Both that URL and
the older `https://trashnothing.com/developer` alias returned **HTTP 403 with a Cloudflare
"Just a moment..." challenge page** from this container, confirmed twice independently (once
via `curl`, once via a second fetch tool) -- so the actual signup form's fields could not be
observed and are **not fabricated below**. What can be said with confidence, from the spec
text and Trash Nothing's known product shape (it federates Freecycle-network groups and has
always required a logged-in account to browse/post), plus what is *not* said anywhere found:

- No public, self-serve "get an API key by email/form, no login" path was found anywhere
  (not on the spec page, not in cached search results, not in the sources cited by
  `seeding-and-distribution.md`).
- No evidence was found that key issuance requires *manual staff review* (unlike, say, a
  paid data API) -- but this could not be confirmed either, because the registration page
  itself is Cloudflare-gated from this environment.

**Exact steps a human must do** (from a real browser/IP, not this container):

1. Go to `https://trashnothing.com` and create a normal account (or sign in with an existing
   one) -- this is the same account type used to join local Freecycle-network groups.
2. While logged in, visit `https://trashnothing.com/app/developer` and use the "register your
   app" flow referenced in the OpenAPI spec's description. Expect to supply an app name and
   description at minimum; a callback/redirect URL may be requested for OAuth-capable apps but
   should not be required for a read-only, api_key-only integration like this one, since the
   spec shows all 12 endpoints work with a bare `api_key` and none of them require a signed-in
   user's data.
3. Trash Nothing issues an `api_key` value tied to that app registration. Store it as a secret
   (never in the repo); it goes in the query string of every request below.
4. There is nothing to build server-side to *use* the key beyond passing it as `?api_key=...`
   -- confirm the spec's `security: [api_key: []]` block on the two endpoints below still
   matches (`/posts` and `/posts/search`) before wiring it up.

### The exact query, ready to paste once a key exists

"Free offers within 25 miles of Houston (29.76, -95.37)" maps to the **`GET /posts`** ("List
posts") endpoint, not `/posts/search` (which requires a text `search` term). 25 miles is
40,233.6 meters; the API's `radius` parameter is meters, capped at 80,500 (~50 miles), so
40,234 fits comfortably:

```
GET https://trashnothing.com/api/v1.4/posts
    ?api_key=YOUR_API_KEY
    &types=offer
    &sources=trashnothing,open_archive_groups
    &latitude=29.76
    &longitude=-95.37
    &radius=40234
    &sort_by=distance
    &per_page=100
    &page=1
```

As one line for `curl`:

```bash
curl -sS "https://trashnothing.com/api/v1.4/posts?api_key=YOUR_API_KEY&types=offer&sources=trashnothing,open_archive_groups&latitude=29.76&longitude=-95.37&radius=40234&sort_by=distance&per_page=100&page=1"
```

Notes for whoever runs this:
- `sources=trashnothing,open_archive_groups` is required in this exact form for api_key
  (non-OAuth) requests per the spec -- the `groups` source needs explicit `group_ids` of
  open-archive groups instead, which requires knowing those IDs in advance.
- The response returns `num_posts` and `num_pages`; with `per_page=100` (the max) you may need
  several pages. The API caps any single query at 1,000 results total (50 pages at the default
  size) -- if Houston within 25 miles exceeds that, narrow with a shorter `date_min`/`date_max`
  window instead of relying on pagination alone.
- Swap `types=offer` for `types=offer,wanted,admin` if "wanted" posts (people asking for
  keepsakes) turn out to matter too; today's question is about supply, so `offer` is correct.

---

## 6. Caveats -- read before trusting the 2.9% number

1. **One day, one sample, no repeats yet.** This is a single fetch at 2026-09-09 ~02:34 UTC.
   Free-listing boards turn over within hours; the `sample-supply.sh` script exists precisely
   so this can be re-run daily for a week and averaged -- until that happens, 2.9% is a
   snapshot, not a trend.
2. **Title/caption only, not full listing bodies.** Craigslist's search page and Nextdoor's
   Free Finds grid both show only a title (Nextdoor) or title (Craigslist); the fuller
   backstory that makes an object "sentimental" -- "this was my grandmother's," "we've had it
   20 years," a paragraph about a move or a loss -- usually lives in the listing *body*, which
   was not fetched (would require opening 276 individual listing pages). **The true sentimental
   fraction is very likely higher than 2.9%** for this reason alone; this number is a floor set
   by what a title alone reveals, not a ceiling.
3. **Keyword matching is literal and produces both false positives and false negatives.**
   - False positive: "Family Dog in Need of a Caring New Home" matched on `family` but is a
     pet rehoming, not a sentimental object.
   - Likely false negatives: "1980s spinet grand paino [sic] co." (an old piano, arguably
     vintage/antique by age, not by keyword), "ENHANCED OAK HUTCH," "Teak entertainment
     center," "Waterbed Headboard" -- older furniture that a human reader might call
     sentimental-adjacent or at least "not IKEA-new," but that used none of the nine specified
     keywords. A stricter human read of all 276 titles would likely move the count by a couple
     of items in each direction; it would not plausibly turn 2.9% into 30%.
4. **Page-size and pagination limits.** Craigslist's snapshot showed no pagination control, so
   204 may or may not be Houston's entire current `free` inventory (§3). Nextdoor's Free Finds
   grid is itself a client-paginated/infinite-scroll UI; 72 is what the first server-rendered
   payload contained, not necessarily every active Houston free listing at that moment.
5. **A meaningful share of "free" listings are not homegoods at all.** 141/276 (51%) fell into
   `other` -- car parts, tires, moving boxes, landscaping plants/rocks, pet rehoming, service
   ads (cleaning, mobile mechanic), and outright scam posts ("SCAM! ... SCAM SCAM SCAM!",
   repeated on Craigslist). This matters for Keepsake specifically: even before asking "is it
   sentimental," a large fraction of the two boards' free supply isn't in Keepsake's object
   categories at all.
6. **Only two of the four intended sources were actually sampled.** Trash Nothing and OfferUp
   both 403'd; the 2.9% figure describes Craigslist + Nextdoor supply only, not "Houston free
   supply" in general. Trash Nothing in particular federates the Freecycle groups that
   `seeding-and-distribution.md` §3 describes as having a stronger free-only, keyword-driven
   culture (16,380 members in Houston Town alone) -- its sentimental fraction could plausibly
   differ from Craigslist/Nextdoor's in either direction, and this sample says nothing about
   it.
7. **No number in this file was invented.** Every count above traces to a saved raw file in
   `supply-raw/` and the CSV in `classification.csv`; every 403 is a saved 403 response, not an
   assumption.
