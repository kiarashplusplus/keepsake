import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { radii, shadow } from "@keepsake/tokens/radii";
import { useColors } from "@/ui/theme";
import { Text } from "@/ui/Text";

type ToastItem = { id: number; message: string };

type ToastContextValue = { show: (message: string) => void };

const ToastContext = React.createContext<ToastContextValue | undefined>(undefined);

const DISPLAY_MS = 3000;

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const nextId = React.useRef(0);
  const colors = useColors();

  const show = React.useCallback((message: string) => {
    const id = nextId.current;
    nextId.current += 1;
    setItems((current) => [...current, { id, message }]);
    setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, DISPLAY_MS);
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
            style={{
              backgroundColor: colors.ink,
              borderRadius: radii.md,
              paddingHorizontal: space.lg,
              paddingVertical: space.sm,
              maxWidth: 360,
              transform: [{ rotate: "-0.6deg" }],
              ...({ boxShadow: shadow.sheet(colors.shadowStrong) } as ViewStyle),
            }}
          >
            <Text variant="caption" style={{ color: colors.print, fontSize: 13 }}>
              {item.message}
            </Text>
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
