/**
 * Issue #141: `POST /api/admin/listings/:id/resuggest`.
 *
 * The endpoint exists because a prompt improvement had no way to reach a
 * listing that already existed. #135 taught the vision model to read the
 * words printed on an object; the one live production listing kept the
 * single vague aspect the older prompt produced, permanently, because
 * `POST /api/admin/backfill-aspects` skips anything that already has aspect
 * rows and nothing anywhere updates `listings.category`.
 *
 * `mockSuggestAi` and `insertListingWithCoverPhoto` mirror
 * `backfillAspects.test.ts` — same reason stated there: this exercises the
 * mocked-AI call path rather than `MOCK_AI`'s canned fixture, so each test
 * controls exactly what the model "sees".
 */
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MODELS } from "../src/models.js";
import { todayISO } from "../src/moderation/budget.js";
import { insertOwner, seedStandardPostalCodes, setTestEnvVar } from "./helpers.js";
import { ulid } from "../src/lib/ids.js";

const ADMIN_TOKEN = "test-admin-token-abcdef0123456789";

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

function mockSuggestAi(handler: (callIndex: number) => unknown): void {
  let callIndex = 0;
  const run = async (model: string) => {
    if (model !== MODELS.imageVision) throw new Error(`mockSuggestAi: unexpected model ${model}`);
    const result = handler(callIndex);
    callIndex += 1;
    return result;
  };
  env.AI.run = run as unknown as Ai["run"];
}

const GIVERS_OWN_TITLE = "Dad's fishing line";
const GIVERS_OWN_STORY = "He kept this spool in the truck for twenty years, and it should go to someone who fishes.";

async function insertListing(options: { ownerId: string; withCoverPhoto?: boolean }): Promise<string> {
  await seedStandardPostalCodes();
  const listingId = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO listings
      (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
       status, version, created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, 'other', 'US', '02144', 'Somerville', 'MA', 42.3958, -71.0967, 'approved', 1, ?, ?, ?)`,
  )
    .bind(listingId, options.ownerId, GIVERS_OWN_TITLE, GIVERS_OWN_STORY, now, now, now)
    .run();

  if (options.withCoverPhoto !== false) {
    const photoId = ulid();
    const thumbKey = `photos/${photoId}/thumb.jpg`;
    await env.DB.prepare(
      `INSERT INTO photos
        (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at)
       VALUES (?, ?, ?, 0, ?, ?, 800, 600, 12345, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 'image/jpeg', 'passed', ?)`,
    )
      .bind(photoId, options.ownerId, listingId, `photos/${photoId}/full.jpg`, thumbKey, now)
      .run();
    // Without a real object at the thumb key `suggestFromPhoto` short-circuits
    // to `{ suggestion: null, reason: "thumb_missing" }` and never reaches the
    // mocked AI — see backfillAspects.test.ts's note on the same trap.
    await env.BUCKET.put(thumbKey, new Uint8Array([0xff, 0xd8, 0xff]), { httpMetadata: { contentType: "image/jpeg" } });
  }

  return listingId;
}

/** The measured output of the #135 prompt on the real production photo. */
const SPOOL_SUGGESTION_JSON = JSON.stringify({
  subject: "Hand holding fishing line spool",
  markings: "SUPER POWER BRAIDED LINE 30 LBS 327 YDS KASTKING.COM",
  title: "Fishing line spool",
  category: "sports_outdoors",
  condition: "",
  aspects: [
    { name: "brand", value: "KastKing" },
    { name: "material", value: "braided line" },
    { name: "size", value: "30 lbs 327 yds" },
  ],
});

async function seedStaleAspect(listingId: string): Promise<void> {
  await env.DB.prepare("INSERT INTO listing_aspects (id, listing_id, name, value, position, created_at) VALUES (?, ?, 'material', 'braided', 0, ?)")
    .bind(ulid(), listingId, Date.now())
    .run();
}

async function listingRow(listingId: string): Promise<{ title: string; story: string; category: string; aspects_backfilled_at: number | null }> {
  const row = await env.DB.prepare("SELECT title, story, category, aspects_backfilled_at FROM listings WHERE id = ?")
    .bind(listingId)
    .first<{ title: string; story: string; category: string; aspects_backfilled_at: number | null }>();
  if (!row) throw new Error("listing vanished");
  return row;
}

async function aspectsOf(listingId: string): Promise<{ name: string; value: string }[]> {
  const { results } = await env.DB.prepare("SELECT name, value FROM listing_aspects WHERE listing_id = ? ORDER BY position")
    .bind(listingId)
    .all<{ name: string; value: string }>();
  return results;
}

function resuggest(listingId: string): Promise<Response> {
  return SELF.fetch(`http://x/api/admin/listings/${listingId}/resuggest`, { method: "POST", headers: adminHeaders() });
}

beforeEach(async () => {
  setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
  env.MOCK_AI = "0";
  // The suggest budget's global counter is keyed by kind + day, so it leaks
  // across tests sharing this file's isolated storage (see budget.test.ts).
  await env.KV.delete(`budget:suggest:${todayISO()}`);
});

describe("POST /api/admin/listings/:id/resuggest", () => {
  it("replaces a stale aspect and category with what the current prompt reads", async () => {
    mockSuggestAi(() => SPOOL_SUGGESTION_JSON);
    const listingId = await insertListing({ ownerId: await insertOwner() });
    await seedStaleAspect(listingId);

    const res = await resuggest(listingId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { applied: boolean; before: { category: string; aspects: unknown[] }; after: { category: string } } };

    expect(body.data.applied).toBe(true);
    // Before and after are both reported, because "the prompt improved" is a
    // claim an operator should be able to check per listing.
    expect(body.data.before.category).toBe("other");
    expect(body.data.before.aspects).toEqual([{ name: "material", value: "braided" }]);
    expect(body.data.after.category).toBe("sports_outdoors");

    expect(await aspectsOf(listingId)).toEqual([
      { name: "brand", value: "KastKing" },
      { name: "material", value: "braided line" },
      { name: "size", value: "30 lbs 327 yds" },
    ]);
    expect((await listingRow(listingId)).category).toBe("sports_outdoors");
  });

  /**
   * The promise this endpoint must not break. `privacy.html` tells a giver in
   * these words that the model's title is a starting point and "anything you
   * type over it wins"; an admin action that replaced their own title with a
   * model's would make that sentence false. The mocked suggestion above
   * carries the title "Fishing line spool" precisely so this can fail if the
   * route ever starts writing it.
   */
  it("GUARD: never touches the giver's own title or story", async () => {
    mockSuggestAi(() => SPOOL_SUGGESTION_JSON);
    const listingId = await insertListing({ ownerId: await insertOwner() });

    expect((await resuggest(listingId)).status).toBe(200);

    const row = await listingRow(listingId);
    expect(row.title).toBe(GIVERS_OWN_TITLE);
    expect(row.story).toBe(GIVERS_OWN_STORY);
  });

  /**
   * A failed vision call must leave the listing exactly as it was. Losing a
   * real aspect to a timeout would be strictly worse than keeping a stale
   * one, and "the model returned nothing" is a normal, expected outcome.
   */
  it("GUARD: writes nothing at all when the model returns nothing usable", async () => {
    mockSuggestAi(() => "not json, and not on the retry either");
    const listingId = await insertListing({ ownerId: await insertOwner() });
    await seedStaleAspect(listingId);

    const res = await resuggest(listingId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { applied: boolean; reason?: string } };
    expect(body.data.applied).toBe(false);
    expect(body.data.reason).toBeDefined();

    expect(await aspectsOf(listingId)).toEqual([{ name: "material", value: "braided" }]);
    const row = await listingRow(listingId);
    expect(row.category).toBe("other");
    expect(row.aspects_backfilled_at).toBeNull();
  });

  it("stamps aspects_backfilled_at, so #37's backfill won't take a second, dumber look", async () => {
    mockSuggestAi(() => SPOOL_SUGGESTION_JSON);
    const listingId = await insertListing({ ownerId: await insertOwner() });

    expect((await resuggest(listingId)).status).toBe(200);
    expect((await listingRow(listingId)).aspects_backfilled_at).toBeGreaterThan(0);
  });

  it("404s for a listing that doesn't exist", async () => {
    mockSuggestAi(() => SPOOL_SUGGESTION_JSON);
    expect((await resuggest(ulid())).status).toBe(404);
  });

  it("409s rather than 500s when the listing has no cover photo", async () => {
    mockSuggestAi(() => SPOOL_SUGGESTION_JSON);
    const listingId = await insertListing({ ownerId: await insertOwner(), withCoverPhoto: false });
    expect((await resuggest(listingId)).status).toBe(409);
  });

  it("requires the admin token, like every other route on this router", async () => {
    const listingId = await insertListing({ ownerId: await insertOwner() });
    const res = await SELF.fetch(`http://x/api/admin/listings/${listingId}/resuggest`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  /**
   * One re-suggestion is one real vision call, so it pays the same daily
   * ceiling live autofill does — an admin endpoint is not a way around the
   * budget that protects moderation's own headroom.
   */
  it("refuses once the shared suggest budget is spent", async () => {
    mockSuggestAi(() => SPOOL_SUGGESTION_JSON);
    const listingId = await insertListing({ ownerId: await insertOwner() });
    await env.KV.put(`budget:suggest:${todayISO()}`, "999999");

    const res = await resuggest(listingId);
    expect(res.status).toBe(429);
    // And still wrote nothing.
    expect(await aspectsOf(listingId)).toEqual([]);
  });
});
