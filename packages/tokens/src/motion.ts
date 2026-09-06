/**
 * Motion tokens. Named, so a screen says `motion.spring` rather than inventing
 * numbers. Reduce-motion is folded in here, at the token layer, via
 * `motionSafe(reduce)`: components receive already-tamed values and never
 * check the preference themselves (Bayan's `motionSafe()` idea).
 */
export type SpringToken = { readonly damping: number; readonly stiffness: number; readonly mass: number };

export const motion = {
  /** Interactive transitions; roughly SwiftUI response 0.5 / damping 0.7. */
  spring: { damping: 18, stiffness: 180, mass: 1 },
  /** Sheets and dialogs coming in. */
  modalPresent: { damping: 22, stiffness: 260, mass: 1 },
  /** The seal settling once a listing goes live. */
  settle: { damping: 14, stiffness: 220, mass: 1 },
  standardMs: 300,
  quickMs: 150,
  modalDismissMs: 250,
  imageFadeMs: 200,
  /** One breath of the reviewing seal, in and out. */
  sealBreathMs: 2400,
  /** Skeleton shimmer sweep. */
  shimmerMs: 1400,
} as const;

export type MotionTokens = {
  readonly spring: SpringToken;
  readonly modalPresent: SpringToken;
  readonly settle: SpringToken;
  readonly standardMs: number;
  readonly quickMs: number;
  readonly modalDismissMs: number;
  readonly imageFadeMs: number;
  readonly sealBreathMs: number;
  readonly shimmerMs: number;
  /** True when the user asked for reduced motion; loops (breath, shimmer) must not run. */
  readonly reduce: boolean;
};

const INSTANT: SpringToken = { damping: 100, stiffness: 1000, mass: 1 };

export function motionSafe(reduce: boolean): MotionTokens {
  if (!reduce) return { ...motion, reduce: false };
  return {
    spring: INSTANT,
    modalPresent: INSTANT,
    settle: INSTANT,
    standardMs: 0,
    quickMs: 0,
    modalDismissMs: 0,
    imageFadeMs: 0,
    sealBreathMs: 0,
    shimmerMs: 0,
    reduce: true,
  };
}
