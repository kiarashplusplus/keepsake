/**
 * Issue #162 — the takedown-undo bypass.
 *
 * Every control this product has for pulling a listing out of public view
 * writes a moderation event whose `kind` is *not* `'decision'`:
 * `POST /api/admin/listings/:id/reject`, `.../hide` and the ban sweep all
 * write `kind = 'admin'` (admin.ts's `logAdminEvent`), and the three-report
 * auto-hide writes `kind = 'report_autohide'` (listings.ts). None of them
 * bumps the listing's `version`.
 *
 * `POST /api/listings/:id/relist` used to restore status from the newest
 * `kind = 'decision'` row only, which after any of those takedowns is still
 * the pipeline's original `approved` — so the listing's own owner could undo
 * a human's decision with `withdraw` + `relist`, authenticated by nothing but
 * the device token they already had, as many times as they liked.
 *
 * Each case below drives the real admin endpoint rather than writing the
 * event by hand, so a future change to how a takedown is recorded fails here
 * rather than passing against a fixture that no longer matches production.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnerListing } from "@keepsake/contracts/listing";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import {
  authHeaders,
  freshClientIp,
  freshOwnerToken,
  readOk,
  seedStandardPostalCodes,
  setTestEnvVar,
  uploadPhoto,
  waitForListingStatus,
} from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-relist-takedown-1";

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

const VALID_LISTING_BODY = {
  title: "A quiet teacup",
  story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
  category: "home_kitchen",
  country: "US",
  postal_code: "02144",
  date_of_birth: "1990-01-01",
};

/** A real owner-token-authenticated listing that the mocked pipeline has
 * approved — i.e. one carrying a genuine `kind='decision'`/`approved` event
 * at version 1, which is the row the old code kept finding. */
async function createApprovedListing(token: string): Promise<OwnerListing> {
  await seedStandardPostalCodes();
  const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
  const res = await SELF.fetch("http://x/api/listings", {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID_LISTING_BODY, photo_ids: [photo.id] }),
  });
  const listing = await readOk<OwnerListing>(res);
  await waitForListingStatus(listing.id, (status) => status === "approved");
  return listing;
}

async function withdrawThenRelist(listingId: string, token: string): Promise<OwnerListing> {
  const withdrawRes = await SELF.fetch(`http://x/api/listings/${listingId}/withdraw`, { method: "POST", headers: authHeaders(token) });
  expect(withdrawRes.status).toBe(200);
  expect((await readOk<OwnerListing>(withdrawRes)).status).toBe("withdrawn");

  const relistRes = await SELF.fetch(`http://x/api/listings/${listingId}/relist`, { method: "POST", headers: authHeaders(token) });
  expect(relistRes.status).toBe(200);
  return readOk<OwnerListing>(relistRes);
}

/** The assertion that actually matters: whatever the API said, a stranger
 * must not be able to fetch the listing again. `GET /api/listings/:id`
 * serves `approved` and `given` only, so a 404 here is the real proof the
 * takedown survived — not just that a status string looked right. */
async function expectNotPubliclyVisible(listingId: string): Promise<void> {
  const publicRes = await SELF.fetch(`http://x/api/listings/${listingId}`);
  expect(publicRes.status).toBe(404);
}

describe("withdraw + relist cannot undo a takedown (issue #162)", () => {
  beforeEach(() => setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN));
  afterEach(() => setTestEnvVar("ADMIN_TOKEN", ""));

  it("an admin rejection survives withdraw + relist", async () => {
    const token = freshOwnerToken();
    const listing = await createApprovedListing(token);

    const rejectRes = await SELF.fetch(`http://x/api/admin/listings/${listing.id}/reject`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ reason: "violent_content" }),
    });
    expect(rejectRes.status).toBe(200);

    const relisted = await withdrawThenRelist(listing.id, token);
    expect(relisted.status).not.toBe("approved");
    // `needs_review`, not `pending`: `pending` would re-run the AI pipeline,
    // which is the judgement the admin just overrode — it would re-approve
    // the listing within seconds and the bypass would be as complete as
    // before, only slower.
    expect(relisted.status).toBe("needs_review");
    expect(relisted.moderation_reason).toBe("held_for_review");
    await expectNotPubliclyVisible(listing.id);
  });

  it("an admin hide survives withdraw + relist", async () => {
    const token = freshOwnerToken();
    const listing = await createApprovedListing(token);

    const hideRes = await SELF.fetch(`http://x/api/admin/listings/${listing.id}/hide`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ reason: "reported by several people" }),
    });
    expect(hideRes.status).toBe(200);

    const relisted = await withdrawThenRelist(listing.id, token);
    expect(relisted.status).toBe("needs_review");
    await expectNotPubliclyVisible(listing.id);
  });

  it("the ban sweep's hide survives withdraw + relist after an unban", async () => {
    const token = freshOwnerToken();
    const listing = await createApprovedListing(token);

    const ownerRow = await env.DB.prepare("SELECT owner_id FROM listings WHERE id = ?")
      .bind(listing.id)
      .first<{ owner_id: string }>();
    expect(ownerRow?.owner_id).toBeTruthy();
    const ownerId = ownerRow!.owner_id;

    const banRes = await SELF.fetch(`http://x/api/admin/owners/${ownerId}/ban`, { method: "POST", headers: adminHeaders(), body: "{}" });
    expect(banRes.status).toBe(200);

    const hiddenRow = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(listing.id).first<{ status: string }>();
    expect(hiddenRow?.status).toBe("hidden");

    // A banned owner can't call anything, so the bypass needs the unban
    // first — which is exactly the scenario in the issue: banned, swept,
    // later unbanned, and the sweep's hide silently undone from there.
    const unbanRes = await SELF.fetch(`http://x/api/admin/owners/${ownerId}/unban`, { method: "POST", headers: adminHeaders() });
    expect(unbanRes.status).toBe(200);

    const relisted = await withdrawThenRelist(listing.id, token);
    expect(relisted.status).toBe("needs_review");
    await expectNotPubliclyVisible(listing.id);
  });

  it("a three-report auto-hide survives withdraw + relist", async () => {
    const token = freshOwnerToken();
    const listing = await createApprovedListing(token);

    for (let i = 0; i < 3; i++) {
      const res = await SELF.fetch(`http://x/api/listings/${listing.id}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
        body: JSON.stringify({ reason: "not_a_keepsake" }),
      });
      expect(res.status).toBe(201);
    }

    const hiddenRow = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(listing.id).first<{ status: string }>();
    expect(hiddenRow?.status).toBe("hidden");

    const relisted = await withdrawThenRelist(listing.id, token);
    expect(relisted.status).toBe("needs_review");
    await expectNotPubliclyVisible(listing.id);
  });

  it("an admin restore still relists to approved — the guard doesn't refuse a legitimate one", async () => {
    const token = freshOwnerToken();
    const listing = await createApprovedListing(token);

    const hideRes = await SELF.fetch(`http://x/api/admin/listings/${listing.id}/hide`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(hideRes.status).toBe(200);
    const restoreRes = await SELF.fetch(`http://x/api/admin/listings/${listing.id}/restore`, { method: "POST", headers: adminHeaders() });
    expect(restoreRes.status).toBe(200);

    const relisted = await withdrawThenRelist(listing.id, token);
    expect(relisted.status).toBe("approved");

    const publicRes = await SELF.fetch(`http://x/api/listings/${listing.id}`);
    expect(publicRes.status).toBe(200);
  });

  it("an untouched approved listing still relists to approved", async () => {
    const token = freshOwnerToken();
    const listing = await createApprovedListing(token);

    const relisted = await withdrawThenRelist(listing.id, token);
    expect(relisted.status).toBe("approved");
  });
});
