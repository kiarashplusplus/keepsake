/**
 * Issue #168 — every owner-authenticated write on `listingRoutes` reached its
 * handler with no metering of any kind.
 *
 * `POST /api/listings` was triple-guarded (burst + Turnstile + daily budget)
 * while `PATCH /api/listings/:id`, which costs exactly the same Workers AI
 * calls — it unconditionally schedules the full moderation pipeline and, on
 * any title/story/aspect change, a re-embed — had nothing. The audit fired 60
 * PATCHes from one token and one fixed `CF-Connecting-IP` and got 60x200,
 * with `EMBED_DAILY_BUDGET` (global, no per-IP twin, no reserved floor) and
 * the `mod_text` pool moving one-for-one with the request count.
 *
 * The fix is a router-level registration, not another per-route decision,
 * because per-route decisions are what let this drift — so the test that
 * matters most is the last one in this file: it enumerates the router's own
 * registrations and fails if a write route is ever added outside the guard.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { OwnerListing } from "@keepsake/contracts/listing";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import { listingRoutes } from "../src/routes/listings.js";
import {
  authHeaders,
  freshClientIp,
  freshOwnerToken,
  installDenyingRateLimiter,
  insertApprovedListing,
  insertOwner,
  readOk,
  seedStandardPostalCodes,
  setTestEnvVar,
  uploadPhoto,
} from "./helpers.js";

const VALID_LISTING_BODY = {
  title: "A quiet teacup",
  story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
  category: "home_kitchen",
  country: "US",
  postal_code: "02144",
  date_of_birth: "1990-01-01",
  // Required since the give flow stopped offering a "Skip" on its email
  // step: `POST /api/listings` refuses a first listing with no way back to
  // its giver (neither the body nor the owner row carrying an address).
  email: "giver@keepsake.ing",
};

/** Every non-GET route this router registers, and the request that reaches
 * it. Kept in one place so the enumeration test below can prove it is the
 * *whole* list rather than whichever routes someone remembered. */
const WRITE_ROUTES: { method: string; path: string; url: (id: string) => string; body?: unknown }[] = [
  { method: "POST", path: "/", url: () => "http://x/api/listings", body: VALID_LISTING_BODY },
  { method: "PATCH", path: "/:id", url: (id) => `http://x/api/listings/${id}`, body: { title: "Edited" } },
  { method: "DELETE", path: "/:id", url: (id) => `http://x/api/listings/${id}` },
  { method: "POST", path: "/:id/given", url: (id) => `http://x/api/listings/${id}/given` },
  {
    method: "PUT",
    path: "/:id/category",
    url: (id) => `http://x/api/listings/${id}/category`,
    body: { category: "tools_diy" },
  },
  { method: "POST", path: "/:id/withdraw", url: (id) => `http://x/api/listings/${id}/withdraw` },
  { method: "POST", path: "/:id/relist", url: (id) => `http://x/api/listings/${id}/relist` },
  { method: "POST", path: "/:id/reports", url: (id) => `http://x/api/listings/${id}/reports`, body: { reason: "not_a_keepsake" } },
  {
    method: "POST",
    path: "/:id/requests",
    url: (id) => `http://x/api/listings/${id}/requests`,
    body: { note: "This would mean so much to my family, thank you for considering us.", email: "r@keepsake.ing", date_of_birth: "1990-01-01" },
  },
];

describe("every write on listingRoutes is behind the router-level burst brake (issue #168)", () => {
  it("429s every non-GET route when RL_WRITE denies, before auth or a handler runs", async () => {
    const restore = installDenyingRateLimiter("RL_WRITE");
    try {
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });

      for (const route of WRITE_ROUTES) {
        const res = await SELF.fetch(route.url(listingId), {
          method: route.method,
          // Deliberately no `Authorization` header: the limiter has to sit in
          // front of `ownerAuth`, which mints an `owners` row on sight of any
          // well-formed token. A 429 with no credential presented is the
          // proof it does.
          headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
          ...(route.body ? { body: JSON.stringify(route.body) } : {}),
        });
        expect(`${route.method} ${route.path} -> ${res.status}`).toBe(`${route.method} ${route.path} -> 429`);
      }
    } finally {
      restore();
    }
  });

  it("leaves GET alone — the read path keeps its own RL_READ accounting", async () => {
    const restore = installDenyingRateLimiter("RL_WRITE");
    try {
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });

      const res = await SELF.fetch(`http://x/api/listings/${listingId}`, { headers: { "CF-Connecting-IP": freshClientIp() } });
      expect(res.status).toBe(200);
    } finally {
      restore();
    }
  });

  /**
   * The guard on the guard. `listingRoutes.routes` is Hono's own registry —
   * one entry per registered handler, so middleware and handlers both appear
   * — and the router-level brake shows up as `["POST", "/*"]` and friends.
   * Every other non-GET entry has to be in `WRITE_ROUTES`, which the first
   * test exercises. Add an unguarded write route to `listings.ts` and this
   * fails, naming it.
   */
  it("enumerates the router: no non-GET route exists outside WRITE_ROUTES", () => {
    const covered = new Set(WRITE_ROUTES.map((route) => `${route.method} ${route.path}`));
    const registered = new Set(
      listingRoutes.routes
        .filter((route) => route.method !== "GET" && route.path !== "/*")
        .map((route) => `${route.method} ${route.path}`),
    );
    expect([...registered].filter((entry) => !covered.has(entry))).toEqual([]);
    // And the reverse, so a route deleted from `listings.ts` doesn't leave a
    // stale entry here quietly passing.
    expect([...covered].filter((entry) => !registered.has(entry))).toEqual([]);
  });
});

describe("PATCH /api/listings/:id charges the same daily budget create does (issue #168)", () => {
  afterEach(() => setTestEnvVar("LISTING_IP_DAILY_BUDGET", "20"));

  it("429s an edit once the caller's listing budget for the day is spent", async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("LISTING_IP_DAILY_BUDGET", "1");

    const token = freshOwnerToken();
    const ip = freshClientIp();
    const headers = { ...authHeaders(token), "CF-Connecting-IP": ip, "Content-Type": "application/json" };

    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
    const created = await SELF.fetch("http://x/api/listings", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...VALID_LISTING_BODY, photo_ids: [photo.id] }),
    });
    expect(created.status).toBe(201);
    const listing = await readOk<OwnerListing>(created);

    // The create spent this address's single allowance for the day. The edit
    // costs the same moderation run and the same re-embed, so it draws on the
    // same pool — and there is nothing left in it.
    const patched = await SELF.fetch(`http://x/api/listings/${listing.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "An edited teacup" }),
    });
    expect(patched.status).toBe(429);

    // Untouched: the 429 has to land before the handler, or the AI calls this
    // budget exists to ration have already been scheduled.
    const row = await env.DB.prepare("SELECT title, version FROM listings WHERE id = ?")
      .bind(listing.id)
      .first<{ title: string; version: number }>();
    expect(row?.title).toBe(VALID_LISTING_BODY.title);
    expect(row?.version).toBe(1);
  });
});
