/**
 * Query-side half of semantic search (issue #38): turns a raw `q=` string
 * into a ranked list of listing ids, or `null` when `routes/feed.ts` should
 * fall back to `db/fts.ts`'s FTS5 search instead. Three things can trigger
 * that fallback, all deliberately distinguishable in the return value so a
 * test can drive each one on purpose (see `test/search.test.ts`):
 *
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
 * MIN_SCORE is deliberately **not** a relevance classifier, because a real
 * one isn't available cheaply: measured directly against real Workers AI
 * (`@cf/baai/bge-base-en-v1.5`, cosine, six pairs, same "brass sextant"
 * anchor text each time) —
 *
 *   identical text                        1.00
 *   close paraphrase, zero shared words    0.86
 *   same category, different item          0.56
 *   unrelated but concrete                 0.52
 *   random word-salad gibberish            0.55
 *   totally unrelated / abstract           0.42
 *
 * — this model's raw cosine scores do not separate "relevant" from
 * "irrelevant" cleanly; unrelated concrete text and outright gibberish both
 * score *higher* than one genuinely unrelated abstract pair. A threshold
 * that actually filtered "same category, different item" (0.56) would also
 * filter plenty of real matches, since a true synonym pair can plausibly
 * land in that same band. Building a real relevance classifier (a
 * cross-encoder re-ranker, or a margin relative to the top result rather
 * than an absolute cutoff) is out of scope here.
 *
 * So MIN_SCORE is set low, well under the "unrelated but concrete" floor
 * measured above, and exists only to catch the genuinely degenerate case —
 * an empty index, or a query so far outside the embedding space that even
 * Vectorize's own nearest neighbors are closer to orthogonal than to
 * anything real — not to enforce topical relevance. False negatives here
 * fall back to FTS (a listing is still findable); false positives serve an
 * imperfectly-ranked result, which is the honest ceiling of this approach
 * without a re-ranker. Revisit with real query traffic and, ideally, a
 * second-stage re-ranker before trusting this number to mean "relevant."
 */
import type { Env } from "../env.js";
import { embed } from "./embedding.js";
import { queryListingVectors, type VectorMatch } from "./vectorize.js";

const SEARCH_TOP_K = 100;
const MIN_SCORE = 0.3;

export async function vectorSearchCandidates(env: Env, rawQuery: string): Promise<VectorMatch[] | null> {
  const trimmed = rawQuery.trim();
  if (trimmed.length === 0) return null;

  const vector = await embed(env, trimmed);
  if (!vector) return null;

  const matches = await queryListingVectors(env, vector, SEARCH_TOP_K);
  if (matches === null) return null;

  return matches.filter((match) => match.score >= MIN_SCORE);
}

export type { VectorMatch };
