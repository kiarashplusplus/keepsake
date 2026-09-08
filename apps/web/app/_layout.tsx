import * as React from "react";
import { View } from "react-native";
import { Stack, DefaultTheme as RouterDefaultTheme, ThemeProvider as RouterThemeProvider } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider } from "@/ui/theme";
import { MotionProvider } from "@/ui/MotionProvider";
import { ToastProvider } from "@/ui/Toast";
import { KraftTable } from "@/ui/KraftTable";
import { AppHeader } from "@/ui/AppHeader";
import { VersionSkewBanner } from "@/features/versionSkew/VersionSkewBanner";

// expo-router's Stack renders each screen inside a React Navigation `Screen`
// container whose own background comes from a *navigation* theme — entirely
// separate from this app's `ThemeProvider`/`data-theme` — and defaults to
// `rgb(242, 242, 242)` (React Navigation's `DefaultTheme.colors.background`)
// regardless of light/dark mode. That opaque grey sits between the fixed
// `KraftTable` (z-index -1, so it paints behind normal in-flow content) and
// the screen's own content, hiding the table entirely. Overriding just
// `colors.background` to transparent here — once, at the root — is what
// actually lets the table show through every route's `contentStyle`.
const TRANSPARENT_ROUTER_THEME = { ...RouterDefaultTheme, colors: { ...RouterDefaultTheme.colors, background: "transparent" } };

/**
 * The header stays here — it is chrome, and it is the only way back to the
 * feed from a screen scrolled to its end. The FOOTER does not: `ui/Page`
 * renders it inside each screen's own scroller so it sits at the end of the
 * document rather than pinned over it (#221). Putting it back here would
 * re-pin it, because of the `flex: 1` shell below.
 */
function Shell(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: "transparent" }}>
        <KraftTable />
        <VersionSkewBanner />
        <AppHeader />
        <RouterThemeProvider value={TRANSPARENT_ROUTER_THEME}>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: "transparent" },
            }}
          />
        </RouterThemeProvider>
      </View>
    </SafeAreaProvider>
  );
}

export default function RootLayout(): React.ReactElement {
  return (
    <ThemeProvider>
      <MotionProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </MotionProvider>
    </ThemeProvider>
  );
}
