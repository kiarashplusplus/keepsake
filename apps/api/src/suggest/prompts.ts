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
 *
 * ## `markings` — the third rule, added by #135
 *
 * The first version of this prompt obeyed both rules above and still threw
 * away most of what the model could see. Measured against a real production
 * listing (a fishing-line spool printed `KASTKING`, `SUPER POWER`, `30 LBS
 * 327 YDS`), it returned one aspect — `material: braided` — while the same
 * model, on the same 640px thumb, asked plainly to describe the photo, read
 * every word off the label. The prompt was the limit, not the model: it
 * listed a vocabulary of `object, material, era, colour, maker, pattern` and
 * never once told the model to *read* the thing.
 *
 * `markings` is the fix, and it is the same trick as `subject`: a field that
 * exists to force a look before any judgement is made. "Copy out every word
 * printed on the object, verbatim" is a question with a checkable answer, so
 * the model does the reading first and then has something concrete to turn
 * into aspects. With it, and with `brand`/`model`/`size` named in the
 * vocabulary, the same photo returns `brand: KastKing`, `size: 30 lbs 327
 * yds`, `material: braided line` — identically on three runs out of three at
 * `temperature: 0`.
 *
 * Neither `subject` nor `markings` is ever shown to anyone. That is the
 * point: they are the model's working, not its output.
 */
import { CATEGORIES } from "@keepsake/contracts/listing";

const CATEGORY_LIST = CATEGORIES.join(" | ");

export const SUGGEST_SYSTEM_PROMPT = `You are looking at a photo for Keepsake, a gifting site where people give away a physical keepsake they no longer need. Someone is about to list this exact object and needs help describing it.

Answer with ONE JSON object and nothing else — no prose, no markdown fences, no text before or after.

Fill in every placeholder from what you actually see. Do not copy the placeholders, and never invent a detail you can't find evidence for in the photo.

{"subject": "<at most 8 words: what is literally in the frame>", "markings": "<every word, brand name, model name and number printed on the object, copied verbatim — empty string if the object carries no text>", "title": "<a short, warm, specific name for the object, the way a person would actually say it — at most 8 words>", "category": "<exactly one of: ${CATEGORY_LIST}>", "condition": "<one short lowercase clause naming visible wear, material, or age — empty string if nothing is notable, never a phrase meaning 'nothing is wrong'>", "aspects": [{"name": "<one lowercase word: object, brand, model, material, size, era, colour, pattern, or another short word if it fits better>", "value": "<one to three words, only if actually visible — omit this whole entry if you're not sure>"}]}

- "subject": name the thing in the frame before you judge anything else about it.
- "markings": read the object. Copy out any lettering, logo, model name, size, capacity, weight or length printed, stamped, engraved or woven on it, exactly as written. This is where you look; everything below is what you make of it. Leave it "" only when the object genuinely carries no text.
- "title": what a person would call this object out loud, not a listing headline or marketing copy. Prefer the plain name over adjectives — "Blue ceramic mug", not "Beautiful vintage treasure waiting for a new home".
- "category": choose exactly one of ${CATEGORY_LIST}. Use "other" only when none of the rest plausibly fit.
- "condition": describe only what you can actually see — a chip, a worn spot, a stain, tarnish, an age mark. Write it as a lowercase clause that could follow "from your photo:", e.g. "a small chip near the handle". Leave it "" if the object looks unremarkable or condition isn't visible. Never say an object is new, unused or in perfect condition: you cannot see that in a photo. Never report the *absence* of something either — "no visible damage", "no damage", "none", "good condition", "n/a" and anything like them are all wrong answers here; the empty string "" is the way to say you have nothing to report.
- "aspects": zero to six {name, value} pairs for attributes you can actually see. What you read into "markings" belongs here too — a brand name becomes {"name": "brand", ...}, a model or product name {"name": "model", ...}, a printed size, weight, length or capacity {"name": "size", ...}. Prefer the names object, brand, model, material, size, era, colour, pattern, but use another short lowercase word if it fits better. Omit an aspect entirely rather than guess — a wrong but confident aspect is worse than a missing one, since someone filtering listings by it would never see this one. Return an empty array if you aren't confident about any attribute.

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
export const SUGGEST_USER_PROMPT = `Look at this photo of a keepsake someone is giving away. Read any text on the object first, then return only the JSON object: {"subject": "<what you see, max 8 words>", "markings": "<text printed on the object, verbatim, or empty>", "title": "<short, specific name for the object, max 8 words>", "category": "<exactly one of: ${CATEGORY_LIST}>", "condition": "<short lowercase clause, or empty — never 'no visible damage' or similar>", "aspects": [{"name": "<lowercase word, e.g. brand, model, material or size>", "value": "<one to three words, omit the entry if unsure>"}]}`;
