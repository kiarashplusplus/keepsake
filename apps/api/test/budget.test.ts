import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkAndBump } from "../src/moderation/budget.js";

// Each test picks its own `kind` value so the global KV counters (keyed only
// by kind + day, not by test name) never leak between tests sharing the same
// isolated-storage instance within a file.
let kindCounter = 0;
function freshKind(): "mod_text" | "mod_image" | "listing" | "request" | "upload" {
  const kinds = ["mod_text", "mod_image", "listing", "request", "upload"] as const;
  const kind = kinds[kindCounter % kinds.length];
  kindCounter += 1;
  if (kind === undefined) throw new Error("unreachable");
  return kind;
}

describe("checkAndBump", () => {
  it("allows requests under the global ceiling and denies once it's reached", async () => {
    const kind = freshKind();

    const first = await checkAndBump(env.KV, { kind, dailyLimit: 2 });
    const second = await checkAndBump(env.KV, { kind, dailyLimit: 2 });
    const third = await checkAndBump(env.KV, { kind, dailyLimit: 2 });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeDefined();
    expect(third.retryAfter as number).toBeGreaterThanOrEqual(1);
    expect(third.retryAfter as number).toBeLessThanOrEqual(86_400);
  });

  it("allows requests under the per-IP ceiling and denies once it's reached, independent of the global ceiling", async () => {
    const kind = freshKind();
    const clientIP = "203.0.113.9";

    const first = await checkAndBump(env.KV, { kind, clientIP, dailyLimit: 1000, ipDailyLimit: 2 });
    const second = await checkAndBump(env.KV, { kind, clientIP, dailyLimit: 1000, ipDailyLimit: 2 });
    const third = await checkAndBump(env.KV, { kind, clientIP, dailyLimit: 1000, ipDailyLimit: 2 });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter as number).toBeGreaterThanOrEqual(1);
    expect(third.retryAfter as number).toBeLessThanOrEqual(86_400);

    // A different IP has its own, unaffected ceiling.
    const otherIP = await checkAndBump(env.KV, { kind, clientIP: "198.51.100.4", dailyLimit: 1000, ipDailyLimit: 2 });
    expect(otherIP.allowed).toBe(true);
  });

  it("never stores the raw client IP in a KV key", async () => {
    const kind = freshKind();
    const clientIP = "203.0.113.9";

    await checkAndBump(env.KV, { kind, clientIP, dailyLimit: 1000, ipDailyLimit: 1000 });

    const { keys } = await env.KV.list({ prefix: "budget:" });
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.name).not.toContain(clientIP);
      expect(key.name).not.toContain("203.0.113");
    }

    // The per-IP key layout is still present, just digested.
    expect(keys.some((k: { name: string }) => k.name.startsWith(`budget:ip:${kind}:`))).toBe(true);
  });

  describe("cost", () => {
    it("charges `cost` units per check instead of 1, so it denies once the sum would exceed the ceiling", async () => {
      const kind = freshKind();

      const first = await checkAndBump(env.KV, { kind, dailyLimit: 10, cost: 4 });
      const second = await checkAndBump(env.KV, { kind, dailyLimit: 10, cost: 4 });
      // 4 + 4 = 8, under 10; a third would make 12, over — denied even
      // though only two checks have run.
      const third = await checkAndBump(env.KV, { kind, dailyLimit: 10, cost: 4 });

      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(true);
      expect(third.allowed).toBe(false);
    });
  });

  describe("reservedFloor", () => {
    it("denies a caller who already exhausted the general pool and has no reserved floor available", async () => {
      const kind = freshKind();
      // dailyLimit 10, reservedFloor 2 -> general pool is 8.
      for (let i = 0; i < 8; i++) {
        const result = await checkAndBump(env.KV, {
          kind,
          dailyLimit: 10,
          reservedFloor: 2,
          freshCallerCeiling: 3,
          clientIP: `203.0.113.${i}`,
        });
        expect(result.allowed).toBe(true);
      }
      // General pool (8) is now spent. This caller has no prior usage today
      // (fresh), so it can still draw from the 2-unit reserved floor.
      const fresh = await checkAndBump(env.KV, { kind, dailyLimit: 10, reservedFloor: 2, freshCallerCeiling: 3, clientIP: "198.51.100.1" });
      expect(fresh.allowed).toBe(true);
      const freshAgain = await checkAndBump(env.KV, {
        kind,
        dailyLimit: 10,
        reservedFloor: 2,
        freshCallerCeiling: 3,
        clientIP: "198.51.100.1",
      });
      expect(freshAgain.allowed).toBe(true);
      // Floor (2 units) is now spent too — a brand-new IP is denied outright.
      const deniedFresh = await checkAndBump(env.KV, {
        kind,
        dailyLimit: 10,
        reservedFloor: 2,
        freshCallerCeiling: 3,
        clientIP: "198.51.100.2",
      });
      expect(deniedFresh.allowed).toBe(false);
    });

    it("refuses the reserved floor to a caller who has already used it enough to lose 'fresh' status", async () => {
      const kind = freshKind();
      // Drain the general pool (dailyLimit 10, reservedFloor 5 -> general pool 5).
      for (let i = 0; i < 5; i++) {
        await checkAndBump(env.KV, { kind, dailyLimit: 10, reservedFloor: 5, freshCallerCeiling: 2, clientIP: `203.0.113.${i}` });
      }
      const clientIP = "198.51.100.9";
      const first = await checkAndBump(env.KV, { kind, dailyLimit: 10, reservedFloor: 5, freshCallerCeiling: 2, clientIP });
      const second = await checkAndBump(env.KV, { kind, dailyLimit: 10, reservedFloor: 5, freshCallerCeiling: 2, clientIP });
      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(true);
      // This same IP has now used the floor `freshCallerCeiling` (2) times —
      // it no longer counts as fresh, so a third attempt is denied even
      // though the floor (5) isn't numerically exhausted yet.
      const third = await checkAndBump(env.KV, { kind, dailyLimit: 10, reservedFloor: 5, freshCallerCeiling: 2, clientIP });
      expect(third.allowed).toBe(false);
    });

    it("never reaches the reserved floor for a caller with no clientIP (the cron-retry case)", async () => {
      const kind = freshKind();
      for (let i = 0; i < 8; i++) {
        await checkAndBump(env.KV, { kind, dailyLimit: 10, reservedFloor: 2, freshCallerCeiling: 3, clientIP: `203.0.113.${i}` });
      }
      // General pool is spent; no clientIP means this call can never draw on
      // the floor, regardless of how much of it remains.
      const anonymous = await checkAndBump(env.KV, { kind, dailyLimit: 10, reservedFloor: 2, freshCallerCeiling: 3 });
      expect(anonymous.allowed).toBe(false);
    });
  });
});
