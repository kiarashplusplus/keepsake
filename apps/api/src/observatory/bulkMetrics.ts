/**
 * The bulk-upload half of the Observatory's D1-derived `app` section — plan
 * Stage 5. Same floor as `./appMetrics.ts`: no Cloudflare credential, always
 * present, works locally. Kept in its own module rather than folded into
 * `appMetrics.ts` because it reads four tables (`upload_batches`,
 * `upload_batch_items`, `upload_batch_photos`, `bulk_grants`,
 * `bulk_operations`) none of the give flow's own metrics touch, and because
 * the whole thing collapses to `{ enabled: false }` in most environments —
 * see `ObservatoryBulk`'s own doc comment for why.
 *
 * The pilot's actual failure mode is not "the API 500s" — the API already
 * has tests for that. It is "a giver's submission sits at `queued` for six
 * hours and nobody notices until they email asking why their photos
 * vanished." Every field here exists to answer, at a glance, "is anything
 * stuck" for bulk the same way `appMetrics.ts`'s `moderation` section
 * already answers it for the give flow.
 */
import type {
  ObservatoryBulk,
  ObservatoryBulkBatches,
  ObservatoryBulkDrafts,
  ObservatoryBulkFunnel,
  ObservatoryBulkGrants,
  ObservatoryBulkOperations,
} from "@keepsake/contracts/observatory";
import { BATCH_ITEM_STATES, BATCH_STATES, BULK_OPERATION_STATUSES } from "@keepsake/contracts/bulk";
import type { Env } from "../env.js";
import { bulkUploadEnabled } from "../env.js";
import { LATENCY_SAMPLE_LIMIT, medianOf, windowStartMs } from "./appMetrics.js";

/** Every state/status bucket seeded at zero, same reason
 * `appMetrics.ts`'s `emptySeries` seeds every calendar day — a state nothing
 * currently occupies must still appear as `0`, not be silently absent from
 * the object a client indexes by key. */
function zeroRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

interface StateCountRow {
  state: string;
  count: number;
}

async function fetchBatches(env: Env, now: number): Promise<ObservatoryBulkBatches> {
  const [stateRows, abandonedRow] = await Promise.all([
    env.DB.prepare("SELECT state, COUNT(*) AS count FROM upload_batches GROUP BY state").all<StateCountRow>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM upload_batches WHERE state = 'draft' AND expires_at < ?")
      .bind(now)
      .first<{ count: number }>(),
  ]);

  const byState = zeroRecord(BATCH_STATES);
  for (const row of stateRows.results) {
    if (row.state in byState) byState[row.state as (typeof BATCH_STATES)[number]] = row.count;
  }

  return {
    by_state: byState,
    active: byState.draft + byState.submitting,
    abandoned_draft: abandonedRow?.count ?? 0,
  };
}

interface PhotoUploadRow {
  reserved: number | null;
  stored: number | null;
}

async function fetchDrafts(env: Env): Promise<ObservatoryBulkDrafts> {
  const [itemRows, photoRow] = await Promise.all([
    env.DB.prepare("SELECT state, COUNT(*) AS count FROM upload_batch_items GROUP BY state").all<StateCountRow>(),
    env.DB.prepare(
      `SELECT SUM(CASE WHEN photo_id IS NULL THEN 1 ELSE 0 END) AS reserved,
              SUM(CASE WHEN photo_id IS NOT NULL THEN 1 ELSE 0 END) AS stored
         FROM upload_batch_photos`,
    ).first<PhotoUploadRow>(),
  ]);

  const byState = zeroRecord(BATCH_ITEM_STATES);
  for (const row of itemRows.results) {
    if (row.state in byState) byState[row.state as (typeof BATCH_ITEM_STATES)[number]] = row.count;
  }

  return {
    items_by_state: byState,
    items_outstanding: byState.editing + byState.ready + byState.queued + byState.failed,
    photos_reserved: photoRow?.reserved ?? 0,
    photos_stored: photoRow?.stored ?? 0,
  };
}

interface OperationStateRow {
  status: string;
  count: number;
}

interface ActiveOperationRow {
  oldest_created: number | null;
  stale_recoveries: number | null;
}

async function fetchOperations(env: Env, now: number): Promise<ObservatoryBulkOperations> {
  const [statusRows, activeRow] = await Promise.all([
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM bulk_operations GROUP BY status").all<OperationStateRow>(),
    // Scoped to `queued`/`running` for both fields — see `ObservatoryBulkOperations`'s
    // own doc comment on why the recovery count is deliberately "among work
    // still in flight" rather than an all-time total.
    env.DB.prepare(
      `SELECT MIN(created_at) AS oldest_created, SUM(stale_recoveries) AS stale_recoveries
         FROM bulk_operations WHERE status IN ('queued', 'running')`,
    ).first<ActiveOperationRow>(),
  ]);

  const byStatus = zeroRecord(BULK_OPERATION_STATUSES);
  for (const row of statusRows.results) {
    if (row.status in byStatus) byStatus[row.status as (typeof BULK_OPERATION_STATUSES)[number]] = row.count;
  }

  return {
    by_status: byStatus,
    active: byStatus.queued + byStatus.running,
    oldest_active_age_ms: activeRow?.oldest_created == null ? null : now - activeRow.oldest_created,
    active_stale_lease_recoveries: activeRow?.stale_recoveries ?? 0,
  };
}

interface GrantRow {
  active: number | null;
  expired: number | null;
  revoked: number | null;
  items_remaining: number | null;
  photos_remaining: number | null;
  suggestions_remaining: number | null;
}

async function fetchGrants(env: Env, now: number): Promise<ObservatoryBulkGrants> {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN revoked_at IS NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired,
       SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,
       SUM(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN items_remaining ELSE 0 END) AS items_remaining,
       SUM(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN photos_remaining ELSE 0 END) AS photos_remaining,
       SUM(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN suggestions_remaining ELSE 0 END) AS suggestions_remaining
     FROM bulk_grants`,
  )
    .bind(now, now, now, now, now)
    .first<GrantRow>();

  return {
    active: row?.active ?? 0,
    expired: row?.expired ?? 0,
    revoked: row?.revoked ?? 0,
    items_remaining: row?.items_remaining ?? 0,
    photos_remaining: row?.photos_remaining ?? 0,
    suggestions_remaining: row?.suggestions_remaining ?? 0,
  };
}

interface FunnelCountsRow {
  batches_started: number;
  items_submitted: number;
}

interface OrphanBytesRow {
  orphan_bytes: number | null;
}

interface LatencyRow {
  latency_ms: number;
}

/**
 * Median moderation latency (listing creation → first `moderation_events`
 * decision) for listings created inside the window, split by whether the
 * listing was born from a bulk item. Same query shape as
 * `appMetrics.ts`'s `fetchModerationLatency`, duplicated rather than
 * parameterised over that function — the two differ in exactly one clause
 * (the `EXISTS`/`NOT EXISTS` against `upload_batch_items`) and threading
 * that through a shared helper would cost more clarity than the four lines
 * it would save.
 */
async function fetchLatencyMedian(env: Env, since: number, bulk: boolean): Promise<number | null> {
  const originClause = bulk
    ? "EXISTS (SELECT 1 FROM upload_batch_items ubi WHERE ubi.listing_id = l.id)"
    : "NOT EXISTS (SELECT 1 FROM upload_batch_items ubi WHERE ubi.listing_id = l.id)";

  const { results } = await env.DB.prepare(
    `SELECT MIN(e.created_at) - l.created_at AS latency_ms
       FROM listings l
       JOIN moderation_events e ON e.listing_id = l.id AND e.kind = 'decision'
      WHERE l.created_at >= ? AND ${originClause}
      GROUP BY l.id
      ORDER BY l.created_at DESC
      LIMIT ?`,
  )
    .bind(since, LATENCY_SAMPLE_LIMIT)
    .all<LatencyRow>();

  const samples = results.map((row) => row.latency_ms).sort((a, b) => a - b);
  return medianOf(samples);
}

async function fetchFunnel(env: Env, now: number, windowDays: number): Promise<ObservatoryBulkFunnel> {
  const since = windowStartMs(now, windowDays);

  const [counts, approved, orphan, ordinaryLatency, bulkLatency] = await Promise.all([
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM upload_batches WHERE created_at >= ?1) AS batches_started,
         (SELECT COUNT(*) FROM upload_batch_items WHERE submitted_at IS NOT NULL AND submitted_at >= ?1) AS items_submitted`,
    )
      .bind(since)
      .first<FunnelCountsRow>(),
    // Approved inside the window, scoped to listings that came from a bulk
    // item — joined through `upload_batch_items.listing_id`, the only link
    // between the two. Not a cohort of `items_submitted` above — see
    // `ObservatoryBulkFunnel`'s own doc comment on why.
    env.DB.prepare(
      `SELECT COUNT(DISTINCT e.listing_id) AS count
         FROM moderation_events e
         JOIN upload_batch_items ubi ON ubi.listing_id = e.listing_id
        WHERE e.created_at >= ? AND e.kind IN ('decision', 'admin') AND e.verdict = 'approved'`,
    )
      .bind(since)
      .first<{ count: number | null }>(),
    // Bytes, not a photo count — see the field's own doc comment. Scoped to
    // batches whose fate is sealed (`closed`/`cancelled`): a photo still
    // sitting unattached in a `draft` batch's tray is ordinary in-progress
    // work, not an orphan yet.
    env.DB.prepare(
      `SELECT SUM(p.bytes_full) AS orphan_bytes
         FROM upload_batch_photos ubp
         JOIN photos p ON p.id = ubp.photo_id
         JOIN upload_batches b ON b.id = ubp.batch_id
        WHERE ubp.photo_id IS NOT NULL
          AND ubp.item_id IS NULL
          AND b.state IN ('closed', 'cancelled')`,
    ).first<OrphanBytesRow>(),
    fetchLatencyMedian(env, since, false),
    fetchLatencyMedian(env, since, true),
  ]);

  return {
    window_days: windowDays,
    batches_started: counts?.batches_started ?? 0,
    items_submitted: counts?.items_submitted ?? 0,
    items_approved: approved?.count ?? 0,
    orphan_bytes: orphan?.orphan_bytes ?? 0,
    moderation_latency_ordinary_median_ms: ordinaryLatency,
    moderation_latency_bulk_median_ms: bulkLatency,
  };
}

export async function buildBulkMetrics(env: Env, windowDays: number, now: number = Date.now()): Promise<ObservatoryBulk> {
  if (!bulkUploadEnabled(env)) return { enabled: false };

  const [batches, drafts, operations, grants, funnel] = await Promise.all([
    fetchBatches(env, now),
    fetchDrafts(env),
    fetchOperations(env, now),
    fetchGrants(env, now),
    fetchFunnel(env, now, windowDays),
  ]);

  return { enabled: true, batches, drafts, operations, grants, funnel };
}
