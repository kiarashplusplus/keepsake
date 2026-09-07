import { OwnerMe } from "@keepsake/contracts/owner";
import { guardRecipient, recipientDomain, sendMail } from "../src/email/sendMail.js";
import type { Env } from "../src/env.js";
import { sanitizeSubject } from "../src/email/templates/shared.js";
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import {
  authHeaders,
  freshClientIp,
  freshOwnerToken,
  insertApprovedListing,
  insertOwner,
  installFakeEmail,
  readOk,
  removeFakeEmail,
  seedStandardPostalCodes,
  uploadPhoto,
} from "./helpers.js";
import { randomTokenRaw } from "../src/lib/tokens.js";
import { RECOVER_TTL_MS } from "../src/routes/recover.js";
import { sha256Hex } from "../src/lib/digest.js";
import { ulid } from "../src/lib/ids.js";

/** Establishes the `owners` row via `PUT /api/photos`'s `createIfMissing`
 * path (the only way a fresh token becomes a real owner), then returns its
 * id — `GET /api/me` and `/api/me/email` both require the owner to already
 * exist. */
async function registerOwner(token: string): Promise<string> {
  await uploadPhoto({ token });
  const me = await readOk<{ id: string }>(await SELF.fetch("http://x/api/me", { headers: authHeaders(token) }));
  return me.id;
}

describe("POST /api/me/email + GET /api/me/email/verify", () => {
  afterEach(() => removeFakeEmail());

  it("sends a verify link, and the link verifies the email exactly once", async () => {
    const sent = installFakeEmail();
    const token = freshOwnerToken();
    // Owner must already exist for ownerAuth() (no createIfMissing on /me/email).
    await uploadPhoto({ token });

    const res = await SELF.fetch("http://x/api/me/email", {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@keepsake.ing" }),
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("owner@keepsake.ing");

    const link = sent[0]?.text.match(/https?:\/\/\S+/)?.[0];
    expect(link).toBeTruthy();
    const verifyRes = await SELF.fetch(link as string, { redirect: "manual" });
    expect(verifyRes.status).toBe(302);
    expect(verifyRes.headers.get("Location")).toBe("http://localhost:8787/mine?verified=1");

    const me = await readOk<{ email: string; email_verified: boolean }>(
      await SELF.fetch("http://x/api/me", { headers: authHeaders(token) }),
    );
    expect(me.email_verified).toBe(true);

    // Single use: the same link again is invalid, not a second success.
    const secondUse = await SELF.fetch(link as string, { redirect: "manual" });
    expect(secondUse.status).toBe(302);
    expect(secondUse.headers.get("Location")).toBe("http://localhost:8787/mine?verified=0&reason=invalid");
  });

  it("redirects with reason=expired for an expired token", async () => {
    const token = freshOwnerToken();
    const ownerId = await registerOwner(token);
    const rawToken = randomTokenRaw();
    const tokenHash = await sha256Hex(rawToken);
    const past = Date.now() - 1000;
    await env.DB.prepare(
      `INSERT INTO recovery_tokens (id, owner_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, 'verify_email', ?, ?, ?)`,
    )
      .bind(ulid(), ownerId, tokenHash, past, past)
      .run();

    const res = await SELF.fetch(`http://x/api/me/email/verify?token=${rawToken}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://localhost:8787/mine?verified=0&reason=expired");
  });

  it("POST /api/listings with an email reuses the same verify-email flow", async () => {
    const sent = installFakeEmail();
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));

    const res = await SELF.fetch("http://x/api/listings", {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "A quiet teacup",
        story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
        category: "home_kitchen",
        country: "US",
        postal_code: "02144",
        photo_ids: [photo.id],
        email: "on-create@keepsake.ing",
        date_of_birth: "1990-01-01",
      }),
    });
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("on-create@keepsake.ing");
    expect(sent[0]?.subject).toBe("Confirm your email — Keepsake");

    const link = sent[0]?.text.match(/https?:\/\/\S+/)?.[0];
    const verifyRes = await SELF.fetch(link as string, { redirect: "manual" });
    expect(verifyRes.headers.get("Location")).toBe("http://localhost:8787/mine?verified=1");
  });
});

describe("POST /api/recover + POST /api/recover/:token", () => {
  afterEach(() => removeFakeEmail());

  it("still returns {sent:true} for an email with no owner (no enumeration)", async () => {
    const res = await SELF.fetch("http://x/api/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody-here@keepsake.ing" }),
    });
    expect(res.status).toBe(200);
    const body = await readOk<{ sent: boolean }>(res);
    expect(body.sent).toBe(true);
  });

  it("a fresh token recovers the dashboard and the old owner token 401s afterwards", async () => {
    const sent = installFakeEmail();
    const oldToken = freshOwnerToken();
    await registerOwner(oldToken);
    const now = Date.now();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE token_hash = ?")
      .bind("recover-me@keepsake.ing", now, await sha256Hex(oldToken))
      .run();

    const recoverRes = await SELF.fetch("http://x/api/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "recover-me@keepsake.ing" }),
    });
    expect(recoverRes.status).toBe(200);
    expect(sent).toHaveLength(1);

    const link = sent[0]?.text.match(/https?:\/\/\S+\/recover\/\S+/)?.[0];
    expect(link).toBeTruthy();
    const recoverToken = (link as string).split("/recover/")[1];

    const exchangeRes = await SELF.fetch(`http://x/api/recover/${recoverToken}`, { method: "POST" });
    expect(exchangeRes.status).toBe(200);
    const result = await readOk<{ ownerToken: string }>(exchangeRes);
    expect(result.ownerToken).not.toBe(oldToken);
    expect(result.ownerToken.startsWith("ks_")).toBe(true);

    // Old token is dead immediately.
    const oldRes = await SELF.fetch("http://x/api/me", { headers: authHeaders(oldToken) });
    expect(oldRes.status).toBe(401);

    // New token works.
    const newRes = await SELF.fetch("http://x/api/me", { headers: authHeaders(result.ownerToken) });
    expect(newRes.status).toBe(200);

    // The recovery token itself is single-use.
    const secondExchange = await SELF.fetch(`http://x/api/recover/${recoverToken}`, { method: "POST" });
    expect(secondExchange.status).toBe(401);
  });

  // The email tells the reader when their link stops working. That sentence
  // used to carry its own literal "30 minutes" while the lifetime it
  // described lived in RECOVER_TTL_MS one module away, so shortening the TTL
  // would have left every recovery email making a false promise — the same
  // published-claim drift the privacy-policy guard in apps/web exists for,
  // with no guard on this side. Asserts against the row's real expires_at,
  // not just the constant, so the mail, the code and the database have to
  // agree on one number.
  it("states the token's real lifetime in the email it sends", async () => {
    const sent = installFakeEmail();
    const ownerToken = freshOwnerToken();
    await registerOwner(ownerToken);
    const now = Date.now();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE token_hash = ?")
      .bind("ttl-prose@keepsake.ing", now, await sha256Hex(ownerToken))
      .run();

    const res = await SELF.fetch("http://x/api/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ttl-prose@keepsake.ing" }),
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);

    const row = await env.DB.prepare(
      "SELECT expires_at, created_at FROM recovery_tokens WHERE purpose = 'recover' ORDER BY created_at DESC LIMIT 1",
    ).first<{ expires_at: number; created_at: number }>();
    expect(row).toBeTruthy();
    expect((row as { expires_at: number; created_at: number }).expires_at - (row as { created_at: number }).created_at).toBe(
      RECOVER_TTL_MS,
    );

    const minutes = Math.round(RECOVER_TTL_MS / 60_000);
    expect(sent[0]?.text).toContain(`expires in ${minutes} minutes`);
    expect(sent[0]?.html).toContain(`expires in ${minutes} minutes`);
  });
});

// ---------------------------------------------------------------------------
// Recipient guard. Cloudflare scores the sending domain on bounce rate (safe
// under 2%), and this repo carries plenty of `@keepsake.ing` test fixtures, so
// the guard is the thing that keeps a stray test run from burning keepsake.ing.
// ---------------------------------------------------------------------------
describe("guardRecipient", () => {
  const env = (mode: string, allowlist = "") =>
    ({ EMAIL_MODE: mode, EMAIL_ALLOWLIST: allowlist }) as unknown as Parameters<typeof guardRecipient>[0];

  it("refuses reserved domains even in live mode", () => {
    for (const address of [
      "someone@example.com",
      "a@example.net",
      "b@example.org",
      "c@anything.test",
      "d@thing.invalid",
      "e@localhost",
      "f@dev.local",
    ]) {
      expect(guardRecipient(env("live"), address), address).toEqual({
        allowed: false,
        reason: "blocked_reserved_domain",
      });
    }
  });

  it("refuses anything off the allowlist, and allows what is on it", () => {
    const e = env("allowlist", "kiarasha@alum.mit.edu");
    expect(guardRecipient(e, "kiarasha@alum.mit.edu")).toEqual({ allowed: true });
    expect(guardRecipient(e, "  KiaraSha@Alum.MIT.edu  ")).toEqual({ allowed: true });
    expect(guardRecipient(e, "stranger@gmail.com")).toEqual({
      allowed: false,
      reason: "blocked_not_allowlisted",
    });
  });

  it("fails closed when the mode is unset or unrecognised", () => {
    expect(guardRecipient(env(""), "real@gmail.com").allowed).toBe(false);
    expect(guardRecipient(env("yolo"), "real@gmail.com").allowed).toBe(false);
  });

  it("allows a real address in live mode", () => {
    expect(guardRecipient(env("live"), "real@gmail.com")).toEqual({ allowed: true });
  });

  it("rejects malformed addresses", () => {
    expect(guardRecipient(env("live"), "not-an-address").allowed).toBe(false);
    expect(guardRecipient(env("live"), "").allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Every owner-identity response must satisfy OwnerMe. The web client parses
// all three with that schema; POST/DELETE /email used to answer with ad-hoc
// shapes, so the parse threw and adding an email surfaced "That didn't go
// through" even though it had worked. Found by the Playwright suite.
// ---------------------------------------------------------------------------
describe("owner identity responses conform to OwnerMe", () => {
  it("GET, POST and DELETE /api/me/email all return a parseable OwnerMe", async () => {
    const token = freshOwnerToken();
    // Registers the owner: GET/POST /api/me have no create-if-missing, but
    // the photo upload route does upsert on first write.
    await uploadPhoto({ token });
    const auth = authHeaders(token);

    const get = await SELF.fetch("https://x/api/me", { headers: auth });
    expect(OwnerMe.safeParse((await get.json<{ data: unknown }>()).data).success).toBe(true);

    const set = await SELF.fetch("https://x/api/me/email", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@keepsake.ing" }),
    });
    expect(set.status).toBe(200);
    const setBody = OwnerMe.safeParse((await set.json<{ data: unknown }>()).data);
    expect(setBody.success, JSON.stringify(setBody.error?.issues)).toBe(true);
    expect(setBody.data?.email).toBe("owner@keepsake.ing");
    expect(setBody.data?.email_verified).toBe(false);

    const del = await SELF.fetch("https://x/api/me/email", { method: "DELETE", headers: auth });
    const delBody = OwnerMe.safeParse((await del.json<{ data: unknown }>()).data);
    expect(delBody.success, JSON.stringify(delBody.error?.issues)).toBe(true);
    expect(delBody.data?.email).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #20: a listing title reaches both `newRequest` and `chosen`'s
// subject line unescaped. `TitleSchema` (packages/contracts/src/listing.ts)
// now rejects control characters on new input, but `sanitizeSubject`
// (src/email/templates/shared.ts) is the runtime backstop for rows already
// sitting in D1 from before that check existed — these tests insert such a
// row directly, bypassing the schema entirely, exactly like that scenario.
// ---------------------------------------------------------------------------
describe("email subjects strip CR/LF from the listing title (issue #20)", () => {
  afterEach(() => removeFakeEmail());

  const DIRTY_TITLE = "Grandma's\nletters\rfrom\r\nthe war";

  async function insertOpenRequest(listingId: string, email: string): Promise<string> {
    const id = ulid();
    await env.DB.prepare(
      `INSERT INTO requests (id, listing_id, note, email, ip_digest, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    )
      .bind(id, listingId, "I would love this, thank you for considering me.", email, `test-digest-${freshClientIp()}`, Date.now())
      .run();
    return id;
  }

  it("POST /api/listings/:id/requests: the new-request subject has no raw CR/LF and keeps the readable title", async () => {
    const sent = installFakeEmail();
    const ownerId = await insertOwner();
    const now = Date.now();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE id = ?")
      .bind("giver@keepsake.ing", now, ownerId)
      .run();
    // Inserted directly into D1 to bypass `TitleSchema` — a pre-existing row
    // written before the schema's control-character check landed.
    const listingId = await insertApprovedListing({ ownerId, title: DIRTY_TITLE });

    const res = await SELF.fetch(`http://x/api/listings/${listingId}/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
      body: JSON.stringify({
        note: "This would mean so much, thank you for considering us.",
        email: "requester@keepsake.ing",
        date_of_birth: "1990-01-01",
      }),
    });
    expect(res.status).toBe(201);

    // Two sends: the giver's new-request notification (subject under test
    // below), then the requester's own "we passed your note along"
    // confirmation — see requests.test.ts's happy-path test for the full
    // rationale.
    expect(sent).toHaveLength(2);
    const subject = sent[0]?.subject ?? "";
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toContain("Grandma's");
    expect(subject).toContain("letters");
    expect(subject).toContain("from");
    expect(subject).toContain("the war");
  });

  it("POST /api/me/listings/:id/choose: the chosen subject has no raw CR/LF and keeps the readable title", async () => {
    const sent = installFakeEmail();
    const token = freshOwnerToken();
    const ownerId = await insertOwner();
    // `insertOwner` doesn't attach `token_hash` to `token` itself; hash and
    // attach it here so the choose route's `ownerAuth()` accepts `token`.
    await env.DB.prepare("UPDATE owners SET token_hash = ? WHERE id = ?").bind(await sha256Hex(token), ownerId).run();
    const listingId = await insertApprovedListing({ ownerId, title: DIRTY_TITLE });
    const requestId = await insertOpenRequest(listingId, "chosen-me@keepsake.ing");

    const res = await SELF.fetch(`http://x/api/me/listings/${listingId}/choose`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, handoff_note: "I'll leave it on the porch Saturday morning." }),
    });
    expect(res.status).toBe(200);

    expect(sent).toHaveLength(1);
    const subject = sent[0]?.subject ?? "";
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toContain("Grandma's");
    expect(subject).toContain("letters");
    expect(subject).toContain("from");
    expect(subject).toContain("the war");
  });

  it("sanitizeSubject collapses control characters (CR, LF, CRLF) to spaces and trims", () => {
    expect(sanitizeSubject('Someone would love "' + DIRTY_TITLE + '"')).toBe('Someone would love "Grandma\'s letters from the war"');
    expect(sanitizeSubject("\ntrim me\r")).toBe("trim me");
  });
});

describe("re-submitting an already verified address", () => {
  it("stays verified and sends nothing", async () => {
    const mail = installFakeEmail();
    try {
      const token = freshOwnerToken();
      await uploadPhoto({ token });
      const auth = authHeaders(token);
      const body = (email: string) => ({
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      await SELF.fetch("https://x/api/me/email", body("owner@keepsake.ing"));
      const tokenHash = await sha256Hex(token);
      await env.DB.prepare("UPDATE owners SET email_verified_at = ? WHERE token_hash = ?")
        .bind(Date.now(), tokenHash)
        .run();

      const sentBefore = mail.length;
      const again = await SELF.fetch("https://x/api/me/email", body("owner@keepsake.ing"));
      const parsed = OwnerMe.safeParse((await again.json<{ data: unknown }>()).data);

      expect(parsed.success).toBe(true);
      expect(parsed.data?.email_verified, "must not drop back to unverified").toBe(true);
      expect(mail.length, "must not send a second verification").toBe(sentBefore);
    } finally {
      removeFakeEmail();
    }
  });
});

/**
 * Issue #6. The failure this issue is about is invisible from the inside: a
 * Cloudflare Email binding that refuses every non-verified destination
 * produces exactly the same `{sent: false}` as a typo'd address, and the
 * give/request/choose flow reports success either way. What separates them
 * is the provider's own sentence — which `sendViaCloudflare` used to fold
 * into the reason code and truncate at 160 chars.
 *
 * These call `sendMail` directly rather than through a route: the property
 * under test is the split itself (a stable code out to the product, the raw
 * text out to the diagnostic surfaces), and every route is a consumer of it.
 */
describe("sendMail failure reporting", () => {
  afterEach(() => removeFakeEmail());

  function installThrowingEmail(errorMessage: string): void {
    (env as unknown as Record<string, unknown>).EMAIL = {
      send: async (): Promise<never> => {
        throw new Error(errorMessage);
      },
    };
  }

  const REFUSAL =
    "destination address not verified: recipient@gmail.com is not a verified destination address for this Email Routing zone";

  function testMessage(to: string): Parameters<typeof sendMail>[1] {
    return { kind: "new_request", to, subject: "s", html: "<p>h</p>", text: "t" };
  }

  it("returns the provider's raw text as `detail` and keeps `reason` a stable code", async () => {
    installThrowingEmail(REFUSAL);
    const result = await sendMail(env as unknown as Env, testMessage("recipient@gmail.com"));

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("send_failed");
    expect(result.detail).toBe(REFUSAL);
  });

  /**
   * The reason code is what `requests.notify_failed_reason` stores and what
   * the 7-day rollup groups on. If the provider's sentence leaks into it, two
   * things break at once: a column one boolean away from the giver's screen
   * starts carrying raw provider output, and — because that sentence names
   * the recipient — every failure lands in its own group, so a blanket
   * refusal fragments into single-count rows and stops reading as a pattern.
   */
  it("never lets the provider's sentence into the reason code", async () => {
    installThrowingEmail(REFUSAL);
    const result = await sendMail(env as unknown as Env, testMessage("recipient@gmail.com"));

    expect(result.reason).not.toContain("not a verified destination");
    expect(result.reason).not.toContain("recipient@gmail.com");

    // Stable enough to group on: a second failure worded completely
    // differently must still produce the same code, and still keep its own
    // detail.
    installThrowingEmail("552 5.2.2 mailbox full");
    const second = await sendMail(env as unknown as Env, testMessage("other@gmail.com"));
    expect(second.reason).toBe(result.reason);
    expect(second.detail).not.toBe(result.detail);
  });

  it("writes the code, the raw detail and the recipient's domain to email_events", async () => {
    installThrowingEmail(REFUSAL);
    const result = await sendMail(env as unknown as Env, testMessage("Recipient@GMAIL.com"));

    expect(result.eventId).toBeTruthy();
    const row = await env.DB.prepare("SELECT error, error_detail, to_domain, to_hash, ok FROM email_events WHERE id = ?")
      .bind(result.eventId as string)
      .first<{ error: string | null; error_detail: string | null; to_domain: string | null; to_hash: string; ok: number }>();

    expect(row?.ok).toBe(0);
    expect(row?.error).toBe("send_failed");
    expect(row?.error_detail).toBe(REFUSAL);
    // Lowercased, and the domain only — `to_hash` stays the one column that
    // identifies *who* was mailed.
    expect(row?.to_domain).toBe("gmail.com");
    expect(row?.to_hash).not.toContain("@");
  });

  it("records the domain on a successful send too, so a failure ratio has a denominator", async () => {
    installFakeEmail();
    const result = await sendMail(env as unknown as Env, testMessage("someone@fastmail.com"));

    expect(result.sent).toBe(true);
    const row = await env.DB.prepare("SELECT ok, to_domain, error_detail FROM email_events WHERE id = ?")
      .bind(result.eventId as string)
      .first<{ ok: number; to_domain: string | null; error_detail: string | null }>();
    expect(row?.ok).toBe(1);
    expect(row?.to_domain).toBe("fastmail.com");
    expect(row?.error_detail).toBeNull();
  });
});

describe("recipientDomain", () => {
  it("lowercases and takes the last @-segment", () => {
    expect(recipientDomain("Someone+Tag@Example.COM")).toBe("example.com");
  });

  it("returns null for an address with no domain to speak of", () => {
    expect(recipientDomain("not-an-email")).toBeNull();
    expect(recipientDomain("trailing@")).toBeNull();
  });
});
