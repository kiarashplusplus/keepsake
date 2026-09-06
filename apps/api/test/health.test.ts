import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("reports ok with the D1 check passing and the pinned test commit", async () => {
    const res = await SELF.fetch("http://x/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      commit: string;
      env: string;
      checks: Record<string, string>;
    };
    expect(body.ok).toBe(true);
    expect(body.checks.d1).toBe("ok");
    expect(body.commit).toBe("test-sha");
  });
});

describe("GET /api/*", () => {
  it("returns a JSON 404 envelope for unmatched API routes", async () => {
    const res = await SELF.fetch("http://x/api/nope");
    expect(res.status).toBe(404);

    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("not_found");
  });
});

describe("GET /version.json", () => {
  it("is never cached", async () => {
    const res = await SELF.fetch("http://x/version.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as { commit: string };
    expect(body.commit).toBe("test-sha");
  });
});

describe("GET * (assets fallback)", () => {
  it("serves the ASSETS binding and forces no-store on the HTML document", async () => {
    // vitest.config.ts stubs ASSETS (wrangler.toml's directory, ../web/dist,
    // doesn't exist yet) with an in-memory text/html response. This also
    // proves that stub is actually wired up, not silently shadowed by a
    // real-but-empty assets handler.
    const res = await SELF.fetch("http://x/some/spa/route");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const text = await res.text();
    expect(text).toContain("stub");
  });
});
