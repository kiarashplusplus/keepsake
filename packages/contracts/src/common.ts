/**
 * Envelope, error codes, and small primitive schemas shared by every other
 * subpath in this package. Every API response is `{ ok:true, data }` or
 * `{ ok:false, error }` — never a bare payload — so the web client can branch
 * on `ok` without guessing.
 */
import { z } from "zod";

export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "gone",
  "rate_limited",
  "turnstile_failed",
  "conflict",
  "payload_too_large",
  "unsupported_media",
  "internal",
  "unavailable",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export type ApiOk<T> = {
  ok: true;
  data: T;
};

export type ApiErr = {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    retryAfter?: number;
    /** Flattened zod issues from `src/middleware/validate.ts`, present only
     * on `bad_request` responses from body/query validation. Additive field:
     * older clients that only read `code`/`message` are unaffected. */
    issues?: Record<string, unknown>;
  };
};

export type ApiResult<T> = ApiOk<T> | ApiErr;

export function apiOk<T>(data: T): ApiOk<T> {
  return { ok: true, data };
}

export function apiErr(
  code: ErrorCode,
  message: string,
  retryAfter?: number,
  issues?: Record<string, unknown>,
): ApiErr {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(retryAfter === undefined ? {} : { retryAfter }),
      ...(issues === undefined ? {} : { issues }),
    },
  };
}

/** Crockford base32 (excludes I, L, O, U), canonical uppercase, 26 chars. */
export const UlidSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "Invalid ULID");

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().email("Invalid email"));

/**
 * Domains reserved by standard (RFC 2606 / RFC 6761) precisely so they can
 * never resolve. Mail to any of them is guaranteed to bounce — shared here
 * so both the web form that first sees the address and the API's send-time
 * guard (`apps/api/src/email/sendMail.ts`) refuse it for the same reason
 * instead of keeping two lists that can drift.
 */
export const RESERVED_EMAIL_DOMAINS = new Set(["example.com", "example.net", "example.org", "example.edu"]);
export const RESERVED_EMAIL_DOMAIN_SUFFIXES = [".test", ".invalid", ".localhost", ".local", ".example"];

/** Reserved-by-standard domains that can never accept mail. */
export function isReservedEmailDomain(address: string): boolean {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  const domain = at === -1 ? "" : trimmed.slice(at + 1);
  if (domain.length === 0) return true;
  if (RESERVED_EMAIL_DOMAINS.has(domain)) return true;
  return RESERVED_EMAIL_DOMAIN_SUFFIXES.some((suffix) => domain === suffix.slice(1) || domain.endsWith(suffix));
}

export const RESERVED_EMAIL_DOMAIN_MESSAGE = "That address can't receive mail — try another.";

/**
 * `EmailSchema` plus the reserved-domain check, for the fields that name a
 * real person we intend to mail (a signup address, a request contact, a
 * recovery address) rather than a value that merely needs to look like an
 * email. `EmailSchema` itself stays permissive — `@example.com` fixtures
 * elsewhere in the schema surface (e.g. `OwnerMe.email`, `OwnerViewRequest.email`)
 * describe addresses the API is echoing back, not ones this layer is about
 * to send to, and loosening those wasn't asked for.
 */
export const MailableEmailSchema = EmailSchema.refine((email) => !isReservedEmailDomain(email), {
  message: RESERVED_EMAIL_DOMAIN_MESSAGE,
});

/** Unix epoch milliseconds. */
export const TimestampMs = z.number().int().nonnegative();

/** Opaque keyset-pagination cursor — never parsed by the client, just echoed. */
export const CursorSchema = z.string().min(1).max(500);

export const DEFAULT_PAGE_LIMIT = 24;
export const MAX_PAGE_LIMIT = 48;

export const PaginationLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_LIMIT)
  .default(DEFAULT_PAGE_LIMIT);
