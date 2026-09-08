/**
 * Issue #90 — `DELETE /api/listings/:id` deletes exactly one row
 * (`DELETE FROM listings WHERE id = ?`) and relies on `ON DELETE CASCADE` to
 * take `photos`, `requests`, `reports`, `moderation_events` and
 * `listing_aspects` with it. The schema does declare the cascades. Nothing
 * checked that they *fire*.
 *
 * SQLite does not enforce foreign keys unless `PRAGMA foreign_keys` is on,
 * and `grep -rn foreign_keys apps/api` returned nothing before this file:
 * no pragma in code, in the migrations, or in `wrangler.toml`. D1 documents
 * the pragma as on by default, which is almost certainly why this has always
 * worked — but that is external knowledge the repo depends on and never
 * verified, and if it were ever wrong the failure is silent and expensive:
 * a deleted listing would leave its requests behind, meaning a stranger's
 * note, email address and phone number orphaned with no listing to reach
 * them through and no sweeper that looks for them. That is the exact path
 * the privacy page promises deletion for.
 *
 * So: a positive control. Seed every child table, delete through the real
 * route, and assert by querying that nothing is left. Each child count is
 * asserted non-zero *before* the delete, because "0 rows after" proves
 * nothing if there were 0 rows before — that is how a check that cannot
 * fail gets written.
 *
 * The schema under test is the production schema: `vitest.config.ts` reads
 * `apps/api/migrations/*.sql` with `readD1Migrations()` and `test/setup.ts`
 * applies them with `applyD1Migrations()`, so these tables come from the
 * same files `wrangler d1 migrations apply` runs against preview and
 * production. Nothing here hand-writes a `CREATE TABLE`.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OwnerListing } from "@keepsake/contracts/listing";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import { ulid } from "../src/lib/ids.js";
import {
  authHeaders,
  freshClientIp,
  freshOwnerToken,
  readOk,
  seedStandardPostalCodes,
  uploadPhoto,
  waitForListingStatus,
} from "./helpers.js";

/** Every table with a declared `REFERENCES listings(id) ON DELETE CASCADE`,
 * as of the bulk-upload migration — discovered from the schema in the test
 * below rather than trusted from this list, which only exists to make the
 * positive control's seeding explicit.
 *
 * `upload_batch_items` joined in the estate bulk-upload migration and is the
 * reason this list is worth keeping honest: its `listing_id` is what stops a
 * submitted draft being submitted twice, so if it did *not* cascade, deleting
 * a listing would return its draft to "never submitted" and the submission
 * runner would publish it again. The enumeration below is what caught the
 * first draft of that migration, which declared the reference with no
 * `ON DELETE` clause at all. */
const LISTING_CHILD_TABLES = [
  "photos",
  "requests",
  "reports",
  "moderation_events",
  "listing_aspects",
  "upload_batch_items",
] as const;

async function countFor(table: string, listingId: string): Promise<number> {
  // `table` is a literal from this file, never request data — there is no
  // parameter form for an identifier in SQLite.
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE listing_id = ?`)
    .bind(listingId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function countsFor(listingId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of LISTING_CHILD_TABLES) {
    counts[table] = await countFor(table, listingId);
  }
  return counts;
}

describe("issue #90: the delete path's ON DELETE CASCADE is enforced, not assumed", () => {
  it("has foreign key enforcement switched on in the D1 the migrations ran against", async () => {
    // Documents the dependency the delete route silently rests on. If a
    // future D1/miniflare release stopped defaulting this to on, every
    // cascade below would quietly stop firing, and this line names why.
    const row = await env.DB.prepare("PRAGMA foreign_keys").first<{ foreign_keys: number }>();
    expect(row?.foreign_keys).toBe(1);
  });

  it("declares ON DELETE CASCADE on every foreign key that points at listings", async () => {
    // Enumerated from the live schema, not from a list, so a child table
    // added in a later migration without a cascade fails here — the
    // positive control below can only see the tables it knows to seed.
    const { results: tables } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>();

    const referencing: { table: string; onDelete: string }[] = [];
    for (const { name } of tables) {
      const { results: fks } = await env.DB.prepare(`PRAGMA foreign_key_list(${name})`).all<{
        table: string;
        on_delete: string;
      }>();
      for (const fk of fks) {
        if (fk.table === "listings") referencing.push({ table: name, onDelete: fk.on_delete });
      }
    }

    // Guards against the enumeration silently finding nothing — a `PRAGMA`
    // that returned no rows would let the loop above pass vacuously.
    expect(referencing.map((r) => r.table).sort()).toEqual([...LISTING_CHILD_TABLES].sort());
    for (const ref of referencing) {
      expect(ref.onDelete, `${ref.table}.listing_id -> listings(id)`).toBe("CASCADE");
    }
  });

  it("DELETE /api/listings/:id removes every child row, including the requester's note, email and phone", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));

    // A word that appears in no other fixture in this suite, so the FTS
    // assertion at the end cannot match another test's listing.
    const nonce = "cascadenoncezq";

    const created = await readOk<OwnerListing>(
      await SELF.fetch("http://x/api/listings", {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `A quiet teacup ${nonce}`,
          story: `This ${nonce} was my grandmother's favorite teacup, and I'd love for it to find a new home.`,
          category: "home_kitchen",
          country: "US",
          postal_code: "02144",
          date_of_birth: "1990-01-01",
          email: "giver@keepsake.ing",
          photo_ids: [photo.id],
          // Populates `listing_aspects` through the real create path.
          aspects: [
            { name: "object", value: "teacup" },
            { name: "material", value: "porcelain" },
          ],
        }),
      }),
    );
    const listingId = created.id;

    // The moderation pipeline runs in `waitUntil()` and is what writes the
    // `moderation_events` rows; wait for it to land so those rows exist
    // before the delete rather than racing it.
    await waitForListingStatus(listingId, (status) => status === "approved");

    // A real request, through the real route: this is the row that carries
    // the PII issue #90 is actually about.
    const requestRes = await SELF.fetch(`http://x/api/listings/${listingId}/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
      body: JSON.stringify({
        note: "This looks like the one my mother had. I'd give it a good home.",
        email: "requester-cascade@keepsake.ing",
        phone: "+1 617 555 0142",
        date_of_birth: "1990-01-01",
      }),
    });
    expect(requestRes.status).toBe(201);

    const reportRes = await SELF.fetch(`http://x/api/listings/${listingId}/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
      body: JSON.stringify({ reason: "spam", details: "Seeding a report row for the cascade test." }),
    });
    expect(reportRes.status).toBe(201);

    // The bulk-upload draft this listing would have come from. Seeded with
    // SQL rather than driven through `/api/bulk` on purpose: what is under
    // test here is the cascade, and `test/bulkSubmit.test.ts` already drives
    // the real submission path end to end. Going through it here would make
    // this test fail for reasons that have nothing to do with deletion.
    const batchId = ulid();
    const itemId = ulid();
    const seedNow = Date.now();
    await env.DB.prepare(
      `INSERT INTO upload_batches
         (id, owner_id, client_batch_key, name, country, postal_code, place_name, admin1, lat, lng,
          state, last_activity_at, expires_at, created_at, updated_at)
       SELECT ?, owner_id, ?, ?, 'US', '02144', 'Somerville', 'MA', 42.3958, -71.0967,
              'closed', ?, ?, ?, ? FROM listings WHERE id = ?`,
    )
      .bind(batchId, `cascade-${batchId}`, "Cascade test batch", seedNow, seedNow + 60_000, seedNow, seedNow, listingId)
      .run();
    await env.DB.prepare(
      `INSERT INTO upload_batch_items (id, batch_id, client_item_id, state, listing_id, created_at, updated_at)
       VALUES (?, ?, ?, 'submitted', ?, ?, ?)`,
    )
      .bind(itemId, batchId, "item-1", listingId, seedNow, seedNow)
      .run();

    // The positive half of the control: every child table has rows to lose.
    const before = await countsFor(listingId);
    for (const table of LISTING_CHILD_TABLES) {
      expect(before[table], `${table} was empty before the delete — this test would pass vacuously`).toBeGreaterThan(0);
    }
    const requestBefore = await env.DB.prepare("SELECT email, phone, note FROM requests WHERE listing_id = ?")
      .bind(listingId)
      .first<{ email: string | null; phone: string | null; note: string | null }>();
    expect(requestBefore?.email).toBe("requester-cascade@keepsake.ing");
    expect(requestBefore?.phone).toBe("+1 617 555 0142");

    const deleteRes = await SELF.fetch(`http://x/api/listings/${listingId}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(deleteRes.status).toBe(200);

    const listingRow = await env.DB.prepare("SELECT id FROM listings WHERE id = ?").bind(listingId).first();
    expect(listingRow).toBeNull();

    const after = await countsFor(listingId);
    expect(after).toEqual(Object.fromEntries(LISTING_CHILD_TABLES.map((table) => [table, 0])));

    // Named individually as well as in the object compare, so a failure
    // report says which promise was broken rather than printing a diff.
    expect(after.requests, "a deleted listing left the requester's note, email and phone behind").toBe(0);
    expect(after.reports, "a deleted listing left its reports behind").toBe(0);
    expect(after.moderation_events, "a deleted listing left its moderation history behind").toBe(0);
    expect(after.photos, "a deleted listing left its photo rows behind").toBe(0);
    expect(after.listing_aspects, "a deleted listing left its aspects behind").toBe(0);
    expect(
      after.upload_batch_items,
      "a deleted listing left its bulk-upload draft behind, so the submission runner could publish it again",
    ).toBe(0);

    // `listings_fts` is kept in sync by a trigger (0003_fts.sql), not a
    // foreign key — a different mechanism on the same delete path, and one
    // that would otherwise keep the listing's title and story searchable
    // after the row it describes is gone.
    const { results: ftsHits } = await env.DB.prepare("SELECT rowid FROM listings_fts WHERE listings_fts MATCH ?")
      .bind(`${nonce}*`)
      .all<{ rowid: number }>();
    expect(ftsHits.length, "the deleted listing is still in the full-text index").toBe(0);
  });
});
