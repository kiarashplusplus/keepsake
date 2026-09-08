import type { ListingStaleness } from "@keepsake/contracts/listing";
import { ownerEmailProblem, staleLines, staleSummary, waitedFor } from "@/features/mine/staleness";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function staleness(overrides: Partial<ListingStaleness> = {}): ListingStaleness {
  return { reasons: [], waiting_since: null, ...overrides };
}

describe("waitedFor", () => {
  it("counts whole days up to a fortnight", () => {
    expect(waitedFor(3 * DAY)).toBe("3 days");
    expect(waitedFor(13 * DAY + 23 * 60 * 60 * 1000)).toBe("13 days");
  });

  it("switches to weeks, then to months, rather than saying '96 days'", () => {
    expect(waitedFor(14 * DAY)).toBe("2 weeks");
    expect(waitedFor(60 * DAY)).toBe("8 weeks");
    expect(waitedFor(96 * DAY)).toBe("3 months");
  });

  it("never says '0 days' for a sliver under one", () => {
    expect(waitedFor(60 * 1000)).toBe("a day");
  });
});

describe("staleLines", () => {
  it("says nothing when nothing is wrong", () => {
    expect(staleLines(staleness(), NOW)).toEqual([]);
  });

  it("puts the wait in the sentence, because the number is the point", () => {
    const lines = staleLines(staleness({ reasons: ["requests_unanswered"], waiting_since: NOW - 11 * DAY }), NOW);
    expect(lines).toEqual(["Someone has been waiting 11 days to hear back."]);
  });

  it("keeps the API's order — the person waiting first", () => {
    const lines = staleLines(staleness({ reasons: ["requests_unanswered", "email_missing"], waiting_since: NOW - 4 * DAY }), NOW);
    expect(lines[0]).toContain("4 days");
    expect(lines[1]).toContain("No email on this device");
  });

  it("falls back to the plain sentence if a waiting reason ever arrives without its timestamp", () => {
    expect(staleLines(staleness({ reasons: ["requests_unanswered"] }), NOW)).toEqual(["Someone asked for this and is still waiting to hear back."]);
  });
});

describe("staleSummary", () => {
  it("is null for a listing with nothing wrong", () => {
    expect(staleSummary(staleness(), NOW)).toBeNull();
  });

  it("is the first line only — a row has one line", () => {
    const summary = staleSummary(staleness({ reasons: ["email_unverified"] }), NOW);
    expect(summary).toContain("isn't verified");
  });
});

describe("ownerEmailProblem", () => {
  it("is null when every listing is fine", () => {
    expect(ownerEmailProblem([{ staleness: staleness() }, { staleness: staleness() }])).toBeNull();
  });

  it("is null for a page with no listings at all", () => {
    expect(ownerEmailProblem([])).toBeNull();
  });

  it("ignores the reason that is about a keepsake rather than a mailbox", () => {
    expect(ownerEmailProblem([{ staleness: staleness({ reasons: ["requests_unanswered"], waiting_since: NOW }) }])).toBeNull();
  });

  it("finds a missing address anywhere on the page", () => {
    expect(ownerEmailProblem([{ staleness: staleness() }, { staleness: staleness({ reasons: ["email_missing"] }) }])).toBe("email_missing");
  });

  it("prefers 'missing' to 'unverified' when a page somehow shows both", () => {
    const found = ownerEmailProblem([
      { staleness: staleness({ reasons: ["email_unverified"] }) },
      { staleness: staleness({ reasons: ["email_missing"] }) },
    ]);
    expect(found).toBe("email_missing");
  });
});
