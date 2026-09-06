import { OwnerTokenSchema } from "@keepsake/contracts/owner";
import { OWNER_TOKEN_STORAGE_KEY, clearOwnerToken, getOrCreateOwnerToken, getOwnerToken, setOwnerToken } from "@/lib/ownerToken";

describe("ownerToken", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when nothing has been minted yet", () => {
    expect(getOwnerToken()).toBeNull();
  });

  it("mints a token matching OwnerTokenSchema and persists it under the storage key", () => {
    const token = getOrCreateOwnerToken();

    expect(OwnerTokenSchema.safeParse(token).success).toBe(true);
    expect(window.localStorage.getItem(OWNER_TOKEN_STORAGE_KEY)).toBe(token);
    expect(getOwnerToken()).toBe(token);
  });

  it("returns the same token on repeated calls instead of minting a new one", () => {
    const first = getOrCreateOwnerToken();
    const second = getOrCreateOwnerToken();

    expect(second).toBe(first);
  });

  it("setOwnerToken overwrites whatever was stored", () => {
    getOrCreateOwnerToken();
    const custom = `ks_${"a".repeat(43)}`;

    setOwnerToken(custom);

    expect(getOwnerToken()).toBe(custom);
  });

  it("clearOwnerToken removes it, and getOwnerToken never mints one back", () => {
    getOrCreateOwnerToken();

    clearOwnerToken();

    expect(getOwnerToken()).toBeNull();
    expect(window.localStorage.getItem(OWNER_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("treats a malformed stored value as absent rather than returning garbage", () => {
    window.localStorage.setItem(OWNER_TOKEN_STORAGE_KEY, "not-a-token");

    expect(getOwnerToken()).toBeNull();
  });
});
