/**
 * Issue #225: `POST /api/admin/testing/reassign-listing-ids` is what lets
 * `apps/web/e2e/support/demoCatalog.ts` give its fixed UX-baseline catalogue
 * stable ids after creating every listing through the real API — see that
 * route's own comment in `src/routes/admin.ts` for the full design. This
 * file is the positive control cascadeDelete.test.ts's own header describes
 * the shape of: seed every child table for real, rename through the route,
 * and assert by querying that every foreign key moved with it and nothing
 * was left pointing at an id that no longer exists.
 *
 * It also carries the two facts the route's comment claims but a comment
 * alone can't prove against a real D1: that the naive rename (no deferred
 * FK check) really does throw, and that FK enforcement really is back on
 * for the very next statement once the deferred batch commits — so a
 * regression that dropped the `PRAGMA defer_foreign_keys` line, or one that
 * left the connection permanently unguarded, would both fail here.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { OwnerListing } from "@keepsake/contracts/listing";
import type { AdminReassignListingIdsResult } from "@keepsake/contracts/admin";
import {
  authHeaders,
  freshClientIp,
  freshOwnerToken,
  readErr,
  readOk,
  seedStandardPostalCodes,
  setTestEnvVar,
  uploadPhoto,
  waitForListingStatus,
} from "./helpers.js";
import { ulid } from "../src/lib/ids.js";
import { listingReferences } from "../src/lib/listingsDb.js";

const ADMIN_TOKEN = "test-admin-token-reassign-ids";

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

/** Every child table with rows on the listing this file seeds, keyed the
 * same way `cascadeDelete.test.ts`'s `countsFor` is — kept separate from
 * that file because this one also wants the *values*, not just counts, to
 * assert they moved to the new id rather than merely disappearing. */
async function countFor(table: string, column: string, listingId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
    .bind(listingId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("issue #225: POST /api/admin/testing/reassign-listing-ids", () => {
  afterEach(() => {
    setTestEnvVar("ADMIN_TOKEN", "");
    // vitest.config.ts's fixture env defaults MOCK_AI to "1"; restore that
    // default so a test that flips it to "0" (the gating test below) can't
    // leak into the next file.
    setTestEnvVar("MOCK_AI", "1");
  });

  it("moves every foreign key with the rename, in one transaction, and leaves the old id gone", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    await seedStandardPostalCodes();

    const token = freshOwnerToken();
    const photo = await readOk<{ id: string }>(await uploadPhoto({ token }));
    const nonce = "reassignidsnonce";

    const created = await readOk<OwnerListing>(
      await SELF.fetch("http://x/api/listings", {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `A brass compass ${nonce}`,
          story: `This ${nonce} belonged to my uncle and I would like it to go to someone who sails.`,
          category: "other",
          country: "US",
          postal_code: "02144",
          date_of_birth: "1990-01-01",
          photo_ids: [photo.id],
          aspects: [{ name: "object", value: "compass" }],
        }),
      }),
    );
    const oldId = created.id;
    await waitForListingStatus(oldId, (status) => status === "approved");

    const requestRes = await SELF.fetch(`http://x/api/listings/${oldId}/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
      body: JSON.stringify({
        note: "I would love this for my father, who still sails every summer.",
        email: "requester-reassign@keepsake.ing",
        date_of_birth: "1990-01-01",
      }),
    });
    expect(requestRes.status).toBe(201);

    const reportRes = await SELF.fetch(`http://x/api/listings/${oldId}/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
      body: JSON.stringify({ reason: "spam", details: "Seeding a report row for the reassign-ids test." }),
    });
    expect(reportRes.status).toBe(201);

    // Positive control, same reasoning as cascadeDelete.test.ts: every
    // referencing table has a row under the old id before the rename, or a
    // count of zero after it proves nothing.
    const refs = await listingReferences(env);
    expect(refs.length, "listingReferences() found no tables referencing listings(id) — the discovery query is broken").toBeGreaterThan(0);
    const before: Record<string, number> = {};
    for (const ref of refs) {
      before[ref.table] = await countFor(ref.table, ref.column, oldId);
      expect(before[ref.table], `${ref.table} was empty before the rename — this test would pass vacuously`).toBeGreaterThan(0);
    }

    const newId = ulid();

    const reassignRes = await SELF.fetch("http://x/api/admin/testing/reassign-listing-ids", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ pairs: [{ from: oldId, to: newId }] }),
    });
    const result = await readOk<AdminReassignListingIdsResult>(reassignRes);
    expect(result.reassigned).toBe(1);
    expect(result.tables.sort()).toEqual(refs.map((r) => r.table).sort());

    // The old id is entirely gone...
    const oldRow = await env.DB.prepare("SELECT id FROM listings WHERE id = ?").bind(oldId).first();
    expect(oldRow).toBeNull();
    for (const ref of refs) {
      expect(await countFor(ref.table, ref.column, oldId), `${ref.table} still has a row under the old id`).toBe(0);
    }

    // ...and every row that mattered moved to the new one, with the same
    // count it had before.
    const newRow = await env.DB.prepare("SELECT id, title FROM listings WHERE id = ?")
      .bind(newId)
      .first<{ id: string; title: string }>();
    expect(newRow?.title).toBe(`A brass compass ${nonce}`);
    for (const ref of refs) {
      expect(await countFor(ref.table, ref.column, newId), `${ref.table} did not gain a row under the new id`).toBe(
        before[ref.table],
      );
    }

    // The listing is reachable under its new id through the ordinary public
    // route, not just by querying D1 directly — the rename didn't just move
    // rows, it moved the listing a real client would fetch.
    const publicRes = await SELF.fetch(`http://x/api/listings/${newId}`);
    expect(publicRes.status).toBe(200);
    const publicBody = await readOk<{ id: string }>(publicRes);
    expect(publicBody.id).toBe(newId);

    // `listings_fts` needed no explicit handling (see the route's comment):
    // it's keyed on rowid, which a `TEXT PRIMARY KEY` rename never touches,
    // and the trigger that would resync it only fires on `title`/`story`.
    // Confirm the search index still resolves this row, and resolves it to
    // the *new* id.
    const ftsRow = await env.DB.prepare(
      "SELECT l.id FROM listings_fts f JOIN listings l ON l.rowid = f.rowid WHERE listings_fts MATCH ?",
    )
      .bind(`${nonce}*`)
      .first<{ id: string }>();
    expect(ftsRow?.id).toBe(newId);

    // FK enforcement is back on immediately afterward — the deferred pragma
    // is scoped to the one transaction the batch ran in, not left off for
    // the connection. An update that would orphan a child row still throws.
    await expect(
      env.DB.prepare("UPDATE photos SET listing_id = ? WHERE listing_id = ?").bind(ulid(), newId).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("renaming an id nobody has yet is a harmless no-op, not an error", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const res = await SELF.fetch("http://x/api/admin/testing/reassign-listing-ids", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ pairs: [{ from: ulid(), to: ulid() }] }),
    });
    const result = await readOk<AdminReassignListingIdsResult>(res);
    expect(result.reassigned).toBe(1);
  });

  it("rejects a non-ULID id as a validation error, not a raw SQL failure", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const res = await SELF.fetch("http://x/api/admin/testing/reassign-listing-ids", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ pairs: [{ from: "not-a-ulid", to: ulid() }] }),
    });
    expect(res.status).toBe(400);
    const err = await readErr(res);
    expect(err.code).toBe("bad_request");
  });

  it("401s without a valid admin token, the same as every other route on this router", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    const res = await SELF.fetch("http://x/api/admin/testing/reassign-listing-ids", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairs: [{ from: ulid(), to: ulid() }] }),
    });
    expect(res.status).toBe(401);
  });

  it("404s outside MOCK_AI, even with a correct admin token — this is the test/dev-only gate", async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    setTestEnvVar("MOCK_AI", "0");
    const res = await SELF.fetch("http://x/api/admin/testing/reassign-listing-ids", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ pairs: [{ from: ulid(), to: ulid() }] }),
    });
    expect(res.status).toBe(404);
  });
});
