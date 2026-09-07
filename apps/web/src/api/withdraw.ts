import {
  RequestWithdrawInput as RequestWithdrawInputSchema,
  RequestWithdrawResult,
  type RequestWithdrawResult as RequestWithdrawResultT,
} from "@keepsake/contracts/request";
import { apiFetch } from "@/api/client";

/** `POST /api/requests/withdraw` — one-time use; erases the requester's own
 * note, email, and phone from `requests` and flips its status to
 * `withdrawn`. No Turnstile (the token itself, sent only via the
 * `requestReceived` email, is the proof of possession) — same shape as
 * `POST /api/recover/:token` (`src/api/recover.ts`). Unknown, already-used,
 * and expired tokens all fail identically (`ApiError` with code
 * `unauthorized`) so a caller can't learn anything by probing. */
export async function withdrawWithToken(
  token: string,
  signal?: AbortSignal,
): Promise<RequestWithdrawResultT> {
  const body = RequestWithdrawInputSchema.parse({ token });
  const data = await apiFetch<unknown>("/api/requests/withdraw", {
    method: "POST",
    body,
    ...(signal !== undefined ? { signal } : {}),
  });
  return RequestWithdrawResult.parse(data);
}
