/**
 * Creating a listing — the one implementation, shared by the give flow's
 * `POST /api/listings` and the estate bulk-upload submission runner.
 *
 * It exists because the alternative is two implementations of the same rules.
 * The bulk runner has to write a listing, attach its photos in order, and
 * write its aspects; if it did that itself, then the day someone changes what
 * a create writes — a new column, a different aspect rule — one of the two
 * paths gets the change and the other silently does not, and the difference
 * is only visible in production, on somebody's keepsake.
 *
 * ## Why the writes are one `DB.batch()`
 *
 * `env.DB.batch()` is a single transaction and is the only such primitive
 * this Worker has (`routes/me.ts`'s choose flow is the existing precedent).
 * Before this module, `POST /api/listings` performed the listing INSERT, then
 * N photo UPDATEs in a loop, then the aspect writes, as separate awaits with
 * nothing tying them together — so an isolate evicted midway left a listing
 * holding some of its photos, which the moderation pipeline would then judge
 * on a partial set. Batching them is a real fix on the ordinary path as well
 * as the precondition for the bulk one.
 *
 * ## Why there is no compensating delete anywhere
 *
 * The obvious way to make a multi-step create atomic is to insert, check, and
 * `DELETE FROM listings` if a later step disagrees. **That is a trap here.**
 * `photos.listing_id` carries `ON DELETE CASCADE` (0001_init.sql), so deleting
 * a just-inserted listing deletes the `photos` rows attached to it — on the
 * bulk path those are the giver's draft photos, and their R2 objects would
 * then be referenced by nothing and swept by nothing. Every guard below is
 * therefore a *precondition on the insert*, never a rollback after it.
 */
import type { Env } from "../env.js";
import type { CreateListingInput } from "@keepsake/contracts/listing";
import type { PostalLookup } from "@keepsake/contracts/geo";
import { ulid } from "../lib/ids.js";
import { containsContactInfo } from "../moderation/contactInfo.js";

/**
 * Issue #171: a listing's aspects are attacker-controlled input — up to six
 * free-text name/value pairs taken from the request body, with no check that
 * they came from `POST /api/photos/:id/suggest` — and `serializePublicListing`
 * publishes them. Both halves of each pair are checked, `name` as well as
 * `value`: 24 characters is enough for a short URL.
 *
 * Moved here from `routes/listings.ts` so the bulk submission path cannot
 * publish an aspect the give flow would have refused.
 */
export function aspectsContainContactInfo(aspects: readonly { name: string; value: string }[] | undefined): boolean {
  if (!aspects) return false;
  return aspects.some((aspect) => containsContactInfo(aspect.name) || containsContactInfo(aspect.value));
}

export const ASPECT_CONTACT_INFO_MESSAGE =
  "Keep contact details out of the item details — people reach you through Keepsake.";

/**
 * The bulk runner's claim. Present only on the bulk path; the give flow
 * passes nothing and gets the plain statements.
 *
 * `itemId`/`revision` name the draft being published and the revision it was
 * reviewed at. Together they are what makes a resumed submission exactly
 * once: the claim only fires while the item still has no listing, and the
 * insert only fires if this caller won that claim.
 */
export interface BulkClaim {
  itemId: string;
  revision: number;
}

export interface ListingCreateArgs {
  /** Pre-chosen on the bulk path (recorded on the draft row before the write,
   * so a retry re-drives the same insert and the primary key refuses a
   * second listing). The give flow lets this default. */
  listingId?: string;
  ownerId: string;
  input: CreateListingInput;
  place: PostalLookup;
  now?: number;
  claim?: BulkClaim;
}

export interface ListingCreateStatements {
  listingId: string;
  statements: D1PreparedStatement[];
  /** Index into the batch's results of the statement whose `meta.changes`
   * says whether the listing was actually inserted. Callers read this rather
   * than counting statements themselves. */
  insertResultIndex: number;
}

/**
 * Builds every write a create performs, as prepared statements rather than
 * executions, so the caller can run them as one transaction and — on the bulk
 * path — read which of them fired.
 */
export function buildListingCreateStatements(env: Env, args: ListingCreateArgs): ListingCreateStatements {
  const { ownerId, input, place, claim } = args;
  const listingId = args.listingId ?? ulid();
  const now = args.now ?? Date.now();
  const photoIds = input.photo_ids;
  const statements: D1PreparedStatement[] = [];

  if (claim) {
    // The claim, and the whole of the concurrency story on the bulk path.
    // `listing_id IS NULL` loses to any runner that got here first;
    // `revision = ?` loses to an edit that landed after the giver pressed
    // submit, which is what "submit the revisions I reviewed" has to mean.
    statements.push(
      env.DB.prepare(
        `UPDATE upload_batch_items
            SET listing_id = ?, state = 'submitted', submitted_at = ?, updated_at = ?,
                failure_code = NULL, failure_detail = NULL
          WHERE id = ? AND listing_id IS NULL AND revision = ?`,
      ).bind(listingId, now, now, claim.itemId, claim.revision),
    );
  }

  const insertResultIndex = statements.length;

  if (claim) {
    // Inserted only if this runner won the claim above AND every photo is
    // still this owner's own and still unattached. The photo half is the
    // "validate attachment eligibility inside the transaction" rule: without
    // it, two submissions could each attach the same photo, and the second
    // would silently steal it from the first listing.
    const placeholders = photoIds.map(() => "?").join(",");
    statements.push(
      env.DB.prepare(
        `INSERT INTO listings
           (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
            status, version, created_at, updated_at, age_attested_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?
          WHERE (SELECT listing_id FROM upload_batch_items WHERE id = ?) = ?
            AND (SELECT COUNT(*) FROM photos
                  WHERE owner_id = ? AND listing_id IS NULL AND id IN (${placeholders})) = ?`,
      ).bind(
        listingId,
        ownerId,
        input.title,
        input.story,
        input.category,
        place.country,
        place.code,
        place.place_name,
        place.admin1,
        place.lat,
        place.lng,
        now,
        now,
        now,
        claim.itemId,
        listingId,
        ownerId,
        ...photoIds,
        photoIds.length,
      ),
    );
  } else {
    // Issue #283: guarded the same way the bulk branch above is, minus the
    // claim — the give flow has no `upload_batch_items` row to gate on, but
    // it has the same photo race the bulk comment already names: the
    // caller's pre-check `SELECT` (`routes/listings.ts`) and this INSERT are
    // separated by a window, so two submissions racing on the same photo
    // could previously both insert a listing while only one attach below
    // actually won the photo — an unconditional insert can't see that, so
    // `created` always read `true` and a photo-less listing shipped straight
    // past image moderation (`moderation/pipeline.ts` skips image work when
    // `photos.length === 0`). Re-checking eligibility inside the same
    // statement that inserts closes the window: the insert only fires if
    // every requested photo is still this owner's unattached orphan at the
    // instant this statement runs, so `created` now means what it always
    // claimed to for the bulk path — the listing exists iff every photo did
    // too.
    const placeholders = photoIds.map(() => "?").join(",");
    statements.push(
      env.DB.prepare(
        `INSERT INTO listings
           (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
            status, version, created_at, updated_at, age_attested_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM photos
                  WHERE owner_id = ? AND listing_id IS NULL AND id IN (${placeholders})) = ?`,
      ).bind(
        listingId,
        ownerId,
        input.title,
        input.story,
        input.category,
        place.country,
        place.code,
        place.place_name,
        place.admin1,
        place.lat,
        place.lng,
        now,
        now,
        // Issue #64: a request only reaches a caller of this function once
        // `DateOfBirthSchema` has confirmed the birth date implies the
        // minimum age, so the field's mere presence means the gate passed.
        // The date itself is deliberately never bound into this query and
        // never stored anywhere — only this timestamp is.
        input.date_of_birth ? now : null,
        ownerId,
        ...photoIds,
        photoIds.length,
      ),
    );
  }

  for (let position = 0; position < photoIds.length; position++) {
    // `listing_id IS NULL` even on the give-flow path, where the route has
    // already checked it in a prior SELECT: between that check and this write
    // is a window, and the predicate closes it for free. `EXISTS(...)` makes
    // the whole thing a no-op when a guarded insert above declined.
    statements.push(
      env.DB.prepare(
        `UPDATE photos SET listing_id = ?, position = ?, retain_until = NULL
          WHERE id = ? AND owner_id = ? AND listing_id IS NULL
            AND EXISTS (SELECT 1 FROM listings WHERE id = ?)`,
      ).bind(listingId, position, photoIds[position], ownerId, listingId),
    );
  }

  const aspects = input.aspects ?? [];
  for (let position = 0; position < aspects.length; position++) {
    const aspect = aspects[position];
    if (!aspect) continue;
    statements.push(
      env.DB.prepare(
        `INSERT INTO listing_aspects (id, listing_id, name, value, position, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM listings WHERE id = ?)`,
      ).bind(ulid(), listingId, aspect.name, aspect.value, position, now, listingId),
    );
  }

  if (claim) {
    // Releases the claim when the insert declined, so the giver can fix the
    // conflict (usually a photo already used by another item) and retry.
    // A release, not a rollback: nothing has been written to undo.
    statements.push(
      env.DB.prepare(
        `UPDATE upload_batch_items
            SET listing_id = NULL, state = 'failed', submitted_at = NULL,
                failure_code = 'photo_conflict', updated_at = ?
          WHERE id = ? AND listing_id = ? AND NOT EXISTS (SELECT 1 FROM listings WHERE id = ?)`,
      ).bind(now, claim.itemId, listingId, listingId),
    );
  }

  return { listingId, statements, insertResultIndex };
}

export interface ListingCreateResult {
  listingId: string;
  /** False when the insert's own photo-eligibility guard declined — on the
   * bulk path that also covers a lost claim (issue #283's fix gave the give
   * flow's insert the same guard the bulk branch always had, so both paths
   * report this the same way now). Callers must check it: a `false` here
   * means nothing was written — no listing, no photo attach, no aspect —
   * and the caller owns turning that into a response the client sees. */
  created: boolean;
}

/** Runs a create's statements as one transaction. */
export async function createListingForOwner(env: Env, args: ListingCreateArgs): Promise<ListingCreateResult> {
  const { listingId, statements, insertResultIndex } = buildListingCreateStatements(env, args);
  const results = await env.DB.batch(statements);
  const insertResult = results[insertResultIndex];
  return { listingId, created: (insertResult?.meta?.changes ?? 0) > 0 };
}
