import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { decide, decideImage, decideText } from "../src/moderation/decide.js";
import { moderateListing } from "../src/moderation/pipeline.js";
import { moderationRetry } from "../src/cron/moderationRetry.js";
import { MODELS } from "../src/models.js";
import { authHeaders, freshOwnerToken, readOk, seedStandardPostalCodes, setTestEnvVar, uploadPhoto, waitFor, waitForListingStatus } from "./helpers.js";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import type { OwnerListing } from "@keepsake/contracts/listing";
import type { ImageVerdict } from "@keepsake/contracts/admin";

// ---------------------------------------------------------------------------
// Pure decide.ts unit tests — the minimal-list mapping, no I/O.
// ---------------------------------------------------------------------------
describe("decideText", () => {
  it("safe -> pass", () => {
    expect(decideText({ verdict: "safe" })).toBe("pass");
  });

  it("unsafe S12 (sexual content) -> review, not flag", () => {
    expect(decideText({ verdict: "unsafe", codes: ["S12"] })).toBe("review");
  });

  it("unsafe S4 (child exploitation) -> flag", () => {
    expect(decideText({ verdict: "unsafe", codes: ["S4"] })).toBe("flag");
  });

  it("error stays error", () => {
    expect(decideText("error")).toBe("error");
  });

  it("an unmapped S-code (not in either list) is treated as pass", () => {
    expect(decideText({ verdict: "unsafe", codes: ["S99"] })).toBe("pass");
  });
});

describe("decideImage", () => {
  it("drugs >= 0.7 -> flag", () => {
    expect(decideImage(imageVerdict({ drugs: 0.9 }))).toBe("flag");
  });

  it("drugs just under 0.7 -> pass", () => {
    expect(decideImage(imageVerdict({ drugs: 0.69 }))).toBe("pass");
  });

  it("is_physical_object: false -> flag", () => {
    expect(decideImage(imageVerdict({ is_physical_object: false }))).toBe("flag");
  });

  it("nsfw >= 0.5 -> review", () => {
    expect(decideImage(imageVerdict({ nsfw: 0.55 }))).toBe("review");
  });

  it("error stays error", () => {
    expect(decideImage("error")).toBe("error");
  });
});

describe("decide (combining text + images)", () => {
  it("all pass -> approved", () => {
    expect(decide({ verdict: "safe" }, [imageVerdict({})])).toEqual({ status: "approved" });
  });

  it("any error (text or image) -> pending, fail-closed", () => {
    expect(decide("error", [imageVerdict({})])).toEqual({ status: "pending" });
    expect(decide({ verdict: "safe" }, ["error"])).toEqual({ status: "pending" });
  });

  it("text flag wins over an image error would not apply — flag is checked, but an error anywhere still short-circuits to pending first", () => {
    // Explicit ordering check: `decide` treats "any error" as the very first
    // gate, ahead of "any flag" — an image error must not be masked by an
    // unrelated text flag.
    expect(decide({ verdict: "unsafe", codes: ["S4"] }, ["error"])).toEqual({ status: "pending" });
  });

  it("text S4 -> rejected sexual_content_minors", () => {
    expect(decide({ verdict: "unsafe", codes: ["S4"] }, [imageVerdict({})])).toEqual({
      status: "rejected",
      reason: "sexual_content_minors",
    });
  });

  it("image drugs flag -> rejected illegal_drugs", () => {
    expect(decide({ verdict: "safe" }, [imageVerdict({ drugs: 0.9 })])).toEqual({ status: "rejected", reason: "illegal_drugs" });
  });

  it("image not-an-object -> rejected not_an_object", () => {
    expect(decide({ verdict: "safe" }, [imageVerdict({ is_physical_object: false })])).toEqual({
      status: "rejected",
      reason: "not_an_object",
    });
  });

  it("review with no flag -> needs_review", () => {
    expect(decide({ verdict: "unsafe", codes: ["S12"] }, [imageVerdict({})])).toEqual({ status: "needs_review" });
  });
});

function imageVerdict(overrides: Partial<ImageVerdict>): ImageVerdict {
  return {
    is_physical_object: true,
    nsfw: 0,
    violence: 0,
    weapons: 0,
    drugs: 0,
    hate_symbols: 0,
    personal_info: 0,
    notes: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pipeline integration — real moderateText/moderateImage code paths against
// a mocked env.AI.run, MOCK_AI flipped off for this whole file.
// ---------------------------------------------------------------------------

const SAFE_TEXT_RESPONSE = "safe";
const PASS_IMAGE_JSON = JSON.stringify({
  is_physical_object: true,
  nsfw: 0,
  violence: 0,
  weapons: 0,
  drugs: 0,
  hate_symbols: 0,
  personal_info: 0,
  notes: "",
});

function mockAi(handlers: { text?: () => unknown; image?: (callIndex: number) => unknown }): void {
  let imageCallIndex = 0;
  const run = async (model: string) => {
    if (model === MODELS.textGuard) {
      return handlers.text ? handlers.text() : SAFE_TEXT_RESPONSE;
    }
    if (model === MODELS.imageVision) {
      const result = handlers.image ? handlers.image(imageCallIndex) : PASS_IMAGE_JSON;
      imageCallIndex += 1;
      return result;
    }
    throw new Error(`mockAi: unexpected model ${model}`);
  };
  env.AI.run = run as unknown as Ai["run"];
}

const VALID_LISTING_BODY = {
  title: "A quiet teacup",
  story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
  category: "home_kitchen",
  country: "US",
  postal_code: "02144",
  age_attested: true,
};

async function createListingWithOnePhoto(token: string, overrides: Record<string, unknown> = {}): Promise<OwnerListing> {
  const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
  const res = await SELF.fetch("http://x/api/listings", {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID_LISTING_BODY, photo_ids: [photo.id], ...overrides }),
  });
  return readOk<OwnerListing>(res);
}

async function decisionEventCount(listingId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM moderation_events WHERE listing_id = ? AND kind = 'decision'")
    .bind(listingId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Waits for the create call's own `waitUntil(moderateListing(...))` (attempt
 * 1) to finish logging its decision event, so a test that then drives
 * further attempts explicitly (the cron tests) starts from a known attempt
 * count instead of racing that first background run. */
async function waitForAttempt1(listingId: string): Promise<void> {
  await waitFor(async () => ((await decisionEventCount(listingId)) >= 1 ? true : undefined));
}

beforeEach(async () => {
  env.MOCK_AI = "0";
  await seedStandardPostalCodes();
});

describe("moderateListing: text outcomes", () => {
  it("a story with a phone number is rejected contact_in_story before any AI call runs", async () => {
    mockAi({
      text: () => {
        throw new Error("must not call the text model for a contact_in_story rejection");
      },
    });
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token, { story: "Call me anytime at 617-555-0134 about this teacup!" });

    const row = await waitForListingStatus(listing.id, (s) => s === "rejected");
    expect(row.moderation_reason).toBe("contact_in_story");
  });

  it("text unsafe S12 -> needs_review (held, invisible)", async () => {
    mockAi({ text: () => "unsafe\nS12" });
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);

    const row = await waitForListingStatus(listing.id, (s) => s === "needs_review");
    expect(row.moderation_reason).toBe("held_for_review");

    const publicRes = await SELF.fetch(`http://x/api/listings/${listing.id}`);
    expect(publicRes.status).toBe(404);
  });

  it("text unsafe S4 -> rejected", async () => {
    mockAi({ text: () => "unsafe\nS4" });
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);

    const row = await waitForListingStatus(listing.id, (s) => s === "rejected");
    expect(row.moderation_reason).toBe("sexual_content_minors");
  });
});

describe("moderateListing: image outcomes", () => {
  it("drugs: 0.9 -> rejected illegal_drugs", async () => {
    mockAi({ image: () => JSON.stringify({ ...JSON.parse(PASS_IMAGE_JSON), drugs: 0.9 }) });
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);

    const row = await waitForListingStatus(listing.id, (s) => s === "rejected");
    expect(row.moderation_reason).toBe("illegal_drugs");
  });

  it("nsfw: 0.55 -> needs_review", async () => {
    mockAi({ image: () => JSON.stringify({ ...JSON.parse(PASS_IMAGE_JSON), nsfw: 0.55 }) });
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);

    const row = await waitForListingStatus(listing.id, (s) => s === "needs_review");
    expect(row.moderation_reason).toBe("held_for_review");
  });

  it("is_physical_object: false -> rejected not_an_object", async () => {
    mockAi({ image: () => JSON.stringify({ ...JSON.parse(PASS_IMAGE_JSON), is_physical_object: false }) });
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);

    const row = await waitForListingStatus(listing.id, (s) => s === "rejected");
    expect(row.moderation_reason).toBe("not_an_object");
  });

  it("malformed JSON once, then a valid parse on the single retry -> approved", async () => {
    mockAi({ image: (callIndex) => (callIndex === 0 ? "not json at all {" : PASS_IMAGE_JSON) });
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);

    const row = await waitForListingStatus(listing.id, (s) => s === "approved");
    expect(row.published_at).not.toBeNull();

    const imageEvents = await env.DB.prepare("SELECT verdict FROM moderation_events WHERE listing_id = ? AND kind = 'image' ORDER BY created_at")
      .bind(listing.id)
      .all<{ verdict: string }>();
    expect(imageEvents.results).toHaveLength(1); // one photo -> one logged image verdict, after the internal retry
    expect(imageEvents.results[0]?.verdict).toBe("pass");
  });

  it("malformed JSON twice -> stays pending with an error event, no approval", async () => {
    mockAi({ image: () => "still not json {{{" });
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);

    await waitForAttempt1(listing.id);

    const row = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(listing.id).first<{ status: string }>();
    expect(row?.status).toBe("pending");

    const decisionEvent = await env.DB.prepare(
      "SELECT verdict FROM moderation_events WHERE listing_id = ? AND kind = 'decision' ORDER BY created_at DESC LIMIT 1",
    )
      .bind(listing.id)
      .first<{ verdict: string }>();
    expect(decisionEvent?.verdict).toBe("error");
  });

  it("AI.run throwing -> stays pending", async () => {
    mockAi({
      image: () => {
        throw new Error("simulated Workers AI outage");
      },
    });
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);

    await waitForAttempt1(listing.id);
    const row = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(listing.id).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });
});

describe("moderateListing: budget gate", () => {
  it("MOD_IMAGE_DAILY_BUDGET exhausted -> stays pending with a budget error event", async () => {
    mockAi({}); // would pass if it ever ran
    setTestEnvVar("MOD_IMAGE_DAILY_BUDGET", "0");
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);

    await waitForAttempt1(listing.id);
    const row = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(listing.id).first<{ status: string }>();
    expect(row?.status).toBe("pending");

    const event = await env.DB.prepare(
      "SELECT verdict, reason FROM moderation_events WHERE listing_id = ? AND kind = 'decision' ORDER BY created_at DESC LIMIT 1",
    )
      .bind(listing.id)
      .first<{ verdict: string; reason: string | null }>();
    expect(event?.verdict).toBe("error");
    expect(event?.reason).toBe("budget");

    setTestEnvVar("MOD_IMAGE_DAILY_BUDGET", "3000");
  });
});

describe("moderateListing: version guard", () => {
  it("a stale version's pipeline run never approves the listing's current (bumped) version", async () => {
    mockAi({});
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);
    // Wait for the version-1 run to actually finish before we simulate the
    // race, so we're testing the guard, not a fluke of ordering.
    await waitForListingStatus(listing.id, (s) => s === "approved");

    // Simulate an edit racing a slow retry: bump the DB's version to 2
    // directly, then invoke moderateListing for the now-stale version 1.
    await env.DB.prepare("UPDATE listings SET version = 2, status = 'pending', updated_at = ? WHERE id = ?")
      .bind(Date.now(), listing.id)
      .run();

    await moderateListing(env, listing.id, 1);

    const row = await env.DB.prepare("SELECT status, version FROM listings WHERE id = ?")
      .bind(listing.id)
      .first<{ status: string; version: number }>();
    expect(row?.version).toBe(2);
    expect(row?.status).toBe("pending"); // untouched by the stale version-1 run
  });
});

describe("moderationRetry cron", () => {
  it("escalates a listing stuck in pending to needs_review after 3 failed attempts", async () => {
    mockAi({
      image: () => {
        throw new Error("simulated persistent Workers AI outage");
      },
    });
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);
    // Attempt 1 already ran from the create call above — wait for it to
    // finish logging before driving the next 3 explicitly, so this test
    // isn't racing that background run for who logs "attempt 1".
    await waitForAttempt1(listing.id);

    // Backdate `updated_at` past the cron's 2-minute staleness window before
    // each subsequent attempt, exactly like a real 5-minute cron tick would
    // see it.
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare("UPDATE listings SET updated_at = ? WHERE id = ?")
        .bind(Date.now() - 3 * 60 * 1000, listing.id)
        .run();
      await moderationRetry(env);
    }

    const row = await env.DB.prepare("SELECT status, moderation_reason FROM listings WHERE id = ?")
      .bind(listing.id)
      .first<{ status: string; moderation_reason: string | null }>();
    expect(row?.status).toBe("needs_review");
    expect(row?.moderation_reason).toBe("held_for_review");

    const attempts = await env.DB.prepare(
      "SELECT attempt, verdict FROM moderation_events WHERE listing_id = ? AND kind = 'decision' ORDER BY attempt",
    )
      .bind(listing.id)
      .all<{ attempt: number; verdict: string }>();
    expect(attempts.results.map((a) => a.attempt)).toEqual([1, 2, 3, 4]);
    expect(attempts.results[3]?.verdict).toBe("needs_review");
  });

  it("does not touch a listing that isn't stale yet", async () => {
    mockAi({
      image: () => {
        throw new Error("simulated outage");
      },
    });
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);
    await waitForAttempt1(listing.id);
    // updated_at is "now" (just created) — well within the 2-minute window.
    await moderationRetry(env);

    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM moderation_events WHERE listing_id = ? AND kind = 'decision'")
      .bind(listing.id)
      .first<{ n: number }>();
    // Exactly the one decision event from the original create-triggered run —
    // the cron pass shouldn't have added a second.
    expect(events?.n).toBe(1);
  });
});

describe("self-harm is held, never auto-rejected", () => {
  it("routes S11 to needs_review rather than rejected or approved", () => {
    // Verified live 2026-09-06: llama-guard-3-8b returns "unsafe\nS11" for
    // self-harm language, and S11 used to fall through decideText to "pass".
    expect(decideText({ verdict: "unsafe", codes: ["S11"] })).toBe("review");
    expect(decide({ verdict: "unsafe", codes: ["S11"] }, [])).toEqual({
      status: "needs_review",
    });
  });
});
