export const radii = {
  sm: 6,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

/**
 * Shadows are warm-tinted (see colors.shadow) so they read as paper on a table
 * rather than grey smudges. Expressed as CSS `boxShadow` strings because under
 * the New Architecture that prop renders on iOS, Android and web alike.
 */
export const shadow = {
  card: (color: string) => `0px 2px 8px ${color}`,
  cardHover: (color: string) => `0px 6px 18px ${color}`,
  sheet: (color: string) => `0px 12px 32px ${color}`,
} as const;
