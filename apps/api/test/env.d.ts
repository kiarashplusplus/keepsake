import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// `env` (imported from "cloudflare:test") is typed as `Cloudflare.Env`
// directly in @cloudflare/vitest-pool-workers@0.22 (the `ProvidedEnv`
// indirection Bayan's `worker/test/env.d.ts` used is from an older version).
// `TEST_MIGRATIONS` only exists in the test runtime (injected as a JSON
// binding by vitest.config.ts), never in the real deployed Env, so it's
// merged into the ambient `Cloudflare.Env` interface here rather than in
// src/env.ts.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
