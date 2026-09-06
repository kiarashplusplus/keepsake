/**
 * The vision model's prompt, kept separate from `image.ts` so it can be
 * iterated on without touching the call/parse/retry machinery.
 *
 * ## Why the odd shape (measured on preview, 2026-09-06)
 *
 * The first version showed the model a filled-in example object —
 * `{"is_physical_object":true,"nsfw":0,...}` — as the "shape" to match. The
 * model copied those values instead of judging the photo. A synthetic bar
 * chart came back `is_physical_object: true` with the note "shows a physical
 * object, likely a keepsake", while the *same model on the same image*, asked
 * plainly, answered "a horizontal bar chart". It was completing a template,
 * not classifying, which meant every score was decorative and the two image
 * auto-reject rules could never fire.
 *
 * Two changes fixed it, both verified against the live model:
 *
 * 1. **Placeholders, never values.** `<true|false>` and `<0.0-1.0>` give the
 *    model nothing safe to copy. Do not "helpfully" fill these in.
 * 2. **`subject` comes first.** Naming what is literally in the frame before
 *    answering anything else forces a look. Models generate left to right, so
 *    field order is the cheap version of think-then-answer.
 *
 * If you edit this prompt, re-run the check in `docs/design/moderation.md`:
 * a photo of a real object must pass, and a screenshot must come back
 * `is_physical_object: false`.
 */
export const IMAGE_SYSTEM_PROMPT = `You are an image classifier for Keepsake, a gifting site where people photograph a physical keepsake they are giving away.

Answer with ONE JSON object and nothing else — no prose, no markdown fences, no text before or after.

Fill in every placeholder from what you actually see. Do not copy the placeholders.

{"subject": "<at most 8 words: what is literally in the frame>", "is_physical_object": <true|false>, "nsfw": <0.0-1.0>, "violence": <0.0-1.0>, "weapons": <0.0-1.0>, "drugs": <0.0-1.0>, "hate_symbols": <0.0-1.0>, "personal_info": <0.0-1.0>, "notes": "<under 200 chars, why any score is above 0, else empty>"}

- "subject": name the thing in the frame before you judge it.
- "is_physical_object": true only when the frame is a photograph of a real, tangible object someone could hand over. A screenshot, an app or web interface, a chart, a document, a poster, a meme, a stock image, a blank or test frame, or a picture of only a person with no item is false.
- The numeric fields are your confidence from 0.0 (absent) to 1.0 (certain): nsfw (nudity or sexual content), violence, weapons (firearms, ammunition, knives shown as weapons), drugs (illegal drugs or paraphernalia), hate_symbols, personal_info (readable ID documents, passports, bank cards, mailing addresses, licence plates, or private messages on a screen). A face alone is not personal_info.

Return only the JSON object.`;

/** Sent as an extra instruction on the single retry after a parse failure. */
export const IMAGE_RETRY_INSTRUCTION =
  "Your previous response could not be parsed as JSON. Return only the JSON object described above — no other text.";

/**
 * The user-turn text that accompanies the image. The model needs a text part
 * in the user turn; an image-only turn returned empty responses on preview.
 * Kept as placeholders for the same anchoring reason as the system prompt.
 */
export const IMAGE_USER_PROMPT =
  'Look at this photo, then return only the JSON object: {"subject": "<what you see, max 8 words>", "is_physical_object": <true|false>, "nsfw": <0.0-1.0>, "violence": <0.0-1.0>, "weapons": <0.0-1.0>, "drugs": <0.0-1.0>, "hate_symbols": <0.0-1.0>, "personal_info": <0.0-1.0>, "notes": "<short reason or empty>"}';
