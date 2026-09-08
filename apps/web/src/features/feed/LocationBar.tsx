// Feed location controls: country + postcode (or "Use my location"), and a
// radius chip row that includes "Anywhere" alongside the API's four
// `RADIUS_OPTIONS`. Persists every change to `prefStore` itself (rather than
// leaving that to the feed page) so the location survives a reload no matter
// which screen mounts this component.
import * as React from "react";
import { View } from "react-native";
import { RADIUS_OPTIONS } from "@keepsake/contracts/feed";
import { COUNTRIES, COUNTRY_LABELS, COUNTRY_POSTCODE_HINTS, type Country } from "@keepsake/contracts/geo";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Chip } from "@/ui/Chip";
import { Input } from "@/ui/Input";
import { Button } from "@/ui/Button";
import { saveLocationPref, type LocationPref, type RadiusChoice } from "@/lib/geo";
import { locateOnce } from "@/lib/geoLocate";

export type LocationBarProps = {
  value: LocationPref;
  onChange: (pref: LocationPref) => void;
};

const RADIUS_CHOICES: readonly RadiusChoice[] = [...RADIUS_OPTIONS, "anywhere"];

function radiusLabel(radius: RadiusChoice): string {
  return radius === "anywhere" ? "Anywhere" : `${radius} mi`;
}

export function LocationBar({ value, onChange }: LocationBarProps): React.ReactElement {
  const [geoError, setGeoError] = React.useState<string | null>(null);
  const [locating, setLocating] = React.useState(false);

  function commit(next: LocationPref): void {
    onChange(next);
    void saveLocationPref(next);
  }

  function handleCountry(country: Country): void {
    commit({ ...value, mode: value.postal.trim() === "" ? "none" : "postal", country, lat: null, lng: null });
  }

  function handlePostal(postal: string): void {
    commit({ ...value, mode: postal.trim() === "" ? "none" : "postal", postal, lat: null, lng: null });
  }

  function handleRadius(radius: RadiusChoice): void {
    commit({ ...value, radius });
  }

  /** Leaves coordinate mode and hands the postcode field back. Whatever the
   * visitor had typed before they pressed "Use my location" is still in
   * `postal` (coordinate mode keeps it rather than blanking it), so this
   * restores that search instead of dropping them back to no filter. */
  function handleUsePostcode(): void {
    setGeoError(null);
    commit({ ...value, mode: value.postal.trim() === "" ? "none" : "postal", lat: null, lng: null });
  }

  function handleUseMyLocation(): void {
    // `locateOnce` must be called synchronously from this press handler
    // (not after an `await`) or iOS Safari can silently drop the
    // permission prompt — see `lib/geoLocate.ts`.
    setGeoError(null);
    setLocating(true);
    locateOnce(
      (coords) => {
        setLocating(false);
        commit({ ...value, mode: "coords", lat: coords.lat, lng: coords.lng });
      },
      // Same reasoning as `app/give/details.tsx` (#132): `geoLocate.ts`
      // already distinguishes a denied permission from an unavailable
      // position from a timeout, and each has a different fix. Every one of
      // its messages ends in "Enter it manually", which is what the postcode
      // field directly above this button is for.
      (message) => {
        setLocating(false);
        setGeoError(message);
      },
    );
  }

  return (
    <View style={{ gap: space.md }}>
      <Eyebrow>Near</Eyebrow>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {COUNTRIES.map((country) => (
          <Chip
            key={country}
            label={COUNTRY_LABELS[country]}
            selected={value.mode !== "coords" && value.country === country}
            onPress={() => handleCountry(country)}
          />
        ))}
      </View>

      {/* Coordinate mode replaces the postcode field rather than emptying it.
          Reported from a phone: once the device permission prompt was
          allowed, the field went blank and kept its "5-digit ZIP code"
          placeholder under a "POSTCODE" label, so the one control on screen
          read as an unfilled required field — while the helper line under it
          said the postcode was no longer being used at all. There is nothing
          to put in it (we hold coordinates, not a postcode, and don't reverse
          geocode), so the honest state is a plain confirmation plus the way
          back. */}
      {value.mode === "coords" ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, alignItems: "center" }}>
          <Text variant="body">Using your current location.</Text>
          <Button label="Use a postcode instead" variant="link" arrow={false} onPress={handleUsePostcode} />
        </View>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, alignItems: "flex-end" }}>
          <Input
            label="Postcode"
            value={value.postal}
            onChangeText={handlePostal}
            placeholder={COUNTRY_POSTCODE_HINTS[value.country]}
            style={{ minWidth: 160 }}
          />
          <Button label={locating ? "Locating…" : "Use my location"} variant="secondary" loading={locating} onPress={handleUseMyLocation} />
        </View>
      )}

      {geoError !== null ? (
        <Text variant="caption" color="dangerText">
          {geoError}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {RADIUS_CHOICES.map((radius) => (
          <Chip key={String(radius)} label={radiusLabel(radius)} selected={value.radius === radius} onPress={() => handleRadius(radius)} />
        ))}
      </View>
    </View>
  );
}
