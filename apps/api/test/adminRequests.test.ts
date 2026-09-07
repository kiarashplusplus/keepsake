// #70: the minor-takedown rule (docs/runbooks/admin.md) was executable on
// the giver side but not the requester side — no admin visibility into a
// request's note, and no way to remove a single request without hiding or
// rejecting the whole listing. These cover the two new endpoints that close
// that gap: GET /api/admin/requests/:id (targeted, on-demand lookup, not a
// queue) and POST /api/admin/requests/:id/remove (distinct from the
// requester's own self-service POST /api/requests/withdraw).
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminRequestRemoveResult, AdminRequestView } from "@keepsake/contracts/admin";
import { freshClientIp, installDenyingRateLimiter, insertApprovedListing, insertOwner, readErr, readOk, setTestEnvVar } from "./helpers.js";
import { ulid } from "../src/lib/ids.js";

const ADMIN_TOKEN = "test-admin-token-req-0123456789";

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

interface InsertRequestOptions {
  status?: string;
  /** Issue #188. Defaults to "confirmed", because that is what every status
   * this file exercises implies: a request only reaches `open` (and from
   * there `chosen`, `withdrawn`, `removed`) once its address was proved. Pass
   * `null` for the held case — an unconfirmed row, which never counted toward
   * `request_count` and so must not be decremented when an admin removes it. */
  confirmedAt?: number | null;
  note?: string | null;
  email?: string | null;
  phone?: string | null;
  ageAttestedAt?: number | null;
  withdrawnAt?: number | null;
  removedAt?: number | null;
  removedReason?: string | null;
}

async function insertRequest(listingId: string, options: InsertRequestOptions = {}): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO requests
      (id, listing_id, note, email, phone, ip_digest, status, created_at, age_attested_at, withdrawn_at, removed_at, removed_reason,
       confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      listingId,
      options.note === undefined ? "This would mean a lot to my family, thank you for considering us." : options.note,
      options.email === undefined ? "requester@keepsake.ing" : options.email,
      options.phone ?? null,
      `test-digest-${id}`,
      options.status ?? "open",
      now,
      options.ageAttestedAt ?? null,
      options.withdrawnAt ?? null,
      options.removedAt ?? null,
      options.removedReason ?? null,
      options.confirmedAt === undefined ? now : options.confirmedAt,
    )
    .run();
  // Mirrors the Worker: `request_count` moves when a request is confirmed, so
  // a held row does not bump it.
  if (options.confirmedAt !== null) {
    await env.DB.prepare("UPDATE listings SET request_count = request_count + 1 WHERE id = ?").bind(listingId).run();
  }
  return id;
}

describe("admin request routes", () => {
  afterEach(() => setTestEnvVar("ADMIN_TOKEN", ""));

  describe("GET /api/admin/requests/:id", () => {
    it("returns the full request, including note and listing context, unmasked", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId, title: "Grandmother's teacup" });
      const requestId = await insertRequest(listingId, {
        note: "I am 14 and would really like this for my collection.",
        email: "young.requester@keepsake.ing",
        phone: "+16175550100",
        ageAttestedAt: Date.now(),
      });

      const res = await SELF.fetch(`http://x/api/admin/requests/${requestId}`, { headers: adminHeaders() });
      expect(res.status).toBe(200);
      const body = await readOk<AdminRequestView>(res);
      expect(body.id).toBe(requestId);
      expect(body.listing_id).toBe(listingId);
      expect(body.listing_title).toBe("Grandmother's teacup");
      expect(body.listing_status).toBe("approved");
      expect(body.status).toBe("open");
      // The actual gap this issue closes: the note is visible at all.
      expect(body.note).toBe("I am 14 and would really like this for my collection.");
      expect(body.email).toBe("young.requester@keepsake.ing");
      expect(body.phone).toBe("+16175550100");
      expect(body.age_attested_at).not.toBeNull();
      expect(body.removed_at).toBeNull();
    });

    it("404s an unknown request id", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const res = await SELF.fetch(`http://x/api/admin/requests/${ulid()}`, { headers: adminHeaders() });
      expect(res.status).toBe(404);
    });

    it("401s with no admin token", async () => {
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });
      const requestId = await insertRequest(listingId);

      const res = await SELF.fetch(`http://x/api/admin/requests/${requestId}`, {
        headers: { "CF-Connecting-IP": freshClientIp() },
      });
      expect(res.status).toBe(401);
      const error = await readErr(res);
      expect(error.code).toBe("unauthorized");
    });
  });

  describe("POST /api/admin/requests/:id/remove", () => {
    it("redacts note/email/phone, marks removed (not withdrawn), decrements request_count, and logs an admin event", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });
      const requestId = await insertRequest(listingId, { note: "I am underage.", email: "minor@keepsake.ing" });

      const before = await env.DB.prepare("SELECT request_count FROM listings WHERE id = ?").bind(listingId).first<{ request_count: number }>();
      expect(before?.request_count).toBe(1);

      const res = await SELF.fetch(`http://x/api/admin/requests/${requestId}/remove`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ reason: "actual knowledge of minor age" }),
      });
      expect(res.status).toBe(200);
      const body = await readOk<AdminRequestRemoveResult>(res);
      expect(body.id).toBe(requestId);
      expect(body.listing_id).toBe(listingId);
      expect(body.removed).toBe(true);

      const row = await env.DB.prepare(
        "SELECT status, note, email, phone, removed_at, removed_reason FROM requests WHERE id = ?",
      )
        .bind(requestId)
        .first<{ status: string; note: string | null; email: string | null; phone: string | null; removed_at: number | null; removed_reason: string | null }>();
      // Deliberately not "withdrawn" — that status is reserved for the
      // requester's own action via POST /api/requests/withdraw, and
      // labeling an admin removal that way would misattribute it to the
      // requester on the owner's dashboard (apps/api/src/routes/me.ts).
      expect(row?.status).toBe("removed");
      expect(row?.note).toBeNull();
      expect(row?.email).toBeNull();
      expect(row?.phone).toBeNull();
      expect(row?.removed_at).not.toBeNull();
      expect(row?.removed_reason).toBe("actual knowledge of minor age");

      const after = await env.DB.prepare("SELECT request_count FROM listings WHERE id = ?").bind(listingId).first<{ request_count: number }>();
      expect(after?.request_count).toBe(0);

      const event = await env.DB.prepare(
        "SELECT kind, verdict, request_id, reason FROM moderation_events WHERE listing_id = ? AND kind = 'admin' ORDER BY created_at DESC LIMIT 1",
      )
        .bind(listingId)
        .first<{ kind: string; verdict: string; request_id: string | null; reason: string | null }>();
      expect(event?.verdict).toBe("request_removed");
      expect(event?.request_id).toBe(requestId);
      expect(event?.reason).toBe("actual knowledge of minor age");
    });

    it("removing a listing's request does not touch the listing itself", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });
      const requestId = await insertRequest(listingId);

      await SELF.fetch(`http://x/api/admin/requests/${requestId}/remove`, { method: "POST", headers: adminHeaders(), body: "{}" });

      const listing = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(listingId).first<{ status: string }>();
      expect(listing?.status).toBe("approved");
    });

    it("404s an unknown request id", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const res = await SELF.fetch(`http://x/api/admin/requests/${ulid()}/remove`, {
        method: "POST",
        headers: adminHeaders(),
        body: "{}",
      });
      expect(res.status).toBe(404);
    });

    // The exact bug class this project keeps shipping: an action on a bad
    // or already-handled id that returns 200 and quietly does nothing. A
    // second removal must be a hard conflict, not an idempotent success —
    // there is nothing left to redact, and a 200 here would look identical
    // to a real removal from the caller's side.
    it("409s removing an already-removed request instead of silently no-op'ing", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });
      const requestId = await insertRequest(listingId);

      const first = await SELF.fetch(`http://x/api/admin/requests/${requestId}/remove`, { method: "POST", headers: adminHeaders(), body: "{}" });
      expect(first.status).toBe(200);

      const second = await SELF.fetch(`http://x/api/admin/requests/${requestId}/remove`, { method: "POST", headers: adminHeaders(), body: "{}" });
      expect(second.status).toBe(409);
    });

    it("409s removing a request the requester already withdrew", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });
      const requestId = await insertRequest(listingId, { status: "withdrawn", note: null, email: null, withdrawnAt: Date.now() });

      const res = await SELF.fetch(`http://x/api/admin/requests/${requestId}/remove`, { method: "POST", headers: adminHeaders(), body: "{}" });
      expect(res.status).toBe(409);
    });

    it("401s with no admin token", async () => {
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });
      const requestId = await insertRequest(listingId);

      const res = await SELF.fetch(`http://x/api/admin/requests/${requestId}/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
        body: "{}",
      });
      expect(res.status).toBe(401);
    });

    it("runs the rate limiter before auth, same as every other /api/admin/* route", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const restore = installDenyingRateLimiter("RL_ADMIN");
      try {
        const res = await SELF.fetch("http://x/api/admin/requests/anything/remove", {
          method: "POST",
          headers: { ...adminHeaders(), "CF-Connecting-IP": freshClientIp() },
          body: "{}",
        });
        expect(res.status).toBe(429);
      } finally {
        restore();
      }
    });
  });
});
