/**
 * Issue #199 — the takedown-undo bypass reached by editing.
 *
 * #162 closed `withdraw` + `relist`: that path restored a listing's status
 * from its own event log at the *same* version, so a human's takedown was
 * still there to be found once `relist` learned to read every status-setting
 * event kind rather than `kind='decision'` alone.
 *
 * `PATCH /api/listings/:id` arrives at the same place by a road that check
 * cannot see. An edit bumps `version`, sets `pending` and schedules the
 * pipeline afresh; admin events and the three-report auto-hide are written
 * against the version that was live when they happened. The new version
 * therefore carries no takedown at all, and the pipeline — which auto-
 * approves anything the models pass — republished a listing Kiarash had
 * rejected, for the price of one character in the title.
 *
 * Every case drives the real endpoints (admin reject/hide/restore/approve,
 * the public report route, the owner's own PATCH) rather than writing
 * events by hand, for the reason `relistAfterTakedown.test.ts` gives: a
 * future change to how a takedown is recorded should fail here, not pass
 * against a fixture that no longer matches production.
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

const ADMIN_TOKEN = "test-admin-token-edit-takedown-1";

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
  // Required since the give flow stopped offering a "Skip" on its email
  // step: `POST /api/listings` refuses a first listing with no way back to
  // its giver (neither the body nor the owner row carrying an address).
  email: "giver@keepsake.ing",
};

async function createListing(token: string, overrides: Record<string, unknown> = {}): Promise<OwnerListing> {
  await seedStandardPostalCodes();
  const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
  const res = await SELF.fetch("http://x/api/listings", {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID_LISTING_BODY, ...overrides, photo_ids: [photo.id] }),
  });
  return readOk<OwnerListing>(res);
}

async function createApprovedListing(token: string): Promise<OwnerListing> {
  const listing = await createListing(token);
  await waitForListingStatus(listing.id, (status) => status === "approved");
  return listing;
}

/**
 * The edit from the issue: one character of the title, nothing else, sent by
 * the listing's own owner with the device token they already have.
 *
 * Waits for any status other than `pending` rather than for the status the
 * case expects — a regression here must *fail* the assertion below, not hang
 * until the poll times out somewhere far from the cause.
 */
async function editTitleAndSettle(
  listingId: string,
  token: string,
  title: string,
): Promise<{ status: string; moderation_reason: string | null }> {
  const res = await SELF.fetch(`http://x/api/listings/${listingId}`, {
    method: "PATCH",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(200);
  expect((await readOk<OwnerListing>(res)).version).toBeGreaterThan(1);
  return waitForListingStatus(listingId, (status) => status !== "pending");
}

/** Whatever the status string says, the real proof is that a stranger still
 * cannot fetch it: `GET /api/listings/:id` serves `approved` and `given`
 * only. */
async function expectNotPubliclyVisible(listingId: string): Promise<void> {
  const publicRes = await SELF.fetch(`http://x/api/listings/${listingId}`);
  expect(publicRes.status).toBe(404);
}

describe("editing cannot undo a takedown (issue #199)", () => {
  beforeEach(() => setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN));
  afterEach(() => setTestEnvVar("ADMIN_TOKEN", ""));

  it("an admin rejection survives an edit", async () => {
    const token = freshOwnerToken();
    const listing = await createApprovedListing(token);

    const rejectRes = await SELF.fetch(`http://x/api/admin/listings/${listing.id}/reject`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ reason: "violent_content" }),
    });
    expect(rejectRes.status).toBe(200);

    const settled = await editTitleAndSettle(listing.id, token, "A quiet teacup.");
    expect(settled.status).not.toBe("approved");
    expect(settled.status).toBe("needs_review");
    expect(settled.moderation_reason).toBe("held_for_review");
    await expectNotPubliclyVisible(listing.id);
  });

  it("records why it was held, against the new version, for whoever reviews it", async () => {
    const token = freshOwnerToken();
    const listing = await createApprovedListing(token);

    const rejectRes = await SELF.fetch(`http://x/api/admin/listings/${listing.id}/reject`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ reason: "violent_content" }),
    });
    expect(rejectRes.status).toBe(200);

    await editTitleAndSettle(listing.id, token, "A quiet teacup.");

    // A `needs_review` the models never asked for, with nothing saying why,
    // would send the reviewer to the wrong question.
    const event = await env.DB.prepare(
      `SELECT listing_version, flags_json FROM moderation_events
       WHERE listing_id = ? AND kind = 'decision' AND verdict = 'needs_review'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
      .bind(listing.id)
      .first<{ listing_version: number; flags_json: string | null }>();
    expect(event?.listing_version).toBe(2);
    expect(JSON.parse(event?.flags_json ?? "{}")).toMatchObject({
      downgraded_from: "approved",
      prior_takedown: "rejected",
      prior_version: 1,
    });
  });

  it("an admin hide survives an edit", async () => {
    const token = freshOwnerToken();
    const listing = await createApprovedListing(token);

    const hideRes = await SELF.fetch(`http://x/api/admin/listings/${listing.id}/hide`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ reason: "reported by several people" }),
    });
    expect(hideRes.status).toBe(200);

    const settled = await editTitleAndSettle(listing.id, token, "A quiet teacup, still");
    expect(settled.status).toBe("needs_review");
    await expectNotPubliclyVisible(listing.id);
  });

  it("a three-report auto-hide survives an edit", async () => {
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
    const hidden = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(listing.id).first<{ status: string }>();
    expect(hidden?.status).toBe("hidden");

    const settled = await editTitleAndSettle(listing.id, token, "A quiet teacup, reported");
    expect(settled.status).toBe("needs_review");
    await expectNotPubliclyVisible(listing.id);
  });

  it("the ban sweep's hide survives an edit after an unban", async () => {
    const token = freshOwnerToken();
    const listing = await createApprovedListing(token);

    const ownerRow = await env.DB.prepare("SELECT owner_id FROM listings WHERE id = ?")
      .bind(listing.id)
      .first<{ owner_id: string }>();
    const ownerId = ownerRow?.owner_id;
    expect(ownerId).toBeTruthy();

    const banRes = await SELF.fetch(`http://x/api/admin/owners/${ownerId}/ban`, { method: "POST", headers: adminHeaders(), body: "{}" });
    expect(banRes.status).toBe(200);
    const unbanRes = await SELF.fetch(`http://x/api/admin/owners/${ownerId}/unban`, { method: "POST", headers: adminHeaders() });
    expect(unbanRes.status).toBe(200);

    const settled = await editTitleAndSettle(listing.id, token, "A quiet teacup, unbanned");
    expect(settled.status).toBe("needs_review");
    await expectNotPubliclyVisible(listing.id);
  });

  it("an admin restore lets a later edit publish again — the guard doesn't refuse a legitimate one", async () => {
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

    const settled = await editTitleAndSettle(listing.id, token, "A quiet teacup, restored");
    expect(settled.status).toBe("approved");

    const publicRes = await SELF.fetch(`http://x/api/listings/${listing.id}`);
    expect(publicRes.status).toBe(200);
  });

  it("the honest recovery path still works: rejected, fixed, reviewed, and editable again", async () => {
    const token = freshOwnerToken();
    const listing = await createApprovedListing(token);

    const rejectRes = await SELF.fetch(`http://x/api/admin/listings/${listing.id}/reject`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ reason: "contact_in_story" }),
    });
    expect(rejectRes.status).toBe(200);

    // The giver fixes it. It reaches a human rather than the public feed…
    const held = await editTitleAndSettle(listing.id, token, "A quiet teacup, fixed");
    expect(held.status).toBe("needs_review");

    // …the human says yes, which is what clears the takedown…
    const approveRes = await SELF.fetch(`http://x/api/admin/listings/${listing.id}/approve`, { method: "POST", headers: adminHeaders() });
    expect(approveRes.status).toBe(200);

    // …and from there the listing edits like any other.
    const settled = await editTitleAndSettle(listing.id, token, "A quiet teacup, reviewed");
    expect(settled.status).toBe("approved");
    const publicRes = await SELF.fetch(`http://x/api/listings/${listing.id}`);
    expect(publicRes.status).toBe(200);
  });

  it("the pipeline's own rejection is not carried forward — fix it and resubmit still publishes", async () => {
    const token = freshOwnerToken();
    // Rejected by the pipeline itself (`kind='decision'`), not by a human:
    // the contact-info regex, the one auto-rejection reachable with MOCK_AI.
    const listing = await createListing(token, {
      story: "My grandmother's teacup, and I would love it to find a home. Reach me at teacup@example.org any time.",
    });
    const rejected = await waitForListingStatus(listing.id, (status) => status !== "pending");
    expect(rejected.status).toBe("rejected");
    expect(rejected.moderation_reason).toBe("contact_in_story");

    const res = await SELF.fetch(`http://x/api/listings/${listing.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ story: VALID_LISTING_BODY.story }),
    });
    expect(res.status).toBe(200);

    const settled = await waitForListingStatus(listing.id, (status) => status !== "pending");
    expect(settled.status).toBe("approved");
  });

  it("an untouched approved listing still re-approves after an edit", async () => {
    const token = freshOwnerToken();
    const listing = await createApprovedListing(token);

    const settled = await editTitleAndSettle(listing.id, token, "A quiet teacup, edited");
    expect(settled.status).toBe("approved");
  });
});
