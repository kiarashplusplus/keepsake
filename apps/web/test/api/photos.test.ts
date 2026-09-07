import { suggestPhoto } from "@/api/photos";

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
