// "I'd love this" — the anonymous request form, in the shared `Sheet`.
// Submits with an idempotency key derived from listing + email so a flaky
// retry can't double-post the same request (the API also enforces a unique
// (listing_id, email) constraint independently, surfaced here as a 409).
import * as React from "react";
import { View } from "react-native";
import { z } from "zod";
import { NOTE_MAX, NOTE_MIN, PhoneSchema } from "@keepsake/contracts/request";
import { MailableEmailSchema, RESERVED_EMAIL_DOMAIN_MESSAGE } from "@keepsake/contracts/common";
import { space } from "@keepsake/tokens/spacing";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { TextArea } from "@/ui/TextArea";
import { Input } from "@/ui/Input";
import { Button } from "@/ui/Button";
import { Turnstile, type TurnstileHandle, type TurnstileStatus } from "@/ui/Turnstile";
import { AgeGateField, isAgeGateValid } from "@/features/ageGate/AgeGateField";
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
  const [turnstileStatus, setTurnstileStatus] = React.useState<TurnstileStatus>({ status: "pending" });
  const turnstileRef = React.useRef<TurnstileHandle>(null);
  const [touched, setTouched] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>("form");
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [dateOfBirth, setDateOfBirth] = React.useState("");
  const [gone, setGone] = React.useState(false);

  const turnstileReady = turnstileStatus.status === "ready" || turnstileStatus.status === "unconfigured";
  const turnstileToken = turnstileStatus.status === "ready" ? turnstileStatus.token : "";

  function reset(): void {
    setNote("");
    setEmail("");
    setPhone("");
    setTouched(false);
    setPhase("form");
    setSubmitError(null);
    setConflict(false);
    setDateOfBirth("");
    setGone(false);
  }

  function handleClose(): void {
    onClose();
    reset();
  }

  const noteValidation = NoteSchema.safeParse(note);
  const emailValidation = MailableEmailSchema.safeParse(email);
  const phoneValidation = phone.trim() === "" ? { success: true as const } : PhoneSchema.safeParse(phone);
  const ageGateValid = isAgeGateValid(dateOfBirth);

  const noteError = touched && !noteValidation.success ? noteValidation.error.issues[0]?.message : undefined;
  const emailError =
    touched && !emailValidation.success
      ? (emailValidation.error.issues[0]?.message === RESERVED_EMAIL_DOMAIN_MESSAGE
          ? RESERVED_EMAIL_DOMAIN_MESSAGE
          : "That doesn't look like an email address.")
      : undefined;
  const phoneError = touched && !phoneValidation.success ? "Digits, spaces, and a leading + only." : undefined;

  async function handleSubmit(): Promise<void> {
    setTouched(true);
    setConflict(false);
    setGone(false);
    setSubmitError(null);
    if (!noteValidation.success || !emailValidation.success || !phoneValidation.success || !ageGateValid) return;

    setPhase("submitting");
    const trimmedEmail = email.trim().toLowerCase();
    try {
      // A deterministic key from the same (listingId, email) every time —
      // not a ref generated once — so it's already stable across a retry
      // with no extra bookkeeping needed here.
      const idempotencyKey = hashIdempotencyKey(`${listingId}:${trimmedEmail}`);
      await createRequest(
        listingId,
        {
          note: note.trim(),
          email: trimmedEmail,
          // Issue #64: sent once, validated again server-side, never
          // persisted beyond `age_attested_at` — see `AgeGateField`'s doc
          // comment.
          date_of_birth: dateOfBirth,
          ...(phone.trim() !== "" ? { phone: phone.trim() } : {}),
        },
        { turnstileToken, idempotencyKey },
      );
      setPhase("sent");
      // The matching Google Ads conversion was removed with the rest of the
      // ads plumbing (#175) — it could never fire, because no deploy passed a
      // tag id. This line is our own telemetry and is unaffected.
      track(AnalyticsEvents.RequestSent);
    } catch (error) {
      if (error instanceof ApiError && error.code === "conflict") {
        setConflict(true);
        setPhase("form");
        return;
      }
      if (error instanceof ApiError && error.code === "gone") {
        setGone(true);
        setPhase("form");
        return;
      }
      if (error instanceof ApiError && error.code === "turnstile_failed") {
        turnstileRef.current?.reset();
        setTurnstileStatus({ status: "pending" });
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
          <Text variant="caption" color="textTertiary">
            {"If you're chosen: meet somewhere public and well-lit, bring a friend or tell " +
              "someone the plan, and keep working out the details here in Keepsake rather than " +
              "switching to text. Leaving it on a porch instead of meeting face to face is always " +
              "fine too — just say so."}
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

          <AgeGateField value={dateOfBirth} onChangeText={setDateOfBirth} touched={touched} onBlur={() => setTouched(true)} />

          <Text variant="caption" color="textTertiary">
            {"A note before you send this: if you two meet up, pick a public spot, bring a " +
              "friend if you can, and keep talking here in Keepsake rather than trading numbers " +
              "early. A porch handoff works too, if you'd both rather skip meeting in person."}
          </Text>

          <Turnstile ref={turnstileRef} onStatus={setTurnstileStatus} />

          {conflict ? (
            <Text variant="body" color="dangerText">
              {"You've already asked for this one."}
            </Text>
          ) : null}
          {gone ? (
            <Text variant="body" color="dangerText">
              {"This keepsake was just given to someone else."}
            </Text>
          ) : null}
          {submitError !== null ? (
            <Text variant="body" color="dangerText">
              {submitError}
            </Text>
          ) : null}

          <View style={{ flexDirection: "row" }}>
            <Button
              label="Send"
              loading={phase === "submitting"}
              disabled={phase === "submitting" || !turnstileReady || !ageGateValid}
              onPress={() => void handleSubmit()}
            />
          </View>
        </View>
      )}
    </Sheet>
  );
}
