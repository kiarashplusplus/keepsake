import * as React from "react";
import { Pressable, StyleSheet, useWindowDimensions, View, type ViewStyle } from "react-native";
import { Link, usePathname, type Href } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { space } from "@keepsake/tokens/spacing";
import { radii } from "@keepsake/tokens/radii";
import { type } from "@keepsake/tokens/typography";
import { useColors, useThemeMode, type ThemeMode } from "@/ui/theme";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";

const NEXT_MODE: Record<ThemeMode, ThemeMode> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const MODE_ICON: Record<ThemeMode, keyof typeof Ionicons.glyphMap> = {
  light: "sunny",
  dark: "moon",
  system: "contrast",
};

const NARROW_BREAKPOINT = 640;

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
      <Ionicons name={MODE_ICON[selectedMode]} size={20} color={colors.ink} />
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

function NavLink({ href, label, active }: { href: Href; label: string; active: boolean }): React.ReactElement {
  const colors = useColors();
  return (
    <Link href={href} asChild>
      <Pressable accessibilityRole="link" accessibilityState={{ selected: active }} style={navStyle(active, colors)}>
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
function SiteLink({ href, label }: { href: string; label: string }): React.ReactElement {
  const colors = useColors();
  return (
    <View accessibilityRole="link" {...({ href } as object)} style={navStyle(false, colors)}>
      <Text variant="label" color="ink" style={{ fontSize: 12 }}>
        {label}
      </Text>
    </View>
  );
}

export function AppHeader(): React.ReactElement {
  const colors = useColors();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const narrow = width < NARROW_BREAKPOINT;

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
          minHeight: narrow ? 64 : 76,
        }}
      >
        <Link href="/" accessibilityLabel="Keepsake, home">
          <Text
            testID="wordmark"
            variant="wordmark"
            fontVariationSettings={type.wordmark.fontVariationSettings}
            style={narrow ? { fontSize: 23, lineHeight: 28 } : undefined}
          >
            Keepsake
          </Text>
        </Link>

        <View style={{ flexDirection: "row", alignItems: "center", gap: narrow ? space.md : space.xl }}>
          {narrow ? null : <NavLink href="/" label="Browse" active={pathname === "/"} />}
          <NavLink href="/mine" label="Mine" active={pathname.startsWith("/mine")} />
          {narrow ? null : <SiteLink href="/about" label="About" />}
          <Link href="/give" asChild>
            <Button label={narrow ? "Give" : "Give something"} />
          </Link>
          <ThemeToggle />
        </View>
      </ReadableWidth>
    </View>
  );
}
