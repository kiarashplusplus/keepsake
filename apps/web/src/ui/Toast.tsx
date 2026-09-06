import * as React from "react";
import { Pressable, View, type ViewStyle } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { radii, shadow } from "@keepsake/tokens/radii";
import { useColors } from "@/ui/theme";
import { Text } from "@/ui/Text";

export type ToastAction = { label: string; onPress: () => void };

type ToastItem = { id: number; message: string; action?: ToastAction };

type ToastContextValue = {
  /** `action` (e.g. `{ label: "Undo", onPress }`) is optional — most toasts
   * are fire-and-forget confirmations, but the admin queue's optimistic
   * remove/reinsert (`app/admin.tsx`) needs a way back without a full page
   * reload. Present only when a toast has one. */
  show: (message: string, action?: ToastAction) => void;
};

const ToastContext = React.createContext<ToastContextValue | undefined>(undefined);

const DISPLAY_MS = 3000;
// Toasts carrying an undo get more time on screen — 3s is barely enough to
// read a plain confirmation, let alone notice and reach for a second action.
const ACTION_DISPLAY_MS = 6000;

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const nextId = React.useRef(0);
  const colors = useColors();

  const show = React.useCallback((message: string, action?: ToastAction) => {
    const id = nextId.current;
    nextId.current += 1;
    setItems((current) => [...current, action !== undefined ? { id, message, action } : { id, message }]);
    setTimeout(
      () => {
        setItems((current) => current.filter((item) => item.id !== id));
      },
      action !== undefined ? ACTION_DISPLAY_MS : DISPLAY_MS,
    );
  }, []);

  const value = React.useMemo<ToastContextValue>(() => ({ show }), [show]);

  const wrapperStyle = {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: space.xl,
    alignItems: "center",
    gap: space.sm,
    zIndex: 1000,
  } as unknown as ViewStyle;

  return (
    <ToastContext.Provider value={value}>
      {children}
      <View pointerEvents="none" style={wrapperStyle} accessibilityRole="alert">
        {items.map((item) => (
          <View
            key={item.id}
            pointerEvents="auto"
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              backgroundColor: colors.ink,
              borderRadius: radii.md,
              paddingHorizontal: space.lg,
              paddingVertical: space.sm,
              maxWidth: 360,
              transform: [{ rotate: "-0.6deg" }],
              ...({ boxShadow: shadow.sheet(colors.shadowStrong) } as ViewStyle),
            }}
          >
            <Text variant="caption" style={{ color: colors.print, fontSize: 13, flexShrink: 1 }}>
              {item.message}
            </Text>
            {item.action !== undefined ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={item.action.label}
                onPress={() => {
                  item.action?.onPress();
                  setItems((current) => current.filter((current_) => current_.id !== item.id));
                }}
                style={{ minHeight: 32, justifyContent: "center" }}
              >
                <Text variant="label" style={{ color: colors.print, fontSize: 12, textDecorationLine: "underline" }}>
                  {item.action.label}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </View>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
