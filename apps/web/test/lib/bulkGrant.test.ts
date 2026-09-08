import { clearStoredGrantId, getStoredGrantId, setStoredGrantId } from "@/lib/bulkGrant";

describe("bulkGrant", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns an empty string when nothing has been stored", () => {
    expect(getStoredGrantId()).toBe("");
  });

  it("round-trips a trimmed grant id", () => {
    setStoredGrantId("  01GRANT000000000000000000  ");
    expect(getStoredGrantId()).toBe("01GRANT000000000000000000");
  });

  it("treats an empty or blank id as clearing the stored one", () => {
    setStoredGrantId("01GRANT000000000000000000");
    setStoredGrantId("   ");
    expect(getStoredGrantId()).toBe("");
  });

  it("clearStoredGrantId removes it outright", () => {
    setStoredGrantId("01GRANT000000000000000000");
    clearStoredGrantId();
    expect(getStoredGrantId()).toBe("");
  });
});
