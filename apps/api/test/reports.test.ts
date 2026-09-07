import { env, SELF } from "cloudflare:test";
import * as Capture from "@keepsake/observability/capture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshClientIp, insertApprovedListing, insertOwner, readErr, readOk } from "./helpers.js";

async function report(listingId: string, clientIp: string, reason = "not_a_keepsake"): Promise<Response> {
  return SELF.fetch(`http://x/api/listings/${listingId}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
    body: JSON.stringify({ reason }),
  });
}

describe("POST /api/listings/:id/reports", () => {
  it("409s a second report from the same address on the same day", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const ip = freshClientIp();

    const first = await report(listingId, ip);
    expect(first.status).toBe(201);

    const second = await report(listingId, ip);
    expect(second.status).toBe(409);
    const error = await readErr(second);
    expect(error.code).toBe("conflict");
  });

  it("hides the listing once report_count reaches REPORT_AUTOHIDE_THRESHOLD (3), from three distinct addresses", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const first = await readOk<{ id: string }>(await report(listingId, freshClientIp()));
    expect(first.id).toBeTruthy();
    await report(listingId, freshClientIp());

    let row = await env.DB.prepare("SELECT status, report_count FROM listings WHERE id = ?")
      .bind(listingId)
      .first<{ status: string; report_count: number }>();
    expect(row?.status).toBe("approved");
    expect(row?.report_count).toBe(2);

    const third = await report(listingId, freshClientIp());
    expect(third.status).toBe(201);

    row = await env.DB.prepare("SELECT status, report_count FROM listings WHERE id = ?")
      .bind(listingId)
      .first<{ status: string; report_count: number }>();
    expect(row?.report_count).toBe(3);
    expect(row?.status).toBe("hidden");

    const event = await env.DB.prepare(
      "SELECT kind, verdict FROM moderation_events WHERE listing_id = ? AND kind = 'report_autohide'",
    )
      .bind(listingId)
      .first<{ kind: string; verdict: string }>();
    expect(event?.verdict).toBe("hidden");
  });

  it("404s a pending listing (not yet public, so not reportable)", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    await env.DB.prepare("UPDATE listings SET status = 'pending' WHERE id = ?").bind(listingId).run();

    const res = await report(listingId, freshClientIp());
    expect(res.status).toBe(404);
  });

  describe("capture notification on autohide", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("calls captureMessage once the threshold hides the listing", async () => {
      const captureMessageSpy = vi.spyOn(Capture, "captureMessage");
      const ownerId = await insertOwner();
      const listingId = await insertApprovedListing({ ownerId });

      await report(listingId, freshClientIp());
      await report(listingId, freshClientIp());
      expect(captureMessageSpy).not.toHaveBeenCalled();

      const third = await report(listingId, freshClientIp());
      expect(third.status).toBe(201);

      expect(captureMessageSpy).toHaveBeenCalledTimes(1);
      const [message] = captureMessageSpy.mock.calls[0] ?? [];
      expect(message).toContain(listingId);
      expect(message).toContain("auto-hidden");
    });
  });
});
