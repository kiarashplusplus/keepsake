// The feed: location + search + category controls over a masonry grid of
// tag cards. URL state (`q`/`category`/`country`/`postal`/`radius_mi`) round
// trips through expo-router so a shared feed link reproduces the same view.
import * as React from "react";
import { useWindowDimensions, View } from "react-native";
import { Link, useLocalSearchParams, useRouter } from "expo-router";
import type { Category } from "@keepsake/contracts/listing";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import { radii } from "@keepsake/tokens/radii";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { DeckleRule } from "@/ui/DeckleRule";
import { Skeleton } from "@/ui/Skeleton";
import { EmptyState } from "@/ui/EmptyState";
import { TagCard } from "@/ui/TagCard";
import { Seal } from "@/ui/Seal";
import { useColors } from "@/ui/theme";
import { CategoryChips } from "@/features/feed/CategoryChips";
import { SearchBar } from "@/features/feed/SearchBar";
import { LocationBar } from "@/features/feed/LocationBar";
import { MasonryGrid } from "@/features/feed/MasonryGrid";
import { ListingCard } from "@/features/feed/ListingCard";
import { LoadMoreSentinel } from "@/features/feed/LoadMoreSentinel";
import { useFeed } from "@/features/feed/useFeed";
import { buildFeedQuery } from "@/features/feed/buildFeedQuery";
import { feedQueryFromUrlParams, urlParamsFromFeedQuery, type FeedUrlParams } from "@/features/feed/feedUrlParams";
import { DEFAULT_LOCATION_PREF, loadLocationPref, type LocationPref } from "@/lib/geo";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";

const NARROW_BREAKPOINT = 640;

type RawParams = { q?: string; category?: string; country?: string; postal?: string; radius_mi?: string };

function SkeletonCards(): React.ReactElement {
  const colors = useColors();
  const photoGround = { aspectRatio: 4 / 5, width: "100%", borderRadius: 0, borderTopRightRadius: radii.tag } as const;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xxl }}>
      {[0, 1, 2, 3].map((index) => (
        <TagCard key={index} style={{ flexGrow: 1, flexBasis: 260, maxWidth: 360 }}>
          <Skeleton style={photoGround as never} />
          <View style={{ padding: space.lg, gap: space.sm, borderTopWidth: 1, borderStyle: "dashed", borderTopColor: colors.rule }}>
            <Skeleton height={16} />
            <Skeleton height={20} width="70%" />
            <Skeleton height={14} width="50%" />
          </View>
        </TagCard>
      ))}
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

  const emptyLine = React.useMemo(() => {
    if (location.mode === "postal" && location.postal.trim() !== "" && location.radius !== "anywhere") {
      return `Nothing within ${location.radius} mi of ${location.postal.trim()} yet. Try a wider radius.`;
    }
    if (location.mode === "coords" && location.radius !== "anywhere") {
      return `Nothing within ${location.radius} mi of your location yet. Try a wider radius.`;
    }
    return "Nothing here yet. Be the first to give something.";
  }, [location]);

  return (
    <ReadableWidth variant="grid" style={{ paddingTop: narrow ? sectionRhythm.normal : sectionRhythm.loose, paddingBottom: sectionRhythm.bookend, gap: sectionRhythm.tight }}>
      <View style={{ maxWidth: 680, gap: space.lg }}>
        <Eyebrow tick>A free gifting marketplace</Eyebrow>
        <Text variant={narrow ? "displayLg" : "displayXl"}>Give a keepsake a second life.</Text>
        <Text variant="bodyLg" color="textSecondary">
          Some things are too full of memory to sell and too good to throw away. Post the story, and let someone nearby who’ll love it come and
          get it.
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xl, marginTop: space.sm }}>
          <Link href="/give" asChild>
            <Button label="Give something" />
          </Link>
        </View>
      </View>

      <DeckleRule style={{ marginTop: sectionRhythm.tight }} />

      <View style={{ gap: space.lg }}>
        <SearchBar value={q} onChange={setQ} />
        <CategoryChips value={category} onChange={setCategory} />
        <LocationBar value={location} onChange={setLocation} />
      </View>

      <DeckleRule />

      <View style={{ gap: space.xl }}>
        {error !== null ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
            <Text variant="body" color="dangerText">
              {error}
            </Text>
            <Button label="Try again" variant="link" onPress={() => setReloadToken((n) => n + 1)} />
          </View>
        ) : null}

        {loading ? (
          <SkeletonCards />
        ) : items.length === 0 ? (
          <EmptyState
            ornament={<Seal state="idle" />}
            eyebrow="Nearby"
            title={emptyLine}
            action={
              <Link href="/give" asChild>
                <Button label="Give something" />
              </Link>
            }
          />
        ) : (
          <>
            <MasonryGrid
              items={items}
              keyOf={(listing) => listing.id}
              sizeOf={(listing) => {
                const cover = listing.photos[0];
                return cover !== undefined ? { width: cover.width, height: cover.height } : { width: 4, height: 5 };
              }}
              renderItem={(listing) => (
                <ListingCard listing={listing} tilt={items.indexOf(listing) % 2 === 0 ? 1 : -1} testID={listing.id === items[0]?.id ? "feed-card-first" : undefined} />
              )}
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
    </ReadableWidth>
  );
}
