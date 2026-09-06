import * as React from "react";
import { act, render } from "@testing-library/react-native";
import { ToastProvider } from "@/ui/Toast";
import { recoverWithToken } from "@/api/recover";
import { getOwnerToken } from "@/lib/ownerToken";
import { ApiError } from "@/api/client";
import RecoverToken from "../../../app/recover/[token]";

const mockReplace = jest.fn();

jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useLocalSearchParams: () => ({ token: "rec-token-abc" }),
    useRouter: () => ({ replace: mockReplace }),
    Link: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
      asChild ? children : ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

jest.mock("@/api/recover", () => ({ recoverWithToken: jest.fn() }));

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe("recover/[token]", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.mocked(recoverWithToken).mockReset();
    mockReplace.mockClear();
  });

  it("stores the new owner token and redirects to /mine on success", async () => {
    jest.mocked(recoverWithToken).mockResolvedValue({ ownerToken: `ks_${"a".repeat(43)}` });

    render(
      <ToastProvider>
        <RecoverToken />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    expect(jest.mocked(recoverWithToken)).toHaveBeenCalledWith("rec-token-abc");
    expect(getOwnerToken()).toBe(`ks_${"a".repeat(43)}`);
    expect(mockReplace).toHaveBeenCalledWith("/mine");
  });

  it("shows an error state with a link back to /recover when the token is invalid", async () => {
    jest.mocked(recoverWithToken).mockRejectedValue(new ApiError("not_found", "That link didn't work.", 404));

    const { toJSON } = render(
      <ToastProvider>
        <RecoverToken />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    expect(mockReplace).not.toHaveBeenCalled();
    expect(JSON.stringify(toJSON())).toContain("That link didn't work.");
  });
});
