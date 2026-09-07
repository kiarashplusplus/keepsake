/**
 * Issue #92: `POST /api/listings/:id/reports`, `POST /api/recover` and
 * `POST /api/me/email` were guarded only by a `[[ratelimits]]` burst binding.
 * `src/middleware/rateLimit.ts`'s own header calls that layer best-effort —
 * Cloudflare documents it as "permissive, eventually consistent, and
 * intentionally designed to not be used as an accurate accounting system",
 * and issue #8 measured `RL_UPLOAD` at 10/60s letting 26 requests through —
 * so those three routes had no hard cap at all behind it. Reports drive the
 * three-report auto-hide; the other two put mail in a real inbox.
 *
 * This file is the measurement, not the intention: it sends past the ceiling
 * and reads what comes back, the way #8 measured the leak and the way
 * `adminAuth.test.ts` proved `RL_ADMIN` was reachable at all. The cap under
 * test is the KV `dailyBudget()` layer, which *is* exact (a real read-then-
 * write per caller per day), so "the (N+1)th request is refused" is a claim
 * that can be made precisely — unlike anything about `burst()`.
 *
 * Every case sets its ceiling low via `setTestEnvVar` rather than sending 10
 * real requests: the number in `wrangler.toml` is a tuning decision, but
 * "the (N+1)th is refused, whatever N is" is the property. The controls at
 * the end are what stop this passing for the wrong reason — a second address
 * is unaffected, and the routes answer normally when the budget is untouched.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authHeaders,
  freshClientIp,
  freshOwnerToken,
  insertApprovedListing,
  insertOwner,
  installFakeEmail,
  readErr,
  setTestEnvVar,
} from "./helpers.js";
import { sha256Hex } from "../src/lib/digest.js";
import { ulid } from "../src/lib/ids.js";

/** An `owners` row whose `token_hash` matches `token`, so `ownerAuth()` (no
 * `createIfMissing` on this route) authenticates it. `insertOwner()` in
 * helpers deliberately stores a synthetic hash no token maps to. */
async function insertOwnerWithToken(token: string): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .bind(id, await sha256Hex(token), now, now)
    .run();
  return id;
}

function report(listingId: string, clientIp: string): Promise<Response> {
  return SELF.fetch(`http://x/api/listings/${listingId}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
    body: JSON.stringify({ reason: "not_a_keepsake" }),
  });
}

function recover(email: string, clientIp: string): Promise<Response> {
  return SELF.fetch("http://x/api/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
    body: JSON.stringify({ email }),
  });
}

function setEmail(token: string, email: string, clientIp: string): Promise<Response> {
  return SELF.fetch("http://x/api/me/email", {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
    body: JSON.stringify({ email }),
  });
}

describe("POST /api/listings/:id/reports has a hard daily cap (#92)", () => {
  beforeEach(() => {
    setTestEnvVar("REPORT_IP_DAILY_BUDGET", "3");
  });

  afterEach(() => {
    setTestEnvVar("REPORT_IP_DAILY_BUDGET", "10");
  });

  it("refuses the 4th report of the day from one address, across different listings", async () => {
    const ownerId = await insertOwner();
    // Four *different* listings on purpose: the handler's own per-listing,
    // per-day `ip_digest` uniqueness check would 409 a repeat of the same
    // one, which is not the hole this cap closes. The hole was one address
    // reporting many listings, each toward its own auto-hide.
    const listings = await Promise.all([1, 2, 3, 4].map(() => insertApprovedListing({ ownerId })));
    const ip = freshClientIp();

    const statuses: number[] = [];
    for (const listingId of listings) {
      const res = await report(listingId, ip);
      statuses.push(res.status);
      if (res.status !== 201) {
        const error = await readErr(res);
        expect(error.code).toBe("rate_limited");
        expect(error.retryAfter).toBeGreaterThan(0);
      } else {
        await res.text();
      }
    }

    expect(statuses).toEqual([201, 201, 201, 429]);

    // And the refusal is real, not cosmetic: the 4th listing has no report
    // row and no incremented count behind it.
    const fourth = await env.DB.prepare("SELECT report_count FROM listings WHERE id = ?")
      .bind(listings[3])
      .first<{ report_count: number }>();
    expect(fourth?.report_count).toBe(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE listing_id = ?")
      .bind(listings[3])
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("leaves a different address unaffected (control)", async () => {
    const ownerId = await insertOwner();
    const listings = await Promise.all([1, 2, 3, 4].map(() => insertApprovedListing({ ownerId })));
    const spent = freshClientIp();

    for (const listingId of listings.slice(0, 3)) {
      await (await report(listingId, spent)).text();
    }
    expect((await report(listings[3] as string, spent)).status).toBe(429);

    // The cap is per address, not global: a second reporter still gets
    // through. Without this, a bug that refused everyone once anyone hit the
    // ceiling would pass the test above.
    expect((await report(listings[3] as string, freshClientIp())).status).toBe(201);
  });
});

describe("the mail-sending routes share one hard daily cap (#92)", () => {
  beforeEach(() => {
    installFakeEmail();
    setTestEnvVar("EMAIL_IP_DAILY_BUDGET", "2");
  });

  afterEach(() => {
    setTestEnvVar("EMAIL_IP_DAILY_BUDGET", "10");
  });

  it("refuses the 3rd recovery request of the day from one address", async () => {
    const ip = freshClientIp();

    // `POST /api/recover` always answers 200 whether or not the address is
    // known (it must not confirm which addresses exist), so the ceiling is
    // the only thing that can refuse it.
    expect((await recover("nobody-1@keepsake.ing", ip)).status).toBe(200);
    expect((await recover("nobody-2@keepsake.ing", ip)).status).toBe(200);

    const third = await recover("nobody-3@keepsake.ing", ip);
    expect(third.status).toBe(429);
    const error = await readErr(third);
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfter).toBeGreaterThan(0);

    // Control: a different address is untouched by that caller's spending.
    expect((await recover("nobody-4@keepsake.ing", freshClientIp())).status).toBe(200);
  });

  it("counts /api/recover and /api/me/email into the same bucket", async () => {
    // The reason `email` is one budget kind and not two: alternating between
    // the two mail-sending routes must not buy the allowance twice.
    const ip = freshClientIp();
    const token = freshOwnerToken();
    await insertOwnerWithToken(token);

    expect((await recover("nobody-5@keepsake.ing", ip)).status).toBe(200);
    expect((await recover("nobody-6@keepsake.ing", ip)).status).toBe(200);

    const spilled = await setEmail(token, "someone@keepsake.ing", ip);
    expect(spilled.status).toBe(429);
    expect((await readErr(spilled)).code).toBe("rate_limited");

    // Control: the same call from a fresh address is accepted, so the 429
    // above is the shared ceiling and not a broken route.
    const otherToken = freshOwnerToken();
    await insertOwnerWithToken(otherToken);
    const fresh = await setEmail(otherToken, "someone-else@keepsake.ing", freshClientIp());
    expect(fresh.status).toBe(200);
  });
});
