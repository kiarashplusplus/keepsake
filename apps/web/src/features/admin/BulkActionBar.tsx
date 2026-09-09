/**
 * Appears above the queue the moment a checkbox is ticked — the fast path
 * out of "200 cards, one at a time" (issue #11). Every button here still
 * routes through the same confirmation `ReasonSheet` the single-item actions
 * use (`app/admin.tsx`'s `handleSheetConfirm`), stating the exact count, so a
 * destructive bulk action never fires from a single, unconfirmed keystroke.
 *
 * It is `position: sticky` (#360). In normal flow it sat once, between the
 * status tabs and the list, and queue cards are tall — on a phone the
 * moderation-history block alone was twenty lines — so by the second or
 * third checkbox "Reject N" was several screens above the card just ticked,
 * and the fast path was a scroll back to the top per batch. Sticky keeps
 * "N selected / Reject N / Clear selection" pinned under the header for the
 * whole pass. It works because `Page` scrolls in a real `ScrollView` and
 * nothing between it and this bar clips overflow; the header itself sits
 * outside that scroller (`app/_layout.tsx`), so `top` is measured from just
 * beneath it.
 */
import * as React from "react";
import { View, type ViewStyle } from "react-native";
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
        // Opaque on purpose: cards scroll underneath this while it is
        // pinned, and `accentSoft` is a solid wash in both themes.
        backgroundColor: colors.accentSoft,
        // `sticky` is not in react-native's `position` union, but
        // react-native-web passes it straight through to the DOM — the same
        // cast `Print.web.tsx`'s `boxShadow` and `viewport.web.ts` use for
        // CSS react-native's types don't model.
        ...({ position: "sticky", top: space.sm, zIndex: 1 } as ViewStyle),
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
