/**
 * Re-embeds one listing's title + story + aspects into `env.VECTORIZE`
 * (issue #38). Called, fire-and-forget via `waitUntil`, from every path
 * that can change what a listing's story or aspects say:
 * `POST /api/listings` (create) and `PATCH /api/listings/:id` (edit, when
 * the request body actually touched title/story/aspects) in
 * `routes/listings.ts`. The #37 backfill script (landing separately) should
 * call this directly, once per listing, after it writes that listing's
 * aspects — it is exported for exactly that reuse rather than duplicating
 * the embed-and-upsert steps.
 *
 * `DELETE /api/listings/:id` calls `deleteListingVector` directly instead;
 * nothing here handles removal.
 *
 * Never throws: a failure here must never surface as a 500 on a listing
 * write. The fallback design in `routes/feed.ts` means a listing that never
 * got embedded (budget exhausted, AI call failed, Vectorize down) is still
 * findable by title/story through FTS in the meantime.
 */
import type { Env } from "../env.js";
import { parseIntVar } from "../env.js";
import { checkAndBump } from "../moderation/budget.js";
import { fetchAspectRows, fetchListingRow } from "../lib/listingsDb.js";
import { embed, embeddingText } from "./embedding.js";
import { upsertListingVector } from "./vectorize.js";

const DEFAULT_EMBED_DAILY_BUDGET = 2000;

export async function reembedListing(env: Env, listingId: string): Promise<void> {
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
    return;
  }

  const aspects = await fetchAspectRows(env, listingId);
  const text = embeddingText(listing.title, listing.story, aspects);

  const vector = await embed(env, text);
  if (!vector) return;

  await upsertListingVector(env, listingId, vector);
}
