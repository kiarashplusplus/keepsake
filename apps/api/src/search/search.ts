/**
 * Query-side half of semantic search (issue #38): turns a raw `q=` string
 * into a ranked list of listing ids, or `null` when `routes/feed.ts` should
 * fall back to `db/fts.ts`'s FTS5 search instead. Four things can trigger
 * that fallback, all deliberately distinguishable in the return value so a
 * test can drive each one on purpose (see `test/search.test.ts`):
 *
 *  0. `SEMANTIC_SEARCH` is not `"1"` — the kill switch, checked first and
 *     currently the live answer in every environment. Nothing below it runs
 *     at all: no embedding call, no Vectorize call. See
 *     `semanticSearchEnabled` in `env.ts`.
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
 * MIN_SCORE is deliberately **not** a relevance classifier, and the number
 * below is **not calibrated against anything reproducible.**
 *
 * The original author of this branch reported measuring `MODELS.embedding`
 * directly against real Workers AI — six cosine pairs against one "brass
 * sextant" anchor, reported as: identical 1.00, close paraphrase 0.86, same
 * category/different item 0.56, unrelated but concrete 0.52, gibberish 0.55,
 * unrelated/abstract 0.42 — and set MIN_SCORE under that spread. **None of
 * that has been reproduced.** That agent never reported back and left no
 * transcript, log or issue comment behind (the header of
 * `test/search.test.ts` cites "the issue's closing comment" for it; no such
 * comment exists), and no session since has had a Cloudflare credential to
 * re-run it. The numbers are recorded here as a lead for whoever does have
 * one — not as a measurement this repo stands behind.
 *
 * What survives independently of those numbers is the shape of the argument:
 * an absolute cosine cutoff on a bi-encoder is a weak relevance signal at
 * best, so this threshold is set low and treated as a *degenerate-result
 * floor* — it catches an empty index, or a query so far outside the
 * embedding space that even Vectorize's nearest neighbors are near
 * orthogonal. It is not asked to decide topical relevance, and must not be
 * trusted to. False negatives fall back to FTS (the listing is still
 * findable); false positives serve an imperfectly-ranked result.
 *
 * Before `SEMANTIC_SEARCH` is ever turned on (see `semanticSearchEnabled` —
 * it is off in every environment today), this number has to be re-derived
 * against the real model, with the run recorded somewhere durable. Until
 * then no request reaches this code in a deployed environment at all.
 */
import type { Env } from "../env.js";
import { semanticSearchEnabled } from "../env.js";
import { embed } from "./embedding.js";
import { queryListingVectors, type VectorMatch } from "./vectorize.js";

const SEARCH_TOP_K = 100;
const MIN_SCORE = 0.3;

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
