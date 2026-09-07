// Contact info in the story is both a privacy problem (an unverified email
// swap outside the platform) and a bypass of the whole request/choose flow —
// caught locally, before any AI call, so it costs nothing from either budget.
//
// The patterns themselves moved to `@keepsake/observability/patterns` in
// #170. They used to live here, and the observability redactor had no idea
// what an email address looked like, so "personal data redacted before
// anything is written" was false for the only PII this product holds. One
// definition, two consumers: this check and `redactString`. If you loosen the
// email rule for moderation you are also loosening what gets scrubbed out of
// Workers Logs — that coupling is the point.
//
// `PHONE_LOOSE_RE` is moderation's own, and is deliberately *not* what the
// redactor uses; see the note on `PHONE_REDACTION_PATTERN` for why a rule
// that is right for a listing story is wrong for a log line.
import { EMAIL_RE, PHONE_LOOSE_RE, URL_RE } from "@keepsake/observability/patterns";

export function containsContactInfo(text: string): boolean {
  return EMAIL_RE.test(text) || URL_RE.test(text) || PHONE_LOOSE_RE.test(text);
}
