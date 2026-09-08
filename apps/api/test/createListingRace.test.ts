/**
 * Issue #283: the give flow's listing INSERT was unconditional while its
 * photo attach was guarded. `createListingForOwner`'s `created` flag read
 * the *insert's* `meta.changes`, which for an unguarded insert is always
 * `> 0` — so it could never reflect whether a photo actually attached. A
 * lost race between two submissions for the same photo (a double-tapped
 * submit, or a retry with no `X-Idempotency-Key`) could insert a listing
 * that then attached zero photos, which `moderation/pipeline.ts` treats as
 * "skip image moderation" rather than "reject" — a listing could reach the
 * public feed with `photos: []`.
 *
 * These simulate the outcome a genuine race leaves behind, the same style
 * `bulkSubmitIdempotency.test.ts`'s case (c) uses for the bulk path's own
 * guard: the photo is already claimed by the time the insert actually runs,
 * without needing two HTTP requests to land in exactly the right order.
 * That's deliberate, not a shortcut — `POST /api/listings`'s own
 * `SELECT`-based pre-check (`routes/listings.ts`) sits in front of the
 * insert this test targets, so a genuinely raced pair of HTTP requests tends
 * to have its loser refused there instead (400, an existing and unrelated
 * code path), which would prove nothing about the guard this issue adds.
 * Calling `createListingForOwner` directly reaches the exact statement under
 * test regardless of how the two requests would have happened to interleave.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CreateListingInput } from "@keepsake/contracts/listing";
import { createListingForOwner } from "../src/listings/create.js";
import { ulid } from "../src/lib/ids.js";
import { insertOwner } from "./helpers.js";

const PLACE = { country: "US" as const, code: "02144", place_name: "Somerville", admin1: "MA", lat: 42.3958, lng: -71.0967 };

async function insertUnattachedPhoto(ownerId: string): Promise<string> {
  const id = ulid();
  const now = Date.now();
  const fullKey = `photos/${id}/full.jpg`;
  const thumbKey = `photos/${id}/thumb.jpg`;
  await env.BUCKET.put(fullKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  await env.BUCKET.put(thumbKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  await env.DB.prepare(
    `INSERT INTO photos
       (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at)
     VALUES (?, ?, NULL, NULL, ?, ?, 800, 600, 12345, 'LEHV6nl01waF5-KStrzX', 'image/jpeg', 'unchecked', ?)`,
  )
    .bind(id, ownerId, fullKey, thumbKey, now)
    .run();
  return id;
}

function createInput(photoId: string): CreateListingInput {
  return {
    title: "A quiet teacup",
    story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
    category: "home_kitchen",
    country: "US",
    postal_code: "02144",
    photo_ids: [photoId],
    date_of_birth: "1990-01-01",
    aspects: [],
  };
}

describe("createListingForOwner's give-flow insert is guarded (issue #283)", () => {
  it("declines when a requested photo is claimed by another listing between the pre-check and the write", async () => {
    const ownerId = await insertOwner();
    const photoId = await insertUnattachedPhoto(ownerId);

    // Stands in for the other half of a lost race: another submission's
    // batch committed first and already attached this photo elsewhere.
    const otherListingId = ulid();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO listings
         (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
          status, version, created_at, updated_at)
       VALUES (?, ?, 'Unrelated listing', 'Already published, already holding this photo, nothing to do with this test.',
               'home_kitchen', 'US', '02144', 'Somerville', 'MA', 42.3958, -71.0967, 'pending', 1, ?, ?)`,
    )
      .bind(otherListingId, ownerId, now, now)
      .run();
    await env.DB.prepare("UPDATE photos SET listing_id = ? WHERE id = ?").bind(otherListingId, photoId).run();

    const result = await createListingForOwner(env, {
      ownerId,
      input: createInput(photoId),
      place: PLACE,
      now,
    });

    // The fix: `created` reports the insert's own guard, not an
    // unconditional write. On `main` this was always `true` for the give
    // flow regardless of whether any photo actually attached, and
    // `POST /api/listings` (`routes/listings.ts`) had no `created` check at
    // all — it always returned 201 with whatever `fetchListingRow` found.
    expect(result.created).toBe(false);

    const listingRow = await env.DB.prepare("SELECT id FROM listings WHERE id = ?").bind(result.listingId).first();
    expect(listingRow).toBeNull();

    // Nothing else from the batch fired either — the contested photo is
    // still exactly where the other listing left it, not stolen by a
    // listing that itself never got written.
    const photoRow = await env.DB.prepare("SELECT listing_id FROM photos WHERE id = ?").bind(photoId).first<{ listing_id: string }>();
    expect(photoRow?.listing_id).toBe(otherListingId);
  });

  it("still creates normally when nothing raced (control)", async () => {
    const ownerId = await insertOwner();
    const photoId = await insertUnattachedPhoto(ownerId);

    const result = await createListingForOwner(env, {
      ownerId,
      input: createInput(photoId),
      place: PLACE,
      now: Date.now(),
    });

    expect(result.created).toBe(true);
    const listingRow = await env.DB.prepare("SELECT id FROM listings WHERE id = ?").bind(result.listingId).first();
    expect(listingRow).not.toBeNull();
    const photoRow = await env.DB.prepare("SELECT listing_id FROM photos WHERE id = ?").bind(photoId).first<{ listing_id: string }>();
    expect(photoRow?.listing_id).toBe(result.listingId);
  });
});
