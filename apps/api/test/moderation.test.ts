import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Capture from "@keepsake/observability/capture";
import { decide, decideImage, decideText } from "../src/moderation/decide.js";
import { parseTextVerdict } from "../src/moderation/text.js";
import { moderateListing } from "../src/moderation/pipeline.js";
import { MODERATED_PHOTO_VARIANTS } from "../src/moderation/image.js";
import { todayISO } from "../src/moderation/budget.js";
import { moderationRetry } from "../src/cron/moderationRetry.js";
import { MODELS } from "../src/models.js";
import { ulid } from "../src/lib/ids.js";
import {
  authHeaders,
  freshOwnerToken,
  insertOwner,
  readOk,
  seedStandardPostalCodes,
  setTestEnvVar,
  uploadPhoto,
  waitFor,
  waitForListingStatus,
} from "./helpers.js";
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

  // Issue #280: a text verdict of "unsafe" with no parsable S-codes must not
  // fail open. An empty `codes` array is a distinct thing from an *unmapped*
  // code (the S99 case above) — here nothing could be extracted at all, so
  // there is no code to check membership on. Falling through to "pass" was
  // the bug: it made this indistinguishable from a genuinely safe verdict.
  it("unsafe with no parsable codes -> error, not pass (#280 fail-open)", () => {
    expect(decideText({ verdict: "unsafe", codes: [] })).toBe("error");
  });
});

// Issue #280. Direct unit tests of the parsing rule, independent of the AI
// call — `parseTextVerdict`'s own doc comment says it is exported for this.
describe("parseTextVerdict", () => {
  it('parses "safe"', () => {
    expect(parseTextVerdict("safe")).toEqual({ verdict: "safe" });
  });

  it('parses "unsafe" followed by S-codes', () => {
    expect(parseTextVerdict("unsafe\nS12")).toEqual({ verdict: "unsafe", codes: ["S12"] });
  });

  // The deliberate fallback #280 is about: a bare "unsafe" with no category
  // line still parses as unsafe (not "error"), with an empty codes array —
  // it is `decideText`'s job, not the parser's, to treat that as fail-closed.
  it('parses a bare "unsafe" with no category line as unsafe with empty codes', () => {
    expect(parseTextVerdict("unsafe")).toEqual({ verdict: "unsafe", codes: [] });
  });

  it("empty input is an error", () => {
    expect(parseTextVerdict("")).toBe("error");
  });

  it("unrecognised text is an error", () => {
    expect(parseTextVerdict("banana")).toBe("error");
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

  // Issue #280: an unsafe verdict with no parsable codes must hold for a
  // human, the same as any other AI ambiguity — not fall through to approved.
  it("unsafe with no parsable codes -> pending, fail-closed (#280)", () => {
    expect(decide({ verdict: "unsafe", codes: [] }, [imageVerdict({})])).toEqual({ status: "pending" });
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
  date_of_birth: "1990-01-01",
  // Required since the give flow stopped offering a "Skip" on its email
  // step: `POST /api/listings` refuses a first listing with no way back to
  // its giver (neither the body nor the owner row carrying an address).
  email: "giver@keepsake.ing",
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

  // Issue #280: a bare "unsafe" with no category line — the fallback
  // `parseTextVerdict` deliberately preserves — must not fail open into an
  // approved listing.
  it("bare text 'unsafe' with no category line -> stays pending, not approved (#280)", async () => {
    mockAi({ text: () => "unsafe" });
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);

    await waitForAttempt1(listing.id);
    const row = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(listing.id).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  // Same bug, the structured-JSON shape: `{"safe": false}` with no
  // `categories` field is the other input `text.ts`'s header says the model
  // can return.
  it("structured {safe:false} with no categories -> stays pending, not approved (#280)", async () => {
    mockAi({ text: () => ({ response: { safe: false } }) });
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);

    await waitForAttempt1(listing.id);
    const row = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(listing.id).first<{ status: string }>();
    expect(row?.status).toBe("pending");
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

    const imageEvents = await env.DB.prepare(
      "SELECT verdict, flags_json FROM moderation_events WHERE listing_id = ? AND kind = 'image' ORDER BY created_at",
    )
      .bind(listing.id)
      .all<{ verdict: string; flags_json: string | null }>();
    // One photo -> one logged image verdict *per moderated variant* (#161),
    // each after its own internal retry. This assertion read `toHaveLength(1)`
    // while the pipeline looked at the thumb alone.
    expect(imageEvents.results).toHaveLength(MODERATED_PHOTO_VARIANTS.length);
    expect(imageEvents.results.map((e) => e.verdict)).toEqual(MODERATED_PHOTO_VARIANTS.map(() => "pass"));
    expect(imageEvents.results.map((e) => (JSON.parse(e.flags_json ?? "{}") as { variant?: string }).variant)).toEqual([
      ...MODERATED_PHOTO_VARIANTS,
    ]);
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

  // Issue #18: the listing row itself must carry the truth (not only the
  // moderation-event log), since `GET /api/me/listings(/:id)` reads
  // `moderation_reason` off the listing for every status.
  it("MOD_IMAGE_DAILY_BUDGET exhausted -> persists moderation_reason='budget' on the listing row", async () => {
    mockAi({});
    setTestEnvVar("MOD_IMAGE_DAILY_BUDGET", "0");
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);

    await waitForAttempt1(listing.id);
    const row = await env.DB.prepare("SELECT status, moderation_reason FROM listings WHERE id = ?")
      .bind(listing.id)
      .first<{ status: string; moderation_reason: string | null }>();
    expect(row?.status).toBe("pending");
    expect(row?.moderation_reason).toBe("budget");

    setTestEnvVar("MOD_IMAGE_DAILY_BUDGET", "3000");
  });

  describe("capture alert on exhaustion", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      setTestEnvVar("MOD_IMAGE_DAILY_BUDGET", "3000");
    });

    it("fires once per UTC day, not once per denied listing", async () => {
      mockAi({});
      setTestEnvVar("MOD_IMAGE_DAILY_BUDGET", "0");
      // The "already alerted today" flag is keyed only by kind + calendar
      // day (`alertBudgetExhaustedOnce`, `moderation/pipeline.ts`), so it
      // persists in this file's shared KV across the earlier budget-gate
      // tests above, which also exhaust MOD_IMAGE_DAILY_BUDGET. Clear it
      // first so this test observes its own first-alert, not a flag one of
      // them already set today.
      await env.KV.delete(`budget:alerted:mod_image:${todayISO()}`);
      const captureMessageSpy = vi.spyOn(Capture, "captureMessage");

      const tokenA = freshOwnerToken();
      const listingA = await createListingWithOnePhoto(tokenA);
      await waitForAttempt1(listingA.id);
      expect(captureMessageSpy).toHaveBeenCalledTimes(1);
      const [message] = captureMessageSpy.mock.calls[0] ?? [];
      expect(message).toContain("mod_image");

      // A second, independent listing hits the same exhausted budget the
      // same day — no second alert, so a filling queue doesn't also become
      // a paging storm.
      const tokenB = freshOwnerToken();
      const listingB = await createListingWithOnePhoto(tokenB);
      await waitForAttempt1(listingB.id);
      expect(captureMessageSpy).toHaveBeenCalledTimes(1);
    });
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


  // Issue #179. The audit's repro, kept as a test: with the image budget at
  // 0, three cron passes used to spend all three attempts (a denial writes a
  // `decision`/`error` event and `nextAttemptNumber` counted those), so a
  // budget exhausted at 10:00 UTC turned every listing posted for the next
  // fourteen hours into `needs_review` about fifteen minutes after it was
  // posted — a status the cron never selects again, so the midnight reset
  // freed nothing and each one became manual work forever.
  it("an exhausted budget does not burn the 3 attempts: still pending after three passes, decided after the reset", async () => {
    mockAi({}); // would approve, if the budget ever let the pipeline reach it
    setTestEnvVar("MOD_IMAGE_DAILY_BUDGET", "0");
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);
    // The create-triggered run is denial #1.
    await waitForAttempt1(listing.id);

    for (let i = 0; i < 3; i++) {
      await env.DB.prepare("UPDATE listings SET updated_at = ? WHERE id = ?")
        .bind(Date.now() - 3 * 60 * 1000, listing.id)
        .run();
      await moderationRetry(env);
    }

    const denied = await env.DB.prepare("SELECT status, moderation_reason FROM listings WHERE id = ?")
      .bind(listing.id)
      .first<{ status: string; moderation_reason: string | null }>();
    expect(denied?.status, "a budget denial must not escalate the listing").toBe("pending");
    expect(denied?.moderation_reason).toBe("budget");

    // Every denial is still logged — the owner-facing reason and the audit
    // trail both depend on it — but none of them advanced the counter.
    const events = await env.DB.prepare(
      "SELECT attempt, verdict, reason FROM moderation_events WHERE listing_id = ? AND kind = 'decision' ORDER BY created_at",
    )
      .bind(listing.id)
      .all<{ attempt: number; verdict: string; reason: string | null }>();
    expect(events.results.length, "the denials are recorded, not silent").toBeGreaterThanOrEqual(4);
    expect(events.results.every((event) => event.reason === "budget")).toBe(true);
    expect(events.results.map((event) => event.attempt)).toEqual(events.results.map(() => 1));

    // Midnight UTC: the ceiling resets. The next cron pass must be able to
    // make a real attempt — this is the half that was permanently lost.
    setTestEnvVar("MOD_IMAGE_DAILY_BUDGET", "3000");
    await env.DB.prepare("UPDATE listings SET updated_at = ? WHERE id = ?")
      .bind(Date.now() - 3 * 60 * 1000, listing.id)
      .run();
    await moderationRetry(env);

    const afterReset = await env.DB.prepare("SELECT status, moderation_reason FROM listings WHERE id = ?")
      .bind(listing.id)
      .first<{ status: string; moderation_reason: string | null }>();
    expect(afterReset?.status, "after the reset the listing must actually get moderated").toBe("approved");
    expect(afterReset?.moderation_reason).toBeNull();
  });

  // The other side of the same coin: an AI error must still escalate, so the
  // fix above cannot be "nothing ever escalates now". The test above this one
  // covers the escalation path itself; this asserts the two reasons are told
  // apart rather than both being exempt.
  it("an AI error still counts, even after budget denials on the same listing", async () => {
    mockAi({
      image: () => {
        throw new Error("simulated persistent Workers AI outage");
      },
    });
    setTestEnvVar("MOD_IMAGE_DAILY_BUDGET", "0");
    const token = freshOwnerToken();
    const listing = await createListingWithOnePhoto(token);
    await waitForAttempt1(listing.id);

    // Two budget denials first — they must leave the counter where it was.
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare("UPDATE listings SET updated_at = ? WHERE id = ?")
        .bind(Date.now() - 3 * 60 * 1000, listing.id)
        .run();
      await moderationRetry(env);
    }

    setTestEnvVar("MOD_IMAGE_DAILY_BUDGET", "3000");
    for (let i = 0; i < 4; i++) {
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
      "SELECT attempt FROM moderation_events WHERE listing_id = ? AND kind = 'decision' AND (reason IS NULL OR reason <> 'budget') ORDER BY created_at",
    )
      .bind(listing.id)
      .all<{ attempt: number }>();
    // Three real attempts, then the escalation event as attempt 4 — the
    // budget denials in between changed none of it.
    expect(attempts.results.map((a) => a.attempt)).toEqual([1, 2, 3, 4]);
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

  // Issue: an estate's bulk submission produces dozens of pending listings
  // with near-identical `updated_at`, so a plain FIFO `LIMIT 50` occupies
  // most or all of a pass with one owner's rows — `docs/design/
  // bulk-upload.md`'s "What is not paced". These insert `listings` rows
  // directly (`insertOwner` + a hand-rolled pending row, no photos) rather
  // than going through the create endpoint: what's under test is the cron's
  // *selection*, not the moderation outcome, and a bare-story listing with no
  // photos still runs the full pipeline (text only, since `photos.length` is
  // 0) and reaches a real terminal status under `mockAi({})`.
  describe("per-owner fairness cap", () => {
    async function insertPendingListing(ownerId: string, updatedAt: number): Promise<string> {
      const id = ulid();
      await env.DB.prepare(
        `INSERT INTO listings
          (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
           status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`,
      )
        .bind(
          id,
          ownerId,
          "A quiet teacup",
          "This belonged to a dear friend of the family, and I'd love for it to find a new home.",
          "home_kitchen",
          "US",
          "02144",
          "Somerville",
          "MA",
          42.3958,
          -71.0967,
          updatedAt,
          updatedAt,
        )
        .run();
      return id;
    }

    async function pendingCount(ownerId: string): Promise<number> {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM listings WHERE owner_id = ? AND status = 'pending'")
        .bind(ownerId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    }

    it("one owner's 42-item estate does not crowd an ordinary giver's stuck listing out of the pass", async () => {
      mockAi({}); // every one of these approves once it actually runs
      const stale = Date.now() - 3 * 60 * 1000;

      const bulkOwner = await insertOwner();
      // Oldest-first, exactly like a real bulk submission: every item goes
      // stale within the same cron tick, near-identical `updated_at`.
      for (let i = 0; i < 42; i++) {
        await insertPendingListing(bulkOwner, stale - (42 - i));
      }

      // Newer than every estate row, so a plain FIFO `ORDER BY updated_at
      // ASC LIMIT 50` would reach it this pass regardless (42 < 50) — the
      // real test is that it is *not* left to chance once the estate is
      // bigger than a pass, which the next test covers. This one pins the
      // ordinary case: the estate must not eat the whole batch even when it
      // technically could fit.
      const ordinaryOwner = await insertOwner();
      const ordinaryListingId = await insertPendingListing(ordinaryOwner, stale);

      await moderationRetry(env);

      const ordinaryRow = await env.DB.prepare("SELECT status FROM listings WHERE id = ?")
        .bind(ordinaryListingId)
        .first<{ status: string }>();
      expect(ordinaryRow?.status, "the ordinary giver's listing got its turn").not.toBe("pending");

      // The estate lost at most MAX_PER_OWNER_PER_PASS (10) rows this pass —
      // it did not get to monopolize the batch just because it fit.
      expect(await pendingCount(bulkOwner)).toBe(32); // 42 - 10
    });

    it("an estate larger than one pass does not starve a second owner whose oldest row it would otherwise outrank", async () => {
      mockAi({});
      const stale = Date.now() - 3 * 60 * 1000;

      // 60 items — bigger than BATCH_SIZE (50) — all older than the second
      // owner's single row, so an uncapped FIFO pass would fill entirely
      // from this one owner and never reach the other at all.
      const bulkOwner = await insertOwner();
      for (let i = 0; i < 60; i++) {
        await insertPendingListing(bulkOwner, stale - (200 - i));
      }
      const otherOwner = await insertOwner();
      const otherListingId = await insertPendingListing(otherOwner, stale - 1);

      await moderationRetry(env);

      const otherRow = await env.DB.prepare("SELECT status FROM listings WHERE id = ?")
        .bind(otherListingId)
        .first<{ status: string }>();
      expect(otherRow?.status, "the second owner's older-than-most, but not oldest, row still got picked").not.toBe("pending");
      expect(await pendingCount(bulkOwner)).toBe(50); // 60 - 10
    });

    it("a capped owner's backlog fully drains across subsequent passes rather than being permanently deprioritised", async () => {
      mockAi({});
      const owner = await insertOwner();
      const stale = Date.now() - 3 * 60 * 1000;
      for (let i = 0; i < 25; i++) {
        await insertPendingListing(owner, stale - (25 - i));
      }

      await moderationRetry(env);
      expect(await pendingCount(owner)).toBe(15); // 25 - 10

      // Re-stage the remainder past the staleness window, exactly like a
      // real 5-minute cron tick would see them next time.
      await env.DB.prepare("UPDATE listings SET updated_at = ? WHERE owner_id = ? AND status = 'pending'")
        .bind(stale, owner)
        .run();
      await moderationRetry(env);
      expect(await pendingCount(owner)).toBe(5); // 15 - 10

      await env.DB.prepare("UPDATE listings SET updated_at = ? WHERE owner_id = ? AND status = 'pending'")
        .bind(stale, owner)
        .run();
      await moderationRetry(env);
      expect(await pendingCount(owner), "fully drained — not stuck behind its own cap forever").toBe(0);
    });
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
