// Pending listings whose moderation call errored, hit its daily budget, or
// never landed (Worker eviction mid-`waitUntil`, AI timeout) get re-run here
// on a 5-minute cron. `moderateListing` re-derives the attempt number from
// `moderation_events` itself and escalates to `needs_review` after 3 — see
// `src/moderation/pipeline.ts` and the cron table under "API (Hono,
// apps/api)" in the plan.
import { captureException } from "@keepsake/observability/capture";
import type { Env } from "../env.js";
import { moderateListing } from "../moderation/pipeline.js";

/** A listing only stays `status = 'pending'` after moderation has already
 * run once for its current version if that run ended in `error`/budget
 * exhaustion — every other outcome (`approved`, `rejected`, `needs_review`)
 * moves it off `pending`. So this query doesn't need to inspect
 * `moderation_events` itself to know which listings need a retry. */
const STALE_MS = 2 * 60 * 1000;
/** How many listings one pass actually runs through `moderateListing`. Kept
 * at its original size — this cap is about *which* 50 get picked, not about
 * running more of them per pass. */
const BATCH_SIZE = 50;

/**
 * How many stale-pending rows the SQL query itself fetches, before the
 * per-owner cap below narrows them down to `BATCH_SIZE`. Must be bigger than
 * `BATCH_SIZE` or the cap has nothing to choose *between* — with an equal
 * `LIMIT`, one owner occupying the front of the `updated_at ASC` order
 * (exactly the estate-bulk case this exists for) could still fill the whole
 * window before any other owner's row is even fetched, same as today. 6x is
 * enough that a single owner sitting on `MAX_PER_OWNER_PER_PASS`-plus rows
 * still leaves five batches' worth of room for everyone else to surface
 * within the same query.
 */
const OVER_FETCH_LIMIT = BATCH_SIZE * 6;

/**
 * Fairness cap: **at most this many listings per owner per pass.** Without
 * it, a single bulk submission — 42 listings created within seconds of each
 * other, so near-identical `updated_at` values — fills most or all of every
 * pass's `BATCH_SIZE`, and an ordinary giver's one stuck listing waits behind
 * the entire estate for as many passes as it takes to drain it (`docs/design/
 * bulk-upload.md`'s "What is not paced"). 10 is small enough that even one
 * giant estate leaves at least 40 of the 50 slots to everyone else, and large
 * enough that a capped owner's own backlog still drains at a real pace across
 * passes rather than trickling one row every five minutes.
 */
const MAX_PER_OWNER_PER_PASS = 10;

interface CandidateRow {
  id: string;
  version: number;
  owner_id: string;
}

/**
 * Keep at most `maxPerOwner` rows per `owner_id`, in the order they arrived,
 * until `limit` total rows are kept. `bulkRunner.ts`'s `dedupeByOwner` is the
 * same idea one step stricter (exactly one per owner, no `limit` needed
 * because its candidate query is already small); this is its many-per-owner
 * generalization, so a single pass can still process real work from more
 * than one owner even when the flattest possible number for a healthy giver
 * — "everyone gets one" — would be too little to move a genuine backlog.
 *
 * Deduped in memory rather than in SQL, exactly like `dedupeByOwner`:
 * `candidates` already arrive ordered `updated_at ASC` (oldest-stale-first),
 * so keeping the first `maxPerOwner` seen per owner and skipping the rest is
 * "the `maxPerOwner` most-overdue listings for each owner, among the ones
 * fetched" without a window function.
 *
 * Skipped rows are not lost, only deferred. A capped owner's skipped rows
 * keep their `updated_at` untouched (this pass never calls `moderateListing`
 * on them, and nothing else writes to a `pending` listing outside that
 * call), so next pass's query surfaces them again — now among the *oldest*
 * stale-pending rows overall, since every row this pass *did* process just
 * had its `updated_at` bumped forward (a real attempt, successful or not,
 * always ends by writing a new status or a fresh `pending`/`budget` row —
 * see `setStatus` in `moderation/pipeline.ts` — and the one path that
 * doesn't, a mid-attempt AI error, leaves the row exactly where it was, which
 * is still correct: it's genuinely still the oldest and belongs at the front
 * again). So a 42-item estate drains 10 rows per pass rather than 0 or 42 —
 * never permanently stuck behind its own earlier rows, and never able to
 * push everyone else's rows out of every pass indefinitely either.
 */
function capPerOwner(rows: readonly CandidateRow[], maxPerOwner: number, limit: number): CandidateRow[] {
  const perOwnerCount = new Map<string, number>();
  const selected: CandidateRow[] = [];
  for (const row of rows) {
    if (selected.length >= limit) break;
    const count = perOwnerCount.get(row.owner_id) ?? 0;
    if (count >= maxPerOwner) continue;
    perOwnerCount.set(row.owner_id, count + 1);
    selected.push(row);
  }
  return selected;
}

export async function moderationRetry(env: Env): Promise<void> {
  const cutoff = Date.now() - STALE_MS;
  const { results: overFetched } = await env.DB.prepare(
    `SELECT id, version, owner_id FROM listings WHERE status = 'pending' AND updated_at <= ? ORDER BY updated_at ASC LIMIT ?`,
  )
    .bind(cutoff, OVER_FETCH_LIMIT)
    .all<CandidateRow>();

  const candidates = capPerOwner(overFetched, MAX_PER_OWNER_PER_PASS, BATCH_SIZE);

  // Per item, not per batch. Launch audit finding 12: this loop used to be a
  // bare `await` over 50 candidates, so one listing that made `moderateListing`
  // throw — a malformed row, an AI response the parser chokes on — aborted the
  // whole batch, skipped the heartbeat write below, and then did exactly the
  // same thing again five minutes later, forever, with nothing reported
  // anywhere. Every other listing in that batch stayed `pending` because of one
  // neighbour. Now a poisoned listing costs one capture event and its own
  // retry, and the other 49 still get their turn.
  let failed = 0;
  for (const candidate of candidates) {
    try {
      // No `clientIP`: the cron has no request to read one from, so a
      // budget-exhausted retry only draws from the general pool, never the
      // reserved floor (`moderation/pipeline.ts`, issue #18) — that floor is
      // for a fresh caller's first attempt, not a listing already stuck.
      await moderateListing(env, candidate.id, candidate.version);
    } catch (err) {
      failed += 1;
      console.error("moderationRetry: listing failed", {
        listingId: candidate.id,
        version: candidate.version,
        error: err instanceof Error ? err.message : String(err),
      });
      captureException(err, { tags: { cron: "moderationRetry" }, extra: { listingId: candidate.id } });
    }
  }

  if (failed > 0) {
    console.warn("moderationRetry: batch finished with failures", { failed, total: candidates.length });
  }

  // No heartbeat write here any more (#165). `runCron` in `index.ts` writes
  // `cron:last:moderationRetry` for this job the moment this function
  // resolves, which is what `GET /api/admin/health` reads. The property that
  // used to be stated here still holds and is why the per-item `try`/`catch`
  // above exists: returning normally from a pass in which individual
  // listings failed is deliberate, so the heartbeat answers "did the sweep
  // run" while per-listing failures are answered by the captures above. One
  // bad row must not make the whole cron look dead.
}
