/**
 * Type scale — v3, "Polaroids on a table." Two faces, doing two different
 * jobs, and nothing else visible anywhere in the product:
 *
 *   Fraunces (variable: opsz, SOFT, WONK) — headlines and the story itself.
 *     Pushed to a high `opsz` for display type so terminals get chunky and
 *     idiosyncratic (a hand-set headline, not a poster font at rest); kept
 *     low for the story body so it reads like well-set prose.
 *   CourierPrime (static Regular/Bold, upright + italic) — every caption,
 *     label, stamp, button and metadata line: the "typewritten on the
 *     frame" voice. Set with a touch of positive tracking (0.02em-ish) and
 *     allowed to run lowercase.
 *
 * Font family names must match the @font-face declarations in
 * apps/web/app/+html.tsx (preflight checks the files exist). Sizes/line
 * heights are px; `letterSpacing` on the mono faces is expressed in px per
 * the RN convention already used here, tuned to read as ~0.02em at each
 * size rather than a fixed number.
 */
export const fontFamily = {
  display: "Fraunces",
  displayItalic: "Fraunces",
  mono: "CourierPrime",
  /** Kept as an alias of `mono` — v2 code (and Input/TextArea) referred to
   * the UI face as `ui`; there is no separate sans anymore. */
  ui: "CourierPrime",
} as const;

export type TypeStyle = {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: "400" | "500" | "600" | "700";
  readonly letterSpacing?: number;
  readonly fontStyle?: "normal" | "italic";
  readonly textTransform?: "uppercase";
  /** Raw CSS `font-variation-settings` value, e.g. '"opsz" 144, "SOFT" 40, "WONK" 1'. Fraunces only. */
  readonly fontVariationSettings?: string;
};

export const type = {
  displayXl: {
    fontFamily: "Fraunces",
    fontSize: 56,
    lineHeight: 54,
    fontWeight: "600",
    letterSpacing: -1.6,
    fontVariationSettings: '"opsz" 144, "SOFT" 20, "WONK" 1',
  },
  displayLg: {
    fontFamily: "Fraunces",
    fontSize: 40,
    lineHeight: 40,
    fontWeight: "600",
    letterSpacing: -1,
    fontVariationSettings: '"opsz" 100, "SOFT" 14, "WONK" 1',
  },
  displayMd: {
    fontFamily: "Fraunces",
    fontSize: 27,
    lineHeight: 30,
    fontWeight: "600",
    letterSpacing: -0.4,
    fontVariationSettings: '"opsz" 60, "SOFT" 10, "WONK" 0',
  },
  /** The wordmark, set italic with the softened, wonky alternates on — a
   * hand-lettered word on a print, not a logotype. */
  wordmark: {
    fontFamily: "Fraunces",
    fontSize: 26,
    lineHeight: 30,
    fontWeight: "600",
    fontStyle: "italic",
    letterSpacing: -0.3,
    fontVariationSettings: '"opsz" 144, "SOFT" 60, "WONK" 1',
  },
  /** First letter of the deck/about copy. */
  dropCap: {
    fontFamily: "Fraunces",
    fontSize: 64,
    lineHeight: 56,
    fontWeight: "600",
    fontVariationSettings: '"opsz" 144, "SOFT" 60, "WONK" 1',
  },
  /** Oversized numerals for step counts / stats. */
  numeral: {
    fontFamily: "Fraunces",
    fontSize: 96,
    lineHeight: 88,
    fontWeight: "500",
    letterSpacing: -2,
    fontVariationSettings: '"opsz" 144, "SOFT" 10, "WONK" 0',
  },
  /** A handwritten-feel section heading — a step or two down from
   * `displayMd`, meant to sit above a pencil-underline SVG stroke. */
  handwritten: {
    fontFamily: "Fraunces",
    fontSize: 22,
    lineHeight: 26,
    fontWeight: "600",
    fontStyle: "italic",
    fontVariationSettings: '"opsz" 40, "SOFT" 40, "WONK" 1',
  },
  /** The typewritten label above a display heading, and every other
   * spaced-caps eyebrow in the product. */
  eyebrow: {
    fontFamily: "CourierPrime",
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    letterSpacing: 1.6,
    textTransform: "uppercase",
  },
  storyExcerpt: {
    fontFamily: "Fraunces",
    fontSize: 18,
    lineHeight: 27,
    fontWeight: "400",
    fontStyle: "italic",
    fontVariationSettings: '"opsz" 12, "SOFT" 20, "WONK" 1',
  },
  bodyLg: {
    fontFamily: "Fraunces",
    fontSize: 18,
    lineHeight: 29,
    fontWeight: "400",
    fontVariationSettings: '"opsz" 12, "SOFT" 0, "WONK" 0',
  },
  /** A listing's title as it reads on the print — a small serif caption,
   * not a UI heading. */
  title: {
    fontFamily: "Fraunces",
    fontSize: 19,
    lineHeight: 23,
    fontWeight: "600",
    fontVariationSettings: '"opsz" 30, "SOFT" 10, "WONK" 0',
  },
  body: { fontFamily: "Fraunces", fontSize: 16, lineHeight: 25, fontWeight: "400", fontVariationSettings: '"opsz" 12, "SOFT" 0, "WONK" 0' },
  bodySm: { fontFamily: "Fraunces", fontSize: 14, lineHeight: 21, fontWeight: "400", fontVariationSettings: '"opsz" 9, "SOFT" 0, "WONK" 0' },
  /** Typewritten metadata: distances, dates, counts — lowercase reads fine. */
  caption: { fontFamily: "CourierPrime", fontSize: 12, lineHeight: 17, fontWeight: "400", letterSpacing: 0.3 },
  /** A button/chip/badge label: typewritten, spaced, uppercase. */
  label: { fontFamily: "CourierPrime", fontSize: 12, lineHeight: 16, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  /** The rubber-stamp word itself: bigger, heavier tracking, always uppercase. */
  stamp: { fontFamily: "CourierPrime", fontSize: 13, lineHeight: 16, fontWeight: "700", letterSpacing: 2, textTransform: "uppercase" },
} as const satisfies Record<string, TypeStyle>;

export type TypeToken = keyof typeof type;

/** Web-only fluid size for the story body: 18px on phones up to 20px on desktop. */
export const storyFluidFontSize = "clamp(18px, 1.6vw, 20px)";

/** Old-style figures in running prose (Fraunces supports them); web-only CSS value. */
export const proseFontVariantNumeric = "oldstyle-nums";
