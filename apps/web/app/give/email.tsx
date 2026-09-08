// Give flow — step 4 of 5: the giver's email. Required, not optional.
//
// It used to carry a "Skip", and skipping produced a listing nobody could
// ever be told about. `POST /api/requests/confirm` mails a giver only when
// the owner row holds a *verified* address, so an ask on an emailless
// listing waited until the giver happened to reopen `/mine` on the single
// device holding their token — with no notification, no nudge, and no way
// back at all if that device was lost, since `POST /api/recover` has nothing
// to mail either. The step now states what the address is for, in those
// terms, and `POST /api/listings` enforces the same invariant server-side
// (a client that stops asking cannot quietly reopen the hole).
//
// A giver who has given before is not asked again from scratch: the address
// already on their owner row is prefilled from `GET /api/me`, and if it is
// already verified this step is a confirmation rather than a question. The
// create route treats an unchanged address as a no-op, so passing back
// through here never resets anyone's verification.
import * as React from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { MailableEmailSchema, RESERVED_EMAIL_DOMAIN_MESSAGE } from "@keepsake/contracts/common";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Input } from "@/ui/Input";
import { Button } from "@/ui/Button";
import { Page } from "@/ui/Page";
import { Card } from "@/ui/Surface";
import { useGiveDraft } from "@/features/give/GiveDraftContext";
import { getMe } from "@/api/me";
import { getOwnerToken } from "@/lib/ownerToken";

export default function GiveEmail(): React.ReactElement {
  const router = useRouter();
  const { draft, dispatch } = useGiveDraft();
  const [touched, setTouched] = React.useState(false);
  /** True once `GET /api/me` says the prefilled address is already verified —
   * purely a copy decision (a reassurance line instead of a question). */
  const [alreadyVerified, setAlreadyVerified] = React.useState(false);

  // The owner token is minted during step 1's first photo upload, so by this
  // step a returning giver's row exists and this answers with whatever
  // address it holds. Failure is silent on purpose: an unreachable `/api/me`
  // must leave the giver typing an address, not stuck on an error for a
  // convenience.
  React.useEffect(() => {
    if (getOwnerToken() === null) return undefined;

    let cancelled = false;
    getMe()
      .then((me) => {
        if (cancelled || me.email === undefined) return;
        setAlreadyVerified(me.email_verified);
        // Never clobbers something already typed (or restored from the
        // draft's `sessionStorage` copy) — the same functional-update shape
        // `app/mine/email.tsx` uses for its own prefill.
        dispatch({ type: "prefill_email", email: me.email });
      })
      .catch(() => {
        // Nothing to say: the field is simply empty and the giver types.
      });

    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const trimmed = draft.email.trim();
  const validation = MailableEmailSchema.safeParse(trimmed);
  const error =
    touched && !validation.success
      ? trimmed === ""
        ? "We need an email to tell you when someone asks."
        : validation.error.issues[0]?.message === RESERVED_EMAIL_DOMAIN_MESSAGE
          ? RESERVED_EMAIL_DOMAIN_MESSAGE
          : "That doesn't look like an email address."
      : undefined;

  function handleContinue(): void {
    setTouched(true);
    if (!validation.success) return;
    router.push("/give/review");
  }

  return (
    // See app/give/index.tsx's comment on why this step wraps itself in a
    // `Page` rather than the shell doing it once.
    <Page>
      <Card style={{ gap: space.xl }}>
        <View style={{ gap: space.sm }}>
          <Eyebrow>A way back</Eyebrow>
          <Text variant="displayLg">Where should we reach you?</Text>
          <Text variant="bodyLg" color="textSecondary">
            This is how you hear that someone asked for your keepsake — and the only way back to it if you lose this
            device. We never show it on the listing.
          </Text>
        </View>

        <Input
          label="Email"
          value={draft.email}
          onChangeText={(email) => dispatch({ type: "set_email", email })}
          onBlur={() => setTouched(true)}
          error={error}
          keyboardType="email-address"
          autoCapitalize="none"
          placeholder="you@example.com"
        />

        {alreadyVerified && validation.success ? (
          <Text variant="body" color="successText">
            Verified already — nothing to do but continue.
          </Text>
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xl }}>
          <Button label="Continue" onPress={handleContinue} />
        </View>
      </Card>
    </Page>
  );
}
