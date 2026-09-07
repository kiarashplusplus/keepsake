import * as React from "react";
import { Platform, ScrollView, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ReadableWidth } from "@/ui/ReadableWidth";

export type PageProps = {
  /**
   * Width treatment for the page's content. Omit this when the caller is
   * already nested inside another `ReadableWidth`/`Page` that constrains the
   * width (the give flow's steps: `app/give/_layout.tsx`'s `StepShell` wraps
   * the whole step stack in one `ReadableWidth` already, so wrapping each
   * step's own content in a second one would double the horizontal gutter).
   */
  variant?: "prose" | "grid";
  /**
   * Carries the page's vertical rhythm (`paddingVertical`/`paddingTop`/
   * `gap`, etc.) — exactly what used to sit on `ReadableWidth`'s own `style`
   * prop before every route grew a `Page` wrapper. A safe-area-aware bottom
   * inset is always added on top of whatever `paddingBottom` is passed here,
   * so content clears the iOS home indicator / Android gesture bar without
   * every call site having to remember to add it.
   */
  contentContainerStyle?: ViewStyle;
  children: React.ReactNode;
  testID?: string;
};

/**
 * Why this exists: `app/+html.tsx` sets `html, body, #root { height: 100% }`
 * and expo-router's own `ScrollViewStyleReset` (imported there) additionally
 * sets `body { overflow: hidden }` — a root reset built, on purpose, to hand
 * scrolling entirely to React Native `ScrollView`s (see
 * https://necolas.github.io/react-native-web/docs/setup/#root-element).
 * `app/_layout.tsx` then wraps the whole tree in a `flex: 1` `View`. Put
 * together, every screen becomes a fixed-height box, and anything taller
 * than the viewport was clipped away by that `overflow: hidden` — silently,
 * with no scrollbar and no error. For a long time no route rendered a
 * `ScrollView` at all (the only one in the app was the horizontal photo
 * carousel), so the app was unusable on a phone past the first screenful.
 *
 * Every route renders through this component instead of a bare `View` (or
 * `ReadableWidth` directly) so that regression can't come back by accident.
 * Do not "simplify" this back to a `View` — that is precisely the bug this
 * fixes. `apps/web/e2e/scroll.spec.ts` asserts real pages scroll for the
 * same reason.
 */
export function Page({
  variant,
  contentContainerStyle,
  children,
  testID,
}: PageProps): React.ReactElement {
  const insets = useSafeAreaInsets();
  const basePaddingBottom =
    typeof contentContainerStyle?.paddingBottom === "number"
      ? contentContainerStyle.paddingBottom
      : 0;
  const rhythmStyle: ViewStyle = {
    ...contentContainerStyle,
    paddingBottom: basePaddingBottom + insets.bottom,
  };

  const content =
    variant !== undefined ? (
      <ReadableWidth variant={variant} style={rhythmStyle}>
        {children}
      </ReadableWidth>
    ) : (
      <View style={rhythmStyle}>{children}</View>
    );

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ flexGrow: 1 }}
      showsVerticalScrollIndicator={Platform.OS === "web"}
      keyboardShouldPersistTaps="handled"
      testID={testID}
    >
      {content}
    </ScrollView>
  );
}
