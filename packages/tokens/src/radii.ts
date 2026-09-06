/**
 * Radii — v3, "Polaroids on a table." Nothing here is a rounded card or a
 * pill anymore: a print has almost-square corners (`print`, ≤2px, just
 * enough to stop the corner looking laser-cut), and a stamped button is a
 * true rectangle (`sm`). `pill`/`tag` are kept (both now equal to `sm`) so
 * anything still importing them compiles unchanged.
 */
export const radii = {
  sm: 2,
  md: 2,
  lg: 2,
  pill: 2,
  tag: 2,
  print: 2,
} as const;

/**
 * Shadows are warm-brown and offset down-and-right, like a print resting
 * proud of the table rather than a UI card floating over a grey page.
 * Expressed as CSS `boxShadow` strings (one colour in, two layers out) so
 * the same call renders on iOS, Android and web under the New Architecture.
 */
export const shadow = {
  card: (color: string) => `2px 3px 0px ${color}, 3px 10px 16px -8px ${color}`,
  cardHover: (color: string) => `3px 5px 0px ${color}, 5px 16px 24px -8px ${color}`,
  sheet: (color: string) => `4px 6px 0px ${color}, 6px 28px 48px -14px ${color}`,
  /** A print lying flat, barely lifted off the table. */
  tag: (color: string) => `1px 2px 0px ${color}, 2px 6px 10px -6px ${color}`,
} as const;
