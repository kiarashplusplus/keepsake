import { applyD1Migrations, env } from "cloudflare:test";
import { installFakeVectorize } from "./helpers.js";

// `TEST_MIGRATIONS` was read from apps/api/migrations/*.sql out in
// vitest.config.ts (Node context, where `node:fs` exists) and handed in as a
// JSON binding — this file runs inside the Workers runtime, which can't read
// the filesystem itself. Every test file shares this one applied schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// `env.VECTORIZE` (issue #38) has no local emulator, same as `env.AI` — see
// `installFakeVectorize`'s own doc comment in test/helpers.ts for why every
// test file gets a fake by default rather than only the ones that mention
// search.
installFakeVectorize();
