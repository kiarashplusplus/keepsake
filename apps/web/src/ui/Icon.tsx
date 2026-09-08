import * as React from "react";
import { Text, type TextStyle } from "react-native";

/**
 * Every icon this app renders, anywhere — confirmed by grepping every
 * IconButton icon="..." usage and AppHeader's theme toggle.
 * @expo/vector-icons' Ionicons carries ~1,300 glyphs (~207KB Brotli) for
 * these 8; public/fonts/Ionicons-subset.woff2 (~1.6KB, built with fonttools'
 * pyftsubset, see app/+html.tsx's @font-face comment) carries only them, at
 * the same codepoints (Ionicons.json's values), so this map is the one place
 * both have to agree.
 *
 * `star-outline` (PR #263, the bulk-photos "make this the cover" control)
 * landed after the subset was cut (PR #265/#264) and was missing from it —
 * `main` failed `tsc` on the merge of both. Regenerated the woff2 from
 * `@expo/vector-icons@15.1.1`'s own `Ionicons.ttf` (same version this repo
 * had pinned) with `pyftsubset --unicodes=f229,f23b,f24a,f599,f5f6,f5ad,f460,f28c
 * --glyph-names --flavor=woff2`. Regrep this file's own `icon="..."` usages
 * before adding an unlisted glyph next time — same problem otherwise.
 */
const GLYPHS = {
  "chevron-back": "\uf229",
  "chevron-forward": "\uf23b",
  close: "\uf24a",
  "trash-outline": "\uf5f6",
  sunny: "\uf5ad",
  moon: "\uf460",
  contrast: "\uf28c",
  "star-outline": "\uf599",
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
