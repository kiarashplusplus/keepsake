import * as React from "react";
import { createPortal } from "react-dom";
import {
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { radii, shadow } from "@keepsake/tokens/radii";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { Text } from "@/ui/Text";

const BOTTOM_SHEET_BREAKPOINT = 720;
const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export type SheetProps = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /**
   * Rendered below the scrolling body, outside the `ScrollView`, so it stays
   * on screen at every scroll position instead of scrolling away with the
   * rest of the content. Opt-in and additive (issue #373 finding 1): a sheet
   * that doesn't pass this renders exactly as it did before — the same
   * everything-scrolls-together panel — so `ReportSheet`, `ReasonSheet` and
   * `HandoffSheet` are unaffected. Reach for it when a sheet's one action
   * sits behind enough copy that it can land below the fold on a phone; the
   * request sheet is the first case (a 7-line safety paragraph pushed SEND
   * off a 390×844 viewport in both its empty and filled states).
   */
  footer?: React.ReactNode;
};

/**
 * An index card sliding up off the bottom of the table (or dropped onto the
 * middle of it above the sheet breakpoint): the constant `surface` paper,
 * square corners, a shadow instead of a hairline border. Escape closes;
 * focus is trapped inside the panel while open and restored to whatever was
 * focused before it opened.
 */
export function Sheet({
  visible,
  onClose,
  title,
  children,
  footer,
}: SheetProps): React.ReactElement | null {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const isBottomSheet = width < BOTTOM_SHEET_BREAKPOINT;
  const panelRef = React.useRef<View>(null);
  // Callers routinely pass an inline `onClose` (a fresh function every
  // render), and typing into any field inside the sheet re-renders it. A ref
  // lets the focus trap below read the latest `onClose` without listing it as
  // a dependency — depending on it directly reran the trap on every
  // keystroke, and its cleanup restored focus to whatever was focused before
  // the sheet opened, blurring the field being typed into: the keyboard
  // flashing open and shut, and a date `<input>` losing focus mid-pick, which
  // makes WebKit commit whatever date its picker was showing (today).
  //
  // Mirrored in an effect rather than assigned during render, the same way
  // `SearchBar` and `useFileDrop` keep their own callback refs current:
  // `react-hooks/refs` (rightly) rejects a render-phase ref write. Only the
  // Escape handler reads it, on a keypress, long after this has flushed.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  });

  React.useEffect(() => {
    if (!visible || typeof document === "undefined") return undefined;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    // react-native-web forwards a View's ref directly to its underlying DOM
    // node on web, so this cast is safe on the only platform this file ships to.
    const panelNode = panelRef.current as unknown as HTMLElement | null;
    panelNode?.focus?.();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelNode) return;
      const focusables = Array.from(panelNode.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) return;
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [visible]);

  if (!visible) return null;

  // Leaves margin above/below so the sheet never touches the screen edges,
  // and — the point of this — bounds the panel so a long body (a form with
  // several fields plus Turnstile) scrolls inside it instead of growing
  // taller than the viewport and clipping its own submit button, exactly
  // the invisible-overflow failure `src/ui/Page.tsx` fixes for full pages.
  // Keep the panel in the same dynamic-viewport layout as its backdrop.
  // In particular, do not derive this bound from `visualViewport`: iOS 26
  // can leave both its height and offsetTop stale after keyboard/scroll
  // interactions (WebKit #297779).
  const maxHeight = `calc(100dvh - ${space.xxl * 2}px)`;

  const panelStyle: ViewStyle = {
    backgroundColor: colors.surface,
    padding: space.lg,
    gap: space.md,
    maxHeight: maxHeight as unknown as number,
    ...(isBottomSheet
      ? ({
          borderTopLeftRadius: radii.md,
          borderTopRightRadius: radii.md,
          width: "100%",
        } as ViewStyle)
      : ({ borderRadius: radii.md, maxWidth: 480, width: "90%" } as ViewStyle)),
    ...({
      boxShadow: `inset 0px 0px 0px 1px rgba(0,0,0,0.08), ${shadow.sheet(colors.shadowStrong)}`,
    } as ViewStyle),
  };

  // Escape the route's ScrollView so its overflow and current scroll offset
  // cannot clip or relocate the overlay. Unlike react-native-web's Modal,
  // this portal contributes no fixed-position wrapper of its own.
  const portalTarget = typeof document !== "undefined" ? document.getElementById("root") : null;
  if (portalTarget === null) return null;

  return createPortal(
    <View
      style={{
        // `absolute`, not `fixed`, and it pins just as well from out here:
        // the portal above put this at `#root`, where the nearest positioned
        // ancestor is nothing at all, so the containing block is the initial
        // one — and `body` is `overflow: hidden` (only inner containers
        // scroll, never the document), so that block and the viewport
        // coincide and stay coincident. `fixed` would buy nothing and cost
        // the thing §3 is about: it is captured by any transformed ancestor,
        // which inside a navigator is how an overlay ends up anchored to a
        // screen rather than to the window.
        //
        // `100dvh` is then the whole keyboard story — it contracts because
        // `app/+html.tsx` sets `interactive-widget=resizes-content` (see the
        // comment there; without it the layout viewport ignores the keyboard
        // and this height would be a lie). No `visualViewport` read, no
        // translate, nothing to go stale under WebKit #297779.
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: "100dvh" as unknown as number,
        zIndex: 100,
        justifyContent: isBottomSheet ? "flex-end" : "center",
        alignItems: "center",
      }}
    >
      {/* The backdrop is a *sibling* of the panel, never its ancestor, and
          that is load-bearing rather than stylistic. It carries
          `accessibilityRole="button"`, which react-native-web renders as a
          real `<button>` — and a `<button>` wrapping the panel makes every
          field in the sheet a descendant of it. Interactive content nested
          inside a button is invalid HTML, and the browser acts on it: a
          space typed into a field activates the enclosing button, so the
          sheet closed and the keyboard dismissed on the first space of any
          note or email address (#334 fixed a different cause of the same
          visible symptom, which is why this survived it). Verified by
          instrumenting the DOM: `KEYDOWN " "` on the textarea was followed
          immediately by `CLICK` on the button labelled Close.

          As siblings, a press on the panel simply never reaches the
          backdrop, so the panel also no longer needs an `onPress` whose only
          job was to stop propagation. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: colors.overlay,
        }}
      />
      {/* `tabIndex={-1}`: the focus trap above focuses this node when the
          sheet opens, which a plain `<div>` will not accept. -1 keeps it
          programmatically focusable without adding it to the tab order —
          `FOCUSABLE_SELECTOR` deliberately excludes `[tabindex="-1"]`, so
          the panel itself stays out of the cycle it contains. */}
      <View
        ref={panelRef}
        tabIndex={-1}
        accessibilityViewIsModal
        style={panelStyle}
      >
        {title !== undefined ? (
          <Text variant="title" color="ink" accessibilityRole="header">
            {title}
          </Text>
        ) : null}
          {/* `flexShrink: 1` (not `flex: 1`) so the ScrollView only grows as
              tall as its content up to the panel's `maxHeight` above, rather
              than always claiming the full bound and stranding blank space
              under a short body. The focus trap in the effect above still
              works: react-native-web forwards this to a plain `<div>`
              descendant of `panelNode`, so `querySelectorAll` still finds it. */}
        <ScrollView
          testID="sheet-scroll-body"
          style={{ flexShrink: 1 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
        >
          {children}
        </ScrollView>
        {footer !== undefined ? (
          // A sibling of the `ScrollView`, not a child of it: `flexShrink: 1`
          // above already lets the scrolling body give up space, so this
          // keeps its own size and pins to the bottom of the panel — visible
          // at whatever scroll position the body is in, including 0.
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: colors.rule,
              paddingTop: space.md,
            }}
          >
            {footer}
          </View>
        ) : null}
      </View>
    </View>,
    portalTarget,
  );
}
