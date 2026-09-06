// "I'd love this" — the anonymous request form, in the shared `Sheet`.
// Submits with an idempotency key derived from listing + email so a flaky
// retry can't double-post the same request (the API also enforces a unique
// (listing_id, email) constraint independently, surfaced here as a 409).
import * as React from "react";
import { View } from "react-native";
import { z } from "zod";
import { NOTE_MAX, NOTE_MIN, PhoneSchema } from "@keepsake/contracts/request";
import { EmailSchema } from "@keepsake/contracts/common";
import { space } from "@keepsake/tokens/spacing";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { TextArea } from "@/ui/TextArea";
import { Input } from "@/ui/Input";
import { Button } from "@/ui/Button";
import { Turnstile } from "@/ui/Turnstile";
import { createRequest } from "@/api/requests";
import { ApiError } from "@/api/client";
import { hashIdempotencyKey } from "@/lib/hashIdempotencyKey";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";

const NoteSchema = z
  .string()
  .trim()
  .min(NOTE_MIN, `At least ${NOTE_MIN} characters — say why it should be yours.`)
  .max(NOTE_MAX, `Keep it under ${NOTE_MAX} characters.`);

export type RequestSheetProps = {
  visible: boolean;
  onClose: () => void;
  listingId: string;
};

type Phase = "form" | "submitting" | "sent";

export function RequestSheet({ visible, onClose, listingId }: RequestSheetProps): React.ReactElement {
  const [note, setNote] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [turnstileToken, setTurnstileToken] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>("form");
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);

  function reset(): void {
    setNote("");
    setEmail("");
    setPhone("");
    setTouched(false);
    setPhase("form");
    setSubmitError(null);
    setConflict(false);
  }

  function handleClose(): void {
    onClose();
    reset();
  }

  const noteValidation = NoteSchema.safeParse(note);
  const emailValidation = EmailSchema.safeParse(email);
  const phoneValidation = phone.trim() === "" ? { success: true as const } : PhoneSchema.safeParse(phone);

  const noteError = touched && !noteValidation.success ? noteValidation.error.issues[0]?.message : undefined;
  const emailError = touched && !emailValidation.success ? "That doesn't look like an email address." : undefined;
  const phoneError = touched && !phoneValidation.success ? "Digits, spaces, and a leading + only." : undefined;

  async function handleSubmit(): Promise<void> {
    setTouched(true);
    setConflict(false);
    setSubmitError(null);
    if (!noteValidation.success || !emailValidation.success || !phoneValidation.success) return;

    setPhase("submitting");
    const trimmedEmail = email.trim().toLowerCase();
    try {
      const idempotencyKey = hashIdempotencyKey(`${listingId}:${trimmedEmail}`);
      await createRequest(
        listingId,
        { note: note.trim(), email: trimmedEmail, ...(phone.trim() !== "" ? { phone: phone.trim() } : {}) },
        { turnstileToken: turnstileToken ?? "", idempotencyKey },
      );
      setPhase("sent");
      track(AnalyticsEvents.RequestSent);
    } catch (error) {
      if (error instanceof ApiError && error.code === "conflict") {
        setConflict(true);
        setPhase("form");
        return;
      }
      setSubmitError(error instanceof ApiError ? error.message : "That didn't go through. Try again.");
      setPhase("form");
    }
  }

  return (
    <Sheet visible={visible} onClose={handleClose} title={phase === "sent" ? "Sent" : "I'd love this"}>
      {phase === "sent" ? (
        <View style={{ gap: space.lg, alignItems: "flex-start" }}>
          <Text variant="body" color="textSecondary">
            Sent. The giver will choose in their own time.
          </Text>
          <Button label="Done" onPress={handleClose} />
        </View>
      ) : (
        <View style={{ gap: space.lg }}>
          <TextArea
            label="Note"
            value={note}
            onChangeText={setNote}
            maxLength={NOTE_MAX}
            minHeight={120}
            error={noteError}
            placeholder="Tell them why it should be yours"
          />
          <Input
            label="Email"
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              setConflict(false);
            }}
            keyboardType="email-address"
            autoCapitalize="none"
            error={emailError}
            placeholder="you@example.com"
          />
          <Input label="Phone (optional)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" error={phoneError} placeholder="Optional" />

          <Turnstile onToken={setTurnstileToken} />

          {conflict ? (
            <Text variant="body" color="dangerText">
              {"You've already asked for this one."}
            </Text>
          ) : null}
          {submitError !== null ? (
            <Text variant="body" color="dangerText">
              {submitError}
            </Text>
          ) : null}

          <View style={{ flexDirection: "row" }}>
            <Button label="Send" loading={phase === "submitting"} disabled={phase === "submitting" || turnstileToken === null} onPress={() => void handleSubmit()} />
          </View>
        </View>
      )}
    </Sheet>
  );
}
