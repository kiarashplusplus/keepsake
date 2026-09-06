/**
 * Type scale. Fraunces (variable, optical sizes) carries the display sizes and
 * the story itself — serif prose is the point of the product. Inter carries UI.
 *
 * Font family names must match the @font-face declarations in apps/web/app/+html.tsx
 * (preflight checks the files exist). Sizes are px; line heights are px.
 */
export const fontFamily = {
  display: "Fraunces",
  displayItalic: "Fraunces",
  ui: "Inter",
} as const;

export type TypeStyle = {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: "400" | "500" | "600" | "700";
  readonly letterSpacing?: number;
  readonly fontStyle?: "normal" | "italic";
  readonly textTransform?: "uppercase";
};

export const type = {
  displayXl: { fontFamily: "Fraunces", fontSize: 44, lineHeight: 48, fontWeight: "600", letterSpacing: -0.5 },
  displayLg: { fontFamily: "Fraunces", fontSize: 32, lineHeight: 38, fontWeight: "600", letterSpacing: -0.25 },
  displayMd: { fontFamily: "Fraunces", fontSize: 24, lineHeight: 30, fontWeight: "600" },
  storyExcerpt: { fontFamily: "Fraunces", fontSize: 17, lineHeight: 24, fontWeight: "400", fontStyle: "italic" },
  bodyLg: { fontFamily: "Fraunces", fontSize: 18, lineHeight: 28, fontWeight: "400" },
  title: { fontFamily: "Inter", fontSize: 20, lineHeight: 26, fontWeight: "600" },
  body: { fontFamily: "Inter", fontSize: 16, lineHeight: 24, fontWeight: "400" },
  bodySm: { fontFamily: "Inter", fontSize: 14, lineHeight: 20, fontWeight: "400" },
  caption: { fontFamily: "Inter", fontSize: 12, lineHeight: 16, fontWeight: "500" },
  label: { fontFamily: "Inter", fontSize: 13, lineHeight: 16, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" },
} as const satisfies Record<string, TypeStyle>;

export type TypeToken = keyof typeof type;

/** Web-only fluid size for the story body: 17px on phones up to 19px on desktop. */
export const storyFluidFontSize = "clamp(17px, 1.6vw, 19px)";
