import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
