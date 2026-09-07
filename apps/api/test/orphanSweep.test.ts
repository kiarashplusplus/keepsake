import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { orphanSweep } from "../src/cron/orphanSweep.js";
import { runCron } from "../src/index.js";
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

/**
 * Stands in for `.github/workflows/backup-photos.yml` having already run.
 *
 * Issue #178: `orphanSweep` refuses to delete a photo whose keys are not in
 * the backup bucket, so every deletion case below has to say explicitly that
 * the backup happened — which is the point. Before this, the ordering between
 * the two jobs was an assumption living in a comment on a cron schedule; now
 * it is a precondition every test has to state.
 *
 * `wrangler.toml` binds `PHOTO_BACKUP_BUCKET` at the top level, so the test
 * runtime has a real local R2 bucket for it.
 */
async function markBackedUp(...keys: string[]): Promise<void> {
  const backup = (env as unknown as { PHOTO_BACKUP_BUCKET: R2Bucket }).PHOTO_BACKUP_BUCKET;
  for (const key of keys) {
    await backup.put(key, new Uint8Array([9]));
  }
}

/** Runs `body` with the backup binding removed, the way production runs today
 * (#157: `keepsake-photos-production-backup` does not exist, so
 * `wrangler.toml` deliberately omits the binding under `[env.production]`). */
async function withoutBackupBinding(body: () => Promise<void>): Promise<void> {
  const original = (env as unknown as Record<string, unknown>).PHOTO_BACKUP_BUCKET;
  delete (env as unknown as Record<string, unknown>).PHOTO_BACKUP_BUCKET;
  try {
    await body();
  } finally {
    (env as unknown as Record<string, unknown>).PHOTO_BACKUP_BUCKET = original;
  }
}

interface InsertOrphanPhotoOptions {
  createdAt: number;
  /** Default true: the nightly backup has already copied this photo. Set
   * false for the #178 cases that test what happens when it has not. */
  backedUp?: boolean;
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

  if (options.backedUp !== false) await markBackedUp(fullKey, thumbKey);

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
    // Backed up, so the only reason this photo can survive the sweep is the
    // one under test — that it belongs to a listing — and not #178's guard.
    await markBackedUp(fullKey, thumbKey);
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
    // Through `runCron`, because since #165 the heartbeat is written by the
    // dispatcher rather than by each job's last statement — one writer, so a
    // new cron cannot be added without one. `cron.test.ts` covers the same
    // property for all three jobs by driving the real `scheduled()` handler;
    // this stays because a sweep that stops writing its heartbeat is a
    // sweep-shaped failure and belongs in the sweep's own file.
    await env.KV.delete("cron:last:orphanSweep");
    const before = Date.now();
    const ctx = createExecutionContext();
    await runCron("orphanSweep", orphanSweep, env, ctx);
    await waitOnExecutionContext(ctx);
    const stored = await env.KV.get("cron:last:orphanSweep");
    expect(stored).not.toBeNull();
    expect(Number.parseInt(stored ?? "0", 10)).toBeGreaterThanOrEqual(before);
  });
});

/**
 * Issue #169. The 48-hour expiry the privacy page promises twice was real
 * only for the KV budget counters; the same `dailyIpDigest` value written
 * into `requests.ip_digest` and `reports.ip_digest` had no TTL, no sweep and
 * no delete path at all.
 */
/**
 * Issue #178. The photo backup's whole safety argument was that GitHub
 * Actions starts it at 03:00 and this cron fires at 03:17 — 17 minutes of
 * margin against a queue GitHub documents as best-effort, on a repository
 * whose measured drift is routinely larger than that, and whose one and only
 * scheduled run of that workflow started at 03:18, *after* the sweep.
 *
 * When the sweep wins that race it deletes the R2 objects and the `photos`
 * row; the backup then reads D1, no longer sees the row, copies nothing, and
 * exits green. The bytes it exists to insure are gone with no copy anywhere
 * and nothing distinguishes that run from a quiet one.
 *
 * So the ordering is enforced by the deleter now, and these are the cases
 * that hold it there.
 */
describe("orphanSweep: no photo is deleted before it is backed up (#178)", () => {
  it("defers a photo the backup has not copied yet, R2 bytes and D1 row both", async () => {
    const unsaved = await insertOrphanPhoto({ createdAt: Date.now() - 2 * DAY_MS, backedUp: false });

    await orphanSweep(env);

    // Both halves matter: keeping the row without the bytes would leave a
    // photo the API still lists and `/i/:id/:variant` 404s, and keeping the
    // bytes without the row would orphan them from the backup script's own
    // `SELECT ... FROM photos`, which is how it decides what to copy.
    expect(await r2ObjectExists(unsaved.fullKey)).toBe(true);
    expect(await photoRowExists(unsaved.id)).toBe(true);
  });

  it("deletes it on a later night, once the backup has caught up", async () => {
    // A late backup delays a deletion; it does not cancel one. This is the
    // whole trade — an orphan photo costs storage for a night, a deleted
    // un-backed-up one costs a keepsake.
    const late = await insertOrphanPhoto({ createdAt: Date.now() - 2 * DAY_MS, backedUp: false });
    await orphanSweep(env);
    expect(await photoRowExists(late.id)).toBe(true);

    await markBackedUp(late.fullKey, late.thumbKey);
    await orphanSweep(env);

    expect(await photoRowExists(late.id)).toBe(false);
    expect(await r2ObjectExists(late.fullKey)).toBe(false);
    expect(await r2ObjectExists(late.thumbKey)).toBe(false);
  });

  it("defers a photo whose thumbnail was copied but whose full-size was not", async () => {
    // A partial copy is a real state — `tools/backup-photos.mjs` copies key
    // by key and reports `failed` per key — and half a photo is not a backup.
    const partial = await insertOrphanPhoto({ createdAt: Date.now() - 2 * DAY_MS, backedUp: false });
    await markBackedUp(partial.thumbKey);

    await orphanSweep(env);

    expect(await photoRowExists(partial.id)).toBe(true);
  });

  it("does not let one un-backed-up photo block the ones behind it", async () => {
    // The deferred row stays in the table and would be re-selected by an
    // unchanged `LIMIT` query forever. Without the OFFSET this hangs on the
    // first blocked photo and nothing else in the backlog is ever collected.
    const blocked = await insertOrphanPhoto({ createdAt: Date.now() - 3 * DAY_MS, backedUp: false });
    const ready = await insertOrphanPhoto({ createdAt: Date.now() - 3 * DAY_MS });

    await orphanSweep(env);

    expect(await photoRowExists(blocked.id)).toBe(true);
    expect(await photoRowExists(ready.id)).toBe(false);
  });

  it("deletes as before when the backup binding is absent, rather than blocking deletion forever", async () => {
    // Production runs exactly this way today: #157 means
    // `keepsake-photos-production-backup` does not exist, so `wrangler.toml`
    // omits the binding there on purpose. A guard that refused every deletion
    // without it would turn one missing bucket into unbounded R2 growth and a
    // `photos` table nothing prunes — a worse failure, and a silent one. The
    // skip is loud instead (`warnIfUnguarded`, gated on `isDeployed`).
    const unsaved = await insertOrphanPhoto({ createdAt: Date.now() - 2 * DAY_MS, backedUp: false });

    await withoutBackupBinding(async () => {
      await orphanSweep(env);
    });

    expect(await photoRowExists(unsaved.id)).toBe(false);
    expect(await r2ObjectExists(unsaved.fullKey)).toBe(false);
  });
});

describe("orphanSweep: hashed IPs expire at 48 hours (#169)", () => {
  const HOUR_MS = 60 * 60 * 1000;

  async function insertRequest(createdAt: number): Promise<string> {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const id = ulid();
    await env.DB.prepare(
      // Confirmed, so this fixture is the "real ask, old row" case these
      // digest-expiry assertions are about — not #188's held-and-unconfirmed
      // case, which the sweep deletes outright and which has its own test.
      `INSERT INTO requests (id, listing_id, note, email, ip_digest, status, created_at, confirmed_at)
       VALUES (?, ?, 'A note', ?, ?, 'open', ?, ?)`,
    )
      .bind(id, listingId, `requester-${id}@keepsake.ing`, `digest-${id}`, createdAt, createdAt)
      .run();
    return id;
  }

  async function insertReport(createdAt: number): Promise<string> {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const id = ulid();
    await env.DB.prepare(
      `INSERT INTO reports (id, listing_id, reason, ip_digest, created_at) VALUES (?, ?, 'spam', ?, ?)`,
    )
      .bind(id, listingId, `digest-${id}`, createdAt)
      .run();
    return id;
  }

  async function digestOf(table: "requests" | "reports", id: string): Promise<string | null> {
    const row = await env.DB.prepare(`SELECT ip_digest FROM ${table} WHERE id = ?`)
      .bind(id)
      .first<{ ip_digest: string | null }>();
    return row?.ip_digest ?? null;
  }

  it("nulls ip_digest on requests and reports older than 48 hours, and leaves the rest of the row alone", async () => {
    const now = Date.now();
    const oldRequest = await insertRequest(now - 49 * HOUR_MS);
    const oldReport = await insertReport(now - 49 * HOUR_MS);

    await orphanSweep(env);

    expect(await digestOf("requests", oldRequest)).toBeNull();
    expect(await digestOf("reports", oldReport)).toBeNull();

    // The row itself survives — this is a retention rule about one column,
    // not a deletion. A requester's note and a reporter's reason are what the
    // moderation queue and the owner dashboard are made of.
    const request = await env.DB.prepare("SELECT note, status FROM requests WHERE id = ?")
      .bind(oldRequest)
      .first<{ note: string | null; status: string }>();
    expect(request?.note).toBe("A note");
    expect(request?.status).toBe("open");
  });

  it("keeps a hash that is still inside the window, because the day-scoped uniqueness check reads it", async () => {
    // The control. Without this, "nulls everything unconditionally" would
    // pass the test above, and the same-day duplicate-report check that
    // `ip_digest` exists for would silently stop working.
    const now = Date.now();
    const freshRequest = await insertRequest(now - 2 * HOUR_MS);
    const freshReport = await insertReport(now - 2 * HOUR_MS);

    await orphanSweep(env);

    expect(await digestOf("requests", freshRequest)).not.toBeNull();
    expect(await digestOf("reports", freshReport)).not.toBeNull();
  });

  it("is idempotent: a second run the same night clears nothing further", async () => {
    const now = Date.now();
    const oldRequest = await insertRequest(now - 72 * HOUR_MS);

    await orphanSweep(env);
    expect(await digestOf("requests", oldRequest)).toBeNull();

    // `ip_digest IS NOT NULL` in the WHERE clause is what makes this true —
    // and what keeps the logged count an honest measure of what each run
    // actually erased rather than of how many old rows exist.
    await expect(orphanSweep(env)).resolves.toBeUndefined();
    expect(await digestOf("requests", oldRequest)).toBeNull();
  });
});

describe("orphanSweep: legacy plaintext addresses in email_events (#200)", () => {
  /**
   * A row exactly as it was written before #190 scrubbed provider text at the
   * point of capture: Cloudflare Email Routing's own sentence, quoting the
   * destination address in full.
   */
  async function insertEmailEvent(errorDetail: string | null, createdAt = Date.now()): Promise<string> {
    const id = ulid();
    await env.DB.prepare(
      `INSERT INTO email_events (id, kind, to_hash, provider, ok, error, error_detail, created_at)
       VALUES (?, 'new_request', ?, 'cf', 0, 'send_failed', ?, ?)`,
    )
      .bind(id, `hash-${id}`, errorDetail, createdAt)
      .run();
    return id;
  }

  async function detailOf(id: string): Promise<string | null> {
    const row = await env.DB.prepare("SELECT error_detail FROM email_events WHERE id = ?")
      .bind(id)
      .first<{ error_detail: string | null }>();
    return row?.error_detail ?? null;
  }

  it("rewrites the address out of a pre-#190 row and keeps the provider's diagnosis", async () => {
    const id = await insertEmailEvent(
      'destination address "alice.smith+keepsake@gmail.com" is not a verified destination address for this Email Routing zone',
    );

    await orphanSweep(env);

    const detail = await detailOf(id);
    expect(detail).not.toContain("alice.smith+keepsake");
    // The domain stays — the same trade `email_events.to_domain` already
    // makes, and the difference between "one address bounced" and "this
    // provider refuses everything".
    expect(detail).toContain("[REDACTED]@gmail.com");
    // And the sentence still reads, which is the half that would answer #6.
    expect(detail).toContain("is not a verified destination address for this Email Routing zone");
  });

  it("leaves a row that never held an address untouched", async () => {
    const id = await insertEmailEvent("temporary failure, code 451");
    await orphanSweep(env);
    expect(await detailOf(id)).toBe("temporary failure, code 451");
  });

  it("does not rewrite an already-scrubbed row a second time", async () => {
    // A scrubbed row still contains an `@`, so a `LIKE '%@%'` filter would
    // re-select it every night forever; the GLOB looks at the character
    // *before* the `@` and skips it. What a test at this level can see is the
    // text staying byte-identical across runs — the wasted re-read the GLOB
    // avoids is visible in the sweep's `emailDetailsExamined` count, not here.
    const scrubbed = "destination address \"[REDACTED]@gmail.com\" is not verified";
    const id = await insertEmailEvent(scrubbed);

    await orphanSweep(env);
    expect(await detailOf(id)).toBe(scrubbed);

    // A second pass the same night is a no-op, like every other sweep here.
    await orphanSweep(env);
    expect(await detailOf(id)).toBe(scrubbed);
  });

  it("scrubs every affected row, not just the first page", async () => {
    // The keyset cursor, in the only way that can fail visibly: more rows
    // than one batch. `EMAIL_DETAIL_SCRUB_BATCH` is 200, so 220 rows means
    // the second page has to be fetched for the last 20 to be cleaned.
    const ids: string[] = [];
    for (let i = 0; i < 220; i++) {
      ids.push(await insertEmailEvent(`rejected: user-${i}@example.org is not verified`));
    }

    await orphanSweep(env);

    for (const id of ids) {
      const detail = await detailOf(id);
      expect(detail).toContain("[REDACTED]@example.org");
    }
  });

  it("a row the pattern cannot improve does not starve the rows behind it", async () => {
    // The keyset cursor's actual job, and the only shape that can show it.
    // `user@localhost` matches the GLOB (a local-part character sits before
    // the `@`) but `redactString` declines it — the domain has no dot and no
    // TLD — so these rows stay in the matching set forever. Re-querying from
    // the start would hand back the same 200 of them every pass and burn the
    // per-run ceiling without ever reaching the row that needs cleaning.
    for (let i = 0; i < 210; i++) {
      await insertEmailEvent(`rejected: user${i}@localhost is unreachable`);
    }
    // ULIDs are time-ordered, so this one sorts after all 210 above.
    const dirty = await insertEmailEvent("rejected: victim@gmail.com is not verified");

    await orphanSweep(env);

    expect(await detailOf(dirty)).toContain("[REDACTED]@gmail.com");
  });

  it("leaves a NULL error_detail alone", async () => {
    const id = await insertEmailEvent(null);
    await orphanSweep(env);
    expect(await detailOf(id)).toBeNull();
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
  await markBackedUp(fullKey, thumbKey);
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
