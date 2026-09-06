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
});
