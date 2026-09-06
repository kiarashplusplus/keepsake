import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { OwnerViewRequest } from "@keepsake/contracts/request";
import {
  authHeaders,
  freshClientIp,
  freshOwnerToken,
  insertApprovedListing,
  installFakeEmail,
  readErr,
  readOk,
  removeFakeEmail,
} from "./helpers.js";
import { ulid } from "../src/lib/ids.js";

describe("POST /api/me/listings/:id/choose", () => {
  afterEach(() => removeFakeEmail());

  it("marks the chosen request chosen, others not_chosen, sets chosen_request_id, and reveals contact", async () => {
    const sent = installFakeEmail();
    const token = freshOwnerToken();

    // Establish the owner row first (ownerAuth createIfMissing only fires on
    // photo upload / listing create in the real app; here we just need a row
    // to attach a listing to and later authenticate against).
    const tokenHash = await sha256HexForTest(token);
    const ownerId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO owners (id, token_hash, email, email_verified_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(ownerId, tokenHash, "giver@keepsake.ing", now, now, now)
      .run();

    const listingId = await insertApprovedListing({ ownerId, title: "A quiet teacup" });

    const chosenRequestId = await insertRequest(listingId, "chosen-me@keepsake.ing");
    const otherRequestId = await insertRequest(listingId, "not-me@keepsake.ing");

    const res = await SELF.fetch(`http://x/api/me/listings/${listingId}/choose`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: chosenRequestId, handoff_note: "I'll leave it on the porch Saturday morning." }),
    });
    expect(res.status).toBe(200);
    const revealed = await readOk<OwnerViewRequest>(res);
    expect(revealed.status).toBe("chosen");
    expect(revealed.email).toBe("chosen-me@keepsake.ing");

    const listingRow = await env.DB.prepare("SELECT chosen_request_id FROM listings WHERE id = ?").bind(listingId).first<{ chosen_request_id: string }>();
    expect(listingRow?.chosen_request_id).toBe(chosenRequestId);

    const otherRow = await env.DB.prepare("SELECT status FROM requests WHERE id = ?").bind(otherRequestId).first<{ status: string }>();
    expect(otherRow?.status).toBe("not_chosen");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("chosen-me@keepsake.ing");
    expect(sent[0]?.replyTo).toBe("giver@keepsake.ing");
  });

  it("409s choosing a request that's already been decided", async () => {
    const token = freshOwnerToken();
    const tokenHash = await sha256HexForTest(token);
    const ownerId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(ownerId, tokenHash, now, now).run();
    const listingId = await insertApprovedListing({ ownerId });
    const requestId = await insertRequest(listingId, "someone@keepsake.ing");

    const first = await SELF.fetch(`http://x/api/me/listings/${listingId}/choose`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, handoff_note: "Great!" }),
    });
    expect(first.status).toBe(200);

    const second = await SELF.fetch(`http://x/api/me/listings/${listingId}/choose`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, handoff_note: "Again?" }),
    });
    expect(second.status).toBe(409);
    const error = await readErr(second);
    expect(error.code).toBe("conflict");
  });
});

async function insertRequest(listingId: string, email: string): Promise<string> {
  // Must be a real ULID: `request_id` in the choose request body is
  // validated against `ChooseRequestInput`'s `UlidSchema`.
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO requests (id, listing_id, note, email, ip_digest, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  )
    .bind(id, listingId, "I would love this, thank you for considering me.", email, `test-digest-${freshClientIp()}`, now)
    .run();
  return id;
}

async function sha256HexForTest(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
