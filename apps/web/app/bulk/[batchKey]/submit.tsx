// Batch workspace — Submit: select which ready items to publish, run the
// age check once for the whole submission, and watch the operation
// progress. Saving/uploading never submits anything by itself — only this
// screen's own button does.
import * as React from "react";
import { View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { Page } from "@/ui/Page";
import { Card } from "@/ui/Surface";
import { TableHeading } from "@/ui/TableHeading";
import { AgeGateField, isAgeGateValid } from "@/features/ageGate/AgeGateField";
import { useBulkWorkspaceContext } from "@/features/bulk/BulkWorkspaceContext";
import { listItems } from "@/features/bulk/batchStore";

const POLL_INTERVAL_MS = 3000;

export default function BulkSubmit(): React.ReactElement {
  const workspace = useBulkWorkspaceContext();
  const items = listItems(workspace.state);
  const readyItems = items.filter((i) => i.ready === true);
  const notReadyCount = items.length - readyItems.length;

  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(readyItems.map((i) => i.clientItemId)));
  const [dateOfBirth, setDateOfBirth] = React.useState("");
  const [dobTouched, setDobTouched] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const ageValid = isAgeGateValid(dateOfBirth);

  React.useEffect(() => {
    void workspace.refreshOperations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.state.batch.id]);

  React.useEffect(() => {
    const hasActive = workspace.operations.some((op) => op.status === "queued" || op.status === "running");
    if (!hasActive) return undefined;
    const id = setInterval(() => void workspace.refreshOperations(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.operations]);

  function toggle(clientItemId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(clientItemId)) next.delete(clientItemId);
      else next.add(clientItemId);
      return next;
    });
  }

  async function handleSubmit(): Promise<void> {
    setDobTouched(true);
    if (!ageValid || selected.size === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    const result = await workspace.submitItems(Array.from(selected), dateOfBirth);
    setSubmitting(false);
    if (!result.ok) {
      setSubmitError(result.error.message);
      return;
    }
    setSelected(new Set());
  }

  const submittedCount = items.filter((i) => i.state === "submitted" || i.listingId !== null).length;
  const queuedCount = items.filter((i) => i.state === "queued").length;
  const failedCount = items.filter((i) => i.state === "failed").length;
  const draftCount = items.length - submittedCount - queuedCount - failedCount;

  return (
    <Page>
      <View style={{ gap: space.lg }}>
        <Card style={{ gap: space.md }}>
          <View style={{ gap: space.xs }}>
            <Eyebrow>Submit</Eyebrow>
            <Text variant="displayLg">{"Publish what's ready."}</Text>
            <Text variant="bodyLg" color="textSecondary">
              {readyItems.length} ready · {notReadyCount} need details · {failedCount} upload failure{failedCount === 1 ? "" : "s"}
            </Text>
            <Text variant="caption" color="textTertiary">
              {"Submitting doesn't publish everything at once, and there's no promise every item goes live together or by any particular date — each one runs through the ordinary review on its own."}
            </Text>
          </View>

          {readyItems.length === 0 ? (
            <Text variant="body" color="textSecondary">
              {"Nothing is ready yet — head back to Review to finish an item's title, story and category."}
            </Text>
          ) : (
            <View style={{ gap: space.sm }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Button label="Select all ready" variant="ghost" onPress={() => setSelected(new Set(readyItems.map((i) => i.clientItemId)))} />
                <Button label="Select none" variant="ghost" onPress={() => setSelected(new Set())} />
              </View>
              <View style={{ gap: space.xs }}>
                {readyItems.map((item) => (
                  <View key={item.clientItemId} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                    <Button label={selected.has(item.clientItemId) ? "✓ Selected" : "Select"} variant={selected.has(item.clientItemId) ? "secondary" : "ghost"} onPress={() => toggle(item.clientItemId)} />
                    <Text variant="body" numberOfLines={1} style={{ flex: 1 }}>
                      {item.fields.title !== undefined && item.fields.title !== "" ? item.fields.title : "Untitled"}
                    </Text>
                  </View>
                ))}
              </View>

              <AgeGateField value={dateOfBirth} onChangeText={setDateOfBirth} touched={dobTouched} onBlur={() => setDobTouched(true)} />

              {submitError !== null ? (
                <Text variant="body" color="dangerText">
                  {submitError}
                </Text>
              ) : null}

              <View style={{ flexDirection: "row" }}>
                <Button
                  label={`Submit ${selected.size} item${selected.size === 1 ? "" : "s"}`}
                  loading={submitting}
                  disabled={submitting || selected.size === 0 || !ageValid}
                  onPress={() => void handleSubmit()}
                />
              </View>
            </View>
          )}
        </Card>

        <Card style={{ gap: space.sm }}>
          <TableHeading>Status</TableHeading>
          <Text variant="body" color="textSecondary">
            {draftCount} saved draft{draftCount === 1 ? "" : "s"} · {queuedCount} submitted/pending · {submittedCount} live or moved on · {failedCount} failed
          </Text>
          {workspace.operations.length > 0 ? (
            <View style={{ gap: space.xs }}>
              {workspace.operations.map((op) => (
                <Text key={op.id} variant="caption" color="textTertiary">
                  Submission {op.status} — {op.succeeded} succeeded, {op.failed} failed of {op.total}
                </Text>
              ))}
            </View>
          ) : null}
        </Card>
      </View>
    </Page>
  );
}
