/**
 * Query-side half of semantic search (issue #38): turns a raw `q=` string
 * into a ranked list of listing ids, or `null` when `routes/feed.ts` should
 * fall back to `db/fts.ts`'s FTS5 search instead. Four things can trigger
 * that fallback, all deliberately distinguishable in the return value so a
 * test can drive each one on purpose (see `test/search.test.ts`):
 *
 *  0. `SEMANTIC_SEARCH` is not `"1"` — the kill switch, checked first. It is
 *     `"1"` in every environment as of 2026-09-07, so this is not the live
 *     answer anywhere; it is the rollback. With it off nothing below runs at
 *     all: no embedding call, no Vectorize call. See `semanticSearchEnabled`
 *     in `env.ts`.
 *  1. Vectorize is unavailable — no `env.VECTORIZE` binding, or the query
 *     call throws (`vectorize.ts` already turns both into `null`).
 *  2. Embedding the query failed — no `env.AI` result, a timeout, `MOCK_AI`
 *     (`embedding.ts` already turns all of these into `null`).
 *  3. Vectorize answered, but nothing it returned clears MIN_SCORE — every
 *     candidate is too dissimilar to the query to call it a real match.
 *     Vectorize always returns its `topK` nearest neighbors even when the
 *     index holds nothing relevant (there is no "no results" answer at the
 *     API level), so without this threshold the fallback in case 3 could
 *     never fire — exactly the kind of guard-that-can't-fail this project
 *     has shipped before.
 *
 * MIN_SCORE is deliberately **not** a relevance classifier, and cannot be
 * one. That is now a measurement rather than an opinion.
 *
 * Re-derived 2026-09-07 against real Workers AI, with a real credential, by
 * `tools/calibrate-min-score.mjs` (re-runnable; full output recorded in
 * `docs/design/min-score-calibration.md`). 19 listings in the shape
 * `embeddingText()` builds, 19 queries whose intended listing is known, and
 * 8 queries with no answer in the corpus at all:
 *
 *   true match          min 0.5693   mean 0.6811   max 0.7702
 *   wrong doc           min 0.4002   mean 0.5147   max 0.6542
 *   off-corpus, best    min 0.4850   mean 0.5559   max 0.6151
 *
 * **The true-match and off-corpus distributions overlap, so no absolute
 * cutoff separates them.** A floor above 0.6151 (needed to reject the worst
 * off-corpus query) would discard real matches scoring 0.5693. This is the
 * central fact about this number and the reason it is kept modest.
 *
 * Two things that overlap explains. First, `bge-base-en-v1.5` has no notion
 * of "unrelated": nothing in the corpus ever scored below 0.40 against
 * anything, so the "near orthogonal" case the original comment imagined does
 * not occur. Second, the highest off-corpus scores are not meaningful
 * queries but degenerate *text* — gibberish 0.6044, non-Latin script 0.6151,
 * repetition 0.5720 — while genuinely unrelated English sits lower (a
 * mortgage question 0.5834, a veterinary one 0.4856, a Kubernetes one
 * 0.4850). A cutoff cannot tell "nonsense" from "a terse listing", because
 * to this model they are the same distance from everything.
 *
 * What does the relevance work is **ranking**, not thresholding: the
 * intended listing ranked first for 16 of 19 queries and never below third,
 * including for the deliberately terse and obliquely-phrased ones.
 *
 * So 0.50 is a floor, chosen to sit below every true match observed (0.5693,
 * a 0.07 margin) while still rejecting the clearly-unrelated end of the
 * off-corpus range. Its job is case 3 above — noticing that the index is
 * empty or degenerate, so the FTS fallback can fire — and **not** deciding
 * topical relevance. It must not be raised toward 0.62 to "improve
 * precision": the measurement says that trades a real, graceful FTS fallback
 * for silently dropped matches.
 *
 * The previous value, 0.3, was below every score this model produces for
 * anything at all, which made case 3 unreachable — a guard that could not
 * fail. The pre-existing comment's six unattributed cosine figures are
 * superseded by the run above; where they overlap they were roughly the
 * right shape, but they were never reproducible and are not carried forward.
 *
 * Re-run the calibration if `MODELS.embedding` changes. The corpus is
 * synthetic and small; treat these as the floor's order of magnitude, not
 * as production statistics.
 */
import type { Env } from "../env.js";
import { semanticSearchEnabled } from "../env.js";
import { embed } from "./embedding.js";
import { queryListingVectors, type VectorMatch } from "./vectorize.js";

const SEARCH_TOP_K = 100;
const MIN_SCORE = 0.5;

export async function vectorSearchCandidates(env: Env, rawQuery: string): Promise<VectorMatch[] | null> {
  // The kill switch, checked before anything else so that with the flag off
  // this function cannot embed, cannot call Vectorize, and cannot return
  // anything but `null` — which `routes/feed.ts` reads as "fall back to
  // FTS". This is the fourth fallback trigger, and the only one that holds
  // no matter what the bindings or the index are doing. See
  // `semanticSearchEnabled` in `env.ts` for why it is off everywhere.
  if (!semanticSearchEnabled(env)) return null;

  const trimmed = rawQuery.trim();
  if (trimmed.length === 0) return null;

  const vector = await embed(env, trimmed);
  if (!vector) return null;

  const matches = await queryListingVectors(env, vector, SEARCH_TOP_K);
  if (matches === null) return null;

  return matches.filter((match) => match.score >= MIN_SCORE);
}

export type { VectorMatch };
