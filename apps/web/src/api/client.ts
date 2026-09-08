/**
 * Thin fetch wrapper around the API envelope (`@keepsake/contracts/common`):
 * every response is `{ ok:true, data }` or `{ ok:false, error }` — this is
 * the one place that branches on `ok` and throws `ApiError` for the `false`
 * case, so every call site downstream just gets a typed value or a catch.
 *
 * Per-domain modules (`src/api/{photos,listings,me,geo}.ts`) wrap this with
 * the contracts' zod schemas so a drifted API response fails loudly (a
 * parse error) instead of silently shipping malformed data into the UI.
 */
import type { ErrorCode } from "@keepsake/contracts/common";
import { config } from "@/lib/config";
import { getOrCreateOwnerToken } from "@/lib/ownerToken";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfter: number | undefined;

  constructor(code: ErrorCode, message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ApiFetchOptions = {
  method?: ApiMethod;
  /** A plain JSON-serializable body, or a `FormData` instance for uploads
   * (passed through untouched — any `Content-Type` is *removed* so the
   * browser can add its own multipart boundary). */
  body?: unknown;
  /** Attaches `Authorization: Bearer <ownerToken>`, minting one lazily if
   * none exists yet. Omit (or `false`) for anonymous routes. */
  owner?: boolean;
  /** Attaches `Authorization: Bearer <adminToken>` verbatim — unlike `owner`,
   * this never mints anything; the caller (`src/api/admin.ts`) already read
   * it out of `src/lib/adminToken.ts`'s sessionStorage-backed store. Mutually
   * exclusive with `owner` in practice (no route needs both), but nothing
   * here enforces that since no route ever will. */
  adminToken?: string;
  /** Sent as `cf-turnstile-response` on Turnstile-protected routes. */
  turnstileToken?: string;
  /** Sent as `X-Idempotency-Key`. */
  idempotencyKey?: string;
  /**
   * Extra request headers, merged in before `Authorization`/`Content-Type`
   * are set — so those two still win if a caller collides with them, and a
   * caller can't be surprised into overriding auth by accident. On a
   * `FormData` body a colliding `Content-Type` is dropped rather than
   * overwritten, because there the correct value is the one only `fetch`
   * can write (it carries the multipart boundary). Added for a bulk-write
   * header that has since been removed with the admission code, and kept
   * because the alternative for the next caller that needs one — a bespoke
   * fetch wrapper duplicating this file's envelope handling — is the exact
   * drift this module exists to prevent.
   */
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string; retryAfter?: number } };

/**
 * Not just "has an `ok` key" (issue #297): that let a malformed
 * `{ ok: true }` with no `data` — a proxy error page, a partially-written
 * response, anything that happens to carry the one field this checked —
 * through as a *successful* response whose payload is `undefined`. The two
 * callers with no zod parse downstream (`getAdminStats`/`getAdminHealth` in
 * `src/api/admin.ts`) had nothing left to catch that; every other caller
 * only caught it by accident, one `.parse()` call away. Requiring `ok` to
 * actually be a boolean, `data` to be present when it's `true`, and a
 * well-formed `{ code, message }` when it's `false` makes a malformed
 * envelope fail as the `internal` `ApiError` below throws for, instead of
 * silently shipping `undefined` as if it were real data.
 */
function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  const ok = (value as { ok: unknown }).ok;
  if (typeof ok !== "boolean") return false;
  if (ok) return "data" in value;
  if (!("error" in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { method = "GET", body, owner = false, adminToken, turnstileToken, idempotencyKey, headers: extraHeaders, signal } = options;

  const url = `${config.siteUrl}${path}`;
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  let requestBody: BodyInit | null = null;

  if (body !== undefined) {
    if (isFormData(body)) {
      // Strip any caller-supplied Content-Type rather than merely declining
      // to set one. `fetch` only generates the `multipart/form-data;
      // boundary=...` value when the header is absent, so a caller who
      // passed one through `headers` — even the correct-looking
      // `multipart/form-data` — would send a body the server cannot split
      // into parts. Header names are case-insensitive on the wire but this
      // is a plain object, so match that way too.
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === "content-type") delete headers[name];
      }
      requestBody = body;
    } else {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }
  }

  if (owner) {
    headers.Authorization = `Bearer ${getOrCreateOwnerToken()}`;
  }
  if (adminToken !== undefined) {
    headers.Authorization = `Bearer ${adminToken}`;
  }
  if (turnstileToken !== undefined) {
    headers["cf-turnstile-response"] = turnstileToken;
  }
  if (idempotencyKey !== undefined) {
    headers["X-Idempotency-Key"] = idempotencyKey;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: requestBody,
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch {
    throw new ApiError("unavailable", "Couldn't reach Keepsake. Check your connection and try again.", 0);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiError("internal", "The server sent back something unexpected.", response.status);
  }

  if (!isEnvelope(parsed)) {
    throw new ApiError("internal", "The server sent back something unexpected.", response.status);
  }

  if (!parsed.ok) {
    throw new ApiError(parsed.error.code, parsed.error.message, response.status, parsed.error.retryAfter);
  }

  return parsed.data as T;
}
