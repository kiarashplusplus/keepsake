import * as React from "react";
import { Text, type TextStyle } from "react-native";

/**
 * Every icon this app renders, anywhere — confirmed by grepping every
 * IconButton icon="..." usage and AppHeader's theme toggle.
 * @expo/vector-icons' Ionicons carries ~1,300 glyphs (~207KB Brotli) for
 * these 7; public/fonts/Ionicons-subset.woff2 (~1.5KB, built with fonttools'
 * pyftsubset, see app/+html.tsx's @font-face comment) carries only them, at
 * the same codepoints (Ionicons.json's values), so this map is the one place
 * both have to agree.
 */
const GLYPHS = {
  "chevron-back": "\uf229",
  "chevron-forward": "\uf23b",
  close: "\uf24a",
  "trash-outline": "\uf5f6",
  sunny: "\uf5ad",
  moon: "\uf460",
  contrast: "\uf28c",
} as const;

export type IconName = keyof typeof GLYPHS;

export type IconProps = {
  name: IconName;
  size?: number;
  color?: string;
  style?: TextStyle;
};

export function Icon({ name, size = 12, color, style }: IconProps): React.ReactElement {
  return (
    <Text
      selectable={false}
      style={[{ fontFamily: "Ionicons-subset", fontSize: size, fontWeight: "normal", fontStyle: "normal", color }, style ?? {}]}
    >
      {GLYPHS[name]}
    </Text>
  );
}
