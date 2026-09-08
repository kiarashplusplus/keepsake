/**
 * Deleting a listing's rendered share cards from R2.
 *
 * Cards are content-addressed under `og/<listingId>/<fingerprint>.jpg` and are
 * deliberately never invalidated — an edit writes a new key and abandons the
 * old one (see `og/fingerprint.ts`). That is the right trade while a listing
 * exists. It stops being the right trade when the listing is **deleted**: a
 * card is a rendered copy of the giver's photo, their story and their town,
 * so leaving one in R2 after `DELETE /api/listings/:id` keeps exactly the
 * material the delete was meant to remove — next to the photo objects that
 * same handler is careful to delete.
 *
 * Nothing else in this repo prefix-scans R2 (`cron/orphanSweep.ts` deletes
 * only specific keys read from rows), so this is the one place the `og/`
 * prefix is enumerated, and the one place that has to know cards accumulate.
 *
 * Not called on withdraw, hide or given: those all leave the row in place and
 * are reversible, and `routes/ogCard.ts` re-reads the listing's status from
 * D1 before it will serve anything, so a non-public listing's stored card is
 * unreachable rather than stale.
 */
import type { Env } from "../env.js";

/** R2 `list` caps at 1000 keys per page; a listing will never approach that,
 * but paginating costs three lines and removes the ceiling as a thing to
 * think about. */
export async function deleteCardObjects(env: Env, listingId: string): Promise<number> {
  const prefix = `og/${listingId}/`;
  let deleted = 0;
  let cursor: string | undefined;

  do {
    const page = await env.BUCKET.list(cursor ? { prefix, cursor } : { prefix });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) {
      await env.BUCKET.delete(keys);
      deleted += keys.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);

  return deleted;
}
