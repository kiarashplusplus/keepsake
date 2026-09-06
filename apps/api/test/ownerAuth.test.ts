import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/lib/digest.js";
import { ulid } from "../src/lib/ids.js";
import { authHeaders, freshOwnerToken, readErr } from "./helpers.js";

/**
 * `ownerAuth` (src/middleware/ownerAuth.ts) already 403s a banned owner on
 * every route it guards — this pins that behavior with a direct test rather
 * than only relying on the admin-ban test to notice a regression here
 * indirectly. Per the plan's M4 DoD: "banned owner gets 403 everywhere," not
 * just on the one route a ban action happens to touch first.
 */
describe("ownerAuth: a banned owner is forbidden on every owner route", () => {
  async function insertBannedOwner(): Promise<string> {
    const token = freshOwnerToken();
    const tokenHash = await sha256Hex(token);
    const id = ulid();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO owners (id, token_hash, banned_at, ban_reason, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, tokenHash, now, "spam", now, now)
      .run();
    return token;
  }

  it("403s GET /api/me", async () => {
    const token = await insertBannedOwner();
    const res = await SELF.fetch("http://x/api/me", { headers: authHeaders(token) });
    expect(res.status).toBe(403);
    const error = await readErr(res);
    expect(error.code).toBe("forbidden");
  });

  it("403s GET /api/me/listings", async () => {
    const token = await insertBannedOwner();
    const res = await SELF.fetch("http://x/api/me/listings", { headers: authHeaders(token) });
    expect(res.status).toBe(403);
  });

  it("403s PUT /api/photos (would-be first write from a banned token)", async () => {
    const token = await insertBannedOwner();
    const form = new FormData();
    const res = await SELF.fetch("http://x/api/photos", {
      method: "PUT",
      headers: authHeaders(token),
      body: form,
    });
    expect(res.status).toBe(403);
  });
});
