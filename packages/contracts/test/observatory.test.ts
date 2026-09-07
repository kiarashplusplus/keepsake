/**
 * `ObservatoryQuery` is the one client-submitted shape in
 * `../src/observatory.ts` — everything else there is a server-computed
 * payload the client only renders. So this file is small on purpose: it
 * covers the window parameter and nothing else, because nothing else in that
 * module has runtime behaviour to get wrong.
 */
import { describe, expect, it } from "vitest";
import { OBSERVATORY_WINDOWS, ObservatoryQuery } from "../src/observatory";

describe("ObservatoryQuery", () => {
  it("defaults to a week when the window is omitted", () => {
    expect(ObservatoryQuery.parse({})).toEqual({ window_days: 7 });
  });

  it("accepts every window the UI offers", () => {
    // Coupled to the exported constant rather than to a literal list, so a
    // window added to `OBSERVATORY_WINDOWS` without a matching aggregation
    // path cannot pass this by being forgotten here.
    for (const days of OBSERVATORY_WINDOWS) {
      expect(ObservatoryQuery.parse({ window_days: days })).toEqual({ window_days: days });
    }
  });

  it("coerces the string a query parameter actually arrives as", () => {
    // `?window_days=30` is the string "30" by the time Hono hands it over.
    // Without coercion the closed-set check below would reject every real
    // request while passing every test that used a number literal.
    expect(ObservatoryQuery.parse({ window_days: "30" })).toEqual({ window_days: 30 });
  });

  it("rejects a plausible-looking window that is not in the set", () => {
    // 14 is the kind of value someone would try by hand. It has no
    // aggregation path, so accepting it would silently produce a window
    // labelled 14 days and filled by whatever the queries happened to do.
    expect(() => ObservatoryQuery.parse({ window_days: 14 })).toThrow();
  });

  it("rejects values that are not windows at all", () => {
    expect(() => ObservatoryQuery.parse({ window_days: 0 })).toThrow();
    expect(() => ObservatoryQuery.parse({ window_days: -7 })).toThrow();
    expect(() => ObservatoryQuery.parse({ window_days: 7.5 })).toThrow();
    expect(() => ObservatoryQuery.parse({ window_days: "lots" })).toThrow();
  });
});
