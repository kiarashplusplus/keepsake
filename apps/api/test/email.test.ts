import { OwnerMe } from "@keepsake/contracts/owner";
import { guardRecipient, recipientDomain, sendMail } from "../src/email/sendMail.js";
import type { Env } from "../src/env.js";
import { sanitizeSubject } from "../src/email/templates/shared.js";
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  // Issue #167. The move none of the cases above makes: change the address
  // *between* mint and redeem. The token's only subject used to be
  // `owner_id`, so clicking the first link stamped "verified" on whatever
  // address was on the row at click time — an address nobody at that address
  // ever confirmed. A typo corrected before clicking is enough to do it; the
  // adversarial version attaches a stranger's inbox and then collects
  // recovery links, requesters' private notes, and the giver's own address.
  it("refuses a link mailed to an address that is no longer on the row, and never marks the new one verified", async () => {
    const sent = installFakeEmail();
    const token = freshOwnerToken();
    await uploadPhoto({ token });

    // 1. First address — link L1 lands in *this* inbox and is left unclicked.
    const first = await SELF.fetch("http://x/api/me/email", {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "typo@keepsake.ing" }),
    });
    expect(first.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("typo@keepsake.ing");
    const staleLink = sent[0]?.text.match(/https?:\/\/\S+/)?.[0];
    expect(staleLink).toBeTruthy();

    // 2. Corrected address. Nothing at `corrected@` has confirmed anything.
    const second = await SELF.fetch("http://x/api/me/email", {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "corrected@keepsake.ing" }),
    });
    expect(second.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.to).toBe("corrected@keepsake.ing");

    // 3. Click L1 out of the first inbox.
    const staleRes = await SELF.fetch(staleLink as string, { redirect: "manual" });
    expect(staleRes.status).toBe(302);
    expect(staleRes.headers.get("Location")).toBe("http://localhost:8787/mine?verified=0&reason=invalid");

    // The assertion that matters is the row, not the redirect: `corrected@`
    // must still be unverified, because nobody there confirmed it.
    const me = await readOk<{ email: string; email_verified: boolean }>(
      await SELF.fetch("http://x/api/me", { headers: authHeaders(token) }),
    );
    expect(me.email).toBe("corrected@keepsake.ing");
    expect(me.email_verified).toBe(false);

    // And the stale link is burned, not merely refused this once.
    const replay = await SELF.fetch(staleLink as string, { redirect: "manual" });
    expect(replay.headers.get("Location")).toBe("http://localhost:8787/mine?verified=0&reason=invalid");

    // The link that was actually mailed to the current address still works —
    // this is a fix, not a padlock on the whole flow.
    const goodLink = sent[1]?.text.match(/https?:\/\/\S+/)?.[0];
    const goodRes = await SELF.fetch(goodLink as string, { redirect: "manual" });
    expect(goodRes.headers.get("Location")).toBe("http://localhost:8787/mine?verified=1");
    const verified = await readOk<{ email_verified: boolean }>(await SELF.fetch("http://x/api/me", { headers: authHeaders(token) }));
    expect(verified.email_verified).toBe(true);
  });

  // The same fix from the other side: a token that predates the address
  // column (or was minted by `POST /api/listings`, which does not record
  // one) carries `email IS NULL`. It must still be refused once the address
  // has moved on — otherwise the migration only half-lands and every link
  // already in flight at deploy time keeps the old behaviour for 24 hours.
  it("refuses a NULL-address (legacy) verify token once the address has changed", async () => {
    const sent = installFakeEmail();
    const token = freshOwnerToken();
    const ownerId = await registerOwner(token);

    const now = Date.now();
    const rawToken = randomTokenRaw();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = NULL WHERE id = ?").bind("old@keepsake.ing", ownerId).run();
    // Exactly the shape `0001_init.sql` produced: no address on the row.
    await env.DB.prepare(
      `INSERT INTO recovery_tokens (id, owner_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, 'verify_email', ?, ?, ?)`,
    )
      .bind(ulid(), ownerId, await sha256Hex(rawToken), now + 60_000, now)
      .run();

    const changed = await SELF.fetch("http://x/api/me/email", {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@keepsake.ing" }),
    });
    expect(changed.status).toBe(200);
    expect(sent).toHaveLength(1);

    const res = await SELF.fetch(`http://x/api/me/email/verify?token=${rawToken}`, { redirect: "manual" });
    expect(res.headers.get("Location")).toBe("http://localhost:8787/mine?verified=0&reason=invalid");

    const me = await readOk<{ email_verified: boolean }>(await SELF.fetch("http://x/api/me", { headers: authHeaders(token) }));
    expect(me.email_verified).toBe(false);
  });

  // The read-side half of #167 on its own, with no help from the write-side
  // invalidation in `POST /api/me/email`. `POST /api/listings` also changes
  // `owners.email` and mints a verify token, and it does *not* invalidate
  // outstanding ones (that file is owned by another session on this branch).
  // So this drives the whole sequence through that route: two listings, two
  // addresses, then click the first link. Only `GET /email/verify`'s
  // "a newer verify_email token exists for this owner" rule can refuse it.
  it("refuses a superseded verify link even when nothing invalidated it on write (listing-create path)", async () => {
    const sent = installFakeEmail();
    await seedStandardPostalCodes();
    const token = freshOwnerToken();

    async function createListingWithEmail(email: string, title: string): Promise<void> {
      const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
      const res = await SELF.fetch("http://x/api/listings", {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          story: "This was my grandmother's favorite thing, and I'd love for it to find a new home.",
          category: "home_kitchen",
          country: "US",
          postal_code: "02144",
          photo_ids: [photo.id],
          email,
          date_of_birth: "1990-01-01",
        }),
      });
      expect(res.status).toBe(201);
    }

    await createListingWithEmail("first-typo@keepsake.ing", "A quiet teacup");
    expect(sent).toHaveLength(1);
    const staleLink = sent[0]?.text.match(/https?:\/\/\S+/)?.[0];
    expect(staleLink).toBeTruthy();

    await createListingWithEmail("second-correct@keepsake.ing", "A tin lunchbox");
    expect(sent).toHaveLength(2);

    // Neither token records an address (that route does not write one), so
    // this is the "newer token exists" rule alone doing the work.
    const staleRes = await SELF.fetch(staleLink as string, { redirect: "manual" });
    expect(staleRes.headers.get("Location")).toBe("http://localhost:8787/mine?verified=0&reason=invalid");

    const me = await readOk<{ email: string; email_verified: boolean }>(
      await SELF.fetch("http://x/api/me", { headers: authHeaders(token) }),
    );
    expect(me.email).toBe("second-correct@keepsake.ing");
    expect(me.email_verified).toBe(false);

    // The newest link — the one actually mailed to the address on file — works.
    const goodLink = sent[1]?.text.match(/https?:\/\/\S+/)?.[0];
    const goodRes = await SELF.fetch(goodLink as string, { redirect: "manual" });
    expect(goodRes.headers.get("Location")).toBe("http://localhost:8787/mine?verified=1");
  });

  // The write-side half of #167, asserted on the table rather than through
  // a redirect — `GET /email/verify` would refuse these links anyway, so a
  // route-level assertion could not tell the two halves apart. What this
  // pins is that changing or clearing the address leaves **no redeemable
  // verify_email row behind at all**: the invariant is true in the data, not
  // merely enforced on the way out. Anything auditing `recovery_tokens` for
  // live credentials depends on that.
  it("burns outstanding verify_email tokens the moment the address changes or is cleared", async () => {
    installFakeEmail();
    const token = freshOwnerToken();
    const ownerId = await registerOwner(token);

    const liveCount = async (): Promise<number> => {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM recovery_tokens WHERE owner_id = ? AND purpose = 'verify_email' AND used_at IS NULL",
      )
        .bind(ownerId)
        .first<{ n: number }>();
      return row?.n ?? -1;
    };

    const setEmail = async (email: string): Promise<void> => {
      const res = await SELF.fetch("http://x/api/me/email", {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      expect(res.status).toBe(200);
    };

    await setEmail("one@keepsake.ing");
    expect(await liveCount()).toBe(1);

    // Changing it leaves exactly the new link live — not two.
    await setEmail("two@keepsake.ing");
    expect(await liveCount()).toBe(1);

    // Resending to the same unverified address is also a change of link.
    await setEmail("two@keepsake.ing");
    expect(await liveCount()).toBe(1);

    // Removing the address leaves nothing redeemable at all.
    const del = await SELF.fetch("http://x/api/me/email", { method: "DELETE", headers: authHeaders(token) });
    expect(del.status).toBe(200);
    expect(await liveCount()).toBe(0);
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

describe("POST /api/recover + POST /api/recover/exchange", () => {
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

    const exchangeRes = await SELF.fetch("http://x/api/recover/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: recoverToken }),
    });
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
    const secondExchange = await SELF.fetch("http://x/api/recover/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: recoverToken }),
    });
    expect(secondExchange.status).toBe(401);
  });

  // Issue #182. Exchanging a recovery token rotates `owners.token_hash` —
  // full takeover of a giver's dashboard — and it used to travel as
  // `POST /api/recover/<token>`, a URL path segment. `index.ts`'s `onError`
  // wrote `path: c.req.path` into a bare `console.error` and into a
  // `captureException` tag, and Workers Logs keeps every line, so a giver
  // clicking their emailed link during any request that threw put a *live*
  // credential into a log store. The fix is the route shape, so what this
  // pins is the shape: there must be no way to put the token in a URL.
  it("refuses to exchange a token supplied as a URL path segment", async () => {
    const sent = installFakeEmail();
    const ownerToken = freshOwnerToken();
    await registerOwner(ownerToken);
    const now = Date.now();
    await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE token_hash = ?")
      .bind("path-shape@keepsake.ing", now, await sha256Hex(ownerToken))
      .run();

    const requested = await SELF.fetch("http://x/api/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "path-shape@keepsake.ing" }),
    });
    expect(requested.status).toBe(200);
    expect(sent).toHaveLength(1);
    const recoverToken = (sent[0]?.text.match(/https?:\/\/\S+\/recover\/\S+/)?.[0] as string).split("/recover/")[1];
    expect(recoverToken).toBeTruthy();

    // A real, live, unused token — the strongest form of the assertion,
    // since a bad token would 401 whatever the route shape was.
    const viaPath = await SELF.fetch(`http://x/api/recover/${recoverToken}`, { method: "POST" });
    expect(viaPath.status).toBe(404);

    // And it is still live afterwards, i.e. the 404 is "no such route", not
    // "the token got spent by the old handler".
    const viaBody = await SELF.fetch("http://x/api/recover/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: recoverToken }),
    });
    expect(viaBody.status).toBe(200);
  });

  // The other half of #182: whatever `onError` writes into a log field must
  // not be able to carry a caller's secret. It logs the matched route
  // *pattern* now, never the concrete path — a string this repo wrote rather
  // than one a caller supplied. Driven by making D1 throw, which is exactly
  // the "a D1 blip while a giver clicks their link" case the issue describes.
  it("logs the route pattern, not the request path, when a request throws", async () => {
    const secretish = "hQ2n0Xa9Vb7cD3eF5gH8iJ1kL4mN6oP0qR2sT4uV6wY";
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    const prepare = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("D1_ERROR: simulated 7403");
    });
    try {
      const res = await SELF.fetch("http://x/api/recover/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: secretish }),
      });
      expect(res.status).toBe(500);
    } finally {
      prepare.mockRestore();
      console.error = originalError;
    }

    const unhandled = logged.find((args) => args[0] === "unhandled error");
    expect(unhandled).toBeTruthy();
    const fields = (unhandled as unknown[])[1] as Record<string, unknown>;
    expect(fields.route).toBe("/api/recover/exchange");
    // The field that carried the token is gone entirely, not merely cleaned.
    expect(fields).not.toHaveProperty("path");
    expect(JSON.stringify(fields)).not.toContain(secretish);
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
      // Confirmed (#188) — an `open` request is by definition one whose
      // address has been proved.
      `INSERT INTO requests (id, listing_id, note, email, ip_digest, status, created_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
      .bind(id, listingId, "I would love this, thank you for considering me.", email, `test-digest-${freshClientIp()}`, Date.now(), Date.now())
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

    // Issue #188: the giver's notification is sent at confirmation, not at
    // submission, so the subject under test only exists after the requester
    // redeems the link mailed to them.
    const confirmToken = /\/confirm\/([A-Za-z0-9_-]+)/.exec(sent[0]?.text ?? "")?.[1];
    expect(confirmToken).toBeTruthy();
    const confirmed = await SELF.fetch("http://x/api/requests/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
      body: JSON.stringify({ token: confirmToken }),
    });
    expect(confirmed.status).toBe(200);

    // Three sends now: the "was this you?" confirmation, the giver's
    // new-request notification (subject under test below), and the
    // requester's "we passed your note along".
    expect(sent).toHaveLength(3);
    const subject = sent[1]?.subject ?? "";
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toContain("Grandma's");
    expect(subject).toContain("letters");
    expect(subject).toContain("from");
    expect(subject).toContain("the war");

    // The confirmation mail carries the same title to an address nobody has
    // verified yet, so it gets the same guarantee (#188 + #20).
    const confirmSubject = sent[0]?.subject ?? "";
    expect(confirmSubject).not.toMatch(/[\r\n]/);
    expect(confirmSubject).toContain("Grandma's");
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

  it("returns the provider's text as `detail`, recipient scrubbed, and keeps `reason` a stable code", async () => {
    installThrowingEmail(REFUSAL);
    const result = await sendMail(env as unknown as Env, testMessage("recipient@gmail.com"));

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("send_failed");
    // The sentence, whole — minus the identifier. #190.
    expect(result.detail).toBe(
      "destination address not verified: <recipient> is not a verified destination address for this Email Routing zone",
    );
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

  /**
   * Issue #190, and the assertion this test exists to have *inverted*.
   *
   * It used to read `expect(row?.error_detail).toBe(REFUSAL)` — two lines
   * above `expect(row?.to_hash).not.toContain("@")`. The suite was enforcing
   * that the recipient's plaintext address is stored in the same row whose
   * hash is defended immediately below it: not a gap in coverage, but
   * coverage pointed the wrong way, which is why it would survive an ordinary
   * review. Inverting it and watching it fail against the unmodified code was
   * the proof that the leak was real:
   *
   *     AssertionError: expected 'destination address not verified: rec…'
   *       not to contain 'recipient@gmail.com'
   *
   * The recipient here is `Recipient@GMAIL.com` while the provider quotes
   * `recipient@gmail.com`, so this also pins the case-insensitive match — a
   * provider echoing a normalised form must not slip past.
   */
  it("scrubs the recipient out of error_detail while keeping the diagnosis", async () => {
    installThrowingEmail(REFUSAL);
    const result = await sendMail(env as unknown as Env, testMessage("Recipient@GMAIL.com"));

    expect(result.eventId).toBeTruthy();
    const row = await env.DB.prepare("SELECT error, error_detail, to_domain, to_hash, ok FROM email_events WHERE id = ?")
      .bind(result.eventId as string)
      .first<{ error: string | null; error_detail: string | null; to_domain: string | null; to_hash: string; ok: number }>();

    expect(row?.ok).toBe(0);
    expect(row?.error).toBe("send_failed");

    // The address is gone — in any casing.
    expect(row?.error_detail ?? "").not.toContain("recipient@gmail.com");
    expect((row?.error_detail ?? "").toLowerCase()).not.toContain("recipient@gmail.com");
    expect(row?.error_detail ?? "").not.toContain("@gmail.com");

    // ...and the diagnosis is not. This is the half that would answer #6, so
    // "scrubbed" must not have quietly become "blanked".
    expect(row?.error_detail).toContain("<recipient>");
    expect(row?.error_detail).toContain("is not a verified destination address");

    // Lowercased, and the domain only — `to_hash` stays the one column that
    // identifies *who* was mailed.
    expect(row?.to_domain).toBe("gmail.com");
    expect(row?.to_hash).not.toContain("@");
  });

  /**
   * The backstop. If the provider quotes an address that is *not* the one we
   * sent to — a forwarding target, an envelope sender — step 1 of the scrub
   * cannot match it by string equality, and #170's `redactString` has to
   * catch it by shape. The domain survives on purpose: it names a mail
   * provider, not a person.
   */
  it("also scrubs an address the provider quotes that is not the recipient", async () => {
    installThrowingEmail("forwarding loop: someone-else@yahoo.com refused relay");
    const result = await sendMail(env as unknown as Env, testMessage("recipient@gmail.com"));

    expect(result.detail).not.toContain("someone-else@yahoo.com");
    expect(result.detail).toContain("@yahoo.com");
    expect(result.detail).toContain("refused relay");
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
