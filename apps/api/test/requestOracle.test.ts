/**
 * Issue #189 — `POST /api/listings/:id/requests` was a silent oracle.
 *
 * Two guards answered with distinguishable, content-bearing errors above the
 * insert and above both `sendMail` calls, so probing was completely invisible
 * to the person being probed:
 *
 *   400 "That's your own keepsake."      → confirms a guessed address is the
 *                                          giver's, an address the privacy
 *                                          page promises is never shown
 *                                          publicly. Matched on `owners.email`
 *                                          rather than `email_verified_at`, so
 *                                          it confirmed unverified ones too.
 *   409 "You've already asked for this one." → confirms whether a named person
 *                                          has asked for a named keepsake.
 *
 * `routes/recover.ts` already enforces the opposite rule and its comment says
 * why. The assertion that matters here is not "the status changed" but
 * *indistinguishability*: a caller must not be able to tell the two probes
 * from an ordinary first ask by status, error code, or response shape — and
 * nothing may be written or mailed either way.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateRequestResult } from "@keepsake/contracts/request";
import { freshClientIp, insertApprovedListing, insertOwner, installFakeEmail, readOk, removeFakeEmail } from "./helpers.js";

const VALID_REQUEST_BODY = {
  note: "This would mean so much to my family, thank you for considering us.",
  email: "requester@keepsake.ing",
  date_of_birth: "1990-01-01",
};

async function requestListing(listingId: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`http://x/api/listings/${listingId}/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
    body: JSON.stringify(body),
  });
}

/** Everything a caller can actually observe about the answer. */
async function observable(res: Response): Promise<{ status: number; keys: string[]; ok: boolean }> {
  const body = (await res.json()) as Record<string, unknown>;
  const data = body["data"];
  return {
    status: res.status,
    ok: body["ok"] === true,
    keys: data && typeof data === "object" ? Object.keys(data as object).sort() : Object.keys(body).sort(),
  };
}

describe("POST /api/listings/:id/requests is not an enumeration oracle (issue #189)", () => {
  afterEach(() => removeFakeEmail());

  it("a self-request is indistinguishable from an ordinary first ask", async () => {
    installFakeEmail();

    const giverOwnerId = await insertOwner();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE id = ?")
      .bind("kiarash@keepsake.ing", Date.now(), giverOwnerId)
      .run();
    const probedListingId = await insertApprovedListing({ ownerId: giverOwnerId });

    // A second listing whose giver is *not* that address — the baseline the
    // probe has to be compared against, since an attacker always has one.
    const otherOwnerId = await insertOwner();
    const controlListingId = await insertApprovedListing({ ownerId: otherOwnerId });

    const probe = await observable(await requestListing(probedListingId, { ...VALID_REQUEST_BODY, email: "kiarash@keepsake.ing" }));
    const control = await observable(await requestListing(controlListingId, { ...VALID_REQUEST_BODY, email: "kiarash@keepsake.ing" }));

    expect(probe).toEqual(control);
    expect(probe.status).toBe(201);
    expect(probe.ok).toBe(true);
  });

  it("a duplicate ask is indistinguishable from a first ask", async () => {
    installFakeEmail();

    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const first = await observable(await requestListing(listingId, VALID_REQUEST_BODY));
    const repeat = await observable(await requestListing(listingId, VALID_REQUEST_BODY));

    expect(repeat).toEqual(first);
    expect(repeat.status).toBe(201);
  });

  it("neither probe writes a row or sends a mail", async () => {
    const sent = installFakeEmail();

    const giverOwnerId = await insertOwner();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE id = ?")
      .bind("giver189@keepsake.ing", Date.now(), giverOwnerId)
      .run();
    const listingId = await insertApprovedListing({ ownerId: giverOwnerId });

    // Self-request probe.
    const selfRes = await requestListing(listingId, { ...VALID_REQUEST_BODY, email: "giver189@keepsake.ing" });
    expect(selfRes.status).toBe(201);
    expect(sent).toHaveLength(0);

    // The id handed back is not a real request — no row, and `request_count`
    // is untouched, so the giver's dashboard shows nothing either.
    const selfBody = await readOk<CreateRequestResult>(selfRes);
    const selfRow = await env.DB.prepare("SELECT id FROM requests WHERE id = ?").bind(selfBody.id).first();
    expect(selfRow).toBeNull();

    // One genuine ask, then the duplicate probe.
    const realRes = await requestListing(listingId, VALID_REQUEST_BODY);
    expect(realRes.status).toBe(201);
    const mailsAfterRealAsk = sent.length;
    expect(mailsAfterRealAsk).toBeGreaterThan(0);

    const dupRes = await requestListing(listingId, VALID_REQUEST_BODY);
    expect(dupRes.status).toBe(201);
    // Deliberately no re-send: replaying an ask must not become an unbounded
    // mailer aimed at whatever address a stranger names.
    expect(sent).toHaveLength(mailsAfterRealAsk);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE listing_id = ?")
      .bind(listingId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);

    const listing = await env.DB.prepare("SELECT request_count FROM listings WHERE id = ?")
      .bind(listingId)
      .first<{ request_count: number }>();
    expect(listing?.request_count).toBe(1);
  });

  it("confirms nothing about an unverified giver address either", async () => {
    installFakeEmail();

    // The old check read `owners.email` with no regard for
    // `email_verified_at`, so it confirmed addresses the owner had never even
    // proved they controlled.
    const ownerId = await insertOwner();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = NULL WHERE id = ?")
      .bind("unverified189@keepsake.ing", ownerId)
      .run();
    const listingId = await insertApprovedListing({ ownerId });

    const res = await requestListing(listingId, { ...VALID_REQUEST_BODY, email: "unverified189@keepsake.ing" });
    expect(res.status).toBe(201);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE listing_id = ?")
      .bind(listingId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});
