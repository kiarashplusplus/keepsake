import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authHeaders,
  freshOwnerToken,
  readErr,
  readOk,
  seedStandardPostalCodes,
  setTestEnvVar,
  uploadPhoto,
  waitForListingStatus,
} from "./helpers.js";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import type { OwnerListing } from "@keepsake/contracts/listing";

const VALID_LISTING_BODY = {
  title: "A quiet teacup",
  story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
  category: "home_kitchen",
  country: "US",
  postal_code: "02144",
  date_of_birth: "1990-01-01",
};

async function createListing(token: string, photoIds: string[], overrides: Record<string, unknown> = {}): Promise<Response> {
  return SELF.fetch("http://x/api/listings", {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID_LISTING_BODY, photo_ids: photoIds, ...overrides }),
  });
}

async function givenOnePhoto(token: string): Promise<string> {
  const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
  return photo.id;
}

/** Creates a listing and waits for MOCK_AI's background pipeline run to
 * land it on `approved` — the create response itself always reports
 * `pending`, since the pipeline runs in `waitUntil()` after the response is
 * built, and `SELF.fetch` (a plain service-binding `Fetcher`) gives tests no
 * handle to await that execution context directly. */
async function createApprovedListing(token: string, photoIds: string[], overrides: Record<string, unknown> = {}): Promise<OwnerListing> {
  const listing = await readOk<OwnerListing>(await createListing(token, photoIds, overrides));
  await waitForListingStatus(listing.id, (status) => status === "approved");
  return listing;
}

describe("POST /api/listings", () => {
  it("creates a pending listing that MOCK_AI approves within its background moderation run", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);

    const res = await createListing(token, [photoId]);
    expect(res.status).toBe(201);
    const listing = await readOk<OwnerListing>(res);
    expect(listing.status).toBe("pending");
    expect(listing.place_name).toBe("Somerville");
    expect(listing.admin1).toBe("MA");
    expect(listing.photos).toHaveLength(1);

    const row = await waitForListingStatus(listing.id, (status) => status === "approved");
    expect(row.published_at).not.toBeNull();

    const decision = await env.DB.prepare(
      "SELECT verdict FROM moderation_events WHERE listing_id = ? AND kind = 'decision' ORDER BY created_at DESC LIMIT 1",
    )
      .bind(listing.id)
      .first<{ verdict: string }>();
    expect(decision?.verdict).toBe("approved");
  });

  it("records age_attested_at on create (docs/legal-considerations.md Minimum age)", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);

    const listing = await readOk<OwnerListing>(await createListing(token, [photoId]));
    const row = await env.DB.prepare("SELECT age_attested_at FROM listings WHERE id = ?")
      .bind(listing.id)
      .first<{ age_attested_at: number | null }>();
    expect(row?.age_attested_at).not.toBeNull();
  });

  it("400s bad_request when date_of_birth is missing", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const res = await createListing(token, [photoId], { date_of_birth: undefined });
    expect(res.status).toBe(400);
    const error = await readErr(res);
    expect(error.code).toBe("bad_request");
  });

  it("400s bad_request when date_of_birth implies under the minimum age, not just when it's missing", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const res = await createListing(token, [photoId], { date_of_birth: "2020-01-01" });
    expect(res.status).toBe(400);
  });

  it("400s bad_request for a postcode the geo seed doesn't cover", async () => {
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const res = await createListing(token, [photoId], { postal_code: "99999" });
    expect(res.status).toBe(400);
    const error = await readErr(res);
    expect(error.code).toBe("bad_request");
  });

  it("400s bad_request when a photo_id isn't this owner's orphan upload", async () => {
    await seedStandardPostalCodes();
    const ownerA = freshOwnerToken();
    const ownerB = freshOwnerToken();
    const photoIdFromA = await givenOnePhoto(ownerA);

    const res = await createListing(ownerB, [photoIdFromA]);
    expect(res.status).toBe(400);
  });

  it("400s bad_request for a story that fails contract validation (too short)", async () => {
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const res = await createListing(token, [photoId], { story: "too short" });
    expect(res.status).toBe(400);
    const error = await readErr(res);
    expect(error.code).toBe("bad_request");
    expect(error).toHaveProperty("issues");
  });

  it("replays a cached response for a repeated X-Idempotency-Key instead of creating a second listing", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const idempotencyKey = "test-key-1";
    const headers = { ...authHeaders(token), "Content-Type": "application/json", "X-Idempotency-Key": idempotencyKey };
    const body = JSON.stringify({ ...VALID_LISTING_BODY, photo_ids: [photoId] });

    const first = await SELF.fetch("http://x/api/listings", { method: "POST", headers, body });
    expect(first.status).toBe(201);
    const firstListing = await readOk<OwnerListing>(first);
    expect(first.headers.get("X-Idempotent-Replay")).toBeNull();

    const second = await SELF.fetch("http://x/api/listings", { method: "POST", headers, body });
    expect(second.status).toBe(201);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("1");
    const secondListing = await readOk<OwnerListing>(second);
    expect(secondListing.id).toBe(firstListing.id);

    const { results } = await env.DB.prepare("SELECT id FROM listings WHERE owner_id = (SELECT owner_id FROM photos WHERE id = ?)")
      .bind(photoId)
      .all();
    expect(results.length).toBe(1);
  });
});

describe("turnstile on POST /api/listings", () => {
  afterEach(() => {
    setTestEnvVar("TURNSTILE_SECRET", "");
    vi.unstubAllGlobals();
  });

  it("403s turnstile_failed when the secret is set but the header is missing", async () => {
    setTestEnvVar("TURNSTILE_SECRET", "test-secret");
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);

    const res = await createListing(token, [photoId]);
    expect(res.status).toBe(403);
    const error = await readErr(res);
    expect(error.code).toBe("turnstile_failed");
  });

  it("403s turnstile_failed when siteverify reports success:false", async () => {
    setTestEnvVar("TURNSTILE_SECRET", "test-secret");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
      return new Response(JSON.stringify({ success: false }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const res = await SELF.fetch("http://x/api/listings", {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json", "cf-turnstile-response": "bad-token" },
      body: JSON.stringify({ ...VALID_LISTING_BODY, photo_ids: [photoId] }),
    });
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("201s and creates the listing when siteverify reports success:true", async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("TURNSTILE_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
    );

    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const res = await SELF.fetch("http://x/api/listings", {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json", "cf-turnstile-response": "good-token" },
      body: JSON.stringify({ ...VALID_LISTING_BODY, photo_ids: [photoId] }),
    });
    expect(res.status).toBe(201);
  });
});

describe("owner auth on listing routes", () => {
  it("401s a malformed bearer token", async () => {
    const res = await SELF.fetch("http://x/api/me", { headers: { Authorization: "Bearer not-a-real-token" } });
    expect(res.status).toBe(401);
  });

  it("403s forbidden for a banned owner", async () => {
    const token = freshOwnerToken();
    // Register the owner first (GET /api/me has no createIfMissing).
    await givenOnePhoto(token);
    const tokenHash = await sha256HexForTest(token);
    await env.DB.prepare("UPDATE owners SET banned_at = ? WHERE token_hash = ?").bind(Date.now(), tokenHash).run();

    const res = await SELF.fetch("http://x/api/me", { headers: authHeaders(token) });
    expect(res.status).toBe(403);
    const error = await readErr(res);
    expect(error.code).toBe("forbidden");
  });
});

// Duplicated (not imported) on purpose: this is the same primitive
// `src/lib/digest.ts` uses, kept local to the test so the test doesn't
// depend on the implementation module it's indirectly verifying via HTTP.
async function sha256HexForTest(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("GET /api/me/listings and /api/me/listings/:id", () => {
  it("lists an owner's listings newest first, with photos and moderation info", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId1 = await givenOnePhoto(token);
    const first = await createApprovedListing(token, [photoId1]);

    const photoId2 = await givenOnePhoto(token);
    const second = await createApprovedListing(token, [photoId2], { title: "A second keepsake" });

    const listRes = await SELF.fetch("http://x/api/me/listings", { headers: authHeaders(token) });
    expect(listRes.status).toBe(200);
    const list = await readOk<OwnerListing[]>(listRes);
    expect(list.map((l) => l.id)).toEqual([second.id, first.id]);

    const detailRes = await SELF.fetch(`http://x/api/me/listings/${first.id}`, { headers: authHeaders(token) });
    expect(detailRes.status).toBe(200);
    const detail = await readOk<OwnerListing & { requests: unknown[]; moderation: { status: string; held: boolean } }>(detailRes);
    expect(detail.requests).toEqual([]);
    expect(detail.moderation.status).toBe("approved");
    expect(detail.moderation.held).toBe(false);
  });

  it("404s another owner's listing", async () => {
    await seedStandardPostalCodes();
    const ownerA = freshOwnerToken();
    const ownerB = freshOwnerToken();
    const photoId = await givenOnePhoto(ownerA);
    const listing = await readOk<OwnerListing>(await createListing(ownerA, [photoId]));
    await givenOnePhoto(ownerB); // register ownerB

    const res = await SELF.fetch(`http://x/api/me/listings/${listing.id}`, { headers: authHeaders(ownerB) });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/listings/:id (public)", () => {
  it("404s a rejected listing (never public, regardless of why it didn't pass)", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const listing = await readOk<OwnerListing>(
      await createListing(token, [photoId], { story: "Email me at test@example.com about this keepsake, thanks!" }),
    );

    await waitForListingStatus(listing.id, (status) => status === "rejected");

    const publicRes = await SELF.fetch(`http://x/api/listings/${listing.id}`);
    expect(publicRes.status).toBe(404);
  });

  it("200s an approved listing", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const listing = await createApprovedListing(token, [photoId]);

    const publicRes = await SELF.fetch(`http://x/api/listings/${listing.id}`);
    expect(publicRes.status).toBe(200);
  });
});

describe("listing lifecycle: given / withdraw / relist", () => {
  it("moves approved -> given -> (not withdrawable) and withdrawn -> relist -> approved", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const listing = await createApprovedListing(token, [photoId]);

    const withdrawRes = await SELF.fetch(`http://x/api/listings/${listing.id}/withdraw`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(withdrawRes.status).toBe(200);
    const withdrawn = await readOk<OwnerListing>(withdrawRes);
    expect(withdrawn.status).toBe("withdrawn");

    const relistRes = await SELF.fetch(`http://x/api/listings/${listing.id}/relist`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(relistRes.status).toBe(200);
    const relisted = await readOk<OwnerListing>(relistRes);
    // Last decision for this version was `approved`, so relist goes straight
    // back to `approved` without re-running moderation.
    expect(relisted.status).toBe("approved");

    const givenRes = await SELF.fetch(`http://x/api/listings/${listing.id}/given`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(givenRes.status).toBe(200);
    const given = await readOk<OwnerListing>(givenRes);
    expect(given.status).toBe("given");
    expect(given.given_at).toBeDefined();

    const secondWithdraw = await SELF.fetch(`http://x/api/listings/${listing.id}/withdraw`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(secondWithdraw.status).toBe(409);
  });
});

describe("PATCH /api/listings/:id", () => {
  it("bumps version, resets to pending, and re-approves via the mocked pipeline", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const listing = await createApprovedListing(token, [photoId]);
    expect(listing.version).toBe(1);

    const patchRes = await SELF.fetch(`http://x/api/listings/${listing.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "An updated quiet teacup" }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await readOk<OwnerListing>(patchRes);
    expect(updated.version).toBe(2);
    expect(updated.title).toBe("An updated quiet teacup");
    // The PATCH response itself is built right after the version-2 row is
    // written and before that version's `waitUntil(moderateListing(...))`
    // has run, so it always reports `pending` here, then converges.
    expect(updated.status).toBe("pending");

    await waitForListingStatus(listing.id, (status) => status === "approved");
  });

  it("one of two overlapping PATCHes loses with 409, not a silently dropped update (issue #282)", async () => {
    // Two genuinely concurrent requests — dispatched before either is
    // awaited, the same overlap `reportAutohideConcurrency.test.ts` relies
    // on — engineered with the same asymmetry the issue's own "concrete
    // scenario" describes: A is a bare title edit, the shortest path through
    // the handler (straight from `fetchListingRow` to the guarded
    // `UPDATE`, no other awaits between them). B carries `country`/
    // `postal_code` (an extra `lookupPostalCode` await) and `photo_ids` (an
    // extra ownership `SELECT`) between its own read and its own write, so
    // it reliably reaches its `UPDATE` after A's has already committed —
    // while both still read the row at version 1, since they were
    // dispatched together. That reproduces "B read `row.version = 1` a
    // moment earlier" deterministically rather than hoping a bare
    // `Promise.all` interleaves the right way.
    //
    // Deliberately `createListing`, not `createApprovedListing`: PATCH's own
    // guard doesn't care whether the listing has converged to `approved`
    // yet (only `given` is refused), and waiting on `waitForListingStatus`'s
    // polling loop first was measured to change the runtime's scheduling
    // enough to make the race below intermittent — sometimes both requests
    // read before either wrote, sometimes not. Racing immediately after
    // create, with nothing else awaited first, reproduced the interleaving
    // on every run tried.
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const listing = await readOk<OwnerListing>(await createListing(token, [photoId]));
    expect(listing.version).toBe(1);

    const fast = SELF.fetch(`http://x/api/listings/${listing.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Winning PATCH's title" }),
    });
    const slow = SELF.fetch(`http://x/api/listings/${listing.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Losing PATCH's title",
        country: "US",
        postal_code: "02144",
        photo_ids: [photoId],
        aspects: [{ name: "material", value: "porcelain" }],
      }),
    });

    const [resFast, resSlow] = await Promise.all([fast, slow]);
    // On `main`, B's `UPDATE ... WHERE version = ?` matches zero rows (A
    // already bumped it to 2), the result is discarded, and the handler
    // falls through to run B's photo re-attach and aspect replace
    // unconditionally before returning 200 with a row it no longer owns.
    // The fix returns 409 here instead, before either of those writes runs.
    expect(resFast.status).toBe(200);
    expect(resSlow.status).toBe(409);
    const error = await readErr(resSlow);
    expect(error.code).toBe("conflict");

    // A's title and version 2 must survive untouched — no aspect row from
    // B's request in particular, since that write sits after the guard in
    // the handler and must never have run.
    const row = await env.DB.prepare("SELECT title, version FROM listings WHERE id = ?")
      .bind(listing.id)
      .first<{ title: string; version: number }>();
    expect(row?.title).toBe("Winning PATCH's title");
    expect(row?.version).toBe(2);

    const aspectCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM listing_aspects WHERE listing_id = ?")
      .bind(listing.id)
      .first<{ n: number }>();
    expect(aspectCount?.n).toBe(0);
  });

  it("409s editing a given listing", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const listing = await createApprovedListing(token, [photoId]);
    const givenRes = await SELF.fetch(`http://x/api/listings/${listing.id}/given`, { method: "POST", headers: authHeaders(token) });
    expect(givenRes.status).toBe(200);

    const patchRes = await SELF.fetch(`http://x/api/listings/${listing.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Trying to edit anyway" }),
    });
    expect(patchRes.status).toBe(409);
  });
});

describe("DELETE /api/listings/:id", () => {
  it("deletes the listing and its photos", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const listing = await readOk<OwnerListing>(await createListing(token, [photoId]));

    const deleteRes = await SELF.fetch(`http://x/api/listings/${listing.id}`, { method: "DELETE", headers: authHeaders(token) });
    expect(deleteRes.status).toBe(200);

    const row = await env.DB.prepare("SELECT id FROM listings WHERE id = ?").bind(listing.id).first();
    expect(row).toBeNull();
    const photoRow = await env.DB.prepare("SELECT id FROM photos WHERE id = ?").bind(photoId).first();
    expect(photoRow).toBeNull();
  });
});
