import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateRequestResult } from "@keepsake/contracts/request";
import type { OwnerViewRequest } from "@keepsake/contracts/request";
import {
  authHeaders,
  freshClientIp,
  freshRequesterEmail,
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

/**
 * Issue #188: submitting no longer forwards anything. These two helpers are
 * the second half of every flow that used to be one POST — pull the one-time
 * token out of the confirmation email the way a real requester would (by
 * following the link in it, not by reading the database), and redeem it.
 *
 * Reading the token from the mail rather than from `requests` is deliberate:
 * it is what makes these tests fail if the link is ever malformed, points at
 * the wrong path, or stops being included at all.
 */
function confirmTokenFrom(sent: { to: string; text: string }[], to?: string): string {
  const mail = to === undefined ? sent.at(-1) : sent.filter((m) => m.to === to).at(-1);
  const match = /\/confirm\/([A-Za-z0-9_-]+)/.exec(mail?.text ?? "");
  if (!match?.[1]) throw new Error(`no confirm link in mail to ${to ?? "(latest)"}: ${JSON.stringify(mail?.text)}`);
  return match[1];
}

async function confirmRequest(token: string): Promise<Response> {
  return SELF.fetch("http://x/api/requests/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
    body: JSON.stringify({ token }),
  });
}

/**
 * A well-formed submission with an address no other test has used — see
 * `freshRequesterEmail`. Issue #188 made the requester's address a rate-limit
 * key, so a shared constant would have unrelated tests spending each other's
 * confirmation allowance.
 */
function validRequestBody(email = freshRequesterEmail()): { note: string; email: string; date_of_birth: string } {
  return {
    note: "This would mean so much to my family, thank you for considering us.",
    email,
    date_of_birth: "1990-01-01",
  };
}

describe("POST /api/listings/:id/requests", () => {
  afterEach(() => removeFakeEmail());

  // Issue #188. Submitting writes the ask down and mails one "was this you?"
  // link; it does not make the request real. The three things a giver can
  // see — `status`, `request_count`, and (in the tests below) the dashboard —
  // stay untouched until the link is redeemed, and that is the whole fix:
  // nothing about a stranger's unproven address reaches the giver.
  it("holds the request unconfirmed on submit: no request_count, no open status", async () => {
    const sent = installFakeEmail();
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const submission = validRequestBody();
    const res = await requestListing(listingId, submission);
    expect(res.status).toBe(201);
    const body = await readOk<CreateRequestResult>(res);
    expect(body.id).toBeTruthy();
    expect(body.created_at).toBeGreaterThan(0);

    const row = await env.DB.prepare("SELECT request_count FROM listings WHERE id = ?").bind(listingId).first<{ request_count: number }>();
    expect(row?.request_count).toBe(0);

    const requestRow = await env.DB.prepare("SELECT status, email, confirmed_at, withdraw_token_hash FROM requests WHERE id = ?")
      .bind(body.id)
      .first<{ status: string; email: string; confirmed_at: number | null; withdraw_token_hash: string | null }>();
    expect(requestRow?.status).toBe("unconfirmed");
    expect(requestRow?.confirmed_at).toBeNull();
    expect(requestRow?.email).toBe(submission.email);
    // No withdraw token yet: a second bearer secret must not be mailed to an
    // address nobody has verified.
    expect(requestRow?.withdraw_token_hash).toBeNull();

    // Exactly one message, and it goes to the requester. The giver hears
    // nothing at this stage.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(submission.email);
    expect(sent[0]?.subject).toContain("Did you ask for");
  });

  it("confirming the emailed link is what opens the request and bumps request_count", async () => {
    const sent = installFakeEmail();
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const created = await readOk<CreateRequestResult>(await requestListing(listingId, validRequestBody()));
    const confirmed = await confirmRequest(confirmTokenFrom(sent));
    expect(confirmed.status).toBe(200);
    const result = await readOk<{ id: string; listing_id: string; listing_available: boolean }>(confirmed);
    expect(result.id).toBe(created.id);
    expect(result.listing_available).toBe(true);

    const row = await env.DB.prepare("SELECT request_count FROM listings WHERE id = ?").bind(listingId).first<{ request_count: number }>();
    expect(row?.request_count).toBe(1);

    const requestRow = await env.DB.prepare("SELECT status, confirmed_at, withdraw_token_hash FROM requests WHERE id = ?")
      .bind(created.id)
      .first<{ status: string; confirmed_at: number | null; withdraw_token_hash: string | null }>();
    expect(requestRow?.status).toBe("open");
    expect(requestRow?.confirmed_at).not.toBeNull();
    // The withdraw token is minted here, and mailed here, in the
    // "we passed your note along" confirmation that is finally true.
    expect(requestRow?.withdraw_token_hash).toBeTruthy();
    expect(sent.at(-1)?.subject).toContain("We passed your note along");
    expect(sent.at(-1)?.text).toContain("/withdraw/");
  });

  it("silently discards a duplicate of a confirmed request (same listing, same email) — no second row, no 409, no second email", async () => {
    const sent = installFakeEmail();
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const submission = validRequestBody();

    const first = await requestListing(listingId, submission);
    expect(first.status).toBe(201);
    expect((await confirmRequest(confirmTokenFrom(sent))).status).toBe(200);
    const mailsAfterConfirming = sent.length;

    // Issue #189: this used to be a `409 "You've already asked for this
    // one."`, which told any stranger whether a named person had asked for a
    // named keepsake. It is now the same 201 a first ask gets — see
    // `requestOracle.test.ts` for the full indistinguishability proof.
    const second = await requestListing(listingId, submission);
    expect(second.status).toBe(201);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE listing_id = ?")
      .bind(listingId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    // Issue #188: and nothing is re-mailed. Re-sending on every repeat
    // submission is what would turn this endpoint into an open mailer aimed
    // at any address a stranger names.
    expect(sent).toHaveLength(mailsAfterConfirming);
  });

  // Issue #188. The other half of "a row already exists for this address":
  // one that is still waiting on a link nobody clicked. Refusing to reissue
  // would mean a single lost email locks that address out of that listing
  // until the sweep, so this is deliberately allowed — bounded to one live
  // link per held request (the old token stops working), and bounded overall
  // by the per-recipient ceiling, which every submission spends whether it
  // reissues or not.
  it("reissues a fresh link onto the held row when the same address asks again before confirming", async () => {
    const sent = installFakeEmail();
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const submission = validRequestBody();

    expect((await requestListing(listingId, submission)).status).toBe(201);
    const firstToken = confirmTokenFrom(sent);

    expect((await requestListing(listingId, submission)).status).toBe(201);
    const secondToken = confirmTokenFrom(sent);
    expect(secondToken).not.toBe(firstToken);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE listing_id = ?")
      .bind(listingId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    // The superseded link is dead, not a second way in.
    expect((await confirmRequest(firstToken)).status).toBe(401);
    expect((await confirmRequest(secondToken)).status).toBe(200);
  });

  it("404s a pending listing", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    await env.DB.prepare("UPDATE listings SET status = 'pending' WHERE id = ?").bind(listingId).run();

    const res = await requestListing(listingId, validRequestBody());
    expect(res.status).toBe(404);
  });

  it("emails the giver and records notified_at when the owner has a verified email, and always confirms the requester", async () => {
    const sent = installFakeEmail();
    const ownerId = await insertOwner();
    const now = Date.now();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE id = ?").bind("giver@keepsake.ing", now, ownerId).run();
    const listingId = await insertApprovedListing({ ownerId, title: "A quiet teacup" });

    const res = await requestListing(listingId, validRequestBody());
    expect(res.status).toBe(201);
    const body = await readOk<CreateRequestResult>(res);

    // Issue #188: the giver's notification is no longer sent here. The only
    // message so far is the requester's own "was this you?".
    expect(sent).toHaveLength(1);
    const requesterAddress = sent[0]?.to;
    expect(requesterAddress).toMatch(/@keepsake\.ing$/);

    expect((await confirmRequest(confirmTokenFrom(sent))).status).toBe(200);

    // Then the two that used to go out at submit time: the giver's
    // new-request notification, and the requester's "we passed your note
    // along" confirmation carrying the withdraw link.
    expect(sent).toHaveLength(3);
    expect(sent[1]?.to).toBe("giver@keepsake.ing");
    expect(sent[1]?.subject).toContain("A quiet teacup");
    expect(sent[2]?.to).toBe(requesterAddress);
    expect(sent[2]?.subject).toContain("We passed your note along");
    expect(sent[2]?.text).toContain("/withdraw/");

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

    // The fake binding is installed only for the submit half, so the confirm
    // link can be read out of the mail the way a requester would. It is then
    // removed, so the owner-notify — which since #188 happens at confirmation
    // time — hits the real "binding missing" stub path and genuinely returns
    // `{ sent: false }`, which is the failure this test is about.
    const sent = installFakeEmail();
    const res = await requestListing(listingId, validRequestBody());
    expect(res.status).toBe(201);
    const body = await readOk<CreateRequestResult>(res);
    const confirmLinkToken = confirmTokenFrom(sent);
    removeFakeEmail();
    expect((await confirmRequest(confirmLinkToken)).status).toBe(200);

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

  it("mails only the requester when the owner has no verified email, at both steps", async () => {
    const sent = installFakeEmail();
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const res = await requestListing(listingId, validRequestBody());
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    const requesterAddress = sent[0]?.to;
    expect(sent[0]?.subject).toContain("Did you ask for");

    expect((await confirmRequest(confirmTokenFrom(sent))).status).toBe(200);

    expect(sent).toHaveLength(2);
    expect(sent[1]?.to).toBe(requesterAddress);
    expect(sent[1]?.subject).toContain("We passed your note along");
  });

  it("404s a listing whose owner is banned, same as if the listing didn't exist", async () => {
    const ownerId = await insertOwner();
    await env.DB.prepare("UPDATE owners SET banned_at = ? WHERE id = ?").bind(Date.now(), ownerId).run();
    const listingId = await insertApprovedListing({ ownerId });

    const res = await requestListing(listingId, validRequestBody());
    expect(res.status).toBe(404);
    const error = await readErr(res);
    expect(error.code).toBe("not_found");
  });

  it("silently discards a request whose email is the giver's own — no row, and no 400 confirming the address", async () => {
    const ownerId = await insertOwner();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE id = ?")
      .bind("giver@keepsake.ing", Date.now(), ownerId)
      .run();
    const listingId = await insertApprovedListing({ ownerId });

    // Issue #189: this used to be a `400 "That's your own keepsake."`, which
    // confirmed the giver's private address to whoever guessed it.
    const res = await requestListing(listingId, { ...validRequestBody(), email: "giver@keepsake.ing" });
    expect(res.status).toBe(201);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE listing_id = ?")
      .bind(listingId)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("matches the giver's own email case-insensitively (still discarded, still silent)", async () => {
    const ownerId = await insertOwner();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE id = ?")
      .bind("giver@keepsake.ing", Date.now(), ownerId)
      .run();
    const listingId = await insertApprovedListing({ ownerId });

    const res = await requestListing(listingId, { ...validRequestBody(), email: "GIVER@Keepsake.ING" });
    expect(res.status).toBe(201);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE listing_id = ?")
      .bind(listingId)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("400s when date_of_birth is missing (docs/legal-considerations.md Minimum age, issue #64)", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const { date_of_birth: _omit, ...withoutAttestation } = validRequestBody();

    const res = await requestListing(listingId, withoutAttestation);
    expect(res.status).toBe(400);
    const error = await readErr(res);
    expect(error.code).toBe("bad_request");
  });

  it("400s when date_of_birth implies under the minimum age, not just when it's missing", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const res = await requestListing(listingId, { ...validRequestBody(), date_of_birth: "2020-01-01" });
    expect(res.status).toBe(400);
  });

  it("records the age attestation at submit and mints the withdraw token at confirmation, exposing neither to the client", async () => {
    const sent = installFakeEmail();
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const res = await requestListing(listingId, validRequestBody());
    const body = await readOk<CreateRequestResult>(res);
    expect(Object.keys(body)).toEqual(["id", "created_at"]);

    // The attestation is a fact about the submission and is recorded when it
    // is made; the withdraw token is a credential and waits for #188's proof
    // of address ownership.
    const held = await env.DB.prepare("SELECT withdraw_token_hash, age_attested_at FROM requests WHERE id = ?")
      .bind(body.id)
      .first<{ withdraw_token_hash: string | null; age_attested_at: number | null }>();
    expect(held?.age_attested_at).not.toBeNull();
    expect(held?.withdraw_token_hash).toBeNull();

    expect((await confirmRequest(confirmTokenFrom(sent))).status).toBe(200);

    const row = await env.DB.prepare("SELECT withdraw_token_hash FROM requests WHERE id = ?")
      .bind(body.id)
      .first<{ withdraw_token_hash: string | null }>();
    expect(row?.withdraw_token_hash).toBeTruthy();
  });

  it("410s a request against a listing that was just given to someone else", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    await env.DB.prepare("UPDATE listings SET status = 'given' WHERE id = ?").bind(listingId).run();

    const res = await requestListing(listingId, validRequestBody());
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

      const res = await requestListing(listingId, { ...validRequestBody(), note: "Call me directly at 555-123-4567, thanks!" });
      expect(res.status).toBe(400);
      const error = await readErr(res);
      expect(error.code).toBe("bad_request");
      expect(await requestCount(listingId)).toBe(0);
    });

    it("400s and inserts no row when the note contains an email address", async () => {
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });

      const res = await requestListing(listingId, { ...validRequestBody(), note: "Reach me at someone@example.com instead of here." });
      expect(res.status).toBe(400);
      expect(await requestCount(listingId)).toBe(0);
    });

    it("400s and inserts no row when the note contains a URL", async () => {
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });

      const res = await requestListing(listingId, { ...validRequestBody(), note: "Check out https://example.com for more about me." });
      expect(res.status).toBe(400);
      expect(await requestCount(listingId)).toBe(0);
    });

    it("still accepts an ordinary clean note, and still reaches the giver once confirmed", async () => {
      const sent = installFakeEmail();
      const ownerId = await insertOwner();
      await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE id = ?")
        .bind("giver@keepsake.ing", Date.now(), ownerId)
        .run();
      const listingId = await insertApprovedListing({ ownerId, title: "A quiet teacup" });

      const res = await requestListing(listingId, validRequestBody());
      expect(res.status).toBe(201);
      // The row exists — held, not open. `requestCount` here counts rows in
      // `requests`, not the listing's `request_count`.
      expect(await requestCount(listingId)).toBe(1);

      expect((await confirmRequest(confirmTokenFrom(sent))).status).toBe(200);

      // Three sends now: the "was this you?", then the two that used to go
      // out at submit time.
      expect(sent).toHaveLength(3);
      expect(sent[0]?.to).toMatch(/@keepsake\.ing$/);
      expect(sent[1]?.to).toBe("giver@keepsake.ing");
      expect(sent[2]?.to).toBe(sent[0]?.to);
    });
  });
});
