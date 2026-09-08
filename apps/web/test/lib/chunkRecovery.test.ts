import { isChunkLoadFailure, CHUNK_PATH_PREFIX } from "@/lib/chunkRecovery";

describe("isChunkLoadFailure", () => {
  it("recognizes Chromium's failed-dynamic-import message", () => {
    const error = new Error(
      `Failed to fetch dynamically imported module: https://keepsake.ing${CHUNK_PATH_PREFIX}js/web/give-abc123.js`,
    );
    expect(isChunkLoadFailure(error)).toBe(true);
  });

  it("recognizes Firefox's wording", () => {
    const error = new Error("error loading dynamically imported module: https://keepsake.ing/_expo/static/js/web/give-abc123.js");
    expect(isChunkLoadFailure(error)).toBe(true);
  });

  it("recognizes the generic module-script-failed wording some engines fall back to", () => {
    expect(isChunkLoadFailure(new Error("Importing a module script failed"))).toBe(true);
  });

  it("recognizes the wording observed against the e2e suite's pinned headless-shell build — the real path for expo-router's lazy routes", () => {
    expect(
      isChunkLoadFailure(
        new Error(
          `Loading module https://keepsake.ing${CHUNK_PATH_PREFIX}js/web/give-abc123.js failed.\n(error: https://keepsake.ing${CHUNK_PATH_PREFIX}js/web/give-abc123.js)`,
        ),
      ),
    ).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isChunkLoadFailure(new Error("FAILED TO FETCH DYNAMICALLY IMPORTED MODULE"))).toBe(true);
  });

  it("accepts a plain string reason, not just an Error", () => {
    expect(isChunkLoadFailure("Failed to fetch dynamically imported module: /x.js")).toBe(true);
  });

  it("recognizes a failing URL under the chunk prefix even without matching wording", () => {
    expect(
      isChunkLoadFailure(new Error("NetworkError"), `https://keepsake.ing${CHUNK_PATH_PREFIX}js/web/give-abc123.js`),
    ).toBe(true);
  });

  it("is false for an ordinary error unrelated to a chunk load", () => {
    expect(isChunkLoadFailure(new Error("Failed to fetch"))).toBe(false);
    expect(isChunkLoadFailure(new TypeError("NetworkError when attempting to fetch resource."))).toBe(false);
    expect(isChunkLoadFailure(new Error("listing not found"))).toBe(false);
  });

  it("is false for a non-error, non-string reason with no failing URL", () => {
    expect(isChunkLoadFailure(undefined)).toBe(false);
    expect(isChunkLoadFailure(null)).toBe(false);
    expect(isChunkLoadFailure({ code: "ECONNRESET" })).toBe(false);
  });

  it("is false for a URL failure outside the chunk prefix — an ordinary asset 404 must not trigger a reload", () => {
    expect(isChunkLoadFailure(new Error("fetch failed"), "https://keepsake.ing/og-default.png")).toBe(false);
  });
});
