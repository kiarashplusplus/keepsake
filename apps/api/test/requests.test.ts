import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateRequestResult } from "@keepsake/contracts/request";
import type { OwnerViewRequest } from "@keepsake/contracts/request";
import {
  authHeaders,
  freshClientIp,
  freshOwnerToken,
  insertApprovedListing,
  insertOwner,
  installFakeEmail,
  readErr,
  readOk,
  removeFakeEmail,
} from "./helpers.js";
import { sha256Hex } from "../src/lib/digest.js";

async function requestListing(listingId: string, body: Record<string, unknown>, clientIp = freshClientIp()): Promise<Response> {
  return SELF.fetch(`http://x/api/listings/${listingId}/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
    body: JSON.stringify(body),
  });
}

const VALID_REQUEST_BODY = {
  note: "This would mean so much to my family, thank you for considering us.",
  email: "requester@keepsake.ing",
  age_attested: true,
};

describe("POST /api/listings/:id/requests", () => {
  afterEach(() => removeFakeEmail());

  it("happy path: creates the request, bumps request_count, and returns {id, created_at}", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const res = await requestListing(listingId, VALID_REQUEST_BODY);
    expect(res.status).toBe(201);
    const body = await readOk<CreateRequestResult>(res);
    expect(body.id).toBeTruthy();
    expect(body.created_at).toBeGreaterThan(0);

    const row = await env.DB.prepare("SELECT request_count FROM listings WHERE id = ?").bind(listingId).first<{ request_count: number }>();
    expect(row?.request_count).toBe(1);

    const requestRow = await env.DB.prepare("SELECT status, email FROM requests WHERE id = ?")
      .bind(body.id)
      .first<{ status: string; email: string }>();
    expect(requestRow?.status).toBe("open");
    expect(requestRow?.email).toBe("requester@keepsake.ing");
  });

  it("409s a duplicate request (same listing, same email)", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const first = await requestListing(listingId, VALID_REQUEST_BODY);
    expect(first.status).toBe(201);

    const second = await requestListing(listingId, VALID_REQUEST_BODY);
    expect(second.status).toBe(409);
    const error = await readErr(second);
    expect(error.code).toBe("conflict");
  });

  it("404s a pending listing", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    await env.DB.prepare("UPDATE listings SET status = 'pending' WHERE id = ?").bind(listingId).run();

    const res = await requestListing(listingId, VALID_REQUEST_BODY);
    expect(res.status).toBe(404);
  });

  it("emails the giver and records notified_at when the owner has a verified email, and always confirms the requester", async () => {
    const sent = installFakeEmail();
    const ownerId = await insertOwner();
    const now = Date.now();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE id = ?").bind("giver@keepsake.ing", now, ownerId).run();
    const listingId = await insertApprovedListing({ ownerId, title: "A quiet teacup" });

    const res = await requestListing(listingId, VALID_REQUEST_BODY);
    expect(res.status).toBe(201);
    const body = await readOk<CreateRequestResult>(res);

    // Two sends: the giver's new-request notification, then the requester's
    // own "we passed your note along" confirmation (with the withdraw link).
    expect(sent).toHaveLength(2);
    expect(sent[0]?.to).toBe("giver@keepsake.ing");
    expect(sent[0]?.subject).toContain("A quiet teacup");
    expect(sent[1]?.to).toBe("requester@keepsake.ing");
    expect(sent[1]?.subject).toContain("We passed your note along");
    expect(sent[1]?.text).toContain("/withdraw/");

    const requestRow = await env.DB.prepare("SELECT notified_at FROM requests WHERE id = ?").bind(body.id).first<{ notified_at: number | null }>();
    expect(requestRow?.notified_at).not.toBeNull();

    const emailEvent = await env.DB.prepare("SELECT kind, ok, provider FROM email_events WHERE kind = 'new_request' ORDER BY created_at DESC LIMIT 1")
      .first<{ kind: string; ok: number; provider: string }>();
    expect(emailEvent?.ok).toBe(1);
  });

  // Issue #6: this used to be discarded — the giver's own address rejected
  // the notification and their dashboard never said so. Breaks the send by
  // removing the fake `EMAIL` binding, so `sendMail` falls through to its
  // real "binding missing" stub path (`sent: false`) rather than the
  // reserved-domain guard, which `EMAIL_MODE: "test"` bypasses everywhere
  // else in this suite. Checks all three places the failure must now land:
  // the `requests` row, `email_events`, and the owner's own dashboard read.
  it("records a failed owner-notify and surfaces it on the giver's own dashboard, instead of discarding it", async () => {
    const token = freshOwnerToken();
    const tokenHash = await sha256Hex(token);
    const ownerId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO owners (id, token_hash, email, email_verified_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(ownerId, tokenHash, "unreachable-giver@keepsake.ing", now, now, now)
      .run();
    const listingId = await insertApprovedListing({ ownerId, title: "A dented compass" });

    // No fake EMAIL binding installed — the owner-notify hits the real
    // "binding missing" stub path and genuinely returns `{ sent: false }`.
    const res = await requestListing(listingId, VALID_REQUEST_BODY);
    expect(res.status).toBe(201);
    const body = await readOk<CreateRequestResult>(res);

    const requestRow = await env.DB.prepare("SELECT notify_failed_reason FROM requests WHERE id = ?").bind(body.id).first<{
      notify_failed_reason: string | null;
    }>();
    expect(requestRow?.notify_failed_reason).toBeTruthy();

    const emailEvent = await env.DB.prepare(
      "SELECT ok FROM email_events WHERE kind = 'new_request' ORDER BY created_at DESC LIMIT 1",
    ).first<{ ok: number }>();
    expect(emailEvent?.ok).toBe(0);

    const dashboard = await SELF.fetch(`http://x/api/me/listings/${listingId}`, { headers: authHeaders(token) });
    expect(dashboard.status).toBe(200);
    const detail = await readOk<{ requests: OwnerViewRequest[] }>(dashboard);
    expect(detail.requests.find((r) => r.id === body.id)?.notify_failed).toBe(true);
  });

  it("sends only the requester confirmation when the owner has no verified email", async () => {
    const sent = installFakeEmail();
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const res = await requestListing(listingId, VALID_REQUEST_BODY);
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("requester@keepsake.ing");
    expect(sent[0]?.subject).toContain("We passed your note along");
  });

  it("404s a listing whose owner is banned, same as if the listing didn't exist", async () => {
    const ownerId = await insertOwner();
    await env.DB.prepare("UPDATE owners SET banned_at = ? WHERE id = ?").bind(Date.now(), ownerId).run();
    const listingId = await insertApprovedListing({ ownerId });

    const res = await requestListing(listingId, VALID_REQUEST_BODY);
    expect(res.status).toBe(404);
    const error = await readErr(res);
    expect(error.code).toBe("not_found");
  });

  it("400s when the requester's email is the giver's own (verified) email", async () => {
    const ownerId = await insertOwner();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE id = ?")
      .bind("giver@keepsake.ing", Date.now(), ownerId)
      .run();
    const listingId = await insertApprovedListing({ ownerId });

    const res = await requestListing(listingId, { ...VALID_REQUEST_BODY, email: "giver@keepsake.ing" });
    expect(res.status).toBe(400);
    const error = await readErr(res);
    expect(error.code).toBe("bad_request");
    expect(error.message).toBe("That's your own keepsake.");
  });

  it("matches the giver's own email case-insensitively", async () => {
    const ownerId = await insertOwner();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE id = ?")
      .bind("giver@keepsake.ing", Date.now(), ownerId)
      .run();
    const listingId = await insertApprovedListing({ ownerId });

    const res = await requestListing(listingId, { ...VALID_REQUEST_BODY, email: "GIVER@Keepsake.ING" });
    expect(res.status).toBe(400);
  });

  it("400s when age_attested is missing (docs/legal-considerations.md Minimum age)", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const { age_attested: _omit, ...withoutAttestation } = VALID_REQUEST_BODY;

    const res = await requestListing(listingId, withoutAttestation);
    expect(res.status).toBe(400);
    const error = await readErr(res);
    expect(error.code).toBe("bad_request");
  });

  it("400s when age_attested is false, not just missing", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const res = await requestListing(listingId, { ...VALID_REQUEST_BODY, age_attested: false });
    expect(res.status).toBe(400);
  });

  it("mints a single-use withdraw token every time (age attestation recorded, but never exposed to the client)", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const res = await requestListing(listingId, VALID_REQUEST_BODY);
    const body = await readOk<CreateRequestResult>(res);
    expect(Object.keys(body)).toEqual(["id", "created_at"]);

    const row = await env.DB.prepare("SELECT withdraw_token_hash, age_attested_at FROM requests WHERE id = ?")
      .bind(body.id)
      .first<{ withdraw_token_hash: string | null; age_attested_at: number | null }>();
    expect(row?.withdraw_token_hash).toBeTruthy();
    expect(row?.age_attested_at).not.toBeNull();
  });

  it("410s a request against a listing that was just given to someone else", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    await env.DB.prepare("UPDATE listings SET status = 'given' WHERE id = ?").bind(listingId).run();

    const res = await requestListing(listingId, VALID_REQUEST_BODY);
    expect(res.status).toBe(410);
    const error = await readErr(res);
    expect(error.code).toBe("gone");
  });

  describe("note moderation (contact info)", () => {
    async function requestCount(listingId: string): Promise<number> {
      const row = await env.DB.prepare("SELECT COUNT(*) as n FROM requests WHERE listing_id = ?")
        .bind(listingId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    }

    it("400s and inserts no row when the note contains a phone number", async () => {
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });

      const res = await requestListing(listingId, { ...VALID_REQUEST_BODY, note: "Call me directly at 555-123-4567, thanks!" });
      expect(res.status).toBe(400);
      const error = await readErr(res);
      expect(error.code).toBe("bad_request");
      expect(await requestCount(listingId)).toBe(0);
    });

    it("400s and inserts no row when the note contains an email address", async () => {
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });

      const res = await requestListing(listingId, { ...VALID_REQUEST_BODY, note: "Reach me at someone@example.com instead of here." });
      expect(res.status).toBe(400);
      expect(await requestCount(listingId)).toBe(0);
    });

    it("400s and inserts no row when the note contains a URL", async () => {
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });

      const res = await requestListing(listingId, { ...VALID_REQUEST_BODY, note: "Check out https://example.com for more about me." });
      expect(res.status).toBe(400);
      expect(await requestCount(listingId)).toBe(0);
    });

    it("still accepts an ordinary clean note and still emails the giver", async () => {
      const sent = installFakeEmail();
      const ownerId = await insertOwner();
      await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE id = ?")
        .bind("giver@keepsake.ing", Date.now(), ownerId)
        .run();
      const listingId = await insertApprovedListing({ ownerId, title: "A quiet teacup" });

      const res = await requestListing(listingId, VALID_REQUEST_BODY);
      expect(res.status).toBe(201);
      expect(await requestCount(listingId)).toBe(1);
      // Two sends, same as the happy-path test above: the giver's new-request
      // notification, then the requester's own "we passed your note along"
      // confirmation — this test predates that second send, back when the
      // giver was the only recipient.
      expect(sent).toHaveLength(2);
      expect(sent[0]?.to).toBe("giver@keepsake.ing");
      expect(sent[1]?.to).toBe("requester@keepsake.ing");
    });
  });
});
