/**
 * The Observatory's "recent error lines" panel, read from D1 (issue #159,
 * step 1).
 *
 * This used to be `fetchLogTelemetry` in `./cloudflare.ts`: two queries per
 * level against Cloudflare's Workers Observability API, needing
 * `CF_OBSERVATORY_TOKEN`, and — the reason it is gone — able to see only the
 * last **3 days**, because that is Workers Logs retention on the Free plan.
 * The panel whose entire job is answering "what went wrong" was blank about
 * anything older than 72 hours, which is the loss #159 calls the sharpest one
 * ("a Saturday incident diagnosed on Monday has no logs left").
 *
 * The rows now come from `error_events`, written by the Tail Worker
 * (`src/tail/errorEvents.ts`) and swept at 30 days by
 * `src/cron/errorEventSweep.ts`. Three consequences worth naming:
 *
 *  - the window the panel reports is the window it was asked for, up to the
 *    retention, rather than a silent clamp to 3 days;
 *  - it needs **no credential at all**, so it works locally and in tests and
 *    joins the D1-derived floor the rest of the Observatory already has;
 *  - the rows are already redacted at write time, and — unlike the Workers
 *    Logs feed, which surfaced any bare `console.error` verbatim — a line
 *    that never went through `capture.ts` has been through the redactor too.
 *
 * ## Why this still returns an `ObservatorySource`
 *
 * Because it can still be honestly empty for two entirely different reasons,
 * and one of them is not "nothing went wrong": until the Tail Worker is
 * deployed and named in this environment's `[[tail_consumers]]`, nothing ever
 * writes here. An empty table would then render as a calm panel on a Worker
 * whose errors are going nowhere — the confident-empty answer AGENTS.md calls
 * the most convincing wrong answer there is.
 *
 * `tail_deliveries` is what tells those apart. The tail consumer stamps it on
 * every delivery it receives, including the ones carrying nothing worth
 * keeping, so the row's existence is evidence that the pipeline is real and
 * this environment has actually been looked at. No row, no claim:
 * `unconfigured`, with a reason saying what to check.
 */
import type { ObservatoryLogEvent, ObservatoryLogs, ObservatorySource } from "@keepsake/contracts/observatory";
import type { Env } from "../env.js";
import { ERROR_EVENT_RETENTION_DAYS } from "../tail/errorEvents.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Most recent lines returned. A feed, not an archive — `counts` in the same
 * payload carries the magnitude, so this cap costs no information about *how
 * much* is wrong, only about the long tail of what. Kept at the number the
 * Workers Logs feed used, so the panel reads the same. */
const LOG_EVENT_LIMIT = 50;

interface EventRow {
  observed_at: number;
  level: string;
  message: string;
  script_name: string | null;
  environment: string | null;
  request_id: string | null;
}

export async function fetchPersistedLogs(
  env: Env,
  requestedWindowDays: number,
  now: number = Date.now(),
): Promise<ObservatorySource<ObservatoryLogs>> {
  // Clamped to the sweep's retention for the same reason the old
  // implementation clamped to Workers Logs' 3 days: a "30 days" label over
  // 14 days of rows is a lie the reader has no way to detect. Today the two
  // numbers are equal by construction (`ERROR_EVENT_RETENTION_DAYS` is 30,
  // `OBSERVATORY_WINDOWS`' widest is 30) and `test/tailErrorEvents.test.ts`
  // asserts that, so this clamp is a guard against a future retention cut
  // rather than something that fires today.
  const windowDays = Math.min(requestedWindowDays, ERROR_EVENT_RETENTION_DAYS);
  const since = now - windowDays * DAY_MS;

  try {
    const delivery = await env.DB.prepare("SELECT last_delivery_at FROM tail_deliveries WHERE id = 1").first<{
      last_delivery_at: number;
    }>();

    if (!delivery) {
      return {
        state: "unconfigured",
        reason:
          "No Tail Worker has ever delivered events to this database, so an empty feed would say nothing about " +
          "whether anything has gone wrong. Deploy keepsake-tail (apps/api/wrangler.tail.toml) and check this " +
          "environment's [[tail_consumers]] block in apps/api/wrangler.toml.",
      };
    }

    const [counts, events] = await Promise.all([
      env.DB.prepare("SELECT level, COUNT(*) AS n FROM error_events WHERE observed_at >= ? GROUP BY level")
        .bind(since)
        .all<{ level: string; n: number }>(),
      env.DB.prepare(
        `SELECT observed_at, level, message, script_name, environment, request_id
           FROM error_events
          WHERE observed_at >= ?
          ORDER BY observed_at DESC
          LIMIT ?`,
      )
        .bind(since, LOG_EVENT_LIMIT)
        .all<EventRow>(),
    ]);

    const byLevel = new Map((counts.results ?? []).map((row) => [row.level, row.n]));

    const feed: ObservatoryLogEvent[] = (events.results ?? []).map((row) => ({
      ts: row.observed_at,
      level: row.level,
      message: row.message,
      // The producing script (`keepsake-production`) where the trace item
      // carried one, falling back to the app-level environment a capture
      // line reports. Same preference order the Workers Logs reader used,
      // where `$metadata.service` was the script name and won over
      // `capture.ts`'s own `service` field.
      service: row.script_name ?? row.environment,
      request_id: row.request_id,
    }));

    return {
      state: "ok",
      data: {
        window_days: windowDays,
        counts: { error: byLevel.get("error") ?? 0, warning: byLevel.get("warning") ?? 0 },
        events: feed,
      },
    };
  } catch (err) {
    // A thrown D1 error here is nearly always one thing: the migration that
    // creates these tables has not been applied to this environment. Say so
    // as an error rather than an empty feed — this is the same distinction
    // `ObservatorySource` exists to keep.
    return {
      state: "error",
      error: `error_events read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
