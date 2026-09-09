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
import { SafetyNote } from "@/ui/SafetyNote";
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

  // Issue #373 finding 1: at 390px the safety paragraph below the date-of-
  // birth field pushed SEND under the fold — cut in half empty, off-screen
  // entirely once the note held a few lines. The paragraph is deliberate
  // copy (see `SafetyNote`'s own doc comment) and isn't the thing to cut, so
  // it stays in the scrolling body and only the action row moves: `Sheet`'s
  // `footer` pins SEND (and the errors a submit attempt produces, which a
  // sender needs to see without hunting for them) below the scroll, visible
  // at whatever the note's length has scrolled the rest of the form to.
  //
  // The `sent` phase had the same shape and was missed the first time round:
  // `item-request-sent.jpg` shows DONE sitting on the very bottom edge of the
  // same 390×844 viewport, pushed there by its own ten-line `SafetyNote`
  // (#224/#308 — load-bearing at the time; finding 9 below shortened it, but
  // the mechanism this comment describes doesn't depend on the note's
  // length, so it's unchanged). Same sheet, same phone, same cause, so it
  // gets the same fix: DONE moves to `footer` too, rather than growing a
  // second mechanism for one button.
  const sheetFooter =
    phase === "sent" ? (
      // Row-wrapped so `Button`'s intrinsic width holds here the same way it
      // did as the form's last child of a `flex-start` column — `Sheet`'s
      // footer is plain `View` (default `alignItems: "stretch"`), and
      // without this Done would stretch edge to edge.
      <View style={{ flexDirection: "row" }}>
        <Button label="Done" onPress={handleClose} />
      </View>
    ) : (
      <View style={{ gap: space.sm }}>
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
    );

  return (
    <Sheet
      visible={visible}
      onClose={handleClose}
      title={phase === "sent" ? "Check your email" : "I'd love this"}
      footer={sheetFooter}
    >
      {phase === "sent" ? (
        <View style={{ gap: space.lg, alignItems: "flex-start" }}>
          {/* Issue #188: this used to say "Sent." — and it wasn't true any
              more the moment the server stopped forwarding an ask nobody had
              confirmed. The request is held until the link in that email is
              clicked, so the copy names the step instead of implying the
              giver already has it. Naming it is also what makes it work: a
              confirmation nobody is expecting is a confirmation people leave
              unread. */}
          <Text variant="body" color="textSecondary">
            {"We've emailed you to check it was really you. Click the link and your note goes to the giver — " +
              "they'll choose in their own time."}
          </Text>
          {/* Issue #224 item 2: this was `<Text variant="caption"
              color="textTertiary">` — 12px mono in the faintest colour the
              palette has, i.e. set exactly like a disclaimer, on the one
              screen where the reader has just committed to meeting a
              stranger. `SafetyNote` carries the argument and the contrast
              number.

              Issue #308 added permission to back out: `terms.html`'s
              "Meeting up safely" list has always carried it, and this
              screen — the moment the reader has already said yes to a
              stranger — is exactly where that pressure lives and exactly
              where the product had never said it.

              Issue #373 finding 9: this paragraph used to also carry "keep
              working out the details here in Keepsake" and "a porch handoff
              is fine", word-for-word what the form's note (below) already
              says — a stranger read the whole safety case twice, once before
              sending and once immediately after. Those two ideas are the
              form note's job now, because they're about *how you'll talk*
              from the moment you send, not about the meetup itself; what's
              specific to this later screen — public and well-lit, bring
              someone, and the back-out permission #308 added — is what a
              reader needs once being chosen is a live possibility, not a
              hypothetical. All five ideas from `terms.html`'s list still
              appear once each across the two notes; none were dropped, only
              re-homed. See `RequestSheet.test.tsx`'s header comment on
              `SENT_COPY` for the map. */}
          <SafetyNote>
            {"If you're chosen: meet somewhere public and well-lit, and bring a friend or tell " +
              "someone the plan. And if anything feels off, you can back out — that's worth more " +
              "than any obligation you feel to a stranger you agreed to meet."}
          </SafetyNote>
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

          {/* The same setting change as the sent screen's note (#224 item 2)
              — both paragraphs are set the same way, as a note the reader is
              meant to read rather than small print.

              Issue #308 had added "or tell someone else the time and place"
              here as a fallback for a reader with nobody free that afternoon
              — most people — alongside "bring a friend". That idea now lives
              on the sent screen's note instead (issue #373 finding 9,
              below), because it pairs with "meet somewhere public": both are
              about the meetup itself, and belong where a reader is closer to
              one actually happening.

              Issue #373 finding 9: this note used to also say "pick a public
              spot" and "bring a friend", the same ground the sent screen's
              note covers — a stranger read the case for meeting safely
              twice, back to back, once before sending and once right after.
              What stays here is what's decision-relevant *before* you send:
              that conversation continues inside Keepsake rather than moving
              to text, and that no in-person meetup is required at all — a
              porch handoff is a normal outcome, not a failure to arrange
              one. See `RequestSheet.test.tsx`'s header comment on `FORM_COPY`
              for the full map of where each of `terms.html`'s five points
              ended up. */}
          <SafetyNote>
            {"A note before you send this: if you're chosen, keep working out the details here " +
              "in Keepsake rather than trading numbers early — and if you'd both rather skip " +
              "meeting in person, a porch handoff works just as well."}
          </SafetyNote>

          <Turnstile ref={turnstileRef} onStatus={setTurnstileStatus} />
        </View>
      )}
    </Sheet>
  );
}
