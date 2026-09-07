import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { timingSafeEqualStrings } from "../src/middleware/adminAuth.js";
import { freshClientIp, installDenyingRateLimiter, readErr, setTestEnvVar } from "./helpers.js";

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

  it("rate-limits more wrong tokens than RL_ADMIN's limit from a single IP", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    // RL_ADMIN is `limit = 120, period = 60` in wrangler.toml; 150 matches
    // the audit's own probe count and leaves headroom over the limit.
    const ip = freshClientIp();
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 150; attempt++) {
      const res = await SELF.fetch("http://x/api/admin/stats", {
        headers: { Authorization: `Bearer wrong-token-${attempt}`, "CF-Connecting-IP": ip },
      });
      // Drain the body: an unread response body keeps a stream open per
      // iteration, and 150 of them is enough to matter.
      await res.text();
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
    // And nothing leaked through: a guess is either metered or rejected,
    // never served.
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(true);
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
