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
  /** The field's *resting* height — what it measures with nothing in it.
   * Since issue #217 this is a floor, not a fixed box: the field grows past
   * it to fit what has been typed (see `TEXT_AREA_PADDING` below), so a
   * caller can pick a short resting height on a phone without condemning a
   * long story to be written through a porthole. */
  minHeight?: number;
  style?: ViewStyle;
};

/** The field's own padding, exported because a caller sizing `minHeight` in
 * lines of story type (`app/give/story.tsx`) has to add it back. */
export const TEXT_AREA_PADDING = space.lg;

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
  onContentSizeChange,
  ...rest
}: TextAreaProps): React.ReactElement {
  const colors = useColors();
  const border = useContainerBorder();
  const [focused, setFocused] = React.useState(false);

  // Auto-grow (#217). The story step now asks for a short resting height on
  // a phone so `Continue` isn't pushed off the bottom of the card; that
  // would be a bad trade if a long story then had to be written four lines
  // at a time, so the field grows to fit its own content instead.
  //
  // **Grow-only, deliberately.** react-native-web reports
  // `contentSize.height` as the DOM node's `scrollHeight`
  // (`react-native-web/dist/exports/TextInput/index.js`), and once we have
  // set an explicit `height`, `scrollHeight` is the *greater* of that height
  // and the text inside it — so a measurement taken after deleting a
  // paragraph reports the box we ourselves grew, not the shorter text. The
  // two honest options were "grows and never shrinks" or "reset the height
  // to auto, measure, set it back" on every keystroke, which is a synchronous
  // layout thrash and one missing guard away from a render loop. A field
  // that stays as tall as the longest thing the giver has typed is the
  // harmless half of the trade.
  //
  // Under jest/jsdom nothing is laid out and `scrollHeight` is always 0, so
  // `grown` never leaves 0 and the field renders at exactly `minHeight` —
  // the pre-#217 behaviour, which is why no test has to know this exists.
  const [grown, setGrown] = React.useState(0);
  const handleContentSizeChange: TextInputProps["onContentSizeChange"] = (event) => {
    const measured = event.nativeEvent.contentSize.height;
    // `> current + 1` rather than `!==`: sub-pixel jitter between a reflow
    // and the next keystroke must not schedule a render of its own.
    setGrown((current) => (measured > current + 1 ? measured : current));
    onContentSizeChange?.(event);
  };

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
        onContentSizeChange={handleContentSizeChange}
        placeholderTextColor={colors.textTertiary}
        style={[
          STORY_FONT,
          {
            minHeight,
            // Only once the content is genuinely taller than the resting
            // height: leaving `height` unset below that keeps `minHeight`
            // in charge, so an empty field is exactly what the caller asked
            // for rather than whatever a browser's default rows count is.
            ...(grown > minHeight ? { height: grown } : null),
            padding: TEXT_AREA_PADDING,
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
