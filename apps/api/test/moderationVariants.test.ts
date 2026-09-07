/**
 * #161 — the launch blocker: `PUT /api/photos` takes `full` and `thumb` as
 * two independent client-supplied files and stores both verbatim, the
 * moderation pipeline used to read only `r2_key_thumb`, and
 * `GET /i/:id/full` serves `r2_key_full` to the public once the listing is
 * approved. An attacker sent a coffee mug as the thumb and anything at all
 * as the full: one extra form field, no timing, no race, and
 * `moderation_events` recorded `verdict: pass` for the photo either way.
 *
 * The keeper version of the probe described in the issue. It does not
 * assert that the pipeline is *implemented* a particular way — it asserts
 * the two properties an attacker cares about:
 *
 *   1. the bytes stored under `r2_key_full` are handed to the vision model,
 *      byte for byte, as a data URI;
 *   2. a listing whose `full` variant is unsafe never reaches `approved`,
 *      even when its `thumb` is a perfectly innocent picture.
 *
 * To watch these fail, revert `moderation/pipeline.ts` to the thumb-only
 * SELECT (`SELECT id, r2_key_thumb FROM photos ...`) and its single
 * `moderateImage` call per photo.
 *
 * `MOCK_AI` is off for this whole file (`beforeEach`), so the real
 * `moderateImage`/`moderateListing` code paths run against a stubbed
 * `env.AI.run` — the same pattern `moderation.test.ts` uses.
 */
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MODELS } from "../src/models.js";
import { MODERATED_PHOTO_VARIANTS } from "../src/moderation/image.js";
import {
  authHeaders,
  fakeJpegBytes,
  freshOwnerToken,
  readOk,
  seedStandardPostalCodes,
  uploadPhoto,
  waitForListingStatus,
} from "./helpers.js";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import type { OwnerListing } from "@keepsake/contracts/listing";

const PASS_IMAGE_JSON = JSON.stringify({
  is_physical_object: true,
  nsfw: 0,
  violence: 0,
  weapons: 0,
  drugs: 0,
  hate_symbols: 0,
  personal_info: 0,
  notes: "a coffee mug",
});

/** Trips `decideImage`'s `drugs >= 0.7` auto-reject rule. */
const FLAG_IMAGE_JSON = JSON.stringify({
  ...(JSON.parse(PASS_IMAGE_JSON) as Record<string, unknown>),
  drugs: 0.95,
  notes: "the bytes nobody was looking at",
});

const VALID_LISTING_BODY = {
  title: "A quiet teacup",
  story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
  category: "home_kitchen",
  country: "US",
  postal_code: "02144",
  date_of_birth: "1990-01-01",
};

/**
 * Two byte sequences that no single source image could have produced — the
 * upload path never decodes either one, so this is exactly what the attack
 * in #161 looks like on the wire. Distinct *lengths* as well as contents so
 * a truncated or swapped read is visible in the assertion diff.
 */
function mismatchedVariantBytes(): { fullBytes: Uint8Array; thumbBytes: Uint8Array } {
  const fullBytes = fakeJpegBytes(64);
  fullBytes.fill(0xbd, 3);
  const thumbBytes = fakeJpegBytes(16);
  thumbBytes.fill(0x2a, 3);
  return { fullBytes, thumbBytes };
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface VisionCall {
  dataUri: string;
}

/**
 * Stubs `env.AI.run`, recording every `image_url` data URI the vision model
 * is actually handed. `imageResponse` is keyed on the base64 payload, so a
 * test can answer "safe" for one variant's bytes and "unsafe" for the
 * other's — which is the only way to tell "moderated both" apart from
 * "moderated one twice".
 */
function mockAiCapturing(imageResponse: (base64: string) => string): VisionCall[] {
  const calls: VisionCall[] = [];
  const run = async (model: string, input: unknown) => {
    if (model === MODELS.textGuard) return "safe";
    if (model !== MODELS.imageVision) throw new Error(`mockAiCapturing: unexpected model ${model}`);

    const messages = (input as { messages: { role: string; content: unknown }[] }).messages;
    const userTurn = messages.find((m) => m.role === "user");
    const parts = userTurn?.content as { type: string; image_url?: { url: string } }[];
    const dataUri = parts.find((p) => p.type === "image_url")?.image_url?.url ?? "";
    calls.push({ dataUri });
    return imageResponse(dataUri.slice(dataUri.indexOf(",") + 1));
  };
  env.AI.run = run as unknown as Ai["run"];
  return calls;
}

async function createListingWith(token: string, photoId: string): Promise<OwnerListing> {
  const res = await SELF.fetch("http://x/api/listings", {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID_LISTING_BODY, photo_ids: [photoId] }),
  });
  return readOk<OwnerListing>(res);
}

beforeEach(async () => {
  env.MOCK_AI = "0";
  await seedStandardPostalCodes();
});

describe("#161: every publicly served photo variant is moderated", () => {
  it("hands the full image's own bytes to the vision model, not only the thumb's", async () => {
    const { fullBytes, thumbBytes } = mismatchedVariantBytes();
    const calls = mockAiCapturing(() => PASS_IMAGE_JSON);

    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token, fullBytes, thumbBytes }));
    const listing = await createListingWith(token, photo.id);
    await waitForListingStatus(listing.id, (s) => s === "approved");

    const seen = calls.map((c) => c.dataUri);
    expect(seen).toHaveLength(MODERATED_PHOTO_VARIANTS.length);
    // The load-bearing assertion. Before the fix `seen` held exactly one
    // entry and it was the thumb's; the full bytes below — the ones
    // `GET /i/:id/full` publishes — had never been sent to any model.
    expect(seen).toContain(`data:image/jpeg;base64,${base64Of(thumbBytes)}`);
    expect(seen).toContain(`data:image/jpeg;base64,${base64Of(fullBytes)}`);
  });

  it("rejects a listing whose full image is unsafe even though its thumb passes", async () => {
    const { fullBytes, thumbBytes } = mismatchedVariantBytes();
    const thumbBase64 = base64Of(thumbBytes);
    // The attack from the issue, exactly: an innocent thumb for the model,
    // anything at all for the public.
    mockAiCapturing((base64) => (base64 === thumbBase64 ? PASS_IMAGE_JSON : FLAG_IMAGE_JSON));

    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token, fullBytes, thumbBytes }));
    const listing = await createListingWith(token, photo.id);

    const row = await waitForListingStatus(listing.id, (s) => s === "rejected");
    expect(row.moderation_reason).toBe("illegal_drugs");

    // ...and the unmoderated bytes are not reachable by the public, which
    // is the consequence the issue is actually about: before the fix this
    // listing was `approved` and `/i/:id/full` served 200.
    const publicFull = await SELF.fetch(`http://x/i/${photo.id}/full`);
    expect(publicFull.status).toBe(404);
  });

  it("still rejects when the *thumb* is the unsafe variant (the fix did not just swap which one is read)", async () => {
    const { fullBytes, thumbBytes } = mismatchedVariantBytes();
    const thumbBase64 = base64Of(thumbBytes);
    mockAiCapturing((base64) => (base64 === thumbBase64 ? FLAG_IMAGE_JSON : PASS_IMAGE_JSON));

    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token, fullBytes, thumbBytes }));
    const listing = await createListingWith(token, photo.id);

    const row = await waitForListingStatus(listing.id, (s) => s === "rejected");
    expect(row.moderation_reason).toBe("illegal_drugs");
  });

  it("logs one moderation_events row per variant, so the audit trail cannot claim bytes were seen that were not", async () => {
    const { fullBytes, thumbBytes } = mismatchedVariantBytes();
    mockAiCapturing(() => PASS_IMAGE_JSON);

    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token, fullBytes, thumbBytes }));
    const listing = await createListingWith(token, photo.id);
    await waitForListingStatus(listing.id, (s) => s === "approved");

    const events = await env.DB.prepare(
      "SELECT photo_id, flags_json FROM moderation_events WHERE listing_id = ? AND kind = 'image' ORDER BY created_at",
    )
      .bind(listing.id)
      .all<{ photo_id: string | null; flags_json: string | null }>();

    expect(events.results.map((e) => e.photo_id)).toEqual(MODERATED_PHOTO_VARIANTS.map(() => photo.id));
    expect(events.results.map((e) => (JSON.parse(e.flags_json ?? "{}") as { variant?: string }).variant)).toEqual([
      ...MODERATED_PHOTO_VARIANTS,
    ]);
  });

  it("a variant missing from R2 is an error, not a silent skip — the listing stays pending", async () => {
    mockAiCapturing(() => PASS_IMAGE_JSON);

    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
    const listing = await createListingWith(token, photo.id);
    await waitForListingStatus(listing.id, (s) => s === "approved");

    // Delete the full object out from under an already-approved photo and
    // re-run moderation as an edit would: fail-closed means "cannot read a
    // published variant" must never resolve to `approved`.
    const keys = await env.DB.prepare("SELECT r2_key_full FROM photos WHERE id = ?")
      .bind(photo.id)
      .first<{ r2_key_full: string }>();
    await env.BUCKET.delete(keys!.r2_key_full);
    await env.DB.prepare("UPDATE listings SET version = version + 1, status = 'pending' WHERE id = ?").bind(listing.id).run();

    const { moderateListing } = await import("../src/moderation/pipeline.js");
    const versionRow = await env.DB.prepare("SELECT version FROM listings WHERE id = ?")
      .bind(listing.id)
      .first<{ version: number }>();
    await moderateListing(env, listing.id, versionRow!.version);

    const row = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(listing.id).first<{ status: string }>();
    expect(row?.status).toBe("pending");

    const errorEvent = await env.DB.prepare(
      "SELECT reason FROM moderation_events WHERE listing_id = ? AND kind = 'image' AND verdict = 'error' ORDER BY created_at DESC LIMIT 1",
    )
      .bind(listing.id)
      .first<{ reason: string | null }>();
    expect(errorEvent?.reason).toBe("full_missing");
  });
});
