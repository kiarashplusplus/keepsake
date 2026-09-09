import * as React from "react";
import { TextInput } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { LocationBar } from "@/features/feed/LocationBar";
import { Button } from "@/ui/Button";
import { DEFAULT_LOCATION_PREF, LOCATION_PREF_STORAGE_KEY, type LocationPref } from "@/lib/geo";
import { locateOnce } from "@/lib/geoLocate";

// The real `locateOnce` reaches for `navigator.geolocation`, and swapping the
// whole `navigator` out from under react-native-web mid-render is more
// disruptive than mocking the one module — `test/lib/geoLocate.test.ts`
// already covers the browser call itself.
jest.mock("@/lib/geoLocate", () => ({ locateOnce: jest.fn() }));

const locateOnceMock = locateOnce as jest.MockedFunction<typeof locateOnce>;

/** Presses "Use my location" and resolves the pending `locateOnce` with a
 * position, the way an allowed device permission prompt would. */
async function locateSuccessfully(press: (label: string) => void, coords = { lat: 42.39, lng: -71.1 }): Promise<void> {
  await act(async () => {
    press("Use my location");
    await Promise.resolve();
  });
  const call = locateOnceMock.mock.calls[0];
  if (call === undefined) throw new Error("Expected locateOnce to have been called");
  const [onSuccess] = call;
  await act(async () => {
    onSuccess(coords);
    await Promise.resolve();
  });
}

function Harness({ onChange }: { onChange: (pref: LocationPref) => void }): React.ReactElement {
  const [value, setValue] = React.useState<LocationPref>(DEFAULT_LOCATION_PREF);
  return (
    <LocationBar
      value={value}
      onChange={(pref) => {
        setValue(pref);
        onChange(pref);
      }}
    />
  );
}

describe("LocationBar", () => {
  beforeEach(() => {
    window.localStorage.clear();
    locateOnceMock.mockReset();
  });

  it("persists a radius change to prefStore under the versioned key", async () => {
    const onChange = jest.fn();
    // `getByText`/`getByRole` don't reliably match react-native-web's
    // react-test-renderer output at these pinned library versions (see
    // test/ui/Button.test.tsx's header comment) — `UNSAFE_getByProps`
    // against the Chip's own `accessibilityLabel` (set to its visible
    // label) is the same workaround used there.
    const { UNSAFE_getByProps } = render(<Harness onChange={onChange} />);

    const chip = UNSAFE_getByProps({ accessibilityLabel: "50 mi" });
    await act(async () => {
      fireEvent.press(chip);
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ radius: 50 }));
    const stored = window.localStorage.getItem(LOCATION_PREF_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toMatchObject({ radius: 50 });
  });

  it("persists a postcode change and switches mode to postal", async () => {
    const onChange = jest.fn();
    const { UNSAFE_getAllByType } = render(<Harness onChange={onChange} />);

    const postcodeField = UNSAFE_getAllByType(TextInput)[0];
    if (postcodeField === undefined) throw new Error("Expected the postcode TextInput");

    await act(async () => {
      fireEvent.changeText(postcodeField, "02144");
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: "postal", postal: "02144" }));
    const stored = JSON.parse(window.localStorage.getItem(LOCATION_PREF_STORAGE_KEY) as string);
    expect(stored).toMatchObject({ mode: "postal", postal: "02144" });
  });

  it("replaces the postcode field with a confirmation once coordinates arrive", async () => {
    const onChange = jest.fn();
    const { UNSAFE_getByProps, UNSAFE_queryAllByType, UNSAFE_queryByProps } = render(<Harness onChange={onChange} />);

    await locateSuccessfully((label) => {
      fireEvent.press(UNSAFE_getByProps({ accessibilityLabel: label }));
    });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: "coords", lat: 42.39, lng: -71.1 }));
    // The empty-looking postcode field is gone, not merely blanked...
    expect(UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
    expect(UNSAFE_queryByProps({ accessibilityLabel: "Use my location" })).toBeNull();
    // ...and there is a way back to entering one by hand.
    expect(UNSAFE_queryByProps({ accessibilityLabel: "Use a postcode instead" })).not.toBeNull();
  });

  it("restores the postcode the visitor had typed when they leave coordinate mode", async () => {
    const onChange = jest.fn();
    const { UNSAFE_getAllByType, UNSAFE_getByProps, UNSAFE_queryAllByType } = render(<Harness onChange={onChange} />);

    const postcodeField = UNSAFE_getAllByType(TextInput)[0];
    if (postcodeField === undefined) throw new Error("Expected the postcode TextInput");
    await act(async () => {
      fireEvent.changeText(postcodeField, "02144");
      await Promise.resolve();
    });

    await locateSuccessfully((label) => {
      fireEvent.press(UNSAFE_getByProps({ accessibilityLabel: label }));
    });

    await act(async () => {
      fireEvent.press(UNSAFE_getByProps({ accessibilityLabel: "Use a postcode instead" }));
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "postal", postal: "02144", lat: null, lng: null }));
    const restored = UNSAFE_queryAllByType(TextInput)[0];
    if (restored === undefined) throw new Error("Expected the postcode TextInput to come back");
    expect(restored.props.value).toBe("02144");
    expect(JSON.parse(window.localStorage.getItem(LOCATION_PREF_STORAGE_KEY) as string)).toMatchObject({ mode: "postal", postal: "02144" });
  });

  // Issue #373 finding 5: the baseline screenshot (`feed-location.jpg`, both
  // projects) showed "Use my location" as a heavy filled `secondary` button
  // outweighing the panel's actual apply/close control ("Done", the summary
  // row `LocationDisclosure` renders as a quiet text link in `app/index.tsx`).
  // Asserting the rendered `Button`'s `variant` prop — rather than a colour
  // or style snapshot — pins the fix to the thing that actually carries the
  // visual weight, and fails again if this regresses back to `secondary`.
  it("renders 'Use my location' as a quiet link, not the panel's heaviest control", () => {
    const { UNSAFE_getByProps } = render(<Harness onChange={jest.fn()} />);

    const useMyLocation = UNSAFE_getByProps({ label: "Use my location" });

    expect(useMyLocation.props.variant).toBe("link");
    expect(useMyLocation.props.variant).not.toBe("secondary");
    expect(useMyLocation.type).toBe(Button);
  });
});
