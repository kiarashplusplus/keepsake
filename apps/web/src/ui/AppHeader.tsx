import * as React from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { Link, usePathname, type Href } from "expo-router";
import { Icon, type IconName } from "@/ui/Icon";
import { space } from "@keepsake/tokens/spacing";
import { radii } from "@keepsake/tokens/radii";
import { type } from "@keepsake/tokens/typography";
import { useColors, useThemeMode, type ThemeMode } from "@/ui/theme";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { useViewport } from "@/ui/viewport";

const NEXT_MODE: Record<ThemeMode, ThemeMode> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const MODE_ICON: Record<ThemeMode, IconName> = {
  light: "sunny",
  dark: "moon",
  system: "contrast",
};

function ThemeToggle(): React.ReactElement {
  const colors = useColors();
  const { selectedMode, setMode } = useThemeMode();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Theme: ${selectedMode}. Tap to change.`}
      onPress={() => setMode(NEXT_MODE[selectedMode])}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: radii.pill,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name={MODE_ICON[selectedMode]} size={20} color={colors.ink} />
    </Pressable>
  );
}

/** A nav item in the second voice: bottle-green, with a 2px underline when it
 * is the current page (the site's `aria-current="page"` treatment). */
function navStyle(active: boolean, colors: ReturnType<typeof useColors>): ViewStyle {
  return {
    minHeight: 44,
    justifyContent: "center",
    borderBottomWidth: 2,
    borderBottomColor: active ? colors.accent : "transparent",
  };
}

function NavLink({ href, label, active, style }: { href: Href; label: string; active: boolean; style?: ViewStyle }): React.ReactElement {
  const colors = useColors();
  return (
    // Flattened, not an array: `Link asChild` hands this `Pressable`'s props
    // through expo-router's slot, and in the static export an array style
    // reached the DOM as `style="0:[object Object];1:[object Object]"` —
    // every rule in it lost, including the `display` switch that is supposed
    // to hide `Browse` on a phone. A single object survives the trip.
    <Link href={href} asChild>
      <Pressable accessibilityRole="link" accessibilityState={{ selected: active }} style={StyleSheet.flatten([navStyle(active, colors), style])}>
        <Text variant="label" color="ink" style={{ fontSize: 12 }}>
          {label}
        </Text>
      </Pressable>
    </Link>
  );
}

/** `/about` is a static page from apps/site, not an app route, so it is a
 * plain anchor (react-native-web renders a View with `href` as `<a>`) rather
 * than a typed expo-router `Link`. */
function SiteLink({ href, label, style }: { href: string; label: string; style?: ViewStyle }): React.ReactElement {
  const colors = useColors();
  return (
    <View accessibilityRole="link" {...({ href } as object)} style={[navStyle(false, colors), style]}>
      <Text variant="label" color="ink" style={{ fontSize: 12 }}>
        {label}
      </Text>
    </View>
  );
}

export function AppHeader(): React.ReactElement {
  const colors = useColors();
  const pathname = usePathname();
  // Width comes from CSS, not from `useWindowDimensions()` — see
  // `packages/tokens/src/breakpoints.ts`. This header is on every route, so
  // it was the most visible half of the snap: a desktop visitor's first paint
  // was the 64px phone bar with a 23px wordmark and no `Browse`/`About`.
  const vp = useViewport();

  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.rule,
        zIndex: 10,
      }}
    >
      <ReadableWidth
        variant="grid"
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.lg,
          minHeight: vp.step(64, 76),
        }}
      >
        <Link href="/" accessibilityLabel="Keepsake, home">
          <Text
            testID="wordmark"
            variant="wordmark"
            fontVariationSettings={type.wordmark.fontVariationSettings}
            style={{ fontSize: vp.step(23, type.wordmark.fontSize), lineHeight: vp.step(28, type.wordmark.lineHeight) }}
          >
            Keepsake
          </Text>
        </Link>

        <View style={{ flexDirection: "row", alignItems: "center", gap: vp.step(space.md, space.xl) }}>
          <NavLink href="/" label="Browse" active={pathname === "/"} style={vp.wideOnly} />
          <NavLink href="/mine" label="Mine" active={pathname.startsWith("/mine")} />
          <SiteLink href="/about" label="About" style={vp.wideOnly} />
          {/* `dangerouslySingular`: the root stack keeps the give flow
              mounted (hidden) under whatever the giver navigated to from
              inside it, and a plain push then stacked a *second* give flow
              on top — two providers, two photos screens, and a hidden one
              still holding an upload nobody could see. Singular keeps the
              stack to one give flow: with one already mounted, this lands
              the giver back on it — same provider, same previews, same
              in-flight uploads — and only a fresh visit mounts a new one.
              Same on the feed's own Give buttons (`app/index.tsx`). */}
          {/* Two labels, one per width, rather than one label picked in JS.
              A label is markup, and markup picked from the viewport is
              precisely what one static export cannot get right for everyone
              (`packages/tokens/src/breakpoints.ts`). The hidden one generates
              no box: it is out of the tab order and the accessibility tree,
              and contributes nothing to this row's `gap`. */}
          <View style={vp.wideOnly}>
            <Link href="/give" dangerouslySingular asChild>
              <Button label="Give something" />
            </Link>
          </View>
          <View style={vp.narrowOnly}>
            <Link href="/give" dangerouslySingular asChild>
              <Button label="Give" />
            </Link>
          </View>
          <ThemeToggle />
        </View>
      </ReadableWidth>
    </View>
  );
}
