/**
 * Retention for the Tail Worker's table (issue #159, step 1).
 *
 * `error_events` is the one table in this database nothing else ever prunes
 * and whose growth is driven by *failure* rather than by use — the worse of
 * the two shapes, because the day it grows fastest is the day nobody has
 * attention to spare for it. The per-minute ceiling in
 * `src/tail/errorEvents.ts` bounds the rate; this bounds the total.
 *
 * `ERROR_EVENT_RETENTION_DAYS` (30) is not a tidy round number, it is the
 * widest window `GET /api/admin/observatory` can be asked for
 * (`OBSERVATORY_WINDOWS`). Sweeping sooner would put a "30 days" label above
 * fewer days of rows, which is the failure `fetchEdgeTelemetry`'s own window
 * ceiling documents; `test/tailErrorEvents.test.ts` asserts the inequality
 * against the contract rather than trusting this paragraph.
 *
 * Modelled on `orphanSweep`, including its two habits worth copying: delete
 * in bounded batches so one run never holds a single enormous transaction,
 * and keep every condition purely time-based so re-running the job is a
 * no-op rather than a second, different deletion.
 *
 * Keyed on `received_at` (when this row was written) rather than
 * `observed_at` (when the producing Worker saw the failure). They differ by
 * seconds in practice, but only one of them is a clock this Worker controls:
 * a trace item carrying a nonsense timestamp — the far future, or zero —
 * would either be deleted immediately or never, and "never" is the direction
 * that turns a retention sweep into a table that grows forever. Since
 * `received_at >= observed_at` always, sweeping on it is strictly more
 * generous than the window the Observatory reads.
 */
import type { Env } from "../env.js";
import { ERROR_EVENT_RETENTION_MS } from "../tail/errorEvents.js";

const DELETE_BATCH_SIZE = 500;
/** Safety bound on batches per run — at 500 a batch that is 2.5M rows, far
 * past what the per-minute ceiling can produce in a month (86,400/day). It
 * exists only so a pathological table cannot turn one nightly tick into an
 * unbounded loop; whatever is left over goes tomorrow night. */
const MAX_DELETE_BATCHES = 5000;

export async function errorEventSweep(env: Env, now: number = Date.now()): Promise<void> {
  const cutoff = now - ERROR_EVENT_RETENTION_MS;
  let deleted = 0;

  for (let batch = 0; batch < MAX_DELETE_BATCHES; batch++) {
    // `DELETE ... LIMIT` needs a SQLite build option D1 does not promise, so
    // the bound goes on a subquery instead — the same shape the paged sweeps
    // in `orphanSweep` use. No `OFFSET` is needed: every row this statement
    // touches stops matching the `WHERE` immediately, so the next page's
    // identical query sees a strictly smaller backlog.
    const result = await env.DB.prepare(
      `DELETE FROM error_events
        WHERE id IN (SELECT id FROM error_events WHERE received_at < ? LIMIT ?)`,
    )
      .bind(cutoff, DELETE_BATCH_SIZE)
      .run();

    const changes = result.meta.changes ?? 0;
    deleted += changes;
    if (changes < DELETE_BATCH_SIZE) break;
  }

  console.log("errorEventSweep: done", {
    environment: env.ENVIRONMENT,
    deleted,
    // The cutoff is logged rather than the retention constant so a run's own
    // line says which rows it was entitled to remove, without the reader
    // having to know what the constant was at that deploy.
    cutoff,
  });

  // No heartbeat write here (#165): `runCron` in `index.ts` writes
  // `cron:last:errorEventSweep` when this resolves.
}
