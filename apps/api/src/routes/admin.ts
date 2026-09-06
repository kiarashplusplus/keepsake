/**
 * `/api/admin/*` — Kiarash's own moderation queue, per the plan's route
 * table and `docs/runbooks/admin.md`. Every route here is guarded by
 * `adminAuth()` + `burst("RL_ADMIN")`, mounted once via `.use("*", ...)`
 * below rather than repeated on every handler.
 *
 * Every state-changing action writes a `moderation_events` row with
 * `kind = 'admin'` — the queue's own history doubles as an audit log, the
 * same rule the moderation pipeline already follows for its own decisions.
 */
import { Hono } from "hono";
import {
  AdminBanInput,
  AdminHideInput,
  AdminQueueQuery,
  AdminRejectInput,
  type AdminHealth,
  type AdminQueueItem,
  type AdminStats,
} from "@keepsake/contracts/admin";
import { LISTING_STATUSES, type ListingStatus, type OwnerListing } from "@keepsake/contracts/listing";
import type { FeedPage } from "@keepsake/contracts/feed";
import { maskEmail } from "@keepsake/contracts/request";
import type { ReportReason } from "@keepsake/contracts/report";
import type { Env } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { ulid } from "../lib/ids.js";
import { requireParam } from "../lib/params.js";
import { todayISO } from "../lib/day.js";
import { adminAuth } from "../middleware/adminAuth.js";
import { burst } from "../middleware/rateLimit.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { decodeKeysetCursor, encodeKeysetCursor } from "../lib/cursor.js";
import { fetchListingRow, fetchPhotoRows } from "../lib/listingsDb.js";
import { serializeOwnerListing, type ListingRow } from "../lib/serialize.js";

type Vars = { validatedBody: unknown; validatedQuery: unknown };
export const adminRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

adminRoutes.use("*", adminAuth(), burst("RL_ADMIN"));

function safeParseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function logAdminEvent(
  env: Env,
  fields: { listingId: string; listingVersion: number; verdict: string; reason?: string | undefined },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO moderation_events (id, listing_id, listing_version, kind, verdict, reason, attempt, created_at)
     VALUES (?, ?, ?, 'admin', ?, ?, 1, ?)`,
  )
    .bind(ulid(), fields.listingId, fields.listingVersion, fields.verdict, fields.reason ?? null, Date.now())
    .run();
}

/**
 * Takes `env` rather than the route's `c` on purpose: Hono gives each route
 * handler a `Context` type narrowed to that specific route's middleware
 * stack (e.g. `hide`'s handler sees a `validatedBody: AdminHideInput`
 * Variable that `approve`'s handler doesn't), and those per-route context
 * types aren't assignable to one shared helper's parameter type even though
 * every call site here only ever needs `env` and `id` — plain `env: Env`
 * sidesteps the mismatch entirely instead of fighting it with a cast.
 */
async function fetchOwnerListingOrNull(env: Env, id: string): Promise<OwnerListing | null> {
  const row = await fetchListingRow(env, id);
  if (!row) return null;
  const photos = await fetchPhotoRows(env, id);
  return serializeOwnerListing(row, photos);
}

// ---------------------------------------------------------------------------
// GET /api/admin/queue?status=&cursor=&limit=
// ---------------------------------------------------------------------------
interface OwnerSummaryRow {
  id: string;
  email: string | null;
  email_verified_at: number | null;
  banned_at: number | null;
}

interface ModerationEventRow {
  kind: string;
  model: string | null;
  verdict: string;
  flags_json: string | null;
  reason: string | null;
  attempt: number;
  latency_ms: number | null;
  created_at: number;
}

interface ReportRow {
  reason: string;
  details: string | null;
  created_at: number;
}

adminRoutes.get("/queue", validateQuery(AdminQueueQuery), async (c) => {
  const query = c.get("validatedQuery") as AdminQueueQuery;
  const cursor = decodeKeysetCursor(query.cursor);

  const conditions = ["status = ?"];
  const params: unknown[] = [query.status];
  if (cursor) {
    // Reuses the keyset-cursor helper feed.ts uses for `published_at` —
    // it's a generic `<ms timestamp>:<id>` codec, not specific to that one
    // column. The admin queue orders by `updated_at` instead: what an admin
    // wants triaged first is whatever last changed, not whatever was
    // created first.
    conditions.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
    params.push(cursor.publishedAt, cursor.publishedAt, cursor.id);
  }
  params.push(query.limit);

  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
            status, moderation_reason, version, report_count, request_count, chosen_request_id,
            created_at, updated_at, published_at, given_at
     FROM listings WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`,
  )
    .bind(...params)
    .all<ListingRow>();

  const items: AdminQueueItem[] = [];
  for (const row of rows) {
    const photos = await fetchPhotoRows(c.env, row.id);
    const ownerListing = serializeOwnerListing(row, photos);

    const ownerRow = await c.env.DB.prepare(
      "SELECT id, email, email_verified_at, banned_at FROM owners WHERE id = ?",
    )
      .bind(row.owner_id)
      .first<OwnerSummaryRow>();

    const { results: eventRows } = await c.env.DB.prepare(
      "SELECT kind, model, verdict, flags_json, reason, attempt, latency_ms, created_at FROM moderation_events WHERE listing_id = ? ORDER BY created_at",
    )
      .bind(row.id)
      .all<ModerationEventRow>();

    const { results: reportRows } = await c.env.DB.prepare(
      "SELECT reason, details, created_at FROM reports WHERE listing_id = ? ORDER BY created_at",
    )
      .bind(row.id)
      .all<ReportRow>();

    items.push({
      ...ownerListing,
      report_count: row.report_count,
      owner: {
        id: row.owner_id,
        email_masked: ownerRow?.email ? maskEmail(ownerRow.email) : null,
        email_verified: Boolean(ownerRow?.email_verified_at),
        banned: Boolean(ownerRow?.banned_at),
      },
      events: eventRows.map((event) => ({
        kind: event.kind,
        model: event.model,
        verdict: event.verdict,
        flags: safeParseJson(event.flags_json),
        reason: event.reason,
        attempt: event.attempt,
        latency_ms: event.latency_ms,
        created_at: event.created_at,
      })),
      reports: reportRows.map((report) => ({
        reason: report.reason as ReportReason,
        details: report.details,
        created_at: report.created_at,
      })),
    });
  }

  const last = rows[rows.length - 1];
  const next_cursor = rows.length === query.limit && last ? encodeKeysetCursor(last.updated_at, last.id) : null;
  const page: FeedPage<AdminQueueItem> = { items, next_cursor };
  return ok(c, page);
});

// ---------------------------------------------------------------------------
// POST /api/admin/listings/:id/{approve,hide,restore,reject}
// ---------------------------------------------------------------------------
const APPROVABLE_STATUSES = new Set<ListingStatus>(["needs_review", "pending", "hidden"]);

adminRoutes.post("/listings/:id/approve", async (c) => {
  const id = requireParam(c, "id");
  const row = await fetchListingRow(c.env, id);
  if (!row) return fail(c, "not_found", "Listing not found.", 404);
  if (!APPROVABLE_STATUSES.has(row.status as ListingStatus)) {
    return fail(c, "conflict", "Only a held, pending, or hidden listing can be approved.", 409);
  }

  const now = Date.now();
  await c.env.DB.prepare(
    "UPDATE listings SET status = 'approved', moderation_reason = NULL, updated_at = ?, published_at = COALESCE(published_at, ?) WHERE id = ?",
  )
    .bind(now, now, id)
    .run();
  await logAdminEvent(c.env, { listingId: id, listingVersion: row.version, verdict: "approved" });

  const data = await fetchOwnerListingOrNull(c.env, id);
  if (!data) return fail(c, "internal", "Listing failed to save.", 500);
  return ok(c, data);
});

adminRoutes.post("/listings/:id/hide", validateBody(AdminHideInput), async (c) => {
  const id = requireParam(c, "id");
  const input = c.get("validatedBody") as AdminHideInput;
  const row = await fetchListingRow(c.env, id);
  if (!row) return fail(c, "not_found", "Listing not found.", 404);
  if (row.status === "hidden") {
    return fail(c, "conflict", "This listing is already hidden.", 409);
  }

  const now = Date.now();
  await c.env.DB.prepare("UPDATE listings SET status = 'hidden', updated_at = ? WHERE id = ?").bind(now, id).run();
  await logAdminEvent(c.env, { listingId: id, listingVersion: row.version, verdict: "hidden", reason: input.reason });

  const data = await fetchOwnerListingOrNull(c.env, id);
  if (!data) return fail(c, "internal", "Listing failed to save.", 500);
  return ok(c, data);
});

adminRoutes.post("/listings/:id/restore", async (c) => {
  const id = requireParam(c, "id");
  const row = await fetchListingRow(c.env, id);
  if (!row) return fail(c, "not_found", "Listing not found.", 404);
  if (row.status !== "hidden") {
    return fail(c, "conflict", "Only a hidden listing can be restored.", 409);
  }

  const now = Date.now();
  // `report_count` resets to 0 on restore — otherwise a listing an admin
  // just vouched for would trip `REPORT_AUTOHIDE_THRESHOLD` on its very next
  // report and hide itself again before anyone gets to see it live.
  await c.env.DB.prepare(
    "UPDATE listings SET status = 'approved', moderation_reason = NULL, report_count = 0, updated_at = ?, published_at = COALESCE(published_at, ?) WHERE id = ?",
  )
    .bind(now, now, id)
    .run();
  await logAdminEvent(c.env, { listingId: id, listingVersion: row.version, verdict: "restored" });

  const data = await fetchOwnerListingOrNull(c.env, id);
  if (!data) return fail(c, "internal", "Listing failed to save.", 500);
  return ok(c, data);
});

adminRoutes.post("/listings/:id/reject", validateBody(AdminRejectInput), async (c) => {
  const id = requireParam(c, "id");
  const input = c.get("validatedBody") as AdminRejectInput;
  const row = await fetchListingRow(c.env, id);
  if (!row) return fail(c, "not_found", "Listing not found.", 404);
  if (row.status === "given") {
    return fail(c, "conflict", "A given keepsake can't be rejected.", 409);
  }

  const now = Date.now();
  await c.env.DB.prepare("UPDATE listings SET status = 'rejected', moderation_reason = ?, updated_at = ? WHERE id = ?")
    .bind(input.reason, now, id)
    .run();
  await logAdminEvent(c.env, { listingId: id, listingVersion: row.version, verdict: "rejected", reason: input.reason });

  const data = await fetchOwnerListingOrNull(c.env, id);
  if (!data) return fail(c, "internal", "Listing failed to save.", 500);
  return ok(c, data);
});

// ---------------------------------------------------------------------------
// POST /api/admin/owners/:id/{ban,unban}
// ---------------------------------------------------------------------------
interface OwnerIdRow {
  id: string;
  banned_at: number | null;
}

adminRoutes.post("/owners/:id/ban", validateBody(AdminBanInput), async (c) => {
  const id = requireParam(c, "id");
  const input = c.get("validatedBody") as AdminBanInput;
  const owner = await c.env.DB.prepare("SELECT id, banned_at FROM owners WHERE id = ?").bind(id).first<OwnerIdRow>();
  if (!owner) return fail(c, "not_found", "Owner not found.", 404);

  const now = Date.now();
  await c.env.DB.prepare("UPDATE owners SET banned_at = ?, ban_reason = ? WHERE id = ?")
    .bind(now, input.reason ?? null, id)
    .run();

  // Every listing this owner has that isn't already given — a completed
  // handoff is done, hiding it after the fact would just confuse the
  // recipient who already has the keepsake.
  const { results: listings } = await c.env.DB.prepare(
    "SELECT id, version FROM listings WHERE owner_id = ? AND status != 'given'",
  )
    .bind(id)
    .all<{ id: string; version: number }>();

  for (const listing of listings) {
    await c.env.DB.prepare("UPDATE listings SET status = 'hidden', updated_at = ? WHERE id = ?")
      .bind(now, listing.id)
      .run();
    await logAdminEvent(c.env, { listingId: listing.id, listingVersion: listing.version, verdict: "hidden", reason: "owner_banned" });
  }

  return ok(c, { id, banned: true, hidden_listings: listings.length });
});

adminRoutes.post("/owners/:id/unban", async (c) => {
  const id = requireParam(c, "id");
  const owner = await c.env.DB.prepare("SELECT id FROM owners WHERE id = ?").bind(id).first<{ id: string }>();
  if (!owner) return fail(c, "not_found", "Owner not found.", 404);

  // Reverses the ban only — listings the ban hid stay hidden until an admin
  // individually restores each one (`POST .../restore`). An unban is "this
  // person is allowed back," not "everything they had is automatically
  // trustworthy again."
  await c.env.DB.prepare("UPDATE owners SET banned_at = NULL, ban_reason = NULL WHERE id = ?").bind(id).run();
  return ok(c, { id, banned: false });
});

// ---------------------------------------------------------------------------
// GET /api/admin/stats
// ---------------------------------------------------------------------------
function todayStartMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

adminRoutes.get("/stats", async (c) => {
  const { results: statusRows } = await c.env.DB.prepare("SELECT status, COUNT(*) AS count FROM listings GROUP BY status").all<{
    status: string;
    count: number;
  }>();

  const listings_by_status = Object.fromEntries(LISTING_STATUSES.map((status) => [status, 0])) as Record<ListingStatus, number>;
  for (const row of statusRows) {
    if (row.status in listings_by_status) {
      listings_by_status[row.status as ListingStatus] = row.count;
    }
  }

  const dayStart = todayStartMs();
  const requestsToday = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM requests WHERE created_at >= ?")
    .bind(dayStart)
    .first<{ count: number }>();
  const emailFailuresToday = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM email_events WHERE ok = 0 AND created_at >= ?")
    .bind(dayStart)
    .first<{ count: number }>();

  // Same KV keys `src/moderation/budget.ts`'s `checkAndBump` writes to
  // (`budget:<kind>:YYYY-MM-DD`) — read directly rather than through
  // `checkAndBump` itself, since a stats read must never bump the counter it
  // is only trying to report.
  const modTextUsed = await c.env.KV.get(`budget:mod_text:${todayISO()}`);
  const modImageUsed = await c.env.KV.get(`budget:mod_image:${todayISO()}`);

  const stats: AdminStats = {
    listings_by_status,
    requests_today: requestsToday?.count ?? 0,
    email_failures_today: emailFailuresToday?.count ?? 0,
    ai_budget_used_today: {
      mod_text: modTextUsed ? Number.parseInt(modTextUsed, 10) : 0,
      mod_image: modImageUsed ? Number.parseInt(modImageUsed, 10) : 0,
    },
  };
  return ok(c, stats);
});

// ---------------------------------------------------------------------------
// GET /api/admin/health
// ---------------------------------------------------------------------------
const CRON_JOB_NAMES = ["moderationRetry", "orphanSweep"] as const;

adminRoutes.get("/health", async (c) => {
  const postalCountRow = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM postal_codes").first<{ count: number }>();
  const postalCodesCount = postalCountRow?.count ?? 0;
  if (postalCodesCount === 0) {
    console.warn("admin/health: postal_codes table is empty — geo lookups will 404 for every postcode");
  }

  const cronLastRun: Record<string, number | null> = {};
  for (const name of CRON_JOB_NAMES) {
    const value = await c.env.KV.get(`cron:last:${name}`);
    cronLastRun[name] = value ? Number.parseInt(value, 10) : null;
  }

  const health: AdminHealth = {
    ok: postalCodesCount > 0,
    postal_codes_count: postalCodesCount,
    cron_last_run: cronLastRun,
  };
  return ok(c, health);
});
