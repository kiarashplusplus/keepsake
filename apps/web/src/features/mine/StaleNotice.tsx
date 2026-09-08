// What a listing needs from its giver, said in sentences: one line per
// staleness reason, plus the one button that fixes the mailbox half of it.
//
// Shared by the dashboard's list and detail views so the two cannot drift
// into describing the same condition differently — the copy itself lives in
// `features/mine/staleness.ts` (pure, unit-tested) and this file is only its
// arrangement on the page.
import * as React from "react";
import { View } from "react-native";
import { Link } from "expo-router";
import { space } from "@keepsake/tokens/spacing";
import type { ListingStaleness } from "@keepsake/contracts/listing";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { OWNER_EMAIL_PROBLEM_COPY, staleLines } from "@/features/mine/staleness";

export function StaleNotice({ staleness }: { staleness: ListingStaleness }): React.ReactElement | null {
  if (staleness.reasons.length === 0) return null;

  // Whichever email reason is present (they are mutually exclusive — an
  // address is missing or unverified, never both), so the fix is offered
  // with the words that match the state the giver is actually in.
  const emailReason = staleness.reasons.find((reason) => reason === "email_missing" || reason === "email_unverified");

  return (
    <View style={{ gap: space.sm }}>
      {staleLines(staleness).map((line) => (
        <Text key={line} variant="body" color="dangerText">
          {line}
        </Text>
      ))}
      {emailReason !== undefined ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md }}>
          <Link href="/mine/email" asChild>
            <Button label={OWNER_EMAIL_PROBLEM_COPY[emailReason].action} variant="secondary" />
          </Link>
        </View>
      ) : null}
    </View>
  );
}
