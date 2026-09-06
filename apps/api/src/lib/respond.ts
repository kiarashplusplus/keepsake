/**
 * Every route returns through one of these two helpers so the envelope shape
 * — `{ ok:true, data }` / `{ ok:false, error }` — matches
 * `@keepsake/contracts/common`'s `ApiOk`/`ApiErr` exactly, in one place
 * rather than re-typed at every call site.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { apiErr, apiOk, type ErrorCode } from "@keepsake/contracts/common";

export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200): Response {
  return c.json(apiOk(data), status);
}

export interface FailExtra {
  retryAfter?: number;
  issues?: Record<string, unknown>;
}

export function fail(
  c: Context,
  code: ErrorCode,
  message: string,
  status: ContentfulStatusCode,
  extra?: FailExtra,
): Response {
  if (extra?.retryAfter !== undefined) {
    c.header("Retry-After", String(extra.retryAfter));
  }
  return c.json(apiErr(code, message, extra?.retryAfter, extra?.issues), status);
}
