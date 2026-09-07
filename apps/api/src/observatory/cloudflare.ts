/**
 * The two Cloudflare-side reads behind the Observatory: edge traffic from the
 * GraphQL Analytics API, and the Worker's own log lines from the Workers
 * Observability telemetry API.
 *
 * Both are plain `fetch` calls against `api.cloudflare.com`, not bindings.
 * There is no binding for either dataset — the Worker cannot query its own
 * analytics from inside itself — so this needs a real API credential, which
 * is the one genuinely awkward thing about the whole feature and the reason
 * for the care below.
 *
 * ## The credential
 *
 * `CF_OBSERVATORY_TOKEN` is a *separate, read-only* token from
 * `CF_CACHE_PURGE_TOKEN`, scoped to exactly two account permission groups:
 * `Account Analytics Read` and `Workers Observability Read`. It is not the
 * broad account token used from a laptop, and it deliberately cannot write
 * anything, cannot read D1/R2/KV, and cannot touch DNS. If it leaks, what
 * leaks is the ability to read request counts and log lines for this
 * account — bad, but bounded, and revocable without touching anything the
 * running site depends on. A Worker that holds a credential able to redeploy
 * itself is a much worse trade for a dashboard.
 *
 * Unset is a normal, supported state (`{ state: "unconfigured" }`), not an
 * error: local `wrangler dev`, every test, and any deploy made before the
 * token exists all run without it, and the Observatory is designed to be
 * useful with only its D1-derived half. That is why this module never
 * throws and never returns `null` — see `ObservatorySource`'s doc comment
 * for why "I did not look" and "I looked and saw nothing" must not collapse
 * into the same value.
 *
 * ## Error text
 *
 * Every failure path returns a short, *constructed* string — an HTTP status,
 * a GraphQL error message, a timeout label. It never interpolates the
 * request headers, and never returns the raw exception's `.stack`. A
 * credential lives one field away from everything on this path, and the
 * error string is rendered straight into an admin page; the shortest way to
 * guarantee a token never lands in the DOM is for no code here to be able to
 * put one there.
 */
import type {
  ObservatoryEdge,
  ObservatoryEdgeDay,
  ObservatoryLogEvent,
  ObservatoryLogs,
  ObservatorySource,
} from "@keepsake/contracts/observatory";
import type { Env } from "../env.js";
import { withTimeout } from "../lib/withTimeout.js";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/**
 * Both calls are made while an admin sits watching a spinner, and both are
 * strictly optional garnish on a page that has already rendered its D1 half.
 * 8 seconds is long enough for a cold GraphQL aggregation over 30 days
 * (measured: ~0.8s for a week, and it grows sub-linearly) and short enough
 * that a Cloudflare-side stall shows up as a named timeout on the page
 * rather than as a page that never finishes loading.
 */
const TELEMETRY_TIMEOUT_MS = 8_000;

/** Most recent log lines returned. A feed, not an archive — `counts` in the
 * same payload carries the magnitude, so this cap costs no information about
 * *how much* is wrong, only about the long tail of what. */
const LOG_EVENT_LIMIT = 50;

/**
 * Workers Logs retention on the Free plan is 3 days (see `[observability]` in
 * `wrangler.toml`). Asking for 7 or 30 does not error — it silently returns
 * only what is retained, which would put a "30 days" label above three days
 * of data. Clamped here instead, and the clamped value is what
 * `ObservatoryLogs.window_days` reports back, so the label always matches
 * the data underneath it.
 */
const LOG_RETENTION_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

interface TelemetryConfig {
  token: string;
  accountId: string;
  scriptName: string;
}

/**
 * All three halves of the configuration, or a sentence naming the missing
 * one. Returned as a discriminated result rather than three separate
 * `undefined` checks at both call sites, so "which piece is missing" is
 * stated once and reaches the admin page verbatim — the difference between
 * "the secret isn't set" and "the account id isn't set" is the difference
 * between two very different next actions, and a generic "not configured"
 * makes the reader go and check both.
 */
function telemetryConfig(env: Env): { ok: true; config: TelemetryConfig } | { ok: false; reason: string } {
  const token = env.CF_OBSERVATORY_TOKEN;
  const accountId = env.CF_ACCOUNT_ID as string | undefined;
  const scriptName = env.CF_SCRIPT_NAME as string | undefined;

  if (!token) {
    return { ok: false, reason: "CF_OBSERVATORY_TOKEN is not set — run `wrangler secret put CF_OBSERVATORY_TOKEN`." };
  }
  if (!accountId) {
    return { ok: false, reason: "CF_ACCOUNT_ID is not set in wrangler.toml [vars] for this environment." };
  }
  if (!scriptName) {
    return { ok: false, reason: "CF_SCRIPT_NAME is not set in wrangler.toml [vars] for this environment." };
  }
  return { ok: true, config: { token, accountId, scriptName } };
}

/**
 * `YYYY-MM-DD` for a UTC instant. Matches the `date` dimension Cloudflare's
 * GraphQL API groups by, and `lib/day.ts`'s `todayISO()` shape, so the edge
 * series and the D1 series key on identical strings and can be joined at the
 * render site without either side converting.
 */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Turns any thrown value into one short line. Deliberately does not include
 * `err.stack` — see the module doc comment.
 */
function errorLine(err: unknown, label: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return `${label}: ${message}`;
}

// ---------------------------------------------------------------------------
// Edge traffic — GraphQL Analytics
// ---------------------------------------------------------------------------

/**
 * Two aliased selections against the same dataset in one round trip.
 *
 * `byDay` groups by `date` for the series. `overall` is deliberately
 * *ungrouped*, and that is not redundancy: `quantiles` are computed per
 * result group, so a p99 taken from the by-day rows would be a p99 of one
 * day, and there is no valid way to average day-level percentiles back into
 * a window-level one. The only way to get a correct p50/p99 across the whole
 * window is to ask for it across the whole window, which is what `overall`
 * does. `overall.sum` comes along free and is used in preference to summing
 * `byDay` for the same reason: one source of truth per number.
 *
 * Field names verified against the live API on 2026-09-07 rather than taken
 * from documentation — `date`, `sum { requests errors subrequests }` and
 * `quantiles { cpuTimeP50 cpuTimeP99 }` are what the account actually
 * returns for this dataset.
 */
const EDGE_QUERY = `query Edge($accountTag: String!, $script: String!, $from: Time!, $to: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      byDay: workersInvocationsAdaptive(
        limit: 1000
        filter: { scriptName: $script, datetime_geq: $from, datetime_leq: $to }
        orderBy: [date_ASC]
      ) {
        dimensions { date }
        sum { requests errors subrequests }
      }
      overall: workersInvocationsAdaptive(
        limit: 1
        filter: { scriptName: $script, datetime_geq: $from, datetime_leq: $to }
      ) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
    }
  }
}`;

interface EdgeSum {
  requests: number;
  errors: number;
  subrequests: number;
}

interface GraphQLEdgeResponse {
  data?: {
    viewer?: {
      accounts?: {
        byDay?: { dimensions: { date: string }; sum: EdgeSum }[];
        overall?: { sum: EdgeSum; quantiles: { cpuTimeP50: number | null; cpuTimeP99: number | null } }[];
      }[];
    } | null;
  } | null;
  errors?: { message: string }[] | null;
}

export async function fetchEdgeTelemetry(
  env: Env,
  windowDays: number,
  now: number = Date.now(),
): Promise<ObservatorySource<ObservatoryEdge>> {
  const configured = telemetryConfig(env);
  if (!configured.ok) return { state: "unconfigured", reason: configured.reason };
  const { token, accountId, scriptName } = configured.config;

  // Window start is midnight UTC `windowDays - 1` days back, not `now` minus
  // a duration: the series is bucketed by calendar date, so a rolling
  // 168-hour window would render a half-height first bar that looks like a
  // traffic drop rather than like a partial day.
  const from = new Date(Date.parse(`${utcDate(now - (windowDays - 1) * DAY_MS)}T00:00:00Z`)).toISOString();
  const to = new Date(now).toISOString();

  try {
    const response = await withTimeout(
      fetch(`${CLOUDFLARE_API}/graphql`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: EDGE_QUERY,
          variables: { accountTag: accountId, script: scriptName, from, to },
        }),
      }),
      TELEMETRY_TIMEOUT_MS,
      "cloudflare graphql",
    );

    if (!response.ok) {
      // Status only. The body of a Cloudflare auth failure echoes parts of
      // the request back, and this string is rendered in the admin page.
      return { state: "error", error: `Cloudflare GraphQL returned HTTP ${response.status}` };
    }

    const body = (await response.json()) as GraphQLEdgeResponse;

    // GraphQL reports authorization and query failures in a 200 with a
    // populated `errors` array. Treating a 200 as success is the single
    // easiest way to render "0 requests" over a revoked token.
    if (body.errors && body.errors.length > 0) {
      return { state: "error", error: `Cloudflare GraphQL: ${body.errors.map((e) => e.message).join("; ")}` };
    }

    const account = body.data?.viewer?.accounts?.[0];
    if (!account) {
      return { state: "error", error: "Cloudflare GraphQL returned no account — is CF_ACCOUNT_ID correct?" };
    }

    const overall = account.overall?.[0];
    const byDay: ObservatoryEdgeDay[] = (account.byDay ?? []).map((row) => ({
      date: row.dimensions.date,
      requests: row.sum.requests,
      errors: row.sum.errors,
      subrequests: row.sum.subrequests,
    }));

    return {
      state: "ok",
      data: {
        script: scriptName,
        window_days: windowDays,
        totals: {
          requests: overall?.sum.requests ?? 0,
          errors: overall?.sum.errors ?? 0,
          subrequests: overall?.sum.subrequests ?? 0,
        },
        cpu_time_p50_us: overall?.quantiles.cpuTimeP50 ?? null,
        cpu_time_p99_us: overall?.quantiles.cpuTimeP99 ?? null,
        by_day: byDay,
      },
    };
  } catch (err) {
    return { state: "error", error: errorLine(err, "Cloudflare GraphQL") };
  }
}

// ---------------------------------------------------------------------------
// Log lines — Workers Observability
// ---------------------------------------------------------------------------

interface TelemetryEventSource {
  timestamp?: number;
  level?: string;
  message?: string;
  $metadata?: { level?: string; message?: string; service?: string; requestId?: string };
}

interface TelemetryQueryResponse {
  success?: boolean;
  errors?: { message: string }[];
  result?: {
    events?: { events?: { timestamp?: number; source?: TelemetryEventSource }[] };
    // `view: "count"` fills this instead; shape kept loose because only the
    // single aggregate number is read out of it.
    calculations?: { aggregates?: { value?: number }[] }[];
  };
}

async function telemetryQuery(
  config: TelemetryConfig,
  timeframe: { from: number; to: number },
  level: "error" | "warning",
  view: "events" | "calculations",
): Promise<TelemetryQueryResponse> {
  const response = await withTimeout(
    fetch(`${CLOUDFLARE_API}/accounts/${config.accountId}/workers/observability/telemetry/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        queryId: `keepsake-observatory-${level}-${view}`,
        timeframe,
        limit: view === "events" ? LOG_EVENT_LIMIT : 1,
        view,
        parameters: {
          datasets: ["cloudflare-workers"],
          // Both filters matter. Without `scriptName` this reads every
          // Worker on the account — the probe that established this endpoint
          // scanned 700k rows across unrelated projects — and without
          // `level` it returns ordinary request logs, which are not what an
          // error feed is for.
          filters: [
            { key: "$workers.scriptName", operation: "eq", value: config.scriptName, type: "string" },
            { key: "$metadata.level", operation: "eq", value: level, type: "string" },
          ],
          ...(view === "calculations" ? { calculations: [{ operator: "COUNT", alias: "total" }] } : {}),
        },
      }),
    }),
    TELEMETRY_TIMEOUT_MS,
    "cloudflare observability",
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as TelemetryQueryResponse;
}

export async function fetchLogTelemetry(
  env: Env,
  requestedWindowDays: number,
  now: number = Date.now(),
): Promise<ObservatorySource<ObservatoryLogs>> {
  const configured = telemetryConfig(env);
  if (!configured.ok) return { state: "unconfigured", reason: configured.reason };
  const { config } = configured;

  const windowDays = Math.min(requestedWindowDays, LOG_RETENTION_DAYS);
  const timeframe = { from: now - windowDays * DAY_MS, to: now };

  try {
    // Three calls: the error feed itself, and a count for each level. The
    // counts exist because the feed is capped at `LOG_EVENT_LIMIT` — without
    // them, one stray error and four thousand identical ones render
    // identically, which is exactly the distinction an on-call reader needs
    // and the cap destroys.
    const [errorEvents, errorCount, warningCount] = await Promise.all([
      telemetryQuery(config, timeframe, "error", "events"),
      telemetryQuery(config, timeframe, "error", "calculations"),
      telemetryQuery(config, timeframe, "warning", "calculations"),
    ]);

    const failed = [errorEvents, errorCount, warningCount].find((r) => r.success === false);
    if (failed) {
      return {
        state: "error",
        error: `Cloudflare observability: ${(failed.errors ?? []).map((e) => e.message).join("; ") || "request rejected"}`,
      };
    }

    const events: ObservatoryLogEvent[] = (errorEvents.result?.events?.events ?? []).map((event) => {
      const source = event.source ?? {};
      const metadata = source.$metadata ?? {};
      return {
        ts: event.timestamp ?? source.timestamp ?? 0,
        level: metadata.level ?? source.level ?? "error",
        message: metadata.message ?? source.message ?? "(no message)",
        service: metadata.service ?? null,
        request_id: metadata.requestId ?? null,
      };
    });
    events.sort((a, b) => b.ts - a.ts);

    const readCount = (response: TelemetryQueryResponse): number =>
      response.result?.calculations?.[0]?.aggregates?.[0]?.value ?? 0;

    return {
      state: "ok",
      data: {
        window_days: windowDays,
        counts: { error: readCount(errorCount), warning: readCount(warningCount) },
        events,
      },
    };
  } catch (err) {
    return { state: "error", error: errorLine(err, "Cloudflare observability") };
  }
}
