import { isVersionStale, responseIsCacheable, UNSTAMPED_COMMIT } from "@/lib/versionSkew";

describe("isVersionStale", () => {
  it("is stale when the server commit doesn't start with the build's short commit", () => {
    expect(isVersionStale("a1b2c3d", "9999999deadbeef0000000000000000deadbeef")).toBe(true);
  });

  it("is NOT stale when the full server commit starts with the build's short (7-char) commit", () => {
    // The real-world shape: `apps/web`'s baked-in `commitHash` is always a
    // 7-character prefix (`resolveBuildInfo.mjs`), `/version.json` returns
    // the full SHA (`apps/api/src/index.ts`) — `===` would be permanently
    // stale even on a matching deploy, which is the bug this function fixes.
    expect(isVersionStale("a1b2c3d", "a1b2c3d4e5f6789012345678901234567890abcd")).toBe(false);
  });

  it("is NOT stale when either side is the unstamped 'dev' fallback", () => {
    expect(isVersionStale(UNSTAMPED_COMMIT, "a1b2c3d4e5f6789012345678901234567890abcd")).toBe(false);
    expect(isVersionStale("a1b2c3d", UNSTAMPED_COMMIT)).toBe(false);
    expect(isVersionStale(UNSTAMPED_COMMIT, UNSTAMPED_COMMIT)).toBe(false);
  });

  it("is NOT stale when either side is empty (a malformed/partial response)", () => {
    expect(isVersionStale("", "a1b2c3d4e5f6789012345678901234567890abcd")).toBe(false);
    expect(isVersionStale("a1b2c3d", "")).toBe(false);
  });
});

describe("responseIsCacheable", () => {
  it("is false for the real server contract: Cache-Control: no-store", () => {
    expect(responseIsCacheable("no-store")).toBe(false);
  });

  it("is true when the header is missing entirely — the guard must not assume a fresh response", () => {
    expect(responseIsCacheable(null)).toBe(true);
  });

  it("is true for a cacheable directive — this is the class of dead check the guard exists to avoid", () => {
    expect(responseIsCacheable("public, max-age=3600")).toBe(true);
    expect(responseIsCacheable("private")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(responseIsCacheable("No-Store")).toBe(false);
  });
});
