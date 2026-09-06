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
