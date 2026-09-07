// The give flow's step shell: back link, step numerals, and the
// `GiveDraftProvider` every step reads/writes via `useGiveDraft()`. See the
// build plan's "Web app" section for the five steps.
import * as React from "react";
import { View } from "react-native";
import { Link, Stack, usePathname } from "expo-router";
import { space } from "@keepsake/tokens/spacing";
import { GiveDraftProvider } from "@/features/give/GiveDraftContext";
import { useEditHydration } from "@/features/give/useEditHydration";
import { SuggestionFetcher } from "@/features/give/SuggestionFetcher";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { StepNumerals } from "@/ui/StepNumerals";
import { Card } from "@/ui/Surface";
import { Text } from "@/ui/Text";

const STEP_PATHS = ["/give", "/give/story", "/give/details", "/give/email", "/give/review"] as const;

/**
 * The give flow's header (back link + step numerals) gets its own small
 * `Card`, but `{children}` — the actual per-step screen, rendered by a
 * nested `<Stack>` below — is deliberately left OUTSIDE any card here:
 * React Navigation renders each screen `position: absolute` (to support
 * transitions), which takes it out of normal flow, so a wrapping `Card`
 * around the `<Stack>` itself never grows past its in-flow children (the
 * card would visually clip to the header row alone). Each step file wraps
 * its *own* content in a `Card` instead — see e.g. `app/give/index.tsx`.
 *
 * `flex: 1` on the outer `ReadableWidth` plus the `View` around `{children}`
 * is the other half of that same fact: an absolutely-positioned screen sizes
 * itself against the nearest ancestor with a *definite* height, and without
 * these two, `ReadableWidth` only ever grows to its in-flow content (the
 * header `Card` — a few dozen pixels), so the nested `<Stack>`'s screens (and
 * every `Page`/`ScrollView` each step renders inside itself) inherit a
 * height of exactly 0. Confirmed empirically: without this, the step
 * content still *paints* (nothing here clips it), but a 0-height
 * `overflow-y: auto` ancestor makes it un-hit-testable — clicks land on
 * whatever's underneath instead, which is what broke `e2e/give.spec.ts`.
 */
function StepShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const pathname = usePathname();
  const stepIndex = STEP_PATHS.findIndex((step) => step === pathname);
  const current = stepIndex === -1 ? 0 : stepIndex;

  return (
    <ReadableWidth variant="prose" style={{ flex: 1, paddingVertical: space.xxl, gap: space.xl }}>
      <Card
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          transform: [{ rotate: "0.3deg" }],
        }}
      >
        <Link href="/" accessibilityRole="link" accessibilityLabel="Back to the feed">
          <Text variant="label" color="ink" style={{ fontSize: 12 }}>
            ← Back
          </Text>
        </Link>
        <StepNumerals total={STEP_PATHS.length} current={current} />
      </Card>
      <View style={{ flex: 1 }}>{children}</View>
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
      <SuggestionFetcher />
      <StepShell>
        <Stack screenOptions={{ headerShown: false }} />
      </StepShell>
    </GiveDraftProvider>
  );
}
