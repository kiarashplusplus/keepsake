import { describe, expect, it } from "vitest";
import {
  AdminHideInput,
  AdminQueueItem,
  AdminQueueQuery,
  AdminRejectInput,
  AdminTestEmailInput,
  AdminTestErrorInput,
  ImageVerdictSchema,
} from "../src/admin";

const base = {
  is_physical_object: true,
  nsfw: 0.1,
  violence: 0,
  weapons: 0,
  drugs: 0,
  hate_symbols: 0,
  personal_info: 0,
  notes: "looks fine",
};

describe("ImageVerdictSchema", () => {
  it("parses a well-formed verdict", () => {
    const result = ImageVerdictSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("rejects nsfw out of range", () => {
    const result = ImageVerdictSchema.safeParse({ ...base, nsfw: 1.5 });
    expect(result.success).toBe(false);
  });

  it("coerces numeric strings", () => {
    const result = ImageVerdictSchema.safeParse({ ...base, nsfw: "0.4" });
    expect(result.success).toBe(true);
    expect(result.data?.nsfw).toBe(0.4);
  });

  it("ignores unknown extra keys instead of failing", () => {
    const result = ImageVerdictSchema.safeParse({ ...base, extra_commentary: "chatty model" });
    expect(result.success).toBe(true);
  });
});

const ownerListingBase = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  title: "A quiet teacup",
  story: "This belonged to a dear friend of the family, and I'd love for it to find a new home.",
  category: "home_kitchen",
  place_name: "Somerville",
  admin1: "MA",
  country: "US",
  status: "needs_review",
  photos: [],
  published_at: 0,
  postal_code: "02144",
  moderation_reason: null,
  request_count: 0,
  chosen_request_id: null,
  version: 1,
  created_at: 1,
  updated_at: 1,
  held: true,
};

describe("AdminQueueItem", () => {
  it("parses OwnerListing fields plus the admin-only owner/events/reports context", () => {
    const result = AdminQueueItem.safeParse({
      ...ownerListingBase,
      report_count: 2,
      owner: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", email_masked: "j•••@example.com", email_verified: true, banned: false },
      events: [
        { kind: "decision", model: null, verdict: "needs_review", flags: null, reason: "held_for_review", attempt: 1, latency_ms: null, created_at: 1 },
      ],
      reports: [{ reason: "spam", details: null, created_at: 1 }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a queue item missing the admin-only owner field", () => {
    const result = AdminQueueItem.safeParse({ ...ownerListingBase, report_count: 0, events: [], reports: [] });
    expect(result.success).toBe(false);
  });
});

describe("AdminQueueQuery", () => {
  it("accepts a known status with defaults for cursor/limit", () => {
    const result = AdminQueueQuery.safeParse({ status: "needs_review" });
    expect(result.success).toBe(true);
    expect(result.data?.limit).toBeGreaterThan(0);
  });

  it("rejects an unknown status", () => {
    const result = AdminQueueQuery.safeParse({ status: "approved" });
    expect(result.success).toBe(false);
  });
});

describe("AdminRejectInput", () => {
  it("accepts a real rejection reason", () => {
    expect(AdminRejectInput.safeParse({ reason: "not_an_object" }).success).toBe(true);
  });

  it("rejects the internal-only 'budget' and 'held_for_review' codes", () => {
    expect(AdminRejectInput.safeParse({ reason: "budget" }).success).toBe(false);
    expect(AdminRejectInput.safeParse({ reason: "held_for_review" }).success).toBe(false);
  });
});

describe("AdminHideInput", () => {
  it("allows an empty body (reason is optional)", () => {
    expect(AdminHideInput.safeParse({}).success).toBe(true);
  });
});

describe("AdminTestEmailInput", () => {
  it("accepts a real address", () => {
    expect(AdminTestEmailInput.safeParse({ to: "leapkg@gmail.com" }).success).toBe(true);
  });

  it("rejects a reserved-domain address — even the admin can't mail example.com", () => {
    expect(AdminTestEmailInput.safeParse({ to: "nobody@example.com" }).success).toBe(false);
  });

  it("rejects a malformed address", () => {
    expect(AdminTestEmailInput.safeParse({ to: "not-an-email" }).success).toBe(false);
  });
});

describe("AdminTestErrorInput", () => {
  it("defaults kind to exception on an empty body", () => {
    const result = AdminTestErrorInput.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data.kind).toBe("exception");
  });

  it("accepts kind: message", () => {
    expect(AdminTestErrorInput.safeParse({ kind: "message" }).success).toBe(true);
  });

  it("rejects an unrecognized kind", () => {
    expect(AdminTestErrorInput.safeParse({ kind: "not-a-real-kind" }).success).toBe(false);
  });
});
