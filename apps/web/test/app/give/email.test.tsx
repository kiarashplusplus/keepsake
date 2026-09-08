import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { GiveDraftProvider } from "@/features/give/GiveDraftContext";
import { getMe } from "@/api/me";
import { getOwnerToken } from "@/lib/ownerToken";
import GiveEmail from "../../../app/give/email";

const mockPush = jest.fn();

// Hoisted above the imports by babel-plugin-jest-hoist — see
// test/app/give/details.test.tsx's header for why the imports still resolve
// to these mocks.
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));

jest.mock("@/api/me", () => ({
  getMe: jest.fn(),
}));

jest.mock("@/lib/ownerToken", () => ({
  getOwnerToken: jest.fn(),
}));

async function renderStep(): Promise<void> {
  render(
    <GiveDraftProvider>
      <GiveEmail />
    </GiveDraftProvider>,
  );
  // Lets the `getMe` prefill effect resolve before anything is asserted.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function typeEmail(value: string): void {
  act(() => {
    fireEvent.changeText(screen.getByLabelText("Email"), value);
  });
}

function pressContinue(): void {
  act(() => {
    fireEvent.press(screen.getByLabelText("Continue"));
  });
}

describe("give/email", () => {
  beforeEach(() => {
    // `GiveDraftProvider` rehydrates from `sessionStorage`, which persists
    // across cases in a file — without this, one case's address becomes the
    // next case's prefill.
    window.sessionStorage.clear();
    mockPush.mockReset();
    jest.mocked(getMe).mockReset().mockRejectedValue(new Error("no owner"));
    jest.mocked(getOwnerToken).mockReset().mockReturnValue(null);
  });

  it("offers no way past the step without an address", async () => {
    await renderStep();

    // The Skip this step used to carry is the whole bug: skipping produced a
    // listing whose asks could never reach anyone.
    expect(screen.queryByLabelText("Skip")).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toContain("Skip");
  });

  it("refuses to continue on an empty field, and says why", async () => {
    await renderStep();

    pressContinue();

    expect(mockPush).not.toHaveBeenCalled();
    expect(JSON.stringify(screen.toJSON())).toContain("We need an email to tell you when someone asks");
  });

  it("refuses an address that cannot receive mail", async () => {
    await renderStep();

    typeEmail("someone@example.com");
    pressContinue();

    expect(mockPush).not.toHaveBeenCalled();
    expect(JSON.stringify(screen.toJSON())).toContain("can't receive mail");
  });

  it("refuses something that isn't an address at all", async () => {
    await renderStep();

    typeEmail("not-an-address");
    pressContinue();

    expect(mockPush).not.toHaveBeenCalled();
    expect(JSON.stringify(screen.toJSON())).toContain("doesn't look like an email address");
  });

  it("continues to the review step on a real address", async () => {
    await renderStep();

    typeEmail("giver@keepsake.ing");
    pressContinue();

    expect(mockPush).toHaveBeenCalledWith("/give/review");
  });

  it("prefills the address this device's owner already has, and says it is verified", async () => {
    jest.mocked(getOwnerToken).mockReturnValue("ks_test");
    jest.mocked(getMe).mockResolvedValue({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      email: "giver@keepsake.ing",
      email_verified: true,
      banned: false,
    });

    await renderStep();

    expect(screen.getByLabelText("Email").props.value).toBe("giver@keepsake.ing");
    expect(JSON.stringify(screen.toJSON())).toContain("Verified already");

    pressContinue();
    expect(mockPush).toHaveBeenCalledWith("/give/review");
  });

  it("does not overwrite an address already in the draft with the prefill", async () => {
    jest.mocked(getOwnerToken).mockReturnValue("ks_test");
    let release: (() => void) | null = null;
    jest.mocked(getMe).mockReturnValue(
      new Promise((resolve) => {
        release = () =>
          resolve({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", email: "old@keepsake.ing", email_verified: true, banned: false });
      }),
    );

    await renderStep();
    typeEmail("new@keepsake.ing");

    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Email").props.value).toBe("new@keepsake.ing");
  });

  it("leaves the giver typing when the account lookup fails", async () => {
    jest.mocked(getOwnerToken).mockReturnValue("ks_test");
    jest.mocked(getMe).mockRejectedValue(new Error("offline"));

    await renderStep();

    expect(screen.getByLabelText("Email").props.value).toBe("");
    typeEmail("giver@keepsake.ing");
    pressContinue();
    expect(mockPush).toHaveBeenCalledWith("/give/review");
  });
});
