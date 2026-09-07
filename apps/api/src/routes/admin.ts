/**
 * `/api/admin/*` — Kiarash's own moderation queue, per the plan's route
 * table and `docs/runbooks/admin.md`. Every route here is guarded by
 * `burst("RL_ADMIN")` + `adminAuth()` — in that order — mounted once via
 * `.use("*", ...)` below rather than repeated on every handler.
 *
 * Every state-changing action writes a `moderation_events` row with
 * `kind = 'admin'` — the queue's own history doubles as an audit log, the
 * same rule the moderation pipeline already follows for its own decisions.
 */
import { Hono } from "hono";
import {
  AdminBackfillAspectsInput,
  AdminBanInput,
  AdminHideInput,
  AdminQueueQuery,
  AdminRejectInput,
  AdminRemoveRequestInput,
  AdminTestEmailInput,
  AdminTestErrorInput,
  type AdminBackfillAspectsResult,
  type AdminHealth,
  type AdminQueueItem,
  type AdminRequestRemoveResult,
  type AdminRequestView,
  type AdminStats,
  type AdminTestEmailResult,
  type AdminTestErrorResult,
} from "@keepsake/contracts/admin";
import { LISTING_STATUSES, type ListingStatus, type OwnerListing } from "@keepsake/contracts/listing";
import { readCronHeartbeats } from "../cron/registry.js";
import { ObservatoryQuery, type Observatory } from "@keepsake/contracts/observatory";
import { buildAppMetrics } from "../observatory/appMetrics.js";
import { fetchEdgeTelemetry, fetchLogTelemetry } from "../observatory/cloudflare.js";
import { buildDailyReport } from "../report/daily.js";
import type { FeedPage } from "@keepsake/contracts/feed";
import { maskEmail, type RequestStatus } from "@keepsake/contracts/request";
import type { ReportReason } from "@keepsake/contracts/report";
import { captureException, captureMessage } from "@keepsake/observability/capture";
import type { Env } from "../env.js";
import { emailProviderName, reportAutohideThreshold } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { ulid } from "../lib/ids.js";
import { requireParam } from "../lib/params.js";
import { todayISO } from "../lib/day.js";
import { adminAuth } from "../middleware/adminAuth.js";
import { burst } from "../middleware/rateLimit.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { decodeKeysetCursor, encodeKeysetCursor } from "../lib/cursor.js";
import {
  fetchAspectRows,
  fetchAspectRowsForListings,
  fetchListingRow,
  fetchPhotoRows,
  fetchPhotoRowsForListings,
} from "../lib/listingsDb.js";
import { serializeOwnerListing, type ListingRow } from "../lib/serialize.js";
import { recipientDomain, sendMail } from "../email/sendMail.js";
import { adminTest as adminTestTemplate } from "../email/templates/adminTest.js";
import { runAspectsBackfillBatch } from "../backfill/aspects.js";

type Vars = { validatedBody: unknown; validatedQuery: unknown };
export const adminRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// Limiter first, auth second — deliberately, and load-bearing. `adminAuth`
// answers a bad token with `fail(...)` and never calls `next()`, so with the
// two the other way round a *wrong* token never reached `burst()` at all and
// the single credential that can hide listings and ban owners was guessable
// at an unmetered rate (measured: 150 wrong tokens from one IP inside 60s
// against a 120/60s binding returned 150x401 and 0x429). Putting the limiter
// in front costs a correctly-authenticated admin nothing — 120/60s is far
// past what one human clicking through a queue produces — and makes the
// 401 path cost the attacker the same budget as the 200 path.
// Regression test: "rate-limits wrong tokens" in test/adminAuth.test.ts.
adminRoutes.use("*", burst("RL_ADMIN"), adminAuth());

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
  fields: {
    listingId: string;
    listingVersion: number;
    verdict: string;
    reason?: string | undefined;
    // Set only for an event about one request within the listing (currently
    // just `request_removed` — #70), mirroring how `photo_id` marks an event
    // as being about one photo rather than the listing as a whole.
    requestId?: string | undefined;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO moderation_events (id, listing_id, listing_version, request_id, kind, verdict, reason, attempt, created_at)
     VALUES (?, ?, ?, ?, 'admin', ?, ?, 1, ?)`,
  )
    .bind(ulid(), fields.listingId, fields.listingVersion, fields.requestId ?? null, fields.verdict, fields.reason ?? null, Date.now())
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
  const aspects = await fetchAspectRows(env, id);
  return serializeOwnerListing(row, photos, aspects);
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

/**
 * The three admin-only child lookups a queue page needs, each as one
 * `IN (...)` query for the whole page rather than one query per row (#91 —
 * an N+1 knowingly deferred when launch-audit finding 13 landed). They
 * mirror `fetchPhotoRowsForListings`/`fetchAspectRowsForListings` in
 * lib/listingsDb.ts, which `GET /api/feed` already uses for the same reason,
 * and they live here rather than there because nothing outside the admin
 * queue reads owner ban state, moderation events or reports in bulk.
 *
 * Grouping happens in JS; the SQL only has to return the page's rows in an
 * order that, read left to right, already has each listing's children
 * adjacent and correctly sequenced. Guarded by
 * test/adminQueueBatching.test.ts, which counts prepared statements at two
 * page sizes and fails if the count moves with the row count.
 */
function groupBy<Row, Value>(rows: Row[], keyOf: (row: Row) => string, valueOf: (row: Row) => Value): Map<string, Value[]> {
  const byKey = new Map<string, Value[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const existing = byKey.get(key);
    if (existing) {
      existing.push(valueOf(row));
    } else {
      byKey.set(key, [valueOf(row)]);
    }
  }
  return byKey;
}

async function fetchOwnerSummaries(env: Env, ownerIds: string[]): Promise<Map<string, OwnerSummaryRow>> {
  const byOwner = new Map<string, OwnerSummaryRow>();
  if (ownerIds.length === 0) return byOwner;

  const placeholders = ownerIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, email, email_verified_at, banned_at FROM owners WHERE id IN (${placeholders})`,
  )
    .bind(...ownerIds)
    .all<OwnerSummaryRow>();
  for (const row of results) byOwner.set(row.id, row);
  return byOwner;
}

/**
 * `ORDER BY listing_id, created_at, id` — the `id` is not decoration. The
 * per-row version ordered by `created_at` alone and left same-millisecond
 * events (routine: the text and image legs of one moderation run finish
 * microseconds apart) to whatever order SQLite happened to walk the index
 * in. Adding the primary key makes the sequence a function of the data, so
 * two identical requests can never disagree.
 */
async function fetchModerationEventsForListings(env: Env, listingIds: string[]): Promise<Map<string, ModerationEventRow[]>> {
  if (listingIds.length === 0) return new Map();

  const placeholders = listingIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT listing_id, kind, model, verdict, flags_json, reason, attempt, latency_ms, created_at
     FROM moderation_events WHERE listing_id IN (${placeholders}) ORDER BY listing_id, created_at, id`,
  )
    .bind(...listingIds)
    .all<ModerationEventRow & { listing_id: string }>();
  return groupBy(results, (row) => row.listing_id, (row) => row);
}

/** Same shape and same tiebreak reasoning as the events lookup above. */
async function fetchReportsForListings(env: Env, listingIds: string[]): Promise<Map<string, ReportRow[]>> {
  if (listingIds.length === 0) return new Map();

  const placeholders = listingIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT listing_id, reason, details, created_at FROM reports WHERE listing_id IN (${placeholders}) ORDER BY listing_id, created_at, id`,
  )
    .bind(...listingIds)
    .all<ReportRow & { listing_id: string }>();
  return groupBy(results, (row) => row.listing_id, (row) => row);
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

  // One query per child table for the whole page, not one per row. The
  // owner lookup is de-duplicated first: a queue page is often several
  // listings from the same repeat poster, and the old loop asked for that
  // owner once per listing.
  const listingIds = rows.map((row) => row.id);
  const ownerIds = [...new Set(rows.map((row) => row.owner_id))];
  const [photosByListing, aspectsByListing, ownersById, eventsByListing, reportsByListing] = await Promise.all([
    fetchPhotoRowsForListings(c.env, listingIds),
    fetchAspectRowsForListings(c.env, listingIds),
    fetchOwnerSummaries(c.env, ownerIds),
    fetchModerationEventsForListings(c.env, listingIds),
    fetchReportsForListings(c.env, listingIds),
  ]);

  const items: AdminQueueItem[] = rows.map((row) => {
    const ownerListing = serializeOwnerListing(row, photosByListing.get(row.id) ?? [], aspectsByListing.get(row.id) ?? []);
    const ownerRow = ownersById.get(row.owner_id);

    return {
      ...ownerListing,
      report_count: row.report_count,
      owner: {
        id: row.owner_id,
        email_masked: ownerRow?.email ? maskEmail(ownerRow.email) : null,
        email_verified: Boolean(ownerRow?.email_verified_at),
        banned: Boolean(ownerRow?.banned_at),
      },
      events: (eventsByListing.get(row.id) ?? []).map((event) => ({
        kind: event.kind,
        model: event.model,
        verdict: event.verdict,
        flags: safeParseJson(event.flags_json),
        reason: event.reason,
        attempt: event.attempt,
        latency_ms: event.latency_ms,
        created_at: event.created_at,
      })),
      reports: (reportsByListing.get(row.id) ?? []).map((report) => ({
        reason: report.reason as ReportReason,
        details: report.details,
        created_at: report.created_at,
      })),
    };
  });

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
// GET /api/admin/requests/:id, POST /api/admin/requests/:id/remove
//
// #70: the minor-takedown rule (docs/runbooks/admin.md) was executable on
// the giver side (hide + ban) but not the requester side — no admin view of
// a request's note, and no way to remove one request without hiding or
// rejecting the whole listing, which would punish the giver for a
// requester's status. Deliberately a look-up-by-id pair, not a field added
// to `GET /api/admin/queue`: a request's note is written by a stranger to
// the giver, and streaming every note into a browsable queue by default
// would be a real privacy change for a product that holds very little. A
// moderator who has been told about a specific request (e.g. by the giver
// forwarding it) looks it up directly.
// ---------------------------------------------------------------------------
interface AdminRequestRow {
  id: string;
  listing_id: string;
  note: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  created_at: number;
  chosen_at: number | null;
  age_attested_at: number | null;
  withdrawn_at: number | null;
  removed_at: number | null;
  removed_reason: string | null;
}

interface RequestListingRow {
  title: string;
  status: string;
}

adminRoutes.get("/requests/:id", async (c) => {
  const id = requireParam(c, "id");
  const row = await c.env.DB.prepare(
    `SELECT id, listing_id, note, email, phone, status, created_at, chosen_at, age_attested_at,
            withdrawn_at, removed_at, removed_reason
     FROM requests WHERE id = ?`,
  )
    .bind(id)
    .first<AdminRequestRow>();
  if (!row) return fail(c, "not_found", "Request not found.", 404);

  const listing = await c.env.DB.prepare("SELECT title, status FROM listings WHERE id = ?")
    .bind(row.listing_id)
    .first<RequestListingRow>();
  if (!listing) return fail(c, "internal", "This request's listing is missing.", 500);

  const data: AdminRequestView = {
    id: row.id,
    listing_id: row.listing_id,
    listing_title: listing.title,
    listing_status: listing.status as ListingStatus,
    status: row.status as RequestStatus,
    note: row.note,
    email: row.email,
    phone: row.phone,
    age_attested_at: row.age_attested_at,
    created_at: row.created_at,
    chosen_at: row.chosen_at,
    withdrawn_at: row.withdrawn_at,
    removed_at: row.removed_at,
    removed_reason: row.removed_reason,
  };
  return ok(c, data);
});

// Statuses that already mean "nothing left to redact" — `note`/`email`/
// `phone` are already NULL. Removing again would be a silent no-op that
// looks identical to a real removal from the response alone, exactly the
// class of bug `docs/runbooks/admin.md`'s five-checks table warns about, so
// this is a hard 409 rather than an idempotent 200.
const ALREADY_REDACTED_STATUSES = new Set(["withdrawn", "removed"]);

adminRoutes.post("/requests/:id/remove", validateBody(AdminRemoveRequestInput), async (c) => {
  const id = requireParam(c, "id");
  const input = c.get("validatedBody") as AdminRemoveRequestInput;

  const row = await c.env.DB.prepare("SELECT id, listing_id, status FROM requests WHERE id = ?")
    .bind(id)
    .first<{ id: string; listing_id: string; status: string }>();
  if (!row) return fail(c, "not_found", "Request not found.", 404);
  if (ALREADY_REDACTED_STATUSES.has(row.status)) {
    return fail(c, "conflict", "This request's contact info has already been removed.", 409);
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE requests SET status = 'removed', removed_at = ?, removed_reason = ?, note = NULL, email = NULL, phone = NULL
     WHERE id = ?`,
  )
    .bind(now, input.reason ?? null, id)
    .run();

  // Same reasoning as `POST /api/requests/withdraw`: a removed request is no
  // longer a live ask, and the floor costs nothing.
  await c.env.DB.prepare("UPDATE listings SET request_count = MAX(request_count - 1, 0) WHERE id = ?")
    .bind(row.listing_id)
    .run();

  const listing = await c.env.DB.prepare("SELECT version FROM listings WHERE id = ?")
    .bind(row.listing_id)
    .first<{ version: number }>();
  if (listing) {
    await logAdminEvent(c.env, {
      listingId: row.listing_id,
      listingVersion: listing.version,
      verdict: "request_removed",
      reason: input.reason,
      requestId: id,
    });
  }

  const result: AdminRequestRemoveResult = { id, listing_id: row.listing_id, removed: true, removed_at: now };
  return ok(c, result);
});

// ---------------------------------------------------------------------------
// GET /api/admin/stats
// ---------------------------------------------------------------------------
function todayStartMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * Issue #6: there is no bounce webhook and nothing else reads `email_events`
 * on a schedule, so this rolling window is the only place a real delivery
 * problem (a bad allowlist entry, a domain starting to bounce) would ever
 * become visible instead of silently accumulating. Seven days rather than
 * "today" — `email_failures_today` above already covers the same-day glance,
 * this is for the pattern a single day is too short to show.
 */
const EMAIL_EVENTS_WINDOW_DAYS = 7;

/** Rows with no `to_domain` — every row written before
 * `20260907083648_email_event_diagnostics.sql`. Grouped under a visible label rather
 * than dropped: a bucket of failures nobody can attribute is still a fact
 * about the window, and silently omitting it would understate the total. */
const UNKNOWN_DOMAIN = "(unknown)";
const UNSPECIFIED_REASON = "(unspecified)";

/**
 * The window is grouped on two axes at once — outcome × reason, and outcome ×
 * domain — because either axis alone reproduces the bug this issue is about.
 * By reason only: "3 × send_failed" is the same line whether three people
 * mistyped their address or the binding is refusing everything. By domain
 * only: a failure count with no denominator can't tell one bad address from a
 * blanket refusal. `attempted` alongside `failed`, per domain, is the
 * smallest thing that distinguishes them.
 */
interface EmailEventGroupRow {
  ok: number;
  error: string | null;
  to_domain: string | null;
  count: number;
}

function summarizeEmailEvents(rows: EmailEventGroupRow[]): AdminStats["email_events_7d"] {
  let total = 0;
  let okCount = 0;
  let failed = 0;

  const errorCounts = new Map<string, number>();
  // Per domain: attempts (any outcome), failures, and the failure reasons so
  // the dominant one can be named without a second query.
  const domains = new Map<string, { attempted: number; failed: number; reasons: Map<string, number> }>();

  for (const row of rows) {
    total += row.count;
    const domain = row.to_domain ?? UNKNOWN_DOMAIN;
    const entry = domains.get(domain) ?? { attempted: 0, failed: 0, reasons: new Map<string, number>() };
    entry.attempted += row.count;

    if (row.ok) {
      okCount += row.count;
    } else {
      failed += row.count;
      const reason = row.error ?? UNSPECIFIED_REASON;
      errorCounts.set(reason, (errorCounts.get(reason) ?? 0) + row.count);
      entry.failed += row.count;
      entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + row.count);
    }
    domains.set(domain, entry);
  }

  const byError = [...errorCounts.entries()]
    .map(([error, count]) => ({ error, count }))
    // Ties broken by name so the order is stable across reads — a breakdown
    // that reshuffles on refresh is one a human stops trusting.
    .sort((a, b) => b.count - a.count || a.error.localeCompare(b.error));

  const failuresByDomain = [...domains.entries()]
    .filter(([, entry]) => entry.failed > 0)
    .map(([domain, entry]) => {
      const topReason = [...entry.reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      return {
        domain,
        attempted: entry.attempted,
        failed: entry.failed,
        top_reason: topReason?.[0] ?? UNSPECIFIED_REASON,
      };
    })
    .sort((a, b) => b.failed - a.failed || a.domain.localeCompare(b.domain));

  return {
    window_days: EMAIL_EVENTS_WINDOW_DAYS,
    total,
    ok: okCount,
    failed,
    by_error: byError,
    failures_by_domain: failuresByDomain,
  };
}

async function fetchEmailEventStats(env: Env, now: number): Promise<AdminStats["email_events_7d"]> {
  const windowStart = now - EMAIL_EVENTS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const { results: rows } = await env.DB.prepare(
    "SELECT ok, error, to_domain, COUNT(*) AS count FROM email_events WHERE created_at >= ? GROUP BY ok, error, to_domain",
  )
    .bind(windowStart)
    .all<EmailEventGroupRow>();

  return summarizeEmailEvents(rows);
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

  const emailEvents7d = await fetchEmailEventStats(c.env, Date.now());

  const stats: AdminStats = {
    listings_by_status,
    requests_today: requestsToday?.count ?? 0,
    email_failures_today: emailFailuresToday?.count ?? 0,
    ai_budget_used_today: {
      mod_text: modTextUsed ? Number.parseInt(modTextUsed, 10) : 0,
      mod_image: modImageUsed ? Number.parseInt(modImageUsed, 10) : 0,
    },
    email_events_7d: emailEvents7d,
  };
  return ok(c, stats);
});

// ---------------------------------------------------------------------------
// GET /api/admin/health
// ---------------------------------------------------------------------------
/**
 * How long each cron's `cron:last:<name>` heartbeat may go unrefreshed before
 * this endpoint calls itself unhealthy. Generous multiples of each schedule
 * (`[triggers] crons` in wrangler.toml), so a single skipped tick or a slow
 * night is not an alarm, but a job that has actually stopped is:
 *
 *  - `moderationRetry` runs every 5 minutes. Past 30 (six missed ticks),
 *    listings are stranded in `pending` and no giver's keepsake is going
 *    public.
 *  - `orphanSweep` runs once a night at 03:17. 26 hours allows a late run
 *    plus a couple of hours of slack before a whole night counts as missed.
 *
 * Launch audit finding 12: the heartbeats were written correctly and read
 * correctly here, but `ok` was derived *solely* from `postal_codes_count > 0`,
 * so a month-old timestamp sat in the response next to a cheerful `ok: true`.
 * The value was present and the verdict ignored it, which is the same class
 * of bug as a limiter that never fires.
 */
// The thresholds this docblock describes now live in `src/cron/registry.ts`,
// beside the schedule each one is a multiple of. They were duplicated here
// and in `index.ts`'s dispatch switch, so adding a third job meant editing
// three files and hoping; `readCronHeartbeats` below is the shared read.

/**
 * Issue #89: three independent reporters can hide a live listing on their
 * own (`REPORT_AUTOHIDE_THRESHOLD`, enforced in
 * `POST /api/listings/:id/reports`), and until this block existed nothing
 * told a human it had happened. `GET /health` is a Worker liveness check —
 * an auto-hide changes a *listing's* status, not the Worker's, so it stayed
 * `ok: true` right through the event — and the `captureMessage` the
 * auto-hide fires writes to Workers Logs, which has no Tail Worker and no
 * Logpush reading it on a schedule (docs/runbooks/incident.md).
 *
 * Same shape as the cron-staleness read above: pull the raw signal, log a
 * `console.warn` when it is non-empty, put it in the payload for the admin
 * strip, and let it decide `ok`. Both directions of the risk land in the
 * same bucket on purpose — a genuinely harmful listing that needs
 * confirming, and a legitimate keepsake taken down by three coordinated
 * reporters that needs restoring — because from here they are
 * indistinguishable, and both want the same next step: a human, within
 * hours.
 */
const AUTOHIDDEN_SAMPLE_LIMIT = 20;

interface AutohiddenRow {
  listing_id: string;
  report_count: number;
  autohidden_at: number;
}

interface NearThresholdRow {
  listing_id: string;
  report_count: number;
}

/**
 * "Auto-hidden and nobody has looked" is `status = 'hidden'` plus a
 * `report_autohide` event with no `kind = 'admin'` event at or after it.
 * Deriving it from `moderation_events` rather than from a time window is
 * what makes it self-clearing and non-nagging: every admin action on the
 * listing (`logAdminEvent`) writes a newer `admin` row, so approving,
 * restoring, rejecting or re-hiding it all take it off this list, while a
 * listing nobody touches stays on it however many days pass. A hide an
 * admin performed by hand never appears here at all — it has no
 * `report_autohide` event to join against.
 */
async function fetchReportPressure(env: Env): Promise<AdminHealth["report_pressure"]> {
  const threshold = reportAutohideThreshold(env);

  const { results: autohiddenRows } = await env.DB.prepare(
    `SELECT l.id AS listing_id, l.report_count AS report_count, MAX(e.created_at) AS autohidden_at
       FROM listings l
       JOIN moderation_events e ON e.listing_id = l.id AND e.kind = 'report_autohide'
      WHERE l.status = 'hidden'
        AND NOT EXISTS (
              SELECT 1 FROM moderation_events a
               WHERE a.listing_id = l.id AND a.kind = 'admin' AND a.created_at >= e.created_at)
      GROUP BY l.id, l.report_count
      ORDER BY autohidden_at DESC
      LIMIT ?`,
  )
    .bind(AUTOHIDDEN_SAMPLE_LIMIT)
    .all<AutohiddenRow>();

  // `threshold - 1` rather than "any reports at all": this is the set where
  // one more stranger takes the listing down, which is the only count that
  // gives a moderator time to act *before* a legitimate keepsake disappears.
  // Floored at 1 so a misconfigured `REPORT_AUTOHIDE_THRESHOLD=1` doesn't
  // turn this into "every approved listing".
  const nearFloor = Math.max(threshold - 1, 1);
  const { results: nearRows } = await env.DB.prepare(
    `SELECT id AS listing_id, report_count
       FROM listings
      WHERE status = 'approved' AND report_count >= ?
      ORDER BY report_count DESC, updated_at DESC
      LIMIT ?`,
  )
    .bind(nearFloor, AUTOHIDDEN_SAMPLE_LIMIT)
    .all<NearThresholdRow>();

  return {
    threshold,
    autohidden_awaiting_review: autohiddenRows.map((row) => ({
      listing_id: row.listing_id,
      report_count: row.report_count,
      autohidden_at: row.autohidden_at,
    })),
    near_threshold: nearRows.map((row) => ({ listing_id: row.listing_id, report_count: row.report_count })),
  };
}

adminRoutes.get("/health", async (c) => {
  const postalCountRow = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM postal_codes").first<{ count: number }>();
  const postalCodesCount = postalCountRow?.count ?? 0;
  if (postalCodesCount === 0) {
    console.warn("admin/health: postal_codes table is empty — geo lookups will 404 for every postcode");
  }

  const now = Date.now();
  // `null` counts as stale too. A cron that has never once written its
  // heartbeat is not a neutral state — it is the same observable situation
  // as a cron that stopped, and on a fresh environment it clears itself
  // within one tick. That rule lives in `readCronHeartbeats` so this
  // endpoint and the daily digest cannot come to different conclusions
  // about the same KV keys.
  const heartbeats = await readCronHeartbeats(c.env.KV, now);
  const cronLastRun: Record<string, number | null> = Object.fromEntries(
    heartbeats.map((beat) => [beat.name, beat.last_run_at]),
  );
  const staleCrons = heartbeats.filter((beat) => beat.stale).map((beat) => beat.name);

  if (staleCrons.length > 0) {
    console.warn("admin/health: cron heartbeat stale", { crons: staleCrons, cronLastRun });
  }

  const reportPressure = await fetchReportPressure(c.env);
  if (reportPressure.autohidden_awaiting_review.length > 0) {
    // Same level and shape as the cron warning above, so one Workers Logs
    // filter (`level = "warn"` on this Worker) catches every "needs a human"
    // signal this endpoint knows about rather than one per feature.
    console.warn("admin/health: listings auto-hidden by reports await review", {
      count: reportPressure.autohidden_awaiting_review.length,
      listing_ids: reportPressure.autohidden_awaiting_review.map((entry) => entry.listing_id),
    });
  }

  const health: AdminHealth = {
    ok: postalCodesCount > 0 && staleCrons.length === 0 && reportPressure.autohidden_awaiting_review.length === 0,
    postal_codes_count: postalCodesCount,
    cron_last_run: cronLastRun,
    report_pressure: reportPressure,
  };
  return ok(c, health);
});

// ---------------------------------------------------------------------------
// POST /api/admin/test-email
// ---------------------------------------------------------------------------
/**
 * Sends a real message through the real `sendMail()` path — not a stub, not
 * a dry run — to whatever address is given, and reports back exactly what
 * happened. Launch-audit finding: email failures are invisible, and
 * production has never delivered to anyone but Kiarash. `leapkg@gmail.com`
 * is on the preview allowlist (`wrangler.toml`) specifically so this
 * endpoint has a second real inbox to prove delivery against.
 *
 * `to` is any address `MailableEmailSchema` accepts, deliberately — the
 * whole value of this route is aiming it at a real external inbox on demand,
 * so it must never be pinned to a fixed test address.
 *
 * The response is sized for the one thing a human can do that this Worker
 * cannot: read an inbox. `{sent: false}` alone sends them back to the logs,
 * so this also carries the provider's raw `detail`, the `EMAIL_MODE` that
 * decided a `blocked_*` reason, the domain addressed, and the `email_events`
 * row id — enough to tell a binding-level refusal from a bad address, and to
 * paste an exact row back into issue #6 as evidence. Admin-authenticated
 * (see the `.use("*", ...)` above); `detail` never appears on a public
 * surface.
 */
adminRoutes.post("/test-email", validateBody(AdminTestEmailInput), async (c) => {
  const input = c.get("validatedBody") as AdminTestEmailInput;
  const outcome = await sendMail(c.env, { kind: "admin_test", to: input.to, ...adminTestTemplate() });
  const result: AdminTestEmailResult = {
    sent: outcome.sent,
    reason: outcome.reason ?? null,
    detail: outcome.detail ?? null,
    provider: emailProviderName(c.env) ?? "unset",
    email_mode: (c.env.EMAIL_MODE ?? "").trim().toLowerCase() || "unset",
    to_domain: recipientDomain(input.to),
    event_id: outcome.eventId ?? null,
    at: Date.now(),
  };
  return ok(c, result);
});

// ---------------------------------------------------------------------------
// POST /api/admin/test-error — DIAGNOSTIC ONLY, not part of the product API.
// ---------------------------------------------------------------------------
/**
 * Issue #14 removed `@sentry/cloudflare` in favor of Workers Logs
 * (`[observability]` in `wrangler.toml`) — a unit test asserting
 * `captureException`/`captureMessage`'s return value only proves the pure
 * function ran, not that an event reaches Cloudflare's log pipeline. This
 * route deliberately captures a synthetic failure through the real
 * `@keepsake/observability/capture` path so the whole thing can be exercised
 * against a real deployed Worker — hit it, then check `wrangler tail` or the
 * Workers Logs dashboard for the `event: "capture"` line. Same
 * `burst("RL_ADMIN")` + `adminAuth()` guard as every other route on this
 * router (see the `.use("*", ...)` above); never call this from product
 * code, and never wire a client button to it.
 */
adminRoutes.post("/test-error", validateBody(AdminTestErrorInput), async (c) => {
  const input = c.get("validatedBody") as AdminTestErrorInput;
  if (input.kind === "message") {
    captureMessage("Keepsake admin/test-error: synthetic warning message", "warning", {
      tags: { source: "admin_test_error" },
    });
  } else {
    captureException(new Error("Keepsake admin/test-error: synthetic exception"), {
      tags: { source: "admin_test_error" },
    });
  }
  const result: AdminTestErrorResult = { captured: true, kind: input.kind };
  return ok(c, result);
});

// ---------------------------------------------------------------------------
// POST /api/admin/backfill-aspects
// ---------------------------------------------------------------------------
/**
 * Issue #37: one batch of the aspects backfill (`src/backfill/aspects.ts` —
 * see that file's header comment for the full design, including why a
 * legitimate zero-aspect result and "never attempted" have to be tracked
 * separately). POST `{}` (or `{"limit": N}`) repeatedly — from a terminal, a
 * script, or just the same curl command run again — until
 * `AdminBackfillAspectsResult.remaining` reaches 0. Same
 * `burst("RL_ADMIN")` + `adminAuth()` guard as every other route on this
 * router; every listing it touches still goes through the same
 * `SUGGEST_DAILY_BUDGET` ceiling live traffic does; see `runAspectsBackfillBatch`.
 */
adminRoutes.post("/backfill-aspects", validateBody(AdminBackfillAspectsInput), async (c) => {
  const input = c.get("validatedBody") as AdminBackfillAspectsInput;
  const batch = await runAspectsBackfillBatch(c.env, input.limit);
  const result: AdminBackfillAspectsResult = {
    processed: batch.processed,
    with_aspects: batch.withAspects,
    without_aspects: batch.withoutAspects,
    failed: batch.failed,
    budget_exhausted: batch.budgetExhausted,
    remaining: batch.remaining,
  };
  return ok(c, result);
});

// ---------------------------------------------------------------------------
// GET /api/admin/observatory
// ---------------------------------------------------------------------------
/**
 * The system-level view: traffic, throughput, the give→get funnel, the
 * moderation queue's age, recent errors, and today's digest — one payload,
 * one round trip, one auth gate.
 *
 * Deliberately separate from `/stats` and `/health` rather than folded into
 * them, because the three answer different questions and are read at
 * different moments. `/health` is a liveness verdict a monitor polls;
 * `/stats` is the strip above the moderation queue; this is the thing you
 * open when you want to know how the site is *doing*. Merging them would
 * have meant either making the cheap endpoints expensive or making this one
 * shallow.
 *
 * ## Failure isolation
 *
 * The three sections fail independently and on purpose. `app` comes from D1
 * and is awaited normally — if that throws, the request 500s, because a
 * Worker that cannot read its own database has nothing useful to render.
 * `edge` and `logs` call out to Cloudflare's API and can be unconfigured,
 * slow, or rejected; both are wrapped in `ObservatorySource` by the client
 * module and neither can throw, so a revoked telemetry token degrades two
 * panels instead of taking down the page. `Promise.all` is still correct
 * here — the two telemetry calls resolve to error *values*, never rejections.
 *
 * The window is clamped by `ObservatoryQuery` to 1, 7 or 30 days; see the
 * schema for why it is a closed set. Note the logs half silently clamps
 * further to Workers Logs' 3-day Free-plan retention and reports the window
 * it actually used, rather than labelling three days of data as thirty.
 */
adminRoutes.get("/observatory", validateQuery(ObservatoryQuery), async (c) => {
  const query = c.get("validatedQuery") as ObservatoryQuery;
  const windowDays = query.window_days;
  const now = Date.now();

  const [app, edge, logs, report] = await Promise.all([
    buildAppMetrics(c.env, windowDays, now),
    fetchEdgeTelemetry(c.env, windowDays, now),
    fetchLogTelemetry(c.env, windowDays, now),
    buildDailyReport(c.env, now),
  ]);

  const observatory: Observatory = {
    generated_at: now,
    environment: c.env.ENVIRONMENT as string,
    commit: c.env.COMMIT_SHA as string,
    window_days: windowDays,
    app,
    edge,
    logs,
    report,
  };
  return ok(c, observatory);
});
