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
import { runCron } from "../src/index.js";
import { moderationRetry } from "../src/cron/moderationRetry.js";
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
    await runCron(
      "fake",
      async () => {
        ran = true;
      },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(ran).toBe(true);
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
        "fake",
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

    // Without the per-item try/catch this rejects on the first candidate.
    await expect(moderationRetry(env)).resolves.toBeUndefined();

    // And the heartbeat — the last statement of the job, and the only thing
    // `GET /api/admin/health` can see — was still written. Before the fix
    // this line was never reached on a batch containing a bad row, so the
    // cron looked dead from the admin page for a reason that had nothing to
    // do with the trigger.
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
