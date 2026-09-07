import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as Sentry from "@sentry/cloudflare";
import { sentryOptions } from "@keepsake/observability/init";
import { apiErr } from "@keepsake/contracts/common";
import { assertBindings, isProduction, type Env } from "./env.js";
import { moderationRetry } from "./cron/moderationRetry.js";
import { orphanSweep } from "./cron/orphanSweep.js";
import { ukBlock } from "./middleware/ukBlock.js";
import { geoRoutes } from "./routes/geo.js";
import { photoRoutes } from "./routes/photos.js";
import { listingRoutes } from "./routes/listings.js";
import { meRoutes } from "./routes/me.js";
import { imageRoutes } from "./routes/images.js";
import { feedRoutes } from "./routes/feed.js";
import { itemRoutes } from "./routes/item.js";
import { robotsRoutes } from "./routes/robots.js";
import { sitemapRoutes } from "./routes/sitemap.js";
import { recoverRoutes } from "./routes/recover.js";
import { adminRoutes } from "./routes/admin.js";
import { requestWithdrawRoutes } from "./routes/requestWithdraw.js";

type Variables = {
  requestId: string;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Every response carries the id it was handled under, so a report from a
// giver ("it said something went wrong") can be matched to a log line
// without either side reading the body of an error response to each other.
app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  await next();
  c.header("X-Request-Id", requestId);

  // Launch audit finding 2. `robots.txt` is a request a crawler may or may
  // not make; this header travels on the response it already has, and is the
  // half that gets a preview URL *removed* from an index rather than merely
  // asking not to be added to one. Set on every non-production response, not
  // just HTML: `/item/:id`'s OG shell, `/i/:id/:variant` photos and the JSON
  // API are all indexable surfaces, and image search is exactly how a
  // stranger's keepsake photo would surface from a host nobody is watching.
  if (!isProduction(c.env)) {
    c.header("X-Robots-Tag", "noindex, nofollow");
  }
});

// Mounted early, before any route: see src/middleware/ukBlock.ts and
// docs/runbooks/uk-block.md. Reads and writes both, `/api/*` and the SPA
// shell alike — nothing behind this line should ever see a UK visitor.
app.use("*", ukBlock());

app.onError((err, c) => {
  const status: ContentfulStatusCode = err instanceof HTTPException ? err.status : 500;
  console.error("unhandled error", {
    requestId: c.get("requestId"),
    path: c.req.path,
    status,
    error: err instanceof Error ? err.message : String(err),
  });
  // `withSentry` below instruments `app.fetch` itself, but Hono's own
  // `onError` already turns every thrown error into a normal JSON response
  // before that instrumentation ever sees an exception propagate — so
  // without this explicit call, a route bug would show up in the Worker's
  // own logs but never in Sentry. `captureException` is a safe no-op when
  // `SENTRY_DSN` is unset (no client, per `buildSentryOptions` below).
  Sentry.captureException(err);
  // Every code here must be one of `@keepsake/contracts/common`'s
  // `ERROR_CODES` — this is the catch-all for anything a route didn't
  // already turn into a proper `fail(...)` response via `src/lib/respond.ts`,
  // so "internal" (an unexpected failure) is the only honest code for it.
  return c.json(apiErr("internal", err.message), status);
});

app.get("/health", async (c) => {
  const { ok: bindingsOk, checks: bindingChecks } = assertBindings(c.env);

  // A dedicated read past `assertBindings`' presence check: the D1 binding
  // can exist and still be unreachable (wrong database_id, D1 outage), and
  // that's the failure mode `/health` exists to catch.
  let d1: "ok" | "error";
  try {
    await c.env.DB.prepare("SELECT 1").first();
    d1 = "ok";
  } catch (err) {
    console.error("health: D1 check failed", { error: err instanceof Error ? err.message : String(err) });
    d1 = "error";
  }

  // Neither secret's presence nor absence is ever put in the response body
  // by name — only this rolled-up "ok"/"degraded" verdict — and only in
  // `production`. Local dev and preview routinely run without Turnstile/
  // admin provisioned yet (see `.dev.vars.example`); that shouldn't make
  // their `/health` look unhealthy the way it must once traffic is real.
  const secretsConfigured = Boolean(c.env.TURNSTILE_SECRET) && Boolean(c.env.ADMIN_TOKEN);
  const secrets: "ok" | "degraded" = !isProduction(c.env) || secretsConfigured ? "ok" : "degraded";

  const checks = { ...bindingChecks, d1, secrets };
  const ok = bindingsOk && d1 === "ok";
  const degraded = secrets === "degraded";
  const commit = c.env.COMMIT_SHA ?? "dev";

  return c.json(
    {
      ok,
      degraded,
      commit,
      env: c.env.ENVIRONMENT,
      // Same shape `/version.json` returns, inlined here too so a single
      // `/health` fetch is enough to confirm which build answered — no
      // second round trip needed just to double-check the commit.
      version: { commit, environment: c.env.ENVIRONMENT },
      checks,
    },
    ok ? 200 : 503,
  );
});

app.get("/version.json", (c) => {
  // Never cached: this is exactly what apps/web's version-skew guard polls to
  // notice a new deploy, so a stale cached copy would defeat the point.
  c.header("Cache-Control", "no-store");
  return c.json({ commit: c.env.COMMIT_SHA ?? "dev" });
});

app.route("/api/geo", geoRoutes);
app.route("/api/photos", photoRoutes);
app.route("/api/listings", listingRoutes);
app.route("/api/me", meRoutes);
app.route("/api/feed", feedRoutes);
app.route("/api/recover", recoverRoutes);
app.route("/api/requests", requestWithdrawRoutes);
app.route("/api/admin", adminRoutes);
app.route("/i", imageRoutes);
// Mounted at the Worker root, per the plan's route table — not under /api/*,
// and reached at all only because wrangler.toml's `run_worker_first` lists
// these exact paths, overriding the static-assets system that would
// otherwise serve them as SPA-shell/404 before this Worker code ever runs.
app.route("/item", itemRoutes);
app.route("/sitemap.xml", sitemapRoutes);
// Same deal as `/sitemap.xml`: reached only because `run_worker_first` lists
// `/robots.txt`, so this handler answers instead of the static asset that
// also exists at that path. Production delegates straight back to that asset;
// see `routes/robots.ts`.
app.route("/robots.txt", robotsRoutes);

app.all("/api/*", (c) => c.json({ ok: false as const, error: { code: "not_found", message: "Not found" } }, 404));

// Everything else — the SPA shell, hashed static assets, `/item/:id` (M2
// will layer HTMLRewriter OG injection on top of this same fetch) — is
// served by the `ASSETS` binding. Only the HTML document is forced to
// `no-store`; hashed `/_expo/static/*` assets keep whatever immutable
// caching header the assets binding already set, untouched.
app.all("*", async (c) => {
  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  const contentType = assetResponse.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return assetResponse;
  }

  const headers = new Headers(assetResponse.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
});

/**
 * Runs one cron job to completion and makes a failure *visible*.
 *
 * Launch audit finding 12: both jobs used to be handed to
 * `ctx.waitUntil(...)` and the handler returned immediately. Two things
 * followed from that, and neither was survivable. Sentry's scheduled
 * instrumentation wraps this handler, so it had already resolved by the time
 * the job did any work — its `finally` disposes the client while the job is
 * still running, and a rejection inside `orphanSweep` or `moderationRetry`
 * became a detached unhandled rejection with nothing to catch it. And
 * Cloudflare judges a cron invocation by whether the handler resolved, so a
 * job that threw every single night still reported as a successful run,
 * forever, in silence.
 *
 * Awaiting instead fixes both: the exception propagates into the
 * instrumentation that exists to report it, this function additionally
 * captures it with the job's name attached (so the Sentry issue says which
 * cron, not just "scheduled"), and rethrowing marks the invocation failed in
 * the Cloudflare dashboard. The heartbeat each job writes as its last
 * statement (`cron:last:<name>` in KV) stays the positive signal —
 * `GET /api/admin/health` turns a stale one into `ok: false`.
 *
 * `ctx` is still passed and used for `waitUntil`, so the job keeps running if
 * the request context is torn down early — belt and braces, not either/or.
 */
async function runCron(name: string, job: (env: Env) => Promise<void>, env: Env, ctx: ExecutionContext): Promise<void> {
  const started = Date.now();
  const running = job(env);
  ctx.waitUntil(running);
  try {
    await running;
    console.log("scheduled: done", { cron: name, durationMs: Date.now() - started });
  } catch (err) {
    console.error("scheduled: failed", {
      cron: name,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    Sentry.captureException(err, { tags: { cron: name } });
    // Rethrow so the invocation is recorded as failed by the platform too —
    // Sentry is the alert, the dashboard is the audit trail, and a job that
    // silently "succeeded" while doing nothing is the exact failure mode this
    // whole function exists to remove.
    throw err;
  }
}

async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  switch (controller.cron) {
    case "*/5 * * * *":
      await runCron("moderationRetry", moderationRetry, env, ctx);
      break;
    case "17 3 * * *":
      await runCron("orphanSweep", orphanSweep, env, ctx);
      break;
    default:
      console.warn("scheduled: unrecognized cron pattern", { cron: controller.cron });
  }
}

/** Exported for `test/cron.test.ts`: the scheduled handler is not reachable
 * through `SELF.fetch`, and the property under test — a throwing job reaches
 * Sentry and is rethrown rather than swallowed — is not observable from
 * anywhere else. */
export { runCron };

/**
 * `withSentry`'s options callback, exported for direct unit testing. Returns
 * `undefined` — the documented way to tell `withSentry` not to initialize a
 * client at all — whenever `SENTRY_DSN` is unset, which is true for local
 * dev and any preview/production deploy before the DSN secret is
 * provisioned. `@keepsake/observability/init`'s `sentryOptions()` already
 * wires `beforeSend`/`beforeBreadcrumb` to the redaction layer; the double
 * cast at the end exists only because that package is dependency-free (no
 * `@sentry/*` import allowed in it) and so its plain `(event: unknown) =>
 * unknown` function types don't structurally satisfy Sentry's own
 * `Event`/`Breadcrumb`-typed callback signatures — the redaction functions
 * themselves operate on plain objects either way, so the mismatch is in the
 * type system only, not in behavior.
 */
export function buildSentryOptions(env: Env): Sentry.CloudflareOptions | undefined {
  if (!env.SENTRY_DSN) return undefined;
  return sentryOptions({
    service: "keepsake-api",
    runtime: "cloudflare",
    dsn: env.SENTRY_DSN,
    environment: env.ENVIRONMENT,
    release: env.COMMIT_SHA,
  }) as unknown as Sentry.CloudflareOptions;
}

// `withSentry` instruments both `fetch` and `scheduled` on the handler
// object it's given (see @sentry/cloudflare's own `withSentry.ts`), so the
// cron handler above is covered by the same wrapping as every HTTP route —
// no separate scheduled-specific setup needed.
export default Sentry.withSentry(buildSentryOptions, {
  fetch: app.fetch,
  scheduled,
});
