/**
 * The Tail Worker (issue #159, step 1) — filter, redaction, volume ceiling,
 * retention, and the panel that reads the result back.
 *
 * Three of these are guards rather than features, and each was watched
 * failing before it was trusted (the closing comment on #159 records what the
 * failures looked like):
 *
 *  - **Redaction.** The one this issue's scoping comment says not to let a
 *    fast implementation skip. The assertion is deliberately not "the
 *    redactor was called" — it is that a delivery carrying an address, a
 *    phone number, a bearer token, a `?token=` query parameter and a
 *    `/recover/<token>` path leaves **no column of any stored row**
 *    containing any of those strings. A test that checked the message field
 *    alone would have passed against a version that wrote the raw stack.
 *  - **The volume ceiling.** Asserted from both sides: what a capped minute
 *    refuses, and that the refusal is *recorded* rather than swallowed. A cap
 *    that silently drops rows makes one stray error and a runaway loop render
 *    identically, which is the distinction the Observatory's counts exist to
 *    preserve.
 *  - **"I did not look" vs "I looked and saw nothing".** The panel must not
 *    render an empty feed as calm on an environment where no tail consumer
 *    has ever delivered anything.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { OBSERVATORY_WINDOWS } from "@keepsake/contracts/observatory";
import {
  ERROR_EVENT_RETENTION_DAYS,
  MAX_ERROR_EVENTS_PER_MINUTE,
  extractErrorEvents,
  persistTailEvents,
  capNoticeMessage,
} from "../src/tail/errorEvents.js";
import tailWorker from "../src/tail/index.js";
import { errorEventSweep } from "../src/cron/errorEventSweep.js";
import { fetchPersistedLogs } from "../src/observatory/errorEvents.js";
import type { Env } from "../src/env.js";
import { insertErrorEvent, seedTailDelivery } from "./helpers.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

interface TraceLogInput {
  level: string;
  message: unknown;
  timestamp?: number;
}

/**
 * One trace item in the shape Cloudflare hands a tail consumer: `logs[]`
 * carrying the console call's *arguments*, `exceptions[]` carrying uncaught
 * throws, and the producing script's name and outcome beside them. Cast
 * rather than constructed as a real `TraceItem` because the runtime type is
 * `readonly` throughout and carries a dozen fields this code never reads.
 */
function traceItem(options: {
  logs?: TraceLogInput[];
  exceptions?: { name: string; message: string; stack?: string; timestamp?: number }[];
  scriptName?: string;
  outcome?: string;
  at?: number;
}): TraceItem {
  const at = options.at ?? Date.now();
  return {
    event: null,
    eventTimestamp: at,
    logs: (options.logs ?? []).map((log) => ({
      timestamp: log.timestamp ?? at,
      level: log.level,
      message: log.message,
    })),
    exceptions: (options.exceptions ?? []).map((exception) => ({
      timestamp: exception.timestamp ?? at,
      name: exception.name,
      message: exception.message,
      stack: exception.stack,
    })),
    diagnosticsChannelEvents: [],
    scriptName: options.scriptName ?? "keepsake-production",
    outcome: options.outcome ?? "ok",
    executionModel: "stateless",
    truncated: false,
    cpuTime: 1,
    wallTime: 2,
  } as unknown as TraceItem;
}

/** The exact object `@keepsake/observability/capture` logs — the
 * `event: "capture"` discriminator is what the filter keys on. */
function captureLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "capture",
    level: "error",
    service: "keepsake-api",
    environment: "production",
    release: "abc123",
    message: "moderation failed",
    error: { name: "Error", message: "moderation failed", stack: "Error: moderation failed\n  at moderate" },
    ts: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Storage is shared across the tests in this file (the pool does not roll
 * back between `it`s here), and every case below asserts on *counts* of rows
 * in one small table — so a leftover row from the previous test is not a
 * flake, it is a wrong answer. Both tables are cleared rather than one: a
 * stale `tail_deliveries` row would make the "unconfigured before any
 * delivery" case pass for the wrong reason, which is the one assertion in
 * this file that must never be able to pass by accident.
 */
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM error_events").run();
  await env.DB.prepare("DELETE FROM tail_deliveries").run();
});

async function allRows(): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM error_events ORDER BY observed_at").all();
  return results as unknown as Record<string, unknown>[];
}

describe("Tail Worker: what reaches the table", () => {
  it("keeps error and warning lines, capture records and uncaught exceptions", async () => {
    const now = Date.now();
    const result = await persistTailEvents(
      env,
      [
        traceItem({
          at: now,
          logs: [
            { level: "log", message: ["GET /api/feed 200"] },
            { level: "info", message: ["cache warm"] },
            { level: "debug", message: ["candidate rows: 4"] },
            { level: "error", message: ["unhandled error", { route: "/api/listings/:id", status: 500 }] },
            { level: "warn", message: ["orphanSweep: photo deletions deferred", { photosDeferred: 2 }] },
            { level: "error", message: [captureLine()] },
            { level: "warn", message: [captureLine({ level: "warning", message: "cron heartbeat stale" })] },
          ],
          exceptions: [{ name: "TypeError", message: "x is not a function", stack: "TypeError: x is not a function" }],
        }),
      ],
      now,
    );

    // Four levels of console noise in, three of them dropped on the floor:
    // a tail consumer receives a trace item for *every* invocation, so the
    // filter is what keeps this table from being a request log.
    expect(result.considered).toBe(5);
    expect(result.persisted).toBe(5);
    expect(result.dropped).toBe(0);

    const rows = await allRows();
    expect(rows.map((row) => row.kind).sort()).toEqual(["capture", "capture", "console", "console", "exception"]);
    expect(rows.map((row) => row.message)).toContain("x is not a function");
    expect(rows.map((row) => row.message)).toContain("unhandled error");
    expect(rows.map((row) => row.message)).toContain("cron heartbeat stale");
    expect(rows.filter((row) => row.level === "warning")).toHaveLength(2);
  });

  it("reads a capture record's own fields rather than the console argument's text", async () => {
    const now = Date.now();
    await persistTailEvents(
      env,
      [
        traceItem({
          at: now,
          scriptName: "keepsake-production",
          outcome: "exception",
          logs: [{ level: "error", message: [captureLine({ tags: { requestId: "req-42", route: "/api/listings" } })] }],
        }),
      ],
      now,
    );

    const [row] = await allRows();
    expect(row).toMatchObject({
      kind: "capture",
      level: "error",
      message: "moderation failed",
      script_name: "keepsake-production",
      environment: "production",
      release: "abc123",
      error_name: "Error",
      // The request id an admin can be handed by the person who hit the
      // error — `index.ts` returns it as `X-Request-Id` and tags every
      // capture with it.
      request_id: "req-42",
      outcome: "exception",
    });
    expect(String(row?.stack)).toContain("at moderate");
    expect(String(row?.detail)).toContain("/api/listings");
  });

  it("is pure about the filter: nothing is written by extractErrorEvents itself", async () => {
    const events = extractErrorEvents([traceItem({ logs: [{ level: "error", message: ["boom"] }] })]);
    expect(events).toHaveLength(1);
    expect(await allRows()).toHaveLength(0);
  });
});

describe("Tail Worker: redaction (the guard #159 says not to skip)", () => {
  /**
   * Every value here is something the redactor must scrub, and each is in a
   * *different* field of the delivery, so a partial implementation that
   * redacted only the message would still fail this test.
   */
  const ADDRESS = "alice.smith@gmail.com";
  const PHONE = "+1 617 555 0134";
  const BEARER = "sk_live_9f2c8b1a4d6e";
  const QUERY_TOKEN = "cf0e1d2a3b4c5d6e7f8a9b0c";
  const RECOVERY_TOKEN = "Xq3vT7bN2mK9pL4sD8fG1hJ6wZ0yR5cV3eB7nM2kQ1a";

  it("scrubs every column of every row it writes", async () => {
    const now = Date.now();
    await persistTailEvents(
      env,
      [
        traceItem({
          at: now,
          logs: [
            // A bare console.error — the case that never went near
            // `capture.ts` and so has never been redacted before now.
            {
              level: "error",
              message: [`send failed for ${ADDRESS}`, { detail: `called ${PHONE}`, url: `/recover/${RECOVERY_TOKEN}` }],
            },
            // A capture record, whose fields the parser reads individually.
            {
              level: "error",
              message: [
                captureLine({
                  message: `request from ${ADDRESS} failed`,
                  error: {
                    name: "Error",
                    message: "auth rejected",
                    stack: `Error: auth rejected\n  at fetch (https://api/x?token=${QUERY_TOKEN})`,
                  },
                  tags: { requestId: "req-9" },
                  extra: { authorization: `Bearer ${BEARER}`, requester: ADDRESS },
                }),
              ],
            },
          ],
          exceptions: [
            {
              name: "Error",
              message: `no route for ${ADDRESS}`,
              stack: `Error\n  at /withdraw/${RECOVERY_TOKEN}`,
            },
          ],
        }),
      ],
      now,
    );

    const rows = await allRows();
    expect(rows).toHaveLength(3);

    // Every column of every row, flattened — not just `message`. The whole
    // point is that no field is exempt.
    const everything = rows.flatMap((row) => Object.values(row).map((value) => String(value ?? ""))).join("\n");

    for (const secret of [ADDRESS, "alice.smith", PHONE, BEARER, QUERY_TOKEN, RECOVERY_TOKEN]) {
      expect(everything).not.toContain(secret);
    }

    // …and it is redaction, not deletion: the diagnostic value survives.
    // `redact.ts` keeps the domain deliberately ("a bare domain names a mail
    // provider, not a person"), which is the difference between "one address
    // bounced" and "this provider refuses everything".
    expect(everything).toContain("[REDACTED]");
    expect(everything).toContain("gmail.com");
    expect(everything).toContain("auth rejected");
    expect(everything).toContain("no route for");
  });
});

describe("Tail Worker: the per-minute volume ceiling", () => {
  /** `n` distinct error lines in one delivery. */
  function burst(n: number, at: number): TraceItem {
    return traceItem({
      at,
      logs: Array.from({ length: n }, (_, i) => ({ level: "error", message: [`loop iteration ${i}`] })),
    });
  }

  /**
   * Pinned to a minute boundary, not `Date.now()`. The ceiling is keyed on
   * the wall-clock minute, so a test that started at :59.5 and made its
   * second delivery a second later would be asserting across two different
   * minutes — and would pass or fail depending on when it ran, which is
   * exactly the kind of "flake" that turns out to be the test lying.
   */
  const minuteStart = (): number => Math.floor(Date.now() / MINUTE) * MINUTE;

  it("stops at the ceiling and records what it refused", async () => {
    const now = minuteStart();
    const over = 5;
    const result = await persistTailEvents(env, [burst(MAX_ERROR_EVENTS_PER_MINUTE + over, now)], now);

    expect(result.considered).toBe(MAX_ERROR_EVENTS_PER_MINUTE + over);
    expect(result.persisted).toBe(MAX_ERROR_EVENTS_PER_MINUTE);
    expect(result.dropped).toBe(over);

    const persisted = await env.DB.prepare("SELECT COUNT(*) AS n FROM error_events WHERE kind <> 'cap_notice'").first<{
      n: number;
    }>();
    expect(persisted?.n).toBe(MAX_ERROR_EVENTS_PER_MINUTE);

    // The refusal is in the feed, not only in a log line nobody reads.
    const notice = await env.DB.prepare("SELECT * FROM error_events WHERE kind = 'cap_notice'").first<{
      dropped: number;
      message: string;
      level: string;
    }>();
    expect(notice?.dropped).toBe(over);
    expect(notice?.level).toBe("warning");
    expect(notice?.message).toBe(capNoticeMessage(over));
  });

  it("refuses a delivery whose minute is already full, however small that delivery is", async () => {
    // The case the JavaScript-side slice in `persistTailEvents` cannot
    // cover, and therefore the one that actually exercises the ceiling
    // living in the `INSERT`'s own `WHERE`: a *two line* delivery arriving
    // into a minute that other invocations already filled. Written as its
    // own test because removing the SQL predicate leaves the
    // single-delivery case above passing on the slice alone.
    const now = minuteStart();
    for (let i = 0; i < MAX_ERROR_EVENTS_PER_MINUTE; i++) {
      await insertErrorEvent({ observedAt: now, receivedAt: now, message: `earlier invocation ${i}` });
    }

    const result = await persistTailEvents(env, [burst(2, now)], now);
    expect(result.persisted).toBe(0);
    expect(result.dropped).toBe(2);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM error_events WHERE kind <> 'cap_notice'").first<{
      n: number;
    }>();
    expect(rows?.n).toBe(MAX_ERROR_EVENTS_PER_MINUTE);
  });

  it("counts the rows written earlier in the same batch, not just the ones already there", async () => {
    // The claim the ceiling rests on, and the one that would be silently
    // false if D1 evaluated each statement's `WHERE` against a snapshot
    // taken before the batch: with 58 rows already in the minute and 5 more
    // arriving in one delivery, every one of those 5 would see "58 < 60" and
    // all 5 would land — an overshoot that only shows up at exactly this
    // boundary, never in a bulk burst against an empty table.
    const now = minuteStart();
    const already = MAX_ERROR_EVENTS_PER_MINUTE - 2;
    for (let i = 0; i < already; i++) {
      await insertErrorEvent({ observedAt: now, receivedAt: now, message: `earlier ${i}` });
    }

    const result = await persistTailEvents(env, [burst(5, now)], now);
    expect(result.persisted).toBe(2);
    expect(result.dropped).toBe(3);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM error_events WHERE kind <> 'cap_notice'").first<{
      n: number;
    }>();
    expect(rows?.n).toBe(MAX_ERROR_EVENTS_PER_MINUTE);
  });

  it("holds across deliveries inside the same minute, and accumulates the notice", async () => {
    const now = minuteStart();
    await persistTailEvents(env, [burst(MAX_ERROR_EVENTS_PER_MINUTE, now)], now);

    // A second delivery, one second later — same minute, so the ceiling is
    // already spent. This is the case a counter read in one statement and
    // spent in another would let through.
    const second = await persistTailEvents(env, [burst(3, now + 1000)], now + 1000);
    expect(second.persisted).toBe(0);
    expect(second.dropped).toBe(3);

    const third = await persistTailEvents(env, [burst(2, now + 2000)], now + 2000);
    expect(third.persisted).toBe(0);

    const notices = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(dropped) AS total FROM error_events WHERE kind = 'cap_notice'").first<{
      n: number;
      total: number;
    }>();
    // One notice for the minute, carrying the running total — not one row
    // per delivery, which would itself be the flood.
    expect(notices?.n).toBe(1);
    expect(notices?.total).toBe(5);
  });

  it("refills on the next minute", async () => {
    const now = minuteStart();
    await persistTailEvents(env, [burst(MAX_ERROR_EVENTS_PER_MINUTE, now)], now);

    const next = now + MINUTE;
    const result = await persistTailEvents(env, [burst(2, next)], next);
    expect(result.persisted).toBe(2);
    expect(result.dropped).toBe(0);
  });

  it("never lets a cap notice eat a slot from the lines it is reporting on", async () => {
    const now = minuteStart();
    await persistTailEvents(env, [burst(MAX_ERROR_EVENTS_PER_MINUTE + 1, now)], now);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM error_events").first<{ n: number }>();
    // Ceiling + exactly one notice: the notice is deliberately outside the
    // ceiling, and bounded to one per minute by its own primary key.
    expect(rows?.n).toBe(MAX_ERROR_EVENTS_PER_MINUTE + 1);
  });
});

describe("Tail Worker: the delivery stamp", () => {
  it("records a delivery even when nothing in it is worth keeping", async () => {
    const now = Date.now();
    const result = await persistTailEvents(env, [traceItem({ at: now, logs: [{ level: "log", message: ["ok"] }] })], now);

    expect(result.persisted).toBe(0);
    const row = await env.DB.prepare("SELECT * FROM tail_deliveries WHERE id = 1").first<{
      first_delivery_at: number;
      last_delivery_at: number;
    }>();
    // This is the whole reason the row exists: a quiet Worker and an
    // unattached tail consumer must not look the same from the panel.
    expect(row?.first_delivery_at).toBe(now);
    expect(row?.last_delivery_at).toBe(now);
  });

  it("throttles the stamp to one write a minute", async () => {
    const now = Date.now();
    await persistTailEvents(env, [traceItem({ at: now, logs: [] })], now);
    await persistTailEvents(env, [traceItem({ at: now + 1000, logs: [] })], now + 1000);

    const row = await env.DB.prepare("SELECT last_delivery_at FROM tail_deliveries WHERE id = 1").first<{
      last_delivery_at: number;
    }>();
    expect(row?.last_delivery_at).toBe(now);

    await persistTailEvents(env, [traceItem({ at: now + 2 * MINUTE, logs: [] })], now + 2 * MINUTE);
    const later = await env.DB.prepare("SELECT last_delivery_at FROM tail_deliveries WHERE id = 1").first<{
      last_delivery_at: number;
    }>();
    expect(later?.last_delivery_at).toBe(now + 2 * MINUTE);
  });
});

describe("Tail Worker: the entrypoint never throws", () => {
  it("swallows a broken database rather than failing the invocation", async () => {
    const broken = {
      ENVIRONMENT: "test",
      DB: {
        prepare() {
          throw new Error("D1_ERROR: no such table: error_events");
        },
      },
    } as unknown as Parameters<typeof tailWorker.tail>[1];

    // A throwing tail handler is recorded by Cloudflare as a failure of this
    // Worker *and* drops the events — turning "an error happened" into "an
    // error happened and the record of it is gone".
    await expect(tailWorker.tail([traceItem({ logs: [{ level: "error", message: ["boom"] }] })], broken)).resolves.toBeUndefined();
  });
});

describe("errorEventSweep: retention", () => {
  it("keeps the retention window and deletes what is older", async () => {
    const now = Date.now();
    const fresh = await insertErrorEvent({ observedAt: now - DAY });
    const edge = await insertErrorEvent({ observedAt: now - (ERROR_EVENT_RETENTION_DAYS - 1) * DAY });
    const stale = await insertErrorEvent({ observedAt: now - (ERROR_EVENT_RETENTION_DAYS + 1) * DAY });

    await errorEventSweep(env as Env, now);

    const { results } = await env.DB.prepare("SELECT id FROM error_events").all<{ id: string }>();
    const ids = results.map((row) => row.id);
    expect(ids).toContain(fresh);
    expect(ids).toContain(edge);
    expect(ids).not.toContain(stale);
  });

  it("is a no-op the second time, like every other sweep here", async () => {
    const now = Date.now();
    await insertErrorEvent({ observedAt: now - (ERROR_EVENT_RETENTION_DAYS + 1) * DAY });
    await errorEventSweep(env as Env, now);
    await errorEventSweep(env as Env, now);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM error_events").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("keeps at least as much history as the widest window the Observatory can ask for", () => {
    // Otherwise the panel labels a 30-day window over fewer days of rows —
    // the same quiet lie the edge window's own ceiling exists to prevent.
    expect(ERROR_EVENT_RETENTION_DAYS).toBeGreaterThanOrEqual(Math.max(...OBSERVATORY_WINDOWS));
  });
});

describe("the Observatory's log panel, read from D1", () => {
  it("says `unconfigured` — not an empty feed — before any tail delivery", async () => {
    const source = await fetchPersistedLogs(env as Env, 7);
    expect(source.state).toBe("unconfigured");
    if (source.state !== "unconfigured") throw new Error("unreachable");
    // The reason has to name the thing to go and check, or it sends the
    // reader to look at three.
    expect(source.reason).toContain("keepsake-tail");
    expect(source.reason).toContain("tail_consumers");
  });

  it("reports zero honestly once the pipeline has delivered something", async () => {
    const now = Date.now();
    await seedTailDelivery(now);

    const source = await fetchPersistedLogs(env as Env, 7, now);
    if (source.state !== "ok") throw new Error(`expected ok, got ${source.state}`);
    expect(source.data.counts).toEqual({ error: 0, warning: 0 });
    expect(source.data.events).toEqual([]);
  });

  it("counts over the whole window but returns a capped feed", async () => {
    const now = Date.now();
    await seedTailDelivery(now);
    for (let i = 0; i < 55; i++) {
      await insertErrorEvent({ observedAt: now - i * 1000, message: `failure ${i}` });
    }
    await insertErrorEvent({ observedAt: now - 500, level: "warning", message: "cron heartbeat stale" });

    const source = await fetchPersistedLogs(env as Env, 7, now);
    if (source.state !== "ok") throw new Error("expected ok");
    // A count is the magnitude; the feed is a sample. One stray error and
    // four thousand identical ones must not render the same.
    expect(source.data.counts.error).toBe(55);
    expect(source.data.counts.warning).toBe(1);
    expect(source.data.events).toHaveLength(50);
    // Most recent first.
    expect(source.data.events[0]?.ts).toBeGreaterThan(source.data.events[49]?.ts ?? 0);
  });

  it("reports the window it was asked for, and only counts rows inside it", async () => {
    const now = Date.now();
    await seedTailDelivery(now);
    await insertErrorEvent({ observedAt: now - 2 * DAY, message: "inside the week" });
    await insertErrorEvent({ observedAt: now - 10 * DAY, message: "outside the week" });

    const week = await fetchPersistedLogs(env as Env, 7, now);
    if (week.state !== "ok") throw new Error("expected ok");
    // Not 3. The old Workers Logs reader clamped every window to the Free
    // plan's 3-day retention; the whole point of persisting is that a
    // 7-day window is now really 7 days.
    expect(week.data.window_days).toBe(7);
    expect(week.data.counts.error).toBe(1);

    const month = await fetchPersistedLogs(env as Env, 30, now);
    if (month.state !== "ok") throw new Error("expected ok");
    expect(month.data.window_days).toBe(30);
    expect(month.data.counts.error).toBe(2);
  });

  it("surfaces the real rows the Tail Worker wrote, end to end", async () => {
    const now = Date.now();
    await persistTailEvents(
      env,
      [
        traceItem({
          at: now,
          logs: [{ level: "error", message: [captureLine({ tags: { requestId: "req-77" } })] }],
        }),
      ],
      now,
    );

    const source = await fetchPersistedLogs(env as Env, 7, now);
    if (source.state !== "ok") throw new Error("expected ok");
    expect(source.data.events[0]).toEqual({
      ts: now,
      level: "error",
      message: "moderation failed",
      service: "keepsake-production",
      request_id: "req-77",
    });
  });

  it("reports a read failure as an error rather than as an empty feed", async () => {
    const broken = {
      DB: {
        prepare() {
          throw new Error("D1_ERROR: no such table: error_events");
        },
      },
    } as unknown as Env;

    const source = await fetchPersistedLogs(broken, 7);
    expect(source.state).toBe("error");
    if (source.state !== "error") throw new Error("unreachable");
    expect(source.error).toContain("no such table");
  });
});
