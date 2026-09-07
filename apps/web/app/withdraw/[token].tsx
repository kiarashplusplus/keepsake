// Lands from the "withdraw your request" link in the requestReceived
// confirmation email. POSTs the one-time token on mount and erases the
// requester's note, email, and phone from our records — see
// `apps/api/src/routes/requestWithdraw.ts` and docs/design/identity.md's
// "Request withdrawal" section.
//
// This link sits in an inbox indefinitely, so an already-used or expired
// token is an expected, not exceptional, outcome — the API doesn't
// distinguish "never existed", "already withdrawn", and "typo'd" (same
// posture as `/recover/:token`), so neither does this page.
//
// The copy here is deliberately not "your data has been deleted": if the
// giver already chose this requester, the giver already has their contact
// info in an email that landed before this page ever ran. Withdrawing only
// removes Keepsake's own stored copy; it can't recall a message a giver
// already opened.
import * as React from "react";
import { useLocalSearchParams } from "expo-router";
import { sectionRhythm } from "@keepsake/tokens/spacing";
import { Page } from "@/ui/Page";
import { EmptyState } from "@/ui/EmptyState";
import { Stamp } from "@/ui/Stamp";
import { useToast } from "@/ui/Toast";
import { withdrawWithToken } from "@/api/withdraw";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";

type Phase = "working" | "done" | "error";

export default function WithdrawToken(): React.ReactElement {
  const { token } = useLocalSearchParams<{ token: string }>();
  const toast = useToast();
  const [phase, setPhase] = React.useState<Phase>("working");
  const attempted = React.useRef(false);

  React.useEffect(() => {
    if (attempted.current || typeof token !== "string") return;
    attempted.current = true;

    withdrawWithToken(token)
      .then(() => {
        track(AnalyticsEvents.RequestWithdrawn);
        setPhase("done");
        toast.show("Your request was withdrawn.");
      })
      .catch(() => {
        // The API never distinguishes "unknown token" from "already used"
        // from "expired" — mirror that here rather than guessing which one
        // happened, and show fixed, honest copy instead of the raw message.
        setPhase("error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (phase === "working") {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState
          ornament={<Stamp state="breathing" label="Working" />}
          eyebrow="Withdrawing"
          title="Taking care of that…"
        />
      </Page>
    );
  }

  if (phase === "error") {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState
          eyebrow="Withdraw"
          title="That link didn't work"
          line="This link is invalid or has already been used. If you already withdrew your request, there's nothing left to do — your note, email, and phone are already gone from our records."
        />
      </Page>
    );
  }

  return (
    <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
      <EmptyState
        ornament={<Stamp state="settled" label="Withdrawn" />}
        eyebrow="Withdraw"
        title="Your request is withdrawn."
        line="We've erased your note, email, and phone number from our records. If the giver had already chosen you, they may already have an email from us with your contact details — withdrawing removes our copy, but it can't recall a message that already reached them."
      />
    </Page>
  );
}
