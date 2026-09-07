/**
 * Issue #188 — a request's email address was never verified, so anyone could
 * enrol a third party as a requester and make Keepsake mail them.
 *
 * These tests are written from the victim's side, because that is who the bug
 * was about. The attacker's submission is allowed to succeed everywhere here:
 * what is asserted is that succeeding buys them nothing — no ask in the
 * giver's dashboard, no choosable request, no giver's address delivered to an
 * address its owner never gave us, and a strictly bounded amount of mail.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { OwnerViewRequest } from "@keepsake/contracts/request";
import { orphanSweep } from "../src/cron/orphanSweep.js";
import {
  authHeaders,
  freshClientIp,
  freshOwnerToken,
  freshRequesterEmail,
  insertApprovedListing,
  installFakeEmail,
  readErr,
  readOk,
  removeFakeEmail,
} from "./helpers.js";
import { sha256Hex } from "../src/lib/digest.js";

const VICTIM_NOTE = "I'd love this, my grandmother had one just like it and I've never forgotten it.";

async function submitRequest(listingId: string, email: string, note = VICTIM_NOTE): Promise<Response> {
  return SELF.fetch(`http://x/api/listings/${listingId}/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
    body: JSON.stringify({ note, email, date_of_birth: "1990-01-01" }),
  });
}

async function confirm(token: string): Promise<Response> {
  return SELF.fetch("http://x/api/requests/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
    body: JSON.stringify({ token }),
  });
}

function tokenFromLatestMail(sent: { text: string }[]): string {
  const match = /\/confirm\/([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "");
  if (!match?.[1]) throw new Error("no confirm link in the latest mail");
  return match[1];
}

/** A giver with a confirmed address, so the owner-notify path is live. */
async function insertGiverWithListing(title = "A quiet teacup"): Promise<{ ownerId: string; listingId: string; token: string }> {
  const { token, ownerId } = await insertOwnerWithToken();
  await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE id = ?")
    .bind("giver@keepsake.ing", Date.now(), ownerId)
    .run();
  const listingId = await insertApprovedListing({ ownerId, title });
  return { ownerId, listingId, token };
}

/** An owner row whose bearer token this suite actually holds, so the giver's
 * own dashboard and choose endpoint can be called as the giver. */
async function insertOwnerWithToken(): Promise<{ token: string; ownerId: string }> {
  const token = freshOwnerToken();
  const ownerId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .bind(ownerId, await sha256Hex(token), now, now)
    .run();
  return { token, ownerId };
}

describe("issue #188: a request is held until its email address is proved", () => {
  afterEach(() => removeFakeEmail());

  it("keeps an unconfirmed request out of the giver's dashboard entirely", async () => {
    installFakeEmail();
    const { listingId, token } = await insertGiverWithListing();

    expect((await submitRequest(listingId, freshRequesterEmail())).status).toBe(201);

    const dashboard = await SELF.fetch(`http://x/api/me/listings/${listingId}`, { headers: authHeaders(token) });
    const detail = await readOk<{ requests: OwnerViewRequest[]; request_count?: number }>(dashboard);
    // The heart of the bug: a stranger's unverified address used to appear
    // here as a genuine-looking ask, masked and ready to be chosen.
    expect(detail.requests).toHaveLength(0);
  });

  it("refuses to let a giver choose an unconfirmed request, so the giver's address is never mailed to it", async () => {
    const sent = installFakeEmail();
    const { listingId, token } = await insertGiverWithListing();
    const victim = freshRequesterEmail();

    await submitRequest(listingId, victim);
    const held = await env.DB.prepare("SELECT id FROM requests WHERE listing_id = ?").bind(listingId).first<{ id: string }>();
    expect(held?.id).toBeTruthy();

    // Straight at the choose endpoint with the held request's real id — the
    // dashboard would never have offered it, so this is the attack a filter
    // on the *read* path alone would not stop.
    const chose = await SELF.fetch(`http://x/api/me/listings/${listingId}/choose`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ request_id: held?.id, handoff_note: "It's yours — I'm around this weekend." }),
    });
    expect(chose.status).toBe(404);

    // Nothing was mailed to the address beyond the one "was this you?".
    expect(sent.filter((m) => m.to === victim)).toHaveLength(1);
    expect(sent.filter((m) => m.to === victim)[0]?.subject).toContain("Did you ask for");
  });

  it("never puts the submitter's note in the message sent to an unproven address", async () => {
    const sent = installFakeEmail();
    const { listingId } = await insertGiverWithListing();
    const victim = freshRequesterEmail();

    // The note is the attacker's free text. Reflecting it would make the
    // confirmation itself a way to deliver a message to a stranger's inbox —
    // the harassment channel this whole step exists to close.
    const hostileNote = "You should be ashamed of yourself, and I know exactly where you live.";
    await submitRequest(listingId, victim, hostileNote);

    const mail = sent.find((m) => m.to === victim);
    expect(mail).toBeTruthy();
    expect(mail?.text).not.toContain("ashamed");
    expect(mail?.html).not.toContain("ashamed");
    // The listing title is fine: it is public, already-moderated content, and
    // it is what makes the message make sense to read.
    expect(mail?.text).toContain("A quiet teacup");
  });

  it("caps how much mail one address can be sent in a day, however many listings or IPs are used", async () => {
    const sent = installFakeEmail();
    const victim = freshRequesterEmail();
    const { ownerId } = await insertOwnerWithToken();

    // Five different listings, five different client IPs — the shape of the
    // original report, where `REQUEST_IP_DAILY_BUDGET = 20` meant one address
    // could be sent twenty unsolicited messages a day by walking the feed.
    // `UNIQUE (listing_id, email)` never stopped it, because each listing is
    // a fresh row.
    for (let i = 0; i < 5; i += 1) {
      const listingId = await insertApprovedListing({ ownerId, title: `Keepsake ${i}` });
      // Every submission still answers 201: refusing visibly would tell a
      // caller whether someone has been aiming requests at that address.
      expect((await submitRequest(listingId, victim)).status).toBe(201);
    }

    // REQUEST_CONFIRM_ADDRESS_DAILY_BUDGET is pinned to 3 in vitest.config.ts.
    expect(sent.filter((m) => m.to === victim)).toHaveLength(3);

    // And the two refused submissions were not written down either: an
    // address we will not mail is not an address to hold.
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE email = ?")
      .bind(victim)
      .first<{ n: number }>();
    expect(rows?.n).toBe(3);
  });

  it("deletes a request nobody confirmed once its link expires, freeing the address to ask again", async () => {
    const sent = installFakeEmail();
    const { listingId } = await insertGiverWithListing();
    const victim = freshRequesterEmail();

    await submitRequest(listingId, victim);
    const held = await env.DB.prepare("SELECT id FROM requests WHERE email = ?").bind(victim).first<{ id: string }>();
    const staleToken = tokenFromLatestMail(sent);

    // Age the link past its expiry rather than waiting three days for it.
    await env.DB.prepare("UPDATE requests SET confirm_expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, held?.id)
      .run();

    // An expired link says so — actionable, and only reachable by whoever
    // reads mail at that address.
    const expired = await confirm(staleToken);
    expect(expired.status).toBe(410);
    expect((await readErr(expired)).code).toBe("gone");

    await orphanSweep(env);

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE email = ?").bind(victim).first<{ n: number }>();
    expect(after?.n).toBe(0);
    // Gone, not redacted: the row held a third party's address on no
    // authority at all, so there is nothing here worth keeping. And with the
    // row gone, `UNIQUE (listing_id, email)` no longer locks that address out
    // of that listing.
    const again = await submitRequest(listingId, victim);
    expect(again.status).toBe(201);
  });

  it("confirms once and only once — a replayed link never double-counts or re-mails the giver", async () => {
    const sent = installFakeEmail();
    const { listingId } = await insertGiverWithListing();

    await submitRequest(listingId, freshRequesterEmail());
    const token = tokenFromLatestMail(sent);

    expect((await confirm(token)).status).toBe(200);
    const mailsAfterFirst = sent.length;

    // Clicking twice, reloading the page, and the back button are all
    // ordinary. The replay answers success (telling someone their own
    // confirmation is invalid because it worked reads as a broken product)
    // and does nothing.
    expect((await confirm(token)).status).toBe(200);

    expect(sent).toHaveLength(mailsAfterFirst);
    const listing = await env.DB.prepare("SELECT request_count FROM listings WHERE id = ?")
      .bind(listingId)
      .first<{ request_count: number }>();
    expect(listing?.request_count).toBe(1);
  });

  it("confirms without forwarding when the keepsake was given away while the link sat unread", async () => {
    const sent = installFakeEmail();
    const { listingId } = await insertGiverWithListing();

    await submitRequest(listingId, freshRequesterEmail());
    const token = tokenFromLatestMail(sent);
    await env.DB.prepare("UPDATE listings SET status = 'given' WHERE id = ?").bind(listingId).run();
    const mailsBefore = sent.length;

    const res = await confirm(token);
    expect(res.status).toBe(200);
    const result = await readOk<{ listing_available: boolean }>(res);
    expect(result.listing_available).toBe(false);

    // Nobody is mailed: telling a giver about a new ask for something they
    // have already given away is noise about a decision they have made.
    expect(sent).toHaveLength(mailsBefore);
    expect(sent.some((m) => m.to === "giver@keepsake.ing")).toBe(false);
  });

  it("kills the confirm link when the request is withdrawn, so the ask cannot be revived", async () => {
    const sent = installFakeEmail();
    const { listingId } = await insertGiverWithListing();
    const victim = freshRequesterEmail();

    await submitRequest(listingId, victim);
    const confirmToken = tokenFromLatestMail(sent);
    expect((await confirm(confirmToken)).status).toBe(200);

    const withdrawMatch = /\/withdraw\/([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "");
    expect(withdrawMatch?.[1]).toBeTruthy();
    const withdrawn = await SELF.fetch("http://x/api/requests/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
      body: JSON.stringify({ token: withdrawMatch?.[1] }),
    });
    expect(withdrawn.status).toBe(200);

    // Both links were mailed to the same inbox, so a live confirm token on a
    // withdrawn row would let whoever still has the first message put back a
    // note and an address the row was just asked to forget.
    expect((await confirm(confirmToken)).status).toBe(401);
    const row = await env.DB.prepare("SELECT status, email, confirm_token_hash FROM requests WHERE listing_id = ?")
      .bind(listingId)
      .first<{ status: string; email: string | null; confirm_token_hash: string | null }>();
    expect(row?.status).toBe("withdrawn");
    expect(row?.email).toBeNull();
    expect(row?.confirm_token_hash).toBeNull();
  });

  it("answers an unknown token exactly as it answers a used one", async () => {
    const res = await confirm("not-a-real-token-at-all");
    expect(res.status).toBe(401);
    expect((await readErr(res)).code).toBe("unauthorized");
  });
});
