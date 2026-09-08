/**
 * `GET /og/item/:id/card.png` — the share card route.
 *
 * The assertions here are deliberately about the **artifact**, not about
 * status codes: a route that returns 200 with a broken image is the exact
 * failure this feature has, because the only consumer is a crawler that never
 * complains. So the tests decode the JPEG's SOF header to check the real
 * pixel dimensions, and compare bytes across renders rather than trusting
 * that a fingerprint "should have" changed.
 *
 * What this file structurally CANNOT catch is `/og/*` missing from
 * `[env.production.assets] run_worker_first` — miniflare ignores the setting,
 * so the route answers here regardless. `test/robotsConfig.test.ts` asserts
 * that separately, for the reason its own header explains.
 */
import { decode as decodeJpeg } from "jpeg-js";
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ulid } from "../src/lib/ids.js";
import { authHeaders, freshClientIp, freshOwnerToken, insertApprovedListing, insertOwner, realJpegBytes } from "./helpers";
import { sha256Hex } from "../src/lib/digest.js";

const CARD_PATH = (id: string) => `http://x/og/item/${id}/card.png`;

function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(url, { headers: { "CF-Connecting-IP": freshClientIp(), ...headers } });
}

/**
 * Reads the frame dimensions out of a JPEG's SOF marker.
 *
 * Walks the marker chain rather than reading a fixed offset — the encoder
 * puts its own segments ahead of the frame header, and a fixed offset would
 * pass on this fixture while being wrong about every real file.
 */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2; // skip SOI
  while (at < bytes.length) {
    if (view.getUint8(at) !== 0xff) throw new Error(`not a marker at ${at}`);
    const marker = view.getUint8(at + 1);
    const length = view.getUint16(at + 2);
    // SOF0/1/2 (baseline, extended, progressive) carry the frame dimensions.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    }
    at += 2 + length;
  }
  throw new Error("no SOF marker");
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

interface SeedOptions {
  status?: "approved" | "given" | "pending" | "hidden" | "withdrawn" | "rejected";
  title?: string;
  contentType?: string;
  photoBytes?: Uint8Array;
  withPhoto?: boolean;
}

/**
 * An approved listing with a real photo in R2. Bypasses the upload route on
 * purpose — what's under test is the card, not `PUT /api/photos`, which
 * `photos.test.ts` already covers.
 */
async function seedListing(ownerId: string, options: SeedOptions = {}): Promise<string> {
  const listingId = await insertApprovedListing({ ownerId, ...(options.title ? { title: options.title } : {}) });

  if (options.status && options.status !== "approved") {
    await env.DB.prepare("UPDATE listings SET status = ? WHERE id = ?").bind(options.status, listingId).run();
  }

  if (options.withPhoto !== false) {
    const photoId = ulid();
    const bytes = options.photoBytes ?? realJpegBytes(64, 48);
    await env.BUCKET.put(`photos/${photoId}/full.jpg`, bytes);
    await env.BUCKET.put(`photos/${photoId}/thumb.jpg`, bytes);
    await env.DB.prepare(
      `INSERT INTO photos (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height,
                           bytes_full, blurhash, content_type, moderation_status, created_at)
       VALUES (?, ?, ?, 0, ?, ?, 1200, 900, ?, 'LEHV6nWB2yk8', ?, 'passed', ?)`,
    )
      .bind(
        photoId,
        ownerId,
        listingId,
        `photos/${photoId}/full.jpg`,
        `photos/${photoId}/thumb.jpg`,
        bytes.length,
        options.contentType ?? "image/jpeg",
        Date.now(),
      )
      .run();
  }

  return listingId;
}

let ownerId: string;

beforeAll(async () => {
  ownerId = await insertOwner();
});

/** `insertOwner` mints an owner with no usable token; the delete route needs
 * one that authenticates. Creates the pair through the same seam
 * `helpers.authHeaders` expects. */
async function freshOwnerTokenForOwner(): Promise<{ token: string; ownerId: string }> {
  const token = freshOwnerToken();
  const hash = await sha256Hex(token);
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, hash, now, now)
    .run();
  return { token, ownerId: id };
}

describe("the rendered card", () => {
  it("is a JPEG at exactly 1200x630", async () => {
    // The dimensions are load-bearing, not cosmetic: `og:image:width`/`height`
    // in `routes/item.ts` advertise 1200x630, and an unfurler that finds a
    // different aspect ratio letterboxes or crops the card. Decoded from the
    // SOF marker so this is an assertion about the image, not about the code
    // that made it.
    const id = await seedListing(ownerId);
    const res = await get(CARD_PATH(id));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(isJpeg(bytes)).toBe(true);
    expect(jpegSize(bytes)).toEqual({ width: 1200, height: 630 });
  });

  it("actually has ink on it — title, stamp and photo", async () => {
    // The failure this catches is the one every other assertion here would
    // sail past: if the fonts fail to load, resvg draws NOTHING for the text
    // (not tofu — nothing), and the result is still a valid 1200x630 JPEG
    // with the right headers. Same for the photo: an unresolved `href`
    // renders a blank window silently. So decode the card and look at it.
    //
    // The three probes cover three different subsystems: the bundled fonts,
    // the SVG's own vector shapes, and the photo bytes pulled from R2.
    const id = await seedListing(ownerId, { title: "Ink please" });
    const res = await get(CARD_PATH(id));
    const { data, width } = decodeJpeg(new Uint8Array(await res.arrayBuffer()), { useTArray: true });

    const at = (x: number, y: number): [number, number, number] => {
      const i = (y * width + x) * 4;
      return [data[i] as number, data[i + 1] as number, data[i + 2] as number];
    };
    const countWhere = (
      box: { x0: number; y0: number; x1: number; y1: number },
      predicate: (rgb: [number, number, number]) => boolean,
    ): number => {
      let n = 0;
      for (let y = box.y0; y < box.y1; y += 2) {
        for (let x = box.x0; x < box.x1; x += 2) if (predicate(at(x, y))) n += 1;
      }
      return n;
    };

    // Black ink (`colors.ink` #1B1815) where the title is set on the index card.
    const titleInk = countWhere({ x0: 590, y0: 100, x1: 1080, y1: 200 }, ([r, g, b]) => r < 90 && g < 90 && b < 90);
    expect(titleInk).toBeGreaterThan(100);

    // The stamp's red (`colors.stamp` #C4341C) in the lower right of the card.
    const stampRed = countWhere(
      { x0: 880, y0: 430, x1: 1080, y1: 530 },
      ([r, g, b]) => r > 130 && r - g > 60 && r - b > 60,
    );
    expect(stampRed).toBeGreaterThan(20);

    // The photo window is not one flat colour — the fixture is a gradient, so
    // an unresolved image href (a blank white print) would collapse its
    // variance to nothing.
    const samples: number[] = [];
    for (let y = 120; y < 460; y += 8) samples.push(at(300, y)[0]);
    expect(new Set(samples).size).toBeGreaterThan(4);
  });

  it("is served with the same one-hour, non-immutable caching /i/:id uses", async () => {
    // Issue #22's reasoning applies identically here: a listing's visibility
    // can be revoked even when its content cannot change, and no purge
    // reaches a stranger's browser cache.
    const id = await seedListing(ownerId);
    const res = await get(CARD_PATH(id));
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(res.headers.get("Cache-Control")).not.toContain("immutable");
    // `toContain`, not `toBe`: outside production the global security
    // middleware widens this to "noindex, nofollow" on every response
    // (`routes/robots.ts`'s reasoning), and that override is correct.
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("renders once, then answers from the edge cache", async () => {
    const id = await seedListing(ownerId);

    const first = await get(CARD_PATH(id));
    expect(first.headers.get("X-Keepsake-OG")).toBe("render");
    await first.arrayBuffer();

    const second = await get(CARD_PATH(id));
    expect(second.headers.get("X-Keepsake-OG")).toBe("edge");
    expect(jpegSize(new Uint8Array(await second.arrayBuffer()))).toEqual({ width: 1200, height: 630 });
  });

  it("answers from R2 when the edge cache misses", async () => {
    // `?v=` is part of the edge-cache key but NOT of the R2 key, so varying
    // it is the seam that exercises the middle layer — and it doubles as the
    // assertion that `v` is advisory: a stale or invented `v` must still
    // serve the current card rather than 404 or re-render something else.
    const id = await seedListing(ownerId);

    const first = await get(`${CARD_PATH(id)}?v=first`);
    expect(first.headers.get("X-Keepsake-OG")).toBe("render");
    await first.arrayBuffer();

    // The R2 write rides on `waitUntil`, so it lands shortly after the
    // response does.
    expect(await waitForR2Prefix(`og/${id}/`)).not.toBeNull();

    const second = await get(`${CARD_PATH(id)}?v=stale-and-wrong`);
    expect(second.headers.get("X-Keepsake-OG")).toBe("r2");
    expect(jpegSize(new Uint8Array(await second.arrayBuffer()))).toEqual({ width: 1200, height: 630 });
  });
});

describe("visibility", () => {
  it("404s an id that does not exist", async () => {
    const res = await get(CARD_PATH(ulid()));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).not.toContain("image");
  });

  it("serves a given listing, stamped differently from an approved one", async () => {
    // A link shared before the keepsake was claimed is a normal, common flow;
    // 404ing it would make an ordinary message look broken. The stamp is what
    // changes, which means the bytes must differ — asserted, because a
    // fingerprint that ignored `status` would serve the FREE card forever.
    const id = await seedListing(ownerId, { title: "A stamped teacup" });
    // Distinct `?v=` per request: the edge cache is keyed on the full URL, so
    // reusing one would replay the pre-edit bytes and prove nothing about the
    // fingerprint. In production `routes/item.ts` supplies a fresh `v` for
    // exactly this reason.
    const approved = new Uint8Array(await (await get(`${CARD_PATH(id)}?v=a`)).arrayBuffer());

    await env.DB.prepare("UPDATE listings SET status = 'given' WHERE id = ?").bind(id).run();
    const givenRes = await get(`${CARD_PATH(id)}?v=b`);

    expect(givenRes.status).toBe(200);
    const given = new Uint8Array(await givenRes.arrayBuffer());
    expect(given.length).toBeGreaterThan(0);
    expect(Buffer.from(given).equals(Buffer.from(approved))).toBe(false);
  });

  it("stops serving a cached card the moment the listing stops being public", async () => {
    // The card carries the giver's photo, their story and their town. An
    // earlier version checked `caches.default` BEFORE reading the listing, so
    // a withdrawn or deleted keepsake kept being handed out at the edge for
    // up to an hour — the exact failure `lib/photoCache.ts` exists to prevent
    // for the photo itself, reintroduced one route over.
    const id = await seedListing(ownerId);
    const first = await get(CARD_PATH(id));
    expect(first.status).toBe(200);
    await first.arrayBuffer();

    // Warm a cache layer: the second request must not re-render, so there is
    // now a stored copy that could outlive the listing. Either `edge` or `r2`
    // proves that; which one won the race with the `waitUntil` write is not
    // what this test is about.
    expect(["edge", "r2"]).toContain((await get(CARD_PATH(id))).headers.get("X-Keepsake-OG"));

    await env.DB.prepare("UPDATE listings SET status = 'withdrawn' WHERE id = ?").bind(id).run();

    const after = await get(CARD_PATH(id));
    expect(after.status).toBe(404);
    expect(after.headers.get("Content-Type")).not.toContain("image");
  });

  for (const status of ["pending", "hidden", "withdrawn", "rejected"] as const) {
    it(`404s a ${status} listing even for its own owner`, async () => {
      // Deliberately stricter than `routes/images.ts`, which grants owners a
      // preview of their unapproved photos because the give flow needs one.
      // The card is only ever shown once a listing is approved, so an owner
      // bypass here would be surface with no use. If that ever changes, this
      // test is the thing that should be edited, consciously.
      const id = await seedListing(ownerId, { status });
      const token = "ks_" + "A".repeat(43);
      const res = await get(CARD_PATH(id), authHeaders(token));
      expect(res.status).toBe(404);
    });
  }
});

describe("the fingerprint", () => {
  it("changes the bytes when the title changes", async () => {
    const id = await seedListing(ownerId, { title: "Before the edit" });
    const before = new Uint8Array(await (await get(`${CARD_PATH(id)}?v=a`)).arrayBuffer());

    // Wait for the first card to actually be IN R2 before editing. Without
    // this the test is a race and, worse, a false pass: if the fingerprint
    // ignored `title`, the second request would find nothing stored yet,
    // re-render with the new title, and produce different bytes for entirely
    // the wrong reason. Verified by deleting `input.title` from
    // `cardFingerprint` and watching this fail.
    expect(await waitForR2Prefix(`og/${id}/`)).not.toBeNull();

    // ONLY the title — deliberately not `version` too, even though the real
    // `PATCH /api/listings/:id` bumps both. Touching two fingerprint inputs
    // at once means either one alone could be carrying the test, and this one
    // is here to prove the title is.
    await env.DB.prepare("UPDATE listings SET title = ? WHERE id = ?")
      .bind("After the edit, entirely different", id)
      .run();

    const after = new Uint8Array(await (await get(`${CARD_PATH(id)}?v=b`)).arrayBuffer());
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(false);
  });

  it("leaves the old object in R2 rather than invalidating it", async () => {
    // Content-addressing is the whole design: nothing purges, so an edit adds
    // a key instead of replacing one. Asserting the old key survives is what
    // proves no invalidation logic crept back in — logic that would have to
    // be wired into all nine sites that write `listings.status`.
    const id = await seedListing(ownerId, { title: "Two keys, please" });
    await (await get(`${CARD_PATH(id)}?v=a`)).arrayBuffer();
    await waitForR2Prefix(`og/${id}/`);
    const firstKeys = await listR2Prefix(`og/${id}/`);

    await env.DB.prepare("UPDATE listings SET title = ? WHERE id = ?").bind("A different title now", id).run();
    await (await get(`${CARD_PATH(id)}?v=b`)).arrayBuffer();

    await vi_waitUntil(async () => (await listR2Prefix(`og/${id}/`)).length > firstKeys.length);
    const bothKeys = await listR2Prefix(`og/${id}/`);
    expect(bothKeys).toEqual(expect.arrayContaining(firstKeys));
    expect(bothKeys.length).toBe(firstKeys.length + 1);
  });
});

describe("deleting a listing", () => {
  it("removes its rendered cards from R2, not just its photos", async () => {
    // A card is a rendered copy of the photo, the story and the town. The
    // delete handler is careful to remove the photo objects; leaving the
    // cards behind keeps exactly the material the delete was for. They are
    // never invalidated while the listing lives (content-addressed), so this
    // is the only sweep they get.
    const ownerToken = await freshOwnerTokenForOwner();
    const id = await seedListing(ownerToken.ownerId);

    await (await get(CARD_PATH(id))).arrayBuffer();
    expect(await waitForR2Prefix(`og/${id}/`)).not.toBeNull();

    const res = await SELF.fetch(`http://x/api/listings/${id}`, {
      method: "DELETE",
      headers: { "CF-Connecting-IP": freshClientIp(), ...authHeaders(ownerToken.token) },
    });
    expect(res.status).toBe(200);

    await vi_waitUntil(async () => (await listR2Prefix(`og/${id}/`)).length === 0);
    expect(await listR2Prefix(`og/${id}/`)).toEqual([]);
  });
});

describe("fallbacks", () => {
  it("serves the default card, not a 500, when the listing has no photo", async () => {
    // Reachable: `DELETE /api/photos/:id` can strip the last photo off a live
    // listing.
    const id = await seedListing(ownerId, { withPhoto: false });
    const res = await get(CARD_PATH(id));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Keepsake-OG-Fallback")).toBe("no_photo");
  });

  it("serves the raw photo, not a 500, when the cover cannot be decoded", async () => {
    // resvg decodes JPEG, PNG and GIF — not WebP, which `lib/imageSniff.ts`
    // accepts on upload. The official client always re-encodes to JPEG, so
    // this needs a hand-rolled client to happen; it must degrade, not break.
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
      ...new Array<number>(16).fill(0),
    ]);
    const id = await seedListing(ownerId, { photoBytes: webp, contentType: "image/webp" });
    const res = await get(CARD_PATH(id));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Keepsake-OG-Fallback")).toBe("photo");
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(webp.length);
  });
});

/* ------------------------------------------------------------------ *
 * Small async helpers — the route writes to R2 under `waitUntil`, so
 * "it was stored" is eventually true, not immediately true.
 * ------------------------------------------------------------------ */

async function listR2Prefix(prefix: string): Promise<string[]> {
  const listed = await env.BUCKET.list({ prefix });
  return listed.objects.map((o) => o.key).sort();
}

async function waitForR2Prefix(prefix: string): Promise<string | null> {
  let found: string | null = null;
  await vi_waitUntil(async () => {
    const keys = await listR2Prefix(prefix);
    found = keys[0] ?? null;
    return keys.length > 0;
  });
  return found;
}

async function vi_waitUntil(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
