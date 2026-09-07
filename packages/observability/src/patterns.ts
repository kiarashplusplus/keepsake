/**
 * The single definition of what personal data *looks like* in this codebase.
 *
 * Two very different consumers need "is that an email address?" and they used
 * to answer it separately:
 *
 *  - `apps/api/src/moderation/contactInfo.ts` — does a listing story contain
 *    contact details the giver is trying to route around the request flow with?
 *  - `./redact.ts` — is there personal data about to be written to Workers
 *    Logs or handed to a diagnostic surface?
 *
 * Issue #170 was exactly the gap between them: the moderation side had a
 * working email regex and the redactor had none, so the privacy page's
 * "personal data redacted before anything is written" was false for the only
 * PII this product holds. One definition, imported by both, is the fix — and
 * this package is where it has to live, because `@keepsake/observability` is
 * dependency-free and `apps/api` already depends on it. The other direction
 * would be a cycle.
 *
 * **Exported as pattern *sources*, not as ready-made `RegExp` objects with
 * flags baked in.** A `RegExp` carrying `g` is stateful — `lastIndex` survives
 * between calls — so a shared global instance used with `.test()` in one
 * consumer silently returns alternating true/false in another. Each consumer
 * builds its own instance with the flags it needs. The non-global `*_RE`
 * exports below are the convenience form for `.test()` only.
 *
 * No lookbehind and no named groups anywhere in this file, for the same
 * reason `redact.ts` says so: it must be able to run on React Native Hermes,
 * which supports neither.
 */

/**
 * An email address. Byte-for-byte the regex that lived in
 * `apps/api/src/moderation/contactInfo.ts` before #170 — deliberately
 * unchanged, because moving a definition and editing it in the same breath is
 * how a moderation regression gets smuggled in behind a privacy fix.
 */
export const EMAIL_PATTERN = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";

/**
 * The local part of an address, captured, so redaction can keep the domain.
 * `alice@gmail.com` -> `[REDACTED]@gmail.com`. This is the same trade
 * `sendMail.ts` already makes with `email_events.to_domain`: *"a bare domain
 * names a mail provider, not a person"*. Dropping the whole address would
 * throw away the one thing that separates "one address bounced" from "every
 * send to this provider is refused", which is issue #6's entire question.
 */
export const EMAIL_LOCAL_PART_PATTERN = "[A-Za-z0-9._%+-]+(?=@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})";

/** A bare http(s) or `www.` URL. Moderation's; unchanged. */
export const URL_PATTERN = "\\bhttps?:\\/\\/\\S+|\\bwww\\.\\S+";

/**
 * **Moderation's** phone rule: any run of 8+ digits, separators optional.
 * Deliberately greedy — a giver typing `6175550134` into a story is exactly
 * the bypass this is meant to catch, and the cost of a false positive is one
 * listing taking the slow path through review.
 */
export const PHONE_LOOSE_PATTERN = "(?:\\+?\\d[\\s().-]?){7,}\\d";

/**
 * **Redaction's** phone rule, and the reason there are two.
 *
 * `PHONE_LOOSE_PATTERN` cannot be used on a log line. `Date.now()` is a
 * 13-digit run, so the loose rule matches every epoch millisecond this Worker
 * has ever logged — and `email_events.created_at`, `head_sampling_rate`,
 * request durations and row counts would all come out `[REDACTED]`. A
 * redactor that erases every timestamp destroys far more diagnostic value
 * than it protects, and #170 warns about precisely this.
 *
 * So the redaction rule requires evidence the digits were *written as a phone
 * number*: either a `+` country code, or real separators in the 3-3-4 shape.
 * A bare digit run is left alone. That means `6175550134` written with no
 * punctuation survives redaction — an accepted, deliberate miss, because the
 * alternative is redacting every number in every log line. Moderation still
 * catches that form on the way in, which is the layer where it matters.
 *
 * Three alternations: `+` international, `(617) 555-0134`, and `617-555-0134`.
 * The international one counts digits (7 to 15, E.164's own range) rather
 * than matching a character class greedily, so it cannot run away across a
 * whole log line from a single stray `+`.
 */
export const PHONE_REDACTION_PATTERN =
  "\\+\\d(?:[\\s().-]{0,2}\\d){6,14}" +
  "|\\(\\d{3}\\)[\\s.-]?\\d{3}[\\s.-]?\\d{4}\\b" +
  "|\\b\\d{3}[\\s.-]\\d{3}[\\s.-]\\d{4}\\b";

/**
 * URL path segments that are a live credential rather than an identifier.
 *
 * `/recover/<token>` and `/withdraw/<token>` put a single-use secret in a
 * path, where `redactString`'s `?key=` rule — which only ever matched query
 * parameters — could not see it. (#182 is separately moving the recovery
 * token out of the path; this rule is defence in depth and should hold
 * regardless of where that lands.)
 *
 * The length floor matters. `randomTokenRaw()` produces 43 base64url
 * characters, so a real token always clears 12 by a wide margin, while a
 * literal route file in a stack trace — `app/withdraw/[token].tsx` — starts
 * with `[`, which is not in the charset, and is left readable.
 */
export const SECRET_PATH_PREFIXES = ["recover", "withdraw"] as const;

export const SECRET_PATH_SEGMENT_PATTERN = `\\/(${SECRET_PATH_PREFIXES.join("|")})\\/[A-Za-z0-9._~+%-]{12,}`;

/**
 * Non-global instances, safe for `.test()`. Do not add `g` to these: see the
 * `lastIndex` note at the top of the file.
 */
export const EMAIL_RE = new RegExp(EMAIL_PATTERN);
export const URL_RE = new RegExp(URL_PATTERN, "i");
export const PHONE_LOOSE_RE = new RegExp(PHONE_LOOSE_PATTERN);
