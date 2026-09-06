/**
 * Launch audit finding 9: `RL_READ` was declared in all three environment
 * blocks of `wrangler.toml` and used by nothing. `grep -rn 'burst(' apps/api/src`
 * returned eight call sites and `RL_READ` was not among them — it appeared
 * only in a comment — so `/api/feed`, `/api/listings/:id`, `/item/:id`,
 * `/i/:id/:variant` and `/api/geo/*` had no rate limiting whatsoever. 320
 * parallel `GET /api/feed` from one address returned 320x 200.
 *
 * These tests exist because "declared but never called" is the exact bug, and
 * the only way a test can catch it is to check the call actually happens on
 * each route. They swap `RL_READ` for a binding that denies everything, so a
 * single request per route is enough and no test has to exhaust a 300/60s
 * limiter (which would be slow and, per finding 10's measured ~2.5x leakage
 * on the real bindings, unreliable).
 *
 * The trailing "still serves when the binding allows" case is the control: it
 * proves the 429s above come from the limiter and not from the routes being
 * broken.
 */
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { freshClientIp, insertApprovedListing, insertOwner, installDenyingRateLimiter, readErr } from "./helpers.js";

/** Every public read surface. A route added here without `burst("RL_READ")`
 * fails this suite rather than quietly shipping unmetered. */
const READ_ROUTES = [
  "/api/feed",
  "/api/geo/lookup?country=US&code=02144",
  "/api/listings/01M1TEVSEDJDEVN5Q1D9BBW4ZR",
  "/item/01M1TEVSEDJDEVN5Q1D9BBW4ZR",
  "/i/01M1TEVSEDJDEVN5Q1D9BBW4ZR/thumb",
];

describe("RL_READ is wired to the public read routes", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it.each(READ_ROUTES)("429s %s when the burst binding denies", async (path) => {
    restore = installDenyingRateLimiter("RL_READ");

    const res = await SELF.fetch(`http://x${path}`, { headers: { "CF-Connecting-IP": freshClientIp() } });

    expect(res.status).toBe(429);
    expect((await readErr(res)).code).toBe("rate_limited");
  });

  // The control. Ids that do not exist answer 404 rather than 429, and a real
  // listing answers 200 — so the assertions above are about the limiter, not
  // about these routes being unreachable in the test runtime.
  it("serves normally when the binding allows", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId, title: "A readable teacup" });

    const feed = await SELF.fetch("http://x/api/feed", { headers: { "CF-Connecting-IP": freshClientIp() } });
    expect(feed.status).toBe(200);

    const listing = await SELF.fetch(`http://x/api/listings/${listingId}`, {
      headers: { "CF-Connecting-IP": freshClientIp() },
    });
    expect(listing.status).toBe(200);

    const missingImage = await SELF.fetch("http://x/i/01M1TEVSEDJDEVN5Q1D9BBW4ZR/thumb", {
      headers: { "CF-Connecting-IP": freshClientIp() },
    });
    expect(missingImage.status).toBe(404);
  });
});
