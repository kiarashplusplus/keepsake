/**
 * The vision model's prompt for `POST /api/photos/:id/suggest`, kept
 * separate from `suggest.ts` for the same reason `moderation/prompts.ts` is
 * split from `moderation/image.ts`: so the prompt can be iterated on without
 * touching the call/parse/retry machinery.
 *
 * ## Same discipline as `moderation/prompts.ts` — read that file first
 *
 * `moderation/prompts.ts` documents a real, measured failure: a first draft
 * showed the model a filled-in example JSON object, and the model copied
 * those values instead of looking at the photo — a synthetic bar chart came
 * back tagged as a physical object because the model was completing a
 * template, not classifying. The fix was two changes, both re-usable here:
 *
 * 1. **Placeholders, never values.** `<short, specific name>` gives the
 *    model nothing safe to copy; a filled-in `"Blue ceramic mug"` would.
 * 2. **`subject` first.** Naming what is literally in the frame before
 *    answering anything else forces a look, the same left-to-right
 *    think-then-answer trick moderation relies on.
 *
 * The failure mode is arguably worse here than in moderation: a moderation
 * verdict that ignores the photo still fails safe (`decide.ts` holds an
 * `error` as `pending`, never auto-approves). A *suggestion* that ignores
 * the photo produces a wrong, confident title a giver might not notice and
 * submit anyway — the plan calls this out explicitly: "a suggestion that
 * ignores the photo is worse than none." So the same two rules apply, not
 * as a nice-to-have but because the trap is identical.
 */
import { CATEGORIES } from "@keepsake/contracts/listing";

const CATEGORY_LIST = CATEGORIES.join(" | ");

export const SUGGEST_SYSTEM_PROMPT = `You are looking at a photo for Keepsake, a gifting site where people give away a physical keepsake they no longer need. Someone is about to list this exact object and needs help describing it.

Answer with ONE JSON object and nothing else — no prose, no markdown fences, no text before or after.

Fill in every placeholder from what you actually see. Do not copy the placeholders, and never invent a detail you can't find evidence for in the photo.

{"subject": "<at most 8 words: what is literally in the frame>", "title": "<a short, warm, specific name for the object, the way a person would actually say it — at most 8 words>", "category": "<exactly one of: ${CATEGORY_LIST}>", "condition": "<one short clause naming visible wear, material, or age — empty string if nothing is notable>", "aspects": [{"name": "<one lowercase word: object, material, era, colour, maker, pattern, or another short word if it fits better>", "value": "<one or two words, only if actually visible — omit this whole entry if you're not sure>"}]}

- "subject": name the thing in the frame before you judge anything else about it.
- "title": what a person would call this object out loud, not a listing headline or marketing copy. Prefer the plain name over adjectives — "Blue ceramic mug", not "Beautiful vintage treasure waiting for a new home".
- "category": choose exactly one of ${CATEGORY_LIST}. Use "other" only when none of the rest plausibly fit.
- "condition": describe only what you can actually see — a chip, a worn spot, a stain, tarnish, an age mark. Leave it "" if the object looks unremarkable or condition isn't visible.
- "aspects": zero to six {name, value} pairs for attributes you can actually see in the photo. Prefer the names object, material, era, colour, maker, pattern, but use another short lowercase word if it fits better. Omit an aspect entirely rather than guess — a wrong but confident aspect is worse than a missing one, since someone filtering listings by it would never see this one. Return an empty array if you aren't confident about any attribute.

Return only the JSON object.`;

/** Sent as an extra instruction on the single retry after a parse failure. */
export const SUGGEST_RETRY_INSTRUCTION =
  "Your previous response could not be parsed as JSON. Return only the JSON object described above — no other text.";

/**
 * The user-turn text that accompanies the image. The model needs a text part
 * in the user turn; an image-only turn returned empty responses on preview
 * for the moderation prompt (see `moderation/prompts.ts`), and the same
 * model is used here. Kept as placeholders for the same anchoring reason as
 * the system prompt.
 */
export const SUGGEST_USER_PROMPT = `Look at this photo of a keepsake someone is giving away, then return only the JSON object: {"subject": "<what you see, max 8 words>", "title": "<short, specific name for the object, max 8 words>", "category": "<exactly one of: ${CATEGORY_LIST}>", "condition": "<short clause or empty>", "aspects": [{"name": "<lowercase word, e.g. material or colour>", "value": "<one or two words, omit the entry if unsure>"}]}`;
