import { apiFetch, ApiError } from "@/api/client";
import { getOrCreateOwnerToken } from "@/lib/ownerToken";

type FetchMock = jest.Mock<Promise<{ json: () => Promise<unknown> }>, [string, RequestInit?]>;

function mockFetchOnce(body: unknown): FetchMock {
  const mock: FetchMock = jest.fn().mockResolvedValue({ json: async () => body });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe("apiFetch", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns the payload on an ok envelope", async () => {
    mockFetchOnce({ ok: true, data: { hello: "world" } });

    const result = await apiFetch<{ hello: string }>("/api/thing");

    expect(result).toEqual({ hello: "world" });
  });

  it("throws an ApiError carrying the code/message/retryAfter on an error envelope", async () => {
    mockFetchOnce({ ok: false, error: { code: "rate_limited", message: "Slow down", retryAfter: 30 } });

    await expect(apiFetch("/api/thing")).rejects.toBeInstanceOf(ApiError);
    // Fresh mock per assertion: the response body stream is a fresh object,
    // but re-using the same rejected assertion twice would only consume it once.
    mockFetchOnce({ ok: false, error: { code: "rate_limited", message: "Slow down", retryAfter: 30 } });
    await expect(apiFetch("/api/thing")).rejects.toMatchObject({ code: "rate_limited", message: "Slow down", retryAfter: 30 });
  });

  it("throws unavailable when fetch itself rejects (offline)", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("network error")) as unknown as typeof fetch;

    await expect(apiFetch("/api/thing")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("never attaches an Authorization header for owner:false (the default)", async () => {
    const mock = mockFetchOnce({ ok: true, data: null });

    await apiFetch("/api/anonymous");

    const init = mock.mock.calls[0]?.[1];
    expect(init?.headers).not.toHaveProperty("Authorization");
  });

  it("attaches Authorization: Bearer <ownerToken> only when owner:true is requested", async () => {
    const mock = mockFetchOnce({ ok: true, data: null });
    const token = getOrCreateOwnerToken();

    await apiFetch("/api/owner-thing", { owner: true });

    const init = mock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  });

  it("sends a JSON body with Content-Type for a plain object body", async () => {
    const mock = mockFetchOnce({ ok: true, data: null });

    await apiFetch("/api/thing", { method: "POST", body: { a: 1 } });

    const init = mock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("merges custom headers in, without letting them override Authorization", async () => {
    const mock = mockFetchOnce({ ok: true, data: null });
    const token = getOrCreateOwnerToken();

    await apiFetch("/api/bulk/thing", { owner: true, headers: { "x-bulk-grant": "grant-1", Authorization: "Bearer nope" } });

    const init = mock.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-bulk-grant"]).toBe("grant-1");
    expect(headers.Authorization).toBe(`Bearer ${token}`);
  });

  it("passes a FormData body through untouched, without a Content-Type header", async () => {
    const mock = mockFetchOnce({ ok: true, data: null });
    const form = new FormData();
    form.append("a", "1");

    await apiFetch("/api/upload", { method: "PUT", body: form });

    const init = mock.mock.calls[0]?.[1];
    expect(init?.body).toBe(form);
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("drops a caller-supplied Content-Type on a FormData body, in any casing", async () => {
    // The one header a caller must NOT win: only `fetch` can write the
    // multipart value, because only it knows the boundary. Both spellings,
    // because `headers` is a plain object and HTTP header names are not
    // case-sensitive.
    for (const name of ["Content-Type", "content-type"]) {
      const mock = mockFetchOnce({ ok: true, data: null });
      const form = new FormData();
      form.append("a", "1");

      await apiFetch("/api/upload", { method: "PUT", body: form, headers: { [name]: "multipart/form-data" } });

      const headers = mock.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(Object.keys(headers).some((key) => key.toLowerCase() === "content-type")).toBe(false);
    }
  });
});
