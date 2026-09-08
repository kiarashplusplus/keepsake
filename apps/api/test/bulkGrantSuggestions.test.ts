/**
 * Unit coverage for `src/bulk/grants.ts`'s suggestion half — the pieces
 * `test/bulkSuggest.test.ts` exercises through the route, isolated here so a
 * regression in the plumbing itself (not the HTTP layer around it) points
 * straight at `grants.ts`.
 *
 * `GRANT_COLUMNS` (the `SELECT` list `loadUsableGrant` runs) is a specific,
 * easy-to-reintroduce regression: it has to be kept in sync with
 * `BulkGrantRow` by hand, and the migration + `mintGrant` can write a column
 * correctly while a `SELECT` list still forgets to read it back — which is
 * exactly what `7e71af0` (adding `suggestions_remaining`) did. Nothing
 * downstream throws when that happens; `grant.suggestions_remaining` is just
 * silently `undefined` on every grant `requireGrant()` loads. The first test
 * below pins that column present in the loaded row, not only in the DB.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildSuggestionDebitStatements, loadUsableGrant, mintGrant, type BulkGrantRow } from "../src/bulk/grants.js";
import { ulid } from "../src/lib/ids.js";

async function seedOwner(): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .bind(id, `hash-${id}`, now, now)
    .run();
  return id;
}

describe("bulk/grants.ts: suggestions_remaining plumbing", () => {
  it("loadUsableGrant reads suggestions_remaining back, not just mintGrant's own in-memory return", async () => {
    const ownerId = await seedOwner();
    const minted = await mintGrant(env, { ownerId, items: 10, photos: 10, suggestions: 7 });
    expect(minted.suggestions_remaining).toBe(7); // mintGrant's own return value — never touched GRANT_COLUMNS

    const loaded = await loadUsableGrant(env, { grantId: minted.id, ownerId, now: Date.now() });
    // The regression this pins: GRANT_COLUMNS omitting the column makes this
    // `undefined` even though the row in D1 genuinely holds 7.
    expect(loaded?.suggestions_remaining).toBe(7);
  });

  it("buildSuggestionDebitStatements: a guarded decrement that refuses at zero and never goes negative", async () => {
    const ownerId = await seedOwner();
    const grant = await mintGrant(env, { ownerId, items: 10, photos: 10, suggestions: 1 });

    const first = buildSuggestionDebitStatements(env, { grant });
    const firstResults = await env.DB.batch(first.statements);
    expect((firstResults[first.grantResultIndex]?.meta.changes ?? 0) > 0).toBe(true);

    const reloaded = await loadUsableGrant(env, { grantId: grant.id, ownerId, now: Date.now() });
    expect(reloaded?.suggestions_remaining).toBe(0);

    // Reload so the second attempt uses the grant's *current* row, the same
    // as a second HTTP request would via `requireGrant()` — not the stale
    // `suggestions: 1` object above, which the guard doesn't even need
    // (it's a SQL-side `WHERE`, not a JS check) but a real caller would pass.
    const second = buildSuggestionDebitStatements(env, { grant: reloaded as BulkGrantRow });
    const secondResults = await env.DB.batch(second.statements);
    expect((secondResults[second.grantResultIndex]?.meta.changes ?? 0) > 0).toBe(false);

    const stillZero = await loadUsableGrant(env, { grantId: grant.id, ownerId, now: Date.now() });
    expect(stillZero?.suggestions_remaining).toBe(0); // never negative
  });

  it("buildSuggestionDebitStatements refuses a revoked grant even with suggestions left", async () => {
    const ownerId = await seedOwner();
    const grant = await mintGrant(env, { ownerId, items: 10, photos: 10, suggestions: 5 });
    await env.DB.prepare("UPDATE bulk_grants SET revoked_at = ? WHERE id = ?").bind(Date.now(), grant.id).run();

    const debit = buildSuggestionDebitStatements(env, { grant });
    const results = await env.DB.batch(debit.statements);
    expect((results[debit.grantResultIndex]?.meta.changes ?? 0) > 0).toBe(false);
  });
});
