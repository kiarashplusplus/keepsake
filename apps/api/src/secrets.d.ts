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
      // Issue #94: Cloudflare API token scoped to `Zone.Cache Purge` on the
      // keepsake.ing zone, read by `src/lib/photoCache.ts` to purge a
      // deleted photo from every colo rather than only the one that
      // executed the delete. Its partner `CF_ZONE_ID` is an ordinary
      // `[vars]` entry, not a secret — a zone id is a public identifier and
      // is written down in `docs/runbooks/kiarash-checklist.md`; the token
      // is the credential.
      CF_CACHE_PURGE_TOKEN?: string;
      // Read-only Cloudflare API token for the Observatory
      // (`GET /api/admin/observatory`): `Account Analytics Read` +
      // `Workers Observability Read`, scoped to the Leapkg account. The
      // second half is unused since #159 step 1 — the error-lines panel now
      // reads D1, not the observability API — and is left on the existing
      // token rather than re-minted, since narrowing a read-only token is not
      // worth a rotation; a token minted fresh only needs the first. Its
      // partners `CF_ACCOUNT_ID`/`CF_SCRIPT_NAME` are ordinary `[vars]` —
      // neither is a credential — and with any of the three unset the edge
      // panel reports itself `unconfigured` rather than rendering zero. Deliberately not `CF_CACHE_PURGE_TOKEN` and
      // deliberately not the deploy token: this one can read request counts
      // and log lines and can change nothing.
      CF_OBSERVATORY_TOKEN?: string;
      // Where the daily digest is mailed (`cron/dailyDigest.ts`). A secret
      // rather than a var because it is a real person's address, and
      // `wrangler.toml` is committed. Unset means the digest is built and
      // logged but not sent — a supported state, not an error.
      ADMIN_DIGEST_TO?: string;
      // Keys the per-recipient unsubscribe token (`src/email/unsubscribe.ts`).
      // Unset means every unsubscribe link falls back to the `mailto:`
      // address the CASL footer already names — a working, less convenient
      // mechanism, not a type error and not a broken link.
      UNSUBSCRIBE_SECRET?: string;
    }
  }
}

export {};
