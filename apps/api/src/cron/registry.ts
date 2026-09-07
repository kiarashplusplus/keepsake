/**
 * The one place a scheduled job is described: its name, the cron expression
 * that fires it, and how long its heartbeat may go unrefreshed before
 * something is wrong.
 *
 * Before this file those three facts lived in three places — the schedule in
 * `wrangler.toml`'s `[triggers] crons`, the dispatch in `index.ts`'s
 * `scheduled()` switch, and the staleness threshold in `routes/admin.ts`'s
 * `CRON_STALE_AFTER_MS` — with nothing tying them together except that
 * preflight's `cron-triggers` check compares the first two. Adding a third
 * job meant editing all three and hoping. The failure that shape produces is
 * quiet in the worst way: a job whose schedule was changed in `wrangler.toml`
 * but not in the switch stays registered with Cloudflare, fires exactly on
 * time, falls through to `default:`, and is recorded by the platform as a
 * *successful* invocation that did nothing.
 *
 * `wrangler.toml` still has to restate the schedules — Cloudflare reads that
 * file, not this one — but preflight asserts the two agree, so the
 * duplication is checked rather than trusted.
 */

/**
 * `cron` is matched against `ScheduledController.cron`, which Cloudflare
 * passes as the *literal string* from `wrangler.toml`. Whitespace and form
 * must match exactly: a five-minute schedule written with one space between
 * fields and the same schedule written with two are identical to a cron
 * parser and two different strings here.
 */
export interface CronJobSpec {
  name: string;
  cron: string;
  /**
   * How long `cron:last:<name>` may go unrefreshed before `GET
   * /api/admin/health` and the daily digest call the job stopped. A generous
   * multiple of the schedule, so one skipped tick or a slow night is not an
   * alarm but a job that has actually died is.
   */
  staleAfterMs: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const CRON_JOBS = [
  {
    name: "moderationRetry",
    cron: "*/5 * * * *",
    // Six missed ticks. Past this, listings are stranded in `pending` and no
    // giver's keepsake is going public.
    staleAfterMs: 30 * MINUTE,
  },
  {
    name: "orphanSweep",
    cron: "17 3 * * *",
    // 26 hours allows a late run plus a couple of hours of slack before a
    // whole missed night counts as an alarm.
    staleAfterMs: 26 * HOUR,
  },
  {
    name: "searchIndexRetry",
    cron: "23 * * * *",
    // Three missed ticks. An un-indexed listing is still findable through FTS
    // (#180), so this job dying is a ranking problem rather than an outage —
    // but it is the only thing that ever retries a failed embed, so nobody
    // finding out for a day is not acceptable either.
    staleAfterMs: 3 * HOUR,
  },
  {
    name: "dailyDigest",
    cron: "7 0 * * *",
    // Same 26-hour reasoning as the nightly sweep. Worth stating what a stale
    // heartbeat means *here* specifically, because it is self-referential:
    // the digest is the thing that reports staleness, so if this job is the
    // one that died, nothing emails to say so. The heartbeat is therefore
    // the only evidence, and it is why the absence of a digest is itself
    // documented as a signal (see `report/daily.ts`).
    staleAfterMs: 26 * HOUR,
  },
] as const satisfies readonly CronJobSpec[];

export type CronJobName = (typeof CRON_JOBS)[number]["name"];

export const CRON_JOB_NAMES: readonly CronJobName[] = CRON_JOBS.map((job) => job.name);

/** KV key holding the last successful completion of `name`, written by
 * `writeCronHeartbeat` below — called from `runCron` in `index.ts` as its
 * final statement — so the timestamp only ever means "this job finished",
 * never "this job started". */
export function cronHeartbeatKey(name: string): string {
  return `cron:last:${name}`;
}

/**
 * Records that `name` finished. The **only** writer of a heartbeat, and it is
 * called from exactly one place: `runCron`, after the job's promise resolves.
 *
 * Issue #165. Until this existed each job wrote its own key as its last
 * statement, and the comments in `index.ts` and above already described
 * `runCron` as the writer — aspirationally. `dailyDigest` simply never wrote
 * one. `readCronHeartbeats` counts a missing key as stale (correctly), so
 * `GET /api/admin/health` returned `ok: false` on every deployed tier from
 * the day that job was registered, and every nightly digest listed its own
 * cron under `needs_attention`. The only "the crons died" channel this system
 * has was jammed in the alarm position, which carries exactly as much
 * information as one jammed in the all-clear position.
 *
 * A per-job write is a rule a person has to remember; this is a rule the
 * dispatcher enforces. Adding a fourth cron cannot now ship without a
 * heartbeat, because the author never writes one.
 */
export async function writeCronHeartbeat(kv: KVNamespace, name: CronJobName, at: number): Promise<void> {
  await kv.put(cronHeartbeatKey(name), String(at));
}

export function staleAfterMs(name: string): number {
  return CRON_JOBS.find((job) => job.name === name)?.staleAfterMs ?? 26 * HOUR;
}

/**
 * Reads every job's heartbeat and says which have gone quiet. Shared by
 * `GET /api/admin/health` and the daily digest so the two can never disagree
 * about whether a cron is stale — they used to be one implementation and one
 * copy of its thresholds.
 */
export async function readCronHeartbeats(
  kv: KVNamespace,
  now: number,
): Promise<{ name: string; last_run_at: number | null; stale: boolean }[]> {
  return Promise.all(
    CRON_JOB_NAMES.map(async (name) => {
      const raw = await kv.get(cronHeartbeatKey(name));
      const parsed = raw ? Number.parseInt(raw, 10) : null;
      const lastRunAt = parsed !== null && Number.isFinite(parsed) ? parsed : null;
      // A job that has never run is stale: on a Worker that has been
      // deployed longer than the threshold, "no heartbeat at all" and "a very
      // old heartbeat" are the same fact. Treating a missing key as healthy
      // is how a job that never once fired reports green forever.
      return { name, last_run_at: lastRunAt, stale: lastRunAt === null || now - lastRunAt > staleAfterMs(name) };
    }),
  );
}
