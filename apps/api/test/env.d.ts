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

// `import.meta.glob` is a Vite build-time transform, not a runtime API, so no
// package ships its type into this project: `apps/api/tsconfig.json` pins
// `types` to the worker configuration and the vitest-pool-workers types, and
// pulling in `vite/client` wholesale would drag DOM/asset ambient
// declarations into a Worker project to get one method. `emailSubjects.test.ts`
// (issue #86) uses it to enumerate `src/email/templates/*.ts` from inside the
// Workers runtime, which has no `node:fs` to list the directory itself.
declare global {
  interface ImportMeta {
    glob<T = unknown>(
      pattern: string,
      options: { eager: true; query?: string; import?: string },
    ): Record<string, T>;
  }
}
