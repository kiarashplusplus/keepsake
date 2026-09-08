/**
 * The give flow's field-level validation for title and story, shared by the
 * step that collects each one (`details.tsx`, `story.tsx`) and the review
 * step (#296), which has to know the same thing without re-rendering
 * either field: whether the title and story the draft is about to submit
 * would actually pass `CreateListingInput`'s server-side `TITLE_MIN`/
 * `STORY_MIN` — reachable with either blank by a typed or bookmarked URL,
 * or browser back/forward across the flow, none of which the review step's
 * own submit button used to check. A single shared schema means the three
 * call sites can't quietly drift apart on what "valid" means.
 */
import { z } from "zod";
import { STORY_MAX, STORY_MIN, TITLE_MAX, TITLE_MIN } from "@keepsake/contracts/listing";

export const TitleFieldSchema = z.string().trim().min(TITLE_MIN).max(TITLE_MAX);

export const StoryFieldSchema = z
  .string()
  .trim()
  .min(STORY_MIN, `At least ${STORY_MIN} characters — enough to say what it is and why it matters.`)
  .max(STORY_MAX, `Keep it under ${STORY_MAX} characters.`);
