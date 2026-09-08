/**
 * Issue #171 — aspects were attacker-controlled free text that skipped both
 * text gates and published verbatim.
 *
 * `CreateListingInput.aspects` / `UpdateListingInput.aspects` take up to six
 * `{name ≤ 24, value ≤ 48}` pairs straight from the client. The give flow
 * forwards a model suggestion, but nothing ever required the values to have
 * come from the model — and `moderation/pipeline.ts` read only
 * `title`/`story`, both for the local `containsContactInfo` gate and for the
 * string handed to Llama Guard. So the same email address that auto-rejects
 * in the story was served to every stranger as an aspect value: a complete
 * bypass of the request/choose flow the whole product is built on.
 *
 * The control case below is what makes it unambiguous, and is kept from the
 * original audit: the *identical* string in the story and in an aspect, with
 * both now refused.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnerListing } from "@keepsake/contracts/listing";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import { MODELS } from "../src/models.js";
import { moderateListing } from "../src/moderation/pipeline.js";
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

const LEAKED_EMAIL = "seller99@keepsake.ing";

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

async function givenOnePhoto(token: string): Promise<string> {
  const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
  return photo.id;
}

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

describe("aspects are gated for contact info at the API boundary (issue #171)", () => {
  beforeEach(async () => {
    await seedStandardPostalCodes();
  });

  it("400s an email address hidden in an aspect value, and writes nothing", async () => {
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);

    const res = await createListing(token, [photoId], {
      aspects: [
        { name: "object", value: "teacup" },
        { name: "contact", value: LEAKED_EMAIL },
      ],
    });
    expect(res.status).toBe(400);
    expect((await readErr(res)).code).toBe("bad_request");

    // The 400 has to land above the insert, not after it — otherwise the
    // string is in `listing_aspects` regardless of what the caller was told.
    const leaked = await env.DB.prepare("SELECT COUNT(*) AS n FROM listing_aspects WHERE value = ?")
      .bind(LEAKED_EMAIL)
      .first<{ n: number }>();
    expect(leaked?.n).toBe(0);
    const photoRow = await env.DB.prepare("SELECT listing_id FROM photos WHERE id = ?")
      .bind(photoId)
      .first<{ listing_id: string | null }>();
    expect(photoRow?.listing_id).toBeNull();
  });

  it("400s a phone number in an aspect value", async () => {
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);

    const res = await createListing(token, [photoId], { aspects: [{ name: "whatsapp", value: "+1 617 555 0134" }] });
    expect(res.status).toBe(400);
  });

  it("400s a URL in an aspect value", async () => {
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);

    const res = await createListing(token, [photoId], { aspects: [{ name: "site", value: "https://buy-my-stuff.example" }] });
    expect(res.status).toBe(400);
  });

  it("checks the aspect NAME too, not only the value (24 chars is enough for a short URL)", async () => {
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);

    const res = await createListing(token, [photoId], { aspects: [{ name: "www.buy-stuff.example", value: "teacup" }] });
    expect(res.status).toBe(400);
  });

  it("control: the identical address in the story is rejected contact_in_story — same string, both fields", async () => {
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);

    const res = await createListing(token, [photoId], { story: `A lovely teacup. Write to me directly at ${LEAKED_EMAIL} about it.` });
    expect(res.status).toBe(201);
    const listing = await readOk<OwnerListing>(res);
    const row = await waitForListingStatus(listing.id, (status) => status === "rejected");
    expect(row.moderation_reason).toBe("contact_in_story");
  });

  it("PATCH is gated the same way, and leaves the listing's existing aspects alone", async () => {
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const listing = await readOk<OwnerListing>(
      await createListing(token, [photoId], { aspects: [{ name: "object", value: "teacup" }] }),
    );

    const res = await patchListing(listing.id, token, { aspects: [{ name: "contact", value: LEAKED_EMAIL }] });
    expect(res.status).toBe(400);

    const { results } = await env.DB.prepare("SELECT name, value FROM listing_aspects WHERE listing_id = ? ORDER BY position")
      .bind(listing.id)
      .all<{ name: string; value: string }>();
    expect(results).toEqual([{ name: "object", value: "teacup" }]);
  });

  it("an ordinary suggestion's aspects still go through untouched", async () => {
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);

    const res = await createListing(token, [photoId], {
      aspects: [
        { name: "object", value: "teapot" },
        { name: "material", value: "copper" },
        { name: "era", value: "1970s" },
      ],
    });
    expect(res.status).toBe(201);
    const listing = await readOk<OwnerListing>(res);
    expect(listing.aspects).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The pipeline's own half of the fix: aspects already in `listing_aspects`
// (a backfill, an older client, anything that didn't come through the two
// routes above) still have to reach both text gates. MOCK_AI off so the real
// `moderateText` path runs against a recording `env.AI.run`.
// ---------------------------------------------------------------------------
describe("moderateListing folds aspects into both text gates (issue #171)", () => {
  let textInputs: string[] = [];

  beforeEach(async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("MOCK_AI", "0");
    textInputs = [];
    const run = async (model: string, options: { messages?: { content: string }[] }) => {
      if (model === MODELS.textGuard) {
        textInputs.push(options.messages?.[0]?.content ?? "");
        return "safe";
      }
      return JSON.stringify({
        is_physical_object: true,
        nsfw: 0,
        violence: 0,
        weapons: 0,
        drugs: 0,
        hate_symbols: 0,
        personal_info: 0,
        notes: "",
      });
    };
    (env as unknown as Record<string, unknown>).AI = { run };
  });

  afterEach(() => setTestEnvVar("MOCK_AI", "1"));

  it("hands the aspect text to Llama Guard alongside the title and story", async () => {
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const listing = await readOk<OwnerListing>(
      await createListing(token, [photoId], {
        title: "A stoneware pitcher",
        aspects: [{ name: "material", value: "hand-thrown stoneware" }],
      }),
    );
    await waitForListingStatus(listing.id, (status) => status === "approved");

    // Matched by title rather than by index: a `waitUntil` moderation run
    // scheduled by an earlier test in this file can still be in flight when
    // this one starts recording, so "the call for *this* listing" is the
    // only stable thing to assert on.
    const input = textInputs.find((text) => text.includes("A stoneware pitcher"));
    expect(input).toBeDefined();
    expect(input).toContain("hand-thrown stoneware");
  });

  it("rejects contact_in_story for an aspect row that reached the DB without passing the route gate", async () => {
    const token = freshOwnerToken();
    const photoId = await givenOnePhoto(token);
    const listing = await readOk<OwnerListing>(await createListing(token, [photoId]));
    await waitForListingStatus(listing.id, (status) => status === "approved");

    // Written straight into the table, the way a backfill or an older client
    // would — deliberately bypassing the route gate this file also covers.
    await env.DB.prepare("INSERT INTO listing_aspects (id, listing_id, name, value, position, created_at) VALUES (?, ?, ?, ?, 0, ?)")
      .bind(`asp${listing.id}`, listing.id, "contact", LEAKED_EMAIL, Date.now())
      .run();

    await moderateListing(env, listing.id, listing.version);

    const row = await env.DB.prepare("SELECT status, moderation_reason FROM listings WHERE id = ?")
      .bind(listing.id)
      .first<{ status: string; moderation_reason: string | null }>();
    expect(row?.status).toBe("rejected");
    expect(row?.moderation_reason).toBe("contact_in_story");
  });
});
