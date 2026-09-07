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
  AdminBanInput,
  AdminHideInput,
  AdminQueueQuery,
  AdminRejectInput,
  AdminRemoveRequestInput,
  AdminTestEmailInput,
  AdminTestErrorInput,
  type AdminHealth,
  type AdminQueueItem,
  type AdminRequestRemoveResult,
  type AdminRequestView,
  type AdminStats,
  type AdminTestEmailResult,
  type AdminTestErrorResult,
} from "@keepsake/contracts/admin";
import { LISTING_STATUSES, type ListingStatus, type OwnerListing } from "@keepsake/contracts/listing";
import type { FeedPage } from "@keepsake/contracts/feed";
import { maskEmail, type RequestStatus } from "@keepsake/contracts/request";
import type { ReportReason } from "@keepsake/contracts/report";
import { captureException, captureMessage } from "@keepsake/observability/capture";
import type { Env } from "../env.js";
import { emailProviderName } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { ulid } from "../lib/ids.js";
import { requireParam } from "../lib/params.js";
import { todayISO } from "../lib/day.js";
import { adminAuth } from "../middleware/adminAuth.js";
import { burst } from "../middleware/rateLimit.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { decodeKeysetCursor, encodeKeysetCursor } from "../lib/cursor.js";
import { fetchAspectRows, fetchListingRow, fetchPhotoRows } from "../lib/listingsDb.js";
import { serializeOwnerListing, type ListingRow } from "../lib/serialize.js";
import { sendMail } from "../email/sendMail.js";
import { adminTest as adminTestTemplate } from "../email/templates/adminTest.js";

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
    const aspects = await fetchAspectRows(c.env, row.id);
    const ownerListing = serializeOwnerListing(row, photos, aspects);

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

interface EmailEventGroupRow {
  ok: number;
  error: string | null;
  count: number;
}

async function fetchEmailEventStats(env: Env, now: number): Promise<AdminStats["email_events_7d"]> {
  const windowStart = now - EMAIL_EVENTS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const { results: rows } = await env.DB.prepare(
    "SELECT ok, error, COUNT(*) AS count FROM email_events WHERE created_at >= ? GROUP BY ok, error",
  )
    .bind(windowStart)
    .all<EmailEventGroupRow>();

  let total = 0;
  let okCount = 0;
  let failed = 0;
  const byError: { error: string; count: number }[] = [];
  for (const row of rows) {
    total += row.count;
    if (row.ok) {
      okCount += row.count;
    } else {
      failed += row.count;
      byError.push({ error: row.error ?? "(unspecified)", count: row.count });
    }
  }
  byError.sort((a, b) => b.count - a.count);

  return { window_days: EMAIL_EVENTS_WINDOW_DAYS, total, ok: okCount, failed, by_error: byError };
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
const CRON_STALE_AFTER_MS: Record<string, number> = {
  moderationRetry: 30 * 60 * 1000,
  orphanSweep: 26 * 60 * 60 * 1000,
};

const CRON_JOB_NAMES = ["moderationRetry", "orphanSweep"] as const;

adminRoutes.get("/health", async (c) => {
  const postalCountRow = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM postal_codes").first<{ count: number }>();
  const postalCodesCount = postalCountRow?.count ?? 0;
  if (postalCodesCount === 0) {
    console.warn("admin/health: postal_codes table is empty — geo lookups will 404 for every postcode");
  }

  const now = Date.now();
  const cronLastRun: Record<string, number | null> = {};
  const staleCrons: string[] = [];
  for (const name of CRON_JOB_NAMES) {
    const value = await c.env.KV.get(`cron:last:${name}`);
    const lastRun = value ? Number.parseInt(value, 10) : null;
    cronLastRun[name] = Number.isFinite(lastRun) ? lastRun : null;
    // `null` counts as stale too. A cron that has never once written its
    // heartbeat is not a neutral state — it is the same observable situation
    // as a cron that stopped, and on a fresh environment it clears itself
    // within one tick.
    const staleAfter = CRON_STALE_AFTER_MS[name] ?? 26 * 60 * 60 * 1000;
    if (cronLastRun[name] === null || now - (cronLastRun[name] ?? 0) > staleAfter) {
      staleCrons.push(name);
    }
  }

  if (staleCrons.length > 0) {
    console.warn("admin/health: cron heartbeat stale", { crons: staleCrons, cronLastRun });
  }

  const health: AdminHealth = {
    ok: postalCodesCount > 0 && staleCrons.length === 0,
    postal_codes_count: postalCodesCount,
    cron_last_run: cronLastRun,
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
 */
adminRoutes.post("/test-email", validateBody(AdminTestEmailInput), async (c) => {
  const input = c.get("validatedBody") as AdminTestEmailInput;
  const outcome = await sendMail(c.env, { kind: "admin_test", to: input.to, ...adminTestTemplate() });
  const result: AdminTestEmailResult = {
    sent: outcome.sent,
    reason: outcome.reason ?? null,
    provider: emailProviderName(c.env) ?? "unset",
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
