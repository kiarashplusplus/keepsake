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

  // Issue #6: choosing used to fire the "chosen" email and report success
  // to the giver regardless of whether it actually reached anyone —
  // `sendMail()`'s own `{ sent: false, reason }` was discarded. This breaks
  // the send by removing the fake `EMAIL` binding (so `sendMail` falls
  // through to its "binding missing" stub path rather than the reserved-
  // domain guard, which `EMAIL_MODE: "test"` already bypasses everywhere in
  // this suite) and checks all three places the failure must now show up:
  // the choose response itself, the `requests` row, and the owner's own
  // dashboard read.
  it("surfaces a failed chosen-notify on the response, the request row, and the owner's dashboard — instead of reporting success anyway", async () => {
    const token = freshOwnerToken();
    const tokenHash = await sha256HexForTest(token);
    const ownerId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(ownerId, tokenHash, now, now).run();
    const listingId = await insertApprovedListing({ ownerId, title: "A tin lunchbox" });
    const requestId = await insertRequest(listingId, "unreachable@keepsake.ing");

    // No fake EMAIL binding installed — `sendMail` hits the "binding
    // missing" stub path and returns `{ sent: false }` for real, the same
    // as it would if Cloudflare's Email Service were unconfigured.
    const res = await SELF.fetch(`http://x/api/me/listings/${listingId}/choose`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, handoff_note: "On the porch, any time after six." }),
    });
    expect(res.status).toBe(200);
    const revealed = await readOk<OwnerViewRequest>(res);
    expect(revealed.notify_failed).toBe(true);

    const requestRow = await env.DB.prepare("SELECT notify_failed_reason FROM requests WHERE id = ?").bind(requestId).first<{
      notify_failed_reason: string | null;
    }>();
    expect(requestRow?.notify_failed_reason).toBeTruthy();

    const emailEvent = await env.DB.prepare("SELECT ok FROM email_events WHERE kind = 'chosen' ORDER BY created_at DESC LIMIT 1").first<{
      ok: number;
    }>();
    expect(emailEvent?.ok).toBe(0);

    const dashboard = await SELF.fetch(`http://x/api/me/listings/${listingId}`, { headers: authHeaders(token) });
    expect(dashboard.status).toBe(200);
    const detail = await readOk<{ requests: OwnerViewRequest[] }>(dashboard);
    expect(detail.requests.find((r) => r.id === requestId)?.notify_failed).toBe(true);
  });

  // Issue #185. Not the happy path and not the already-decided path — the
  // *interrupted* one. The old route was three unbatched writes: mark this
  // request chosen, mark the rest not_chosen, set `chosen_request_id`. If the
  // first landed and a later one did not (a D1 7403, an isolate eviction, a
  // timeout), the listing was left with `chosen_request_id = NULL` while one
  // request already read `chosen`. Nothing in the route looked at the listing,
  // so the giver's retry with a different request sailed through every guard,
  // and the "mark the rest not_chosen" statement only touched `open` rows —
  // so it could not un-choose the first. Two strangers, one object, one of
  // them travelling to meet someone who is expecting the other.
  //
  // This seeds the mirror-image state — the listing already claimed while
  // another request is still `open`, which is what a *concurrent* choose sees
  // once the other call has claimed the listing — and asserts the second
  // choose is refused with nothing written and, above all, nothing mailed.
  it("refuses a second choose once the listing is claimed, and mails nobody", async () => {
    const sent = installFakeEmail();
    const token = freshOwnerToken();
    const tokenHash = await sha256HexForTest(token);
    const ownerId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO owners (id, token_hash, email, email_verified_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(ownerId, tokenHash, "giver@keepsake.ing", now, now, now)
      .run();
    const listingId = await insertApprovedListing({ ownerId, title: "A brass thimble" });

    const firstRequestId = await insertRequest(listingId, "first@keepsake.ing");
    const secondRequestId = await insertRequest(listingId, "second@keepsake.ing");

    // The state a concurrent choose finds after the other call won the race:
    // the listing is claimed, and this request has not been decided yet.
    await env.DB.prepare("UPDATE listings SET chosen_request_id = ? WHERE id = ?").bind(firstRequestId, listingId).run();
    await env.DB.prepare("UPDATE requests SET status = 'chosen', chosen_at = ? WHERE id = ?").bind(now, firstRequestId).run();

    const res = await SELF.fetch(`http://x/api/me/listings/${listingId}/choose`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: secondRequestId, handoff_note: "Saturday morning works." }),
    });
    expect(res.status).toBe(409);
    expect((await readErr(res)).code).toBe("conflict");

    // The one that actually matters: nobody was told they'd been chosen, and
    // in particular nobody was handed the giver's address.
    expect(sent).toHaveLength(0);

    // And nothing moved. The loser is still `open`, the winner still holds
    // the listing.
    const second = await env.DB.prepare("SELECT status, chosen_at FROM requests WHERE id = ?")
      .bind(secondRequestId)
      .first<{ status: string; chosen_at: number | null }>();
    expect(second?.status).toBe("open");
    expect(second?.chosen_at).toBeNull();

    const listing = await env.DB.prepare("SELECT chosen_request_id FROM listings WHERE id = ?")
      .bind(listingId)
      .first<{ chosen_request_id: string }>();
    expect(listing?.chosen_request_id).toBe(firstRequestId);
  });

  // The other half of the interrupted case, and the one the issue calls
  // "sticky": a listing left with `chosen_request_id = NULL` while a request
  // already reads `chosen`. Exactly one request per listing may be chosen, so
  // finishing the decision here has to close the orphan too — the old sweep
  // said `WHERE status = 'open'`, which by construction could never do it.
  it("closes a request left chosen by an interrupted earlier attempt", async () => {
    const sent = installFakeEmail();
    const token = freshOwnerToken();
    const tokenHash = await sha256HexForTest(token);
    const ownerId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO owners (id, token_hash, email, email_verified_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(ownerId, tokenHash, "giver2@keepsake.ing", now, now, now)
      .run();
    const listingId = await insertApprovedListing({ ownerId, title: "A tin lunchbox" });

    const orphanId = await insertRequest(listingId, "orphan@keepsake.ing");
    const secondRequestId = await insertRequest(listingId, "second@keepsake.ing");

    // First write landed, the other two did not: request chosen, listing not.
    await env.DB.prepare("UPDATE requests SET status = 'chosen', chosen_at = ? WHERE id = ?").bind(now, orphanId).run();

    const res = await SELF.fetch(`http://x/api/me/listings/${listingId}/choose`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: secondRequestId, handoff_note: "Any evening after six." }),
    });
    expect(res.status).toBe(200);

    const orphan = await env.DB.prepare("SELECT status FROM requests WHERE id = ?").bind(orphanId).first<{ status: string }>();
    expect(orphan?.status).toBe("not_chosen");

    const listing = await env.DB.prepare("SELECT chosen_request_id FROM listings WHERE id = ?")
      .bind(listingId)
      .first<{ chosen_request_id: string }>();
    expect(listing?.chosen_request_id).toBe(secondRequestId);

    // One mail, to one person.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("second@keepsake.ing");
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
