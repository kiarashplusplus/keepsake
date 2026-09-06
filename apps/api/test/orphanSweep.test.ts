import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { orphanSweep } from "../src/cron/orphanSweep.js";
import { ulid } from "../src/lib/ids.js";
import { insertApprovedListing, insertOwner } from "./helpers.js";

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
