// The give flow's step shell: back link, step numerals, and the
// `GiveDraftProvider` every step reads/writes via `useGiveDraft()`. See the
// build plan's "Web app" section for the five steps.
import * as React from "react";
import { Link, Stack, usePathname } from "expo-router";
import { StyleSheet, View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { GiveDraftProvider } from "@/features/give/GiveDraftContext";
import { useEditHydration } from "@/features/give/useEditHydration";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { StepNumerals } from "@/ui/StepNumerals";
import { Text } from "@/ui/Text";
import { useColors } from "@/ui/theme";

const STEP_PATHS = ["/give", "/give/story", "/give/details", "/give/email", "/give/review"] as const;

function StepShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const colors = useColors();
  const pathname = usePathname();
  const stepIndex = STEP_PATHS.findIndex((step) => step === pathname);
  const current = stepIndex === -1 ? 0 : stepIndex;

  return (
    <ReadableWidth variant="prose" style={{ paddingVertical: space.xxl, gap: space.xxl }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingBottom: space.md,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.rule,
        }}
      >
        <Link href="/" accessibilityRole="link" accessibilityLabel="Back to the feed">
          <Text variant="bodySm" color="accent2Text" style={{ fontSize: 15, fontWeight: "500" }}>
            ← Back
          </Text>
        </Link>
        <StepNumerals total={STEP_PATHS.length} current={current} />
      </View>
      {children}
    </ReadableWidth>
  );
}

function EditHydrator(): null {
  useEditHydration();
  return null;
}

export default function GiveLayout(): React.ReactElement {
  return (
    <GiveDraftProvider>
      <EditHydrator />
      <StepShell>
        <Stack screenOptions={{ headerShown: false }} />
      </StepShell>
    </GiveDraftProvider>
  );
}
