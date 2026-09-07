import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { orphanSweep } from "../src/cron/orphanSweep.js";
import { ulid } from "../src/lib/ids.js";
import {
  authHeaders,
  freshOwnerToken,
  insertApprovedListing,
  insertOwner,
  installDenyingRateLimiter,
  uploadPhoto,
} from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface InsertOrphanPhotoOptions {
  createdAt: number;
}

async function insertOrphanPhoto(options: InsertOrphanPhotoOptions): Promise<{ id: string; fullKey: string; thumbKey: string }> {
  const id = ulid();
  const fullKey = `photos/${id}/full.jpg`;
  const thumbKey = `photos/${id}/thumb.jpg`;
  const ownerId = await insertOwner();

  await env.BUCKET.put(fullKey, new Uint8Array([1, 2, 3]));
  await env.BUCKET.put(thumbKey, new Uint8Array([4, 5, 6]));

  await env.DB.prepare(
    `INSERT INTO photos (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at)
     VALUES (?, ?, NULL, NULL, ?, ?, 800, 600, 3, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 'image/jpeg', 'unchecked', ?)`,
  )
    .bind(id, ownerId, fullKey, thumbKey, options.createdAt)
    .run();

  return { id, fullKey, thumbKey };
}

async function photoRowExists(id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id FROM photos WHERE id = ?").bind(id).first<{ id: string }>();
  return row !== null;
}

async function r2ObjectExists(key: string): Promise<boolean> {
  const object = await env.BUCKET.head(key);
  return object !== null;
}

describe("orphanSweep: orphan photos", () => {
  it("deletes an orphan photo (D1 row + both R2 objects) once it's older than 24h", async () => {
    const old = await insertOrphanPhoto({ createdAt: Date.now() - DAY_MS - 60_000 });

    await orphanSweep(env);

    expect(await photoRowExists(old.id)).toBe(false);
    expect(await r2ObjectExists(old.fullKey)).toBe(false);
    expect(await r2ObjectExists(old.thumbKey)).toBe(false);
  });

  it("leaves a recent orphan photo (younger than 24h) untouched", async () => {
    const recent = await insertOrphanPhoto({ createdAt: Date.now() - 60_000 });

    await orphanSweep(env);

    expect(await photoRowExists(recent.id)).toBe(true);
    expect(await r2ObjectExists(recent.fullKey)).toBe(true);
    expect(await r2ObjectExists(recent.thumbKey)).toBe(true);
  });

  it("never touches a photo that's attached to a listing, however old", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const id = ulid();
    const fullKey = `photos/${id}/full.jpg`;
    const thumbKey = `photos/${id}/thumb.jpg`;
    await env.BUCKET.put(fullKey, new Uint8Array([1]));
    await env.BUCKET.put(thumbKey, new Uint8Array([2]));
    await env.DB.prepare(
      `INSERT INTO photos (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at)
       VALUES (?, ?, ?, 0, ?, ?, 800, 600, 1, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 'image/jpeg', 'unchecked', ?)`,
    )
      .bind(id, ownerId, listingId, fullKey, thumbKey, Date.now() - 10 * DAY_MS)
      .run();

    await orphanSweep(env);

    expect(await photoRowExists(id)).toBe(true);
    expect(await r2ObjectExists(fullKey)).toBe(true);
  });

  it("is idempotent: running twice in a row deletes nothing extra the second time", async () => {
    const old = await insertOrphanPhoto({ createdAt: Date.now() - 2 * DAY_MS });
    await orphanSweep(env);
    expect(await photoRowExists(old.id)).toBe(false);

    // Second run should be a clean no-op, not an error re-deleting an
    // already-gone R2 object or D1 row.
    await expect(orphanSweep(env)).resolves.toBeUndefined();
  });

  it("records its own last-run time in KV for GET /api/admin/health", async () => {
    const before = Date.now();
    await orphanSweep(env);
    const stored = await env.KV.get("cron:last:orphanSweep");
    expect(stored).not.toBeNull();
    expect(Number.parseInt(stored ?? "0", 10)).toBeGreaterThanOrEqual(before);
  });
});

describe("orphanSweep: retention", () => {
  it("deletes recovery_tokens more than 7 days past their own expiry, keeps the rest", async () => {
    const ownerId = await insertOwner();
    const now = Date.now();
    const longExpired = ulid();
    const recentlyExpired = ulid();
    const notYetExpired = ulid();

    await env.DB.prepare(
      "INSERT INTO recovery_tokens (id, owner_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, 'recover', ?, ?, ?)",
    )
      .bind(longExpired, ownerId, `hash-${longExpired}`, now - 8 * DAY_MS, now - 9 * DAY_MS)
      .run();
    await env.DB.prepare(
      "INSERT INTO recovery_tokens (id, owner_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, 'recover', ?, ?, ?)",
    )
      .bind(recentlyExpired, ownerId, `hash-${recentlyExpired}`, now - 3 * DAY_MS, now - 4 * DAY_MS)
      .run();
    await env.DB.prepare(
      "INSERT INTO recovery_tokens (id, owner_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, 'verify_email', ?, ?, ?)",
    )
      .bind(notYetExpired, ownerId, `hash-${notYetExpired}`, now + DAY_MS, now)
      .run();

    await orphanSweep(env);

    const remaining = await env.DB.prepare("SELECT id FROM recovery_tokens WHERE id IN (?, ?, ?)")
      .bind(longExpired, recentlyExpired, notYetExpired)
      .all<{ id: string }>();
    const remainingIds = remaining.results.map((row) => row.id);
    expect(remainingIds).not.toContain(longExpired);
    expect(remainingIds).toContain(recentlyExpired);
    expect(remainingIds).toContain(notYetExpired);
  });

  it("deletes moderation_events and email_events older than 90 days, keeps recent ones", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const now = Date.now();
    const oldEventId = ulid();
    const recentEventId = ulid();

    await env.DB.prepare(
      "INSERT INTO moderation_events (id, listing_id, listing_version, kind, verdict, attempt, created_at) VALUES (?, ?, 1, 'decision', 'approved', 1, ?)",
    )
      .bind(oldEventId, listingId, now - 91 * DAY_MS)
      .run();
    await env.DB.prepare(
      "INSERT INTO moderation_events (id, listing_id, listing_version, kind, verdict, attempt, created_at) VALUES (?, ?, 1, 'decision', 'approved', 1, ?)",
    )
      .bind(recentEventId, listingId, now)
      .run();

    const oldEmailId = ulid();
    const recentEmailId = ulid();
    await env.DB.prepare("INSERT INTO email_events (id, kind, to_hash, provider, ok, created_at) VALUES (?, 'verify_email', 'hash', 'cf', 1, ?)")
      .bind(oldEmailId, now - 91 * DAY_MS)
      .run();
    await env.DB.prepare("INSERT INTO email_events (id, kind, to_hash, provider, ok, created_at) VALUES (?, 'verify_email', 'hash', 'cf', 1, ?)")
      .bind(recentEmailId, now)
      .run();

    await orphanSweep(env);

    const remainingEvents = await env.DB.prepare("SELECT id FROM moderation_events WHERE id IN (?, ?)")
      .bind(oldEventId, recentEventId)
      .all<{ id: string }>();
    const remainingEventIds = remainingEvents.results.map((row) => row.id);
    expect(remainingEventIds).not.toContain(oldEventId);
    expect(remainingEventIds).toContain(recentEventId);

    const remainingEmails = await env.DB.prepare("SELECT id FROM email_events WHERE id IN (?, ?)")
      .bind(oldEmailId, recentEmailId)
      .all<{ id: string }>();
    const remainingEmailIds = remainingEmails.results.map((row) => row.id);
    expect(remainingEmailIds).not.toContain(oldEmailId);
    expect(remainingEmailIds).toContain(recentEmailId);
  });
});

// ---------------------------------------------------------------------------
// Launch audit finding 15: photos of rejected, withdrawn and hidden listings
// were kept forever. `sweepOrphanPhotos` only ever sees `listing_id IS NULL`,
// and every one of those transitions changes `listings.status` alone — so
// nothing, anywhere, ever deleted those R2 objects, while the privacy page
// promised "a short grace period after it's removed".
//
// Retention: 30 days from `updated_at`. See the comment on
// `TERMINAL_PHOTO_RETENTION_MS`.
// ---------------------------------------------------------------------------

async function insertListingPhoto(listingId: string, ownerId: string): Promise<{ id: string; fullKey: string; thumbKey: string }> {
  const id = ulid();
  const fullKey = `photos/${id}/full.jpg`;
  const thumbKey = `photos/${id}/thumb.jpg`;
  await env.BUCKET.put(fullKey, new Uint8Array([1, 2, 3]));
  await env.BUCKET.put(thumbKey, new Uint8Array([4, 5, 6]));
  await env.DB.prepare(
    `INSERT INTO photos (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at)
     VALUES (?, ?, ?, 0, ?, ?, 800, 600, 3, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 'image/jpeg', 'passed', ?)`,
  )
    .bind(id, ownerId, listingId, fullKey, thumbKey, Date.now())
    .run();
  return { id, fullKey, thumbKey };
}

async function insertListingInStatus(status: string, updatedAt: number): Promise<{ listingId: string; ownerId: string }> {
  const ownerId = await insertOwner();
  const listingId = await insertApprovedListing({ ownerId });
  await env.DB.prepare("UPDATE listings SET status = ?, updated_at = ? WHERE id = ?").bind(status, updatedAt, listingId).run();
  return { listingId, ownerId };
}

describe("orphanSweep: photos of terminal listings", () => {
  it.each(["rejected", "withdrawn", "hidden"])(
    "deletes the R2 bytes for a %s listing older than 30 days, and keeps the listing row",
    async (status) => {
      const { listingId, ownerId } = await insertListingInStatus(status, Date.now() - 31 * DAY_MS);
      const photo = await insertListingPhoto(listingId, ownerId);

      await orphanSweep(env);

      expect(await r2ObjectExists(photo.fullKey)).toBe(false);
      expect(await r2ObjectExists(photo.thumbKey)).toBe(false);
      expect(await photoRowExists(photo.id)).toBe(false);

      // The listing itself — status, moderation reason, event history — is
      // the audit trail for why it was rejected. It stays.
      const listing = await env.DB.prepare("SELECT status FROM listings WHERE id = ?")
        .bind(listingId)
        .first<{ status: string }>();
      expect(listing?.status).toBe(status);
    },
  );

  it("keeps the bytes while the listing is still inside the grace period", async () => {
    const { listingId, ownerId } = await insertListingInStatus("rejected", Date.now() - 3 * DAY_MS);
    const photo = await insertListingPhoto(listingId, ownerId);

    await orphanSweep(env);

    expect(await r2ObjectExists(photo.fullKey)).toBe(true);
    expect(await photoRowExists(photo.id)).toBe(true);
  });

  // `given` listings stay individually reachable at `/item/:id`, so purging
  // their photos would leave a live page with a missing image. This is the
  // control that the sweep is selecting on status and not just on age.
  it("never touches a given listing's photos, however old", async () => {
    const { listingId, ownerId } = await insertListingInStatus("given", Date.now() - 400 * DAY_MS);
    const photo = await insertListingPhoto(listingId, ownerId);

    await orphanSweep(env);

    expect(await r2ObjectExists(photo.fullKey)).toBe(true);
    expect(await photoRowExists(photo.id)).toBe(true);
  });

  it("is idempotent: a second run finds nothing left to delete", async () => {
    const { listingId, ownerId } = await insertListingInStatus("withdrawn", Date.now() - 60 * DAY_MS);
    const photo = await insertListingPhoto(listingId, ownerId);

    await orphanSweep(env);
    expect(await photoRowExists(photo.id)).toBe(false);
    await expect(orphanSweep(env)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Launch audit finding 11: `owners` rows were minted before any limiter and
// never swept. Two halves, tested separately below — bound the rate at which
// they are created, and bound the total that accumulates.
// ---------------------------------------------------------------------------

async function ownerRowExists(id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id FROM owners WHERE id = ?").bind(id).first<{ id: string }>();
  return row !== null;
}

async function insertOwnerAged(ageMs: number): Promise<string> {
  const id = ulid();
  const at = Date.now() - ageMs;
  await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .bind(id, `test-hash-${id}`, at, at)
    .run();
  return id;
}

describe("orphanSweep: empty owners", () => {
  it("deletes an owner with no listings, no photos, no email and no activity for 30 days", async () => {
    const id = await insertOwnerAged(31 * DAY_MS);

    await orphanSweep(env);

    expect(await ownerRowExists(id)).toBe(false);
  });

  it("keeps a recently-seen owner, however old the row is", async () => {
    const id = await insertOwnerAged(400 * DAY_MS);
    await env.DB.prepare("UPDATE owners SET last_seen_at = ? WHERE id = ?").bind(Date.now(), id).run();

    await orphanSweep(env);

    expect(await ownerRowExists(id)).toBe(true);
  });

  it("keeps an old owner who still has a listing", async () => {
    const id = await insertOwnerAged(90 * DAY_MS);
    await insertApprovedListing({ ownerId: id });

    await orphanSweep(env);

    expect(await ownerRowExists(id)).toBe(true);
  });

  it("keeps an old owner who still has a photo", async () => {
    const id = await insertOwnerAged(90 * DAY_MS);
    const photoId = ulid();
    await env.DB.prepare(
      `INSERT INTO photos (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at)
       VALUES (?, ?, NULL, NULL, ?, ?, 800, 600, 3, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 'image/jpeg', 'unchecked', ?)`,
    )
      .bind(photoId, id, `photos/${photoId}/full.jpg`, `photos/${photoId}/thumb.jpg`, Date.now())
      .run();

    await orphanSweep(env);

    expect(await ownerRowExists(id)).toBe(true);
  });

  // An address is a dashboard someone can recover into, so the row is not
  // empty even when nothing else points at it.
  it("keeps an old owner who left an email address", async () => {
    const id = await insertOwnerAged(90 * DAY_MS);
    await env.DB.prepare("UPDATE owners SET email = ? WHERE id = ?").bind("someone@example.com", id).run();

    await orphanSweep(env);

    expect(await ownerRowExists(id)).toBe(true);
  });

  it("keeps an old owner who still holds a recovery token", async () => {
    const id = await insertOwnerAged(90 * DAY_MS);
    const tokenId = ulid();
    await env.DB.prepare(
      "INSERT INTO recovery_tokens (id, owner_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, 'recover', ?, ?, ?)",
    )
      .bind(tokenId, id, `hash-${tokenId}`, Date.now() + DAY_MS, Date.now())
      .run();

    await orphanSweep(env);

    expect(await ownerRowExists(id)).toBe(true);
  });
});

describe("owners are not minted before the rate limiter", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  async function ownerCount(): Promise<number> {
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM owners").first<{ count: number }>();
    return row?.count ?? 0;
  }

  // Before the reorder, `ownerAuth({ createIfMissing: true })` ran first on
  // both of these routes, so a request that was subsequently 429'd had
  // already inserted a permanent `owners` row for whatever random token it
  // presented.
  it("PUT /api/photos: a rate-limited upload creates no owner row", async () => {
    restore = installDenyingRateLimiter("RL_UPLOAD");
    const before = await ownerCount();

    const res = await uploadPhoto({ token: freshOwnerToken() });

    expect(res.status).toBe(429);
    expect(await ownerCount()).toBe(before);
  });

  it("POST /api/listings: a rate-limited create creates no owner row", async () => {
    restore = installDenyingRateLimiter("RL_CREATE");
    const before = await ownerCount();

    const res = await SELF.fetch("http://x/api/listings", {
      method: "POST",
      headers: { ...authHeaders(freshOwnerToken()), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(429);
    expect(await ownerCount()).toBe(before);
  });
});
