import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { ToastProvider } from "@/ui/Toast";
import { getMe, setEmail } from "@/api/me";
import { getOrCreateOwnerToken } from "@/lib/ownerToken";
import MineEmail from "../../../app/mine/email";

jest.mock("@/api/me", () => ({ getMe: jest.fn(), setEmail: jest.fn(), deleteEmail: jest.fn() }));

// A fake widget that starts `ready` with one token and lets the test decide
// exactly when a fresh one arrives — the real widget's own async challenge
// is what made this bug hard to see: it usually *does* refresh eventually,
// which is exactly how "Save then Resend fails today" stayed unnoticed.
let latestOnStatus: ((status: { status: "ready"; token: string } | { status: "pending" }) => void) | null = null;
jest.mock("@/ui/Turnstile", () => {
  const ReactActual = jest.requireActual("react");
  return {
    Turnstile: ReactActual.forwardRef(
      (
        { onStatus }: { onStatus: (status: { status: "ready"; token: string } | { status: "pending" }) => void },
        ref: React.Ref<{ reset: () => void }>,
      ) => {
        latestOnStatus = onStatus;
        ReactActual.useImperativeHandle(ref, () => ({ reset: () => onStatus({ status: "pending" }) }), [onStatus]);
        ReactActual.useEffect(() => {
          onStatus({ status: "ready", token: "T1" });
        }, [onStatus]);
        return null;
      },
    ),
  };
});

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
}

describe("mine/email", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.mocked(getMe).mockReset();
    jest.mocked(setEmail).mockReset();
    latestOnStatus = null;
  });

  it("shows the unverified state and a Resend action", async () => {
    getOrCreateOwnerToken();
    jest.mocked(getMe).mockResolvedValue({ id: "01OWNERAAAAAAAAAAAAAAAAAA", email: "person@keepsake.ing", email_verified: false, banned: false });

    const { toJSON, UNSAFE_queryAllByProps } = render(
      <ToastProvider>
        <MineEmail />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    const rendered = JSON.stringify(toJSON());
    expect(rendered).toContain("Not verified yet");
    expect(rendered).toContain('"borderLeftWidth":"3px"');
    expect(UNSAFE_queryAllByProps({ accessibilityLabel: "Resend" }).length).toBeGreaterThan(0);
  });

  it("shows the verified state without a Resend action", async () => {
    getOrCreateOwnerToken();
    jest.mocked(getMe).mockResolvedValue({ id: "01OWNERAAAAAAAAAAAAAAAAAA", email: "person@keepsake.ing", email_verified: true, banned: false });

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

  it("GUARD: Save then Resend does not reuse the same single-use Turnstile token", async () => {
    getOrCreateOwnerToken();
    jest.mocked(getMe).mockResolvedValue({ id: "01OWNERAAAAAAAAAAAAAAAAAA", email: "person@keepsake.ing", email_verified: false, banned: false });
    jest.mocked(setEmail).mockResolvedValue({ id: "01OWNERAAAAAAAAAAAAAAAAAA", email: "person@keepsake.ing", email_verified: false, banned: false });

    const { UNSAFE_getByProps } = render(
      <ToastProvider>
        <MineEmail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    const saveButton = UNSAFE_getByProps({ accessibilityLabel: "Save" });
    await act(async () => {
      fireEvent.press(saveButton);
      await flush();
    });

    expect(jest.mocked(setEmail)).toHaveBeenNthCalledWith(1, { email: "person@keepsake.ing" }, expect.objectContaining({ turnstileToken: "T1" }));

    // The token was single-use and just got spent: `spendTurnstileToken()`
    // resets the widget, which (in the real widget) starts fetching a new
    // one — until it arrives, Resend must stay disabled rather than able
    // to fire with the same "T1" that just got used.
    const resendButtonWhilePending = UNSAFE_getByProps({ accessibilityLabel: "Resend" });
    expect(resendButtonWhilePending.props.disabled).toBe(true);

    // The widget's own challenge resolves with a fresh token.
    await act(async () => {
      latestOnStatus?.({ status: "ready", token: "T2" });
      await flush();
    });

    const resendButtonReady = UNSAFE_getByProps({ accessibilityLabel: "Resend" });
    expect(resendButtonReady.props.disabled).toBe(false);
    await act(async () => {
      fireEvent.press(resendButtonReady);
      await flush();
    });

    expect(jest.mocked(setEmail)).toHaveBeenNthCalledWith(2, { email: "person@keepsake.ing" }, expect.objectContaining({ turnstileToken: "T2" }));
  });
});
