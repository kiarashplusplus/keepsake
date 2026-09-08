/**
 * Keepsake colour tokens — v3, "Polaroids on a table."
 *
 * The whole identity is: objects laid out on a tabletop. A photograph, once
 * printed, does not change colour when you turn the lights down in the room
 * — so almost nothing here flips between light and dark. Only the TABLE
 * itself (`bg`/`tableEdge`, linen by day, walnut at night) and the shadows
 * it casts (`shadow`/`shadowStrong`/`overlay`/`lampLight`) respond to the
 * room's lighting. Every object resting on the table — the print, its ink
 * caption, the pencil-grey secondary line, the red rubber stamp, the tape,
 * the linen index card an input looks like — stays exactly the same
 * colour in both modes. `bg`/`tableEdge` are decorative backdrop only: no
 * component in this app renders text directly on them without a paper
 * object (a print, an index card, the header's paper strip) underneath it,
 * so dark mode never asks black ink to sit on a dark table.
 *
 * `surface` is the *chrome* paper — the tint an input, sheet, chip or the
 * header bar is cut from (a lined index card: warm linen, not
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
  bg: "#E4DDD1",
  table: "#E4DDD1",
  tableEdge: "#C9C0B3",
  surfaceSunken: "#C9C0B3",
  overlay: "rgba(40,35,31,0.55)",
  shadow: "rgba(40,35,31,0.14)",
  shadowStrong: "rgba(40,35,31,0.26)",
  /** The lamp's warm pool of light behind the hero, on the dark table only — a pale wash in light mode, where it does nothing. */
  lampLight: "rgba(255,247,224,0.35)",

  // --- objects on the table (constant in both modes) ---
  surface: "#FAF6EE",
  border: "#968A7E",
  print: "#FFFDF8",
  ink: "#28231F",
  textSecondary: "#635B53",
  pencil: "#635B53",
  textTertiary: "#635B53",
  inkSoft: "#49423C",
  accent2: "#28231F",
  accent2Text: "#28231F",
  onAccent2: "#FAF6EE",
  accent: "#A9432E",
  stamp: "#A9432E",
  accentText: "#87301F",
  stampText: "#87301F",
  onAccent: "#FFFDF8",
  accentSoft: "#F0DDD3",
  foil: "#8A6D3F",
  foilText: "#5C4726",
  onFoil: "#FFFDF8",
  rule: "rgba(40,35,31,0.32)",
  tape: "rgba(205,184,140,0.42)",
  tapeStripe: "rgba(139,113,67,0.18)",
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
  surface: "#FAF6EE",
  border: "#968A7E",
  print: "#FFFDF8",
  ink: "#28231F",
  textSecondary: "#635B53",
  pencil: "#635B53",
  textTertiary: "#635B53",
  inkSoft: "#49423C",
  accent2: "#28231F",
  accent2Text: "#28231F",
  onAccent2: "#FAF6EE",
  accent: "#A9432E",
  stamp: "#A9432E",
  accentText: "#87301F",
  stampText: "#87301F",
  onAccent: "#FFFDF8",
  accentSoft: "#F0DDD3",
  foil: "#8A6D3F",
  foilText: "#5C4726",
  onFoil: "#FFFDF8",
  rule: "rgba(40,35,31,0.32)",
  tape: "rgba(205,184,140,0.42)",
  tapeStripe: "rgba(139,113,67,0.18)",
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
