/**
 * Keepsake colour tokens — "the box, not the brand."
 *
 * Ground is deep paper cream + brown-black ink (never pure white/black — the
 * dark ground is a warm charcoal, the inside of a lidded box, not an inverted
 * light mode). Three accents do three different jobs instead of one
 * terracotta doing everything:
 *
 *   accent    warm terracotta — the ONE pill button, the seal ribbon, urgency.
 *   accent2   deep bottle-green ink — links, labels, the "eyebrow" rule, the
 *             secondary voice that keeps accent from being the whole palette.
 *   foil      decorative gold leaf — the wax seal, small ornaments (the ❦
 *             fleuron), hairline flourishes. It is NOT text-safe at full
 *             saturation; use `foilText` for any gold that must carry words.
 *
 * Every accent still follows the three-way split (borrowed from Bayan):
 *
 *   <name>       decorative — fills, rules, icons. Not guaranteed 4.5:1 on `bg`.
 *   <name>Text   the same hue pushed until it clears WCAG AA as text on `bg`
 *                and `surface`. Use for links, chip labels, counts.
 *   on<Name>     ink drawn *on* the filled `<name>` swatch (button labels,
 *                ribbon text). Flips lightness with the scheme so it's always
 *                readable on its own fill, unlike a fixed ink.
 *
 * `inkSoft` is a text tone between `ink` and `textSecondary` for pull quotes,
 * drop caps and hand-set flourishes that want weight without full ink black.
 * `rule` is ink at partial opacity for hairline dividers (deckled edges,
 * card rules) — decorative only, never used to carry text, so it is not in
 * TEXT_ON_GROUND_TOKENS and is allowed to be an rgba() string.
 *
 * Every `text*`, `*Text`, `inkSoft` and `on<Name>` token is verified at 4.5:1
 * by test/contrast.test.ts. Change a hex, run the test.
 */
export const colorsLight = {
  bg: "#F6EFE1",
  surface: "#FBF5E8",
  surfaceSunken: "#ECE0C8",
  border: "#D9C9A3",
  ink: "#241C12",
  textSecondary: "#5C4F3B",
  textTertiary: "#6C5B40",
  inkSoft: "#3D3122",
  accent: "#AB4726",
  accentText: "#8C3A1E",
  onAccent: "#FFF7EC",
  accentSoft: "#EFD6C3",
  accent2: "#1E4D3F",
  accent2Text: "#1E4D3F",
  onAccent2: "#F3ECDC",
  foil: "#B8862E",
  foilText: "#7A5710",
  onFoil: "#241C12",
  rule: "rgba(36,28,18,0.35)",
  success: "#2F7A4A",
  successText: "#256A3E",
  danger: "#A83A2B",
  dangerText: "#8F2F22",
  warning: "#8A5A12",
  focus: "#8C3A1E",
  overlay: "rgba(36,28,18,0.5)",
  shadow: "rgba(60,40,20,0.16)",
  shadowStrong: "rgba(60,40,20,0.28)",
} as const;

export const colorsDark = {
  bg: "#1B1512",
  surface: "#221B16",
  surfaceSunken: "#120E0B",
  border: "#3A2F26",
  ink: "#F5ECDC",
  textSecondary: "#C7B9A0",
  textTertiary: "#9C8F79",
  inkSoft: "#D9CBB0",
  accent: "#E08258",
  accentText: "#F3A97E",
  onAccent: "#2A1208",
  accentSoft: "#3F2A1C",
  accent2: "#5FA98C",
  accent2Text: "#7FC4A8",
  onAccent2: "#0D211B",
  foil: "#D9B155",
  foilText: "#E8C97A",
  onFoil: "#2A1F0A",
  rule: "rgba(245,236,220,0.28)",
  success: "#7CC495",
  successText: "#8FD3A6",
  danger: "#E8897A",
  dangerText: "#F09A8C",
  warning: "#E0B562",
  focus: "#F3A97E",
  overlay: "rgba(0,0,0,0.6)",
  shadow: "rgba(0,0,0,0.35)",
  shadowStrong: "rgba(0,0,0,0.5)",
} as const;

export type ColorTokens = { readonly [K in keyof typeof colorsLight]: string };
export type ColorMode = "light" | "dark";

export const colorsFor = (mode: ColorMode): ColorTokens =>
  mode === "dark" ? colorsDark : colorsLight;

/** Tokens that must read as text on `bg` and `surface` at WCAG AA. */
export const TEXT_ON_GROUND_TOKENS = [
  "ink",
  "textSecondary",
  "textTertiary",
  "inkSoft",
  "accentText",
  "accent2Text",
  "foilText",
  "successText",
  "dangerText",
  "warning",
  "focus",
] as const satisfies readonly (keyof ColorTokens)[];
