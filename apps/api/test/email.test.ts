import { guardRecipient } from "../src/email/sendMail.js";
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import {
  authHeaders,
  freshOwnerToken,
  installFakeEmail,
  readOk,
  removeFakeEmail,
  seedStandardPostalCodes,
  uploadPhoto,
} from "./helpers.js";
import { randomTokenRaw } from "../src/lib/tokens.js";
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
      body: JSON.stringify({ email: "owner@example.com" }),
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("owner@example.com");

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
        email: "on-create@example.com",
      }),
    });
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("on-create@example.com");
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
      body: JSON.stringify({ email: "nobody-here@example.com" }),
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
      .bind("recover-me@example.com", now, await sha256Hex(oldToken))
      .run();

    const recoverRes = await SELF.fetch("http://x/api/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "recover-me@example.com" }),
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
});

// ---------------------------------------------------------------------------
// Recipient guard. Cloudflare scores the sending domain on bounce rate (safe
// under 2%), and this repo carries 80 `@example.com` fixtures, so the guard is
// the thing that keeps a stray test run from burning keepsake.ing.
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
