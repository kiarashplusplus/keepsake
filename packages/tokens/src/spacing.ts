/** 4pt grid. Use the names, not the numbers, so density changes stay one edit. */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
  huge: 64,
} as const;
export type SpaceToken = keyof typeof space;

/** Content measures. Prose reads best under ~75 characters; the grid can go wider. */
export const measure = {
  prose: 720,
  grid: 1100,
  /** Narrower measure for the asymmetric hero: text sits on 7 of 12 columns. */
  heroText: 560,
} as const;

/**
 * Named vertical rhythm between sections. Deliberately UNEQUAL — evenly
 * spaced sections are exactly the "generic AI landing page" tell this scale
 * exists to avoid. Pick the name for what the section is doing, not a slot.
 */
export const sectionRhythm = {
  /** Tight beat right after the hero, before the eye adjusts. */
  tight: space.xxl,
  /** The default between most sections. */
  normal: space.xxxl,
  /** A section that should feel like its own chapter. */
  loose: 96,
  /** Above the hero / below the closing CTA. */
  bookend: 112,
} as const;

