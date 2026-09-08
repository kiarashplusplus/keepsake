import * as React from "react";
import { TextInput } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { COUNTRY_POSTCODE_HINTS } from "@keepsake/contracts/geo";
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
    // `GiveDraftProvider` rehydrates from `sessionStorage`, which persists
    // across tests in a file — so without this each case inherits whatever
    // postcode the one before it typed, and the order of the cases becomes
    // part of what they assert.
    window.sessionStorage.clear();
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

  /**
   * Issue #224. Before a lookup resolves, the helper under the postcode
   * field used to be `COUNTRY_POSTCODE_HINTS[country]` — the exact string
   * already sitting in the field as its placeholder, printed twice two lines
   * apart.
   *
   * Asserting only that the two strings now differ would pass for any second
   * copy of the format ("five digits", "e.g. 02144"), so this counts: the
   * hint appears exactly ONCE in the rendered screen, as the placeholder.
   * The second assertion pins what replaced it — the one thing a giver
   * actually wants to know at this field, and a claim the contracts back
   * (`postal_code` is on `OwnerListing` only; `PublicListing` carries
   * `place_name`/`admin1` and nothing finer).
   */
  it("does not repeat the postcode placeholder as its own helper line", () => {
    const { toJSON } = render(
      <GiveDraftProvider>
        <GiveDetails />
      </GiveDraftProvider>,
    );

    const json = JSON.stringify(toJSON());
    // The draft starts on "US" (`GIVE_DRAFT_INITIAL`), so this is the hint in play.
    expect(json.split(COUNTRY_POSTCODE_HINTS.US)).toHaveLength(2);
    expect(json).toContain("never the postcode itself");
  });
});
