// Estate bulk upload's recovery cron. `startSubmission` (src/bulk/submit.ts)
// records a durable `bulk_operations` row the moment a submission is
// accepted; this is what actually drives it to completion — the first
// attempt, and every retry after a crash, a Worker eviction mid-batch, or a
// lease that simply outlived its own invocation.
import { captureException } from "@keepsake/observability/capture";
import type { Env } from "../env.js";
import { runBulkOperation } from "../bulk/submit.js";

/** Matches the `LIMIT` in the candidate query below, not
 * `ITEMS_PER_INVOCATION` (which bounds *items* within one operation) — this
 * bounds how many *operations* one pass of this cron will even look at. */
const CANDIDATE_LIMIT = 10;

interface DueOperationRow {
  id: string;
  owner_id: string;
}

/**
 * Fairness rule: **at most one operation per owner per pass.** Without it, one
 * estate with several stuck or still-in-progress operations (a batch split
 * across more items than one invocation can finish, say) could occupy every
 * slot this cron has time for, starving every other owner's submission of a
 * turn until the greedy one finishes. Deduped in memory rather than in SQL —
 * candidates already arrive ordered `next_attempt_at ASC`, so keeping the
 * first one seen per `owner_id` and skipping the rest is exactly "the most
 * overdue operation for each owner, among the ones fetched" without a window
 * function.
 */
function dedupeByOwner(rows: readonly DueOperationRow[]): DueOperationRow[] {
  const seenOwners = new Set<string>();
  const selected: DueOperationRow[] = [];
  for (const row of rows) {
    if (seenOwners.has(row.owner_id)) continue;
    seenOwners.add(row.owner_id);
    selected.push(row);
  }
  return selected;
}

export async function bulkRunner(env: Env): Promise<void> {
  const now = Date.now();
  const { results: candidates } = await env.DB.prepare(
    `SELECT id, owner_id FROM bulk_operations
      WHERE status IN ('queued', 'running') AND next_attempt_at <= ?
        AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY next_attempt_at ASC
      LIMIT ?`,
  )
    .bind(now, now, CANDIDATE_LIMIT)
    .all<DueOperationRow>();

  const selected = dedupeByOwner(candidates);

  // Per operation, not per pass — the same reasoning `moderationRetry.ts`
  // documents at length: one operation that makes `runBulkOperation` throw
  // must not abort the pass, skip the heartbeat write in `runCron`, and then
  // do exactly the same thing again three minutes later, forever, with
  // nothing reported anywhere. Every other operation in this pass still gets
  // its turn.
  let failed = 0;
  for (const candidate of selected) {
    try {
      await runBulkOperation(env, candidate.id);
    } catch (err) {
      failed += 1;
      console.error("bulkRunner: operation failed", {
        operationId: candidate.id,
        ownerId: candidate.owner_id,
        error: err instanceof Error ? err.message : String(err),
      });
      captureException(err, { tags: { cron: "bulkRunner" }, extra: { operationId: candidate.id } });
    }
  }

  if (failed > 0) {
    console.warn("bulkRunner: pass finished with failures", { failed, total: selected.length });
  }

  // No heartbeat write here — same as every other cron since #165. `runCron`
  // in `index.ts` writes `cron:last:bulkRunner` the moment this function
  // resolves, which is what `GET /api/admin/health` reads. Returning
  // normally from a pass in which individual operations failed is
  // deliberate: the heartbeat answers "did the sweep run", per-operation
  // failures are answered by the captures above.
}
