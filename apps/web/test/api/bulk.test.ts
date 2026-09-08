import { BULK_GRANT_HEADER } from "@keepsake/contracts/bulk";
import {
  cancelBatch,
  classifyBulkError,
  createBatch,
  getBatch,
  hasAdmission,
  submitBatch,
  suggestBatchPhoto,
  updateBatch,
  uploadBatchPhoto,
  upsertBatchItem,
} from "@/api/bulk";
import { ApiError } from "@/api/client";

function mockFetchOnce(body: unknown): jest.Mock {
  const mock = jest.fn().mockResolvedValue({ json: async () => body });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

const BATCH_SUMMARY = {
  id: "01BATCHA000000000000000000",
  client_batch_key: "batch-1",
  name: "Estate",
  country: "US",
  postal_code: "94110",
  place_name: "San Francisco",
  admin1: "CA",
  shared_story: null,
  state: "draft",
  revision: 1,
  item_count: 0,
  ready_count: 0,
  photo_count: 0,
  created_at: 1000,
  updated_at: 1000,
  expires_at: 999999,
};

describe("classifyBulkError", () => {
  it("maps conflict/forbidden/rate_limited(with & without retryAfter)/unavailable to distinct kinds", () => {
    expect(classifyBulkError(new ApiError("conflict", "stale", 409))).toEqual({ kind: "conflict", message: "stale" });
    expect(classifyBulkError(new ApiError("forbidden", "no grant", 403))).toEqual({ kind: "no_grant", message: "no grant" });
    expect(classifyBulkError(new ApiError("rate_limited", "wait", 429, 30))).toEqual({
      kind: "throttled",
      message: "wait",
      retryAfterSeconds: 30,
    });
    expect(classifyBulkError(new ApiError("rate_limited", "empty grant", 429))).toEqual({
      kind: "admission_exhausted",
      message: "empty grant",
    });
    expect(classifyBulkError(new ApiError("unavailable", "offline", 0))).toEqual({ kind: "network", message: "offline" });
  });

  it("falls back to 'unexpected', carrying the raw code and status, for everything else", () => {
    expect(classifyBulkError(new ApiError("not_found", "gone", 404))).toEqual({
      kind: "unexpected",
      message: "gone",
      code: "not_found",
      status: 404,
    });
  });

  it("rethrows anything that isn't an ApiError — a client-side bug must not be swallowed into a BulkResult", () => {
    expect(() => classifyBulkError(new TypeError("bug"))).toThrow(TypeError);
  });
});

describe("bulk write functions: BulkResult instead of a thrown ApiError", () => {
  it("createBatch resolves ok:true with the parsed BatchSummary on success", async () => {
    mockFetchOnce({ ok: true, data: BATCH_SUMMARY });

    const result = await createBatch(
      { client_batch_key: "batch-1", name: "Estate", country: "US", postal_code: "94110" },
      { grantId: "grant-1" },
    );

    expect(result).toEqual({ ok: true, data: BATCH_SUMMARY });
  });

  it("createBatch sends the grant id in the x-bulk-grant header, alongside owner auth", async () => {
    const mock = mockFetchOnce({ ok: true, data: BATCH_SUMMARY });

    await createBatch({ client_batch_key: "batch-1", name: "Estate", country: "US", postal_code: "94110" }, { grantId: "grant-xyz" });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/bulk/batches");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers[BULK_GRANT_HEADER]).toBe("grant-xyz");
    expect(headers.Authorization).toMatch(/^Bearer /);
  });

  it("createBatch rejects a request that doesn't match CreateBatchInput before ever calling fetch", async () => {
    const mock = mockFetchOnce({ ok: true, data: BATCH_SUMMARY });
    await expect(
      // @ts-expect-error deliberately missing required fields
      createBatch({ client_batch_key: "batch-1" }, { grantId: "grant-1" }),
    ).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
  });

  it("a 409 surfaces as {ok:false, error:{kind:'conflict'}}, not a thrown ApiError", async () => {
    mockFetchOnce({ ok: false, error: { code: "conflict", message: "This batch changed elsewhere — reload and try again." } });

    const result = await updateBatch("01BATCHA000000000000000000", { expected_revision: 1, name: "New name" }, { grantId: "grant-1" });

    expect(result).toEqual({ ok: false, error: { kind: "conflict", message: "This batch changed elsewhere — reload and try again." } });
  });

  it("a 429 with Retry-After surfaces as 'throttled' — a resumable pause, distinguishable from admission running out", async () => {
    mockFetchOnce({ ok: false, error: { code: "rate_limited", message: "Slow down.", retryAfter: 12 } });

    const result = await upsertBatchItem("01BATCHA000000000000000000", "item-a", { fields: {} }, { grantId: "grant-1" });

    expect(result).toEqual({ ok: false, error: { kind: "throttled", message: "Slow down.", retryAfterSeconds: 12 } });
  });

  it("a 429 with no Retry-After surfaces as 'admission_exhausted' — needs a fresh grant, not a wait", async () => {
    mockFetchOnce({ ok: false, error: { code: "rate_limited", message: "Your admission grant has no items left." } });

    const result = await upsertBatchItem("01BATCHA000000000000000000", "item-a", { fields: {} }, { grantId: "grant-1" });

    expect(result).toEqual({ ok: false, error: { kind: "admission_exhausted", message: "Your admission grant has no items left." } });
  });

  it("a network failure surfaces as 'network', distinguishable from every other write failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("network error")) as unknown as typeof fetch;

    const result = await cancelBatch("01BATCHA000000000000000000", { grantId: "grant-1" });

    expect(result).toEqual({ ok: false, error: { kind: "network", message: "Couldn't reach Keepsake. Check your connection and try again." } });
  });
});

describe("uploadBatchPhoto", () => {
  it("PUTs multipart with the same field names as src/api/photos.ts's uploadPhoto, plus the grant header", async () => {
    const mock = mockFetchOnce({
      ok: true,
      data: {
        client_photo_id: "photo-a",
        photo_id: "01SNAPA0000000000000000000",
        item_client_id: null,
        position: 0,
        url_thumb: "/i/01SNAPA0000000000000000000/thumb",
      },
    });

    const result = await uploadBatchPhoto(
      "01BATCHA000000000000000000",
      "photo-a",
      { full: new Blob(["full"]), thumb: new Blob(["thumb"]), width: 800, height: 600, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
      { grantId: "grant-1" },
    );

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/bulk/batches/01BATCHA000000000000000000/photos/photo-a");
    expect(init.method).toBe("PUT");
    const form = init.body as FormData;
    expect(form.get("width")).toBe("800");
    expect(form.get("blurhash")).toBe("LEHV6nWB2yk8pyo0adR*.7kCMdnj");
    expect((init.headers as Record<string, string>)[BULK_GRANT_HEADER]).toBe("grant-1");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.url_thumb).toMatch(/^https?:\/\//);
  });
});

describe("reads (getBatch, submitBatch) — plain ApiError like every other src/api module", () => {
  it("getBatch resolves photo URLs the same way fixPhotoUrls does for every other domain module", async () => {
    mockFetchOnce({
      ok: true,
      data: {
        ...BATCH_SUMMARY,
        items: [],
        photos: [{ client_photo_id: "photo-a", photo_id: "01SNAPA0000000000000000000", item_client_id: null, position: 0, url_thumb: "/i/01SNAPA0000000000000000000/thumb" }],
      },
    });

    const detail = await getBatch("01BATCHA000000000000000000");
    expect(detail.photos[0]?.url_thumb).toMatch(/^https?:\/\//);
  });

  it("submitBatch returns ok:true with the BulkOperationSummary on the 202 path", async () => {
    mockFetchOnce({
      ok: true,
      data: { id: "01TASKA0000000000000000000", batch_id: "01BATCHA000000000000000000", kind: "submit", status: "queued", total: 3, succeeded: 0, failed: 0, created_at: 1, updated_at: 1, finished_at: null },
    });

    const result = await submitBatch(
      "01BATCHA000000000000000000",
      { op_key: "submit-1", date_of_birth: "2000-01-01", items: [{ client_item_id: "item-a", revision: 1 }] },
      { grantId: "grant-1" },
    );

    expect(result.ok).toBe(true);
  });
});

describe("suggestBatchPhoto", () => {
  it("resolves ok:true with null when the model declined — never treated as an error", async () => {
    mockFetchOnce({ ok: true, data: { suggestion: null } });
    await expect(suggestBatchPhoto("01BATCHA000000000000000000", "photo-a", { grantId: "grant-1" })).resolves.toEqual({
      ok: true,
      data: null,
    });
  });

  // The behavior the coordinator's follow-up note asked for: running out of
  // suggestion admission (its own counter, `BulkGrantSummary.
  // suggestions_remaining`, separate from items/photos) must not read like a
  // generic failure or like running out of photo/item admission.
  it("surfaces suggestion-admission exhaustion as a typed BulkResult, not a thrown ApiError", async () => {
    mockFetchOnce({ ok: false, error: { code: "rate_limited", message: "Your admission grant has no suggestions left." } });
    const result = await suggestBatchPhoto("01BATCHA000000000000000000", "photo-a", { grantId: "grant-1" });
    expect(result).toEqual({ ok: false, error: { kind: "admission_exhausted", message: "Your admission grant has no suggestions left." } });
  });

  it("still classifies a genuine failure unrelated to admission (a validation bug, a 500) as 'unexpected'", async () => {
    mockFetchOnce({ ok: false, error: { code: "internal", message: "Something went wrong." } });
    const result = await suggestBatchPhoto("01BATCHA000000000000000000", "missing", { grantId: "grant-1" });
    expect(result).toEqual({ ok: false, error: { kind: "unexpected", message: "Something went wrong.", code: "internal", status: undefined } });
  });
});

describe("hasAdmission", () => {
  const grant = { id: "01GRANTX000000000000000000", batch_id: null, items_remaining: 0, photos_remaining: 3, suggestions_remaining: 0, expires_at: 1 };

  it("checks each of the three counters independently — a batch can still be finished with zero suggestions", () => {
    expect(hasAdmission(grant, "items")).toBe(false);
    expect(hasAdmission(grant, "photos")).toBe(true);
    expect(hasAdmission(grant, "suggestions")).toBe(false);
  });
});
