/**
 * Keepsake colour tokens — "warm keepsake box".
 *
 * Semantic light/dark pairs. Never pure black: the dark ground is a warm
 * near-black so photographs of wood, paper and brass sit on it comfortably.
 *
 * The accent comes in three forms, and the split is the rule that prevents
 * most contrast bugs (borrowed from Bayan's gold):
 *
 *   accent      decorative — button fills, rules, the seal. It is NOT text-safe
 *               on the page ground in light mode (~4.2:1).
 *   accentText  the same hue pushed until it clears WCAG AA (4.5:1) as text on
 *               `bg` and `surface`. Use for links, chip labels, counts.
 *   onAccent    ink drawn *on* `accent` (button labels). Unlike Bayan's gold,
 *               terracotta is dark in light mode and light in dark mode, so this
 *               ink has to flip with the scheme.
 *
 * Every `text*`, `accentText`, `*Text` and `onAccent` token is verified at
 * 4.5:1 by test/contrast.test.ts. Change a hex, run the test.
 */
export const colorsLight = {
  bg: "#FBF7F0",
  surface: "#FFFDF8",
  surfaceSunken: "#F3EDE2",
  border: "#E3D9C9",
  ink: "#1F1B17",
  textSecondary: "#5C544B",
  textTertiary: "#736A61",
  accent: "#B9502F",
  accentText: "#96401F",
  onAccent: "#FFF8F2",
  accentSoft: "#F2D9CC",
  success: "#2F7A4A",
  successText: "#256A3E",
  danger: "#A83A2B",
  dangerText: "#8F2F22",
  warning: "#8A5A12",
  focus: "#96401F",
  overlay: "rgba(31,27,23,0.5)",
  shadow: "rgba(60,40,20,0.10)",
  shadowStrong: "rgba(60,40,20,0.18)",
} as const;

export const colorsDark = {
  bg: "#171310",
  surface: "#1F1A16",
  surfaceSunken: "#120F0D",
  border: "#2E2621",
  ink: "#F3ECE2",
  textSecondary: "#B8ADA1",
  textTertiary: "#948A7E",
  accent: "#D9744F",
  accentText: "#F0A283",
  onAccent: "#2A1208",
  accentSoft: "#3A2418",
  success: "#7CC495",
  successText: "#8FD3A6",
  danger: "#E8897A",
  dangerText: "#F09A8C",
  warning: "#E0B562",
  focus: "#F0A283",
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
  "accentText",
  "successText",
  "dangerText",
  "warning",
  "focus",
] as const satisfies readonly (keyof ColorTokens)[];
