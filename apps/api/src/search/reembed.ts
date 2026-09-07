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
 * write. The fallback design in `routes/feed.ts` means a listing that never
 * got embedded (budget exhausted, AI call failed, Vectorize down) is still
 * findable by title/story through FTS in the meantime.
 */
import type { Env } from "../env.js";
import { parseIntVar, semanticSearchEnabled } from "../env.js";
import { checkAndBump } from "../moderation/budget.js";
import { fetchAspectRows, fetchListingRow } from "../lib/listingsDb.js";
import { embed, embeddingText } from "./embedding.js";
import { upsertListingVector } from "./vectorize.js";

const DEFAULT_EMBED_DAILY_BUDGET = 2000;

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
    return;
  }

  const aspects = await fetchAspectRows(env, listingId);
  const text = embeddingText(listing.title, listing.story, aspects);

  const vector = await embed(env, text);
  if (!vector) return;

  await upsertListingVector(env, listingId, vector);
}
