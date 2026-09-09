import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { radii } from "@keepsake/tokens/radii";
import { space } from "@keepsake/tokens/spacing";
import { useColors, useContainerBorder } from "@/ui/theme";
import { Text } from "@/ui/Text";

/**
 * The chrome every field in the product wears: the stamped label above, the
 * control, and the helper/error line with an optional character counter
 * below. Split out of `Input.tsx` for issue #133, where the age gate needed a
 * real `<input type="date">` — a DOM element react-native-web's `TextInput`
 * cannot produce, since it derives its `type` solely from
 * `inputMode`/`keyboardType`/`secureTextEntry` and overwrites any `type` prop
 * with the result.
 *
 * The alternative was a second hand-styled copy of the label/helper/error
 * markup in `DateField.web.tsx`, which would have drifted the first time
 * anyone touched either. `Input` renders exactly what it always did; this is
 * a move, not a redesign.
 */

export type FieldFrameProps = {
  label: string;
  helper?: string | undefined;
  error?: string | undefined;
  /** Rendered as `count/maxLength` on the right of the helper line. Both are
   * needed for the counter to appear. */
  count?: number | undefined;
  maxLength?: number | undefined;
  style?: ViewStyle | undefined;
  children: React.ReactNode;
};

export function FieldFrame({ label, helper, error, count, maxLength, style, children }: FieldFrameProps): React.ReactElement {
  const helperOrError = error ?? helper;
  const showCounter = maxLength !== undefined && count !== undefined;

  return (
    <View style={[{ gap: space.sm }, style]}>
      <Text variant="eyebrow" color="accent2Text">
        {label}
      </Text>
      {children}
      {helperOrError !== undefined || showCounter ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
          <Text variant="caption" color={error !== undefined ? "dangerText" : "textTertiary"} style={{ flex: 1 }}>
            {helperOrError ?? ""}
          </Text>
          {showCounter ? (
            <Text variant="caption" color="textTertiary">
              {count}/{maxLength}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The lined-index-card look shared by every field control: kraft paper, mono
 * type, and a 2px ink baseline that thickens and turns brass/gold
 * (`colors.focus`) on focus (the baseline IS the focus ring), taken over by
 * the red `colors.danger` when there is an error. Focus and error used to
 * share one maroon value (issue #373 finding 6) — a valid, focused field
 * drew the same rule as an invalid one. They are now visually distinct
 * hues, and `hasError` still wins when both are true (mirrors an invalid
 * field's own focus). Returned as plain values rather than a style object
 * so both a react-native `TextInput` and a DOM `<input>` can spend them —
 * the two disagree on `paddingHorizontal` vs `paddingLeft`/`paddingRight`,
 * and on nothing else that matters here. */
export const FIELD_MIN_HEIGHT = 44;
export const FIELD_FONT_SIZE = 15;
export const FIELD_FONT_FAMILY = "CourierPrime";

export function useFieldControlLook({ focused, hasError }: { focused: boolean; hasError: boolean }): {
  backgroundColor: string;
  color: string;
  borderRadius: number;
  paddingHorizontal: number;
  borderBottomWidth: number;
  borderBottomColor: string;
} {
  const colors = useColors();
  const border = useContainerBorder();
  return {
    backgroundColor: colors.surface,
    color: colors.ink,
    borderRadius: radii.tag,
    paddingHorizontal: space.md,
    borderBottomWidth: focused ? 3 : border.borderBottomWidth,
    borderBottomColor: hasError ? colors.danger : focused ? colors.focus : border.borderBottomColor,
  };
}
