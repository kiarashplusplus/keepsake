import { applyD1Migrations, env } from "cloudflare:test";

// `TEST_MIGRATIONS` was read from apps/api/migrations/*.sql out in
// vitest.config.ts (Node context, where `node:fs` exists) and handed in as a
// JSON binding — this file runs inside the Workers runtime, which can't read
// the filesystem itself. Every test file shares this one applied schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
