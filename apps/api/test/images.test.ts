/**
 * `GET /i/:id/:variant` — Cache-Control shape and the delete-purges-cache
 * guard added for issue #22 ("Cached photo variants outlive deletion").
 *
 * These are the fast regression-suite counterpart to the manual `wrangler
 * dev` verification pasted into the issue's closing comment: that run
 * confirmed a real `CF-Cache-Status: HIT` and then confirmed the same URL
 * 404s the instant the listing stops being public, both via `DELETE` (R2
 * object gone, `purgePhotoCache` called) and via `withdraw` (row stays, no
 * purge call at all — the DB-status check in the route is what actually
 * gates it). This file re-asserts the same shape against the fast in-process
 * runtime so a regression here fails CI, not just a one-off manual check.
 */
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { OwnerListing } from "@keepsake/contracts/listing";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import { authHeaders, freshOwnerToken, readOk, seedStandardPostalCodes, uploadPhoto, waitForListingStatus } from "./helpers.js";

beforeEach(async () => {
  await seedStandardPostalCodes();
});

const VALID_LISTING_BODY = {
  title: "A quiet teacup",
  story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
  category: "home_kitchen",
  country: "US",
  postal_code: "02144",
  age_attested: true,
};

async function createApprovedListingWithPhoto(token: string): Promise<{ listing: OwnerListing; photoId: string }> {
  const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
  const res = await SELF.fetch("http://x/api/listings", {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID_LISTING_BODY, photo_ids: [photo.id] }),
  });
  const listing = await readOk<OwnerListing>(res);
  await waitForListingStatus(listing.id, (s) => s === "approved");
  return { listing, photoId: photo.id };
}

describe("GET /i/:id/:variant — Cache-Control", () => {
  it("public (approved) variant is cacheable but bounded, not a year-long immutable promise", async () => {
    const token = freshOwnerToken();
    const { photoId } = await createApprovedListingWithPhoto(token);

    const res = await SELF.fetch(`http://x/i/${photoId}/full`);
    expect(res.status).toBe(200);
    const cacheControl = res.headers.get("cache-control");
    expect(cacheControl).toBe("public, max-age=3600");
    // The whole point of issue #22: a listing's visibility can change, so a
    // year-long "never needs revalidation" promise on its photo is wrong.
    expect(cacheControl).not.toContain("immutable");
    expect(cacheControl).not.toContain("31536000");
  });

  it("owner-preview (pending, valid owner token) is never cacheable", async () => {
    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
    const res = await SELF.fetch(`http://x/i/${photo.id}/full`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("GET /i/:id/:variant — cache purge on delete (issue #22)", () => {
  it("a cached public photo 404s immediately after the owner deletes the listing", async () => {
    const token = freshOwnerToken();
    const { listing, photoId } = await createApprovedListingWithPhoto(token);

    // Populate the edge cache the same way a stranger browsing the feed
    // would.
    const first = await SELF.fetch(`http://x/i/${photoId}/full`);
    expect(first.status).toBe(200);
    const second = await SELF.fetch(`http://x/i/${photoId}/full`);
    expect(second.status).toBe(200);

    const del = await SELF.fetch(`http://x/api/listings/${listing.id}`, { method: "DELETE", headers: authHeaders(token) });
    expect(del.status).toBe(200);

    const after = await SELF.fetch(`http://x/i/${photoId}/full`);
    expect(after.status).toBe(404);
  });

  it("a cached public photo also 404s after withdraw, which never calls the purge helper — the DB status check is the real guard", async () => {
    const token = freshOwnerToken();
    const { listing, photoId } = await createApprovedListingWithPhoto(token);

    await SELF.fetch(`http://x/i/${photoId}/full`);
    const cached = await SELF.fetch(`http://x/i/${photoId}/full`);
    expect(cached.status).toBe(200);

    const withdraw = await SELF.fetch(`http://x/api/listings/${listing.id}/withdraw`, { method: "POST", headers: authHeaders(token) });
    expect(withdraw.status).toBe(200);

    // Nothing purges `caches.default` on withdraw (only R2-deleting paths
    // do) — this 404 comes entirely from `images.ts` re-reading the
    // listing's status fresh on every request, before it ever looks at the
    // cache.
    const after = await SELF.fetch(`http://x/i/${photoId}/full`);
    expect(after.status).toBe(404);
  });
});
