/**
 * The bulk-upload panel of the Observatory (plan Stage 5) —
 * `src/observatory/bulkMetrics.ts`, reached through `GET
 * /api/admin/observatory`'s `app.bulk`, and its reflection in the daily
 * digest's `report.bulk`.
 *
 * Fixtures write directly to `upload_batches`/`upload_batch_items`/
 * `upload_batch_photos`/`bulk_grants`/`bulk_operations` rather than going
 * through `routes/bulk.ts` (owned by another agent) — the same choice
 * `bulkSubmit.test.ts` and its siblings already make. `runBulkOperation`
 * itself (`src/bulk/submit.ts`) is exercised directly where the test is
 * about what that function's own claim statement does — the
 * `stale_recoveries` tests below — rather than reimplementing its logic.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Observatory } from "@keepsake/contracts/observatory";
import { runBulkOperation } from "../src/bulk/submit.js";
import { ulid } from "../src/lib/ids.js";
import { insertOwner, readOk, setTestEnvVar } from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-observatory-bulk";

async function getObservatory(): Promise<Observatory> {
  const res = await SELF.fetch("http://x/api/admin/observatory", {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  return readOk<Observatory>(res);
}

async function bulk(): Promise<Extract<Observatory["app"]["bulk"], { enabled: true }>> {
  const observatory = await getObservatory();
  if (!observatory.app.bulk.enabled) throw new Error("expected bulk to be enabled in this suite");
  return observatory.app.bulk;
}

interface InsertBatchOptions {
  ownerId: string;
  state?: "draft" | "submitting" | "closed" | "cancelled";
  createdAt?: number;
  expiresAt?: number;
}

async function insertBatch(options: InsertBatchOptions): Promise<string> {
  const id = ulid();
  const now = Date.now();
  const createdAt = options.createdAt ?? now;
  await env.DB.prepare(
    `INSERT INTO upload_batches
       (id, owner_id, client_batch_key, name, shared_story, country, postal_code, place_name, admin1, lat, lng,
        state, revision, last_activity_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'Observatory test batch', NULL, 'US', '02144', 'Somerville', 'MA', 42.3958, -71.0967,
             ?, 1, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      options.ownerId,
      `client-${id}`,
      options.state ?? "draft",
      createdAt,
      options.expiresAt ?? createdAt + 7 * 24 * 60 * 60 * 1000,
      createdAt,
      createdAt,
    )
    .run();
  return id;
}

interface InsertItemOptions {
  batchId: string;
  state?: string;
  submittedAt?: number | null;
  listingId?: string | null;
}

async function insertItem(options: InsertItemOptions): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO upload_batch_items
       (id, batch_id, client_item_id, title, story, category, aspects_json, room_label, lot_label, state, revision,
        listing_id, created_at, updated_at, submitted_at)
     VALUES (?, ?, ?, 'A lovely teacup', 'This belonged to my grandmother and I would love for it to find a new home.',
             'home_kitchen', NULL, NULL, NULL, ?, 1, ?, ?, ?, ?)`,
  )
    .bind(id, options.batchId, `client-${id}`, options.state ?? "editing", options.listingId ?? null, now, now, options.submittedAt ?? null)
    .run();
  return id;
}

interface InsertPhotoRowOptions {
  batchId: string;
  ownerId: string;
  itemId?: string | null;
  reserved?: boolean;
  bytesFull?: number;
}

/** A resolved (or, with `reserved: true`, still-reserved) `upload_batch_photos`
 * row. For a resolved row this also writes the backing `photos` row —
 * `orphan_bytes` sums `photos.bytes_full`, so the fixture needs a real one
 * to sum. */
async function insertBatchPhoto(options: InsertPhotoRowOptions): Promise<string> {
  const id = ulid();
  const now = Date.now();
  let photoId: string | null = null;

  if (!options.reserved) {
    photoId = ulid();
    const fullKey = `photos/${photoId}/full.jpg`;
    const thumbKey = `photos/${photoId}/thumb.jpg`;
    await env.BUCKET.put(fullKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    await env.BUCKET.put(thumbKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    await env.DB.prepare(
      `INSERT INTO photos
         (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at)
       VALUES (?, ?, NULL, NULL, ?, ?, 800, 600, ?, 'LEHV6nl01waF5-KStrzX', 'image/jpeg', 'unchecked', ?)`,
    )
      .bind(photoId, options.ownerId, fullKey, thumbKey, options.bytesFull ?? 1000, now)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO upload_batch_photos (id, batch_id, client_photo_id, photo_id, item_id, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(id, options.batchId, `client-${id}`, photoId, options.itemId ?? null, now, now)
    .run();
  return id;
}

interface InsertGrantOptions {
  ownerId: string;
  itemsRemaining?: number;
  photosRemaining?: number;
  suggestionsRemaining?: number;
  expiresAt?: number;
  revokedAt?: number | null;
}

async function insertGrant(options: InsertGrantOptions): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO bulk_grants
       (id, owner_id, batch_id, items_remaining, photos_remaining, suggestions_remaining, issued_by, expires_at, revoked_at, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, 'admin', ?, ?, ?)`,
  )
    .bind(
      id,
      options.ownerId,
      options.itemsRemaining ?? 10,
      options.photosRemaining ?? 30,
      options.suggestionsRemaining ?? 5,
      options.expiresAt ?? now + 72 * 3_600_000,
      options.revokedAt ?? null,
      now,
    )
    .run();
  return id;
}

interface InsertOperationOptions {
  ownerId: string;
  batchId: string;
  status?: "queued" | "running" | "done" | "cancelled";
  createdAt?: number;
  leaseUntil?: number | null;
  nextAttemptAt?: number;
  /** Fake item ids — `runBulkOperation`'s `processItem` treats an unresolved
   * id as "missing" (logs and returns `failed`, no DB write required), which
   * is exactly the cheap, safe shape these tests need to make an operation
   * outlive one `ITEMS_PER_INVOCATION`-sized chunk without a real listing
   * behind every entry. */
  selectionSize?: number;
}

async function insertOperation(options: InsertOperationOptions): Promise<string> {
  const id = ulid();
  const now = Date.now();
  const selection = Array.from({ length: options.selectionSize ?? 1 }, (_, i) => ({
    client_item_id: `fake-${i}`,
    item_id: ulid(),
    revision: 1,
  }));
  await env.DB.prepare(
    `INSERT INTO bulk_operations
       (id, owner_id, batch_id, kind, op_key, payload_hash, selection_json,
        status, cursor, total, succeeded, failed, attempts, lease_until,
        next_attempt_at, age_attested_at, created_at, updated_at, finished_at)
     VALUES (?, ?, ?, 'submit', ?, 'hash', ?, ?, 0, ?, 0, 0, 0, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      id,
      options.ownerId,
      options.batchId,
      `op-${id}`,
      JSON.stringify(selection),
      options.status ?? "queued",
      selection.length,
      options.leaseUntil ?? null,
      options.nextAttemptAt ?? now,
      now,
      options.createdAt ?? now,
      now,
    )
    .run();
  return id;
}

describe("GET /api/admin/observatory: app.bulk", () => {
  it("requires the admin token", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const res = await SELF.fetch("http://x/api/admin/observatory");
    expect(res.status).toBe(401);
  });

  it("reads 'enabled: false' with no numbers when BULK_UPLOAD is off, per the flag this environment actually reads", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    setTestEnvVar("BULK_UPLOAD", "0");
    const observatory = await getObservatory();
    expect(observatory.app.bulk).toEqual({ enabled: false });
    setTestEnvVar("BULK_UPLOAD", "1");
  });

  it("counts batches by state, active as draft+submitting, and abandoned drafts past their own expiry", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await insertOwner();
    const now = Date.now();

    await insertBatch({ ownerId, state: "draft" });
    await insertBatch({ ownerId, state: "submitting" });
    await insertBatch({ ownerId, state: "closed" });
    await insertBatch({ ownerId, state: "cancelled" });
    // A draft whose own expiry has already passed — nobody came back.
    const abandonedId = await insertBatch({ ownerId, state: "draft", createdAt: now - 20 * 24 * 3_600_000, expiresAt: now - 3_600_000 });

    const data = await bulk();
    expect(data.batches.by_state.draft).toBeGreaterThanOrEqual(2);
    expect(data.batches.by_state.submitting).toBeGreaterThanOrEqual(1);
    expect(data.batches.by_state.closed).toBeGreaterThanOrEqual(1);
    expect(data.batches.by_state.cancelled).toBeGreaterThanOrEqual(1);
    expect(data.batches.active).toBe(data.batches.by_state.draft + data.batches.by_state.submitting);
    expect(data.batches.abandoned_draft).toBeGreaterThanOrEqual(1);

    // Sanity: the abandoned batch really is a `draft` past its own
    // `expires_at`, not just a row this test happens to have inserted.
    const row = await env.DB.prepare("SELECT state, expires_at FROM upload_batches WHERE id = ?").bind(abandonedId).first<{
      state: string;
      expires_at: number;
    }>();
    expect(row?.state).toBe("draft");
    expect(row?.expires_at).toBeLessThan(now);
  });

  it("counts draft items by state and outstanding work, excluding only 'submitted'", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId });

    await insertItem({ batchId, state: "editing" });
    await insertItem({ batchId, state: "queued" });
    await insertItem({ batchId, state: "failed" });
    await insertItem({ batchId, state: "submitted", submittedAt: Date.now() });

    const data = await bulk();
    expect(data.drafts.items_by_state.editing).toBeGreaterThanOrEqual(1);
    expect(data.drafts.items_by_state.queued).toBeGreaterThanOrEqual(1);
    expect(data.drafts.items_by_state.failed).toBeGreaterThanOrEqual(1);
    expect(data.drafts.items_by_state.submitted).toBeGreaterThanOrEqual(1);
    // Every non-'submitted' bucket, summed, equals items_outstanding — the
    // definition this field promises in its own doc comment.
    const expectedOutstanding =
      data.drafts.items_by_state.editing + data.drafts.items_by_state.ready + data.drafts.items_by_state.queued + data.drafts.items_by_state.failed;
    expect(data.drafts.items_outstanding).toBe(expectedOutstanding);
  });

  it("counts reserved vs stored batch photos separately", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId });

    await insertBatchPhoto({ batchId, ownerId, reserved: true });
    await insertBatchPhoto({ batchId, ownerId, reserved: false });
    await insertBatchPhoto({ batchId, ownerId, reserved: false });

    const before = await bulk();
    const data = await bulk();
    expect(data.drafts.photos_reserved).toBeGreaterThanOrEqual(before.drafts.photos_reserved);
    expect(data.drafts.photos_stored).toBeGreaterThanOrEqual(2);
  });

  it("sums grant admission by lifecycle state: active, expired, revoked", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await insertOwner();
    const now = Date.now();

    const before = await bulk();
    await insertGrant({ ownerId, itemsRemaining: 7, photosRemaining: 21, suggestionsRemaining: 3 });
    await insertGrant({ ownerId, expiresAt: now - 3_600_000 }); // expired
    await insertGrant({ ownerId, revokedAt: now - 60_000 }); // revoked

    const after = await bulk();
    expect(after.grants.active).toBe(before.grants.active + 1);
    expect(after.grants.expired).toBe(before.grants.expired + 1);
    expect(after.grants.revoked).toBe(before.grants.revoked + 1);
    expect(after.grants.items_remaining).toBe(before.grants.items_remaining + 7);
    expect(after.grants.photos_remaining).toBe(before.grants.photos_remaining + 21);
    expect(after.grants.suggestions_remaining).toBe(before.grants.suggestions_remaining + 3);
  });

  // Ordered before every other `bulk_operations` test in this file: D1
  // storage is isolated per test *file* here, not per test (vitest-pool-workers
  // resets it between files), so this is the one point at which this file's
  // own `bulk_operations` table is still guaranteed empty — the only honest
  // place to assert "nothing queued or running" without it becoming a
  // coincidence of test order the moment a sibling `it` runs first.
  it("reports null oldest_active_age_ms when nothing is queued or running, not zero", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId });
    await insertOperation({ ownerId, batchId, status: "cancelled" });

    const data = await bulk();
    expect(data.operations.active).toBe(0);
    expect(data.operations.oldest_active_age_ms).toBeNull();
    expect(data.operations.active_stale_lease_recoveries).toBe(0);
  });

  it("reports operation counts by status and the age of the oldest active one", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId });
    const oldCreatedAt = Date.now() - 3 * 3_600_000;

    await insertOperation({ ownerId, batchId, status: "queued", createdAt: oldCreatedAt });
    await insertOperation({ ownerId, batchId, status: "done", createdAt: Date.now() - 10 * 3_600_000 });

    const data = await bulk();
    expect(data.operations.by_status.queued).toBeGreaterThanOrEqual(1);
    expect(data.operations.by_status.done).toBeGreaterThanOrEqual(1);
    expect(data.operations.active).toBe(data.operations.by_status.queued + data.operations.by_status.running);
    // The 'done' operation is 10h old but finished — it must not set the
    // "oldest active" age, which is scoped to queued/running only.
    expect(data.operations.oldest_active_age_ms).not.toBeNull();
    expect(data.operations.oldest_active_age_ms as number).toBeGreaterThanOrEqual(3 * 3_600_000 - 5_000);
  });

  it("computes orphan bytes from closed/cancelled batches' unattached stored photos, in real bytes", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await insertOwner();
    const closedBatch = await insertBatch({ ownerId, state: "closed" });
    const draftBatch = await insertBatch({ ownerId, state: "draft" });

    const before = await bulk();

    // Orphaned: stored, unattached, batch is closed.
    await insertBatchPhoto({ batchId: closedBatch, ownerId, reserved: false, bytesFull: 50_000 });
    // Not orphaned: still in a draft batch's tray — ordinary in-progress work.
    await insertBatchPhoto({ batchId: draftBatch, ownerId, reserved: false, bytesFull: 999_999 });
    // Not orphaned: stored but never attached AND still reserved doesn't
    // apply here since this row IS stored — but it's attached to an item, so
    // it isn't "unattached" either.
    const item = await insertItem({ batchId: closedBatch });
    await insertBatchPhoto({ batchId: closedBatch, ownerId, itemId: item, reserved: false, bytesFull: 777_777 });

    const after = await bulk();
    expect(after.funnel.orphan_bytes).toBe(before.funnel.orphan_bytes + 50_000);
  });

  it("counts batches started and items submitted inside the window", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await insertOwner();
    const before = await bulk();

    const batchId = await insertBatch({ ownerId });
    await insertItem({ batchId, state: "submitted", submittedAt: Date.now() });

    const after = await bulk();
    expect(after.funnel.batches_started).toBe(before.funnel.batches_started + 1);
    expect(after.funnel.items_submitted).toBe(before.funnel.items_submitted + 1);
  });
});

describe("bulk_operations.stale_recoveries: distinguishing a crash recovery from ordinary chunking", () => {
  it("does NOT count a fresh claim (lease_until IS NULL) as a recovery", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId });
    // 6 fake entries: one call processes 5 (ITEMS_PER_INVOCATION) and leaves
    // the operation `queued` rather than `done`, so it is still "active"
    // for the observatory to report on afterward.
    const operationId = await insertOperation({ ownerId, batchId, status: "queued", leaseUntil: null, selectionSize: 6 });

    await runBulkOperation(env, operationId);

    const row = await env.DB.prepare("SELECT status, stale_recoveries FROM bulk_operations WHERE id = ?").bind(operationId).first<{
      status: string;
      stale_recoveries: number;
    }>();
    expect(row?.status).toBe("queued");
    expect(row?.stale_recoveries).toBe(0);
  });

  it("DOES count a claim that recovers an expired lease (lease_until in the past)", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId });
    const operationId = await insertOperation({
      ownerId,
      batchId,
      status: "running",
      leaseUntil: Date.now() - 60_000, // expired 60s ago — the previous holder never released it
      selectionSize: 6,
    });

    await runBulkOperation(env, operationId);

    const row = await env.DB.prepare("SELECT status, stale_recoveries FROM bulk_operations WHERE id = ?").bind(operationId).first<{
      status: string;
      stale_recoveries: number;
    }>();
    expect(row?.status).toBe("queued");
    expect(row?.stale_recoveries).toBe(1);

    // And the Observatory reports it, scoped to operations still in flight.
    const data = await bulk();
    expect(data.operations.active_stale_lease_recoveries).toBeGreaterThanOrEqual(1);
  });

  it("stops counting once the operation finishes — the count is scoped to active work, not an all-time total", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId });
    // A single fake entry finishes in one call (1 <= ITEMS_PER_INVOCATION).
    const operationId = await insertOperation({
      ownerId,
      batchId,
      status: "running",
      leaseUntil: Date.now() - 60_000,
      selectionSize: 1,
    });

    const before = await bulk();
    await runBulkOperation(env, operationId);
    const row = await env.DB.prepare("SELECT status, stale_recoveries FROM bulk_operations WHERE id = ?").bind(operationId).first<{
      status: string;
      stale_recoveries: number;
    }>();
    expect(row?.status).toBe("done");
    expect(row?.stale_recoveries).toBe(1);

    // Finished — must not still be counted among "active" recoveries.
    const after = await bulk();
    expect(after.operations.active_stale_lease_recoveries).toBe(before.operations.active_stale_lease_recoveries);
  });
});

describe("the daily digest: bulk", () => {
  it("carries a bulk block when the flag is on, null when it is off", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    setTestEnvVar("BULK_UPLOAD", "1");
    const on = await getObservatory();
    expect(on.report.bulk).not.toBeNull();

    setTestEnvVar("BULK_UPLOAD", "0");
    const off = await getObservatory();
    expect(off.report.bulk).toBeNull();
    setTestEnvVar("BULK_UPLOAD", "1");
  });

  it("raises a critical alert once an active operation has been stuck past the threshold", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId });
    // 7 hours old and still queued — past the digest's 6-hour threshold.
    await insertOperation({ ownerId, batchId, status: "queued", createdAt: Date.now() - 7 * 3_600_000, selectionSize: 6 });

    const observatory = await getObservatory();
    expect(observatory.report.needs_attention.some((alert) => alert.code === "bulk_operation_stuck")).toBe(true);
    const alert = observatory.report.needs_attention.find((a) => a.code === "bulk_operation_stuck");
    expect(alert?.severity).toBe("critical");
  });

  it("raises a warning once an active operation needed a stale-lease recovery", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId });
    const operationId = await insertOperation({
      ownerId,
      batchId,
      status: "running",
      leaseUntil: Date.now() - 60_000,
      selectionSize: 6,
    });
    await runBulkOperation(env, operationId);

    const observatory = await getObservatory();
    expect(observatory.report.needs_attention.some((alert) => alert.code === "bulk_lease_recoveries")).toBe(true);
    const alert = observatory.report.needs_attention.find((a) => a.code === "bulk_lease_recoveries");
    expect(alert?.severity).toBe("warning");
  });
});
