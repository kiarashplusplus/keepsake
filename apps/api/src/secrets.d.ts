// Worker secrets (`wrangler secret put`, or `.dev.vars` locally) never appear
// in `wrangler.toml`, so `wrangler types` has no way to know about them —
// unlike every other binding/var, which comes straight from the generated
// `worker-configuration.d.ts`. Declared here, once, the same way
// `test/env.d.ts` adds the test-only `TEST_MIGRATIONS` binding. All
// optional: a secret being unset is a real, handled state (see
// `src/middleware/turnstile.ts`), not a type error.
//
// A `.d.ts` file rather than inline in `env.ts` on purpose: ESLint's
// `@typescript-eslint/no-namespace` (correctly) flags a runtime `namespace`
// block in ordinary `.ts` source, but exempts ambient declaration files,
// which is exactly what a `declare global { namespace ... }` augmentation is.
declare global {
  namespace Cloudflare {
    interface Env {
      TURNSTILE_SECRET?: string;
      ADMIN_TOKEN?: string;
      RESEND_API_KEY?: string;
    }
  }
}

export {};
