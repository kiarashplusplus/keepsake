/**
 * Keepsake colour tokens — v3, "Polaroids on a table."
 *
 * The whole identity is: objects laid out on a tabletop. A photograph, once
 * printed, does not change colour when you turn the lights down in the room
 * — so almost nothing here flips between light and dark. Only the TABLE
 * itself (`bg`/`tableEdge`, kraft by day, walnut at night) and the shadows
 * it casts (`shadow`/`shadowStrong`/`overlay`/`lampLight`) respond to the
 * room's lighting. Every object resting on the table — the print, its ink
 * caption, the pencil-grey secondary line, the red rubber stamp, the tape,
 * the kraft-tinted index card an input looks like — stays exactly the same
 * colour in both modes. `bg`/`tableEdge` are decorative backdrop only: no
 * component in this app renders text directly on them without a paper
 * object (a print, an index card, the header's paper strip) underneath it,
 * so dark mode never asks black ink to sit on a dark table.
 *
 * `surface` is the *chrome* paper — the tint an input, sheet, chip or the
 * header bar is cut from (a lined index card: warm, kraft-tinted, not
 * stark). `print` is a slightly brighter, cleaner white reserved for the
 * photograph's own frame. Both are constant.
 *
 * `bg`/`tableEdge`/`shadow*`/`overlay`/`lampLight` are the only tokens that
 * differ between `colorsLight` and `colorsDark` — verified by
 * `test/contrast.test.ts`'s "never invert" check, which asserts every other
 * key is byte-identical across the two objects.
 */
export const colorsLight = {
  // --- the table (the only tokens that flip) ---
  bg: "#D2BC97",
  table: "#D2BC97",
  tableEdge: "#B89D74",
  surfaceSunken: "#B89D74",
  overlay: "rgba(27,24,21,0.55)",
  shadow: "rgba(60,40,20,0.18)",
  shadowStrong: "rgba(60,40,20,0.32)",
  /** The lamp's warm pool of light behind the hero, on the dark table only — a pale wash in light mode, where it does nothing. */
  lampLight: "rgba(255,247,224,0.35)",

  // --- objects on the table (constant in both modes) ---
  surface: "#F1E6CC",
  border: "#B89D74",
  print: "#FBF9F4",
  ink: "#1B1815",
  textSecondary: "#5A524A",
  pencil: "#5A524A",
  textTertiary: "#6C6150",
  inkSoft: "#3A332B",
  accent2: "#1B1815",
  accent2Text: "#1B1815",
  onAccent2: "#F1E6CC",
  accent: "#C4341C",
  stamp: "#C4341C",
  accentText: "#8A2113",
  stampText: "#8A2113",
  onAccent: "#FBF9F4",
  accentSoft: "#F0D6C9",
  foil: "#8A6D3F",
  foilText: "#5C4726",
  onFoil: "#FBF9F4",
  rule: "rgba(27,24,21,0.32)",
  tape: "rgba(255,236,160,0.55)",
  tapeStripe: "rgba(180,140,40,0.22)",
  success: "#3E6B33",
  successText: "#2E4F26",
  danger: "#A8351F",
  dangerText: "#7A2515",
  warning: "#5E4610",
  focus: "#7A2515",
} as const;

export const colorsDark = {
  // --- the table (the only tokens that flip) ---
  bg: "#2B2119",
  table: "#2B2119",
  tableEdge: "#1C140F",
  surfaceSunken: "#1C140F",
  overlay: "rgba(0,0,0,0.6)",
  shadow: "rgba(8,5,2,0.55)",
  shadowStrong: "rgba(8,5,2,0.7)",
  /** The lamp's warm pool of light — the whole point of dark mode's ambience. */
  lampLight: "rgba(255,214,140,0.16)",

  // --- objects on the table (byte-identical to colorsLight — see file header) ---
  surface: "#F1E6CC",
  border: "#B89D74",
  print: "#FBF9F4",
  ink: "#1B1815",
  textSecondary: "#5A524A",
  pencil: "#5A524A",
  textTertiary: "#6C6150",
  inkSoft: "#3A332B",
  accent2: "#1B1815",
  accent2Text: "#1B1815",
  onAccent2: "#F1E6CC",
  accent: "#C4341C",
  stamp: "#C4341C",
  accentText: "#8A2113",
  stampText: "#8A2113",
  onAccent: "#FBF9F4",
  accentSoft: "#F0D6C9",
  foil: "#8A6D3F",
  foilText: "#5C4726",
  onFoil: "#FBF9F4",
  rule: "rgba(27,24,21,0.32)",
  tape: "rgba(255,236,160,0.55)",
  tapeStripe: "rgba(180,140,40,0.22)",
  success: "#3E6B33",
  successText: "#2E4F26",
  danger: "#A8351F",
  dangerText: "#7A2515",
  warning: "#5E4610",
  focus: "#7A2515",
} as const;

export type ColorTokens = { readonly [K in keyof typeof colorsLight]: string };
export type ColorMode = "light" | "dark";

export const colorsFor = (mode: ColorMode): ColorTokens =>
  mode === "dark" ? colorsDark : colorsLight;

/** Tokens that are objects on the table: constant across `colorsLight`/
 * `colorsDark`, verified against both the chrome `surface` and the
 * photograph `print` white. See `test/contrast.test.ts`. */
export const TEXT_ON_GROUND_TOKENS = [
  "ink",
  "textSecondary",
  "textTertiary",
  "inkSoft",
  "accent2Text",
  "accentText",
  "foilText",
  "successText",
  "dangerText",
  "warning",
  "focus",
] as const satisfies readonly (keyof ColorTokens)[];

/** The only tokens allowed to differ between light and dark — the table
 * itself and the light it's under. Everything else must be byte-identical;
 * see `test/contrast.test.ts`'s "never invert" check. */
export const TABLE_TOKENS = ["bg", "table", "tableEdge", "surfaceSunken", "overlay", "shadow", "shadowStrong", "lampLight"] as const satisfies readonly (keyof ColorTokens)[];
