import * as React from "react";
import { Platform, TextInput, View, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { radii } from "@keepsake/tokens/radii";
import { space } from "@keepsake/tokens/spacing";
import { proseFontVariantNumeric, type } from "@keepsake/tokens/typography";
import { useColors, useContainerBorder } from "@/ui/theme";
import { Text } from "@/ui/Text";

export type TextAreaProps = Omit<TextInputProps, "style" | "multiline"> & {
  label: string;
  helper?: string | undefined;
  error?: string | undefined;
  maxLength?: number;
  minHeight?: number;
  style?: ViewStyle;
};

// The story is typed in the same face it will be read in: Fraunces at the
// `bodyLg` story size, low optical size, old-style figures.
const STORY_FONT: TextStyle = {
  fontFamily: type.bodyLg.fontFamily,
  fontSize: type.bodyLg.fontSize,
  lineHeight: type.bodyLg.lineHeight,
  fontWeight: type.bodyLg.fontWeight,
  ...(Platform.OS === "web"
    ? ({ fontVariationSettings: type.bodyLg.fontVariationSettings, fontVariantNumeric: proseFontVariantNumeric, outlineStyle: "none" } as unknown as TextStyle)
    : null),
};

/** Multiline field for the story — same label/helper/error/counter shape as
 * `Input`, taller by default, always `multiline`, set in the story face. */
export function TextArea({
  label,
  helper,
  error,
  maxLength,
  minHeight = 160,
  value,
  style,
  onFocus,
  onBlur,
  ...rest
}: TextAreaProps): React.ReactElement {
  const colors = useColors();
  const border = useContainerBorder();
  const [focused, setFocused] = React.useState(false);

  const count = typeof value === "string" ? value.length : 0;
  const helperOrError = error ?? helper;

  // See `Input.tsx`'s identical handlers for why these are typed via an
  // index into `TextInputProps` rather than imported event types directly.
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
        multiline
        textAlignVertical="top"
        value={value}
        maxLength={maxLength}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholderTextColor={colors.textTertiary}
        style={[
          STORY_FONT,
          {
            minHeight,
            padding: space.lg,
            borderRadius: radii.tag,
            backgroundColor: colors.surface,
            color: colors.ink,
            borderBottomWidth: focused ? 3 : border.borderBottomWidth,
            borderBottomColor: error !== undefined ? colors.danger : focused ? colors.focus : border.borderBottomColor,
          },
        ]}
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
