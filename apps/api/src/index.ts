import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { assertBindings, type Env } from "./env.js";
import { moderationRetry } from "./cron/moderationRetry.js";
import { orphanSweep } from "./cron/orphanSweep.js";

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
});

app.onError((err, c) => {
  const status: ContentfulStatusCode = err instanceof HTTPException ? err.status : 500;
  const code = err instanceof HTTPException ? "http_error" : "internal_error";
  console.error("unhandled error", {
    requestId: c.get("requestId"),
    path: c.req.path,
    status,
    error: err instanceof Error ? err.message : String(err),
  });
  return c.json({ ok: false as const, error: { code, message: err.message } }, status);
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

  const checks = { ...bindingChecks, d1 };
  const ok = bindingsOk && d1 === "ok";

  return c.json(
    {
      ok,
      commit: c.env.COMMIT_SHA ?? "dev",
      env: c.env.ENVIRONMENT,
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

// M1: real routes (feed, listings, photos, requests, me, admin, …) mount
// here, above this catch-all, per the plan's API table. Until then every
// /api/* path is an honest 404 rather than falling through to the SPA shell.
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

async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  switch (controller.cron) {
    case "*/5 * * * *":
      ctx.waitUntil(moderationRetry(env));
      break;
    case "17 3 * * *":
      ctx.waitUntil(orphanSweep(env));
      break;
    default:
      console.warn("scheduled: unrecognized cron pattern", { cron: controller.cron });
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
