import { suggestPhoto, uploadPhoto } from "@/api/photos";

function mockFetchOnce(body: unknown): void {
  global.fetch = jest.fn().mockResolvedValue({ json: async () => body }) as unknown as typeof fetch;
}

describe("suggestPhoto", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns the parsed suggestion on success", async () => {
    mockFetchOnce({
      ok: true,
      data: {
        suggestion: {
          subject: "a ceramic mug",
          markings: "",
          title: "Blue ceramic mug",
          category: "home_kitchen",
          condition: "small chip near the handle",
          aspects: [{ name: "material", value: "ceramic" }],
        },
      },
    });

    const result = await suggestPhoto("01PHOTO");

    expect(result).toMatchObject({ title: "Blue ceramic mug", category: "home_kitchen" });
  });

  it("returns null when the model failed/timed out — a non-event, not a thrown error", async () => {
    mockFetchOnce({ ok: true, data: { suggestion: null } });

    await expect(suggestPhoto("01PHOTO")).resolves.toBeNull();
  });

  it("posts to the right route with the owner token", async () => {
    const mock = jest.fn().mockResolvedValue({ json: async () => ({ ok: true, data: { suggestion: null } }) });
    global.fetch = mock as unknown as typeof fetch;

    await suggestPhoto("01PHOTOXYZ");

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/photos/01PHOTOXYZ/suggest");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });
});

/**
 * #183's other half. `apps/api/test/photoUploadTurnstile.test.ts` pins that
 * `PUT /api/photos` mounts no `turnstile()`; this pins *why* mounting one
 * would break every real giver — the client sends no token, because the give
 * flow's photo step (`apps/web/app/give/index.tsx`, step 1 of 5) uploads on
 * pick and renders no `<Turnstile>` widget. The only widget in the give flow
 * is on the review step, five screens later.
 *
 * When someone adds a widget to the photos step and threads a token through
 * `uploadPhoto`, this test goes red and points at the server-side mount that
 * has to land with it.
 */
describe("uploadPhoto: Turnstile coupling (#183)", () => {
  it("sends no cf-turnstile-response header — the give flow has no token at the photo step", async () => {
    const mock = jest.fn().mockResolvedValue({
      json: async () => ({
        ok: true,
        data: { id: "01J8ZQ4T7X9WBHGMK2N3P4R5S6", width: 800, height: 600, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", url_full: "/i/01J8ZQ4T7X9WBHGMK2N3P4R5S6/full", url_thumb: "/i/01J8ZQ4T7X9WBHGMK2N3P4R5S6/thumb" },
      }),
    });
    global.fetch = mock as unknown as typeof fetch;

    await uploadPhoto({
      full: new Blob(["full"], { type: "image/jpeg" }),
      thumb: new Blob(["thumb"], { type: "image/jpeg" }),
      width: 800,
      height: 600,
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/photos");
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(headers["cf-turnstile-response"]).toBeUndefined();
  });
});
