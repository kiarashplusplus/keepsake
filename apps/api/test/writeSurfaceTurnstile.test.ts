/**
 * Issue #246 — nothing enumerated the write surface, so a new non-GET
 * `/api/*` route could ship with no `turnstile()` mount and nothing would
 * say so. That is exactly how #183 happened: `PUT /api/photos` stores
 * caller-supplied bytes and mints a durable identity row with no Turnstile
 * in front of it, and CI could not tell that apart from a route deliberately
 * exempted.
 *
 * The fix, per the issue and per `test/listingWriteMetering.test.ts`'s own
 * model: enumerate the router's own registrations rather than re-derive the
 * route list by hand or by parsing source, and require every non-GET
 * `/api/*` route to be either Turnstile-mounted or named in `ALLOWLIST`
 * with a written reason. An allowlist entry is the deliverable, not an
 * escape hatch — see each `reason` below.
 */
import { describe, expect, it } from "vitest";
import { app } from "../src/index.js";

/** One entry per exact `METHOD /api/path` exemption. */
interface Exemption {
  method: string;
  path: string;
  reason: string;
}

/** One entry per exemption covering every method under a path prefix — for
 * a whole sub-API that shares one non-Turnstile boundary (`/api/admin/*`'s
 * bearer token, `/api/bulk/*`'s documented D1 counters) rather than one
 * route at a time. */
interface PrefixExemption {
  pathPrefix: string;
  reason: string;
}

const ALLOWLIST: Exemption[] = [
  // -------------------------------------------------------------------
  // The single-use-token-in-the-body shape: possession of a token mailed
  // to one address is itself the proof of control a Turnstile challenge
  // would otherwise exist to establish, and the token is 256 bits from
  // `crypto.getRandomValues` — not guessable at any rate a challenge would
  // meaningfully slow.
  // -------------------------------------------------------------------
  {
    method: "POST",
    path: "/api/requests/confirm",
    reason:
      "The single-use token mailed in confirmRequest *is* the credential (routes/requestConfirm.ts's own header) — the same shape as recover/exchange and requests/withdraw below.",
  },
  {
    method: "POST",
    path: "/api/requests/withdraw",
    reason:
      "Same bearer-token-in-body shape as requests/confirm: the single-use withdraw token is the credential, and there is no account to challenge instead.",
  },
  {
    method: "POST",
    path: "/api/recover/exchange",
    reason:
      "\"No Turnstile, unchanged: possession of the mailed token is the proof\" (routes/recover.ts's own comment on this route). POST /api/recover — the step that actually sends mail — does carry turnstile().",
  },
  {
    method: "POST",
    path: "/api/unsubscribe/:token",
    reason:
      "The token is a keyed HMAC of the recipient's address (routes/unsubscribe.ts, src/email/unsubscribe.ts) — unforgeable without UNSUBSCRIBE_SECRET, the same bearer-credential shape as requests/confirm and requests/withdraw above. It also has to work as RFC 8058's List-Unsubscribe-Post one-click target, which a mail client POSTs to directly with no human at a Turnstile widget to solve one.",
  },
  {
    method: "POST",
    path: "/api/resubscribe/:token",
    reason: "Same credential shape as POST /api/unsubscribe/:token immediately above — the token itself is the proof of control.",
  },

  // -------------------------------------------------------------------
  // Owner-authenticated actions on a resource the caller already controls.
  // ownerAuth() is the security boundary for these, the same way it is for
  // every GET under /api/me and /api/listings/:id; a Turnstile challenge
  // in front of an authenticated owner managing their own listing gates
  // the wrong caller.
  // -------------------------------------------------------------------
  {
    method: "PUT",
    path: "/api/photos",
    reason:
      "Pending #183. apps/web/app/give/index.tsx uploads a photo the instant it's picked and mints no Turnstile token at that point in the wizard — mounting turnstile() here would 403 the first photo every real giver picks. burst(RL_UPLOAD) + ownerAuth({createIfMissing:true}) + the per-IP upload budget stand in until the client changes (see routes/photos.ts's own comment on this exact route).",
  },
  {
    method: "PATCH",
    path: "/api/listings/:id",
    reason:
      "The web edit step mints no Turnstile token, so mounting one would break the real edit flow rather than harden it (routes/listings.ts's own comment on this route). burst(RL_WRITE) + LISTING_IP_DAILY_BUDGET, which charges the same moderation/embed cost create does, stand in.",
  },
  {
    method: "DELETE",
    path: "/api/listings/:id",
    reason:
      "ownerAuth() is the boundary: the owner deleting their own listing costs no AI call and sends no mail. burst(RL_WRITE) covers the write-rate concern a challenge would otherwise address.",
  },
  {
    method: "POST",
    path: "/api/listings/:id/given",
    reason:
      "ownerAuth() is the boundary: marking the caller's own approved listing given is a one-column status flip with no AI cost and no mail. burst(RL_WRITE) covers the write rate.",
  },
  {
    method: "PUT",
    path: "/api/listings/:id/category",
    reason:
      "ownerAuth() is the boundary. Deliberately not PATCH, and deliberately cheap by design (routes/listings.ts's own comment on this route): no re-embed, no re-moderation, one column plus a timestamp — a Turnstile challenge would tax a giver correcting a one-word label harder than the write itself costs.",
  },
  {
    method: "POST",
    path: "/api/listings/:id/withdraw",
    reason:
      "ownerAuth() is the boundary: withdrawing the caller's own listing is a one-column status flip with no AI cost and no mail. burst(RL_WRITE) covers the write rate.",
  },
  {
    method: "POST",
    path: "/api/listings/:id/relist",
    reason:
      "ownerAuth() is the boundary: relisting re-publishes a listing the owner already controls (see the takedown-precedence comment on this route) — no new moderation run, no AI cost, no mail. burst(RL_WRITE) covers the write rate.",
  },
  {
    method: "DELETE",
    path: "/api/photos/:id",
    reason:
      "ownerAuth() is the boundary: deleting the caller's own unattached or listing photo costs no AI call and sends no mail.",
  },
  {
    method: "POST",
    path: "/api/photos/:id/suggest",
    reason:
      "ownerAuth() is the boundary. Bounded by SUGGEST_DAILY_BUDGET (global) and an IP daily budget checked inline (routes/photos.ts), the same D1-counter shape #246's sibling issue documents for bulk — a vision call's cost is rationed by those counters, not by a Turnstile challenge.",
  },
  {
    method: "POST",
    path: "/api/me/listings/:id/choose",
    reason:
      "ownerAuth() is the boundary: this is the owner picking among requests already gathered on their own listing. It does mail the chosen requester, but that address came from a request that reached this listing through its own turnstile()-gated POST .../requests — the challenge already happened one step upstream of the owner's dashboard action.",
  },
  {
    method: "DELETE",
    path: "/api/me/email",
    reason:
      "ownerAuth() is the boundary. Unlike POST /api/me/email two lines above it (which mails a verification link and carries turnstile() + dailyBudget), this only nulls the caller's own owner row — no outbound side effect for a challenge to protect.",
  },
];

const PREFIX_ALLOWLIST: PrefixExemption[] = [
  {
    pathPrefix: "/api/admin/",
    reason:
      "adminRoutes.use(\"*\", burst(\"RL_ADMIN\"), adminAuth()) gates every route under this prefix on the admin bearer token (AGENTS.md's \"Admin tokens\" section) — the credential a Turnstile challenge would otherwise be standing in for is already required on every request.",
  },
  {
    pathPrefix: "/api/bulk/",
    reason:
      'docs/design/bulk-upload.md, "What bounds a batch (there is no admission code)": a Turnstile token is single-use and expires in 300s, so mounting it here would mean one challenge per photo — hundreds for one estate batch. BULK_MAX_ITEMS_PER_BATCH/BULK_MAX_PHOTOS_PER_BATCH (guarded D1 predicates on the insert itself) and bulk_owner_usage (a per-owner-per-day D1 counter) bound the surface instead, and are exact rather than eventually-consistent the way the KV budgets are.',
  },
];

/** True when `handler.name` marks this entry as the `turnstile()`
 * middleware itself. Hono registers one `RouterRoute` per handler passed to
 * `.post(path, mw1, mw2, handler)` (`node_modules/hono/dist/hono-base.js`'s
 * `#addRoute`, called once per argument) — all sharing the same
 * method+path — so a route's full chain is "every entry in `app.routes`
 * with this method and this path", and this predicate is what makes one of
 * them recognisable as the Turnstile mount. */
function isTurnstileHandler(handler: unknown): boolean {
  return typeof handler === "function" && handler.name === "turnstileMiddleware";
}

interface RouteRecord {
  method: string;
  path: string;
  handler: unknown;
}

/**
 * Every entry in the real app's route table, method-normalised, with the
 * global middleware (`app.use("*", ...)`, each router's own `.use("*", ...)`
 * / `.on([...], "*", ...)` wildcard mounts) and every `GET`/`HEAD` filtered
 * out — this guard is only about the non-GET `/api/*` write surface.
 * `app.routes` already carries each sub-router's paths merged onto its real
 * mount prefix (`hono-base.js`'s `.route()`), so this is the real,
 * currently-deployed route table, not a hand-copied restatement of it.
 */
function apiWriteRoutes(): RouteRecord[] {
  return app.routes
    .filter((r) => r.method !== "GET" && r.method !== "HEAD" && r.method !== "ALL")
    .filter((r) => r.path.startsWith("/api/"))
    .filter((r) => r.path !== "/api/*" && !r.path.endsWith("/*"))
    .map((r) => ({ method: r.method, path: r.path, handler: r.handler }));
}

/** One (method, path) pair per distinct write route, deduplicated from the
 * one-entry-per-handler shape `app.routes` actually has. */
function distinctRoutes(records: RouteRecord[]): { method: string; path: string }[] {
  const seen = new Map<string, { method: string; path: string }>();
  for (const r of records) {
    seen.set(`${r.method} ${r.path}`, { method: r.method, path: r.path });
  }
  return [...seen.values()];
}

describe("every non-GET /api/* route is Turnstile-mounted or a reasoned allowlist entry (#246)", () => {
  const records = apiWriteRoutes();
  const routes = distinctRoutes(records);

  it("finds the write surface (positive control)", () => {
    // Without this, every assertion below would pass vacuously against an
    // empty table — the exact shape AGENTS.md's guard-table warns about.
    expect(routes.length).toBeGreaterThan(20);
    expect(routes).toContainEqual({ method: "POST", path: "/api/listings" });
  });

  it("recognises the turnstile() mount it relies on (positive control)", () => {
    // If this predicate ever stopped matching real routes — a refactor of
    // turnstile.ts renaming the returned function, say — every route that
    // actually is protected would look unprotected and fall through to the
    // allowlist-membership check below, where it isn't listed, and the
    // suite would (correctly) go red. This pins the detector itself against
    // a known-protected route so that failure mode is diagnosable instead
    // of looking identical to a genuinely new unguarded route.
    const createListingHandlers = records.filter((r) => r.method === "POST" && r.path === "/api/listings");
    expect(createListingHandlers.some((r) => isTurnstileHandler(r.handler))).toBe(true);
  });

  it("has no allowlist entry for a route that no longer exists", () => {
    // The reverse of the main assertion: an allowlist entry surviving a
    // deleted or renamed route would quietly stop meaning anything, the
    // same failure `listingWriteMetering.test.ts` guards against for
    // `WRITE_ROUTES`.
    const registered = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const stale = ALLOWLIST.filter((e) => !registered.has(`${e.method} ${e.path}`));
    expect(stale).toEqual([]);
  });

  it("every non-GET /api/* route is turnstile-mounted or explicitly, reasonedly allowlisted", () => {
    const byRoute = new Map<string, RouteRecord[]>();
    for (const r of records) {
      const key = `${r.method} ${r.path}`;
      byRoute.set(key, [...(byRoute.get(key) ?? []), r]);
    }

    const exactAllowed = new Set(ALLOWLIST.map((e) => `${e.method} ${e.path}`));

    const unaccountedFor: string[] = [];
    for (const { method, path } of routes) {
      const key = `${method} ${path}`;
      const handlers = byRoute.get(key) ?? [];
      if (handlers.some((h) => isTurnstileHandler(h.handler))) continue;
      if (exactAllowed.has(key)) continue;
      const prefixHit = PREFIX_ALLOWLIST.find((p) => path.startsWith(p.pathPrefix));
      if (prefixHit && prefixHit.reason.length > 0) continue;
      unaccountedFor.push(key);
    }

    // Naming the routes directly in the assertion, not just the count: this
    // is what "fails loudly, naming it" (AGENTS.md, and the issue's own
    // verification instruction) means in practice.
    expect(unaccountedFor).toEqual([]);
  });

  it("every allowlist entry carries an actual reason, not a placeholder", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length, `${entry.method} ${entry.path}`).toBeGreaterThan(20);
    }
    for (const entry of PREFIX_ALLOWLIST) {
      expect(entry.reason.length, entry.pathPrefix).toBeGreaterThan(20);
    }
  });
});
