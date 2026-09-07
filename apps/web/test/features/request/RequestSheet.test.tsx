import * as React from "react";
import { TextInput } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { RequestSheet } from "@/features/request/RequestSheet";
import { createRequest } from "@/api/requests";
import { ApiError } from "@/api/client";

jest.mock("@/api/requests", () => ({ createRequest: jest.fn() }));

// See test/app/item/[id].test.tsx's header comment on why `Sheet` is mocked
// down to "render children" — RN `Modal`'s portal isn't supported by
// react-test-renderer.
jest.mock("@/ui/Sheet", () => {
  const ReactActual = jest.requireActual("react");
  return {
    Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? ReactActual.createElement(ReactActual.Fragment, null, children) : null,
  };
});

// Each field change gets its own `act`, rather than batching several
// `fireEvent` calls before a single `press`: batched synchronous updates can
// still be mid-flight when `press` reads the *previous* render's closure
// over `note`/`email`, so `handleSubmit` would validate against stale
// (empty) values and bail before ever calling `createRequest`.
async function fillAndSubmit(
  instance: ReturnType<typeof render>,
  note: string,
  email: string,
): Promise<void> {
  // Note, email, phone (optional), date of birth — in that render order
  // (see RequestSheet.tsx). Phone is skipped here (every test leaves it
  // blank); the date of birth field is the fourth `TextInput` on the page.
  const [noteField, emailField, , dobField] = instance.UNSAFE_getAllByType(TextInput);
  if (noteField === undefined || emailField === undefined || dobField === undefined) {
    throw new Error("Expected note, email, and date-of-birth fields");
  }

  await act(async () => {
    fireEvent.changeText(noteField, note);
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.changeText(emailField, email);
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.changeText(dobField, "1990-01-01");
    await Promise.resolve();
  });

  const sendButton = instance.UNSAFE_getByProps({ accessibilityLabel: "Send" });
  await act(async () => {
    fireEvent.press(sendButton);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RequestSheet", () => {
  beforeEach(() => {
    jest.mocked(createRequest).mockReset();
  });

  it("shows a validation message and does not submit when the note is too short", async () => {
    const instance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);

    await fillAndSubmit(instance, "too short", "person@keepsake.ing");

    expect(jest.mocked(createRequest)).not.toHaveBeenCalled();
    expect(JSON.stringify(instance.toJSON())).toContain("At least 10 characters");
  });

  it("shows the reserved-domain message inline and does not submit", async () => {
    const instance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);

    await fillAndSubmit(
      instance,
      "Tell them why it should be mine, please and thank you.",
      "me@example.com",
    );

    expect(jest.mocked(createRequest)).not.toHaveBeenCalled();
    expect(JSON.stringify(instance.toJSON())).toContain("That address can't receive mail — try another.");
  });

  it("submits and shows the sent state on success", async () => {
    jest.mocked(createRequest).mockResolvedValue({ id: "req-1", created_at: Date.now() });
    const instance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);

    await fillAndSubmit(instance, "Tell them why it should be mine, please and thank you.", "person@keepsake.ing");

    expect(jest.mocked(createRequest)).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(instance.toJSON())).toContain("Sent. The giver will choose in their own time.");
  });

  it("shows the 409 conflict message inline instead of a generic error", async () => {
    jest.mocked(createRequest).mockRejectedValue(new ApiError("conflict", "Already asked", 409));
    const instance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);

    await fillAndSubmit(instance, "Tell them why it should be mine, please and thank you.", "person@keepsake.ing");

    expect(JSON.stringify(instance.toJSON())).toContain("You've already asked for this one.");
  });

  it("shows the 410 gone message inline instead of a generic error", async () => {
    jest.mocked(createRequest).mockRejectedValue(new ApiError("gone", "Just given away", 410));
    const instance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);

    await fillAndSubmit(instance, "Tell them why it should be mine, please and thank you.", "person@keepsake.ing");

    expect(JSON.stringify(instance.toJSON())).toContain("This keepsake was just given to someone else.");
  });
});
