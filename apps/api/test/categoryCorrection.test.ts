/**
 * Issue #155 — the giver's own correction of what the model decided their
 * object is.
 *
 * `category` had exactly one kind of writer before this: the model, at create
 * (the cover-photo suggestion) and again through
 * `POST /api/admin/listings/:id/resuggest`. #35 removed the give flow's
 * picker, correctly — it was a step in a flow whose product is the story —
 * and left no human path at any layer. The first real production listing
 * showed a visitor the single word OTHER (#135); the three fixes that
 * followed all improved the *model's* answer, and none of them let the person
 * whose object it is say what it actually was.
 *
 * Two properties, and the second is the one that makes the first worth
 * having: a giver can set the category, and nothing later overwrites it.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnerListing } from "@keepsake/contracts/listing";
import type { AdminResuggestResult } from "@keepsake/contracts/admin";
import {
  authHeaders,
  freshOwnerToken,
  insertApprovedListing,
  readErr,
  readOk,
  setTestEnvVar,
  uploadPhoto,
} from "./helpers.js";
import { ulid } from "../src/lib/ids.js";

const ADMIN_TOKEN = "test-admin-token-category-correction";

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

/** A listing owned by `token`, so the owner-authenticated route below is
 * reachable the way a real giver reaches it. */
async function ownedListing(token: string, category = "other"): Promise<string> {
  // `PUT /api/photos` is the only path that mints an `owners` row for a fresh
  // token (`ownerAuth({ createIfMissing: true })`), same as email.test.ts.
  await uploadPhoto({ token });
  const me = await readOk<{ id: string }>(await SELF.fetch("http://x/api/me", { headers: authHeaders(token) }));
  return insertApprovedListing({ ownerId: me.id, category });
}

async function setCategory(id: string, token: string, category: string): Promise<Response> {
  return SELF.fetch(`http://x/api/listings/${id}/category`, {
    method: "PUT",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ category }),
  });
}

async function listingRow(id: string): Promise<{ category: string; status: string; version: number; category_chosen_at: number | null }> {
  const row = await env.DB.prepare("SELECT category, status, version, category_chosen_at FROM listings WHERE id = ?")
    .bind(id)
    .first<{ category: string; status: string; version: number; category_chosen_at: number | null }>();
  if (!row) throw new Error("listing vanished");
  return row;
}

describe("a giver can correct their listing's category (#155)", () => {
  it("sets the category and records that a human chose it", async () => {
    const token = freshOwnerToken();
    const id = await ownedListing(token);

    const res = await setCategory(id, token, "tools_diy");
    expect(res.status).toBe(200);
    const listing = await readOk<OwnerListing>(res);
    expect(listing.category).toBe("tools_diy");
    expect(listing.category_chosen_at).toEqual(expect.any(Number));

    const row = await listingRow(id);
    expect(row.category).toBe("tools_diy");
    expect(row.category_chosen_at).toEqual(expect.any(Number));
  });

  // The reason this is its own route rather than a PATCH carrying one field.
  // A PATCH bumps `version`, resets `status` to `pending` and re-runs the
  // pipeline — so correcting a one-word label would cost a live listing its
  // place in the feed for a moderation cycle, which is the tax that stops
  // people correcting anything.
  it("does not unpublish the listing, bump its version, or re-moderate it", async () => {
    const token = freshOwnerToken();
    const id = await ownedListing(token);
    const before = await listingRow(id);

    expect((await setCategory(id, token, "books_letters")).status).toBe(200);

    const after = await listingRow(id);
    expect(after.status).toBe("approved");
    expect(after.version).toBe(before.version);
    // And it is still fetchable by a stranger, which is what "still in the
    // feed" actually means.
    expect((await SELF.fetch(`http://x/api/listings/${id}`)).status).toBe(200);
  });

  it("refuses a category that is not one of ours", async () => {
    const token = freshOwnerToken();
    const id = await ownedListing(token);

    const res = await setCategory(id, token, "sporting_goods_and_dreams");
    expect(res.status).toBe(400);
    expect((await listingRow(id)).category_chosen_at).toBeNull();
  });

  it("is not another owner's to set", async () => {
    const token = freshOwnerToken();
    const id = await ownedListing(token);
    const stranger = freshOwnerToken();
    await uploadPhoto({ token: stranger });

    const res = await setCategory(id, stranger, "tools_diy");
    // "Not found", not "forbidden" — the same posture every owner-scoped
    // route here takes, so a stranger learns nothing about which ids exist.
    expect(res.status).toBe(404);
    expect((await readErr(res)).code).toBe("not_found");
    expect((await listingRow(id)).category_chosen_at).toBeNull();
  });

  it("refuses once the keepsake has been given", async () => {
    const token = freshOwnerToken();
    const id = await ownedListing(token);
    await env.DB.prepare("UPDATE listings SET status = 'given' WHERE id = ?").bind(id).run();

    expect((await setCategory(id, token, "tools_diy")).status).toBe(409);
  });

  it("stamps even when the giver picks the category the model already chose", async () => {
    // The column records that a human decided, not that they changed
    // something — a giver confirming the model was right is still the fact
    // `resuggest` needs to respect.
    const token = freshOwnerToken();
    const id = await ownedListing(token, "home_kitchen");

    expect((await setCategory(id, token, "home_kitchen")).status).toBe(200);
    expect((await listingRow(id)).category_chosen_at).toEqual(expect.any(Number));
  });

  it("PATCH carrying a category counts as a choice too", async () => {
    // Nothing sends it today — the give flow has had no picker since #35 —
    // but `UpdateListingInput` accepts the field, and a category arriving
    // there is as much a human saying what their object is as one arriving at
    // the route above.
    const token = freshOwnerToken();
    const id = await ownedListing(token);

    const res = await SELF.fetch(`http://x/api/listings/${id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ category: "furniture_decor" }),
    });
    expect(res.status).toBe(200);
    expect((await listingRow(id)).category_chosen_at).toEqual(expect.any(Number));
  });

  it("an ordinary edit that says nothing about the category leaves the stamp alone", async () => {
    const token = freshOwnerToken();
    const id = await ownedListing(token);
    expect((await setCategory(id, token, "tools_diy")).status).toBe(200);
    const chosenAt = (await listingRow(id)).category_chosen_at;

    const res = await SELF.fetch(`http://x/api/listings/${id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "A quieter teacup" }),
    });
    expect(res.status).toBe(200);

    const after = await listingRow(id);
    expect(after.category).toBe("tools_diy");
    expect(after.category_chosen_at).toBe(chosenAt);
  });
});

describe("resuggest leaves a giver-chosen category alone (#155)", () => {
  beforeEach(() => setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN));
  afterEach(() => setTestEnvVar("ADMIN_TOKEN", ""));

  /** A cover photo for the listing, since `resuggest` refuses without one. */
  async function attachCover(listingId: string, ownerId: string): Promise<void> {
    const photoId = ulid();
    const thumbKey = `photos/${photoId}/thumb.jpg`;
    await env.DB.prepare(
      `INSERT INTO photos
        (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at)
       VALUES (?, ?, ?, 0, ?, ?, 800, 600, 12345, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 'image/jpeg', 'passed', ?)`,
    )
      .bind(photoId, ownerId, listingId, `photos/${photoId}/full.jpg`, thumbKey, Date.now())
      .run();
    // Without a real object at the thumb key, `suggestFromPhoto` short-circuits
    // to `{ suggestion: null, reason: "thumb_missing" }` and never reaches the
    // model at all — the trap `adminResuggest.test.ts` and
    // `backfillAspects.test.ts` both document.
    await env.BUCKET.put(thumbKey, new Uint8Array([0xff, 0xd8, 0xff]), {
      httpMetadata: { contentType: "image/jpeg" },
    });
  }

  async function resuggest(listingId: string): Promise<Response> {
    return SELF.fetch(`http://x/api/admin/listings/${listingId}/resuggest`, { method: "POST", headers: adminHeaders() });
  }

  it("keeps the giver's category, applies the model's aspects, and says so", async () => {
    const token = freshOwnerToken();
    const id = await ownedListing(token, "other");
    const row = await env.DB.prepare("SELECT owner_id FROM listings WHERE id = ?").bind(id).first<{ owner_id: string }>();
    await attachCover(id, row?.owner_id ?? "");
    expect((await setCategory(id, token, "tools_diy")).status).toBe(200);

    const res = await resuggest(id);
    expect(res.status).toBe(200);
    const result = await readOk<AdminResuggestResult>(res);

    // Asserted, not guarded behind `if (result.applied)`: a suggestion that
    // never applied would make every assertion below vacuous, which is the
    // one failure mode this repo keeps finding in its own tests.
    expect(result.applied).toBe(true);
    // MOCK_AI returns a fixed suggestion; whatever category it names, the
    // giver's must survive it.
    expect((await listingRow(id)).category).toBe("tools_diy");
    expect(result.after.category).toBe("tools_diy");
    // An operator has to be able to tell "the model agreed" from "we did not
    // take the model's answer", which is what this field is for.
    expect(result.category_kept).toBe("chosen_by_giver");
    // The aspects half still ran — this route's other job is not skipped
    // because the category was left alone.
    expect(result.after.aspects).not.toEqual(result.before.aspects);
  });

  it("still applies the model's category when no human has chosen one", async () => {
    // The control. Without it, "the giver's choice survived" could be passing
    // because resuggest never writes a category at all.
    const token = freshOwnerToken();
    const id = await ownedListing(token, "other");
    const row = await env.DB.prepare("SELECT owner_id FROM listings WHERE id = ?").bind(id).first<{ owner_id: string }>();
    await attachCover(id, row?.owner_id ?? "");

    const res = await resuggest(id);
    const result = await readOk<AdminResuggestResult>(res);
    expect(result.applied).toBe(true);
    expect(result.category_kept).toBeUndefined();
    expect((await listingRow(id)).category).toBe(result.after.category);
  });
});
