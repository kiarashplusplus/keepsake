import * as React from "react";
import { act, render } from "@testing-library/react-native";
import { ToastProvider } from "@/ui/Toast";
import { withdrawWithToken } from "@/api/withdraw";
import { ApiError } from "@/api/client";
import WithdrawToken from "../../../app/withdraw/[token]";

// Same shape as test/app/recover/[token].test.tsx — the page this one
// mirrors (see app/withdraw/[token].tsx's file header). The `Link` mock is
// the one test/app/item/[id].test.tsx settled on in #367: `asChild` merges
// `href` onto the child, which is how a `Button` inside a `Link` becomes a
// real `<a href>` (see `ButtonProps.href`) — without it nothing here could
// tell a link-shaped button from one that navigates nowhere.
jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useLocalSearchParams: () => ({ token: "withdraw-token-abc" }),
    Link: ({ children, asChild, href }: { children: React.ReactNode; asChild?: boolean; href?: string }) =>
      asChild && ReactActual.isValidElement(children)
        ? ReactActual.cloneElement(children as React.ReactElement, { href })
        : ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

jest.mock("@/api/withdraw", () => ({ withdrawWithToken: jest.fn() }));

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe("withdraw/[token]", () => {
  beforeEach(() => {
    jest.mocked(withdrawWithToken).mockReset();
  });

  it("posts the token once on mount and shows the honest 'our copy only' outcome on success", async () => {
    jest
      .mocked(withdrawWithToken)
      .mockResolvedValue({ id: "req-1", listing_id: "listing-1", withdrawn_at: Date.now() });

    const { toJSON } = render(
      <ToastProvider>
        <WithdrawToken />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    expect(jest.mocked(withdrawWithToken)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(withdrawWithToken)).toHaveBeenCalledWith("withdraw-token-abc");

    const tree = JSON.stringify(toJSON());
    expect(tree).toContain("Your request is withdrawn.");
    // The bar this page has to clear per issue #9: never imply the erasure
    // reaches an email a giver already opened.
    expect(tree).toContain("can't recall a message that already reached them");
    expect(tree).not.toContain("your data has been deleted");
  });

  it("shows a generic, non-committal error for an invalid or already-used token — never which", async () => {
    jest
      .mocked(withdrawWithToken)
      .mockRejectedValue(
        new ApiError("unauthorized", "This link is invalid or has already been used.", 401),
      );

    const { toJSON, UNSAFE_getByProps } = render(
      <ToastProvider>
        <WithdrawToken />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    const tree = JSON.stringify(toJSON());
    expect(tree).toContain("That link didn't work");
    // Reassures a requester re-clicking a link they already used, without
    // claiming to know that's actually what happened (expired/typo'd/unknown
    // are indistinguishable from here, same as /recover/:token).
    expect(tree).toContain("already gone from our records");

    // #357: the card used to be the whole page, with nothing on it to press.
    // A real link, not a `<div role="button">` — a crawler can follow it and
    // a screen reader announces it as a link (see `ButtonProps.href`).
    const onward = UNSAFE_getByProps({ accessibilityLabel: "Back to the feed" });
    expect(onward.props.href).toBe("/");
    expect(onward.props.accessibilityRole).toBe("link");
  });

  it("a network failure lands in the same card, with the same link", async () => {
    // Not an `ApiError` — what `fetch` throws when the request never reached
    // the Worker. The page collapses every failure into one branch, so this
    // has to land there too rather than stay on "Taking care of that…".
    jest.mocked(withdrawWithToken).mockRejectedValue(new TypeError("Failed to fetch"));

    const { toJSON, UNSAFE_getByProps } = render(
      <ToastProvider>
        <WithdrawToken />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("That link didn't work");
    const onward = UNSAFE_getByProps({ accessibilityLabel: "Back to the feed" });
    expect(onward.props.href).toBe("/");
    expect(onward.props.accessibilityRole).toBe("link");
  });

  it("offers no link away while it is still working, and none on success", async () => {
    jest
      .mocked(withdrawWithToken)
      .mockResolvedValue({ id: "req-1", listing_id: "listing-1", withdrawn_at: Date.now() });

    const { queryByLabelText } = render(
      <ToastProvider>
        <WithdrawToken />
      </ToastProvider>,
    );

    // #357 added the link to the error branch only; the success card was
    // not touched, and it should stay the quiet "you're done" it was.
    expect(queryByLabelText("Back to the feed")).toBeNull();
    await act(async () => {
      await flush();
    });
    expect(queryByLabelText("Back to the feed")).toBeNull();
  });

  it("only posts once even if the effect re-runs (React StrictMode-safe)", async () => {
    jest
      .mocked(withdrawWithToken)
      .mockResolvedValue({ id: "req-1", listing_id: "listing-1", withdrawn_at: Date.now() });

    const { rerender } = render(
      <ToastProvider>
        <WithdrawToken />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });
    rerender(
      <ToastProvider>
        <WithdrawToken />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    expect(jest.mocked(withdrawWithToken)).toHaveBeenCalledTimes(1);
  });
});
