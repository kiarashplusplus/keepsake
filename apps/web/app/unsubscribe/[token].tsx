// `/unsubscribe/:token` — the human-facing half of issue #310's real
// unsubscribe mechanism. Lands from the link `templates/shared.ts` now puts
// in every outbound email's footer.
//
// Unlike `/confirm/:token` and `/withdraw/:token`, this page does NOT act on
// mount. Those two pages fire on mount and lean on "a scanner fetches the
// page's HTML but doesn't execute its JS" as the guard against a prefetch —
// a fine bet for an action a person already asked for by clicking a link
// mailed in direct response to something *they* just did. Unsubscribing is
// different in exactly the way the task that added this page insists on:
// the consequence has to be stated in plain words *before* the person
// confirms, not after, and "a scanner probably won't run the JS" is not the
// same guarantee as "nothing happens without a click." So this page loads
// read-only status on mount (`GET /api/unsubscribe/:token` — see that
// route's own header for why GET never mutates), shows what will and won't
// stop arriving, and only calls `POST` when the visitor presses the button.
//
// A compliant mail client's own one-click "Unsubscribe" affordance never
// reaches this page at all — it POSTs straight to
// `POST /api/unsubscribe/:token` per RFC 8058, using the client's own UI as
// the confirmation. This page exists for the link a person reads and clicks
// themselves.
import * as React from "react";
import { View } from "react-native";
import { Link, useLocalSearchParams } from "expo-router";
import { space, sectionRhythm } from "@keepsake/tokens/spacing";
import { Page } from "@/ui/Page";
import { EmptyState } from "@/ui/EmptyState";
import { Button } from "@/ui/Button";
import { Stamp } from "@/ui/Stamp";
import { useToast } from "@/ui/Toast";
import { unsubscribeStatus, confirmUnsubscribe, confirmResubscribe } from "@/api/unsubscribe";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";
import { RouteHead } from "@/ui/RouteHead";

type Phase = "loading" | "confirm-unsubscribe" | "confirm-resubscribe" | "unsubscribed" | "resubscribed" | "working" | "error";

/** What keeps arriving regardless of this page's outcome, stated once here
 * and echoed in both confirm screens so the promise and the consequence
 * live in the same sentence — see `src/email/sendMail.ts`'s
 * `TRANSACTIONAL_EMAIL_KINDS` for the actual decision this describes. */
const STILL_ARRIVES =
  "Anything about a request or account action you started yourself still arrives either way — confirming a request, being chosen for one, account recovery, and verifying an email address. Those aren't affected by this page.";

export default function UnsubscribeToken(): React.ReactElement {
  const { token } = useLocalSearchParams<{ token: string }>();
  const toast = useToast();
  const [phase, setPhase] = React.useState<Phase>("loading");

  React.useEffect(() => {
    if (typeof token !== "string") return;
    let cancelled = false;
    unsubscribeStatus(token)
      .then((status) => {
        if (cancelled) return;
        setPhase(status.unsubscribed ? "confirm-resubscribe" : "confirm-unsubscribe");
      })
      .catch(() => {
        if (!cancelled) setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleUnsubscribe(): Promise<void> {
    if (typeof token !== "string") return;
    setPhase("working");
    try {
      await confirmUnsubscribe(token);
      track(AnalyticsEvents.Unsubscribed);
      setPhase("unsubscribed");
      toast.show("You're unsubscribed.");
    } catch {
      setPhase("error");
    }
  }

  async function handleResubscribe(): Promise<void> {
    if (typeof token !== "string") return;
    setPhase("working");
    try {
      await confirmResubscribe(token);
      track(AnalyticsEvents.Resubscribed);
      setPhase("resubscribed");
      toast.show("You're resubscribed.");
    } catch {
      setPhase("error");
    }
  }

  if (phase === "loading" || phase === "working") {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <RouteHead title="Email preferences" />
        <EmptyState ornament={<Stamp state="breathing" label="Working" />} eyebrow="Email" title="One moment…" />
      </Page>
    );
  }

  if (phase === "error") {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <RouteHead title="Email preferences" />
        <EmptyState
          eyebrow="Email"
          title="That link didn't work"
          line="This link is invalid, or something went wrong reaching Keepsake just now. If you meant to change your email preferences, try the link in a recent email again."
          action={
            <Link href="/" asChild>
              <Button label="Back to the feed" />
            </Link>
          }
        />
      </Page>
    );
  }

  if (phase === "confirm-unsubscribe") {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <RouteHead title="Stop these emails?" />
        <EmptyState
          eyebrow="Email"
          title="Stop these emails?"
          line={`If you continue, we'll stop emailing you when someone asks for something you're giving away — those requests still show up on your dashboard, so check there if you'd otherwise miss one. ${STILL_ARRIVES} You can undo this later from the same link.`}
          action={
            <View style={{ gap: space.lg, alignItems: "center" }}>
              <Button label="Stop these emails" onPress={handleUnsubscribe} />
              <Link href="/" asChild>
                <Button label="Never mind" variant="link" />
              </Link>
            </View>
          }
        />
      </Page>
    );
  }

  if (phase === "confirm-resubscribe") {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <RouteHead title="Email preferences" />
        <EmptyState
          eyebrow="Email"
          title="You're currently unsubscribed"
          line={`You won't hear when someone asks for something you're giving away — check your dashboard instead if you're wondering why it's been quiet. ${STILL_ARRIVES} Want these back?`}
          action={
            <View style={{ gap: space.lg, alignItems: "center" }}>
              <Button label="Start receiving these again" onPress={handleResubscribe} />
              <Link href="/mine" asChild>
                <Button label="Go to my dashboard" variant="link" />
              </Link>
            </View>
          }
        />
      </Page>
    );
  }

  if (phase === "unsubscribed") {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <RouteHead title="Unsubscribed" />
        <EmptyState
          ornament={<Stamp state="settled" label="Unsubscribed" />}
          eyebrow="Email"
          title="You're unsubscribed."
          line={`We'll stop emailing you when someone asks for something you're giving away. ${STILL_ARRIVES} Changed your mind? Use this same link any time to turn it back on.`}
          action={
            <Link href="/mine" asChild>
              <Button label="Go to my dashboard" />
            </Link>
          }
        />
      </Page>
    );
  }

  return (
    <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
      <RouteHead title="Resubscribed" />
      <EmptyState
        ornament={<Stamp state="settled" label="Resubscribed" />}
        eyebrow="Email"
        title="You're back on the list."
        line="We'll email you again when someone asks for something you're giving away."
        action={
          <Link href="/" asChild>
            <Button label="Back to the feed" />
          </Link>
        }
      />
    </Page>
  );
}
