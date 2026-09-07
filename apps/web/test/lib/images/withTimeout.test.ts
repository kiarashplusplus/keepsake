import { withTimeout } from "@/lib/images/withTimeout";

describe("withTimeout", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves through when the promise settles first", async () => {
    await expect(withTimeout(Promise.resolve("done"), 1000, "task")).resolves.toBe("done");
  });

  it("propagates the promise's own rejection rather than a timeout", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "task")).rejects.toThrow("boom");
  });

  it("rejects with a labelled timeout when the timer wins", async () => {
    const pending = withTimeout(new Promise(() => undefined), 1000, "decodeImage");
    const assertion = expect(pending).rejects.toThrow("decodeImage timed out after 1000ms");
    jest.advanceTimersByTime(1000);
    await assertion;
  });

  it("clears the timer on the fast path so a settled call leaves nothing pending", async () => {
    await withTimeout(Promise.resolve(1), 1000, "task");
    expect(jest.getTimerCount()).toBe(0);
  });
});
