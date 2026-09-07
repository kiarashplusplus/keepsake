/**
 * Re-embeds one listing's title + story + aspects into `env.VECTORIZE`
 * (issue #38). Called, fire-and-forget via `waitUntil`, from every path
 * that can change what a listing's story or aspects say:
 * `POST /api/listings` (create) and `PATCH /api/listings/:id` (edit, when
 * the request body actually touched title/story/aspects) in
 * `routes/listings.ts`, and once per listing from the #37 aspects backfill
 * (`backfill/aspects.ts`), which is what reaches listings created before
 * this feature existed. That last caller is why this is exported rather
 * than inlined: it is the same embed-and-upsert, not a second copy of it.
 * (An earlier version of this comment described the backfill as "landing
 * separately" and expected to call this. It landed first and did not, so
 * for a while nothing did.)
 *
 * `DELETE /api/listings/:id` calls `deleteListingVector` directly instead;
 * nothing here handles removal.
 *
 * Never throws: a failure here must never surface as a 500 on a listing
 * write. A listing that never got embedded (budget exhausted, AI call
 * failed, Vectorize down) is still findable by title/story through FTS,
 * because `routes/feed.ts` merges the FTS matches into the vector result set
 * rather than choosing one path per query — issue #180, which is also why
 * that sentence is now true. It used to say the same thing while the route
 * picked one path per query, so an un-embedded listing was in fact missing
 * from any search another listing's vector answered.
 *
 * ## Recording the outcome (issue #180)
 *
 * Every exit below now writes `listings.vector_indexed_at`: the epoch-ms
 * time of the successful upsert, or NULL on any failure. Before this, all
 * four failure paths returned void and wrote nothing anywhere, so "this
 * listing has no vector" was not a fact any query, panel or cron could ask
 * about — the same "a panel that cannot tell 'I did not look' from 'I looked
 * and saw nothing'" defect AGENTS.md describes, one layer down. NULL is now
 * the queryable form of "needs (re-)indexing".
 *
 * Failure deliberately *clears* the column rather than leaving whatever was
 * there: after an edit whose re-embed failed, any vector still in the index
 * describes the listing's old text, and a stale vector is a re-index
 * candidate for the same reason a missing one is.
 *
 * `updated_at` is intentionally not touched by that write —
 * `cron/moderationRetry.ts` selects `pending` listings by `updated_at`, and
 * an indexing bookkeeping write must not look like a content change.
 */
import type { Env } from "../env.js";
import { parseIntVar, semanticSearchEnabled } from "../env.js";
import { checkAndBump } from "../moderation/budget.js";
import { fetchAspectRows, fetchListingRow } from "../lib/listingsDb.js";
import { embed, embeddingText } from "./embedding.js";
import { upsertListingVector } from "./vectorize.js";

const DEFAULT_EMBED_DAILY_BUDGET = 2000;

/** `indexedAt = null` means "this listing has no vector for its current
 * text" — never indexed, or invalidated by a failed re-embed. */
async function recordVectorIndexed(env: Env, listingId: string, indexedAt: number | null): Promise<void> {
  await env.DB.prepare("UPDATE listings SET vector_indexed_at = ? WHERE id = ?").bind(indexedAt, listingId).run();
}

export async function reembedListing(env: Env, listingId: string): Promise<void> {
  // Same kill switch the read path checks (`search/search.ts`), checked
  // first here too. With `SEMANTIC_SEARCH` off this must not spend a
  // Workers AI call, a KV budget increment, or a Vectorize write — a
  // listing create/edit should cost exactly what it costs on `main`.
  // Nothing downstream depends on the vector existing: the read path is
  // off as well, and FTS indexes the same listing through its own trigger.
  if (!semanticSearchEnabled(env)) return;

  const listing = await fetchListingRow(env, listingId);
  if (!listing) return; // deleted, or never existed, by the time this runs

  // Global-only ceiling, no per-IP component — see the `BudgetKind` doc
  // comment in `moderation/budget.ts` for why. Denied just means this one
  // edit's new text won't be searchable semantically until the next
  // successful re-embed; FTS already covers it in the meantime.
  const dailyLimit = parseIntVar("EMBED_DAILY_BUDGET", env.EMBED_DAILY_BUDGET, DEFAULT_EMBED_DAILY_BUDGET);
  const budget = await checkAndBump(env.KV, { kind: "embed", dailyLimit });
  if (!budget.allowed) {
    console.warn("reembedListing: EMBED_DAILY_BUDGET exhausted, skipping", { listingId });
    await recordVectorIndexed(env, listingId, null);
    return;
  }

  const aspects = await fetchAspectRows(env, listingId);
  const text = embeddingText(listing.title, listing.story, aspects);

  const vector = await embed(env, text);
  if (!vector) {
    // `embed` already logged which of its failure modes fired (no binding, a
    // thrown call, a timeout, an unparseable response) — this records the
    // consequence: no current vector for this listing.
    console.warn("reembedListing: embedding unavailable, listing left unindexed", { listingId });
    await recordVectorIndexed(env, listingId, null);
    return;
  }

  const upserted = await upsertListingVector(env, listingId, vector);
  if (!upserted) {
    console.warn("reembedListing: Vectorize upsert did not land, listing left unindexed", { listingId });
    await recordVectorIndexed(env, listingId, null);
    return;
  }

  await recordVectorIndexed(env, listingId, Date.now());
}
