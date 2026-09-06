import { relativeTime } from "@/lib/relativeTime";

describe("relativeTime", () => {
  const now = new Date("2026-09-06T12:00:00Z").getTime();

  it("says 'just now' under a minute", () => {
    expect(relativeTime(now - 30 * 1000, now)).toBe("just now");
  });

  it("shows minutes under an hour", () => {
    expect(relativeTime(now - 5 * 60 * 1000, now)).toBe("5 min ago");
  });

  it("shows hours under a day", () => {
    expect(relativeTime(now - 3 * 60 * 60 * 1000, now)).toBe("3 h ago");
  });

  it("shows days under a week", () => {
    expect(relativeTime(now - 2 * 24 * 60 * 60 * 1000, now)).toBe("2 d ago");
  });

  it("falls back to a date beyond a week", () => {
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    expect(relativeTime(eightDaysAgo, now)).toBe(new Date(eightDaysAgo).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }));
  });

  it("never returns a negative duration for a future timestamp", () => {
    expect(relativeTime(now + 10_000, now)).toBe("just now");
  });
});
