import * as React from "react";
import { Platform, Text as RNText, type TextProps as RNTextProps, type TextStyle } from "react-native";
import { type, type TypeStyle, type TypeToken, storyFluidFontSize } from "@keepsake/tokens/typography";
import { useColors } from "@/ui/theme";

/** The only colors a body-copy Text is allowed to render in. Anything more
 * decorative (e.g. raw `accent` fills) belongs on a Surface, not text — see
 * `packages/tokens/src/colors.ts`'s three-way accent split. */
export type TextColor = "ink" | "textSecondary" | "textTertiary" | "accentText" | "successText" | "dangerText" | "onAccent";

export type TextComponentProps = Omit<RNTextProps, "style"> & {
  variant?: TypeToken;
  color?: TextColor;
  style?: TextStyle | TextStyle[];
};

export function Text({ variant = "body", color = "ink", style, children, ...rest }: TextComponentProps): React.ReactElement {
  const colors = useColors();
  // Widen to the shared `TypeStyle` shape: `type[variant]` resolves to one
  // specific member of the token union, and several members simply omit
  // `letterSpacing`/`fontStyle`/`textTransform` (rather than declaring them
  // `undefined`) — every member still satisfies `TypeStyle`, so this
  // widening assignment is sound.
  const typeStyle: TypeStyle = type[variant];

  const fluid = Platform.OS === "web" && variant === "bodyLg" ? { fontSize: storyFluidFontSize as unknown as number } : null;

  const composed: TextStyle = {
    fontFamily: typeStyle.fontFamily,
    fontSize: typeStyle.fontSize,
    lineHeight: typeStyle.lineHeight,
    fontWeight: typeStyle.fontWeight,
    ...(typeStyle.letterSpacing !== undefined ? { letterSpacing: typeStyle.letterSpacing } : null),
    ...(typeStyle.fontStyle !== undefined ? { fontStyle: typeStyle.fontStyle } : null),
    ...(typeStyle.textTransform !== undefined ? { textTransform: typeStyle.textTransform } : null),
    color: colors[color],
    // RN's `TextStyle.textAlign` type only lists physical values
    // (left/right/center/justify/auto), but react-native-web passes
    // "start"/"end" straight through to CSS `text-align`, where they are
    // real logical values — exactly what RTL-readiness needs. Cast past the
    // type, not around the requirement.
    textAlign: "start" as unknown as TextStyle["textAlign"],
    ...(fluid ?? null),
  };

  return (
    <RNText style={[composed, style]} {...rest}>
      {children}
    </RNText>
  );
}
