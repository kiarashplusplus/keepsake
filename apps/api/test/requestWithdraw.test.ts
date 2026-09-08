import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  freshClientIp,
  freshRequesterEmail,
  insertApprovedListing,
  insertOwner,
  installFakeEmail,
  readErr,
  readOk,
  removeFakeEmail,
  type CapturedEmail,
} from "./helpers.js";

function validRequestBody(): Record<string, unknown> {
  return {
    note: "This would mean so much to my family, thank you for considering us.",
    // Fresh per call: since #188 the requester's address is a rate-limit key,
    // so a shared constant would have these tests spending one another's
    // confirmation allowance.
    email: freshRequesterEmail(),
    date_of_birth: "1990-01-01",
  };
}

/**
 * Submit *and* confirm, because since #188 those are two steps and a withdraw
 * token only exists after the second one — a request nobody confirmed has
 * nothing to withdraw, and is deleted by the nightly sweep instead.
 */
async function createRequest(listingId: string, overrides: Record<string, unknown> = {}): Promise<{ res: Response; withdrawLink: string | undefined }> {
  const sent: CapturedEmail[] = installFakeEmail();
  const res = await SELF.fetch(`http://x/api/listings/${listingId}/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
    body: JSON.stringify({ ...validRequestBody(), ...overrides }),
  });

  const confirmLink = sent
    .find((m) => m.subject.includes("Did you ask for"))
    ?.text.match(/https?:\/\/\S+\/confirm\/(\S+)/)?.[1];
  if (confirmLink !== undefined) {
    await SELF.fetch("http://x/api/requests/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
      body: JSON.stringify({ token: confirmLink }),
    });
  }

  const confirmation = sent.find((m) => m.subject.includes("We passed your note along"));
  const withdrawLink = confirmation?.text.match(/https?:\/\/\S+\/withdraw\/\S+/)?.[0];
  return { res, withdrawLink };
}

function tokenFromLink(link: string): string {
  const parts = link.split("/withdraw/");
  return parts[1] as string;
}

function withdraw(token: string): Promise<Response> {
  return SELF.fetch("http://x/api/requests/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

describe("POST /api/requests/withdraw", () => {
  afterEach(() => removeFakeEmail());

  it("claims the single-use token in the redaction write itself", () => {
    const modules = import.meta.glob<string>("../src/routes/requestWithdraw.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const source = modules["../src/routes/requestWithdraw.ts"];
    expect(source).toBeTruthy();
    expect(source).toMatch(
      /UPDATE requests SET[\s\S]*WHERE withdraw_token_hash = \? AND withdrawn_at IS NULL RETURNING id, listing_id/,
    );
  });

  it("erases note/email/phone, sets status withdrawn, and decrements request_count", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const { res: createRes, withdrawLink } = await createRequest(listingId, { phone: "+16175550123" });
    const { id: requestId } = await readOk<{ id: string }>(createRes);
    expect(withdrawLink).toBeTruthy();

    const before = await env.DB.prepare("SELECT request_count FROM listings WHERE id = ?").bind(listingId).first<{ request_count: number }>();
    expect(before?.request_count).toBe(1);

    const res = await withdraw(tokenFromLink(withdrawLink as string));
    expect(res.status).toBe(200);
    const body = await readOk<{ id: string; listing_id: string; withdrawn_at: number }>(res);
    expect(body.id).toBe(requestId);
    expect(body.listing_id).toBe(listingId);
    expect(body.withdrawn_at).toBeGreaterThan(0);

    const row = await env.DB.prepare("SELECT status, note, email, phone, ip_digest, withdrawn_at FROM requests WHERE id = ?")
      .bind(requestId)
      .first<{
        status: string;
        note: string | null;
        email: string | null;
        phone: string | null;
        ip_digest: string | null;
        withdrawn_at: number | null;
      }>();
    expect(row?.status).toBe("withdrawn");
    expect(row?.note).toBeNull();
    expect(row?.email).toBeNull();
    expect(row?.phone).toBeNull();
    // Issue #169: `ip_digest` was absent from the UPDATE, so the one control a
    // requester has over their own data left behind a hash of their IP address
    // on the day they used the site — permanently, because nothing else ever
    // removed a `requests` row except the giver deleting the whole listing.
    // The privacy page said it expired within 48 hours.
    expect(row?.ip_digest).toBeNull();
    expect(row?.withdrawn_at).not.toBeNull();

    const after = await env.DB.prepare("SELECT request_count FROM listings WHERE id = ?").bind(listingId).first<{ request_count: number }>();
    expect(after?.request_count).toBe(0);
  });

  it("401s an unknown token", async () => {
    const res = await withdraw("not-a-real-token");
    expect(res.status).toBe(401);
    const error = await readErr(res);
    expect(error.code).toBe("unauthorized");
  });

  it("401s a token that has already been used (single-use)", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const { withdrawLink } = await createRequest(listingId);
    const token = tokenFromLink(withdrawLink as string);

    const first = await withdraw(token);
    expect(first.status).toBe(200);

    const second = await withdraw(token);
    expect(second.status).toBe(401);
  });

  it("allows exactly one of two concurrent uses to withdraw and decrement the count", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const { withdrawLink } = await createRequest(listingId);
    const token = tokenFromLink(withdrawLink as string);

    // Keep a second live request represented in the aggregate. Starting at
    // two makes a double decrement visible; MAX(..., 0) would hide it if the
    // withdrawing request were the only one on the listing.
    await env.DB.prepare("UPDATE listings SET request_count = 2 WHERE id = ?").bind(listingId).run();

    const responses = await Promise.all([withdraw(token), withdraw(token)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);

    const row = await env.DB.prepare("SELECT request_count FROM listings WHERE id = ?")
      .bind(listingId)
      .first<{ request_count: number }>();
    expect(row?.request_count).toBe(1);
  });

  it("never lets a second withdrawal on the same listing double-decrement request_count below zero", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const { withdrawLink } = await createRequest(listingId);
    const token = tokenFromLink(withdrawLink as string);

    await withdraw(token);
    await withdraw(token); // second call 401s and must not touch request_count again

    const row = await env.DB.prepare("SELECT request_count FROM listings WHERE id = ?").bind(listingId).first<{ request_count: number }>();
    expect(row?.request_count).toBe(0);
  });

  it("still erases a chosen request's stored contact info — the giver may already have it by email, and this can't recall that, but our own database no longer holds it", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const { res: createRes, withdrawLink } = await createRequest(listingId);
    const { id: requestId } = await readOk<{ id: string }>(createRes);

    // Simulate the giver having already chosen this request (contact info
    // revealed and mailed to them — docs/design/email.md's "contact reveal
    // rule") before the requester changes their mind.
    await env.DB.prepare("UPDATE requests SET status = 'chosen', chosen_at = ? WHERE id = ?").bind(Date.now(), requestId).run();

    const res = await withdraw(tokenFromLink(withdrawLink as string));
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT status, email FROM requests WHERE id = ?").bind(requestId).first<{ status: string; email: string | null }>();
    expect(row?.status).toBe("withdrawn");
    expect(row?.email).toBeNull();
  });
});
