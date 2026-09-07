/**
 * Launch audit finding 12: cron failures were invisible, including to
 * Sentry (in place at the time; replaced by Workers Logs in issue #14).
 *
 * Both jobs were handed to `ctx.waitUntil(...)` and `scheduled` returned
 * immediately, so a rejection inside either became a detached unhandled
 * rejection — the instrumentation wrapping the handler at the time had
 * already resolved and disposed its client, and Cloudflare recorded the
 * invocation as a success because the handler it was watching resolved fine.
 * On top of that,
 * `moderationRetry` looped `await moderateListing(...)` over 50 candidates
 * with no per-item guard: one poisoned listing aborted the batch, skipped the
 * heartbeat write, and repeated identically every five minutes forever.
 *
 * These tests pin both halves. Neither can pass on the original code: the
 * first would resolve instead of rejecting, and the second would reject
 * instead of resolving.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker, { runCron } from "../src/index.js";
import { dailyDigest } from "../src/cron/dailyDigest.js";
import { moderationRetry } from "../src/cron/moderationRetry.js";
import { orphanSweep } from "../src/cron/orphanSweep.js";
import { CRON_JOBS, cronHeartbeatKey } from "../src/cron/registry.js";
import { ulid } from "../src/lib/ids.js";
import { insertOwner } from "./helpers.js";

/** `moderationRetry` only picks up listings that have been `pending` for
 * longer than its own 2-minute staleness cutoff. */
const STALE_MS = 3 * 60 * 1000;

async function insertStalePendingListing(): Promise<string> {
  const ownerId = await insertOwner();
  const id = ulid();
  const staleAt = Date.now() - STALE_MS;
  await env.DB.prepare(
    `INSERT INTO listings
      (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
       status, version, created_at, updated_at, published_at)
     VALUES (?, ?, 'A stale teacup', 'Waiting on moderation for a while now.', 'home_kitchen',
             'US', '02144', 'Somerville', 'MA', 42.3958, -71.0967, 'pending', 1, ?, ?, NULL)`,
  )
    .bind(id, ownerId, staleAt, staleAt)
    .run();
  return id;
}

describe("runCron", () => {
  it("resolves and logs when the job succeeds", async () => {
    const ctx = createExecutionContext();
    let ran = false;
    // A real registry name, not a made-up one: `runCron`'s `name` is typed
    // `CronJobName` since #165, so a job dispatched under a name no
    // `staleAfterMs` covers no longer compiles. The stub body is what is
    // under test here, not which job it stands in for.
    await runCron(
      "moderationRetry",
      async () => {
        ran = true;
      },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(ran).toBe(true);
  });

  /**
   * Issue #165, and the hole that let it ship. `orphanSweep.test.ts` and the
   * `moderationRetry` block below each asserted the post-run heartbeat for
   * their own job; nothing asserted it for `dailyDigest`, which wrote none —
   * so `GET /api/admin/health` returned `ok: false` on every deployed tier
   * from the day that job was registered, and the one "the crons died" alarm
   * this system has was stuck in the alarm position.
   *
   * A per-job test would only have closed the instance. This drives the real
   * `scheduled()` default export with each registered cron *expression* and
   * asserts the key afterwards, looping over `CRON_JOBS` — so it covers the
   * dispatch switch in `index.ts` as well as the write, and a fourth job
   * added to the registry is tested the moment it is registered rather than
   * whenever someone remembers to write the test.
   */
  it.each(CRON_JOBS)("$name writes its heartbeat when the platform fires its schedule", async ({ name, cron }) => {
    const key = cronHeartbeatKey(name);
    await env.KV.delete(key);
    const before = Date.now();

    const ctx = createExecutionContext();
    await worker.scheduled({ cron, scheduledTime: before, noRetry: () => undefined }, env, ctx);
    await waitOnExecutionContext(ctx);

    const stored = await env.KV.get(key);
    expect(stored).not.toBeNull();
    expect(Number.parseInt(stored ?? "0", 10)).toBeGreaterThanOrEqual(before);
  });

  it("runs the real dailyDigest and leaves cron:last:dailyDigest behind", async () => {
    // The named case from the issue, kept separate from the loop above so it
    // is legible in a failure list: the real job, the real env, no seeded
    // key, dispatched the way production dispatches it.
    await env.KV.delete("cron:last:dailyDigest");
    const ctx = createExecutionContext();

    await runCron("dailyDigest", dailyDigest, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await env.KV.get("cron:last:dailyDigest")).not.toBeNull();
  });

  it("writes no heartbeat for a job that threw", async () => {
    // The other half of "the timestamp means the job finished". Without
    // this, moving the write into `runCron` could have been done in a
    // `finally` and nothing would have noticed.
    await env.KV.delete("cron:last:orphanSweep");
    const ctx = createExecutionContext();

    await expect(
      runCron(
        "orphanSweep",
        async () => {
          throw new Error("sweep exploded");
        },
        env,
        ctx,
      ),
    ).rejects.toThrow("sweep exploded");
    await waitOnExecutionContext(ctx).catch(() => undefined);

    expect(await env.KV.get("cron:last:orphanSweep")).toBeNull();
  });

  it("has a real job behind every name in the registry (#176)", async () => {
    // `CRON_JOBS` is the list `GET /api/admin/health` grades against. A name
    // in it with no job behind it would report itself stale forever with
    // nothing wrong at the trigger — the same permanently-red signal #165
    // was, arrived at from the other end. The loop above proves each of
    // these is actually reached by its own cron expression; this pins the
    // set, so adding a registry entry without a job fails here.
    const jobs: Record<string, (e: typeof env) => Promise<void>> = {
      moderationRetry,
      orphanSweep,
      dailyDigest,
    };
    expect(Object.keys(jobs).sort()).toEqual(CRON_JOBS.map((job) => job.name).sort());
  });

  // The control for the test above, and the actual finding: with
  // `ctx.waitUntil(job(env))` and no `await`, this call resolved cleanly
  // while the job's rejection escaped into nothing. Rethrowing is what makes
  // the failure reach Workers Logs' automatic capture of an uncaught
  // exception *and* the Cloudflare dashboard's invocation record.
  it("rethrows a failing job rather than detaching it", async () => {
    const ctx = createExecutionContext();
    const boom = new Error("cron exploded");

    await expect(
      runCron(
        "moderationRetry",
        async () => {
          throw boom;
        },
        env,
        ctx,
      ),
    ).rejects.toThrow("cron exploded");

    // The rejection is already handled by the assertion above; this only
    // drains the context so the runtime doesn't warn about pending work.
    await waitOnExecutionContext(ctx).catch(() => undefined);
  });
});

describe("moderationRetry: one poisoned listing", () => {
  const realKv = env.KV;

  afterEach(() => {
    (env as unknown as Record<string, unknown>).KV = realKv;
  });

  /** Every `moderateListing` call reaches `checkAndBump`, which reads KV
   * before it does anything else — so a KV whose `get` throws makes every
   * candidate in the batch fail, deterministically, without touching the
   * pipeline's own code. `put` still delegates to the real namespace, which
   * is what lets the test observe whether the heartbeat at the end of the
   * loop was ever written. */
  function installFailingKvReads(): void {
    (env as unknown as Record<string, unknown>).KV = {
      get: async () => {
        throw new Error("KV read exploded");
      },
      put: (key: string, value: string) => realKv.put(key, value),
      delete: (key: string) => realKv.delete(key),
      list: () => realKv.list(),
    };
  }

  it("finishes the batch and still writes its heartbeat when every listing throws", async () => {
    await insertStalePendingListing();
    await insertStalePendingListing();
    await insertStalePendingListing();
    await realKv.delete("cron:last:moderationRetry");

    installFailingKvReads();

    // Through `runCron`, because that is where the heartbeat is written
    // since #165 — and because the property under test is exactly the pair:
    // the job returns normally despite every listing failing, so the
    // dispatcher counts the pass as finished. Without the per-item
    // try/catch the job rejects on the first candidate, `runCron` rethrows,
    // and no heartbeat is written.
    const ctx = createExecutionContext();
    await expect(runCron("moderationRetry", moderationRetry, env, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);

    // And the heartbeat — the only thing `GET /api/admin/health` can see —
    // was still written. Before the fix this line was never reached on a
    // batch containing a bad row, so the cron looked dead from the admin
    // page for a reason that had nothing to do with the trigger.
    const heartbeat = await realKv.get("cron:last:moderationRetry");
    expect(heartbeat).not.toBeNull();
  });

  it("leaves the failed listings pending so the next tick retries them", async () => {
    const listingId = await insertStalePendingListing();
    installFailingKvReads();

    await moderationRetry(env);

    const row = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(listingId).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });
});
