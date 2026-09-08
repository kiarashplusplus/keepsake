// Add / change / remove the giver's email — the only "account" concept in
// the product (a device-bound token plus an optional address for
// notifications and recovery). "Resend" just re-runs `setEmail` with the
// same address, which the API treats the same as a fresh save.
import * as React from "react";
import { View } from "react-native";
import { MailableEmailSchema, RESERVED_EMAIL_DOMAIN_MESSAGE } from "@keepsake/contracts/common";
import type { OwnerMe } from "@keepsake/contracts/owner";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import { Page } from "@/ui/Page";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Input } from "@/ui/Input";
import { Button } from "@/ui/Button";
import { Turnstile, type TurnstileHandle, type TurnstileStatus } from "@/ui/Turnstile";
import { EmptyState } from "@/ui/EmptyState";
import { Card } from "@/ui/Surface";
import { Stamp } from "@/ui/Stamp";
import { useToast } from "@/ui/Toast";
import { useColors } from "@/ui/theme";
import { deleteEmail, getMe, setEmail } from "@/api/me";
import { ApiError } from "@/api/client";
import { getOwnerToken } from "@/lib/ownerToken";
import { RouteHead } from "@/ui/RouteHead";

export default function MineEmail(): React.ReactElement {
  const toast = useToast();
  const colors = useColors();
  const [hasOwnerToken] = React.useState(() => getOwnerToken() !== null);
  const [me, setMe] = React.useState<OwnerMe | null>(null);
  const [emailInput, setEmailInput] = React.useState("");
  const [turnstileStatus, setTurnstileStatus] = React.useState<TurnstileStatus>({ status: "pending" });
  const turnstileRef = React.useRef<TurnstileHandle>(null);
  const [touched, setTouched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const turnstileReady = turnstileStatus.status === "ready" || turnstileStatus.status === "unconfigured";
  const turnstileToken = turnstileStatus.status === "ready" ? turnstileStatus.token : "";

  /** A Turnstile token is single-use: consumed the moment `setEmail` sends
   * it. Without this, Save then Resend shared one token from the same
   * widget render and the second call failed every time — this forces a
   * fresh one before the *next* submit is allowed, right after the one
   * that just spent it. A no-op when unconfigured: there was no real token
   * to begin with, so nothing needs replacing (and there's no later status
   * update that would ever un-stick a `pending` set here by mistake).
   */
  function spendTurnstileToken(): void {
    if (turnstileStatus.status !== "ready") return;
    turnstileRef.current?.reset();
    setTurnstileStatus({ status: "pending" });
  }

  React.useEffect(() => {
    if (!hasOwnerToken) return;
    getMe()
      .then((result) => {
        setMe(result);
        // Prefills the field from the loaded account exactly once, inside
        // the same callback that sets `me` — not a second effect keyed off
        // `me` (which would set state synchronously in an effect body; see
        // SearchBar.tsx's comment on this repo's `react-hooks/set-state-in-effect`
        // rule). A functional update reads the *current* input rather than
        // closing over the empty initial value, so it still never clobbers
        // anything the giver has already typed.
        setEmailInput((current) => (current === "" && result.email !== undefined ? result.email : current));
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Couldn't load your account."));
  }, [hasOwnerToken]);

  const validation = MailableEmailSchema.safeParse(emailInput);
  const emailError =
    touched && !validation.success
      ? (validation.error.issues[0]?.message === RESERVED_EMAIL_DOMAIN_MESSAGE
          ? RESERVED_EMAIL_DOMAIN_MESSAGE
          : "That doesn't look like an email address.")
      : undefined;

  async function handleSave(): Promise<void> {
    setTouched(true);
    if (!validation.success) return;
    setBusy(true);
    setError(null);
    try {
      const result = await setEmail({ email: emailInput.trim() }, { turnstileToken });
      spendTurnstileToken();
      setMe(result);
      toast.show("Check your inbox to verify.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "turnstile_failed") spendTurnstileToken();
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleResend(): Promise<void> {
    if (me?.email === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const result = await setEmail({ email: me.email }, { turnstileToken });
      spendTurnstileToken();
      setMe(result);
      toast.show("Sent again.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "turnstile_failed") spendTurnstileToken();
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await deleteEmail();
      setMe(result);
      setEmailInput("");
      toast.show("Email removed.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!hasOwnerToken) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <RouteHead title="Your email" />
        <EmptyState
          ornament={<Stamp state="idle" label="Email" />}
          eyebrow="Email"
          title="Nothing to show yet"
          line="Give something first — your device gets an owner identity the moment you do, and an email can attach to it then."
        />
      </Page>
    );
  }

  const hasEmail = me !== null && me.email !== undefined;

  return (
    <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
      <RouteHead title="Your email" />
      <Card style={{ gap: space.xl, transform: [{ rotate: "-0.2deg" }] }}>
        <View style={{ gap: space.sm }}>
          <Eyebrow tick>A way back</Eyebrow>
          <Text variant="displayLg">Your email</Text>
          <Text variant="bodyLg" color="textSecondary">
            Get a note when someone asks, and a way back if you lose this device.
          </Text>
        </View>

        {hasEmail ? (
          <View
            style={{
              borderStartWidth: 3,
              borderStartColor: me?.email_verified === true ? colors.success : colors.foil,
              paddingStart: space.md,
            }}
          >
            <Text variant="bodyLg" color={me?.email_verified === true ? "successText" : "foilText"}>
              {me?.email_verified === true ? "Verified." : "Not verified yet — check your inbox, or resend below."}
            </Text>
          </View>
        ) : null}

        <Input
          label="Email"
          value={emailInput}
          onChangeText={setEmailInput}
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

        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md }}>
          <Button label="Save" loading={busy} disabled={busy || !turnstileReady} onPress={() => void handleSave()} />
          {hasEmail && me?.email_verified === false ? (
            <Button label="Resend" variant="secondary" disabled={busy || !turnstileReady} onPress={() => void handleResend()} />
          ) : null}
          {hasEmail ? <Button label="Remove" variant="ghost" disabled={busy} onPress={() => void handleRemove()} /> : null}
        </View>
      </Card>
    </Page>
  );
}
