/**
 * Motion tokens — v3, "Polaroids on a table." Reduce-motion is folded in
 * here, at the token layer, via `motionSafe(reduce)`: components receive
 * already-tamed values and never check the preference themselves.
 *
 * The product's motion vocabulary is entirely physical: prints "drop" onto
 * the table on first render (`dropMs`, `dropSpring`), a hovered print lifts
 * 2px and straightens by `tiltDeg`, a stamp lands with a quick press
 * (`stampMs`), and the one loop left running is the reviewing print's slow
 * tilt (`reviewTiltDeg` / `reviewTiltMs`) — nothing else should animate.
 * Older names (`liftMs`, `tagTiltDeg`, `sealBreathMs`) are kept as aliases
 * so nothing that already imports them breaks.
 */
export type SpringToken = { readonly damping: number; readonly stiffness: number; readonly mass: number };

export const motion = {
  /** Interactive transitions; roughly SwiftUI response 0.5 / damping 0.7. */
  spring: { damping: 18, stiffness: 180, mass: 1 },
  /** Sheets and dialogs coming in. */
  modalPresent: { damping: 22, stiffness: 260, mass: 1 },
  /** The reviewing print settling flat once a listing goes live. */
  settle: { damping: 14, stiffness: 220, mass: 1 },
  /** A print dropping onto the table: scale 1.03 -> 1, tilt settling. */
  dropSpring: { damping: 16, stiffness: 210, mass: 1 },
  standardMs: 300,
  quickMs: 150,
  modalDismissMs: 250,
  imageFadeMs: 200,
  /** A print's drop-onto-the-table entrance. */
  dropMs: 350,
  /** Degrees a hovered print straightens by (and the old per-card lean amount). */
  tiltDeg: 1,
  /** Alias of `tiltDeg`, kept for call sites written against the v2 name. */
  tagTiltDeg: 1,
  /** The full range a listing id's deterministic table-tilt is drawn from: -tiltRangeDeg..+tiltRangeDeg. */
  tiltRangeDeg: 3,
  /** The rubber stamp's press-down: scale 1.15 -> 1, opacity in. */
  stampMs: 120,
  /** One breath of the reviewing print's slow tilt, in degrees. */
  reviewTiltDeg: 1,
  /** Period of the reviewing print's slow tilt loop. */
  reviewTiltMs: 3000,
  /** Alias of `reviewTiltMs`, kept for call sites written against the v2 seal-breath name. */
  sealBreathMs: 3000,
  /** Skeleton shimmer sweep. */
  shimmerMs: 1400,
  /** Hover/press lift on a print, in ms. */
  liftMs: 150,
} as const;

export type MotionTokens = {
  readonly spring: SpringToken;
  readonly modalPresent: SpringToken;
  readonly settle: SpringToken;
  readonly dropSpring: SpringToken;
  readonly standardMs: number;
  readonly quickMs: number;
  readonly modalDismissMs: number;
  readonly imageFadeMs: number;
  readonly dropMs: number;
  readonly tiltDeg: number;
  readonly tagTiltDeg: number;
  readonly tiltRangeDeg: number;
  readonly stampMs: number;
  readonly reviewTiltDeg: number;
  readonly reviewTiltMs: number;
  readonly sealBreathMs: number;
  readonly shimmerMs: number;
  readonly liftMs: number;
  /** True when the user asked for reduced motion; loops (review tilt, shimmer) must not run. */
  readonly reduce: boolean;
};

const INSTANT: SpringToken = { damping: 100, stiffness: 1000, mass: 1 };

export function motionSafe(reduce: boolean): MotionTokens {
  if (!reduce) return { ...motion, reduce: false };
  return {
    spring: INSTANT,
    modalPresent: INSTANT,
    settle: INSTANT,
    dropSpring: INSTANT,
    standardMs: 0,
    quickMs: 0,
    modalDismissMs: 0,
    imageFadeMs: 0,
    dropMs: 0,
    tiltDeg: 0,
    tagTiltDeg: 0,
    tiltRangeDeg: motion.tiltRangeDeg,
    stampMs: 0,
    reviewTiltDeg: 0,
    reviewTiltMs: 0,
    sealBreathMs: 0,
    shimmerMs: 0,
    liftMs: 0,
    reduce: true,
  };
}
