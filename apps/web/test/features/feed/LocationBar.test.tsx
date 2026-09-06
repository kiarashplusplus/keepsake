import * as React from "react";
import { TextInput } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { LocationBar } from "@/features/feed/LocationBar";
import { DEFAULT_LOCATION_PREF, LOCATION_PREF_STORAGE_KEY, type LocationPref } from "@/lib/geo";

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
});
