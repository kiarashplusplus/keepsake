import * as React from "react";
import { act, render } from "@testing-library/react-native";
import { ToastProvider } from "@/ui/Toast";
import { confirmRequestWithToken } from "@/api/confirm";
import { ApiError } from "@/api/client";
import ConfirmToken from "../../../app/confirm/[token]";

// Same shape as test/app/withdraw/[token].test.tsx, the sibling this page
// is modelled on. The `Link` mock is the one test/app/item/[id].test.tsx
// settled on in #367: `asChild` merges `href` onto the child, which is how a
// `Button` inside a `Link` becomes a real `<a href>` (see `ButtonProps.href`)
// — without it nothing here could tell a link-shaped button from one that
// navigates nowhere.
jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useLocalSearchParams: () => ({ token: "confirm-token-abc" }),
    Link: ({ children, asChild, href }: { children: React.ReactNode; asChild?: boolean; href?: string }) =>
      asChild && ReactActual.isValidElement(children)
        ? ReactActual.cloneElement(children as React.ReactElement, { href })
        : ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

jest.mock("@/api/confirm", () => ({ confirmRequestWithToken: jest.fn() }));

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

type Rendered = ReturnType<typeof render>;

async function renderConfirm(): Promise<Rendered> {
  const utils = render(
    <ToastProvider>
      <ConfirmToken />
    </ToastProvider>,
  );
  await act(async () => {
    await flush();
  });
  return utils;
}

/** The #357 check: every branch that is not the confirmed one offers the
 * feed as a real link — `href` on the element and the link role, which is
 * what a crawler follows and a screen reader announces (`ButtonProps.href`). */
function expectFeedLink(utils: Rendered): void {
  const onward = utils.UNSAFE_getByProps({ accessibilityLabel: "Back to the feed" });
  expect(onward.props.href).toBe("/");
  expect(onward.props.accessibilityRole).toBe("link");
}

describe("confirm/[token]", () => {
  beforeEach(() => {
    jest.mocked(confirmRequestWithToken).mockReset();
  });

  it("posts the token once on mount and, with a giver still to tell, says the request is on its way", async () => {
    jest
      .mocked(confirmRequestWithToken)
      .mockResolvedValue({ id: "req-1", listing_id: "listing-1", confirmed_at: Date.now(), listing_available: true });

    const { toJSON, queryByLabelText } = await renderConfirm();

    expect(jest.mocked(confirmRequestWithToken)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(confirmRequestWithToken)).toHaveBeenCalledWith("confirm-token-abc");
    expect(JSON.stringify(toJSON())).toContain("Your request is on its way.");
    // #357 added the link to the other branches only; the confirmed card was
    // not touched, and it should stay the quiet "you're done" it was.
    expect(queryByLabelText("Back to the feed")).toBeNull();
  });

  it("an expired link (`gone`) says so, and offers the feed as a real link", async () => {
    jest
      .mocked(confirmRequestWithToken)
      .mockRejectedValue(new ApiError("gone", "This link has expired.", 410));

    const utils = await renderConfirm();

    const tree = JSON.stringify(utils.toJSON());
    expect(tree).toContain("This link has expired");
    expect(tree).toContain("ask again");
    expectFeedLink(utils);
  });

  it("an invalid or already-used link says so, and offers the feed as a real link", async () => {
    jest
      .mocked(confirmRequestWithToken)
      .mockRejectedValue(new ApiError("unauthorized", "This link is invalid or has already been used.", 401));

    const utils = await renderConfirm();

    const tree = JSON.stringify(utils.toJSON());
    expect(tree).toContain("That link didn't work");
    // The extra sentence #357 asked for, for the person who mistyped.
    expect(tree).toContain("open the keepsake and try again");
    expectFeedLink(utils);
  });

  it("a network failure lands in the same invalid-link card, with the same link", async () => {
    // Not an `ApiError` at all — what `fetch` throws when the request never
    // reached the Worker. The page has no branch for it, so it must fall
    // into the generic one rather than staying on "One moment…" forever.
    jest.mocked(confirmRequestWithToken).mockRejectedValue(new TypeError("Failed to fetch"));

    const utils = await renderConfirm();

    const tree = JSON.stringify(utils.toJSON());
    expect(tree).toContain("That link didn't work");
    expect(tree).not.toContain("One moment");
    expectFeedLink(utils);
  });

  it("a confirmed request whose keepsake was given away meanwhile offers the feed as a real link", async () => {
    jest
      .mocked(confirmRequestWithToken)
      .mockResolvedValue({ id: "req-1", listing_id: "listing-1", confirmed_at: null, listing_available: false });

    const utils = await renderConfirm();

    const tree = JSON.stringify(utils.toJSON());
    expect(tree).toContain("already spoken for");
    // The one branch that confirmed *and* has nothing to show for it: the
    // reader wanted a keepsake, it is gone, and the feed is where the next
    // one is.
    expectFeedLink(utils);
  });

  it("only posts once even if the effect re-runs (React StrictMode-safe)", async () => {
    jest
      .mocked(confirmRequestWithToken)
      .mockResolvedValue({ id: "req-1", listing_id: "listing-1", confirmed_at: Date.now(), listing_available: true });

    const { rerender } = await renderConfirm();
    rerender(
      <ToastProvider>
        <ConfirmToken />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    expect(jest.mocked(confirmRequestWithToken)).toHaveBeenCalledTimes(1);
  });
});
