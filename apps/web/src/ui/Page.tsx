import * as React from "react";
import { Platform, ScrollView, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { AppFooter } from "@/ui/AppFooter";

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
   * prop before every route grew a `Page` wrapper.
   *
   * The safe-area bottom inset used to be added here. It now sits on the
   * `AppFooter` this component renders below the content instead: the footer
   * is the last thing in the document, so it — not the content above it — is
   * what has to clear the iOS home indicator / Android gesture bar.
   */
  contentContainerStyle?: ViewStyle;
  /**
   * The legal footer at the end of the document. On by default and there is
   * currently no caller that turns it off: "Privacy choices" has to be
   * reachable from every surface (see `AppFooter`), so opting out is a
   * decision to make deliberately, not a convenience.
   */
  footer?: boolean;
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
 *
 * It also renders the legal footer, INSIDE the scroller, as the last thing
 * in the document (#221). That footer used to be a sibling of the router's
 * `<Stack>` in `app/_layout.tsx`, which — under the same `flex: 1` shell
 * described above — pinned it to the bottom edge of every viewport: 59px of
 * an 844px phone screen spent permanently on three links nobody navigates
 * by, with the page's own content scrolling underneath and being sliced
 * mid-glyph by its top edge. Here it is ordinary document content: off
 * screen until you reach the end of the page, and never covering anything.
 */
export function Page({
  variant,
  contentContainerStyle,
  footer = true,
  children,
  testID,
}: PageProps): React.ReactElement {
  const insets = useSafeAreaInsets();
  const rhythmStyle: ViewStyle = { ...contentContainerStyle };

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
      {/* `flex: 1` so a screen shorter than the viewport still pushes the
          footer to the bottom edge, and a taller one leaves it below the
          last thing on the page rather than over it. */}
      <View style={{ flex: 1 }}>{content}</View>
      {footer ? <AppFooter safeAreaBottom={insets.bottom} /> : null}
    </ScrollView>
  );
}
