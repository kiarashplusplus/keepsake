import * as React from "react";
import { View } from "react-native";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider, useColors } from "@/ui/theme";
import { MotionProvider } from "@/ui/MotionProvider";
import { ToastProvider } from "@/ui/Toast";
import { PaperGrain } from "@/ui/PaperGrain";
import { AppHeader } from "@/ui/AppHeader";

function Shell(): React.ReactElement {
  const colors = useColors();

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <PaperGrain />
        <AppHeader />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
          }}
        />
      </View>
    </SafeAreaProvider>
  );
}

export default function RootLayout(): React.ReactElement {
  return (
    <ThemeProvider>
      <MotionProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </MotionProvider>
    </ThemeProvider>
  );
}
