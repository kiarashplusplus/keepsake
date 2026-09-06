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
   * (passed through untouched — no `Content-Type` is set so the browser can
   * add its own multipart boundary). */
  body?: unknown;
  /** Attaches `Authorization: Bearer <ownerToken>`, minting one lazily if
   * none exists yet. Omit (or `false`) for anonymous routes. */
  owner?: boolean;
  /** Sent as `cf-turnstile-response` on Turnstile-protected routes. */
  turnstileToken?: string;
  /** Sent as `X-Idempotency-Key`. */
  idempotencyKey?: string;
  signal?: AbortSignal;
};

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string; retryAfter?: number } };

function isEnvelope(value: unknown): value is Envelope<unknown> {
  return typeof value === "object" && value !== null && "ok" in value;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { method = "GET", body, owner = false, turnstileToken, idempotencyKey, signal } = options;

  const url = `${config.siteUrl}${path}`;
  const headers: Record<string, string> = {};
  let requestBody: BodyInit | null = null;

  if (body !== undefined) {
    if (isFormData(body)) {
      requestBody = body;
    } else {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }
  }

  if (owner) {
    headers.Authorization = `Bearer ${getOrCreateOwnerToken()}`;
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
