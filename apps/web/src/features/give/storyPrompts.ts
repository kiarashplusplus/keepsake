/** Gentle prompts that rotate every 6s under the story field on step 2,
 * nudging without demanding a particular structure. */
export const STORY_PROMPTS = [
  "Where did it come from?",
  "Who should have it next?",
  "What did it see?",
  "Why is it hard to let go?",
] as const;

export const STORY_PROMPT_ROTATE_MS = 6000;
