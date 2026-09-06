/**
 * Ported from finderly-monorepo `packages/observability/src/initSentry.ts`,
 * whose `SENSITIVE_KEY_RE` / `redactString` / `redactDeep` this file keeps
 * byte-for-byte where it can. Extended with owner-token and Turnstile keys,
 * which are Keepsake-specific.
 *
 * No lookbehind and no named groups anywhere in this file: it must run on
 * React Native Hermes later, which supports neither.
 *
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

export function redactString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(new RegExp(`([?&](?:${KEY_VALUE_NAMES})=)[^&\\s]+`, "gi"), "$1[REDACTED]")
    .replace(JSON_STRING_SECRET_RE, '$1"[REDACTED]"')
    .replace(JSON_NONSTRING_SECRET_RE, "$1[REDACTED]")
    .replace(new RegExp(`((?:${KEY_VALUE_NAMES})\\s*[:=]\\s*)[^\\s,;&]+`, "gi"), "$1[REDACTED]");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * `ancestors` tracks only the objects on the CURRENT path (entered on the way
 * down, removed on the way back up), not a running set of everything ever
 * visited — see the Finderly source comment this was ported from. A shared
 * reference used twice (e.g. the same tags object nested in two places) is
 * not a cycle and must not come back as `[Circular]`.
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
      output[key] = SENSITIVE_KEY_RE.test(key)
        ? "[REDACTED]"
        : redactDeep(childValue, depth + 1, ancestors);
    }

    return output;
  } finally {
    ancestors.delete(value);
  }
}

/** Usable directly as a Sentry `beforeSend`. */
export function redactEvent(event: unknown): unknown {
  return redactDeep(event);
}

/** Usable directly as a Sentry `beforeBreadcrumb`. */
export function redactBreadcrumb(breadcrumb: unknown): unknown {
  if (!isPlainObject(breadcrumb)) return breadcrumb;

  return {
    ...breadcrumb,
    message:
      typeof breadcrumb.message === "string" ? redactString(breadcrumb.message) : breadcrumb.message,
    data: isPlainObject(breadcrumb.data) ? redactDeep(breadcrumb.data) : breadcrumb.data,
  };
}
