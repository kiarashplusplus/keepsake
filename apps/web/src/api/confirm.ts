import {
  RequestConfirmInput as RequestConfirmInputSchema,
  RequestConfirmResult,
  type RequestConfirmResult as RequestConfirmResultT,
} from "@keepsake/contracts/request";
import { apiFetch } from "@/api/client";

/** `POST /api/requests/confirm` — issue #188. Redeems the one-time token from
 * the "did you ask for this?" email, which is what actually sends the request
 * to the giver: until this call succeeds the ask exists only as a held row
 * that nobody has been shown and that expires on its own.
 *
 * No Turnstile: the token, mailed only to the address that was submitted, is
 * itself the proof of possession — the same shape as `withdrawWithToken` and
 * `POST /api/recover/:token`.
 *
 * Two failures are distinguishable here, unlike the withdraw route's single
 * answer, because both can only be reached by someone holding the emailed
 * link: `gone` for a link that lapsed (ask again), `unauthorized` for
 * anything else. */
export async function confirmRequestWithToken(
  token: string,
  signal?: AbortSignal,
): Promise<RequestConfirmResultT> {
  const body = RequestConfirmInputSchema.parse({ token });
  const data = await apiFetch<unknown>("/api/requests/confirm", {
    method: "POST",
    body,
    ...(signal !== undefined ? { signal } : {}),
  });
  return RequestConfirmResult.parse(data);
}
