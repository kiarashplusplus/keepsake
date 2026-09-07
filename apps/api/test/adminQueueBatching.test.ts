/**
 * `GET /api/admin/queue` used to issue five queries *per row* (photos,
 * aspects, owner, moderation events, reports) on top of the one that
 * selected the page — a query storm that grew linearly with page size (#91,
 * an N+1 deliberately deferred when launch-audit finding 13 was fixed).
 *
 * The guard that keeps it from coming back is the statement counter below:
 * it wraps the D1 binding, serves the same seeded queue at two very
 * different page sizes, and asserts the endpoint used *exactly the same
 * number of prepared statements* for both. A test that only asserts the
 * response body is correct would go on passing through a reintroduced
 * per-row query, which is precisely how this regressed once already.
 *
 * The second half proves the batching didn't quietly change what the admin
 * page receives: a reference implementation of the old per-row loop runs
 * against the same seeded data and its JSON is compared to the endpoint's
 * byte for byte, key order included.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminQueueItem } from "@keepsake/contracts/admin";
import type { FeedPage } from "@keepsake/contracts/feed";
import type { Aspect } from "@keepsake/contracts/listing";
import { maskEmail } from "@keepsake/contracts/request";
import type { ReportReason } from "@keepsake/contracts/report";
import { encodeKeysetCursor } from "../src/lib/cursor.js";
import { ulid } from "../src/lib/ids.js";
import { serializeOwnerListing, type ListingRow, type PhotoRow } from "../src/lib/serialize.js";
import { freshClientIp, readOk, setTestEnvVar } from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-queue-batching";

// Each test below seeds under a *different* `status` (`needs_review`,
// `hidden`, `pending`) so it owns its own slice of the file-shared D1 state
// — storage is isolated per test file, not per test — and the queue's own
// `WHERE status = ?` keeps the three sets apart.
function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, "CF-Connecting-IP": freshClientIp() };
}

// ---------------------------------------------------------------------------
// D1 statement counter
//
// `SELF` and this test file share one `env` object (the same seam
// `installFakeEmail`/`installDenyingRateLimiter` in helpers.ts use), so
// swapping `env.DB` for a thin recorder counts the statements the *handler*
// prepares, not the ones this file prepares while seeding.
// ---------------------------------------------------------------------------
interface StatementCounter {
  statements: string[];
  restore: () => void;
}

function installStatementCounter(): StatementCounter {
  const bindings = env as unknown as Record<string, unknown>;
  const real = bindings.DB as D1Database;
  const statements: string[] = [];
  const recorder = {
    prepare(sql: string) {
      statements.push(sql);
      return real.prepare(sql);
    },
    batch<T = unknown>(stmts: D1PreparedStatement[]) {
      return real.batch<T>(stmts);
    },
    exec(sql: string) {
      return real.exec(sql);
    },
    dump() {
      return real.dump();
    },
    withSession(constraintOrBookmark?: string) {
      return real.withSession(constraintOrBookmark);
    },
  };
  bindings.DB = recorder;
  return {
    statements,
    restore: () => {
      bindings.DB = real;
    },
  };
}

/** Serves the queue once with the D1 binding wrapped, returning both the
 * decoded page and every SQL string the handler prepared. */
async function fetchQueueCountingStatements(status: string, limit: number): Promise<{ page: FeedPage<AdminQueueItem>; statements: string[] }> {
  const counter = installStatementCounter();
  try {
    const res = await SELF.fetch(`http://x/api/admin/queue?status=${status}&limit=${limit}`, { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const page = await readOk<FeedPage<AdminQueueItem>>(res);
    return { page, statements: [...counter.statements] };
  } finally {
    counter.restore();
  }
}

// ---------------------------------------------------------------------------
// Seeding — every timestamp explicit so both the page order (`updated_at
// DESC, id DESC`) and the child order (`position` / `created_at`) are fully
// determined by the data rather than by insertion luck.
// ---------------------------------------------------------------------------
const BASE_TIME = 1_760_000_000_000;

async function seedOwner(index: number, options: { email?: string | null; verified?: boolean; banned?: boolean } = {}): Promise<string> {
  const id = ulid();
  const now = BASE_TIME + index;
  await env.DB.prepare(
    "INSERT INTO owners (id, token_hash, email, email_verified_at, banned_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      `queue-batching-hash-${id}`,
      options.email === undefined ? `owner${index}@keepsake.ing` : options.email,
      options.verified === false ? null : now,
      options.banned ? now : null,
      now,
      now,
    )
    .run();
  return id;
}

interface SeedListingOptions {
  status: string;
  ownerId: string;
  index: number;
  photos?: number;
  aspects?: number;
  events?: number;
  reports?: number;
  /** All moderation events share one `created_at`, for the tie test. */
  tiedEventTimes?: boolean;
}

async function seedListing(options: SeedListingOptions): Promise<string> {
  const id = ulid();
  // Descending `updated_at` per index, so the page order is `index` order.
  const updatedAt = BASE_TIME + 1_000_000 - options.index * 1_000;
  await env.DB.prepare(
    `INSERT INTO listings
       (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
        status, moderation_reason, version, report_count, request_count, chosen_request_id,
        created_at, updated_at, published_at, given_at)
     VALUES (?, ?, ?, ?, 'home_kitchen', 'US', '02144', 'Somerville', 'MA', 42.3958, -71.0967,
             ?, ?, 3, ?, 2, NULL, ?, ?, ?, NULL)`,
  )
    .bind(
      id,
      options.ownerId,
      `Queue item ${options.index}`,
      `A story for queue item ${options.index}, long enough to look like the real thing.`,
      options.status,
      options.index % 2 === 0 ? "held_for_review" : null,
      options.reports ?? 0,
      BASE_TIME,
      updatedAt,
      BASE_TIME,
    )
    .run();

  for (let p = 0; p < (options.photos ?? 2); p++) {
    await env.DB.prepare(
      `INSERT INTO photos (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'image/jpeg', ?)`,
    )
      .bind(ulid(), options.ownerId, id, p, `photos/x/full-${p}.jpg`, `photos/x/thumb-${p}.jpg`, 800 + p, 600 + p, 1234, `blur-${options.index}-${p}`, BASE_TIME)
      .run();
  }

  for (let a = 0; a < (options.aspects ?? 2); a++) {
    await env.DB.prepare("INSERT INTO listing_aspects (id, listing_id, name, value, position, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(ulid(), id, `aspect${a}`, `value-${options.index}-${a}`, a, BASE_TIME)
      .run();
  }

  for (let e = 0; e < (options.events ?? 2); e++) {
    await env.DB.prepare(
      `INSERT INTO moderation_events (id, listing_id, listing_version, photo_id, kind, model, verdict, flags_json, reason, attempt, created_at)
       VALUES (?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        ulid(),
        id,
        e === 0 ? "text" : "decision",
        e === 0 ? "@cf/meta/llama" : null,
        e === 0 ? "pass" : "needs_review",
        e === 0 ? '{"sexual":0.1}' : null,
        e === 0 ? null : "held_for_review",
        e + 1,
        options.tiedEventTimes ? BASE_TIME : BASE_TIME + e * 10,
      )
      .run();
  }

  for (let r = 0; r < (options.reports ?? 0); r++) {
    await env.DB.prepare("INSERT INTO reports (id, listing_id, reason, details, ip_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(ulid(), id, r === 0 ? "spam" : "personal_info", r === 0 ? null : `details ${r}`, `digest-${id}-${r}`, BASE_TIME + r * 10)
      .run();
  }

  return id;
}

// ---------------------------------------------------------------------------
// Reference implementation of the pre-#91 per-row loop, run against the same
// seeded rows so the batched handler's JSON can be compared to it directly.
// ---------------------------------------------------------------------------
function safeParseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function referenceQueuePage(status: string, limit: number): Promise<FeedPage<AdminQueueItem>> {
  const { results: rows } = await env.DB.prepare(
    `SELECT id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
            status, moderation_reason, version, report_count, request_count, chosen_request_id,
            created_at, updated_at, published_at, given_at
     FROM listings WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
  )
    .bind(status, limit)
    .all<ListingRow>();

  const items: AdminQueueItem[] = [];
  for (const row of rows) {
    const { results: photos } = await env.DB.prepare("SELECT id, width, height, blurhash FROM photos WHERE listing_id = ? ORDER BY position")
      .bind(row.id)
      .all<PhotoRow>();
    const { results: aspects } = await env.DB.prepare("SELECT name, value FROM listing_aspects WHERE listing_id = ? ORDER BY position")
      .bind(row.id)
      .all<Aspect>();
    const ownerListing = serializeOwnerListing(row, photos, aspects);

    const ownerRow = await env.DB.prepare("SELECT id, email, email_verified_at, banned_at FROM owners WHERE id = ?")
      .bind(row.owner_id)
      .first<{ id: string; email: string | null; email_verified_at: number | null; banned_at: number | null }>();

    const { results: eventRows } = await env.DB.prepare(
      "SELECT kind, model, verdict, flags_json, reason, attempt, latency_ms, created_at FROM moderation_events WHERE listing_id = ? ORDER BY created_at",
    )
      .bind(row.id)
      .all<{ kind: string; model: string | null; verdict: string; flags_json: string | null; reason: string | null; attempt: number; latency_ms: number | null; created_at: number }>();

    const { results: reportRows } = await env.DB.prepare("SELECT reason, details, created_at FROM reports WHERE listing_id = ? ORDER BY created_at")
      .bind(row.id)
      .all<{ reason: string; details: string | null; created_at: number }>();

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
  const next_cursor = rows.length === limit && last ? encodeKeysetCursor(last.updated_at, last.id) : null;
  return { items, next_cursor };
}

describe("GET /api/admin/queue query budget (#91)", () => {
  afterEach(() => setTestEnvVar("ADMIN_TOKEN", ""));

  it("uses the same number of D1 statements for a 1-row page and a 20-row page", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    // Two owners across twenty listings, so the batched owner lookup has to
    // de-duplicate rather than accidentally scaling with the page.
    const ownerA = await seedOwner(1);
    const ownerB = await seedOwner(2, { email: null, verified: false, banned: true });
    for (let i = 0; i < 20; i++) {
      await seedListing({ status: "needs_review", ownerId: i % 2 === 0 ? ownerA : ownerB, index: i, photos: 2, aspects: 2, events: 2, reports: i % 3 });
    }

    const small = await fetchQueueCountingStatements("needs_review", 1);
    const large = await fetchQueueCountingStatements("needs_review", 20);

    expect(small.page.items).toHaveLength(1);
    expect(large.page.items).toHaveLength(20);

    const message = `1-row page used ${small.statements.length} statements, 20-row page used ${large.statements.length}:\n${large.statements.join("\n")}`;
    expect(large.statements.length, message).toBe(small.statements.length);
    // Belt and braces: the whole page must fit in a handful of statements —
    // one for the page plus one per child table. If someone adds a sixth
    // child collection they should batch it too, not loop it.
    expect(large.statements.length, message).toBeLessThanOrEqual(8);
  });

  it("serves a byte-identical page to the pre-batching per-row implementation", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerVerified = await seedOwner(11);
    const ownerAnonymous = await seedOwner(12, { email: null, verified: false });
    const ownerBanned = await seedOwner(13, { banned: true });
    const owners = [ownerVerified, ownerAnonymous, ownerBanned];
    for (let i = 0; i < 6; i++) {
      await seedListing({
        status: "hidden",
        ownerId: owners[i % owners.length] ?? ownerVerified,
        index: 100 + i,
        // Deliberately ragged: a listing with no photos, one with no
        // aspects, one with no events and one with no reports all have to
        // come back as empty arrays, not as a missing key or a hole.
        photos: i % 3,
        aspects: (i + 1) % 3,
        events: (i + 2) % 3,
        reports: i % 2,
      });
    }

    const expected = await referenceQueuePage("hidden", 6);
    const res = await SELF.fetch("http://x/api/admin/queue?status=hidden&limit=6", { headers: adminHeaders() });
    const actual = await readOk<FeedPage<AdminQueueItem>>(res);

    expect(expected.items).toHaveLength(6);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });

  it("orders moderation events deterministically when their timestamps tie", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const ownerId = await seedOwner(21);
    await seedListing({ status: "pending", ownerId, index: 200, photos: 1, aspects: 1, events: 3, reports: 0, tiedEventTimes: true });

    const first = await SELF.fetch("http://x/api/admin/queue?status=pending&limit=5", { headers: adminHeaders() });
    const firstPage = await readOk<FeedPage<AdminQueueItem>>(first);
    const second = await SELF.fetch("http://x/api/admin/queue?status=pending&limit=5", { headers: adminHeaders() });
    const secondPage = await readOk<FeedPage<AdminQueueItem>>(second);

    expect(firstPage.items[0]?.events).toHaveLength(3);
    expect(JSON.stringify(firstPage)).toBe(JSON.stringify(secondPage));
  });
});
