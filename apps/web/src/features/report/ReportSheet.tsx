// "Report" — anonymous, Turnstile-gated. A plain radio list (no dedicated
// primitive for that shape yet elsewhere in `src/ui`) built from
// `REPORT_REASONS`/`REPORT_REASON_LABELS` so a new reason added to the
// contract shows up here without a second edit.
import * as React from "react";
import { Pressable, View } from "react-native";
import { REPORT_REASONS, REPORT_REASON_LABELS, type ReportReason } from "@keepsake/contracts/report";
import { space } from "@keepsake/tokens/spacing";
import { radii } from "@keepsake/tokens/radii";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { TextArea } from "@/ui/TextArea";
import { Button } from "@/ui/Button";
import { Turnstile } from "@/ui/Turnstile";
import { useColors } from "@/ui/theme";
import { createReport } from "@/api/reports";
import { ApiError } from "@/api/client";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";

const DETAILS_MAX = 500;

export type ReportSheetProps = {
  visible: boolean;
  onClose: () => void;
  listingId: string;
};

type Phase = "form" | "submitting" | "sent";

function ReasonRow({ reason, selected, onSelect }: { reason: ReportReason; selected: boolean; onSelect: () => void }): React.ReactElement {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={REPORT_REASON_LABELS[reason]}
      onPress={onSelect}
      style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44 }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: radii.pill,
          borderWidth: 2,
          borderColor: selected ? colors.accent : colors.rule,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected ? <View style={{ width: 9, height: 9, borderRadius: radii.pill, backgroundColor: colors.accent }} /> : null}
      </View>
      <Text variant="body">{REPORT_REASON_LABELS[reason]}</Text>
    </Pressable>
  );
}

export function ReportSheet({ visible, onClose, listingId }: ReportSheetProps): React.ReactElement {
  const [reason, setReason] = React.useState<ReportReason | null>(null);
  const [details, setDetails] = React.useState("");
  const [turnstileToken, setTurnstileToken] = React.useState<string | null>(null);
  const [phase, setPhase] = React.useState<Phase>("form");
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);

  function reset(): void {
    setReason(null);
    setDetails("");
    setPhase("form");
    setSubmitError(null);
    setConflict(false);
  }

  function handleClose(): void {
    onClose();
    reset();
  }

  async function handleSubmit(): Promise<void> {
    if (reason === null) return;
    setConflict(false);
    setSubmitError(null);
    setPhase("submitting");
    try {
      await createReport(
        listingId,
        { reason, ...(details.trim() !== "" ? { details: details.trim() } : {}) },
        { turnstileToken: turnstileToken ?? "" },
      );
      setPhase("sent");
      track(AnalyticsEvents.ReportSent);
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
    <Sheet visible={visible} onClose={handleClose} title={phase === "sent" ? "Reported" : "Report this listing"}>
      {phase === "sent" ? (
        <View style={{ gap: space.lg, alignItems: "flex-start" }}>
          <Text variant="body" color="textSecondary">
            {"Thanks. We'll take a look."}
          </Text>
          <Button label="Done" onPress={handleClose} />
        </View>
      ) : (
        <View style={{ gap: space.lg }}>
          <View accessibilityRole="radiogroup" style={{ gap: space.xs }}>
            {REPORT_REASONS.map((candidate) => (
              <ReasonRow key={candidate} reason={candidate} selected={reason === candidate} onSelect={() => setReason(candidate)} />
            ))}
          </View>

          <TextArea label="Details (optional)" value={details} onChangeText={setDetails} maxLength={DETAILS_MAX} minHeight={80} placeholder="Anything else we should know" />

          <Turnstile onToken={setTurnstileToken} />

          {conflict ? (
            <Text variant="body" color="dangerText">
              {"You've already reported this."}
            </Text>
          ) : null}
          {submitError !== null ? (
            <Text variant="body" color="dangerText">
              {submitError}
            </Text>
          ) : null}

          <View style={{ flexDirection: "row" }}>
            <Button
              label="Submit"
              loading={phase === "submitting"}
              disabled={phase === "submitting" || reason === null || turnstileToken === null}
              onPress={() => void handleSubmit()}
            />
          </View>
        </View>
      )}
    </Sheet>
  );
}
