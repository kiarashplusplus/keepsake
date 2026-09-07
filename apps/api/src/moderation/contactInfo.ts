// Contact info in the story is both a privacy problem (an unverified email
// swap outside the platform) and a bypass of the whole request/choose flow —
// caught locally, before any AI call, so it costs nothing from either budget.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/i;
const PHONE_RE = /(?:\+?\d[\s().-]?){7,}\d/;

export function containsContactInfo(text: string): boolean {
  return EMAIL_RE.test(text) || URL_RE.test(text) || PHONE_RE.test(text);
}
