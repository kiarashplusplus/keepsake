import {
  countdownLabel,
  daysUntilLaunch,
  isDismissed,
  isQuietPath,
  launchPhase,
  shouldShowLaunch,
} from "@/features/launch/launchPlan";

/** Local-time constructor, because the plan is in the visitor's own calendar. */
const at = (month: number, day: number, hour = 12): Date => new Date(2026, month - 1, day, hour, 0, 0);

describe("launchPhase", () => {
  it("counts down until the last minute of Thanksgiving", () => {
    expect(launchPhase(at(11, 17))).toBe("countdown");
    expect(launchPhase(new Date(2026, 10, 26, 23, 59, 59))).toBe("countdown");
  });

  it("is live from midnight on Friday the 27th through the whole of the meetup day", () => {
    expect(launchPhase(new Date(2026, 10, 27, 0, 0, 0))).toBe("live");
    expect(launchPhase(new Date(2026, 10, 28, 23, 59, 59))).toBe("live");
  });

  it("is over — for good — once the meetup day ends", () => {
    expect(launchPhase(new Date(2026, 10, 29, 0, 0, 0))).toBe("over");
    expect(launchPhase(at(12, 25))).toBe("over");
    expect(launchPhase(new Date(2027, 10, 27, 12))).toBe("over");
  });
});

describe("the countdown line", () => {
  it("counts whole calendar days, whatever the hour", () => {
    expect(daysUntilLaunch(at(11, 17, 1))).toBe(10);
    expect(daysUntilLaunch(at(11, 17, 23))).toBe(10);
    expect(countdownLabel(at(11, 17))).toBe("10 days to go");
    expect(countdownLabel(at(11, 26))).toBe("Tomorrow");
    expect(countdownLabel(at(11, 27))).toBe("Today");
  });
});

describe("isDismissed", () => {
  it("comes back once on launch day for someone who dismissed the countdown", () => {
    expect(isDismissed("countdown", "countdown")).toBe(true);
    expect(isDismissed("countdown", "live")).toBe(false);
  });

  it("stays gone once dismissed on launch day", () => {
    expect(isDismissed("live", "live")).toBe(true);
    expect(isDismissed("live", "countdown")).toBe(true);
  });

  it("treats nothing stored, or junk, as not dismissed", () => {
    expect(isDismissed(null, "countdown")).toBe(false);
    expect(isDismissed("1", "countdown")).toBe(false);
    expect(isDismissed("over", "live")).toBe(false);
  });
});

describe("isQuietPath", () => {
  it("leaves the email-link routes and the admin console alone", () => {
    for (const path of ["/unsubscribe", "/unsubscribe/abc", "/confirm/x", "/withdraw/x", "/recover", "/admin"]) {
      expect(isQuietPath(path)).toBe(true);
    }
  });

  it("does not swallow the routes people browse", () => {
    for (const path of ["/", "/welcome", "/give", "/item/abc", "/mine", "/administer", "/recovery"]) {
      expect(isQuietPath(path)).toBe(false);
    }
  });
});

describe("shouldShowLaunch", () => {
  it("shows to a new visitor on a browsing route before and during launch", () => {
    expect(shouldShowLaunch({ now: at(11, 17), pathname: "/", stored: null })).toBe(true);
    expect(shouldShowLaunch({ now: at(11, 27), pathname: "/item/abc", stored: null })).toBe(true);
  });

  it("never shows after the meetup, on a quiet route, or once dismissed", () => {
    expect(shouldShowLaunch({ now: at(11, 29), pathname: "/", stored: null })).toBe(false);
    expect(shouldShowLaunch({ now: at(11, 17), pathname: "/unsubscribe/t", stored: null })).toBe(false);
    expect(shouldShowLaunch({ now: at(11, 17), pathname: "/", stored: "countdown" })).toBe(false);
    expect(shouldShowLaunch({ now: at(11, 28), pathname: "/", stored: "live" })).toBe(false);
  });
});
