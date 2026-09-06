// Give flow — step 4 of 5: an optional email for notifications and device
// recovery. "Skip" clears any partially-typed value rather than leaving
// something unvalidated in the draft.
import * as React from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { MailableEmailSchema, RESERVED_EMAIL_DOMAIN_MESSAGE } from "@keepsake/contracts/common";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Input } from "@/ui/Input";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Surface";
import { useGiveDraft } from "@/features/give/GiveDraftContext";

export default function GiveEmail(): React.ReactElement {
  const router = useRouter();
  const { draft, dispatch } = useGiveDraft();
  const [touched, setTouched] = React.useState(false);

  const trimmed = draft.email.trim();
  const validation = trimmed === "" ? null : MailableEmailSchema.safeParse(trimmed);
  const isValid = validation === null || validation.success;
  const error =
    touched && validation !== null && !validation.success
      ? (validation.error.issues[0]?.message === RESERVED_EMAIL_DOMAIN_MESSAGE
          ? RESERVED_EMAIL_DOMAIN_MESSAGE
          : "That doesn't look like an email address.")
      : undefined;

  function goNext(): void {
    router.push("/give/review");
  }

  function handleContinue(): void {
    setTouched(true);
    if (!isValid) return;
    goNext();
  }

  function handleSkip(): void {
    dispatch({ type: "set_email", email: "" });
    goNext();
  }

  return (
    <Card style={{ gap: space.xl }}>
      <View style={{ gap: space.sm }}>
        <Eyebrow>A way back</Eyebrow>
        <Text variant="displayLg">Want a way back?</Text>
        <Text variant="bodyLg" color="textSecondary">
          Get a note when someone asks, and a way back if you lose this device. Totally optional.
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

      {/* Primary + the underlined second action, never two pills. */}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xl }}>
        <Button label="Continue" onPress={handleContinue} />
        <Button label="Skip" variant="link" onPress={handleSkip} />
      </View>
    </Card>
  );
}
