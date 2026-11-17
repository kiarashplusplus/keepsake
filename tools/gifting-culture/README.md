# tools/gifting-culture

Compiles what English Wikipedia says about **gift-giving customs** into one neutral JSON record per
city: verbatim passages, each pinned to the article revision it came from and labelled with the
place it is evidence _for_ (the city itself, its region, or its country).

This is the data half of a two-part plan (#394). The other half turns these records into
user-facing, search-friendly stories, and its tone has to be calibrated with care, so it is
deliberately **not** here. Nothing in this tool writes prose. The records are built so the story
layer can't overclaim by accident; see [what the data can support](#what-the-data-can-and-cannot-support).

```sh
# 1. Which cities: Wikidata, sharded per country
NODE_USE_ENV_PROXY=1 node tools/gifting-culture/pipeline.mjs locations --countries JP,US --min-population 500000

# 2. What Wikipedia says about each one
NODE_USE_ENV_PROXY=1 node tools/gifting-culture/pipeline.mjs collect

# or both
NODE_USE_ENV_PROXY=1 node tools/gifting-culture/pipeline.mjs all --countries JP --min-population 1000000
```

`NODE_USE_ENV_PROXY=1` is only needed behind an HTTPS proxy, as in agent containers; Node's
`fetch` ignores `HTTPS_PROXY` otherwise. There are no npm dependencies. Set
`WIKIMEDIA_USER_AGENT` to something that identifies you and includes a contact, as
[Wikimedia's policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)
asks. The default is generic and prints a reminder.

Output goes to `tools/gifting-culture/out/` (gitignored; `--out` moves it):

```
out/
  locations.json            cities + their regions and countries, from Wikidata
  cities/<ISO2>/<slug>--<QID>.json   one record per city
  index.json                every city record present, with its coverage level
  .cache/http/              every successful response, keyed by URL
```

## How it works

**Locations** (`lib/wikidata.mjs`). Runs one SPARQL query per country: items that are a city
(`P31/P279*` → Q515) with population ≥ `--min-population` and an English Wikipedia article, plus
their first-level administrative region (`P131*` → Q10864048). A single worldwide query times
out well before the threshold gets interesting; per country it takes a few seconds. A country
whose query fails is written to `failedShards` **and fails the run**, because a city list that is
quietly missing a country is worse than none. `--qids Q60,Q1490` picks exact cities instead.
Then `wbgetentities` adds labels, English demonyms (P1549, e.g. "Osakan", "Japanese") and
"culture of" items (P2596, e.g. Japan → _Culture of Japan_).

A city claimed by two countries keeps both. Choosing one would be a political statement, and the
record would then carry it.

**Sources** (`lib/sources.mjs`). For each city, and once per run for each of its regions and
countries, the candidate articles are:

| `discoveredBy`    | What                                                                                                                                                                                                         | Must the paragraph name the place?                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `place-article`   | the place's own article                                                                                                                                                                                      | no                                                                              |
| `culture-article` | Wikidata's P2596 article, plus probed titles that exist: _Culture of X_, _Etiquette in X_, _Gift-giving in X_, _Public holidays in X_, _Christmas in X_, … (country list is longer than the city/region one) | no                                                                              |
| `search`          | Wikipedia full-text search, `"X" gift-giving tradition` and `"<demonym>" gifts custom`, top `--search-limit` (default 8). Not run for regions.                                                               | **yes**: the paragraph or a heading above it must name the place or its demonym |

The mention rule is what stops _Red envelope_'s Vietnam section from being filed under China.
The article's lead mentioning the place is deliberately **not** enough.

**Extraction** (`lib/extract.mjs`, `lib/lexicon.mjs`). A paragraph is kept when it uses gifting
vocabulary (`matchedBy: "paragraph"`), sits under a heading that does (`"heading"`; _Etiquette
in Japan_'s "Seasonal gifts" paragraph never says "gift"), or belongs to an article whose title
is a gifting term (`"article-title"`, e.g. _Omiyage_). The vocabulary is in `lexicon.mjs`. It
includes named customs (omiyage, hongbao, eidi, kōden, pasalubong, …) and excludes commerce
("gift shop", "gift card", "souvenir stand"), "gifted", and verb uses of "presents". Sections
like References and See also are skipped.

Every kept passage gets **tags**, `occasions` (christmas, lunar-new-year, eid, wedding, funeral,
travel, …) and `practices` (money, host-gift, reciprocity, presentation, taboo, charity, heirloom,
civic-or-diplomatic, commercial, …). Each tag records the words that earned it. They are labels a
person can audit, not judgements. A passage whose only labels are `civic-or-diplomatic` and/or
`commercial`, with no occasion, is marked `weak` ("the statue was a gift from France").

No model is involved at any stage. A model here would be a second author whose voice nobody has
calibrated, and calibrating the voice is the job of the later stage.

## The record

```jsonc
{
  "schemaVersion": 1,
  "location": { "qid": "Q35765", "name": "Osaka", "regions": [...], "countries": [{ "iso2": "JP", ... }], ... },
  "coverage": {
    "level": "country",                          // narrowest scope with a non-weak passage
    "passages":       { "city": 2, "region": 0, "country": 31 },
    "strongPassages": { "city": 0, "region": 0, "country": 29 }
  },
  "passages": [{
    "id": "…",                                    // sha256(title + text), stable across runs
    "scope": "country",                           // what this is evidence *for*
    "subject": { "qid": "Q17", "name": "Japan" },
    "source": { "title": "Etiquette in Japan", "revisionId": 1364352568, "revisionUrl": "…?oldid=…", "discoveredBy": "culture-article" },
    "headingPath": ["Gifts and gift-giving", "Seasonal gifts"],
    "text": "…verbatim paragraph…",
    "giftSentences": ["…"],                       // the sentences that matched, or all if matched by heading/title
    "matchedBy": "heading",
    "giftTerms": ["gifts"],
    "subjectMentions": [],
    "tags": { "occasions": { "seasonal": ["chūgen", "seibo"] }, "practices": { … } },
    "weak": false
  }],
  "sources": [{ "title": "…", "revisionId": …, "authorsUrl": "…&action=history", "license": { "name": "CC BY-SA 4.0" }, "passages": 12 }],
  "attribution": "…"
}
```

A paragraph that turns up at several scopes is kept once, at the narrowest. That happens when a
city search lands in _Etiquette in Japan_ on a paragraph that names the city.

## What the data can and cannot support

These points are the brief for the story layer.

- **`scope` is a claim boundary.** A `country` passage supports "in Japan, …", not "in Osaka, …".
  For most cities, most passages will be country scope, because Wikipedia documents customs at the
  national or cultural level. `coverage.level` says which case a city is in. A city at `country`
  level has nothing city-specific to say, and a story should not pretend it does.
- **`none` is a real answer.** A city where Wikipedia says nothing about gifting should get no
  story, not an invented one.
- **Etiquette articles generalise.** _Etiquette in X_ pages describe norms in sweeping terms
  ("Japanese people do not…"). Repeating that confidently is how a story turns into a stereotype.
  The passages are verbatim so the generalisation stays visibly the source's.
- **English Wikipedia is not neutral coverage.** It documents some cultures in depth and others
  barely, and it leans towards holiday-shopping framing for Western countries. Thin data for a
  place says more about the source than about the place.
- **Licensing.** Passages are CC BY-SA 4.0. Publishing them, or text adapted closely from them,
  requires attribution to Wikipedia (each `source` has an `authorsUrl`) and the same licence on
  the result. A story that only _uses facts_ learned here is a different case from one that
  paraphrases a paragraph. Where that line sits for a published page is a question for whoever
  decides the story layer's approach (see `docs/legal-considerations.md`), and it is not settled
  here.

## Known gaps

- **"[citation needed]" is invisible.** TextExtracts strips templates, so an unsourced sentence
  looks the same as a sourced one. Every passage has `revisionUrl`, so a reviewer can check.
  Flagging it automatically would mean mapping plain-text paragraphs back to wikitext.
- **City = Wikidata's Q515 class tree.** A place that Wikidata only calls a "town" or
  "municipality" is missed by the population query. Use `--qids` to add it. Wikidata also has some
  overlapping entities (_Tokyo_ and _Tokyo Proper_ are both cities over 1M).
- **Case-sensitive name matching** avoids "nice" ≠ Nice but misses lower-case mentions. Demonyms
  over-match a little: "American" also matches inside "Latin American".
- **English only.** The Japanese Wikipedia says far more about 中元 than the English one does.
  Adding another language means a lexicon per language, which is a separate decision.

## Cost

Requests are serial, at least 500 ms apart (`--min-interval-ms`). Each one retries on 429/5xx,
`maxlag` and timeouts with exponential backoff, and treats `Retry-After` as a floor. A city
typically needs about 15–25 requests, and its country's ~30 are made once per run. Wikimedia
rate-limits shared IPs hard: from an agent container, most requests in the first live run got a
429 before succeeding, and a single city took several minutes. From an ordinary IP, budget about
one city per 15–30 s. The on-disk cache makes re-runs and resumed runs nearly free. `--refresh`
re-fetches everything.

## Tests

```sh
pnpm --filter @keepsake/gifting-culture test
```

`test/extract.test.mjs` covers what counts as a passage, including the false positives found in
real articles. `test/http.test.mjs` uses a fake fetch and a fake clock to run every retry, timeout
and cache branch. `test/compile.test.mjs` covers the Wikidata merge and the scope/coverage
contract. None of them touch the network. The live behaviour is checked by running the pipeline
and reading its output.
