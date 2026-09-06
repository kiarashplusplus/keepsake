import * as React from "react";
import { Pressable, View } from "react-native";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { space } from "@keepsake/tokens/spacing";
import { radii } from "@keepsake/tokens/radii";
import { useColors, useThemeMode, type ThemeMode } from "@/ui/theme";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";

const NEXT_MODE: Record<ThemeMode, ThemeMode> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const MODE_ICON: Record<ThemeMode, keyof typeof Ionicons.glyphMap> = {
  light: "sunny",
  dark: "moon",
  system: "contrast",
};

function ThemeToggle(): React.ReactElement {
  const colors = useColors();
  const { selectedMode, setMode } = useThemeMode();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Theme: ${selectedMode}. Tap to change.`}
      onPress={() => setMode(NEXT_MODE[selectedMode])}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: radii.pill,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Ionicons name={MODE_ICON[selectedMode]} size={20} color={colors.ink} />
    </Pressable>
  );
}

export function AppHeader(): React.ReactElement {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        gap: space.md,
      }}
    >
      <Link href="/">
        <Text variant="displayMd" style={{ fontStyle: "italic" }}>
          Keepsake
        </Text>
      </Link>

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <Link href="/mine">
          <Text variant="title" color="accentText">
            Mine
          </Text>
        </Link>
        <Link href="/give" asChild>
          <Button label="Give something" />
        </Link>
        <ThemeToggle />
      </View>
    </View>
  );
}
