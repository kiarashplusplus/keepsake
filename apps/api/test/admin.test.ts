import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { FeedPage } from "@keepsake/contracts/feed";
import type { AdminHealth, AdminQueueItem, AdminStats, AdminTestEmailResult } from "@keepsake/contracts/admin";
import type { OwnerMe } from "@keepsake/contracts/owner";
import { todayISO } from "../src/lib/day.js";
import { sha256Hex } from "../src/lib/digest.js";
import { ulid } from "../src/lib/ids.js";
import {
  authHeaders,
  freshOwnerToken,
  insertApprovedListing,
  insertOwner,
  installFakeEmail,
  readErr,
  readOk,
  removeFakeEmail,
  seedStandardPostalCodes,
  setTestEnvVar,
} from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-abcdef0123456789";

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

async function setListingStatus(listingId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE listings SET status = ? WHERE id = ?").bind(status, listingId).run();
}

async function insertModerationEvent(listingId: string, fields: Partial<{ kind: string; verdict: string; reason: string | null; flags_json: string | null; model: string | null }> = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO moderation_events (id, listing_id, listing_version, kind, model, verdict, flags_json, reason, attempt, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(ulid(), listingId, fields.kind ?? "decision", fields.model ?? null, fields.verdict ?? "needs_review", fields.flags_json ?? null, fields.reason ?? "held_for_review", Date.now())
    .run();
}

async function insertReport(listingId: string, reason = "spam"): Promise<void> {
  await env.DB.prepare("INSERT INTO reports (id, listing_id, reason, ip_digest, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(ulid(), listingId, reason, `test-digest-${ulid()}`, Date.now())
    .run();
  await env.DB.prepare("UPDATE listings SET report_count = report_count + 1 WHERE id = ?").bind(listingId).run();
}

describe("admin routes", () => {
  afterEach(() => setTestEnvVar("ADMIN_TOKEN", ""));

  describe("GET /api/admin/queue", () => {
    it("lists needs_review listings with events and a masked owner email", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      await env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = ? WHERE id = ?")
        .bind("giver@keepsake.ing", Date.now(), ownerId)
        .run();
      const listingId = await insertApprovedListing({ ownerId, title: "Held for review" });
      await setListingStatus(listingId, "needs_review");
      await insertModerationEvent(listingId, { kind: "decision", verdict: "needs_review", reason: "held_for_review" });
      await insertReport(listingId, "personal_info");

      const res = await SELF.fetch("http://x/api/admin/queue?status=needs_review", { headers: adminHeaders() });
      expect(res.status).toBe(200);
      const page = await readOk<FeedPage<AdminQueueItem>>(res);
      expect(page.items).toHaveLength(1);
      const item = page.items[0];
      expect(item?.id).toBe(listingId);
      expect(item?.status).toBe("needs_review");
      expect(item?.owner.email_masked).toBe("g•••@keepsake.ing");
      expect(item?.owner.email_verified).toBe(true);
      expect(item?.owner.banned).toBe(false);
      expect(item?.report_count).toBe(1);
      expect(item?.events).toHaveLength(1);
      expect(item?.events[0]?.verdict).toBe("needs_review");
      expect(item?.events[0]?.reason).toBe("held_for_review");
      expect(item?.reports).toHaveLength(1);
      expect(item?.reports[0]?.reason).toBe("personal_info");
    });

    it("does not list an approved listing under status=needs_review", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      // D1 storage in this test runtime is shared across every `it` in a
      // file (only isolated per file, not per test) — so this asserts the
      // one listing just inserted here is absent, rather than asserting the
      // whole `needs_review` queue is empty, which other tests in this file
      // legitimately populate.
      const approvedListingId = await insertApprovedListing({ ownerId });

      const res = await SELF.fetch("http://x/api/admin/queue?status=needs_review", { headers: adminHeaders() });
      const page = await readOk<FeedPage<AdminQueueItem>>(res);
      expect(page.items.some((item) => item.id === approvedListingId)).toBe(false);
    });
  });

  describe("POST /api/admin/listings/:id/approve", () => {
    it("moves needs_review -> approved, sets published_at, and logs an admin/approved event", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });
      await env.DB.prepare("UPDATE listings SET status = 'needs_review', published_at = NULL WHERE id = ?").bind(listingId).run();

      const res = await SELF.fetch(`http://x/api/admin/listings/${listingId}/approve`, { method: "POST", headers: adminHeaders() });
      expect(res.status).toBe(200);

      const row = await env.DB.prepare("SELECT status, published_at FROM listings WHERE id = ?").bind(listingId).first<{ status: string; published_at: number | null }>();
      expect(row?.status).toBe("approved");
      expect(row?.published_at).not.toBeNull();

      const event = await env.DB.prepare("SELECT kind, verdict FROM moderation_events WHERE listing_id = ? AND kind = 'admin' ORDER BY created_at DESC LIMIT 1")
        .bind(listingId)
        .first<{ kind: string; verdict: string }>();
      expect(event?.verdict).toBe("approved");
    });

    it("409s approving a listing that's already approved", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });

      const res = await SELF.fetch(`http://x/api/admin/listings/${listingId}/approve`, { method: "POST", headers: adminHeaders() });
      expect(res.status).toBe(409);
      const error = await readErr(res);
      expect(error.code).toBe("conflict");
    });

    it("404s an unknown listing id", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const res = await SELF.fetch(`http://x/api/admin/listings/${ulid()}/approve`, { method: "POST", headers: adminHeaders() });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/admin/listings/:id/hide", () => {
    it("hides an approved listing with an optional reason, logging admin/hidden", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });

      const res = await SELF.fetch(`http://x/api/admin/listings/${listingId}/hide`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ reason: "reported photo looked staged" }),
      });
      expect(res.status).toBe(200);

      const row = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(listingId).first<{ status: string }>();
      expect(row?.status).toBe("hidden");

      const event = await env.DB.prepare("SELECT verdict, reason FROM moderation_events WHERE listing_id = ? AND kind = 'admin' ORDER BY created_at DESC LIMIT 1")
        .bind(listingId)
        .first<{ verdict: string; reason: string | null }>();
      expect(event?.verdict).toBe("hidden");
      expect(event?.reason).toBe("reported photo looked staged");
    });
  });

  describe("POST /api/admin/listings/:id/restore", () => {
    it("restores hidden -> approved and resets report_count to 0", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });
      await env.DB.prepare("UPDATE listings SET status = 'hidden', report_count = 5 WHERE id = ?").bind(listingId).run();

      const res = await SELF.fetch(`http://x/api/admin/listings/${listingId}/restore`, { method: "POST", headers: adminHeaders() });
      expect(res.status).toBe(200);

      const row = await env.DB.prepare("SELECT status, report_count FROM listings WHERE id = ?").bind(listingId).first<{ status: string; report_count: number }>();
      expect(row?.status).toBe("approved");
      expect(row?.report_count).toBe(0);

      const event = await env.DB.prepare("SELECT verdict FROM moderation_events WHERE listing_id = ? AND kind = 'admin' ORDER BY created_at DESC LIMIT 1")
        .bind(listingId)
        .first<{ verdict: string }>();
      expect(event?.verdict).toBe("restored");
    });

    it("409s restoring a listing that isn't hidden", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });

      const res = await SELF.fetch(`http://x/api/admin/listings/${listingId}/restore`, { method: "POST", headers: adminHeaders() });
      expect(res.status).toBe(409);
    });
  });

  describe("POST /api/admin/listings/:id/reject", () => {
    it("rejects a held listing with a valid reason, storing moderation_reason and logging admin/rejected", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });
      await setListingStatus(listingId, "needs_review");

      const res = await SELF.fetch(`http://x/api/admin/listings/${listingId}/reject`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ reason: "not_an_object" }),
      });
      expect(res.status).toBe(200);

      const row = await env.DB.prepare("SELECT status, moderation_reason FROM listings WHERE id = ?").bind(listingId).first<{ status: string; moderation_reason: string | null }>();
      expect(row?.status).toBe("rejected");
      expect(row?.moderation_reason).toBe("not_an_object");

      const event = await env.DB.prepare("SELECT verdict, reason FROM moderation_events WHERE listing_id = ? AND kind = 'admin' ORDER BY created_at DESC LIMIT 1")
        .bind(listingId)
        .first<{ verdict: string; reason: string | null }>();
      expect(event?.verdict).toBe("rejected");
      expect(event?.reason).toBe("not_an_object");
    });

    it("400s an internal-only reason like 'budget' (not a real rejection reason)", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });

      const res = await SELF.fetch(`http://x/api/admin/listings/${listingId}/reject`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ reason: "budget" }),
      });
      expect(res.status).toBe(400);
      const error = await readErr(res);
      expect(error.code).toBe("bad_request");
    });
  });

  describe("POST /api/admin/owners/:id/{ban,unban}", () => {
    it("hides every non-given listing, leaves given ones alone, and 403s the owner on /api/me", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      // A real bearer token, hashed the same way `ownerAuth` hashes one, so
      // /api/me can be checked before and after the ban with a working
      // credential rather than a synthetic owner id.
      const token = freshOwnerToken();
      const tokenHash = await sha256Hex(token);
      const ownerId = ulid();
      const now = Date.now();
      await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
        .bind(ownerId, tokenHash, now, now)
        .run();

      const liveListingId = await insertApprovedListing({ ownerId, title: "Still live" });
      const givenListingId = await insertApprovedListing({ ownerId, title: "Already given" });
      await env.DB.prepare("UPDATE listings SET status = 'given', given_at = ? WHERE id = ?").bind(Date.now(), givenListingId).run();

      const banRes = await SELF.fetch(`http://x/api/admin/owners/${ownerId}/ban`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ reason: "repeated spam listings" }),
      });
      expect(banRes.status).toBe(200);
      const banBody = await readOk<{ id: string; banned: boolean; hidden_listings: number }>(banRes);
      expect(banBody.banned).toBe(true);
      expect(banBody.hidden_listings).toBe(1);

      const liveRow = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(liveListingId).first<{ status: string }>();
      expect(liveRow?.status).toBe("hidden");
      const givenRow = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(givenListingId).first<{ status: string }>();
      expect(givenRow?.status).toBe("given");

      const hideEvent = await env.DB.prepare("SELECT reason FROM moderation_events WHERE listing_id = ? AND kind = 'admin' ORDER BY created_at DESC LIMIT 1")
        .bind(liveListingId)
        .first<{ reason: string | null }>();
      expect(hideEvent?.reason).toBe("owner_banned");

      const meAfterBan = await SELF.fetch("http://x/api/me", { headers: authHeaders(token) });
      expect(meAfterBan.status).toBe(403);

      const unbanRes = await SELF.fetch(`http://x/api/admin/owners/${ownerId}/unban`, { method: "POST", headers: adminHeaders() });
      expect(unbanRes.status).toBe(200);
      const unbanBody = await readOk<{ id: string; banned: boolean }>(unbanRes);
      expect(unbanBody.banned).toBe(false);

      const meAfterUnban = await SELF.fetch("http://x/api/me", { headers: authHeaders(token) });
      expect(meAfterUnban.status).toBe(200);
      const me = await readOk<OwnerMe>(meAfterUnban);
      expect(me.banned).toBe(false);

      // Unban reverses the ban only — the listing the ban hid stays hidden
      // until an admin restores it individually.
      const liveRowAfterUnban = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(liveListingId).first<{ status: string }>();
      expect(liveRowAfterUnban?.status).toBe("hidden");
    });

    it("404s banning an unknown owner id", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const res = await SELF.fetch(`http://x/api/admin/owners/${ulid()}/ban`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/admin/stats", () => {
    it("reports listing counts by status, requests today, email failures today, and today's AI budget usage", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const ownerId = await insertOwner();
      await insertApprovedListing({ ownerId });
      const heldId = await insertApprovedListing({ ownerId });
      await setListingStatus(heldId, "needs_review");

      await env.DB.prepare("INSERT INTO requests (id, listing_id, note, email, ip_digest, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)")
        .bind(ulid(), heldId, "I would love this, thank you.", "someone@keepsake.ing", "digest", Date.now())
        .run();
      await env.DB.prepare("INSERT INTO email_events (id, kind, to_hash, provider, ok, error, created_at) VALUES (?, 'new_request', 'hash', 'cf', 0, 'send_failed', ?)")
        .bind(ulid(), Date.now())
        .run();

      await env.KV.put(`budget:mod_text:${todayISO()}`, "42");
      await env.KV.put(`budget:mod_image:${todayISO()}`, "7");

      const res = await SELF.fetch("http://x/api/admin/stats", { headers: adminHeaders() });
      expect(res.status).toBe(200);
      const stats = await readOk<AdminStats>(res);
      expect(stats.listings_by_status.approved).toBeGreaterThanOrEqual(1);
      expect(stats.listings_by_status.needs_review).toBeGreaterThanOrEqual(1);
      expect(stats.requests_today).toBeGreaterThanOrEqual(1);
      expect(stats.email_failures_today).toBeGreaterThanOrEqual(1);
      expect(stats.ai_budget_used_today.mod_text).toBe(42);
      expect(stats.ai_budget_used_today.mod_image).toBe(7);
    });
  });

  describe("GET /api/admin/health", () => {
    // Runs before the "seeds postal codes" test below on purpose: D1 storage
    // in this test runtime is shared across every `it` in a file, so an
    // empty-table assertion has to run before anything else in the file
    // seeds `postal_codes` — nothing earlier in this file touches that
    // table, which is what makes the ordering safe rather than accidental.
    it("warns (ok: false) when postal_codes is empty", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const res = await SELF.fetch("http://x/api/admin/health", { headers: adminHeaders() });
      const health = await readOk<AdminHealth>(res);
      expect(health.ok).toBe(false);
      expect(health.postal_codes_count).toBe(0);
      expect(health.cron_last_run.orphanSweep).toBeNull();
      expect(health.cron_last_run.moderationRetry).toBeNull();
    });

    it("reports the postal_codes count and cron last-run timestamps once seeded", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      await seedStandardPostalCodes();
      await env.KV.put("cron:last:orphanSweep", String(Date.now()));
      await env.KV.put("cron:last:moderationRetry", String(Date.now()));

      const res = await SELF.fetch("http://x/api/admin/health", { headers: adminHeaders() });
      expect(res.status).toBe(200);
      const health = await readOk<AdminHealth>(res);
      expect(health.ok).toBe(true);
      expect(health.postal_codes_count).toBeGreaterThan(0);
      expect(typeof health.cron_last_run.orphanSweep).toBe("number");
      expect(typeof health.cron_last_run.moderationRetry).toBe("number");
    });

    // Launch audit finding 12: the heartbeats were written correctly, read
    // correctly, and then ignored — `ok` came from `postal_codes_count > 0`
    // alone, so a cron that stopped a month ago still reported `ok: true`
    // with a month-old timestamp sitting right next to it. The test above is
    // the control: same seeded postal codes, same endpoint, fresh heartbeats,
    // `ok: true`. Only the age of one KV value differs here.
    it("is not ok when a cron heartbeat has gone stale", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      await seedStandardPostalCodes();
      await env.KV.put("cron:last:moderationRetry", String(Date.now()));
      // orphanSweep is nightly and allowed 26 hours; three days is dead.
      const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
      await env.KV.put("cron:last:orphanSweep", String(threeDaysAgo));

      const res = await SELF.fetch("http://x/api/admin/health", { headers: adminHeaders() });
      const health = await readOk<AdminHealth>(res);
      expect(health.postal_codes_count).toBeGreaterThan(0);
      expect(health.ok).toBe(false);
      // The stale timestamp is still reported, not hidden — the admin page
      // needs to show *when* it stopped, not just that something is wrong.
      expect(health.cron_last_run.orphanSweep).toBe(threeDaysAgo);
    });

    it("is not ok when moderationRetry has gone quiet, even with a fresh nightly sweep", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      await seedStandardPostalCodes();
      await env.KV.put("cron:last:orphanSweep", String(Date.now()));
      // Every 5 minutes, allowed 30. An hour of silence means listings are
      // stranded in `pending` and nothing is going public.
      await env.KV.put("cron:last:moderationRetry", String(Date.now() - 60 * 60 * 1000));

      const res = await SELF.fetch("http://x/api/admin/health", { headers: adminHeaders() });
      const health = await readOk<AdminHealth>(res);
      expect(health.ok).toBe(false);
    });
  });

  // Launch-audit finding: email failures are invisible, and production has
  // never delivered to anyone but Kiarash. This endpoint sends a real
  // message through the real sendMail() path and reports back exactly what
  // happened, so delivery is verifiable on demand.
  describe("POST /api/admin/test-email", () => {
    afterEach(() => {
      removeFakeEmail();
      // Every other test file in this suite relies on `EMAIL_MODE: "test"`
      // (set in vitest.config.ts) short-circuiting `guardRecipient` entirely
      // — restore it after the one test below that deliberately overrides
      // it to exercise the real reserved-domain guard.
      setTestEnvVar("EMAIL_MODE", "test");
    });

    it("sends a real message and reports sent:true", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      const sent = installFakeEmail();

      const res = await SELF.fetch("http://x/api/admin/test-email", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ to: "leapkg@gmail.com" }),
      });
      expect(res.status).toBe(200);
      const result = await readOk<AdminTestEmailResult>(res);
      expect(result.sent).toBe(true);
      expect(result.reason).toBeNull();

      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe("leapkg@gmail.com");
      expect(sent[0]?.subject).toContain("Keepsake test email");

      const emailEvent = await env.DB.prepare(
        "SELECT kind, ok FROM email_events WHERE kind = 'admin_test' ORDER BY created_at DESC LIMIT 1",
      ).first<{ kind: string; ok: number }>();
      expect(emailEvent?.ok).toBe(1);
    });

    it("reports sent:false with the real reason when EMAIL_MODE is off, rather than pretending it worked", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
      // `EMAIL_MODE: "test"` (the suite-wide default) short-circuits every
      // guard, on purpose, so the rest of the suite can use `@example.com`
      // fixtures freely — override it here to exercise the real guard this
      // test is actually about: an address `AdminTestEmailInput` accepts
      // (unlike a reserved domain, which 400s before this route ever runs)
      // but that `sendMail`'s own `guardRecipient` still refuses.
      setTestEnvVar("EMAIL_MODE", "off");
      installFakeEmail();

      const res = await SELF.fetch("http://x/api/admin/test-email", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ to: "leapkg@gmail.com" }),
      });
      expect(res.status).toBe(200);
      const result = await readOk<AdminTestEmailResult>(res);
      expect(result.sent).toBe(false);
      expect(result.reason).toBe("blocked_email_mode_off");

      const emailEvent = await env.DB.prepare(
        "SELECT ok, error FROM email_events WHERE kind = 'admin_test' ORDER BY created_at DESC LIMIT 1",
      ).first<{ ok: number; error: string | null }>();
      expect(emailEvent?.ok).toBe(0);
      expect(emailEvent?.error).toBe("blocked_email_mode_off");
    });

    it("401s without a valid admin token, same as every other /api/admin/* route", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);

      const res = await SELF.fetch("http://x/api/admin/test-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "leapkg@gmail.com" }),
      });
      expect(res.status).toBe(401);
    });

    it("400s a malformed address", async () => {
      setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);

      const res = await SELF.fetch("http://x/api/admin/test-email", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ to: "not-an-email" }),
      });
      expect(res.status).toBe(400);
    });
  });
});
