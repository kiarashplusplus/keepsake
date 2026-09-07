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

  function handleUseMyLocation(): void {
    // `locateOnce` must be called synchronously from this press handler
    // (not after an `await`) or iOS Safari can silently drop the
    // permission prompt — see `lib/geoLocate.ts`.
    setGeoError(null);
    setLocating(true);
    locateOnce(
      (coords) => {
        setLocating(false);
        commit({ ...value, mode: "coords", postal: "", lat: coords.lat, lng: coords.lng });
      },
      () => {
        setLocating(false);
        setGeoError("Couldn't get your location. Try a postcode instead.");
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

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, alignItems: "flex-end" }}>
        <Input
          label="Postcode"
          value={value.mode === "coords" ? "" : value.postal}
          onChangeText={handlePostal}
          placeholder={COUNTRY_POSTCODE_HINTS[value.country]}
          helper={value.mode === "coords" ? "Using your current location." : undefined}
          style={{ minWidth: 160 }}
        />
        <Button label={locating ? "Locating…" : "Use my location"} variant="secondary" loading={locating} onPress={handleUseMyLocation} />
      </View>

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
