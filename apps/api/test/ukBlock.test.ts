import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { UK_BLOCKED_COUNTRIES } from "../src/middleware/ukBlock";

/**
 * `src/middleware/ukBlock.ts` / docs/runbooks/uk-block.md.
 *
 * Under `@cloudflare/vitest-pool-workers`, `SELF.fetch(url, init)` forwards
 * `init.cf` through to the Worker's `request.cf` (miniflare merges it over
 * `fallbackCf`, which itself defaults every unset field to `country: "US"`)
 * — the same mechanism a real Cloudflare edge populates `request.cf` with
 * from the connection's IP geolocation, and just as unreachable from a
 * request header.
 */
function fetchAs(path: string, country: string | undefined, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const init: RequestInit & { cf?: Record<string, unknown> } = { headers: extraHeaders };
  if (country !== undefined) {
    init.cf = { country };
  }
  return SELF.fetch(`http://x${path}`, init);
}

describe("UK geo-block", () => {
  it("a GB request gets the explanation page, not a bare 403", async () => {
    const res = await fetchAs("/api/feed", "GB");
    expect(res.status).toBe(451);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("isn't available in the UK yet");
    expect(body).toContain("Online Safety Act");
  });

  it("a US request is unaffected", async () => {
    const res = await fetchAs("/api/feed", "US");
    expect(res.status).not.toBe(451);
  });

  it("no cf.country at all (e.g. a same-isolate test request) is not blocked", async () => {
    const res = await fetchAs("/api/feed", undefined);
    expect(res.status).not.toBe(451);
  });

  it.each(["JE", "GG", "IM"])("blocks the Crown Dependency %s too", async (country) => {
    const res = await fetchAs("/api/feed", country);
    expect(res.status).toBe(451);
  });

  it("blocks a write endpoint (POST), not just reads", async () => {
    const res = await fetchAs("/api/listings", "GB", { "Content-Type": "application/json" });
    expect(res.status).toBe(451);
  });

  it("cannot be bypassed by a client-controlled header claiming a different country", async () => {
    // `CF-IPCountry` is a real Cloudflare-set header on some product tiers,
    // but the block reads `request.cf.country` exclusively — a client
    // sending its own copy of that (or anything else) must not matter.
    const res = await fetchAs("/api/feed", "GB", { "CF-IPCountry": "US", "X-Forwarded-For-Country": "US" });
    expect(res.status).toBe(451);
  });

  it("does not block /health, so an uptime monitor never trips on its own location", async () => {
    const res = await fetchAs("/health", "GB");
    expect(res.status).not.toBe(451);
  });
});

describe("OSA re-entry gate (issue #30)", () => {
  // Pins the actual behaviour, not just the constant: a test that only
  // asserts UK_BLOCKED_COUNTRIES' contents can go green while the
  // enforcement logic quietly stops using it. This one drives a real
  // request through the middleware for every required code and fails with
  // an actionable message if any of them stops being refused — whether
  // because the code was removed from the list or because the list stopped
  // being enforced.
  const REQUIRED = ["GB", "JE", "GG", "IM"] as const;

  it("lists everything it must block", () => {
    const missing = REQUIRED.filter(
      (code) => !(UK_BLOCKED_COUNTRIES as readonly string[]).includes(code),
    );

    if (missing.length > 0) {
      throw new Error(
        `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing from ` +
          `UK_BLOCKED_COUNTRIES in apps/api/src/middleware/ukBlock.ts. Removing a code from ` +
          `this list re-opens Keepsake to that jurisdiction's visitors, which the UK Online ` +
          `Safety Act treats as offering a regulated service there — the illegal-content risk ` +
          `assessment, children's access assessment (already overdue), complaints procedure, ` +
          `record-keeping, and Article 27 representative question all need to actually be ` +
          `resolved first. Work through docs/runbooks/uk-reentry-checklist.md, then update this ` +
          `test (and the matching gate in packages/contracts/test/geo.test.ts) together with the ` +
          `code change. See issue #30 and issue #34 (Q1, Q6) on kiarashplusplus/keepsake.`,
      );
    }
  });

  it("actually refuses a request from every required jurisdiction, not just lists it", async () => {
    for (const country of REQUIRED) {
      const res = await fetchAs("/api/feed", country);
      if (res.status !== 451) {
        throw new Error(
          `A request with cf.country="${country}" got HTTP ${res.status}, not 451 — the UK ` +
            `geo-block no longer actually refuses this jurisdiction, even though ` +
            `docs/runbooks/uk-block.md and issue #30 require it to until the Online Safety Act ` +
            `obligations (risk assessment, children's access assessment, complaints procedure, ` +
            `record-keeping, Article 27 representative) are actually done. Work through ` +
            `docs/runbooks/uk-reentry-checklist.md before weakening this behaviour, then update ` +
            `this test together with the code change.`,
        );
      }
    }
  });
});
