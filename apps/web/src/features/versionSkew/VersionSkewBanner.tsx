/**
 * The visible half of the version-skew guard (issue #23) — a thin, dismissible
 * strip, not a modal: it never steals focus and never reloads anything by
 * itself, so it can't interrupt someone mid-story in the give flow or
 * mid-note in `RequestSheet`. `position: sticky` rather than `fixed` so it
 * takes its own row in normal flow instead of overlapping `AppHeader` or
 * whatever's directly under it.
 *
 * Styled as an index card strip (`surface` fill, 2px ink baseline) rather
 * than a cream-and-serif toast — see `docs/design/design-system.md`'s v3
 * "Polaroids on a table" system this app follows everywhere else.
 */
import * as React from "react";
import { Platform, View, type ViewStyle } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { useVersionSkewGuard, type VersionSkewGuardState } from "@/features/versionSkew/useVersionSkewGuard";

export type VersionSkewBannerProps = {
  /** Test-only seam: `useVersionSkewGuard`'s state is normally computed
   * internally, but a test can hand in a fixed `stale: true` state without
   * mocking `fetch`/timers to exercise the presentational half alone. */
  state?: VersionSkewGuardState;
};

export function VersionSkewBanner({ state }: VersionSkewBannerProps): React.ReactElement | null {
  const colors = useColors();
  const guard = useVersionSkewGuard();
  const { stale, dismiss, reload } = state ?? guard;

  if (!stale) return null;

  const wrapperStyle: ViewStyle = {
    backgroundColor: colors.surface,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    zIndex: 900,
    ...(Platform.OS === "web" ? ({ position: "sticky", top: 0 } as ViewStyle) : null),
  };

  return (
    <View style={wrapperStyle} accessibilityRole="alert">
      <Text variant="label" color="ink" style={{ fontSize: 12, flexShrink: 1, textAlign: "center" }}>
        A new version of Keepsake is ready.
      </Text>
      <Button label="Reload" variant="secondary" onPress={reload} style={{ minHeight: 32, paddingVertical: 0 }} />
      <Button label="Dismiss" variant="ghost" onPress={dismiss} style={{ minHeight: 32, paddingVertical: 0 }} />
    </View>
  );
}
