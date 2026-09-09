import * as React from "react";
import { TextInput, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { useColors } from "@/ui/theme";
import { FieldFrame, FIELD_FONT_FAMILY, FIELD_FONT_SIZE, FIELD_MIN_HEIGHT, useFieldControlLook } from "@/ui/FieldFrame";

export type InputProps = Omit<TextInputProps, "style"> & {
  label: string;
  helper?: string | undefined;
  error?: string | undefined;
  maxLength?: number;
  style?: ViewStyle;
};

/** A single-line field styled as a lined index card: kraft-tinted paper,
 * mono type (this is the one place the product allows a typewritten field
 * instead of a stamp/label), and a 2px ink baseline instead of a boxed
 * border — the baseline thickens and turns brass/gold (`colors.focus`) when
 * focused (the baseline IS the focus ring), and the red error colour takes
 * it over when there is one (see `FieldFrame`'s `useFieldControlLook`).
 *
 * The label, helper/error line and counter live in `FieldFrame`, shared with
 * `DateField` since issue #133; the look of the control itself lives in
 * `useFieldControlLook` for the same reason. */
export function Input({ label, helper, error, maxLength, value, style, onFocus, onBlur, ...rest }: InputProps): React.ReactElement {
  const colors = useColors();
  const [focused, setFocused] = React.useState(false);
  const look = useFieldControlLook({ focused, hasError: error !== undefined });

  const count = typeof value === "string" ? value.length : 0;

  // Typed via an index into `TextInputProps` (rather than re-importing
  // `NativeSyntheticEvent`/`TextInputFocusEventData` directly) so the
  // handler's parameter type always matches whatever `<TextInput>`'s own
  // prop type resolves to on this platform — react-native-web's shipped
  // types diverge from `@types/react-native`'s here, and importing the
  // event type from a different source than the component itself produces
  // a mismatch that isn't a real bug.
  const handleFocus: TextInputProps["onFocus"] = (event) => {
    setFocused(true);
    onFocus?.(event);
  };
  const handleBlur: TextInputProps["onBlur"] = (event) => {
    setFocused(false);
    onBlur?.(event);
  };

  return (
    <FieldFrame label={label} helper={helper} error={error} count={count} maxLength={maxLength} style={style}>
      <TextInput
        accessibilityLabel={label}
        value={value}
        maxLength={maxLength}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholderTextColor={colors.textTertiary}
        style={{
          minHeight: FIELD_MIN_HEIGHT,
          fontFamily: FIELD_FONT_FAMILY,
          fontSize: FIELD_FONT_SIZE,
          ...look,
          // The baseline above is the focus ring; drop the browser's own outline (web-only CSS).
          ...({ outlineStyle: "none" } as unknown as TextStyle),
        }}
        {...rest}
      />
    </FieldFrame>
  );
}
