// "Lost your listings?" — request a recovery link by email. Always resolves
// to the same "a link is on its way" copy whether or not the address is on
// file (the API itself never reveals which), so this can't be used to probe
// who has an account.
import * as React from "react";
import { View } from "react-native";
import { MailableEmailSchema, RESERVED_EMAIL_DOMAIN_MESSAGE } from "@keepsake/contracts/common";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import { Page } from "@/ui/Page";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Input } from "@/ui/Input";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Surface";
import { Turnstile, type TurnstileHandle, type TurnstileStatus } from "@/ui/Turnstile";
import { recover } from "@/api/recover";
import { ApiError } from "@/api/client";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";

type Phase = "form" | "submitting" | "sent";

export default function Recover(): React.ReactElement {
  const [email, setEmail] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [turnstileStatus, setTurnstileStatus] = React.useState<TurnstileStatus>({ status: "pending" });
  const turnstileRef = React.useRef<TurnstileHandle>(null);
  const [phase, setPhase] = React.useState<Phase>("form");
  const [error, setError] = React.useState<string | null>(null);

  const turnstileReady = turnstileStatus.status === "ready" || turnstileStatus.status === "unconfigured";
  const turnstileToken = turnstileStatus.status === "ready" ? turnstileStatus.token : "";

  const validation = MailableEmailSchema.safeParse(email);
  const emailError =
    touched && !validation.success
      ? (validation.error.issues[0]?.message === RESERVED_EMAIL_DOMAIN_MESSAGE
          ? RESERVED_EMAIL_DOMAIN_MESSAGE
          : "That doesn't look like an email address.")
      : undefined;

  async function handleSubmit(): Promise<void> {
    setTouched(true);
    if (!validation.success) return;
    setPhase("submitting");
    setError(null);
    try {
      await recover({ email: email.trim() }, { turnstileToken });
      setPhase("sent");
      track(AnalyticsEvents.RecoverRequested);
    } catch (err) {
      if (err instanceof ApiError && err.code === "turnstile_failed") {
        turnstileRef.current?.reset();
        setTurnstileStatus({ status: "pending" });
      }
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
      setPhase("form");
    }
  }

  return (
    <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
      <Card style={{ gap: space.xl, transform: [{ rotate: "0.3deg" }] }}>
        <View style={{ gap: space.sm }}>
          <Eyebrow tick>Lost your listings?</Eyebrow>
          <Text variant="displayLg">Get back in.</Text>
          <Text variant="bodyLg" color="textSecondary">
            If you added an email to a keepsake, we can send a link back to your dashboard on this device.
          </Text>
        </View>

        {phase === "sent" ? (
          <Text variant="body" color="textSecondary">
            If we know that address, a link is on its way.
          </Text>
        ) : (
          <View style={{ gap: space.lg }}>
            <Input
              label="Email"
              value={email}
              onChangeText={setEmail}
              onBlur={() => setTouched(true)}
              error={emailError}
              keyboardType="email-address"
              autoCapitalize="none"
              placeholder="you@example.com"
            />

            <Turnstile ref={turnstileRef} onStatus={setTurnstileStatus} />

            {error !== null ? (
              <Text variant="body" color="dangerText">
                {error}
              </Text>
            ) : null}

            <View style={{ flexDirection: "row" }}>
              <Button label="Send the link" loading={phase === "submitting"} disabled={phase === "submitting" || !turnstileReady} onPress={() => void handleSubmit()} />
            </View>
          </View>
        )}
      </Card>
    </Page>
  );
}
