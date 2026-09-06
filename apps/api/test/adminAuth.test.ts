import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { timingSafeEqualStrings } from "../src/middleware/adminAuth.js";
import { freshClientIp, readErr, setTestEnvVar } from "./helpers.js";

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
});
