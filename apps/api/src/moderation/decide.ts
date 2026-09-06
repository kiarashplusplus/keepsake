/**
 * Pure decision logic — no I/O, no AI calls — so the minimal-list mapping in
 * the plan's "Moderation pipeline" section can be exhaustively unit tested
 * without touching D1/R2/KV/AI. `pipeline.ts` is the only caller.
 */
import type { ImageVerdict, TextVerdict } from "@keepsake/contracts/admin";
import type { ModerationReasonCode } from "@keepsake/contracts/listing";

export type LocalVerdict = "flag" | "review" | "pass" | "error";

/** Violent crime, sex crimes, child exploitation, indiscriminate weapons. */
const TEXT_FLAG_CODES = new Set(["S1", "S3", "S4", "S9"]);
/**
 * Non-violent crime, privacy, hate, sexual content, and self-harm.
 *
 * S11 (suicide & self-harm) is held for a person rather than auto-rejected.
 * People write about letting go of a parent's things here, and Llama Guard
 * does return S11 on that kind of language — answering someone in distress
 * with an automated "this crosses a line" would be the wrong reply. Holding
 * it puts the listing in the admin queue, invisible, until a human looks.
 */
const TEXT_REVIEW_CODES = new Set(["S2", "S7", "S10", "S11", "S12"]);

const IMAGE_REVIEW_THRESHOLD = 0.5;
const IMAGE_DRUGS_FLAG_THRESHOLD = 0.7;

export function decideText(verdict: TextVerdict | "error"): LocalVerdict {
  if (verdict === "error") return "error";
  if (verdict.verdict === "safe") return "pass";
  if (verdict.codes.some((code) => TEXT_FLAG_CODES.has(code))) return "flag";
  if (verdict.codes.some((code) => TEXT_REVIEW_CODES.has(code))) return "review";
  return "pass";
}

export function decideImage(verdict: ImageVerdict | "error"): LocalVerdict {
  if (verdict === "error") return "error";
  if (verdict.drugs >= IMAGE_DRUGS_FLAG_THRESHOLD) return "flag";
  if (verdict.is_physical_object === false) return "flag";
  if (
    verdict.nsfw >= IMAGE_REVIEW_THRESHOLD ||
    verdict.violence >= IMAGE_REVIEW_THRESHOLD ||
    verdict.weapons >= IMAGE_REVIEW_THRESHOLD ||
    verdict.hate_symbols >= IMAGE_REVIEW_THRESHOLD ||
    verdict.personal_info >= IMAGE_REVIEW_THRESHOLD
  ) {
    return "review";
  }
  return "pass";
}

export type FinalDecision =
  | { status: "pending" }
  | { status: "rejected"; reason: ModerationReasonCode }
  | { status: "needs_review" }
  | { status: "approved" };

/** S4 (child exploitation) and S3 (sex crimes) are both closest to the
 * giver-facing `sexual_content_minors` reason; S9 (indiscriminate weapons)
 * maps to `weapons_of_mass_harm`; everything else flaggable (S1, violent
 * crime, and any unmapped flag code) falls back to `violent_content` — the
 * minimal list only has four rejection reasons to choose from. */
function textRejectReason(codes: string[]): ModerationReasonCode {
  const set = new Set(codes);
  if (set.has("S4")) return "sexual_content_minors";
  if (set.has("S9")) return "weapons_of_mass_harm";
  if (set.has("S3")) return "sexual_content_minors";
  return "violent_content";
}

function imageRejectReason(verdict: ImageVerdict): ModerationReasonCode {
  return verdict.is_physical_object === false ? "not_an_object" : "illegal_drugs";
}

/**
 * Combines one text verdict and N per-photo image verdicts into a listing
 * outcome. Any `error` (AI call threw, or two malformed-JSON parses in a
 * row) stays `pending` — fail-closed, the cron retries. Otherwise: any
 * `flag` (text or image) rejects with the first matching reason; any
 * `review` with no flag holds for manual approval; all-pass approves.
 */
export function decide(textVerdict: TextVerdict | "error", imageVerdicts: (ImageVerdict | "error")[]): FinalDecision {
  const textLocal = decideText(textVerdict);
  const imageLocals = imageVerdicts.map(decideImage);

  if (textLocal === "error" || imageLocals.includes("error")) {
    return { status: "pending" };
  }

  if (textLocal === "flag") {
    const codes = textVerdict !== "error" && textVerdict.verdict === "unsafe" ? textVerdict.codes : [];
    return { status: "rejected", reason: textRejectReason(codes) };
  }

  const flaggedImageIndex = imageLocals.findIndex((local) => local === "flag");
  if (flaggedImageIndex !== -1) {
    const verdict = imageVerdicts[flaggedImageIndex];
    if (verdict !== "error" && verdict !== undefined) {
      return { status: "rejected", reason: imageRejectReason(verdict) };
    }
  }

  if (textLocal === "review" || imageLocals.includes("review")) {
    return { status: "needs_review" };
  }

  return { status: "approved" };
}
