// The give flow's step shell: back link, step numerals, and the
// `GiveDraftProvider` every step reads/writes via `useGiveDraft()`. See the
// build plan's "Web app" section for the five steps.
import * as React from "react";
import { ActivityIndicator, View } from "react-native";
import { Link, Stack, usePathname } from "expo-router";
import { space } from "@keepsake/tokens/spacing";
import { GiveDraftProvider } from "@/features/give/GiveDraftContext";
import { GIVE_STEP_NAMES, GIVE_STEP_PATHS, giveStepIndex, previousGiveStep } from "@/features/give/steps";
import { useEditHydration } from "@/features/give/useEditHydration";
import { SuggestionFetcher } from "@/features/give/SuggestionFetcher";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { StepNumerals } from "@/ui/StepNumerals";
import { Card } from "@/ui/Surface";
import { Text } from "@/ui/Text";
import { RouteHead } from "@/ui/RouteHead";

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
  const current = giveStepIndex(pathname);
  // The previous step, or `null` on the first one — where "back" can only
  // mean leaving the flow. It used to be the feed from every step, so
  // stepping back from the story threw the giver out of the flow entirely.
  const previous = previousGiveStep(pathname);
  // One title per step rather than a single static one for the whole flow —
  // read from the same `GIVE_STEP_NAMES` table the Back link's a11y label
  // already does, so there's one place that knows what each step is called.
  const stepName = GIVE_STEP_NAMES[GIVE_STEP_PATHS[current] ?? "/give"];
  const stepTitle = `Give a keepsake: ${stepName.charAt(0).toUpperCase()}${stepName.slice(1)}`;

  return (
    <ReadableWidth variant="prose" style={{ flex: 1, paddingVertical: space.xxl, gap: space.xl }}>
      <RouteHead title={stepTitle} />
      <Card
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          transform: [{ rotate: "0.3deg" }],
        }}
      >
        {/* `dismissTo`, not a push: the earlier step is still mounted under
            this one in the nested `<Stack>` (every step advances with
            `router.push`), so this pops back to it with its state — the
            photos screen's in-memory source files, for one — intact. After
            a reload or a deep link, where nothing is underneath, `dismissTo`
            replaces the current screen instead, which is the same place. */}
        <Link
          href={previous ?? "/"}
          dismissTo={previous !== null}
          accessibilityRole="link"
          accessibilityLabel={previous === null ? "Back to the feed" : `Back to ${GIVE_STEP_NAMES[previous]}`}
        >
          <Text variant="label" color="ink" style={{ fontSize: 12 }}>
            ← Back
          </Text>
        </Link>
        <StepNumerals total={GIVE_STEP_PATHS.length} current={current} />
      </Card>
      <View style={{ flex: 1 }}>{children}</View>
    </ReadableWidth>
  );
}

/**
 * Stands in for the step stack while an `?edit=` prefill fetch is in
 * flight (#289). Before this existed, `GivePhotos` mounted and was fully
 * interactive the moment the flow opened — on a slow connection a giver
 * could add a photo or start typing a title before the fetch landed and
 * `useEditHydration`'s `hydrate` dispatch replaced the whole draft out from
 * under them, wholesale and without warning. Gating the steps behind this
 * instead of letting them render blank means there is nothing to type into
 * until the draft they'd be typing into is the real one.
 */
function GiveStepsGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const { hydrating } = useEditHydration();

  if (hydrating) {
    return (
      <Card style={{ alignItems: "center", paddingVertical: space.xxl, gap: space.md }}>
        <ActivityIndicator accessibilityLabel="Loading your listing" />
        <Text variant="body" color="textSecondary">
          Loading your listing…
        </Text>
      </Card>
    );
  }

  return <>{children}</>;
}

export default function GiveLayout(): React.ReactElement {
  return (
    <GiveDraftProvider>
      <SuggestionFetcher />
      <StepShell>
        <GiveStepsGate>
          <Stack screenOptions={{ headerShown: false }} />
        </GiveStepsGate>
      </StepShell>
    </GiveDraftProvider>
  );
}
