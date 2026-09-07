// Lands from the "did you ask for this?" link in the confirmRequest email —
// issue #188. This page is the step that makes a request real: until the POST
// below succeeds, the ask exists only as a held row that no giver has been
// shown and that is deleted on its own when the link expires.
//
// A POST from here rather than a plain GET on the emailed URL, and that is
// the whole reason this page exists instead of the link confirming directly:
// mail clients, link scanners and corporate security proxies fetch URLs out
// of messages before a human ever reads them. A confirmation that completed
// on GET would be completed by the victim's own mail provider, and the
// verification would prove nothing at all.
//
// The copy distinguishes an expired link from an invalid one because both are
// reachable only by someone reading mail at the address the link was sent to,
// and "this lapsed, ask again" is actionable where "invalid" is not.
import * as React from "react";
import { useLocalSearchParams } from "expo-router";
import { sectionRhythm } from "@keepsake/tokens/spacing";
import { Page } from "@/ui/Page";
import { EmptyState } from "@/ui/EmptyState";
import { Stamp } from "@/ui/Stamp";
import { useToast } from "@/ui/Toast";
import { ApiError } from "@/api/client";
import { confirmRequestWithToken } from "@/api/confirm";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";

type Phase = "working" | "done" | "gone" | "expired" | "error";

export default function ConfirmToken(): React.ReactElement {
  const { token } = useLocalSearchParams<{ token: string }>();
  const toast = useToast();
  const [phase, setPhase] = React.useState<Phase>("working");
  const attempted = React.useRef(false);

  React.useEffect(() => {
    if (attempted.current || typeof token !== "string") return;
    attempted.current = true;

    confirmRequestWithToken(token)
      .then((result) => {
        track(AnalyticsEvents.RequestConfirmed);
        // Confirmed either way — the difference is whether there was still a
        // giver to pass it to. Saying so is more honest than a blanket
        // "we've let them know" for a keepsake that was given away while the
        // email sat unread.
        setPhase(result.listing_available ? "done" : "gone");
        if (result.listing_available) toast.show("Your request is on its way.");
      })
      .catch((error: unknown) => {
        setPhase(error instanceof ApiError && error.code === "gone" ? "expired" : "error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (phase === "working") {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState ornament={<Stamp state="breathing" label="Working" />} eyebrow="Confirming" title="One moment…" />
      </Page>
    );
  }

  if (phase === "expired") {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState
          eyebrow="Confirm"
          title="This link has expired"
          line="Confirmation links last a few days, and this one has passed. Nothing was sent to the giver, and we've let go of what you wrote. If you still want the keepsake, ask again and we'll send a fresh link."
        />
      </Page>
    );
  }

  if (phase === "error") {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState
          eyebrow="Confirm"
          title="That link didn't work"
          line="This link is invalid, or it has already been used. If you confirmed once already, you're done — there's nothing else to do."
        />
      </Page>
    );
  }

  if (phase === "gone") {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState
          eyebrow="Confirm"
          title="This one's already spoken for"
          line="You confirmed it was you — but this keepsake was given to someone else while the email was on its way, so there's nobody left to pass your note to. Nothing was sent."
        />
      </Page>
    );
  }

  return (
    <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
      <EmptyState
        ornament={<Stamp state="settled" label="Confirmed" />}
        eyebrow="Confirm"
        title="Your request is on its way."
        line="We've passed your note to the giver. There's nothing more to do — if they choose you, you'll hear from them directly at this address. We also emailed you a link that removes your note, email, and phone from our records whenever you want it gone."
      />
    </Page>
  );
}
