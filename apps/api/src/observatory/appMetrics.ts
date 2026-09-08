/**
 * The half of the Observatory that needs no credential: everything derived
 * from D1.
 *
 * Kept apart from `./cloudflare.ts` on purpose. That module can be
 * unconfigured, can time out, and can be revoked out from under the page;
 * this one reads the same database every other route reads, so if it fails
 * the Worker has much larger problems than a dashboard. The split is what
 * lets `GET /api/admin/observatory` promise that its `app` section is always
 * present while `edge`/`logs` are wrapped in `ObservatorySource`.
 *
 * Every window here is a *calendar* window in UTC — `windowDays` days ending
 * with today — matching how `lib/day.ts` and `moderation/budget.ts` define a
 * day, and matching the `date` dimension Cloudflare's analytics groups by. A
 * rolling `now - N*24h` window would be marginally more precise and would
 * make the two series impossible to lay on one axis, which is the whole
 * point of collecting them together.
 */
import type {
  ObservatoryApp,
  ObservatoryAppDay,
  ObservatoryFunnel,
  ObservatoryModerationLatency,
  ObservatorySearchIndex,
} from "@keepsake/contracts/observatory";
import type { Env } from "../env.js";
import { semanticSearchEnabled } from "../env.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ceiling on how many per-listing decision latencies are pulled into the
 * Worker to compute a median. SQLite has no `median()` and no percentile
 * function, so the values have to come back and be sorted here; this bounds
 * that. At 2,000 the array is a few tens of kilobytes and the sort is
 * irrelevant next to the query itself, and a 30-day window would have to be
 * carrying ~66 decisions a day before the cap starts truncating — far past
 * the point where this dashboard stops being the right tool anyway. Ordered
 * newest-first before the cap applies, so what survives truncation is the
 * recent behaviour rather than an arbitrary slice.
 */
const LATENCY_SAMPLE_LIMIT = 2000;

/** `YYYY-MM-DD` for a UTC instant — same shape as `lib/day.ts`'s `todayISO`
 * and as Cloudflare's `date` dimension, so the two series join on the key
 * without either side converting. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Midnight UTC, `windowDays - 1` days before the day containing `now`. */
function windowStartMs(now: number, windowDays: number): number {
  return Date.parse(`${utcDate(now - (windowDays - 1) * DAY_MS)}T00:00:00Z`);
}

/**
 * Every day in the window, in order, seeded at zero.
 *
 * This is the reason the per-day queries below can use a plain `GROUP BY`
 * and still produce a gap-free series: a day on which nothing happened
 * produces no row, and a chart fed only the rows that exist silently closes
 * the gap and draws a continuous line across an outage. Days with no
 * activity have to be present and zero, and the only way to know they exist
 * is to enumerate them rather than to read them out of the data.
 */
function emptySeries(now: number, windowDays: number): Map<string, ObservatoryAppDay> {
  const series = new Map<string, ObservatoryAppDay>();
  const start = windowStartMs(now, windowDays);
  for (let i = 0; i < windowDays; i++) {
    const date = utcDate(start + i * DAY_MS);
    series.set(date, {
      date,
      listings_created: 0,
      listings_approved: 0,
      listings_rejected: 0,
      requests_created: 0,
      requests_chosen: 0,
      emails_ok: 0,
      emails_failed: 0,
    });
  }
  return series;
}

/**
 * SQLite's `date(x/1000, 'unixepoch')` renders a millisecond timestamp as
 * `YYYY-MM-DD` in UTC — `unixepoch` has no timezone of its own, which is
 * exactly what is wanted here and is why no `'localtime'` modifier appears
 * anywhere in this file. One helper so the integer division and the modifier
 * list are written once; a stray `'localtime'` in one of six queries would
 * shift a single series by up to a day against the others and would be
 * nearly invisible on a chart.
 */
const UTC_DAY = (column: string) => `date(${column} / 1000, 'unixepoch')`;

interface DayCountRow {
  day: string;
  count: number;
}

/** Folds a `GROUP BY day` result into the pre-seeded series. Rows for days
 * outside the window (possible if a query's own filter is looser than the
 * window) are dropped rather than appended, so the series length always
 * equals `windowDays`. */
function applyDayCounts(
  series: Map<string, ObservatoryAppDay>,
  rows: DayCountRow[],
  field: Exclude<keyof ObservatoryAppDay, "date">,
): void {
  for (const row of rows) {
    const day = series.get(row.day);
    if (day) day[field] = row.count;
  }
}

async function fetchDayCounts(env: Env, sql: string, since: number): Promise<DayCountRow[]> {
  const { results } = await env.DB.prepare(sql).bind(since).all<DayCountRow>();
  return results;
}

/**
 * The per-day series.
 *
 * `listings_approved`/`listings_rejected` come from `moderation_events`
 * rather than from the `listings` table, because `listings` records only the
 * *current* status and `updated_at`: a listing approved on Monday and hidden
 * on Friday would count as neither on Monday and as something else entirely
 * on Friday. The event log is the only place the day a decision was actually
 * made survives. `COUNT(DISTINCT listing_id)` because a listing can be
 * approved more than once (hide, then restore) and the interesting number is
 * how many keepsakes went live that day, not how many times the verdict was
 * written.
 *
 * Both `kind = 'decision'` (the model) and `kind = 'admin'` (Kiarash) are
 * counted: from the giver's side an approval is an approval, and splitting
 * them would make the series stop matching the count of listings that
 * actually became visible.
 */
async function fetchDaySeries(env: Env, now: number, windowDays: number): Promise<ObservatoryAppDay[]> {
  const series = emptySeries(now, windowDays);
  const since = windowStartMs(now, windowDays);

  const [created, approved, rejected, requested, chosen, emails] = await Promise.all([
    fetchDayCounts(
      env,
      `SELECT ${UTC_DAY("created_at")} AS day, COUNT(*) AS count FROM listings WHERE created_at >= ? GROUP BY day`,
      since,
    ),
    fetchDayCounts(
      env,
      `SELECT ${UTC_DAY("created_at")} AS day, COUNT(DISTINCT listing_id) AS count FROM moderation_events
        WHERE created_at >= ? AND kind IN ('decision', 'admin') AND verdict = 'approved' GROUP BY day`,
      since,
    ),
    fetchDayCounts(
      env,
      `SELECT ${UTC_DAY("created_at")} AS day, COUNT(DISTINCT listing_id) AS count FROM moderation_events
        WHERE created_at >= ? AND kind IN ('decision', 'admin') AND verdict = 'rejected' GROUP BY day`,
      since,
    ),
    fetchDayCounts(
      env,
      `SELECT ${UTC_DAY("created_at")} AS day, COUNT(*) AS count FROM requests WHERE created_at >= ? GROUP BY day`,
      since,
    ),
    // Keyed on `chosen_at`, not `created_at`: the day a giver chose someone
    // is the event, and it can be days after the request arrived.
    fetchDayCounts(
      env,
      `SELECT ${UTC_DAY("chosen_at")} AS day, COUNT(*) AS count FROM requests
        WHERE chosen_at IS NOT NULL AND chosen_at >= ? GROUP BY day`,
      since,
    ),
    env.DB.prepare(
      `SELECT ${UTC_DAY("created_at")} AS day, ok, COUNT(*) AS count FROM email_events
        WHERE created_at >= ? GROUP BY day, ok`,
    )
      .bind(since)
      .all<{ day: string; ok: number; count: number }>(),
  ]);

  applyDayCounts(series, created, "listings_created");
  applyDayCounts(series, approved, "listings_approved");
  applyDayCounts(series, rejected, "listings_rejected");
  applyDayCounts(series, requested, "requests_created");
  applyDayCounts(series, chosen, "requests_chosen");

  for (const row of emails.results) {
    const day = series.get(row.day);
    if (!day) continue;
    if (row.ok === 1) day.emails_ok = row.count;
    else day.emails_failed = row.count;
  }

  return [...series.values()];
}

/**
 * A *cohort* funnel, not a set of independent window counts.
 *
 * Every step after `photos_uploaded` is measured over the same set of
 * listings — those created inside the window — and asks what has since
 * become of them. The alternative (count approvals in the window, count
 * requests in the window) mixes cohorts: a listing created before the window
 * and chosen inside it would appear at the last step without ever appearing
 * at the first, and the funnel would be capable of widening as it goes,
 * which is not a funnel. It costs some recency — a listing created an hour
 * ago has not had time to be requested — and that is the honest trade,
 * because the other shape is not merely less precise but actively misleading.
 *
 * `photos_uploaded` is the one step that cannot be cohorted this way: a
 * photo that never became a listing has no listing to join to, and those
 * abandoned uploads are precisely what makes the first step interesting.
 * It is a straight window count, and it is the only one.
 */
async function fetchFunnel(env: Env, now: number, windowDays: number): Promise<ObservatoryFunnel> {
  const since = windowStartMs(now, windowDays);

  const [photos, listings] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM photos WHERE created_at >= ?").bind(since).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS created,
         SUM(CASE WHEN published_at IS NOT NULL THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN request_count > 0 THEN 1 ELSE 0 END) AS requested,
         SUM(CASE WHEN chosen_request_id IS NOT NULL THEN 1 ELSE 0 END) AS chosen
       FROM listings WHERE created_at >= ?`,
    )
      .bind(since)
      .first<{ created: number; approved: number | null; requested: number | null; chosen: number | null }>(),
  ]);

  return {
    window_days: windowDays,
    photos_uploaded: photos?.count ?? 0,
    listings_created: listings?.created ?? 0,
    // `SUM` over zero rows is NULL in SQLite, not 0 — an empty database
    // would otherwise render `null` where the funnel promises a number.
    listings_approved: listings?.approved ?? 0,
    listings_requested: listings?.requested ?? 0,
    listings_chosen: listings?.chosen ?? 0,
  };
}

/**
 * Queue state, and — the part that matters — how long the queue has been in
 * it.
 *
 * The two `oldest_*_age_ms` values are the verdict; the two counts are only
 * a level. Twenty listings that arrived in the last minute and one listing
 * stuck since Tuesday produce a similar-looking `pending` count and mean
 * entirely different things, and only the age separates them. Same reasoning
 * as `/api/admin/health`'s cron staleness check, which exists because a
 * heartbeat timestamp was being read and then ignored in favour of a count.
 *
 * `null` for an age means the queue is empty, which is genuinely different
 * from an age of zero and must not be rendered as one.
 */
/**
 * Median of an already-sorted, non-empty array; `null` for an empty one.
 *
 * `null` rather than `0` for "no samples", because the two say opposite
 * things: `0` would claim every listing was decided instantly, which is the
 * most flattering possible reading of "nothing happened". The even-length
 * case averages the two middle values rather than taking either, so the
 * result does not jump when a single sample arrives.
 */
function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) return null;
  return Math.round((lower + upper) / 2);
}

async function fetchModerationLatency(env: Env, now: number, windowDays: number): Promise<ObservatoryModerationLatency> {
  const since = windowStartMs(now, windowDays);

  const [queue, latencies] = await Promise.all([
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
         MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending,
         MIN(CASE WHEN status = 'needs_review' THEN created_at END) AS oldest_needs_review
       FROM listings WHERE status IN ('pending', 'needs_review')`,
    ).first<{
      pending: number | null;
      needs_review: number | null;
      oldest_pending: number | null;
      oldest_needs_review: number | null;
    }>(),
    // Time from a listing being created to the first decision written about
    // it. `MIN(e.created_at)` because the retry cron can write several
    // decision events for one listing and only the first one ended the wait.
    env.DB.prepare(
      `SELECT MIN(e.created_at) - l.created_at AS latency_ms
         FROM listings l
         JOIN moderation_events e ON e.listing_id = l.id AND e.kind = 'decision'
        WHERE l.created_at >= ?
        GROUP BY l.id
        ORDER BY l.created_at DESC
        LIMIT ?`,
    )
      .bind(since, LATENCY_SAMPLE_LIMIT)
      .all<{ latency_ms: number }>(),
  ]);

  const samples = latencies.results.map((row) => row.latency_ms).sort((a, b) => a - b);
  const median = medianOf(samples);

  return {
    pending: queue?.pending ?? 0,
    needs_review: queue?.needs_review ?? 0,
    oldest_pending_age_ms: queue?.oldest_pending == null ? null : now - queue.oldest_pending,
    oldest_needs_review_age_ms: queue?.oldest_needs_review == null ? null : now - queue.oldest_needs_review,
    median_time_to_decision_ms: median ?? null,
  };
}

/**
 * Issue #208. `listings.vector_indexed_at` was written by `search/reembed.ts`
 * and read by nothing — the second half of #180's fix, left unbuilt because
 * this file belonged to another session at the time. This is the reader.
 *
 * Scoped to `approved` listings on purpose: those are the ones a stranger can
 * find, so those are the ones whose ranking a missing vector actually
 * degrades. A `pending` listing with no vector yet is the pipeline working.
 *
 * `updated_at` rather than `created_at` for the age, because a re-embed
 * failure after an edit is as much a fault as never having been indexed, and
 * the edit is when the current text started being un-searchable.
 *
 * With `SEMANTIC_SEARCH` off there is no number worth rendering — see the
 * union's own doc comment in @keepsake/contracts/observatory.
 */
export async function fetchSearchIndex(env: Env, now: number): Promise<ObservatorySearchIndex> {
  if (!semanticSearchEnabled(env)) return { enabled: false };

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS approved,
            SUM(CASE WHEN vector_indexed_at IS NULL THEN 1 ELSE 0 END) AS unindexed,
            MIN(CASE WHEN vector_indexed_at IS NULL THEN updated_at END) AS oldest_unindexed
       FROM listings WHERE status = 'approved'`,
  ).first<{ approved: number | null; unindexed: number | null; oldest_unindexed: number | null }>();

  return {
    enabled: true,
    approved: row?.approved ?? 0,
    unindexed: row?.unindexed ?? 0,
    oldest_unindexed_age_ms: row?.oldest_unindexed == null ? null : now - row.oldest_unindexed,
  };
}

export async function buildAppMetrics(env: Env, windowDays: number, now: number = Date.now()): Promise<ObservatoryApp> {
  const [byDay, funnel, moderation, searchIndex] = await Promise.all([
    fetchDaySeries(env, now, windowDays),
    fetchFunnel(env, now, windowDays),
    fetchModerationLatency(env, now, windowDays),
    fetchSearchIndex(env, now),
  ]);

  return { window_days: windowDays, by_day: byDay, funnel, moderation, search_index: searchIndex };
}
