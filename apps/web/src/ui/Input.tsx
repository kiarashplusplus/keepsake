import * as React from "react";
import { TextInput, View, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { radii } from "@keepsake/tokens/radii";
import { space } from "@keepsake/tokens/spacing";
import { useColors, useContainerBorder } from "@/ui/theme";
import { Text } from "@/ui/Text";

export type InputProps = Omit<TextInputProps, "style"> & {
  label: string;
  helper?: string | undefined;
  error?: string | undefined;
  maxLength?: number;
  style?: ViewStyle;
};

const MIN_HEIGHT = 44;

/** A single-line field styled as a lined index card: kraft-tinted paper,
 * mono type (this is the one place the product allows a typewritten field
 * instead of a stamp/label), and a 2px ink baseline instead of a boxed
 * border — the baseline thickens and turns stamp-red when focused (the
 * baseline IS the focus ring), and the error colour takes it over. */
export function Input({ label, helper, error, maxLength, value, style, onFocus, onBlur, ...rest }: InputProps): React.ReactElement {
  const colors = useColors();
  const border = useContainerBorder();
  const [focused, setFocused] = React.useState(false);

  const count = typeof value === "string" ? value.length : 0;
  const helperOrError = error ?? helper;

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
    <View style={[{ gap: space.sm }, style]}>
      <Text variant="eyebrow" color="accent2Text">
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        maxLength={maxLength}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholderTextColor={colors.textTertiary}
        style={{
          minHeight: MIN_HEIGHT,
          paddingHorizontal: space.md,
          borderRadius: radii.tag,
          backgroundColor: colors.surface,
          color: colors.ink,
          fontFamily: "CourierPrime",
          fontSize: 15,
          borderBottomWidth: focused ? 3 : border.borderBottomWidth,
          borderBottomColor: error !== undefined ? colors.danger : focused ? colors.focus : border.borderBottomColor,
          // The baseline above is the focus ring; drop the browser's own outline (web-only CSS).
          ...({ outlineStyle: "none" } as unknown as TextStyle),
        }}
        {...rest}
      />
      {helperOrError !== undefined || maxLength !== undefined ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
          <Text variant="caption" color={error !== undefined ? "dangerText" : "textTertiary"} style={{ flex: 1 }}>
            {helperOrError ?? ""}
          </Text>
          {maxLength !== undefined ? (
            <Text variant="caption" color="textTertiary">
              {count}/{maxLength}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
