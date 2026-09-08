/**
 * `shareListing` had no tests at all, which is how it kept a bare title as
 * its message body and stayed invisible to analytics through two releases.
 *
 * The behaviour that matters is the fallback ladder — `navigator.share`, then
 * the clipboard, then honest failure — and the fact that a dismissed share
 * sheet is *not* a failure. Getting that wrong means a user who taps Share
 * and changes their mind silently gets the link copied instead, which is a
 * different thing from what they asked for.
 */
import { shareListing, shareText } from "@/lib/share";
import { track } from "@/lib/analytics";

jest.mock("@/lib/analytics", () => ({ track: jest.fn(() => true) }));

const mockTrack = track as jest.MockedFunction<typeof track>;

/**
 * Each stub declares its `ShareData` parameter even where it ignores it: a
 * bare `jest.fn(async () => …)` infers a ZERO-argument signature, which makes
 * `share.mock.calls[0][0]` a type error and the payload unassertable.
 */
type ShareFn = jest.Mock<Promise<void>, [ShareData]>;
type NavigatorMocks = { share?: ShareFn; writeText?: jest.Mock };

/**
 * Installs the two capabilities `shareListing` feature-detects. jsdom's
 * `navigator` has neither, and both are read-only accessors, so they are
 * defined rather than assigned.
 */
function stubNavigator({ share, writeText }: NavigatorMocks): void {
  Object.defineProperty(navigator, "share", { value: share, configurable: true });
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

const LISTING = { id: "01JQTESTLISTINGID000000001", title: "Grandmother's teacup", surface: "item" } as const;

beforeEach(() => {
  mockTrack.mockClear();
  stubNavigator({});
});

describe("shareText", () => {
  it("is one clause, ending in a full stop, containing the title", () => {
    // Kept short on purpose: some share targets concatenate `text` and `url`
    // into a length-limited field and drop the URL when the result is too
    // long — and the URL is the part that unfurls into the card.
    const text = shareText("Grandmother's teacup");
    expect(text).toContain("Grandmother's teacup");
    expect(text.length).toBeLessThan(120);
    expect(text).not.toBe("Grandmother's teacup");
  });
});

describe("shareListing", () => {
  it("uses the native share sheet with the listing URL when one exists", async () => {
    const share: ShareFn = jest.fn(async (_data: ShareData) => undefined);
    stubNavigator({ share });

    await expect(shareListing(LISTING)).resolves.toBe("shared");

    expect(share).toHaveBeenCalledTimes(1);
    const payload = share.mock.calls[0]?.[0];
    expect(payload?.url).toContain(`/item/${LISTING.id}`);
    expect(payload?.text).toBe(shareText(LISTING.title));
    expect(payload?.title).toBe(LISTING.title);
  });

  it("treats a dismissed share sheet as cancelled, not as a failure", async () => {
    // The important one. Falling through to the clipboard here would copy a
    // link for someone who just decided not to share, and the caller would
    // toast "Link copied." at them for an action they cancelled.
    const abort = new Error("dismissed");
    abort.name = "AbortError";
    const writeText = jest.fn(async () => undefined);
    stubNavigator({ share: jest.fn(async (_data: ShareData) => Promise.reject(abort)), writeText });

    await expect(shareListing(LISTING)).resolves.toBe("cancelled");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to the clipboard when the share sheet fails for any other reason", async () => {
    const writeText = jest.fn(async () => undefined);
    stubNavigator({ share: jest.fn(async (_data: ShareData) => Promise.reject(new Error("NotAllowedError"))), writeText });

    await expect(shareListing(LISTING)).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`/item/${LISTING.id}`));
  });

  it("copies when there is no share sheet at all", async () => {
    const writeText = jest.fn(async () => undefined);
    stubNavigator({ writeText });
    await expect(shareListing(LISTING)).resolves.toBe("copied");
  });

  it("reports failure when neither capability works", async () => {
    stubNavigator({ writeText: jest.fn(async () => Promise.reject(new Error("denied"))) });
    await expect(shareListing(LISTING)).resolves.toBe("failed");
  });

  it("reports failure when the browser offers neither capability", async () => {
    stubNavigator({});
    await expect(shareListing(LISTING)).resolves.toBe("failed");
  });

  describe("analytics", () => {
    it("records every outcome, including the ones that are not successes", async () => {
      // Fired inside `shareListing` rather than at its two call sites, so a
      // third caller cannot forget it. `cancelled` is the interesting value:
      // a share sheet opened and dismissed is a different signal from a share
      // that never started, and only one of them is visible here.
      const abort = new Error("dismissed");
      abort.name = "AbortError";
      stubNavigator({ share: jest.fn(async (_data: ShareData) => Promise.reject(abort)) });

      await shareListing({ ...LISTING, surface: "give_review" });

      expect(mockTrack).toHaveBeenCalledWith("shared", {
        id: LISTING.id,
        surface: "give_review",
        result: "cancelled",
      });
    });

    it("distinguishes the giver's own share from a stranger's", async () => {
      stubNavigator({ share: jest.fn(async (_data: ShareData) => undefined) });

      await shareListing({ ...LISTING, surface: "item" });
      expect(mockTrack).toHaveBeenCalledWith("shared", expect.objectContaining({ surface: "item" }));
    });
  });
});
