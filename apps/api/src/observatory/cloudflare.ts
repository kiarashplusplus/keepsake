/**
 * The Cloudflare-side read behind the Observatory: edge traffic from the
 * GraphQL Analytics API.
 *
 * It is a plain `fetch` against `api.cloudflare.com`, not a binding. There is
 * no binding for this dataset — the Worker cannot query its own analytics from
 * inside itself — so this needs a real API credential, which is the one
 * genuinely awkward thing about the whole feature and the reason for the care
 * below.
 *
 * This module used to carry a second read: the Worker's own log lines, from
 * the Workers Observability telemetry API. That is gone (issue #159, step 1).
 * Workers Logs retains 3 days on the Free plan, so the panel whose job is
 * "what went wrong" could not answer anything about last weekend; the lines
 * are now written to D1 by the Tail Worker and read back by
 * `./errorEvents.ts`, with no credential at all. The `Workers Observability
 * Read` half of `CF_OBSERVATORY_TOKEN`'s scope is unused as of that change —
 * it is left on the token rather than re-minted, since narrowing a read-only
 * token is not worth a rotation, but a token minted fresh only needs
 * `Account Analytics Read`.
 *
 * ## The credential
 *
 * `CF_OBSERVATORY_TOKEN` is a *separate, read-only* token from
 * `CF_CACHE_PURGE_TOKEN`, scoped to account permission groups that can read
 * analytics and nothing else. It is not the broad account token used from a
 * laptop, and it deliberately cannot write anything, cannot read D1/R2/KV, and
 * cannot touch DNS. If it leaks, what leaks is the ability to read request
 * counts for this account — bad, but bounded, and revocable without touching
 * anything the running site depends on. A Worker that holds a credential able
 * to redeploy itself is a much worse trade for a dashboard.
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
import type { ObservatoryEdge, ObservatoryEdgeDay, ObservatorySource } from "@keepsake/contracts/observatory";
import type { Env } from "../env.js";
import { withTimeout } from "../lib/withTimeout.js";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/**
 * The call is made while an admin sits watching a spinner, and it is strictly
 * optional garnish on a page that has already rendered its D1 half.
 * 8 seconds is long enough for a cold GraphQL aggregation over 30 days
 * (measured: ~0.8s for a week, and it grows sub-linearly) and short enough
 * that a Cloudflare-side stall shows up as a named timeout on the page
 * rather than as a page that never finishes loading.
 */
const TELEMETRY_TIMEOUT_MS = 8_000;

/**
 * Widest window the GraphQL Analytics API will accept for this account,
 * measured rather than read off a docs page: a 31-day query returns 32
 * contiguous daily rows, and 40 days is refused outright with
 * `cannot request a time range wider than 4w4d`.
 *
 * Nothing clamps to it, deliberately. A window that exceeded it would be
 * *refused* — surfacing as `{ state: "error" }` carrying Cloudflare's own
 * message — rather than silently returning a short series under a long
 * label, and loud is the right failure here.
 *
 * What this must not become is a comment nobody checks: the zero-fill above
 * reads a missing day as zero, which is only honest while every window fits
 * inside this ceiling. Exported so `test/observatory.test.ts` asserts exactly
 * that against `OBSERVATORY_WINDOWS`, so widening the set past 32 days fails
 * a test rather than quietly turning gaps into zeroes.
 */
export const MAX_EDGE_WINDOW_DAYS = 32;

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
  const windowStart = Date.parse(`${utcDate(now - (windowDays - 1) * DAY_MS)}T00:00:00Z`);
  const from = new Date(windowStart).toISOString();
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

    // Zero-filled across the window's calendar days rather than passed
    // through as Cloudflare returned it. Cloudflare emits no row at all for a
    // day with no invocations, so the raw result is sparse — and a chart fed
    // only the days that exist closes the gap and draws a continuous line
    // across the one day the Worker served nothing, which is exactly the day
    // worth seeing. `appMetrics.ts` seeds its D1 series the same way for the
    // same reason; before this they disagreed, and a 7-day window over a
    // quiet Worker rendered 7 bars against 2.
    //
    // "No row" is only safely read as "zero" because the API covers the whole
    // window: every value in `OBSERVATORY_WINDOWS` is inside the 32-day
    // ceiling below, so there is no region where a missing day means "we did
    // not look that far back". If that stops being true, this becomes the
    // confident-empty lie `ObservatorySource` exists to prevent.
    const byDate = new Map((account.byDay ?? []).map((row) => [row.dimensions.date, row.sum]));
    const byDay: ObservatoryEdgeDay[] = Array.from({ length: windowDays }, (_, i) => {
      const date = utcDate(windowStart + i * DAY_MS);
      const sum = byDate.get(date);
      return {
        date,
        requests: sum?.requests ?? 0,
        errors: sum?.errors ?? 0,
        subrequests: sum?.subrequests ?? 0,
      };
    });

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
