import * as React from "react";
import { act, render } from "@testing-library/react-native";
import { ToastProvider } from "@/ui/Toast";
import { getMe } from "@/api/me";
import { getOrCreateOwnerToken } from "@/lib/ownerToken";
import MineEmail from "../../../app/mine/email";

jest.mock("@/api/me", () => ({ getMe: jest.fn(), setEmail: jest.fn(), deleteEmail: jest.fn() }));

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
}

describe("mine/email", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.mocked(getMe).mockReset();
  });

  it("shows the unverified state and a Resend action", async () => {
    getOrCreateOwnerToken();
    jest.mocked(getMe).mockResolvedValue({ id: "01OWNERAAAAAAAAAAAAAAAAAA", email: "person@example.com", email_verified: false, banned: false });

    const { toJSON, UNSAFE_queryAllByProps } = render(
      <ToastProvider>
        <MineEmail />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Not verified yet");
    expect(UNSAFE_queryAllByProps({ accessibilityLabel: "Resend" }).length).toBeGreaterThan(0);
  });

  it("shows the verified state without a Resend action", async () => {
    getOrCreateOwnerToken();
    jest.mocked(getMe).mockResolvedValue({ id: "01OWNERAAAAAAAAAAAAAAAAAA", email: "person@example.com", email_verified: true, banned: false });

    const { toJSON, UNSAFE_queryAllByProps } = render(
      <ToastProvider>
        <MineEmail />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Verified.");
    expect(UNSAFE_queryAllByProps({ accessibilityLabel: "Resend" }).length).toBe(0);
  });
});
