/**
 * The two halves of "a giver can always be reached about what they gave".
 *
 * 1. `POST /api/listings` refuses to publish a keepsake nobody can be told
 *    about — the server-side half of the give flow losing its "Skip", so a
 *    client that stops asking cannot quietly reopen the hole.
 * 2. The dashboard reads say, per listing, when the giver is nonetheless
 *    holding something up: an address that can receive nothing, or a
 *    stranger who asked and has heard nothing back.
 *
 * Both are driven over HTTP through the real routes. The one thing seeded
 * with SQL is a request's `created_at`, because the threshold under test is
 * 72 hours old and no test may wait for it.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { ListingStaleness, OwnerListing } from "@keepsake/contracts/listing";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import { UNANSWERED_REQUEST_STALE_MS } from "@keepsake/contracts/listing";
import {
  authHeaders,
  freshOwnerToken,
  installFakeEmail,
  readErr,
  readOk,
  removeFakeEmail,
  seedStandardPostalCodes,
  uploadPhoto,
  waitForListingStatus,
} from "./helpers.js";
import { ulid } from "../src/lib/ids.js";

const LISTING_BODY = {
  title: "A quiet teacup",
  story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
  category: "home_kitchen",
  country: "US",
  postal_code: "02144",
  date_of_birth: "1990-01-01",
};

async function givenOnePhoto(token: string): Promise<string> {
  const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
  return photo.id;
}

async function createListing(token: string, overrides: Record<string, unknown> = {}): Promise<Response> {
  const photoId = await givenOnePhoto(token);
  return SELF.fetch("http://x/api/listings", {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ...LISTING_BODY, photo_ids: [photoId], ...overrides }),
  });
}

/** A live listing whose giver's address is present and verified — the
 * ordinary, nothing-wrong case every staleness test below deviates from. */
async function reachableGiverWithListing(): Promise<{ token: string; listingId: string }> {
  await seedStandardPostalCodes();
  const token = freshOwnerToken();
  const listing = await readOk<OwnerListing>(await createListing(token, { email: "giver@keepsake.ing" }));
  await waitForListingStatus(listing.id, (status) => status === "approved");
  await verifyOwnerEmail(token);
  return { token, listingId: listing.id };
}

async function verifyOwnerEmail(token: string): Promise<void> {
  const me = await readOk<{ id: string }>(await SELF.fetch("http://x/api/me", { headers: authHeaders(token) }));
  await env.DB.prepare("UPDATE owners SET email_verified_at = ? WHERE id = ?").bind(Date.now(), me.id).run();
}

/** A confirmed, still-open request that arrived `ageMs` ago. Inserted
 * directly: the route that creates one stamps `created_at` itself, and what
 * is under test is a 72-hour-old ask. */
async function seedOpenRequest(listingId: string, ageMs: number): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO requests (id, listing_id, note, email, phone, ip_digest, status, created_at, confirmed_at)
     VALUES (?, ?, ?, ?, NULL, 'digest', 'open', ?, ?)`,
  )
    .bind(ulid(), listingId, "I'd give this a good home.", `asker-${ulid()}@keepsake.ing`, now - ageMs, now - ageMs)
    .run();
}

async function stalenessOf(token: string, listingId: string): Promise<ListingStaleness> {
  const detail = await readOk<{ staleness: ListingStaleness }>(
    await SELF.fetch(`http://x/api/me/listings/${listingId}`, { headers: authHeaders(token) }),
  );
  return detail.staleness;
}

async function stalenessFromList(token: string, listingId: string): Promise<ListingStaleness> {
  const items = await readOk<{ id: string; staleness: ListingStaleness }[]>(
    await SELF.fetch("http://x/api/me/listings", { headers: authHeaders(token) }),
  );
  const found = items.find((item) => item.id === listingId);
  if (found === undefined) throw new Error(`listing ${listingId} missing from GET /api/me/listings`);
  return found.staleness;
}

describe("POST /api/listings requires a way back to the giver", () => {
  afterEach(() => removeFakeEmail());

  it("400s a first listing that carries no address, and creates nothing", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();

    const res = await createListing(token);

    expect(res.status).toBe(400);
    const error = await readErr(res);
    expect(error.code).toBe("bad_request");
    expect(error.message).toMatch(/email/i);

    const listings = await readOk<unknown[]>(await SELF.fetch("http://x/api/me/listings", { headers: authHeaders(token) }));
    expect(listings).toHaveLength(0);
  });

  it("accepts a second listing with no address in the body, because the owner row already has one", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();

    const first = await createListing(token, { email: "giver@keepsake.ing" });
    expect(first.status).toBe(201);

    // Exactly the shape an older client sends, and the case that is not
    // broken: this giver is reachable, so nothing needs asking again.
    const second = await createListing(token, { title: "A second quiet teacup" });
    expect(second.status).toBe(201);
  });

  it("does not un-verify — or re-mail — a giver posting a second listing with the address they already confirmed", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    await createListing(token, { email: "giver@keepsake.ing" });
    await verifyOwnerEmail(token);

    const sent = installFakeEmail();
    const res = await createListing(token, { title: "A second quiet teacup", email: "giver@keepsake.ing" });
    expect(res.status).toBe(201);

    // The regression this guards: the give flow now always sends the address
    // it prefilled, so an unconditional write here would drop every repeat
    // giver back to unverified — and mail them a link they never asked for —
    // on every single give.
    expect(sent).toHaveLength(0);
    const me = await readOk<{ email_verified: boolean }>(await SELF.fetch("http://x/api/me", { headers: authHeaders(token) }));
    expect(me.email_verified).toBe(true);
  });

  it("still re-verifies and re-mails when the address actually changes", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    await createListing(token, { email: "giver@keepsake.ing" });
    await verifyOwnerEmail(token);

    const sent = installFakeEmail();
    const res = await createListing(token, { title: "A second quiet teacup", email: "moved@keepsake.ing" });
    expect(res.status).toBe(201);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("moved@keepsake.ing");
    const me = await readOk<{ email: string; email_verified: boolean }>(
      await SELF.fetch("http://x/api/me", { headers: authHeaders(token) }),
    );
    expect(me.email).toBe("moved@keepsake.ing");
    expect(me.email_verified).toBe(false);
  });
});

describe("the dashboard says what a listing needs from its giver", () => {
  it("flags nothing for a reachable giver with no open asks", async () => {
    const { token, listingId } = await reachableGiverWithListing();

    expect(await stalenessOf(token, listingId)).toEqual({ reasons: [], waiting_since: null });
    expect(await stalenessFromList(token, listingId)).toEqual({ reasons: [], waiting_since: null });
  });

  it("flags an unverified address — it is mailed nothing but its own verification link", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const listing = await readOk<OwnerListing>(await createListing(token, { email: "giver@keepsake.ing" }));

    expect((await stalenessOf(token, listing.id)).reasons).toEqual(["email_unverified"]);
    expect((await stalenessFromList(token, listing.id)).reasons).toEqual(["email_unverified"]);
  });

  it("flags a giver who removed their address afterwards", async () => {
    const { token, listingId } = await reachableGiverWithListing();

    const removed = await SELF.fetch("http://x/api/me/email", { method: "DELETE", headers: authHeaders(token) });
    expect(removed.status).toBe(200);

    expect((await stalenessOf(token, listingId)).reasons).toEqual(["email_missing"]);
  });

  it("leaves a fresh ask alone, and flags the same ask once it has waited 72 hours", async () => {
    const { token, listingId } = await reachableGiverWithListing();
    await seedOpenRequest(listingId, 60 * 60 * 1000);

    expect(await stalenessOf(token, listingId)).toEqual({ reasons: [], waiting_since: null });

    const askedAt = Date.now() - UNANSWERED_REQUEST_STALE_MS - 60_000;
    await env.DB.prepare("UPDATE requests SET created_at = ?, confirmed_at = ? WHERE listing_id = ?")
      .bind(askedAt, askedAt, listingId)
      .run();

    const stale = await stalenessOf(token, listingId);
    expect(stale.reasons).toEqual(["requests_unanswered"]);
    expect(stale.waiting_since).toBe(askedAt);
    // Both reads agree — they are two code paths over the same rule.
    expect(await stalenessFromList(token, listingId)).toEqual(stale);
  });

  it("never says someone is waiting on an ask nobody confirmed", async () => {
    const { token, listingId } = await reachableGiverWithListing();
    const askedAt = Date.now() - UNANSWERED_REQUEST_STALE_MS - 60_000;
    await env.DB.prepare(
      `INSERT INTO requests (id, listing_id, note, email, phone, ip_digest, status, created_at, confirmed_at)
       VALUES (?, ?, ?, ?, NULL, 'digest', 'unconfirmed', ?, NULL)`,
    )
      .bind(ulid(), listingId, "Held, unproven.", "stranger@keepsake.ing", askedAt)
      .run();

    // Issue #188's rule, restated here because staleness is a new reader of
    // the same rows: an address nobody has proved they control is not a
    // person waiting.
    expect(await stalenessOf(token, listingId)).toEqual({ reasons: [], waiting_since: null });
  });

  it("stops waiting once the giver has chosen someone", async () => {
    const { token, listingId } = await reachableGiverWithListing();
    await seedOpenRequest(listingId, UNANSWERED_REQUEST_STALE_MS + 60_000);

    const request = await env.DB.prepare("SELECT id FROM requests WHERE listing_id = ?").bind(listingId).first<{ id: string }>();
    const res = await SELF.fetch(`http://x/api/me/listings/${listingId}/choose`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: request?.id, handoff_note: "Any afternoon this week works." }),
    });
    expect(res.status).toBe(200);

    // Answered is answered: whatever happens next is between two people, and
    // the dashboard stops asking the giver to do something they have done.
    expect(await stalenessOf(token, listingId)).toEqual({ reasons: [], waiting_since: null });
  });

  it("says nothing about a listing that can no longer take an ask", async () => {
    const { token, listingId } = await reachableGiverWithListing();
    await seedOpenRequest(listingId, UNANSWERED_REQUEST_STALE_MS + 60_000);
    await SELF.fetch("http://x/api/me/email", { method: "DELETE", headers: authHeaders(token) });

    const withdrawn = await SELF.fetch(`http://x/api/listings/${listingId}/withdraw`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(withdrawn.status).toBe(200);

    expect(await stalenessOf(token, listingId)).toEqual({ reasons: [], waiting_since: null });
  });
});
