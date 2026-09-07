import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setTestEnvVar } from "./helpers.js";

interface HealthBody {
  ok: boolean;
  commit: string;
  env: string;
  checks: Record<string, string>;
}

describe("GET /health", () => {
  it("reports ok with the D1/R2/KV/ASSETS checks passing and the pinned test commit", async () => {
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
    // Issue #191: same again for ASSETS, which was graded from binding
    // presence alone — the one binding `deploy.yml`'s post-deploy check
    // verifies *across* rather than *through*.
    expect(body.checks.assets).toBe("ok");
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

/**
 * Issue #191. `ASSETS` and `VECTORIZE` were the two bindings `/health` could
 * not tell the truth about: the first was graded from presence, and the
 * second appeared in no field at all.
 */
describe("GET /health: the ASSETS read (#191)", () => {
  it("reports 503 with checks.assets === 'error' when the assets binding has no shell to serve", async () => {
    // Whole-binding replacement, the same idiom the R2/KV cases above use.
    // A 404 from the assets system is what a deploy over a broken or partial
    // `dist/` looks like from inside the Worker: the binding is present, the
    // Worker is up, `/health` answers, and the site serves nothing usable.
    // That is precisely the state `deploy.yml` used to verify green.
    const originalAssets = env.ASSETS;
    (env as unknown as Record<string, unknown>).ASSETS = {
      fetch: async () => new Response("not found", { status: 404 }),
    };
    try {
      const res = await SELF.fetch("http://x/health");
      expect(res.status).toBe(503);

      const body = (await res.json()) as HealthBody;
      expect(body.ok).toBe(false);
      expect(body.checks.assets).toBe("error");
      // Presence still says "ok" — which is the whole point of the finding:
      // the presence check and the real read disagree, and only the real
      // read is about whether the site works.
      expect(body.checks.ASSETS).toBe("ok");
      // The other reads are unaffected.
      expect(body.checks.d1).toBe("ok");
      expect(body.checks.r2).toBe("ok");
      expect(body.checks.kv).toBe("ok");
    } finally {
      (env as unknown as Record<string, unknown>).ASSETS = originalAssets;
    }
  });

  it("reports checks.assets === 'error' when the assets fetch throws", async () => {
    const originalAssets = env.ASSETS;
    (env as unknown as Record<string, unknown>).ASSETS = {
      fetch: async () => {
        throw new Error("simulated assets outage");
      },
    };
    try {
      const res = await SELF.fetch("http://x/health");
      expect(res.status).toBe(503);

      const body = (await res.json()) as HealthBody;
      expect(body.checks.assets).toBe("error");
    } finally {
      (env as unknown as Record<string, unknown>).ASSETS = originalAssets;
    }
  });
});

describe("GET /health: the VECTORIZE field (#191)", () => {
  afterEach(() => {
    // vitest.config.ts pins this "0" for the whole suite; the cases below
    // flip it deliberately and must put it back.
    setTestEnvVar("SEMANTIC_SEARCH", "0");
  });

  it("says 'off', not 'ok' and not 'error', when the kill switch is off and there is no binding", async () => {
    const originalVectorize = env.VECTORIZE;
    delete (env as unknown as Record<string, unknown>).VECTORIZE;
    setTestEnvVar("SEMANTIC_SEARCH", "0");
    try {
      const res = await SELF.fetch("http://x/health");
      expect(res.status).toBe(200);

      const body = (await res.json()) as HealthBody;
      // A supported configuration is not a fault. Three states rather than
      // two is the requirement: "I did not look" must not read the same as
      // "I looked and saw nothing".
      expect(body.checks.vectorize).toBe("off");
      expect(body.ok).toBe(true);
    } finally {
      (env as unknown as Record<string, unknown>).VECTORIZE = originalVectorize;
    }
  });

  it("reports 503 with checks.vectorize === 'error' when SEMANTIC_SEARCH is on and the binding is gone", async () => {
    // The rollback-across-a-binding-change case. `search/vectorize.ts`
    // returns silently on `!env.VECTORIZE`, so search reverts to FTS while
    // the var and the privacy page both still say semantic search is
    // running. Before this field, nothing anywhere reported that.
    const originalVectorize = env.VECTORIZE;
    delete (env as unknown as Record<string, unknown>).VECTORIZE;
    setTestEnvVar("SEMANTIC_SEARCH", "1");
    try {
      const res = await SELF.fetch("http://x/health");
      expect(res.status).toBe(503);

      const body = (await res.json()) as HealthBody;
      expect(body.checks.vectorize).toBe("error");
      expect(body.ok).toBe(false);
    } finally {
      (env as unknown as Record<string, unknown>).VECTORIZE = originalVectorize;
    }
  });

  it("says 'ok' when the binding is present, whatever the kill switch says", async () => {
    setTestEnvVar("SEMANTIC_SEARCH", "1");
    const res = await SELF.fetch("http://x/health");
    const body = (await res.json()) as HealthBody;
    expect(body.checks.vectorize).toBe("ok");
    expect(body.ok).toBe(true);
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
