# `MIN_SCORE` calibration — semantic search (issue #38)

Run **2026-09-07**, against real Workers AI with a real Cloudflare credential.
Reproduce with `tools/calibrate-min-score.mjs`; this file is the durable record
step 4 of the Vectorize runbook asks for.

```sh
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node tools/calibrate-min-score.mjs
```

Model: `@cf/baai/bge-base-en-v1.5` (`MODELS.embedding`) · 768 dims · cosine.
Corpus: 19 synthetic listings built through the same `embeddingText()` shape the
indexer uses (title, story, `name: value` aspect lines), including deliberately
terse ones and a zero-aspect one (#40). 19 queries with a known intended
listing; 8 queries with no answer in the corpus.

## Result

```
  true match         min 0.5693  mean 0.6811  max 0.7702
  wrong doc          min 0.4002  mean 0.5147  max 0.6542
  off-corpus best    min 0.4850  mean 0.5559  max 0.6151

  lowest true match : 0.5693
  highest off-corpus: 0.6151
  NOT SEPARABLE by an absolute cutoff.
```

**The two distributions overlap.** Rejecting the worst off-corpus query needs a
floor above 0.6151; keeping the weakest true match needs one below 0.5693.
No single number does both. `MIN_SCORE = 0.5` is therefore set as a *floor* —
below every true match observed, above the clearly-unrelated end — and is not
asked to judge relevance.

### Off-corpus queries, best score each

| Query | Kind | Best score |
| --- | --- | --- |
| `kubernetes ingress controller tls termination` | unrelated (technical) | 0.4850 |
| `symptoms of feline hyperthyroidism` | unrelated (concrete) | 0.4856 |
| `quarterly deferred tax liability reconciliation` | unrelated (abstract) | 0.5335 |
| `` (blank-ish) | degenerate | 0.5679 |
| `zzzzz zzzzz zzzzz` | degenerate repetition | 0.5720 |
| `refinance a thirty year fixed mortgage rate` | unrelated (abstract) | 0.5834 |
| `asdkj qwe zxcv hjkl piou` | gibberish | 0.6044 |
| `ةيبرعلا ةغللا سيردت` | non-Latin script | 0.6151 |

The ceiling is set by *degenerate text*, not by meaningful unrelated queries —
gibberish and non-Latin script outscore a real question about mortgages. To this
model, nonsense and a terse listing sit at a similar distance from everything,
which is precisely why a cutoff cannot separate them.

Nothing in the corpus ever scored below **0.40** against anything. The
"near-orthogonal query" the original comment imagined does not occur with this
model, so a floor at the old 0.3 was unreachable — fallback case 3 in
`search/search.ts` could never fire.

### What actually provides relevance

Ranking, not thresholding. The intended listing ranked **first for 16 of 19
queries** and never below third — including the terse listings
(`Wooden high chair` → "something for feeding a toddler at the table") and the
zero-aspect one (`Small brass reading lamp` → "a bedside light to read by",
0.7498, rank 1).

The three that did not rank first were all outranked by the same listing (the
convertible crib), whose long domestic story is a broad attractor. A ranking
wart, not a threshold problem; noted here in case it recurs on real data.

## Caveats

The corpus is synthetic, 19 documents, written by the same session that ran the
measurement. These numbers give the floor's order of magnitude, not production
statistics. Re-run if `MODELS.embedding` changes — an index built at one
model's scale cannot be compared against another's.
