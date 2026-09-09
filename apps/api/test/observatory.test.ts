/**
 * The Observatory endpoint and the daily digest behind it.
 *
 * The property under test throughout is *honesty about absence*. Almost
 * every bug this feature can have looks the same from a screenshot — an
 * empty panel — and means something entirely different underneath: no
 * traffic, no credential, or a credential that stopped working. So the
 * assertions below care much more about which of those three a response
 * claims than about whether a count is 3 or 4.
 *
 * `edge`/`logs` are exercised by stubbing `fetch`, because the alternative
 * is either a real Cloudflare API token in CI or no coverage of the failure
 * paths at all — and the failure paths are the whole point. The success path
 * is shaped from a response body captured from the live API on 2026-09-07,
 * so the parsing under test is parsing of something Cloudflare really sent,
 * not of something invented to match the parser.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OBSERVATORY_WINDOWS, type Observatory } from "@keepsake/contracts/observatory";
import { MAX_EDGE_WINDOW_DAYS } from "../src/observatory/cloudflare.js";
import { CRON_JOB_NAMES, cronHeartbeatKey } from "../src/cron/registry.js";
import { insertApprovedListing, insertOwner, readOk, setTestEnvVar } from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-observatory";

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

async function getObservatory(query = ""): Promise<Observatory> {
  const res = await SELF.fetch(`http://x/api/admin/observatory${query}`, { headers: adminHeaders() });
  return readOk<Observatory>(res);
}

/** A `workersInvocationsAdaptive` body in the shape the live API returned on
 * 2026-09-07 — two aliased selections, `date`-dimensioned rows, and
 * quantiles only on the ungrouped one. */
function edgeResponse(): Response {
  return Response.json({
    data: {
      viewer: {
        accounts: [
          {
            byDay: [
              { dimensions: { date: "2026-09-06" }, sum: { requests: 76, errors: 0, subrequests: 1 } },
              { dimensions: { date: "2026-09-07" }, sum: { requests: 320, errors: 2, subrequests: 13 } },
            ],
            overall: [
              { sum: { requests: 396, errors: 2, subrequests: 14 }, quantiles: { cpuTimeP50: 2261, cpuTimeP99: 17812 } },
            ],
          },
        ],
      },
    },
    errors: null,
  });
}

/**
 * The real row shape, transcribed from a production Workers Logs event and
 * from Cloudflare's own schema for this endpoint: `$metadata` is a *sibling*
 * of `source`, not a key inside it, and `source` is the untouched object
 * `capture.ts` wrote. This mock used to nest `$metadata` under `source`,
 * which is why the parser could read it from the wrong level for as long as
 * it did — the test proved the parser agreed with itself, not with
 * Cloudflare.
 */
function logsResponse(): Response {
  return Response.json({
    success: true,
    errors: [],
    result: {
      events: {
        events: [
          {
            dataset: "cloudflare-workers",
            timestamp: 1_757_000_000_000,
            source: {
              event: "capture",
              level: "error",
              message: "moderation failed",
              service: "keepsake-api",
              environment: "production",
            },
            $metadata: {
              level: "error",
              message: "moderation failed",
              service: "keepsake-production",
              requestId: "req-1",
            },
          },
        ],
      },
      calculations: [{ aggregates: [{ value: 7 }] }],
    },
  });
}

/** Routes a stubbed `fetch` by URL, so one test can make the GraphQL call
 * succeed and the observability call fail — the mixed state a single
 * on/off stub cannot express, and the one that proves the two panels really
 * are independent. */
function stubCloudflare(handlers: { graphql?: () => Response; telemetry?: () => Response }): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/graphql")) {
      if (!handlers.graphql) return Promise.reject(new Error("unexpected graphql call"));
      return Promise.resolve(handlers.graphql());
    }
    if (url.includes("/observability/telemetry/query")) {
      if (!handlers.telemetry) return Promise.reject(new Error("unexpected telemetry call"));
      return Promise.resolve(handlers.telemetry());
    }
    return Promise.reject(new Error(`unstubbed fetch: ${url}`));
  });
}

describe("GET /api/admin/observatory", () => {
  beforeEach(() => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setTestEnvVar("CF_OBSERVATORY_TOKEN", "");
    setTestEnvVar("CF_ACCOUNT_ID", "");
    setTestEnvVar("CF_SCRIPT_NAME", "");
  });

  it("requires the admin token", async () => {
    const res = await SELF.fetch("http://x/api/admin/observatory");
    expect(res.status).toBe(401);
  });

  it("serves the D1-derived half with no Cloudflare credential at all", async () => {
    const observatory = await getObservatory();

    // The floor this feature promises: useful with zero external setup.
    expect(observatory.app).toBeDefined();
    expect(observatory.report).toBeDefined();
    expect(observatory.edge.state).toBe("unconfigured");
    expect(observatory.logs.state).toBe("unconfigured");
  });

  it("says *which* piece of configuration is missing, not just that something is", async () => {
    const observatory = await getObservatory();

    // A generic "not configured" sends the reader to check three things.
    expect(observatory.edge.state).toBe("unconfigured");
    if (observatory.edge.state !== "unconfigured") throw new Error("unreachable");
    expect(observatory.edge.reason).toContain("CF_OBSERVATORY_TOKEN");
  });

  it("names the account id when only the token is set", async () => {
    setTestEnvVar("CF_OBSERVATORY_TOKEN", "fake-token");
    const observatory = await getObservatory();

    if (observatory.edge.state !== "unconfigured") throw new Error("expected unconfigured");
    expect(observatory.edge.reason).toContain("CF_ACCOUNT_ID");
  });

  describe("with telemetry configured", () => {
    beforeEach(() => {
      setTestEnvVar("CF_OBSERVATORY_TOKEN", "fake-token");
      setTestEnvVar("CF_ACCOUNT_ID", "fake-account");
      setTestEnvVar("CF_SCRIPT_NAME", "keepsake-test");
    });

    it("parses a real-shaped GraphQL response, taking quantiles from the ungrouped selection", async () => {
      stubCloudflare({ graphql: edgeResponse, telemetry: logsResponse });
      const observatory = await getObservatory();

      if (observatory.edge.state !== "ok") throw new Error(`expected ok, got ${observatory.edge.state}`);
      expect(observatory.edge.data.totals).toEqual({ requests: 396, errors: 2, subrequests: 14 });
      // Seven, not the fixture's two: the series is zero-filled across the
      // window (covered on its own below), so this assertion is about the
      // window, never about how many rows Cloudflare happened to return.
      expect(observatory.edge.data.by_day).toHaveLength(7);
      expect(observatory.edge.data.by_day.find((day) => day.date === "2026-09-07")?.requests).toBe(320);
      // Not an average of the two per-day groups — a window-level quantile
      // can only come from a window-level query.
      expect(observatory.edge.data.cpu_time_p99_us).toBe(17812);
    });

    it("zero-fills the days Cloudflare returned no row for", async () => {
      // The fixture holds two days. A 7-day window must come back as 7
      // points: Cloudflare emits nothing at all for a day with no
      // invocations, and a chart fed only the days that exist draws a
      // continuous line across the one day the Worker served nothing —
      // which is the day worth seeing.
      stubCloudflare({ graphql: edgeResponse, telemetry: logsResponse });
      const observatory = await getObservatory("?window_days=7");

      if (observatory.edge.state !== "ok") throw new Error("expected ok");
      expect(observatory.edge.data.by_day).toHaveLength(7);

      const dates = observatory.edge.data.by_day.map((day) => day.date);
      expect([...dates].sort()).toEqual(dates);

      // The filled days are real zeroes, not undefined leaking through.
      const filled = observatory.edge.data.by_day.filter((day) => !["2026-09-06", "2026-09-07"].includes(day.date));
      expect(filled.length).toBeGreaterThan(0);
      for (const day of filled) {
        expect(day).toMatchObject({ requests: 0, errors: 0, subrequests: 0 });
      }

      // Totals still come from the ungrouped selection, so zero-filling the
      // series cannot dilute them.
      expect(observatory.edge.data.totals.requests).toBe(396);
    });

    it("puts the edge series on the same days as the D1 series", async () => {
      // The whole reason both are collected: "requests went up and listings
      // created did not" is only readable if the two line up. They did not
      // before — 7 app bars against 2 edge bars on a quiet Worker.
      stubCloudflare({ graphql: edgeResponse, telemetry: logsResponse });
      const observatory = await getObservatory("?window_days=7");

      if (observatory.edge.state !== "ok") throw new Error("expected ok");
      expect(observatory.edge.data.by_day.map((day) => day.date)).toEqual(observatory.app.by_day.map((day) => day.date));
    });

    it("reports a GraphQL error body as an error, not as zero traffic", async () => {
      // The failure mode this exists to prevent: Cloudflare returns HTTP 200
      // with a populated `errors` array when a token is revoked. Treating
      // 200 as success renders a confident, wrong "0 requests".
      stubCloudflare({
        graphql: () => Response.json({ data: null, errors: [{ message: "Authentication error" }] }),
        telemetry: logsResponse,
      });
      const observatory = await getObservatory();

      expect(observatory.edge.state).toBe("error");
      if (observatory.edge.state !== "error") throw new Error("unreachable");
      expect(observatory.edge.error).toContain("Authentication error");
    });

    it("never puts the credential in the error string", async () => {
      stubCloudflare({ graphql: () => new Response("nope", { status: 403 }), telemetry: logsResponse });
      const observatory = await getObservatory();

      if (observatory.edge.state !== "error") throw new Error("expected error");
      // This string is rendered straight into the admin page's DOM.
      expect(observatory.edge.error).not.toContain("fake-token");
      expect(observatory.edge.error).toContain("403");
    });

    it("fails the two panels independently", async () => {
      stubCloudflare({ graphql: edgeResponse, telemetry: () => new Response("boom", { status: 500 }) });
      const observatory = await getObservatory();

      expect(observatory.edge.state).toBe("ok");
      expect(observatory.logs.state).toBe("error");
    });

    it("keeps counts separate from the capped event feed", async () => {
      stubCloudflare({ graphql: edgeResponse, telemetry: logsResponse });
      const observatory = await getObservatory();

      if (observatory.logs.state !== "ok") throw new Error("expected ok");
      // One event returned, seven counted: the cap must not be mistaken for
      // the magnitude.
      expect(observatory.logs.data.events).toHaveLength(1);
      expect(observatory.logs.data.counts.error).toBe(7);
    });

    it("reads each event's fields from `$metadata` beside `source`, not inside it", async () => {
      stubCloudflare({ graphql: edgeResponse, telemetry: logsResponse });
      const observatory = await getObservatory();

      if (observatory.logs.state !== "ok") throw new Error("expected ok");
      // Every one of these came back as a fallback — `"(no message)"`, a
      // guessed level, `null` — while `$metadata` was read one level too
      // deep, so a feed of real errors rendered as anonymous rows.
      expect(observatory.logs.data.events[0]).toEqual({
        ts: 1_757_000_000_000,
        level: "error",
        message: "moderation failed",
        service: "keepsake-production",
        request_id: "req-1",
      });
    });

    it("refuses to render an empty feed under a nonzero error count", async () => {
      // Exactly what production returned during the walkthrough that found
      // this: the count query sees the error, the events query comes back
      // without rows. Two answers to one question — the panel must say so
      // rather than show "no errors" over a count of one.
      stubCloudflare({
        graphql: edgeResponse,
        telemetry: () =>
          Response.json({
            success: true,
            errors: [],
            result: { run: {}, statistics: {}, calculations: [{ aggregates: [{ value: 1 }] }] },
          }),
      });
      const observatory = await getObservatory();

      if (observatory.logs.state !== "error") throw new Error("expected error");
      expect(observatory.logs.error).toContain("events feed returned none");
      // The keys that did come back are the diagnosis — `calculations` back
      // from a `view: "events"` query means the view was not honored.
      expect(observatory.logs.error).toContain("calculations");
    });

    it("treats a 200 carrying `errors` as a failure even with no `success` field", async () => {
      stubCloudflare({
        graphql: edgeResponse,
        telemetry: () => Response.json({ errors: [{ message: "invalid filter key" }], result: {} }),
      });
      const observatory = await getObservatory();

      if (observatory.logs.state !== "error") throw new Error("expected error");
      expect(observatory.logs.error).toContain("invalid filter key");
    });

    it("clamps the log window to Workers Logs retention and says so", async () => {
      stubCloudflare({ graphql: edgeResponse, telemetry: logsResponse });
      const observatory = await getObservatory("?window_days=30");

      expect(observatory.window_days).toBe(30);
      if (observatory.logs.state !== "ok") throw new Error("expected ok");
      // Labelling 3 days of data as 30 is the quiet lie this prevents.
      expect(observatory.logs.data.window_days).toBe(3);
    });

    it("a Cloudflare outage never takes down the D1 half", async () => {
      stubCloudflare({
        graphql: () => {
          throw new Error("network down");
        },
        telemetry: () => {
          throw new Error("network down");
        },
      });
      const observatory = await getObservatory();

      expect(observatory.edge.state).toBe("error");
      expect(observatory.logs.state).toBe("error");
      expect(observatory.app.funnel).toBeDefined();
      expect(observatory.report.needs_attention).toBeInstanceOf(Array);
    });
  });

  it("rejects a window outside the closed set", async () => {
    const res = await SELF.fetch("http://x/api/admin/observatory?window_days=5", { headers: adminHeaders() });
    expect(res.status).toBe(400);
  });

  it("returns a gap-free series with a zero row for a day nothing happened", async () => {
    const observatory = await getObservatory("?window_days=7");

    // A chart fed only the days that produced rows draws a continuous line
    // across an outage. Seven days asked for, seven days returned.
    expect(observatory.app.by_day).toHaveLength(7);
    const dates = observatory.app.by_day.map((day) => day.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("distinguishes an empty queue from a queue whose oldest item just arrived", async () => {
    const observatory = await getObservatory();

    // Nothing pending in this fixture — which must be `null`, not `0`.
    // `0` would claim a listing is pending and has waited no time at all.
    if (observatory.app.moderation.pending === 0) {
      expect(observatory.app.moderation.oldest_pending_age_ms).toBeNull();
    }
  });

  it("counts an approved listing in the funnel cohort", async () => {
    const ownerId = await insertOwner();
    await insertApprovedListing({ ownerId, title: "An observatory teacup" });

    const observatory = await getObservatory();

    expect(observatory.app.funnel.listings_created).toBeGreaterThan(0);
    expect(observatory.app.funnel.listings_approved).toBeGreaterThan(0);
    // Cohort, not independent window counts: a funnel must never widen.
    expect(observatory.app.funnel.listings_approved).toBeLessThanOrEqual(observatory.app.funnel.listings_created);
    expect(observatory.app.funnel.listings_chosen).toBeLessThanOrEqual(observatory.app.funnel.listings_requested);
  });
});

describe("the daily digest", () => {
  beforeEach(() => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
  });

  it("reports the completed UTC day, never the one in progress", async () => {
    const observatory = await getObservatory();
    const today = new Date().toISOString().slice(0, 10);

    // Numbers that can still move are numbers two readers can disagree about.
    expect(observatory.report.date).not.toBe(today);
  });

  it("flags a cron that has never run as stale rather than as healthy", async () => {
    // #165: this used to single out `dailyDigest`, which read as "that job
    // is stale" — a true statement about the world at the time, because that
    // job never wrote a heartbeat at all, and one this test would have gone
    // on asserting after the bug was fixed. The rule under test is the
    // general one in `readCronHeartbeats`: a *missing* key is not read as
    // "fine". So clear every key first and assert it for every job, which
    // also makes the test independent of which jobs happen to be registered.
    for (const name of CRON_JOB_NAMES) {
      await env.KV.delete(cronHeartbeatKey(name));
    }

    const observatory = await getObservatory();

    expect(observatory.report.crons.length).toBe(CRON_JOB_NAMES.length);
    for (const cron of observatory.report.crons) {
      expect(cron.last_run_at).toBeNull();
      expect(cron.stale).toBe(true);
    }
    expect(observatory.report.needs_attention.some((alert) => alert.code === "cron_stale")).toBe(true);
  });

  it("stops flagging a cron once it has actually run", async () => {
    // The control the assertion above never had. A test that only ever sees
    // an empty KV cannot tell "counts a missing key as stale" from "reports
    // every cron as stale, always" — which is precisely the state #165 left
    // the deployed tiers in, and precisely what a permanently-red signal
    // looks like from inside the suite.
    for (const name of CRON_JOB_NAMES) {
      await env.KV.put(cronHeartbeatKey(name), String(Date.now()));
    }

    const observatory = await getObservatory();

    for (const cron of observatory.report.crons) {
      expect(cron.last_run_at).not.toBeNull();
      expect(cron.stale).toBe(false);
    }
    expect(observatory.report.needs_attention.some((alert) => alert.code === "cron_stale")).toBe(false);

    for (const name of CRON_JOB_NAMES) {
      await env.KV.delete(cronHeartbeatKey(name));
    }
  });

  it("carries every cron in the registry, so a new job cannot be added unwatched", async () => {
    const observatory = await getObservatory();
    const names = observatory.report.crons.map((cron) => cron.name).sort();
    // Against the registry rather than a literal list: the point of this test
    // is that a job cannot be added unwatched, and a hand-written expectation
    // makes every new job fail here for the wrong reason — as a chore, not as
    // a finding. `cron.test.ts` is what pins the registry to real jobs.
    expect(names).toEqual([...CRON_JOB_NAMES].sort());
  });

  it("raises a budget alert only once the ceiling is nearly spent", async () => {
    setTestEnvVar("MOD_TEXT_DAILY_BUDGET", "100");
    const today = new Date().toISOString().slice(0, 10);

    await env.KV.put(`budget:mod_text:${today}`, "79");
    const quiet = await getObservatory();
    expect(quiet.report.needs_attention.some((alert) => alert.code === "budget_high")).toBe(false);

    // One unit across the 80% line — the boundary is the whole check.
    await env.KV.put(`budget:mod_text:${today}`, "80");
    const loud = await getObservatory();
    expect(loud.report.needs_attention.some((alert) => alert.code === "budget_high")).toBe(true);

    await env.KV.put(`budget:mod_text:${today}`, "100");
    const exhausted = await getObservatory();
    expect(exhausted.report.needs_attention.some((alert) => alert.code === "budget_exhausted")).toBe(true);

    await env.KV.delete(`budget:mod_text:${today}`);
    setTestEnvVar("MOD_TEXT_DAILY_BUDGET", "1000");
  });

  it("puts critical alerts ahead of warnings", async () => {
    const observatory = await getObservatory();
    const severities = observatory.report.needs_attention.map((alert) => alert.severity);
    const firstWarning = severities.indexOf("warning");
    const lastCritical = severities.lastIndexOf("critical");

    if (firstWarning !== -1 && lastCritical !== -1) {
      expect(lastCritical).toBeLessThan(firstWarning);
    }
  });
});

describe("the edge series", () => {
  it("never claims a window the analytics API would refuse", () => {
    // The zero-fill in `fetchEdgeTelemetry` reads "Cloudflare returned no row
    // for this day" as "zero requests". That is only honest while the API
    // actually covers the whole window — past its 32-day ceiling a missing
    // day would mean "we did not look that far back", and rendering it as a
    // zero bar would be the confident-empty answer `ObservatorySource` exists
    // to prevent. Measured, not assumed: a 31-day query returns 32 contiguous
    // rows and 40 days is refused with "cannot request a time range wider
    // than 4w4d".
    for (const days of OBSERVATORY_WINDOWS) {
      expect(days).toBeLessThanOrEqual(MAX_EDGE_WINDOW_DAYS);
    }
  });
});
