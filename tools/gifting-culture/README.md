# tools/gifting-culture

Compiles what English Wikipedia says about **gift-giving customs** into one neutral JSON record per
city: verbatim passages, each pinned to the article revision it came from and labelled with the
place it is evidence _for_ (the city itself, its region, or its country).

This is the data half of a two-part plan (#394). The other half turns these records into
user-facing, search-friendly stories, and its tone has to be calibrated with care, so it is
deliberately **not** here. Nothing in this tool writes prose. The records are built so the story
layer can't overclaim by accident; see [what the data can support](#what-the-data-can-and-cannot-support).

```sh
# 1. Which cities: Wikidata, sharded per country (SPARQL, not rate-limited)
NODE_USE_ENV_PROXY=1 node tools/gifting-culture/pipeline.mjs locations --countries JP,US --min-population 500000

# 2. Every gifting paragraph in English Wikipedia, from the dump (~27 GB streamed, resumable)
node tools/gifting-culture/pipeline.mjs corpus

# 3. Assign those paragraphs to each city, offline
node tools/gifting-culture/pipeline.mjs collect
```

`NODE_USE_ENV_PROXY=1` is only needed behind an HTTPS proxy, as in agent containers; Node's
`fetch` ignores `HTTPS_PROXY` otherwise. There are no npm dependencies; the dump stage shells out
to `curl` and `bzcat`. The default User-Agent identifies the tool and names
`https://keepsake.ing` as its contact, as
[Wikimedia's policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)
asks.

Output goes to `tools/gifting-culture/out/` (gitignored; `--out` moves it):

```
out/
  locations.json            cities + their regions and countries, from Wikidata
  dump/                     the multistream index (~290 MB), downloaded once per snapshot
  corpus/manifest.json      which dump snapshot the corpus came from
  corpus/parts/NNNN.jsonl   gifting paragraphs, one chunk of the dump per file
  cities/<ISO2>/<slug>--<QID>.json   one record per city
  index.json                every city record present, with its coverage level
  .cache/http/              API-path responses, keyed by URL / revision
```

## Two ways to read Wikipedia, and why the dump is the default

Wikimedia rate-limits its APIs per client identity (see [Rate limits](#rate-limits)), and from an
agent container every unauthenticated API request was refused. Getting "a lot of Wikipedia" through
the API means authenticating and then waiting. The **dump** has neither problem:

|                    | dump (`corpus` + `collect`)                                             | API (`collect --source api`)                                   |
| ------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| Rate limits        | none (dumps.wikimedia.org; two connections, as it asks)                 | per identity: 200/min with this User-Agent, more authenticated |
| What it reads      | **every** article in English Wikipedia                                  | what a search ranks in its top 8, plus probed titles           |
| Freshness          | the snapshot (refreshed ~twice a month); revision ids say which         | current revisions                                              |
| Text               | wikitext rendered by `lib/wikitext.mjs` (fidelity measured below)       | MediaWiki's own plain text (TextExtracts)                      |
| Citation signals   | **yes**: footnote count and "citation needed"-style flags per paragraph | no: TextExtracts strips both                                   |
| Cost of a full run | one scan (measured below), then any number of offline `collect` runs    | ~20 requests per city, ~30 per country                         |

The API path stays for quick, current, small runs and as the reference the dump's rendering is
checked against.

**Rendering fidelity.** `fidelity.mjs` renders articles from the dump and compares every gifting
passage with MediaWiki's own plain text for the same article. Measured 2026-11-17 on 28 articles
(18 at the same revision, 150 passages): **96.7 %** match at ≥ 0.95 word overlap, 98.0 % at ≥ 0.90,
98.7 % at ≥ 0.80. The rest are MediaWiki splitting one paragraph in two (the dump's version is the
whole paragraph) and IPA transcriptions, which are dropped on purpose. 0.7 % of passages carry
`unknownTemplates > 0`, the renderer's own admission that something inline was not reproduced. Re-run
it after changing `lib/wikitext.mjs`:

```sh
node tools/gifting-culture/fidelity.mjs --cache out/.cache/http --index out/dump/enwiki-latest-pages-articles-multistream-index.txt.bz2
```

## How it works

**Locations** (`lib/wikidata.mjs`). Runs one SPARQL query per country: items that are a city
(`P31/P279*` → Q515) with population ≥ `--min-population` and an English Wikipedia article, plus
their first-level administrative region (`P131*` → Q10864048). A single worldwide query times
out well before the threshold gets interesting; per country it takes a few seconds. A country
whose query fails is written to `failedShards` **and fails the run**, because a city list that is
quietly missing a country is worse than none. `--qids Q60,Q1490` picks exact cities instead.
A second SPARQL query adds labels, English demonyms (P1549, e.g. "Osakan", "Japanese") and the
English article of each "culture of" item (P2596, e.g. Japan → _Culture of Japan_). Both run on
the Query Service, which is outside the API gateway's rate limits.

A city claimed by two countries keeps both. Choosing one would be a political statement, and the
record would then carry it.

**Corpus** (`lib/dump.mjs`, `lib/corpus.mjs`). The dump is cut into 128 chunks on bzip2 stream
boundaries. Each chunk is fetched with one HTTP Range request, decompressed by `bzcat` and parsed
on its own worker thread, two at a time. A page is rendered only if it passes two cheap
pre-filters: a plain substring test, then the precise lexicon on its text with references
stripped ("Gift" in a citation title is the usual false start). A test proves the pre-filter
accepts every phrase the lexicon does; before that test it silently dropped "birthday present".
Each paragraph that passes the same relevance rule as the API path is written with its `refs`,
`flags` and `unknownTemplates`. A chunk is renamed into place only after its range has been read
to the end, so an interrupted scan resumes at the first unfinished chunk. A corpus from an older
snapshot refuses to be extended by a newer one.

**Sources, dump path** (`lib/corpus-sources.mjs`). For each city, region and country:

| `discoveredBy`    | What                                                                                                 | Must the paragraph name the place?                   |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `place-article`   | the place's own article                                                                              | no                                                   |
| `culture-article` | Wikidata's P2596 article                                                                             | no                                                   |
| `about-title`     | any article whose title says it is about the place: _Christmas in Japan_, _Japanese wedding customs_ | no                                                   |
| `corpus-mention`  | any other article in Wikipedia                                                                       | **yes, in the same sentence** as the gift vocabulary |

A name shared by several places in the run ("Valencia", "Hyderabad") only counts for a place
whose country or region the same article also names; otherwise it counts for none of them.

**Sources, API path** (`lib/sources.mjs`). For each city, and once per run for each of its regions and
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
    "tags": { "occasions": { "seasonal": ["chūgen", "seibo"] }, "practices": { … } },  // from giftSentences only
    "weak": false,
    "rendering": {                                // what the source text says about its own reliability
      "renderer": "dump-wikitext",                // or "textextracts" (API path)
      "refs": 2,                                  // footnotes in the paragraph; null on the API path (stripped)
      "flags": ["citation-needed"],               // maintenance tags; null on the API path (stripped)
      "unknownTemplates": 0                       // inline templates the renderer could not reproduce
    }
  }],
  "sources": [{ "title": "…", "revisionId": …, "authorsUrl": "…&action=history", "license": { "name": "CC BY-SA 4.0" }, "passages": 12 }],
  "attribution": "…"
}
```

A paragraph that turns up at several scopes is kept once, at the narrowest. That happens when a
city search lands in _Etiquette in Japan_ on a paragraph that names the city.

**Weak passages** are kept but never set `coverage.level`. A passage is weak when its gift
sentences name no occasion and their only practice tags are `civic-or-diplomatic` (a statue from
France, cherry trees "from the citizens of Tokyo"), `institutional` (a bequest to a library) or
`commercial` (a shop's souvenirs). These rules and the name rule (a capitalised "Gift" mid-sentence
is a record label, a show or "GIFT City", not a gift) come from reading the first corpus sample.
Before them, Tokyo, Yokohama and Kawasaki all claimed city-level gifting culture on the strength of
a garden, a cherry tree and a song title. Each such sentence is now a test case.

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

- **On the API path, "[citation needed]" is invisible.** TextExtracts strips templates, so
  `rendering.refs` and `rendering.flags` are `null` there. The dump path has both. A story layer
  that wants only sourced claims should use dump-path records and `refs > 0`.
- **The dump is a snapshot.** It is refreshed about twice a month; each passage's `revisionId`
  says which revision it reflects. A corpus is pinned to one snapshot and refuses to mix in another.
- **City = Wikidata's Q515 class tree.** A place that Wikidata only calls a "town" or
  "municipality" is missed by the population query. Use `--qids` to add it. Wikidata also has some
  overlapping entities (_Tokyo_ and _Tokyo Proper_ are both cities over 1M).
- **Case-sensitive name matching** avoids "nice" ≠ Nice but misses lower-case mentions. Demonyms
  over-match a little: "American" also matches inside "Latin American".
- **Corpus mentions are recall-first.** Same-sentence co-occurrence plus the weak rules remove
  most noise, but not all. A sentence that names a city and a gift for an unrelated reason can
  still read as strong. `discoveredBy: "corpus-mention"` marks these passages so a reviewer or the
  story layer can weigh them below `place-article` and `about-title`.
- **English only.** The Japanese Wikipedia says far more about 中元 than the English one does.
  Adding another language means a lexicon per language, which is a separate decision.

## Rate limits

Wikimedia rate-limits its Action and REST APIs **per client identity, per minute**
([policy](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits), 2026):

| Identity                                     | Limit                     |
| -------------------------------------------- | ------------------------- |
| No contact in the User-Agent                 | 10 req/min, shared per IP |
| User-Agent with a URL or email               | 200 req/min               |
| Authenticated, new account                   | 200 req/min               |
| Authenticated, established editor            | 2,000 req/min             |
| Bot-flagged account, or running on Toolforge | exempt                    |

The client (`lib/http.mjs`) handles this as follows:

- It sends a compliant User-Agent.
- It authenticates when credentials are in the environment:
  - `WIKIMEDIA_CLIENT_ID` + `WIKIMEDIA_CLIENT_SECRET` for an OAuth 2 client-credentials
    consumer, or
  - `WIKIMEDIA_ACCESS_TOKEN` for an owner-only token. The client keeps the cookies Wikimedia sets,
    which the policy requires before it treats such a token as authenticated.
- It **paces** requests below the tier's budget (`--rpm` overrides), halves the pace on each 429
  and earns it back on success.
- It resolves titles and current revisions **50 per request**, and fetches an article's text only
  when the cache lacks that exact revision, so a re-run costs one request per 50 articles plus one
  per edited article.

**What was measured from an agent container (2026-11-17):** every API request was refused with
429, even with the compliant User-Agent. Each was refused with the same `Retry-After` across three
different egress IPs, on a User-Agent string never sent before. The limiter is aggregating that
cloud provider's address range, not keying on the User-Agent. From there, **unauthenticated API
access does not work at any pace**: only authentication ("enforced per user") or running somewhere
else gets a budget of its own. The Wikidata Query Service is outside these limits and worked
throughout.

To authenticate, propose an OAuth 2.0 consumer at
`https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose/oauth2` with the
**client credentials** grant and only the basic rights (read access needs nothing more). Check the
form's current wording there rather than trusting this paragraph's memory of it.
Then put the id and secret in the environment. A bot-flagged account (the plan of record for large
recurring runs) authenticates the same way, with the consumer registered under the bot account.

## Tests

```sh
pnpm --filter @keepsake/gifting-culture test
```

`test/extract.test.mjs` covers what counts as a passage, including the false positives found in
real articles. `test/http.test.mjs` uses a fake fetch and a fake clock to run every retry, timeout
and cache branch. `test/compile.test.mjs` covers the Wikidata merge and the scope/coverage
contract. None of them touch the network. The live behaviour is checked by running the pipeline
and reading its output.
