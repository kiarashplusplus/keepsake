import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Issue #24. `wrangler.toml` checks in `COMMIT_SHA = "dev"` as the fallback
 * every environment (including `production`) uses if nothing overrides it —
 * correct for local `wrangler dev`, where there's no real commit to stamp,
 * but silently misleading in `production`: a hand-run
 * `wrangler deploy --env production` that forgets
 * `--var COMMIT_SHA:$(git rev-parse HEAD)` would ship `"dev"` and `/health`
 * would report it as fact. `src/index.ts`'s first middleware turns that into
 * an immediate, loud refusal — every route, not just `/health` — instead of
 * quietly serving traffic under a false commit.
 *
 * Same override idiom `health.test.ts` uses for BUCKET/KV: swap the value on
 * the shared `env` object for the duration of one test, then restore it so
 * later tests in the file (and other files sharing this worker) see the real
 * `ENVIRONMENT: "test"` / `COMMIT_SHA: "test-sha"` vitest.config.ts pins.
 */
describe("production COMMIT_SHA guard", () => {
  it('refuses every request when ENVIRONMENT is "production" and COMMIT_SHA is still "dev"', async () => {
    const originalEnvironment = env.ENVIRONMENT;
    const originalCommitSha = env.COMMIT_SHA;
    (env as unknown as Record<string, unknown>).ENVIRONMENT = "production";
    (env as unknown as Record<string, unknown>).COMMIT_SHA = "dev";
    try {
      // Not just /health: the guard is the very first middleware, so a
      // completely unrelated route is refused too — proving this is a
      // whole-site refusal, not a health-endpoint-only check.
      for (const path of ["/health", "/version.json", "/api/nope"]) {
        const res = await SELF.fetch(`http://x${path}`);
        expect(res.status).toBe(503);
        const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
        expect(body.ok).toBe(false);
        expect(body.error.code).toBe("unavailable");
        expect(body.error.message).toContain('COMMIT_SHA is still "dev"');
        expect(body.error.message).toContain("--var COMMIT_SHA:$(git rev-parse HEAD)");
      }
    } finally {
      (env as unknown as Record<string, unknown>).ENVIRONMENT = originalEnvironment;
      (env as unknown as Record<string, unknown>).COMMIT_SHA = originalCommitSha;
    }
  });

  it("serves normally when production has a real COMMIT_SHA (the automated deploy path)", async () => {
    const originalEnvironment = env.ENVIRONMENT;
    const originalCommitSha = env.COMMIT_SHA;
    (env as unknown as Record<string, unknown>).ENVIRONMENT = "production";
    (env as unknown as Record<string, unknown>).COMMIT_SHA = "abc1234deadbeef";
    try {
      const res = await SELF.fetch("http://x/version.json");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { commit: string };
      expect(body.commit).toBe("abc1234deadbeef");
    } finally {
      (env as unknown as Record<string, unknown>).ENVIRONMENT = originalEnvironment;
      (env as unknown as Record<string, unknown>).COMMIT_SHA = originalCommitSha;
    }
  });

  it('leaves non-production environments alone even with COMMIT_SHA === "dev" (local wrangler dev, preview)', async () => {
    // vitest.config.ts already pins ENVIRONMENT: "test", COMMIT_SHA:
    // "test-sha" — this test instead proves the specific case the guard must
    // never touch: "dev" is the correct, expected value everywhere except
    // production, so setting it explicitly here (mimicking local
    // `wrangler dev`, which defaults to ENVIRONMENT="development") must not
    // trip the guard.
    const originalEnvironment = env.ENVIRONMENT;
    const originalCommitSha = env.COMMIT_SHA;
    (env as unknown as Record<string, unknown>).ENVIRONMENT = "development";
    (env as unknown as Record<string, unknown>).COMMIT_SHA = "dev";
    try {
      const res = await SELF.fetch("http://x/version.json");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { commit: string };
      expect(body.commit).toBe("dev");
    } finally {
      (env as unknown as Record<string, unknown>).ENVIRONMENT = originalEnvironment;
      (env as unknown as Record<string, unknown>).COMMIT_SHA = originalCommitSha;
    }
  });
});
