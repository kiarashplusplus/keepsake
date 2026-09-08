import * as React from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { radii, shadow } from "@keepsake/tokens/radii";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";
import { Text } from "@/ui/Text";
import { useVisualViewportHeight } from "@/ui/useVisualViewportHeight";

const BOTTOM_SHEET_BREAKPOINT = 720;
const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export type SheetProps = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
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
}: SheetProps): React.ReactElement | null {
  const colors = useColors();
  const motion = useMotion();
  const { width, height: windowHeight } = useWindowDimensions();
  // `useWindowDimensions` tracks `window.innerWidth`/`innerHeight` (the
  // layout viewport), which iOS Safari deliberately leaves unchanged when
  // the on-screen keyboard opens — react-native-web's own `Dimensions`
  // 'change' event doesn't fire there either (necolas/react-native-web#2430)
  // — so it never reflects the keyboard. `visualViewport.height` is the one
  // measurement that does. See `useVisualViewportHeight`'s own comment for
  // why sizing off it is safe where `docs/platform-differences.md` §3 says
  // *positioning* off `visualViewport` (via `offsetTop`/`scrollY` deltas)
  // isn't.
  const height = useVisualViewportHeight(windowHeight);
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
  const maxHeight = height - space.xxl * 2;

  const panelStyle: ViewStyle = {
    backgroundColor: colors.surface,
    padding: space.lg,
    gap: space.md,
    maxHeight,
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

  const animationType = motion.reduce ? "none" : isBottomSheet ? "slide" : "fade";

  return (
    <Modal visible={visible} transparent animationType={animationType} onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        style={{
          // An explicit `height`, not `flex: 1`: this sits inside the
          // `Modal`'s own `position: fixed` full-screen box, which (like
          // `windowHeight` above) keeps its full height even once the
          // keyboard covers its bottom portion. `flex: 1` would keep
          // filling that whole box and `justifyContent: "flex-end"` would
          // keep flushing the panel to ITS bottom edge — still under the
          // keyboard — no matter how short `maxHeight` below makes the
          // panel itself. Sizing this box to `height` is what actually
          // moves the flush-bottom edge up to the visible area.
          height,
          width: "100%",
          backgroundColor: colors.overlay,
          justifyContent: isBottomSheet ? "flex-end" : "center",
          alignItems: "center",
        }}
      >
        <Pressable
          ref={panelRef}
          accessibilityViewIsModal
          onPress={(event) => event.stopPropagation()}
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
            style={{ flexShrink: 1 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
