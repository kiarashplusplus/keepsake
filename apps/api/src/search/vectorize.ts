/**
 * Thin wrapper around `env.VECTORIZE` (`wrangler.toml`'s `[[vectorize]]`
 * binding) so nothing else in this Worker calls its methods directly.
 *
 * Every method degrades to a safe no-op/`null` on a missing binding or a
 * thrown call rather than surfacing an error to the caller: `env.VECTORIZE`
 * can be absent from an environment that predates this issue's deploy, and
 * a Vectorize outage must never turn a listing write into a 500 or a search
 * into one — `routes/feed.ts` treats `null` from `queryListingVectors` as
 * "fall back to FTS", exactly like an embedding call failing.
 */
import type { Env } from "../env.js";

export interface VectorMatch {
  id: string;
  score: number;
}

/**
 * `true` only when the vector actually landed in the index; `false` for a
 * missing binding or a thrown call. Still never throws — the caller's job is
 * to record the outcome (`listings.vector_indexed_at`, issue #180), not to
 * turn it into a 500 on a listing write. Before #180 this returned `void`,
 * which made "upserted" and "silently failed" indistinguishable to every
 * caller and was half of why a missing vector left no trace anywhere.
 */
export async function upsertListingVector(env: Env, listingId: string, vector: number[]): Promise<boolean> {
  if (!env.VECTORIZE) return false;
  try {
    await env.VECTORIZE.upsert([{ id: listingId, values: vector }]);
    return true;
  } catch (err) {
    console.error("upsertListingVector: Vectorize call failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export async function deleteListingVector(env: Env, listingId: string): Promise<void> {
  if (!env.VECTORIZE) return;
  try {
    await env.VECTORIZE.deleteByIds([listingId]);
  } catch (err) {
    console.error("deleteListingVector: Vectorize call failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `null` means "don't trust Vectorize for this query" (missing binding or a
 * thrown call) — the caller falls back to FTS. An empty array is a real,
 * successful answer of "no matches" and is treated the same way by
 * `routes/feed.ts`, but the two are kept distinct here so a test can name
 * which one it's driving (see `test/search.test.ts`).
 *
 * `returnMetadata: "none"`, not `false`. The generated type
 * (`VectorizeQueryOptions.returnMetadata?: boolean | VectorizeMetadataRetrievalLevel`)
 * accepts either, and `"none"` is a valid `VectorizeMetadataRetrievalLevel`,
 * so this is the conservative choice of the two under any behaviour.
 *
 * The branch that wrote this reported that the live API *rejects* the
 * literal `false` with `VECTOR_QUERY_ERROR (40026)` and that a mocked
 * `env.VECTORIZE` would never have caught it. That would be a good catch if
 * true, and it is still **unreproduced**: the later session that did hold a
 * Vectorize-scoped credential ran the round trip with `"none"` in place and
 * never tried the literal `false`, so the rejection itself has never been
 * observed by anyone who wrote it down. The fake in `test/helpers.ts`
 * accepts both values exactly as the report says a mock would. Treat it as
 * an unconfirmed lead: keep `"none"` (it costs nothing and is safe either
 * way), and do not cite it as evidence this code has met the real API.
 */
export async function queryListingVectors(env: Env, vector: number[], topK: number): Promise<VectorMatch[] | null> {
  if (!env.VECTORIZE) return null;
  try {
    const result = await env.VECTORIZE.query(vector, { topK, returnValues: false, returnMetadata: "none" });
    return result.matches.map((match) => ({ id: match.id, score: match.score }));
  } catch (err) {
    console.error("queryListingVectors: Vectorize call failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
