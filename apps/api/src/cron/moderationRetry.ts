// Pending listings whose moderation call errored, hit its daily budget, or
// never landed (Worker eviction mid-`waitUntil`, AI timeout) get re-run here
// on a 5-minute cron. `moderateListing` re-derives the attempt number from
// `moderation_events` itself and escalates to `needs_review` after 3 — see
// `src/moderation/pipeline.ts` and the cron table under "API (Hono,
// apps/api)" in the plan.
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

  for (const candidate of candidates) {
    await moderateListing(env, candidate.id, candidate.version);
  }
}
