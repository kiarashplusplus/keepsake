/**
 * Appears above the queue the moment a checkbox is ticked — the fast path
 * out of "200 cards, one at a time" (issue #11). Every button here still
 * routes through the same confirmation `ReasonSheet` the single-item actions
 * use (`app/admin.tsx`'s `handleSheetConfirm`), stating the exact count, so a
 * destructive bulk action never fires from a single, unconfirmed keystroke.
 */
import * as React from "react";
import { View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { radii } from "@keepsake/tokens/radii";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { useColors } from "@/ui/theme";
import type { QueueActionSet } from "@/features/admin/QueueItemCard";

export type BulkActionBarProps = {
  count: number;
  actions: QueueActionSet;
  onApprove: () => void;
  onHide: () => void;
  onReject: () => void;
  onClear: () => void;
};

export function BulkActionBar({ count, actions, onApprove, onHide, onReject, onClear }: BulkActionBarProps): React.ReactElement | null {
  const colors = useColors();

  if (count === 0) return null;

  return (
    // No `accessibilityLabel` here on purpose: an ancestor's `aria-label`
    // overrides the accessible name computation for everything inside it,
    // which would make the visible "N selected" text and each button's own
    // "Approve N"/"Hide N" label invisible to assistive tech (and, not
    // coincidentally, to `getByText` in this file's test) even though they
    // are the actual, more specific content — a `role="toolbar"` landmark
    // doesn't strictly need a name of its own to be usable.
    <View
      accessibilityRole="toolbar"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: space.md,
        padding: space.md,
        borderWidth: 2,
        borderColor: colors.ink,
        borderRadius: radii.md,
        backgroundColor: colors.accentSoft,
      }}
    >
      <Text variant="label" color="ink">
        {`${count} selected`}
      </Text>
      {actions.approve ? <Button label={`Approve ${count}`} onPress={onApprove} /> : null}
      {actions.hide ? <Button label={`Hide ${count}`} variant="secondary" onPress={onHide} /> : null}
      {actions.reject ? <Button label={`Reject ${count}`} variant="secondary" onPress={onReject} /> : null}
      <Button label="Clear selection" variant="ghost" onPress={onClear} />
    </View>
  );
}
