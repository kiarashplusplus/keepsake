/**
 * Ported from finderly-monorepo `packages/observability/src/initSentry.ts`,
 * whose `SENSITIVE_KEY_RE` / `redactString` / `redactDeep` this file keeps
 * byte-for-byte where it can. Extended with owner-token and Turnstile keys,
 * which are Keepsake-specific.
 *
 * `redactString`/`redactDeep` are consumed directly by `./capture.ts`
 * (Workers Logs, since #14 replaced `@sentry/cloudflare`) — the two
 * Sentry-shaped wrappers this file used to export (`redactEvent`,
 * `redactBreadcrumb`, usable directly as Sentry's `beforeSend`/
 * `beforeBreadcrumb`) were removed with the SDK itself. This redaction
 * logic is the part of the Sentry work worth keeping and outlived it.
 *
 * No lookbehind and no named groups anywhere in this file: it must run on
 * React Native Hermes later, which supports neither.
 *
 * The credential rules below are this file's own. The PII rules — email,
 * phone, and secrets carried in a URL *path* — are built from `./patterns`,
 * which `apps/api/src/moderation/contactInfo.ts` also reads, so the answer to
 * "what does an address look like" is written down once (#170).
 */
import {
  EMAIL_LOCAL_PART_PATTERN,
  PHONE_REDACTION_PATTERN,
  SECRET_PATH_SEGMENT_PATTERN,
} from "./patterns";

/**
 * Kept as a bare, flagless non-capturing group (no `g`/`i` baked in, no outer
 * capturing parens) because its `.source` is composed directly into the JSON
 * regexes below.
 */
const SENSITIVE_KEY_RE =
  /(?:password|passwd|pwd|secret|token|api[-_]?key|authorization|cookie|set-cookie|session|csrf|xsrf|jwt|private[-_]?key|client[-_]?secret|refresh[-_]?token|access[-_]?token|id[-_]?token|owner[-_]?token|cf-turnstile-response|turnstile|idempotency[-_]?key)/i;

export { SENSITIVE_KEY_RE };

// Matches JSON-serialised `"password":"value"` credentials that the loose
// `[:=]` pattern in redactString cannot see: the closing quote between the
// key and the colon defeats `\s*[:=]`. The quoted-key form matches the exact
// key only (e.g. "password"), not a key that merely contains it.
const JSON_STRING_SECRET_RE = new RegExp(
  `("${SENSITIVE_KEY_RE.source}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`,
  "gi",
);
const JSON_NONSTRING_SECRET_RE = new RegExp(
  `("${SENSITIVE_KEY_RE.source}"\\s*:\\s*)(?!")[^,}\\]\\s]+`,
  "gi",
);

const KEY_VALUE_NAMES =
  "access_token|refresh_token|id_token|token|api_key|key|secret|password|owner_token";

/**
 * The three PII/secret rules added by #170, built from the shared sources in
 * `./patterns` so there is exactly one definition of "what an address looks
 * like" in the repo — the moderation check in
 * `apps/api/src/moderation/contactInfo.ts` reads the same constants.
 *
 * Built once at module load rather than per call, and never used with
 * `.test()` or `.exec()`: a `g` regex carries `lastIndex` between calls, but
 * `String.prototype.replace` resets it, so reusing these instances is safe
 * where reusing them for `.test()` would not be.
 */
const SECRET_PATH_SEGMENT_RE = new RegExp(SECRET_PATH_SEGMENT_PATTERN, "gi");
const EMAIL_LOCAL_PART_RE = new RegExp(EMAIL_LOCAL_PART_PATTERN, "g");
const PHONE_RE = new RegExp(PHONE_REDACTION_PATTERN, "g");

/**
 * Order matters in two places:
 *
 *  - the secret-path rule runs before the phone rule, so a token that happens
 *    to contain a phone-shaped digit run is already `[REDACTED]` by the time
 *    the phone rule looks;
 *  - the email rule runs after the credential rules, so `?token=a@b.com`
 *    still comes out as a redacted *token* rather than a redacted address.
 */
export function redactString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(new RegExp(`([?&](?:${KEY_VALUE_NAMES})=)[^&\\s]+`, "gi"), "$1[REDACTED]")
    .replace(JSON_STRING_SECRET_RE, '$1"[REDACTED]"')
    .replace(JSON_NONSTRING_SECRET_RE, "$1[REDACTED]")
    .replace(new RegExp(`((?:${KEY_VALUE_NAMES})\\s*[:=]\\s*)[^\\s,;&]+`, "gi"), "$1[REDACTED]")
    .replace(SECRET_PATH_SEGMENT_RE, "/$1/[REDACTED]")
    // Only the local part: the domain is not personal data and is the whole
    // difference between "one address bounced" and "this provider refuses
    // everything" — the same trade `email_events.to_domain` already makes.
    .replace(EMAIL_LOCAL_PART_RE, "[REDACTED]")
    .replace(PHONE_RE, "[REDACTED]");
}

/**
 * `ancestors` tracks only the objects on the CURRENT path (entered on the way
 * down, removed on the way back up), not a running set of everything ever
 * visited — see the Finderly source comment this was ported from. A shared
 * reference used twice (e.g. the same tags object nested in two places) is
 * not a cycle and must not come back as `[Circular]`.
 *
 * Two kinds of redaction meet here, and #170 was filed because only the first
 * existed:
 *
 *  - **by key name** — `SENSITIVE_KEY_RE.test(key)` blanks credentials
 *    whatever they look like, because a token is just an opaque string;
 *  - **by value shape** — every string leaf goes through `redactString`, so
 *    `{ to: "alice@gmail.com" }` is caught on the strength of the value
 *    alone. There is deliberately no second address pattern here: adding one
 *    would recreate the two-definitions problem #170 is about.
 *
 * Object *keys* run through `redactString` too, for the map-keyed-by-address
 * case (`{ "alice@gmail.com": 3 }`), where the PII is the key and there is no
 * value to blank.
 */
export function redactDeep(
  value: unknown,
  depth = 0,
  ancestors: Set<object> = new Set(),
): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);

  if (ancestors.has(value)) return "[Circular]";
  if (depth >= 8) return "[Truncated]";

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, 100).map((item) => redactDeep(item, depth + 1, ancestors));
    }

    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 500);

    for (const [key, childValue] of entries) {
      output[redactString(key)] = SENSITIVE_KEY_RE.test(key)
        ? "[REDACTED]"
        : redactDeep(childValue, depth + 1, ancestors);
    }

    return output;
  } finally {
    ancestors.delete(value);
  }
}
