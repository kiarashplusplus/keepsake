/**
 * Issue #36: aspects (name/value pairs read off a photo by
 * `POST /api/photos/:id/suggest`) are persisted per listing into
 * `listing_aspects` (migration 0006) and returned on every listing-shaped
 * response. Issue #40's failure mode — a listing becoming invisible, or
 * only reachable, through an aspect — is tested directly here rather than
 * deferred, per the give-flow plan's explicit call-out of eBay's own
 * documented aspect-filter regression.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Aspect, PublicListing, OwnerListing } from "@keepsake/contracts/listing";
import type { FeedPage } from "@keepsake/contracts/feed";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import { replaceListingAspects } from "../src/lib/listingsDb.js";
import { authHeaders, freshOwnerToken, insertApprovedListing, insertOwner, readOk, seedStandardPostalCodes, uploadPhoto } from "./helpers.js";

const VALID_LISTING_BODY = {
  title: "A quiet teacup",
  story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
  category: "home_kitchen",
  country: "US",
  postal_code: "02144",
  date_of_birth: "1990-01-01",
  // Required since the give flow stopped offering a "Skip" on its email
  // step: `POST /api/listings` refuses a first listing with no way back to
  // its giver (neither the body nor the owner row carrying an address).
  email: "giver@keepsake.ing",
};

async function createListing(token: string, photoIds: string[], overrides: Record<string, unknown> = {}): Promise<Response> {
  return SELF.fetch("http://x/api/listings", {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID_LISTING_BODY, photo_ids: photoIds, ...overrides }),
  });
}

async function patchListing(id: string, token: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`http://x/api/listings/${id}`, {
    method: "PATCH",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function givenOnePhoto(token: string): Promise<string> {
  const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
  return photo.id;
}

async function fetchFeed(query: string): Promise<Response> {
  return SELF.fetch(`http://x/api/feed${query}`);
}

const TEAPOT_ASPECTS = [
  { name: "object", value: "teapot" },
  { name: "material", value: "copper" },
  { name: "era", value: "1970s" },
];

describe("aspects persistence (issue #36)", () => {
  it("POST /api/listings persists the suggestion's aspects and returns them, in order", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);

    const res = await createListing(token, [photoId], { aspects: TEAPOT_ASPECTS });
    expect(res.status).toBe(201);
    const listing = await readOk<OwnerListing>(res);
    expect(listing.aspects).toEqual(TEAPOT_ASPECTS);

    const { results } = await env.DB.prepare("SELECT name, value, position FROM listing_aspects WHERE listing_id = ? ORDER BY position")
      .bind(listing.id)
      .all<{ name: string; value: string; position: number }>();
    expect(results.map((row) => ({ name: row.name, value: row.value }))).toEqual(TEAPOT_ASPECTS);
    expect(results.map((row) => row.position)).toEqual([0, 1, 2]);
  });

  it("a listing created with no aspects (the common case) gets zero rows, not an error", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);

    const listing = await readOk<OwnerListing>(await createListing(token, [photoId]));
    expect(listing.aspects).toEqual([]);

    const { results } = await env.DB.prepare("SELECT id FROM listing_aspects WHERE listing_id = ?").bind(listing.id).all();
    expect(results).toHaveLength(0);
  });

  it("GET /api/listings/:id (public) also reports the persisted aspects", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const created = await readOk<OwnerListing>(await createListing(token, [photoId], { aspects: TEAPOT_ASPECTS }));

    // The route only serves approved/given listings — flip it directly
    // rather than waiting on MOCK_AI's background pipeline, since that
    // timing isn't what this test is about.
    await env.DB.prepare("UPDATE listings SET status = 'approved', published_at = ? WHERE id = ?").bind(Date.now(), created.id).run();

    const res = await SELF.fetch(`http://x/api/listings/${created.id}`);
    expect(res.status).toBe(200);
    const publicListing = await readOk<PublicListing>(res);
    expect(publicListing.aspects).toEqual(TEAPOT_ASPECTS);
  });

  it("PATCH replaces aspects wholesale when the request includes them", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const created = await readOk<OwnerListing>(await createListing(token, [photoId], { aspects: TEAPOT_ASPECTS }));

    const updated = await readOk<OwnerListing>(
      await patchListing(created.id, token, { aspects: [{ name: "colour", value: "blue" }] }),
    );
    expect(updated.aspects).toEqual([{ name: "colour", value: "blue" }]);

    const { results } = await env.DB.prepare("SELECT name, value FROM listing_aspects WHERE listing_id = ?")
      .bind(created.id)
      .all<{ name: string; value: string }>();
    expect(results).toEqual([{ name: "colour", value: "blue" }]);
  });

  // This test caught a real bug during development, not a hypothetical one:
  // the first cut of `UpdateListingInput` was plain `CreateListingInput.partial()`,
  // and zod v4's `.partial()` still applies a field's own `.default([])`
  // when the key is missing from the body (`z.object({ a:
  // z.array(z.string()).default([]) }).partial().parse({})` → `{ a: [] }`,
  // not `{}` — verified directly against the installed zod, not assumed).
  // That made a title-only PATCH indistinguishable, at the route, from one
  // that explicitly cleared `aspects`, and this test failed with `[]`
  // instead of `TEAPOT_ASPECTS`. Fixed in `@keepsake/contracts/listing` by
  // overriding `aspects` on `UpdateListingInput` with a plain `.optional()`
  // (no default), which parses a missing key as `undefined` and an
  // explicit `[]` as `[]` — the distinction `routes/listings.ts`'s
  // `if (input.aspects)` gate actually needs.
  it("PATCH omitting aspects entirely leaves the existing ones untouched", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const created = await readOk<OwnerListing>(await createListing(token, [photoId], { aspects: TEAPOT_ASPECTS }));

    const updated = await readOk<OwnerListing>(await patchListing(created.id, token, { title: "A different quiet teacup" }));
    expect(updated.title).toBe("A different quiet teacup");
    expect(updated.aspects).toEqual(TEAPOT_ASPECTS);
  });

  it("aspects are indexed and queryable by name+value (the eBay-style filter shape #39 will build on)", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const teapotListing = await readOk<OwnerListing>(await createListing(token, [photoId], { aspects: TEAPOT_ASPECTS }));

    const otherToken = freshOwnerToken();
    const otherPhotoId = await givenOnePhoto(otherToken);
    const mugListing = await readOk<OwnerListing>(
      await createListing(otherToken, [otherPhotoId], { aspects: [{ name: "material", value: "ceramic" }] }),
    );

    const { results } = await env.DB.prepare("SELECT listing_id FROM listing_aspects WHERE name = ? AND value = ?")
      .bind("material", "copper")
      .all<{ listing_id: string }>();
    const listingIds = results.map((row) => row.listing_id);
    expect(listingIds).toContain(teapotListing.id);
    expect(listingIds).not.toContain(mugListing.id);
  });

  // --- Issue #40's guarantee, tested now rather than deferred to #39/#40 ---
  describe("a zero-aspect listing is never hidden from the default feed or a broad search", () => {
    it("appears in the default (no filter) feed", async () => {
      const ownerId = await insertOwner();
      // `insertApprovedListing` writes only the `listings` row directly —
      // no `listing_aspects` rows at all, which is exactly the "existing
      // listing, never backfilled" shape #37 will also produce mid-run.
      const zeroAspectId = await insertApprovedListing({ ownerId, title: "A plain wooden spoon" });

      const page = await readOk<FeedPage<PublicListing>>(await fetchFeed("?limit=48"));
      const ids = page.items.map((item) => item.id);
      expect(ids).toContain(zeroAspectId);
      const item = page.items.find((entry) => entry.id === zeroAspectId);
      expect(item?.aspects).toEqual([]);
    });

    it("appears in a broad FTS search that matches its title/story, not its (absent) aspects", async () => {
      const ownerId = await insertOwner();
      const zeroAspectId = await insertApprovedListing({
        ownerId,
        title: "A plain wooden spoon",
        story: "Carved by my grandfather one winter; it's seen a thousand pots of soup since.",
      });

      const page = await readOk<FeedPage<PublicListing>>(await fetchFeed("?q=grandfather"));
      expect(page.items.map((item) => item.id)).toContain(zeroAspectId);
    });
  });

  // --- Issue #285: `replaceListingAspects` as one `env.DB.batch()` ---
  describe("replaceListingAspects is atomic (issue #285)", () => {
    it("a failing write among the inserts leaves the original aspects untouched, not half-deleted", async () => {
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });

      const original: Aspect[] = [
        { name: "object", value: "teapot" },
        { name: "material", value: "copper" },
      ];
      await replaceListingAspects(env, listingId, original);
      const before = await env.DB.prepare("SELECT name, value FROM listing_aspects WHERE listing_id = ? ORDER BY position")
        .bind(listingId)
        .all<{ name: string; value: string }>();
      expect(before.results).toEqual(original);

      // `listing_aspects.value` is `NOT NULL` (0006_aspects.sql) — a `null`
      // in the third of four aspects forces D1 to reject that INSERT, which
      // is the failure this test stands in for: an isolate evicted midway
      // through the un-batched loop this function used to be, per this
      // module's own doc comment on why `create.ts` was rewritten the same
      // way. Two good aspects flank the bad one on purpose, so a
      // non-atomic implementation would have already committed the delete
      // and the first insert or two before throwing.
      const withABadAspect = [
        { name: "era", value: "1970s" },
        { name: "condition", value: "well loved" },
        { name: "broken", value: null },
        { name: "finish", value: "hammered" },
      ] as unknown as Aspect[];

      await expect(replaceListingAspects(env, listingId, withABadAspect)).rejects.toThrow();

      // On `main`, the plain `DELETE` awaited on its own line commits
      // unconditionally, then the loop's separate `.run()` calls insert
      // "era" and "condition" before the null `value` throws on "broken" —
      // leaving the row set as ["era", "condition"], neither the original
      // two aspects nor the four requested ones. With the whole replace as
      // one `env.DB.batch()`, the failing statement fails the batch and
      // nothing in it commits: the row set this asserts is the original,
      // unchanged.
      const after = await env.DB.prepare("SELECT name, value FROM listing_aspects WHERE listing_id = ? ORDER BY position")
        .bind(listingId)
        .all<{ name: string; value: string }>();
      expect(after.results).toEqual(original);
    });
  });
});
