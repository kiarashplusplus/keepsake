import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { timingSafeEqualStrings } from "../src/middleware/adminAuth.js";
import { freshClientIp, installCountingRateLimiter, installDenyingRateLimiter, readErr, setTestEnvVar } from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";

describe("timingSafeEqualStrings", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualStrings("abc123", "abc123")).toBe(true);
  });

  it("returns false for a same-length mismatch", () => {
    expect(timingSafeEqualStrings("abc123", "abc124")).toBe(false);
  });

  it("returns false for different-length strings without throwing", () => {
    expect(timingSafeEqualStrings("short", "a-much-longer-string")).toBe(false);
  });

  // Guard validated by breaking it: a version that loops only over
  // `Math.min(a.length, b.length)` and never folds the length difference
  // into the result would pass every case above (they all differ in
  // content within the shorter string's own bytes) but would wrongly
  // return `true` here, since "abc" is a byte-for-byte prefix of
  // "abcabc" — the only thing that distinguishes them is length, which a
  // min-length loop never looks at. Confirmed by temporarily changing
  // `src/middleware/adminAuth.ts` to that shape: this is the one case in
  // the file that failed, everything else still passed.
  it("returns false when one string is a byte-for-byte prefix of the other", () => {
    expect(timingSafeEqualStrings("abc", "abcabc")).toBe(false);
    expect(timingSafeEqualStrings("abcabc", "abc")).toBe(false);
  });

  it("treats two empty strings as equal", () => {
    expect(timingSafeEqualStrings("", "")).toBe(true);
  });

  // Both a naive `a === b` and a short-circuiting `for` loop that returns
  // the moment it finds a mismatch would also pass this pair of assertions —
  // this test only pins the *observable* boolean result for a mismatch at
  // each end, which is all that's mechanically testable from outside the
  // function. The constant-time property itself (equal work regardless of
  // where the mismatch falls) is a property of the implementation in
  // `src/middleware/adminAuth.ts`, not something a black-box timing
  // assertion in a fast, jittery test runner could reliably verify.
  it("returns false whether the mismatch is at the start or the end", () => {
    expect(timingSafeEqualStrings("Xbc123", "abc123")).toBe(false);
    expect(timingSafeEqualStrings("abc12X", "abc123")).toBe(false);
  });
});

describe("/api/admin/* auth", () => {
  afterEach(() => {
    // Falsy, same as "unset" for `adminAuth`'s `if (!secret)` check — keeps
    // this file's tests from leaking a configured token into any other test
    // file sharing the same worker isolate.
    setTestEnvVar("ADMIN_TOKEN", "");
  });

  it("401s every request when ADMIN_TOKEN is unset", async () => {
    const res = await SELF.fetch("http://x/api/admin/stats", {
      headers: { "CF-Connecting-IP": freshClientIp() },
    });
    expect(res.status).toBe(401);
    const error = await readErr(res);
    expect(error.code).toBe("unauthorized");
  });

  it("401s with no Authorization header once a token is configured", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const res = await SELF.fetch("http://x/api/admin/stats", {
      headers: { "CF-Connecting-IP": freshClientIp() },
    });
    expect(res.status).toBe(401);
  });

  it("401s with a wrong token", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const res = await SELF.fetch("http://x/api/admin/stats", {
      headers: { Authorization: "Bearer wrong-token", "CF-Connecting-IP": freshClientIp() },
    });
    expect(res.status).toBe(401);
  });

  it("200s with the right token", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const res = await SELF.fetch("http://x/api/admin/stats", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "CF-Connecting-IP": freshClientIp() },
    });
    expect(res.status).toBe(200);
  });

  // Launch audit finding 6: the response body used to say "Admin is not
  // configured." when ADMIN_TOKEN was unset and "Invalid admin token."
  // otherwise, handing an attacker a free oracle for whether the credential
  // exists at all — despite adminAuth's own docblock claiming the two are
  // indistinguishable.
  it("returns the same 401 body whether the token is unset or wrong", async () => {
    const unconfigured = await SELF.fetch("http://x/api/admin/stats", {
      headers: { Authorization: "Bearer anything", "CF-Connecting-IP": freshClientIp() },
    });
    const unconfiguredError = await readErr(unconfigured);

    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const wrong = await SELF.fetch("http://x/api/admin/stats", {
      headers: { Authorization: "Bearer definitely-not-the-token", "CF-Connecting-IP": freshClientIp() },
    });
    const wrongError = await readErr(wrong);

    expect(unconfigured.status).toBe(wrong.status);
    expect(unconfiguredError.code).toBe(wrongError.code);
    expect(unconfiguredError.message).toBe(wrongError.message);
  });
});

// ---------------------------------------------------------------------------
// Launch audit finding 6: the admin token could be brute-forced without
// limit, because `adminRoutes.use("*", adminAuth(), burst("RL_ADMIN"))` ran
// auth first and `adminAuth` answers a bad token with `fail(...)` — it never
// calls `next()`, so `burst` was unreachable for exactly the requests that
// needed metering. Measured against preview: 150 distinct wrong tokens from
// one IP inside 60s, against a binding configured `limit = 120, period = 60`,
// returned 150x401 and 0x429.
//
// Two tests, deliberately, because they fail for different reasons:
//
//  1. The counting test below reproduces the audit's own measurement — more
//     wrong guesses than the binding's limit, from a single IP, must produce
//     at least one 429. It is the closest thing to the observation that
//     found the bug.
//  2. The ordering test after it replaces `RL_ADMIN` with a binding that
//     denies everything, so a *single* request is enough to prove the
//     limiter runs before auth rather than behind it. It stays fast and
//     deterministic even if Cloudflare's real bindings leak (the audit
//     measured ~2.5x leakage on `RL_UPLOAD` in production), which is exactly
//     the kind of approximation that could otherwise make test 1 flaky.
//
// Both fail with the middleware in its original order: every wrong token
// returns 401 and the limiter never runs.
// ---------------------------------------------------------------------------
describe("/api/admin/* brute-force protection", () => {
  afterEach(() => {
    setTestEnvVar("ADMIN_TOKEN", "");
  });

  it("meters every wrong token and refuses the guess past RL_ADMIN's limit", async () => {
    // Issue #116. This used to fire 400 sequential requests at the *real*
    // `RL_ADMIN` binding and assert that at least one came back 429, because
    // that is how the audit measured the bug. It was flaky on unmodified
    // `main` — two sessions hit it independently — and reproducing it took no
    // luck at all: with 24 busy loops on a 4-core container the test times out
    // at its own 30s budget, which is one of the two shapes that were seen.
    // The other is a missing 429, which the same contention explains: 400
    // awaited round trips can outlast the binding's own 60s window, and a
    // window that rolls mid-run is never exceeded.
    //
    // Neither failure says anything about the code under test. Cloudflare
    // documents these bindings as "permissive, eventually consistent, and
    // intentionally designed to not be used as an accurate accounting system"
    // — measured here at ~2.6x overshoot — so the old test was asserting on
    // someone else's approximation, timed against a shared CPU.
    //
    // So the binding is swapped for one this repo controls, exactly as
    // `readRateLimit.test.ts` already does and for the same measured reason.
    // The claim gets stronger rather than weaker: it is no longer "at least
    // one of 400 guesses was refused" but "every guess reached the limiter,
    // under one key, and the refusal landed on the call after the limit".
    //
    // The audit's finding is what these assertions restate. With the original
    // `adminRoutes.use("*", adminAuth(), burst("RL_ADMIN"))` ordering,
    // `adminAuth` answers a bad token with `fail(...)` and never calls
    // `next()`, so the limiter is unreachable for exactly the requests that
    // need metering: `limiter.keys` would be empty and every status a 401.
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const LIMIT = 5;
    const OVERSHOOT = 3;
    const limiter = installCountingRateLimiter("RL_ADMIN", { limit: LIMIT });
    try {
      const ip = freshClientIp();
      const statuses: number[] = [];

      for (let attempt = 0; attempt < LIMIT + OVERSHOOT; attempt++) {
        const res = await SELF.fetch("http://x/api/admin/stats", {
          headers: { Authorization: `Bearer wrong-token-${attempt}`, "CF-Connecting-IP": ip },
        });
        await res.text();
        statuses.push(res.status);
      }

      const distribution = `statuses: ${JSON.stringify(statuses)}, limiter calls: ${limiter.keys.length}`;

      // Every wrong guess was metered — the finding itself.
      expect(limiter.keys, `expected one limiter call per request; ${distribution}`).toHaveLength(LIMIT + OVERSHOOT);
      // One address, one bucket: guessing from a single IP cannot be spread
      // across keys. (`dailyIpDigest` rotates the key daily, not per request —
      // `ipDigest.test.ts` owns that claim.)
      expect(new Set(limiter.keys).size, `expected a single bucket; ${distribution}`).toBe(1);

      // Wrong tokens inside the allowance are refused by auth…
      expect(statuses.slice(0, LIMIT), distribution).toEqual(Array<number>(LIMIT).fill(401));
      // …and past it the limiter answers first, which is the ordering fix.
      expect(statuses.slice(LIMIT), distribution).toEqual(Array<number>(OVERSHOOT).fill(429));
      // And nothing leaked through: a guess is either metered or rejected,
      // never served.
      expect(statuses.every((status) => status === 401 || status === 429), distribution).toBe(true);
    } finally {
      limiter.restore();
    }
  });

  it("runs the limiter before auth: a denied burst is a 429, not a 401", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const restore = installDenyingRateLimiter("RL_ADMIN");
    try {
      const res = await SELF.fetch("http://x/api/admin/stats", {
        headers: { Authorization: "Bearer wrong-token", "CF-Connecting-IP": freshClientIp() },
      });
      expect(res.status).toBe(429);
      expect((await readErr(res)).code).toBe("rate_limited");
    } finally {
      restore();
    }
  });

  // The limiter must not become a way to lock the real admin out of an
  // endpoint they hold the credential for: a correct token gets the same
  // 429 as a wrong one, which is the intended cost, but only once the
  // binding denies — the previous test's denial must not persist.
  it("still serves a correct token once the burst binding allows again", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const res = await SELF.fetch("http://x/api/admin/stats", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "CF-Connecting-IP": freshClientIp() },
    });
    expect(res.status).toBe(200);
  });
});
