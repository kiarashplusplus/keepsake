/**
 * The launch announcement: the first thing anyone sees on keepsake.ing from
 * now until the meetup is over.
 *
 * Launch is Friday 27 November 2026, the day after Thanksgiving; the first
 * in-person meetup is Saturday the 28th. This opens over whatever route the
 * visitor landed on, throws one burst of paper confetti, says both things,
 * and gets out of the way on one press. It is an announcement, not a gate:
 * the site underneath is fully usable the moment it is dismissed, and
 * `launchPlan.ts` keeps it off the routes people reach from an email link.
 *
 * It decides everything AFTER mount, from an effect. The static export
 * renders these routes in Node with no clock worth trusting and no
 * `localStorage`, so the prerendered HTML never contains the dialog and
 * there is nothing for hydration to disagree with — the same shape as
 * `useConsentInset`. That also keeps it out of what a crawler indexes as the
 * page's content.
 *
 * Web only: `Platform.OS !== "web"` renders nothing.
 */
import * as React from "react";
import { Linking, Platform, View } from "react-native";
import { usePathname } from "expo-router";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";
import { useConsentInset } from "@/ui/useConsentInset";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { PencilRule } from "@/ui/PencilRule";
import { Confetti } from "@/features/launch/Confetti";
import {
  countdownLabel,
  launchPhase,
  shouldShowLaunch,
  LAUNCH_DATE_LABEL,
  LAUNCH_DISMISSED_KEY,
  MEETUP_DATE_LABEL,
  MEETUP_URL,
  type LaunchPhase,
} from "@/features/launch/launchPlan";

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(LAUNCH_DISMISSED_KEY);
  } catch {
    // Storage blocked (private mode, a strict blocker): show it. Seeing an
    // announcement twice is the cheap direction to be wrong in.
    return null;
  }
}

function writeDismissed(phase: LaunchPhase): void {
  try {
    window.localStorage.setItem(LAUNCH_DISMISSED_KEY, phase);
  } catch {
    // Nothing to do; it will show again next load.
  }
}

/** The rubber stamp across the top of the card. */
function LaunchStamp({ label }: { label: string }): React.ReactElement {
  const colors = useColors();
  return (
    <View style={{ alignItems: "flex-start" }}>
      <View
        style={{
          borderWidth: 2,
          borderColor: colors.accent,
          paddingVertical: 6,
          paddingHorizontal: 10,
          transform: [{ rotate: "-3deg" }],
        }}
      >
        <Text variant="stamp" color="stampText">
          {label}
        </Text>
      </View>
    </View>
  );
}

export type LaunchModalProps = {
  /** Test seam: the clock. Production reads the real one. */
  now?: () => Date;
};

export function LaunchModal({ now }: LaunchModalProps): React.ReactElement | null {
  const colors = useColors();
  const motion = useMotion();
  const pathname = usePathname();
  const consentInset = useConsentInset();
  // `null` until the effect has looked: closed on the server, closed on the
  // first client render, and only then possibly open.
  const [phase, setPhase] = React.useState<LaunchPhase | null>(null);
  const [today, setToday] = React.useState<Date | null>(null);

  // Decided once, for the route the visitor LANDED on. Navigating later must
  // not pop it open mid-task, and must not close it either — so `pathname`
  // is read through a ref, not listed as a dependency.
  const landedOn = React.useRef(pathname);
  const clock = React.useRef(now);
  React.useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const current = clock.current?.() ?? new Date();
    if (!shouldShowLaunch({ now: current, pathname: landedOn.current, stored: readDismissed() })) return;
    setToday(current);
    setPhase(launchPhase(current));
  }, []);

  const close = React.useCallback(() => {
    setPhase((open) => {
      if (open !== null) writeDismissed(open);
      return null;
    });
  }, []);

  const confettiColors = React.useMemo(
    () => [colors.accent, colors.foil, colors.print, colors.accentSoft, colors.success, colors.ink],
    [colors],
  );

  if (phase === null || phase === "over" || today === null) return null;

  const live = phase === "live";

  return (
    <>
      <Sheet
        visible
        centered
        blurBackdrop
        bottomInset={consentInset}
        onClose={close}
        accessibilityLabel={live ? "Keepsake is open" : `Keepsake launches ${LAUNCH_DATE_LABEL}`}
        footer={
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.lg, paddingHorizontal: space.xs }}>
            <Button label={live ? "Start looking" : "Come on in"} onPress={close} />
            {MEETUP_URL !== null ? (
              <Button
                variant="link"
                label="RSVP on Meetup"
                onPress={() => {
                  void Linking.openURL(MEETUP_URL as string);
                }}
              />
            ) : null}
          </View>
        }
      >
        {/* The top and side padding is room for the stamp: it is rotated, so
            its corners swing a few pixels outside its own box, and the
            sheet's scrolling body clips anything outside itself — which cut
            the stamp's top border off on a real phone. */}
        <View style={{ gap: space.md, paddingTop: space.sm, paddingHorizontal: space.xs, paddingBottom: space.sm }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md }}>
            <LaunchStamp label={live ? "We're open" : "Save the date"} />
            {live ? null : (
              <Text variant="label" color="textSecondary">
                {countdownLabel(today)}
              </Text>
            )}
          </View>

          <Text variant="displayLg" color="ink" accessibilityRole="header">
            {live ? "We're open." : "We launch Nov 27."}
          </Text>

          <Text variant="body" color="inkSoft">
            {live
              ? "Come see what's on the table."
              : "Give something you love a second life. Free, always."}
          </Text>

          <PencilRule />

          <Text variant="label" color="stampText">
            Meet us in person
          </Text>
          <Text variant="title" color="ink">
            {MEETUP_DATE_LABEL}
          </Text>
          <Text variant="caption" color="textSecondary">
            {MEETUP_URL !== null ? "Free" : "Free · RSVP soon on Meetup"}
          </Text>
        </View>
      </Sheet>
      {motion.reduce ? null : <Confetti colors={confettiColors} />}
    </>
  );
}
