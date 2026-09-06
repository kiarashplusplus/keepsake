import * as React from "react";
import { TextInput } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { GiveDraftProvider } from "@/features/give/GiveDraftContext";
import { lookupPostalCode } from "@/api/geo";
import GiveDetails from "../../../app/give/details";

// `jest.mock` calls are hoisted above these imports by babel-plugin-jest-hoist
// at transform time, so writing the mocked module's import in normal
// top-of-file order (rather than after the `jest.mock` call) still resolves
// to the mock — and avoids fighting `import/first`/`import/order`.
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@/api/geo", () => ({
  lookupPostalCode: jest.fn(),
}));

describe("give/details", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(lookupPostalCode).mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows the resolved place after a mocked geo lookup resolves", async () => {
    jest.mocked(lookupPostalCode).mockResolvedValue({
      country: "US",
      code: "02144",
      place_name: "Somerville",
      admin1: "MA",
      lat: 42.39,
      lng: -71.1,
    });

    const { toJSON, UNSAFE_getAllByType } = render(
      <GiveDraftProvider>
        <GiveDetails />
      </GiveDraftProvider>,
    );

    // Title is the first Input, postcode the second — see the field order in
    // app/give/details.tsx.
    const postcodeField = UNSAFE_getAllByType(TextInput)[1];
    if (postcodeField === undefined) throw new Error("Expected a second TextInput (the postcode field)");

    act(() => {
      fireEvent.changeText(postcodeField, "02144");
    });

    await act(async () => {
      jest.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(JSON.stringify(toJSON())).toContain("Somerville, MA");
  });

  it("shows the 'not found' copy when the lookup resolves to null", async () => {
    jest.mocked(lookupPostalCode).mockResolvedValue(null);

    const { toJSON, UNSAFE_getAllByType } = render(
      <GiveDraftProvider>
        <GiveDetails />
      </GiveDraftProvider>,
    );

    const postcodeField = UNSAFE_getAllByType(TextInput)[1];
    if (postcodeField === undefined) throw new Error("Expected a second TextInput (the postcode field)");

    act(() => {
      fireEvent.changeText(postcodeField, "00000");
    });

    await act(async () => {
      jest.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(JSON.stringify(toJSON())).toContain("We don't know that postcode yet.");
  });
});
