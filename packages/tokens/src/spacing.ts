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
} as const;
