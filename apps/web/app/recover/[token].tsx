// Lands from the recovery email. POSTs the one-time token on mount, stores
// the rotated owner token, and redirects to `/mine` — no user action beyond
// clicking the link.
import * as React from "react";
import { Link, useLocalSearchParams, useRouter } from "expo-router";
import { sectionRhythm } from "@keepsake/tokens/spacing";
import { Page } from "@/ui/Page";
import { EmptyState } from "@/ui/EmptyState";
import { Button } from "@/ui/Button";
import { Stamp } from "@/ui/Stamp";
import { useToast } from "@/ui/Toast";
import { recoverWithToken } from "@/api/recover";
import { setOwnerToken } from "@/lib/ownerToken";
import { ApiError } from "@/api/client";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";
import { RouteHead } from "@/ui/RouteHead";

export default function RecoverToken(): React.ReactElement {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = React.useState<string | null>(null);
  const attempted = React.useRef(false);

  React.useEffect(() => {
    if (attempted.current || typeof token !== "string") return;
    attempted.current = true;

    recoverWithToken(token)
      .then((result) => {
        setOwnerToken(result.ownerToken);
        track(AnalyticsEvents.Recovered);
        router.replace("/mine");
        toast.show("Welcome back.");
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "That link didn't work. It may have already been used.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (error !== null) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
      <RouteHead title="Recovering your account" />
        <EmptyState
          eyebrow="Recovery"
          title="That link didn’t work"
          line={error}
          action={
            <Link href="/recover" asChild>
              <Button label="Try again" />
            </Link>
          }
        />
      </Page>
    );
  }

  return (
    <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
      <RouteHead title="Recovering your account" />
      <EmptyState ornament={<Stamp state="breathing" label="Checking" />} eyebrow="Recovery" title="Getting you back in…" />
    </Page>
  );
}
