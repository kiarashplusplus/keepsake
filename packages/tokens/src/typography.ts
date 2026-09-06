/**
 * Type scale. Fraunces (variable: opsz, wght, SOFT, WONK) carries the display
 * sizes, the wordmark, and the story itself — serif prose is the point of the
 * product. Inter carries UI chrome.
 *
 * Fraunces' axes are used on purpose, not left at defaults:
 *   - `opsz` (optical size) is pushed HIGH (near 144) for display and the
 *     wordmark, so terminals get chunky and idiosyncratic; it is left LOW
 *     (near 9) for the story body and italic excerpts, where it should read
 *     like well-set text, not a poster.
 *   - `SOFT` (softness) rounds the terminals — used on display/wordmark/drop
 *     cap for warmth, left at 0 for small UI type where crispness matters.
 *   - `WONK` (wonky alternates) is 1 on display/wordmark/drop cap — the
 *     tilted, hand-set "a" and "g" are the single most recognisable Fraunces
 *     signature. Left at 0 in running Inter-adjacent UI copy.
 *
 * `fontVariationSettings` is a plain CSS string so the web layer can pass it
 * straight through (`style.fontVariationSettings` on web, ignored elsewhere).
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
  /** Raw CSS `font-variation-settings` value, e.g. '"opsz" 144, "SOFT" 100, "WONK" 1'. */
  readonly fontVariationSettings?: string;
};

export const type = {
  displayXl: {
    fontFamily: "Fraunces",
    fontSize: 52,
    lineHeight: 54,
    fontWeight: "600",
    letterSpacing: -1.4,
    fontVariationSettings: '"opsz" 144, "SOFT" 40, "WONK" 1',
  },
  displayLg: {
    fontFamily: "Fraunces",
    fontSize: 38,
    lineHeight: 40,
    fontWeight: "600",
    letterSpacing: -0.9,
    fontVariationSettings: '"opsz" 100, "SOFT" 30, "WONK" 1',
  },
  displayMd: {
    fontFamily: "Fraunces",
    fontSize: 26,
    lineHeight: 30,
    fontWeight: "600",
    letterSpacing: -0.3,
    fontVariationSettings: '"opsz" 60, "SOFT" 20, "WONK" 0',
  },
  /** The wordmark, set italic with the softened, wonky alternates on. */
  wordmark: {
    fontFamily: "Fraunces",
    fontSize: 26,
    lineHeight: 30,
    fontWeight: "600",
    fontStyle: "italic",
    letterSpacing: -0.3,
    fontVariationSettings: '"opsz" 144, "SOFT" 100, "WONK" 1',
  },
  /** First letter of the deck/about copy — big, soft, wonky, like a hand-set initial. */
  dropCap: {
    fontFamily: "Fraunces",
    fontSize: 64,
    lineHeight: 56,
    fontWeight: "600",
    fontVariationSettings: '"opsz" 144, "SOFT" 100, "WONK" 1',
  },
  /** Oversized numerals for step counts / stats — dense, minimal wonk. */
  numeral: {
    fontFamily: "Fraunces",
    fontSize: 96,
    lineHeight: 88,
    fontWeight: "500",
    letterSpacing: -2,
    fontVariationSettings: '"opsz" 144, "SOFT" 30, "WONK" 0',
  },
  /** Spaced small-caps-style serif eyebrow, replacing an all-caps Inter label. */
  eyebrow: {
    fontFamily: "Fraunces",
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    letterSpacing: 2,
    textTransform: "uppercase",
    fontVariationSettings: '"opsz" 9, "SOFT" 0, "WONK" 0',
  },
  storyExcerpt: {
    fontFamily: "Fraunces",
    fontSize: 18,
    lineHeight: 26,
    fontWeight: "400",
    fontStyle: "italic",
    fontVariationSettings: '"opsz" 9, "SOFT" 20, "WONK" 1',
  },
  bodyLg: {
    fontFamily: "Fraunces",
    fontSize: 18,
    lineHeight: 28,
    fontWeight: "400",
    fontVariationSettings: '"opsz" 9, "SOFT" 0, "WONK" 0',
  },
  title: { fontFamily: "Inter", fontSize: 20, lineHeight: 26, fontWeight: "600" },
  body: { fontFamily: "Inter", fontSize: 16, lineHeight: 24, fontWeight: "400" },
  bodySm: { fontFamily: "Inter", fontSize: 14, lineHeight: 20, fontWeight: "400" },
  caption: { fontFamily: "Inter", fontSize: 12, lineHeight: 16, fontWeight: "500" },
  label: { fontFamily: "Inter", fontSize: 13, lineHeight: 16, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" },
} as const satisfies Record<string, TypeStyle>;

export type TypeToken = keyof typeof type;

/** Web-only fluid size for the story body: 18px on phones up to 20px on desktop. */
export const storyFluidFontSize = "clamp(18px, 1.6vw, 20px)";

/** Old-style figures in running prose (Fraunces supports them); web-only CSS value. */
export const proseFontVariantNumeric = "oldstyle-nums";
