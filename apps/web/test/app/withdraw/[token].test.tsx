import * as React from "react";
import { act, render } from "@testing-library/react-native";
import { ToastProvider } from "@/ui/Toast";
import { withdrawWithToken } from "@/api/withdraw";
import { ApiError } from "@/api/client";
import WithdrawToken from "../../../app/withdraw/[token]";

// Same shape as test/app/recover/[token].test.tsx — the page this one
// mirrors (see app/withdraw/[token].tsx's file header).
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ token: "withdraw-token-abc" }),
}));

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

    const { toJSON } = render(
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
