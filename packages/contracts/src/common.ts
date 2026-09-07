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

/** The minimum age Keepsake asks givers and requesters to self-attest to.
 * Higher than COPPA's 13: the product arranges in-person meetings between
 * strangers, a different calculus than an ordinary content site. See
 * docs/legal-considerations.md "Minimum age" and apps/site/public/terms.html. */
export const MINIMUM_AGE = 18;

/**
 * Issue #64: the age gate used to be an "I confirm I'm 18 or older" checkbox
 * — a prompt that states its own passing answer, which is fine as a term of
 * service and weak as evidence. This is the middle path the issue landed
 * on: a neutral "What is your date of birth?" prompt, validated against
 * `MINIMUM_AGE` on both the client (immediate feedback) and the server
 * (this schema, run again in `validateBody` — a client can't just skip the
 * client-side check), but the date of birth itself is **never persisted**.
 * `apps/api/src/routes/listings.ts`/`requests` still write only
 * `age_attested_at` (a timestamp, exactly as before) the moment this schema
 * accepts a value — the DOB in the request body is read once for its
 * pass/fail verdict and then discarded, never reaching a DB column. See
 * `calculateAge` below, which both this schema and
 * `apps/web/src/features/ageGate/AgeGateField.tsx` call, so the client's
 * live validation and the server's authoritative one can never disagree
 * about what "18" means (leap years, exact-birthday edge cases).
 *
 * Deliberately a plain `YYYY-MM-DD` string, not `z.date()`/an ISO
 * timestamp: a date of birth has no time-of-day or timezone component, and
 * accepting one would invite a client to send `new Date().toISOString()`
 * output that silently carries the browser's local offset.
 */
const DOB_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Whole years between `dateOfBirth` (a `YYYY-MM-DD` string already known to
 * match `DOB_PATTERN`) and `now`, accounting for whether this year's
 * birthday has happened yet — a naive `now.year - birth.year` overcounts by
 * one for anyone whose birthday hasn't occurred yet this year. Pure and
 * shared (see `DateOfBirthSchema` above) rather than duplicated between the
 * client's live validation and the server's. */
export function calculateAge(dateOfBirth: string, now: Date = new Date()): number {
  const parts = dateOfBirth.split("-").map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  let age = now.getUTCFullYear() - year;
  const birthdayHasOccurredThisYear =
    now.getUTCMonth() + 1 > month || (now.getUTCMonth() + 1 === month && now.getUTCDate() >= day);
  if (!birthdayHasOccurredThisYear) age -= 1;
  return age;
}

/**
 * `Date.parse`/`new Date(string)` silently rolls an out-of-range day or
 * month over into the next one instead of rejecting it — confirmed
 * directly: `Date.parse("2024-02-30")` parses to March 1st, not `NaN` — so
 * it cannot be trusted alone to catch a fat-fingered "the 30th of February".
 * This reconstructs the date from its own parsed parts and checks they
 * round-trip, which is what actually catches a rollover.
 */
function isRealCalendarDate(dateOfBirth: string): boolean {
  const parts = dateOfBirth.split("-").map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (year === undefined || month === undefined || day === undefined) return false;
  const asDate = new Date(Date.UTC(year, month - 1, day));
  return asDate.getUTCFullYear() === year && asDate.getUTCMonth() === month - 1 && asDate.getUTCDate() === day;
}

/** Implausibly old rather than tied to any real-world record, purely so a
 * fat-fingered year (`1900` meant as `1990`) fails with "enter a real date"
 * instead of silently passing the minimum-age check by a wide margin.
 *
 * Exported since #133 so the web date picker can set the same floor on the
 * control itself (`<input type="date" min=...>`) rather than hardcoding a
 * second, driftable copy of this number. Note what the picker deliberately
 * does NOT constrain: its `max` is today, not `MINIMUM_AGE` years ago. A
 * control that refuses to let you pick an under-18 date is the same thing
 * #64 replaced the "I confirm I'm 18 or older" checkbox to get away from —
 * an input that hands you its own passing answer. The minimum-age check
 * stays a validation result, here and on the server. */
export const MAX_PLAUSIBLE_AGE = 130;

export const DateOfBirthSchema = z
  .string()
  .trim()
  .regex(DOB_PATTERN, "Enter your date of birth as YYYY-MM-DD.")
  .refine(isRealCalendarDate, "That's not a real date.")
  .refine((value) => Date.parse(value) <= Date.now(), "Date of birth can't be in the future.")
  .refine((value) => calculateAge(value) <= MAX_PLAUSIBLE_AGE, "Enter a real date of birth.")
  .refine((value) => calculateAge(value) >= MINIMUM_AGE, `You must be ${MINIMUM_AGE} or older to continue.`);

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
