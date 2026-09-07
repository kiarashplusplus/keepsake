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
const BATCH_SIZE = 50;

interface CandidateRow {
  id: string;
  version: number;
}

export async function moderationRetry(env: Env): Promise<void> {
  const cutoff = Date.now() - STALE_MS;
  const { results: candidates } = await env.DB.prepare(
    `SELECT id, version FROM listings WHERE status = 'pending' AND updated_at <= ? ORDER BY updated_at ASC LIMIT ?`,
  )
    .bind(cutoff, BATCH_SIZE)
    .all<CandidateRow>();

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

  // Read by `GET /api/admin/health` (`cron:last:<name>`) so a stalled cron
  // trigger is visible from the admin page rather than inferred from a
  // growing pile of stuck `pending` listings. Written after a completed pass,
  // including one where individual listings failed: the heartbeat answers
  // "did the sweep run", and per-listing failures are answered by the capture
  // events above. Conflating the two would mean one bad row could make the
  // whole cron look dead.
  await env.KV.put("cron:last:moderationRetry", String(Date.now()));
}
