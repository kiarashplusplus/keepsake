import * as React from "react";
import { Platform, Text as RNText, type TextProps as RNTextProps, type TextStyle } from "react-native";
import { proseFontVariantNumeric, storyFluidFontSize, type, type TypeStyle, type TypeToken } from "@keepsake/tokens/typography";
import { useColors } from "@/ui/theme";

/** The only colors a body-copy Text is allowed to render in. Anything more
 * decorative (e.g. raw `accent`/`foil` fills) belongs on a Surface, not text —
 * see `packages/tokens/src/colors.ts`'s three-way accent split. Every token
 * here is verified at 4.5:1 on `bg`/`surface` (or is an `on<Name>` ink
 * verified on its own fill). */
export type TextColor =
  | "ink"
  | "inkSoft"
  | "textSecondary"
  | "textTertiary"
  | "accentText"
  | "accent2Text"
  | "foilText"
  | "successText"
  | "dangerText"
  | "onAccent"
  | "onAccent2"
  | "onFoil";

export type TextComponentProps = Omit<RNTextProps, "style"> & {
  variant?: TypeToken;
  color?: TextColor;
  /** Overrides the variant's `font-variation-settings` (Fraunces' opsz/SOFT/
   * WONK axes). Web only; ignored on native until the fonts are bundled. */
  fontVariationSettings?: string;
  /** Hang an opening quotation mark into the margin so the first letter of
   * the excerpt lines up with the lines below. Web only. */
  hangingPunctuation?: boolean;
  style?: TextStyle | TextStyle[] | undefined;
};

// CSS that has no RN counterpart, built as a plain object and cast once so
// the type says "web only" in exactly one place.
function webOnlyStyle(variant: TypeToken, variation: string | undefined, hanging: boolean): TextStyle | null {
  if (Platform.OS !== "web") return null;
  return {
    fontOpticalSizing: "auto",
    ...(variation !== undefined ? { fontVariationSettings: variation } : null),
    ...(variant === "bodyLg" ? { fontSize: storyFluidFontSize, fontVariantNumeric: proseFontVariantNumeric } : null),
    ...(hanging ? { paddingLeft: "0.5em", textIndent: "-0.5em" } : null),
  } as unknown as TextStyle;
}

export function Text({
  variant = "body",
  color = "ink",
  fontVariationSettings,
  hangingPunctuation = false,
  style,
  children,
  ...rest
}: TextComponentProps): React.ReactElement {
  const colors = useColors();
  // Widen to the shared `TypeStyle` shape: `type[variant]` resolves to one
  // specific member of the token union, and several members simply omit
  // `letterSpacing`/`fontStyle`/`textTransform` (rather than declaring them
  // `undefined`) — every member still satisfies `TypeStyle`, so this
  // widening assignment is sound.
  const typeStyle: TypeStyle = type[variant];

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
  };

  const web = webOnlyStyle(variant, fontVariationSettings ?? typeStyle.fontVariationSettings, hangingPunctuation);

  return (
    <RNText style={[composed, web, style]} {...rest}>
      {children}
    </RNText>
  );
}
