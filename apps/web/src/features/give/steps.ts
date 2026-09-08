/**
 * The give flow's five steps, in order, and the one question the shell's
 * Back link asks of them: "what came before this one?"
 *
 * Kept as a pure module (no React, no router) so the answer is unit-testable
 * and so `app/give/_layout.tsx` and anything else that needs to reason about
 * step order read the same table.
 */

export const GIVE_STEP_PATHS = [
  "/give",
  "/give/story",
  "/give/details",
  "/give/email",
  "/give/review",
] as const;

export type GiveStepPath = (typeof GIVE_STEP_PATHS)[number];

/** Short names for the "Back to …" accessibility label — the visible text
 * stays a bare arrow, so this is the only place a screen reader learns where
 * the link actually goes. */
export const GIVE_STEP_NAMES: Record<GiveStepPath, string> = {
  "/give": "photos",
  "/give/story": "story",
  "/give/details": "details",
  "/give/email": "email",
  "/give/review": "review",
};

/** Zero-based index of the step at `pathname`; `0` for anything unknown, so
 * a stray path still renders the numerals rather than an out-of-range mark. */
export function giveStepIndex(pathname: string): number {
  const index = GIVE_STEP_PATHS.findIndex((step) => step === pathname);
  return index === -1 ? 0 : index;
}

/**
 * Where "← Back" goes from `pathname`: the previous step, or `null` on the
 * first one (and on any unknown path), where leaving the flow is the only
 * sensible reading of "back".
 *
 * Before this existed the link went to the feed from every step, so backing
 * out of the story step threw the giver all the way out of the flow — and a
 * moment later "Give" showed them a draft they had not meant to leave.
 */
export function previousGiveStep(pathname: string): GiveStepPath | null {
  const index = GIVE_STEP_PATHS.findIndex((step) => step === pathname);
  if (index <= 0) return null;
  return GIVE_STEP_PATHS[index - 1] ?? null;
}
