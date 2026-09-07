// Give flow — step 3 of 5: title, category, country + postcode. The
// postcode field debounces into a live `GET /api/geo/lookup` so the giver
// sees the resolved place ("Somerville, MA") before ever submitting.
import * as React from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { z } from "zod";
import { CATEGORIES, CATEGORY_LABELS, TITLE_MAX, TITLE_MIN } from "@keepsake/contracts/listing";
import { COUNTRIES, COUNTRY_LABELS, COUNTRY_POSTCODE_HINTS, normalizePostalCode, type Country, type PostalLookup } from "@keepsake/contracts/geo";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Input } from "@/ui/Input";
import { Chip } from "@/ui/Chip";
import { Button } from "@/ui/Button";
import { Page } from "@/ui/Page";
import { Card } from "@/ui/Surface";
import { useGiveDraft } from "@/features/give/GiveDraftContext";
import { coverPhoto } from "@/features/give/giveDraft";
import { lookupPostalCode } from "@/api/geo";
import { locateOnce } from "@/lib/geoLocate";
import { MANUAL_ENTRY_MESSAGE, reverseGeocode } from "@/lib/geoReverse";

const TitleFieldSchema = z.string().trim().min(TITLE_MIN).max(TITLE_MAX);
const LOOKUP_DEBOUNCE_MS = 400;

/** The last completed lookup, tagged with the exact (country, code) it
 * answers — so a stale response for a postcode the giver has since edited
 * away from never gets displayed or accepted, without needing a separate
 * "loading" state set synchronously at the top of the effect (which the
 * `react-hooks/set-state-in-effect` rule rightly flags: state should only be
 * set from the async callback that already has to run outside the effect's
 * synchronous body, not from the body itself). */
type Resolved = { country: Country; code: string; result: PostalLookup | null };

export default function GiveDetails(): React.ReactElement {
  const router = useRouter();
  const { draft, dispatch } = useGiveDraft();
  const [titleTouched, setTitleTouched] = React.useState(false);
  const [resolved, setResolved] = React.useState<Resolved | null>(null);
  const [locating, setLocating] = React.useState(false);
  const [geoError, setGeoError] = React.useState<string | null>(null);

  const normalized = normalizePostalCode(draft.country, draft.postalCode);

  React.useEffect(() => {
    if (normalized === null) return undefined;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      lookupPostalCode({ country: draft.country, code: normalized, signal: controller.signal })
        .then((result) => {
          setResolved({ country: draft.country, code: normalized, result });
        })
        .catch(() => {
          if (!controller.signal.aborted) setResolved({ country: draft.country, code: normalized, result: null });
        });
    }, LOOKUP_DEBOUNCE_MS);

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [draft.country, draft.postalCode, normalized]);

  const isResolvedForCurrent = normalized !== null && resolved !== null && resolved.country === draft.country && resolved.code === normalized;
  const lookupResult = isResolvedForCurrent ? resolved.result : null;

  const titleValidation = TitleFieldSchema.safeParse(draft.title);
  const titleError = titleTouched && !titleValidation.success ? titleValidation.error.issues[0]?.message : undefined;

  const canContinue = titleValidation.success && draft.category !== null && isResolvedForCurrent && lookupResult !== null;

  function handleContinue(): void {
    setTitleTouched(true);
    if (!canContinue) return;
    router.push("/give/email");
  }

  function handleUseMyLocation(): void {
    // `locateOnce` calls `navigator.geolocation.getCurrentPosition`
    // synchronously, inside this press handler — awaiting anything first
    // (even a microtask) can make iOS Safari silently drop the permission
    // prompt. See `lib/geoLocate.ts`.
    setGeoError(null);
    setLocating(true);
    locateOnce(
      (coords) => {
        reverseGeocode(coords.lat, coords.lng)
          .then((result) => {
            dispatch({ type: "set_postal_code", postalCode: result.postcode });
            // Coordinates never leave the browser — only the postcode (and,
            // here, a country code) either provider's response yields does.
            if (result.countryCode !== null && (COUNTRIES as readonly string[]).includes(result.countryCode)) {
              dispatch({ type: "set_country", country: result.countryCode as Country });
            }
          })
          .catch(() => setGeoError(MANUAL_ENTRY_MESSAGE))
          .finally(() => setLocating(false));
      },
      () => {
        setLocating(false);
        setGeoError(MANUAL_ENTRY_MESSAGE);
      },
    );
  }

  const cover = coverPhoto(draft);
  const showSuggestionNote = cover !== null && draft.appliedSuggestionPhotoId !== null && draft.appliedSuggestionPhotoId === cover.id;

  const postcodeHelper =
    normalized === null || !isResolvedForCurrent
      ? COUNTRY_POSTCODE_HINTS[draft.country]
      : lookupResult !== null
        ? `${lookupResult.place_name}${lookupResult.admin1 !== null ? `, ${lookupResult.admin1}` : ""}`
        : "We don't know that postcode yet.";

  return (
    // See app/give/index.tsx's comment on why this step wraps itself in a
    // `Page` rather than the shell doing it once.
    <Page>
      <Card style={{ gap: space.xl }}>
        <View style={{ gap: space.sm }}>
          <Eyebrow>Details</Eyebrow>
          <Text variant="displayLg">A few details.</Text>
        </View>

        <View style={{ gap: space.xs }}>
          <Input
            label="Title"
            value={draft.title}
            onChangeText={(title) => dispatch({ type: "set_title", title })}
            onBlur={() => setTitleTouched(true)}
            maxLength={TITLE_MAX}
            error={titleError}
            placeholder="A hand-thrown mug"
          />
          {showSuggestionNote ? (
            <Text variant="caption" color="textTertiary">
              Filled in from your photo. Change anything.
            </Text>
          ) : null}
        </View>

        <View style={{ gap: space.sm }}>
          <Text variant="eyebrow" color="accent2Text">
            Category
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {CATEGORIES.map((category) => (
              <Chip
                key={category}
                label={CATEGORY_LABELS[category]}
                selected={draft.category === category}
                onPress={() => dispatch({ type: "set_category", category })}
              />
            ))}
          </View>
        </View>

        <View style={{ gap: space.sm }}>
          <Text variant="eyebrow" color="accent2Text">
            Country
          </Text>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            {COUNTRIES.map((country) => (
              <Chip
                key={country}
                label={COUNTRY_LABELS[country]}
                selected={draft.country === country}
                onPress={() => dispatch({ type: "set_country", country })}
              />
            ))}
          </View>
        </View>

        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, alignItems: "flex-end" }}>
            <Input
              label="Postcode"
              value={draft.postalCode}
              onChangeText={(postalCode) => dispatch({ type: "set_postal_code", postalCode })}
              placeholder={COUNTRY_POSTCODE_HINTS[draft.country]}
              helper={postcodeHelper}
              style={{ minWidth: 160 }}
            />
            <Button label={locating ? "Locating…" : "Use my location"} variant="secondary" loading={locating} onPress={handleUseMyLocation} />
          </View>
          {geoError !== null ? (
            <Text variant="caption" color="dangerText">
              {geoError}
            </Text>
          ) : null}
        </View>

        <View style={{ flexDirection: "row" }}>
          <Button label="Continue" disabled={!canContinue} onPress={handleContinue} />
        </View>
      </Card>
    </Page>
  );
}
