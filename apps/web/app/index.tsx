// The feed: location + search + category controls over a masonry grid of
// tag cards. URL state (`q`/`category`/`country`/`postal`/`radius_mi`) round
// trips through expo-router so a shared feed link reproduces the same view.
import * as React from "react";
import { Pressable, useWindowDimensions, View, type ViewStyle } from "react-native";
import { Link, useLocalSearchParams, useRouter } from "expo-router";
import type { Category } from "@keepsake/contracts/listing";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { Page } from "@/ui/Page";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Surface";
import { Skeleton } from "@/ui/Skeleton";
import { EmptyState } from "@/ui/EmptyState";
import { Print } from "@/ui/Print";
import { Stamp } from "@/ui/Stamp";
import { CategoryChips } from "@/features/feed/CategoryChips";
import { SearchBar } from "@/features/feed/SearchBar";
import { LocationBar } from "@/features/feed/LocationBar";
import { MasonryGrid } from "@/features/feed/MasonryGrid";
import { ListingCard } from "@/features/feed/ListingCard";
import { LoadMoreSentinel } from "@/features/feed/LoadMoreSentinel";
import { AspectShelves } from "@/features/feed/AspectShelves";
import { useFeed } from "@/features/feed/useFeed";
import { useShelves } from "@/features/feed/useShelves";
import { buildFeedQuery } from "@/features/feed/buildFeedQuery";
import { feedQueryFromUrlParams, urlParamsFromFeedQuery, type FeedUrlParams } from "@/features/feed/feedUrlParams";
import { describeLocationChoice, resolveFeedEmptyState, type FeedEmptyAction } from "@/features/feed/emptyState";
import { DEFAULT_LOCATION_PREF, loadLocationPref, saveLocationPref, type LocationPref } from "@/lib/geo";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";

const NARROW_BREAKPOINT = 640;

type RawParams = { q?: string; category?: string; country?: string; postal?: string; radius_mi?: string };

function SkeletonCards(): React.ReactElement {
  const photoGround = { aspectRatio: 4 / 5, width: "100%" } as const;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xxl }}>
      {[0, 1, 2, 3].map((index) => (
        <Print key={index} tiltDeg={((index % 2 === 0 ? 1 : -1) * (1 + index)) / 2} style={{ flexGrow: 1, flexBasis: 260, maxWidth: 360, padding: 10 }}>
          <Skeleton style={photoGround as never} />
          <View style={{ paddingTop: space.md, gap: space.sm }}>
            <Skeleton height={16} />
            <Skeleton height={20} width="70%" />
            <Skeleton height={14} width="50%" />
          </View>
        </Print>
      ))}
    </View>
  );
}

/**
 * The narrow-width location control, issue #219.
 *
 * At 390x844 the first screenful of `/` contained no keepsakes at all: hero,
 * search, chips, then `Near`, then the country chips, the postcode field,
 * "Use my location" and five radius chips — the viewport ran out mid-way
 * through the postcode field and the first card sat entirely below the fold.
 * The `LocationBar` is four rows of controls that most visits never touch,
 * and it was sitting between the visitor and the thing they came for.
 *
 * So on a phone it collapses behind this one summary row, which states the
 * choice currently in force ("Near · 25 mi of 02144", or "Near · anywhere")
 * and expands to reveal the untouched `LocationBar` underneath. Nothing
 * about the feed query, the URL params or the persisted preference changes —
 * this is purely what is on screen. Wide widths keep everything expanded,
 * where the row has always fitted.
 *
 * It is a real button, not a tappable label: `accessibilityRole="button"`
 * plus the RN-canonical `accessibilityState={{ expanded }}`. The raw
 * `aria-expanded` alongside it is not belt-and-braces — react-native-web
 * 0.21 builds its DOM props from `aria-expanded`/`accessibilityExpanded`
 * only (`createDOMProps/index.js`) and never reads `accessibilityState`, the
 * same gap `Chip.tsx` documents for `aria-pressed`. Without it the state
 * would be invisible to a screen reader and to axe.
 */
function LocationDisclosure({
  summary,
  expanded,
  onToggle,
  children,
}: {
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const colors = useColors();

  return (
    <View style={{ gap: space.md }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`Near · ${summary}. ${expanded ? "Hide the location controls" : "Change where you are looking"}`}
        {...({ "aria-expanded": expanded } as object)}
        onPress={onToggle}
        style={({ pressed }): ViewStyle => ({
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.md,
          minHeight: 44,
          // The lined-index-card baseline the fields it stands in for wear
          // (see `Input.tsx`) — this reads as the same kind of object, not
          // as a new control shape.
          borderBottomWidth: 2,
          borderBottomColor: colors.ink,
          opacity: pressed ? 0.75 : 1,
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, flexShrink: 1 }}>
          {/* Collapsed, this row IS the section heading, so it says "Near".
              Expanded, the `LocationBar` directly below renders its own
              `Near` eyebrow — printing a second one two lines above it reads
              as a mistake. The summary stays either way: it is a live
              readout of what the controls underneath currently add up to.
              The accessible label carries "Near · …" in both states, so
              nothing is lost to a screen reader. */}
          {expanded ? null : (
            <Text variant="eyebrow" color="accent2Text">
              Near
            </Text>
          )}
          <Text variant="caption" numberOfLines={1}>
            {summary}
          </Text>
        </View>
        <Text variant="label" color="accentText" style={{ fontSize: 11 }}>
          {expanded ? "Done" : "Change"}
        </Text>
      </Pressable>
      {expanded ? children : null}
    </View>
  );
}

export default function Feed(): React.ReactElement {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const narrow = width < NARROW_BREAKPOINT;
  const rawParams = useLocalSearchParams<RawParams>();

  // Read once, at mount, to seed initial state and the location-hydration
  // effect's merge below — not memoized against `rawParams` (a plain
  // function call is cheap enough not to need it, and `router.setParams`
  // below is this same screen's own write path for these params, so this
  // never needs to react to `rawParams` changing after mount).
  const urlQuery = feedQueryFromUrlParams(rawParams as Record<string, string | string[] | undefined>);

  const [category, setCategory] = React.useState<Category | null>(urlQuery.category ?? null);
  const [q, setQ] = React.useState(urlQuery.q ?? "");
  const [location, setLocation] = React.useState<LocationPref>(DEFAULT_LOCATION_PREF);
  const [locationHydrated, setLocationHydrated] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);
  // Issue #219: only consulted under `narrow` — at wide widths the
  // `LocationBar` is always on screen and this never comes into it.
  const [locationOpen, setLocationOpen] = React.useState(false);

  // `LocationBar` persists every change it makes itself, deliberately (see
  // its header comment), so anything on this page that changes the location
  // has to persist it the same way. The empty state's "widen the radius"
  // button is the first such thing: without this it would widen the radius,
  // find something, and then silently snap back to 25 mi on the next reload
  // with nothing to explain why.
  function commitLocation(next: LocationPref): void {
    setLocation(next);
    void saveLocationPref(next);
  }

  // Merge the persisted location preference with any location-shaped URL
  // params (a shared link wins over what's in prefStore) exactly once, on
  // mount, before the first feed fetch fires.
  React.useEffect(() => {
    let cancelled = false;
    loadLocationPref().then((pref) => {
      if (cancelled) return;
      const hasUrlPostal = urlQuery.country !== undefined || urlQuery.postal !== undefined;
      const merged: LocationPref = hasUrlPostal
        ? {
            mode: "postal",
            country: urlQuery.country ?? pref.country,
            postal: urlQuery.postal ?? pref.postal,
            lat: null,
            lng: null,
            radius: urlQuery.radius_mi ?? pref.radius,
          }
        : urlQuery.radius_mi !== undefined
          ? { ...pref, radius: urlQuery.radius_mi }
          : pref;
      setLocation(merged);
      setLocationHydrated(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const feedQuery = React.useMemo(() => buildFeedQuery({ category, q, location }), [category, q, location]);
  const { items, loading, loadingMore, error, hasMore, loadMore } = useFeed(feedQuery, {
    enabled: locationHydrated,
    reloadToken,
  });

  // Shelves (issue #39) are computed globally over the whole approved-listing
  // set, not scoped to the active query — showing them alongside an active
  // text search or category filter would surface prints that don't match
  // what the visitor asked to see, so they're only rendered on the
  // unfiltered browse view. Location stays out of that gate deliberately:
  // "browse near me" with no other filter is still exactly the browsing
  // intent shelves serve, and hiding them behind a postcode would make them
  // invisible for most real visits at today's catalogue size.
  const shelvesEligible = q.trim() === "" && category === null;
  const { shelves } = useShelves();
  const visibleShelves = shelvesEligible ? shelves : [];

  React.useEffect(() => {
    // Fires once the first page settles, not on every render — see
    // analytics.ts's "never from a render body" rule.
    if (!loading) track(AnalyticsEvents.FeedViewed);
  }, [loading]);

  // Reflect state back into the URL once the initial merge has happened, so
  // this effect never stomps the just-read URL params with the defaults.
  React.useEffect(() => {
    if (!locationHydrated) return;
    const params: FeedUrlParams = urlParamsFromFeedQuery({
      ...(q.trim() !== "" ? { q: q.trim() } : {}),
      ...(category !== null ? { category } : {}),
      ...(location.mode === "postal" && location.country !== undefined ? { country: location.country } : {}),
      ...(location.mode === "postal" && location.postal.trim() !== "" ? { postal: location.postal.trim() } : {}),
      ...(location.radius !== "anywhere" ? { radius_mi: location.radius } : {}),
    });
    router.setParams(params as never);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category, location, locationHydrated]);

  // Issue #220: which *kind* of empty this is, resolved in one pure place
  // (`features/feed/emptyState.ts`) so the three cases — an empty
  // marketplace, filters that match nothing, a radius drawn too tight — can
  // be unit-tested without rendering, and so the sentence and the buttons
  // under it can never describe different situations.
  const empty = React.useMemo(() => resolveFeedEmptyState({ q, category, location }), [q, category, location]);

  /** Every one of these really changes the state that produced the empty
   * page — that is the whole point of #220, which found a `Give something`
   * button offered to someone whose search had simply missed. The first
   * action is the one stamp-red primary (see `Button.tsx`'s header on why
   * there is only ever one). */
  function emptyAction(action: FeedEmptyAction, index: number): React.ReactElement {
    const variant = index === 0 ? "primary" : "secondary";
    switch (action.kind) {
      case "give":
        return (
          <Link key={action.kind} href="/give" asChild>
            <Button label={action.label} variant={variant} />
          </Link>
        );
      case "clearSearch":
        return <Button key={action.kind} label={action.label} variant={variant} onPress={() => setQ("")} />;
      case "clearCategory":
        return <Button key={action.kind} label={action.label} variant={variant} onPress={() => setCategory(null)} />;
      case "widenRadius":
        return (
          <Button
            key={action.kind}
            label={action.label}
            variant={variant}
            onPress={() => commitLocation({ ...location, radius: action.radius })}
          />
        );
    }
  }

  return (
    <Page
      variant="grid"
      contentContainerStyle={{ paddingTop: narrow ? sectionRhythm.normal : sectionRhythm.loose, paddingBottom: sectionRhythm.bookend, gap: sectionRhythm.tight }}
    >
      {/* A note pinned to the table announcing the site — the one place body
          copy sits inside a paper card, so it reads regardless of the room's
          lighting; the results below sit right on the visible table.

          Issue #219: on a phone this is cut down to the eyebrow and the
          headline. The deck largely restates `/welcome`, which a first-time
          visitor has just read and clicked through, and the `Give something`
          button duplicates the `Give` button the header already carries at
          this width (`AppHeader.tsx`) — three lines of body copy and a
          second copy of the same CTA were most of the reason the first card
          was below the fold. The full hero stays at wide widths, where it
          costs nothing. */}
      <Card style={{ maxWidth: 680, gap: narrow ? space.md : space.lg, transform: [{ rotate: "-0.4deg" }] }}>
        <Eyebrow tick>A free gifting marketplace</Eyebrow>
        <Text variant={narrow ? "displayLg" : "displayXl"}>Give a keepsake a second life.</Text>
        {narrow ? null : (
          <>
            <Text variant="bodyLg" color="textSecondary">
              Some things are too full of memory to sell and too good to throw away. Post the story, and let someone nearby who’ll love it come
              and get it.
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xl, marginTop: space.sm }}>
              <Link href="/give" asChild>
                <Button label="Give something" />
              </Link>
            </View>
          </>
        )}
      </Card>

      <Card style={{ gap: space.lg }}>
        <SearchBar value={q} onChange={setQ} />
        <CategoryChips value={category} onChange={setCategory} />
        {narrow ? (
          <LocationDisclosure summary={describeLocationChoice(location)} expanded={locationOpen} onToggle={() => setLocationOpen((open) => !open)}>
            <LocationBar value={location} onChange={setLocation} />
          </LocationDisclosure>
        ) : (
          <LocationBar value={location} onChange={setLocation} />
        )}
      </Card>

      <View style={{ gap: space.xl }}>
        {error !== null ? (
          <Card style={{ flexDirection: "row", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
            <Text variant="body" color="dangerText">
              {error}
            </Text>
            <Button label="Try again" variant="link" onPress={() => setReloadToken((n) => n + 1)} />
          </Card>
        ) : null}

        {loading ? (
          <SkeletonCards />
        ) : items.length === 0 ? (
          <EmptyState
            ornament={<Stamp state="idle" label={empty.stamp} />}
            eyebrow={empty.eyebrow}
            title={empty.title}
            // Spread rather than `line={empty.line}`: under
            // `exactOptionalPropertyTypes` an optional `line?: string` does
            // not accept an explicit `undefined`, and the empty-marketplace
            // case deliberately has no second line. Same idiom as the URL
            // params above.
            {...(empty.line !== undefined ? { line: empty.line } : {})}
            action={
              <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.md }}>
                {empty.actions.map((action, index) => emptyAction(action, index))}
              </View>
            }
          />
        ) : (
          <>
            {visibleShelves.length > 0 ? (
              <>
                <AspectShelves shelves={visibleShelves} />
                {/* Only labeled once there's something above it to be
                    distinguished from — on the far more common case today
                    (no aspect value clears the floor), the grid below is
                    the only thing on the page and needs no heading of its
                    own, exactly like before shelves existed. */}
                <Eyebrow tick>Everything nearby</Eyebrow>
              </>
            ) : null}

            <MasonryGrid
              items={items}
              keyOf={(listing) => listing.id}
              sizeOf={(listing) => {
                const cover = listing.photos[0];
                return cover !== undefined ? { width: cover.width, height: cover.height } : { width: 4, height: 5 };
              }}
              renderItem={(listing) => <ListingCard listing={listing} testID={listing.id === items[0]?.id ? "feed-card-first" : undefined} />}
            />

            {hasMore ? (
              <View style={{ alignItems: "center", gap: space.md }}>
                <Button label="More" variant="secondary" loading={loadingMore} onPress={loadMore} />
                <LoadMoreSentinel onVisible={loadMore} />
              </View>
            ) : null}
          </>
        )}
      </View>
    </Page>
  );
}
