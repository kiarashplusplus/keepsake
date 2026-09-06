/**
 * Radii lean square, like a tag or a card stock box, not a SaaS bubble.
 * `pill` stays reserved for the one intentional round shape: the primary
 * button (and its chip cousins). `tag` is the small punch-corner radius for
 * card-as-tag treatments.
 */
export const radii = {
  sm: 4,
  md: 8,
  lg: 14,
  pill: 999,
  tag: 6,
} as const;

/**
 * Shadows are warm-tinted (see colors.shadow/shadowStrong) and layered like
 * paper resting on paper: a hairline contact shadow plus a soft, negative-
 * spread cast shadow, rather than one blurry grey smudge. Expressed as CSS
 * `boxShadow` strings because under the New Architecture that prop renders
 * on iOS, Android and web alike. Each still takes a single color so callers
 * are unchanged; the two-layer look comes from reusing that color at two
 * different offsets/blurs.
 */
export const shadow = {
  card: (color: string) => `0px 1px 0px ${color}, 0px 8px 20px -10px ${color}`,
  cardHover: (color: string) => `0px 1px 0px ${color}, 0px 14px 28px -10px ${color}`,
  sheet: (color: string) => `0px 2px 0px ${color}, 0px 24px 48px -16px ${color}`,
  /** A tag lifted an inch off the table: tighter, closer contact shadow. */
  tag: (color: string) => `0px 1px 0px ${color}, 0px 4px 10px -4px ${color}`,
} as const;
