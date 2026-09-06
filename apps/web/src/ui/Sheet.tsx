import * as React from "react";
import { Modal, Pressable, useWindowDimensions, View, type ViewStyle } from "react-native";
import { radii, shadow } from "@keepsake/tokens/radii";
import { space } from "@keepsake/tokens/spacing";
import { useColors, useContainerBorder } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";
import { Text } from "@/ui/Text";

const BOTTOM_SHEET_BREAKPOINT = 720;
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export type SheetProps = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
};

/** Bottom sheet under 720px, centered dialog at/above it. Escape closes;
 * focus is trapped inside the panel while open and restored to whatever was
 * focused before it opened. */
export function Sheet({ visible, onClose, title, children }: SheetProps): React.ReactElement | null {
  const colors = useColors();
  const border = useContainerBorder();
  const motion = useMotion();
  const { width } = useWindowDimensions();
  const isBottomSheet = width < BOTTOM_SHEET_BREAKPOINT;
  const panelRef = React.useRef<View>(null);

  React.useEffect(() => {
    if (!visible || typeof document === "undefined") return undefined;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    // react-native-web forwards a View's ref directly to its underlying DOM
    // node on web, so this cast is safe on the only platform this file ships to.
    const panelNode = panelRef.current as unknown as HTMLElement | null;
    panelNode?.focus?.();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
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
  }, [visible, onClose]);

  if (!visible) return null;

  const panelStyle: ViewStyle = {
    backgroundColor: colors.surface,
    borderWidth: border.borderWidth,
    borderColor: border.borderColor,
    padding: space.lg,
    gap: space.md,
    ...(isBottomSheet
      ? ({ borderTopLeftRadius: radii.lg, borderTopRightRadius: radii.lg, width: "100%" } as ViewStyle)
      : ({ borderRadius: radii.lg, maxWidth: 480, width: "90%" } as ViewStyle)),
    ...({ boxShadow: shadow.sheet(colors.shadowStrong) } as ViewStyle),
  };

  return (
    <Modal visible={visible} transparent animationType={motion.reduce ? "none" : "fade"} onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        style={{
          flex: 1,
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
            <Text variant="title" accessibilityRole="header">
              {title}
            </Text>
          ) : null}
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
