import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface HealthBody {
  ok: boolean;
  commit: string;
  env: string;
  checks: Record<string, string>;
}

describe("GET /health", () => {
  it("reports ok with the D1/R2/KV checks passing and the pinned test commit", async () => {
    const res = await SELF.fetch("http://x/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthBody;
    expect(body.ok).toBe(true);
    expect(body.checks.d1).toBe("ok");
    // Issue #15: these are real reads (a sentinel `head()`/`get()` on keys
    // that don't exist), not the presence-only `assertBindings` check that
    // still lives at `checks.BUCKET`/`checks.KV` — see src/index.ts.
    expect(body.checks.r2).toBe("ok");
    expect(body.checks.kv).toBe("ok");
    expect(body.commit).toBe("test-sha");
  });

  it("reports 503 with checks.r2 === 'error' when the R2 read throws", async () => {
    // Whole-binding replacement, same idiom `test/helpers.ts`'s
    // installFakeEmail/removeFakeEmail uses for EMAIL — R2Bucket's real
    // methods aren't writable through the generated binding type, so this
    // swaps the binding itself rather than patching one method on it.
    const originalBucket = env.BUCKET;
    (env as unknown as Record<string, unknown>).BUCKET = {
      head: async () => {
        throw new Error("simulated R2 outage");
      },
    };
    try {
      const res = await SELF.fetch("http://x/health");
      expect(res.status).toBe(503);

      const body = (await res.json()) as HealthBody;
      expect(body.ok).toBe(false);
      expect(body.checks.r2).toBe("error");
      // The D1/KV checks are unaffected by the R2 failure.
      expect(body.checks.d1).toBe("ok");
      expect(body.checks.kv).toBe("ok");
    } finally {
      (env as unknown as Record<string, unknown>).BUCKET = originalBucket;
    }
  });

  it("reports 503 with checks.kv === 'error' when the KV read throws", async () => {
    const originalKv = env.KV;
    (env as unknown as Record<string, unknown>).KV = {
      get: async () => {
        throw new Error("simulated KV outage");
      },
    };
    try {
      const res = await SELF.fetch("http://x/health");
      expect(res.status).toBe(503);

      const body = (await res.json()) as HealthBody;
      expect(body.ok).toBe(false);
      expect(body.checks.kv).toBe("error");
      // The D1/R2 checks are unaffected by the KV failure.
      expect(body.checks.d1).toBe("ok");
      expect(body.checks.r2).toBe("ok");
    } finally {
      (env as unknown as Record<string, unknown>).KV = originalKv;
    }
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
