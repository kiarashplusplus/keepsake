// Give flow — step 3 of 5: title, country + postcode. No category picker —
// issue #35 removed it; `draft.category` now follows the cover photo's AI
// suggestion alone (`giveDraft.ts`'s `set_suggestion`), defaulting to
// "other" until one lands. The postcode field debounces into a live
// `GET /api/geo/lookup` so the giver sees the resolved place ("Somerville,
// MA") before ever submitting.
import * as React from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { TITLE_MAX } from "@keepsake/contracts/listing";
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
import { TitleFieldSchema } from "@/features/give/giveValidation";
import { lookupPostalCode } from "@/api/geo";
import { locateOnce } from "@/lib/geoLocate";
import { MANUAL_ENTRY_MESSAGE, reverseGeocode } from "@/lib/geoReverse";

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

  const canContinue = titleValidation.success && isResolvedForCurrent && lookupResult !== null;

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
      // `geoLocate.ts` has already worked out *which* of the three things
      // went wrong — permission denied, position unavailable, or a timeout —
      // and each one has a different fix for the giver. Substituting
      // `MANUAL_ENTRY_MESSAGE` here (which is what this did before #132)
      // threw that away and made a blocked permission look identical to a
      // reverse-geocode failure.
      (message) => {
        setLocating(false);
        setGeoError(message);
      },
    );
  }

  const cover = coverPhoto(draft);
  const showSuggestionNote = cover !== null && draft.appliedSuggestionPhotoId !== null && draft.appliedSuggestionPhotoId === cover.id;

  // Issue #224: this line used to repeat `COUNTRY_POSTCODE_HINTS[country]`
  // — the exact string already sitting in the field as its placeholder, so
  // the giver read "5-digit ZIP code" twice, two lines apart, and learned
  // nothing from the second one. The format is the placeholder's job; the
  // helper's job is the question a giver actually has when a free gifting
  // site asks where they live.
  //
  // The claim is precise, and the code backs it: a listing carries
  // `postal_code` on `OwnerListing` only — `PublicListing`
  // (`packages/contracts/src/listing.ts`) exposes `place_name`/`admin1` and
  // nothing finer, which is what `ListingCard`'s and the item page's caption
  // lines render. The postcode is resolved to the centroid of a whole ZIP
  // (US) or Forward Sortation Area (CA) against a bundled GeoNames table,
  // never to a street (`docs/design/geo.md`). Do not soften this into "we
  // keep your location private" or sharpen it into a promise about an
  // address we never ask for in the first place.
  const postcodeHelper =
    normalized === null || !isResolvedForCurrent
      ? "Only the town it resolves to appears on your listing — never the postcode itself."
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
              // Issue #224: this was `minWidth: 160` alone, which in a
              // wrapping flex row is a floor and nothing else — the field
              // never grew, so its ink baseline stopped short of the Title
              // field's directly above it and read as an unfinished control
              // rather than a deliberately smaller one. `flexGrow` makes it
              // take whatever the row has left after the button; the basis
              // is what decides whether the button fits beside it (wide) or
              // wraps below it (a phone), and once wrapped the field is
              // alone on its row and grows to the full width, matching
              // Title exactly. `minWidth` stays as the floor it always was.
              style={{ flexGrow: 1, flexBasis: 200, minWidth: 160 }}
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
