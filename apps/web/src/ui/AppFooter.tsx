import * as React from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { Text } from "@/ui/Text";
import { isGpcActive, openConsentBanner } from "@/lib/consent";

/**
 * The app's counterpart to `apps/site`'s `.site-footer`: the legal links, and
 * the way back into the consent decision.
 *
 * The brief for the banner is that the choice must be reopenable, and a
 * banner that vanishes after one click leaves no way in. `apps/site`'s pages
 * carry a `<button data-ks-consent>` for the same job; here the same
 * `/consent.js` banner is reopened through `openConsentBanner()`, so there is
 * still exactly one banner in the codebase rather than a React copy of it.
 *
 * On a paper strip (`colors.surface`), never bare on the table. `ink` is
 * constant in both themes by design (see `packages/tokens/src/colors.ts`), so
 * text placed directly on `bg` would be near-black on walnut in dark mode —
 * a real contrast failure, and one `e2e/a11y.spec.ts` would catch. `AppHeader`
 * solves it the same way.
 *
 * Rendered by `ui/Page` at the end of each screen's scroller, not by
 * `app/_layout.tsx` alongside the router — see `Page.tsx`'s header for why
 * (#221). Being the last thing in the document is also why it, rather than
 * the content above it, carries the safe-area bottom inset.
 */
function NEVER_CHANGES(): () => void {
  return () => {};
}

/** The server render cannot see `navigator`, and must not guess. */
function GPC_UNKNOWN_ON_SERVER(): boolean {
  return false;
}

export type AppFooterProps = {
  /** The device's bottom safe-area inset, passed down from `Page` (which
   * already reads it) so this component stays usable outside a
   * `SafeAreaProvider` in tests. */
  safeAreaBottom?: number;
};

export function AppFooter({ safeAreaBottom = 0 }: AppFooterProps): React.ReactElement {
  const colors = useColors();
  // `useSyncExternalStore` rather than `useState` + `useEffect`: the static
  // export renders this in Node, where `navigator` does not exist, so the
  // server snapshot and the client snapshot genuinely differ. That is a
  // hydration mismatch React only handles correctly when it is told about it
  // this way — and setting state synchronously from an effect to paper over it
  // is a cascading render, which `pnpm lint` rejects outright.
  //
  // GPC cannot change within a document's lifetime, so `subscribe` has nothing
  // to listen to; the store is read once per render pass and that is enough.
  const gpc = React.useSyncExternalStore(NEVER_CHANGES, isGpcActive, GPC_UNKNOWN_ON_SERVER);

  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.rule,
      }}
    >
      <ReadableWidth
        variant="grid"
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: space.lg,
          paddingTop: space.md,
          paddingBottom: space.md + safeAreaBottom,
        }}
      >
        {/* `/about` is a static page from `apps/site`, and until #224 it was
            reachable only from the wide header — the narrow header drops it
            for room, and this footer never carried it, so there was no path
            to it at all from a phone. It is a plain anchor here for the same
            reason as in `AppHeader`: not an expo-router route. */}
        <View accessibilityRole="link" {...({ href: "/about" } as object)}>
          <Text variant="caption" color="ink">
            About
          </Text>
        </View>
        <View accessibilityRole="link" {...({ href: "/privacy" } as object)}>
          <Text variant="caption" color="ink">
            Privacy
          </Text>
        </View>
        <View accessibilityRole="link" {...({ href: "/terms" } as object)}>
          <Text variant="caption" color="ink">
            Terms
          </Text>
        </View>
        {/* Web-only: `/consent.js` is a browser script, and there is nothing
            to reopen on a platform that never showed the banner. */}
        {Platform.OS === "web" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Privacy choices"
            onPress={openConsentBanner}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text variant="caption" color="ink" style={{ textDecorationLine: "underline" }}>
              Privacy choices
            </Text>
          </Pressable>
        ) : null}
        {gpc ? (
          <Text variant="caption" color="textSecondary">
            Global Privacy Control honoured — no advertising, no sale or sharing.
          </Text>
        ) : null}
      </ReadableWidth>
    </View>
  );
}
