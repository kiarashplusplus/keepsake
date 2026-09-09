import { UnsubscribeStatusResult, type UnsubscribeStatusResult as UnsubscribeStatusResultT } from "@keepsake/contracts/email";
import { apiFetch } from "@/api/client";

/** `GET /api/unsubscribe/:token` — read-only, never mutates. Called on
 * mount by `/unsubscribe/[token]` to decide what to show *before* the
 * person can click anything: the consequence has to be stated ahead of the
 * confirm step, not discovered after it. */
export async function unsubscribeStatus(token: string, signal?: AbortSignal): Promise<UnsubscribeStatusResultT> {
  const data = await apiFetch<unknown>(`/api/unsubscribe/${encodeURIComponent(token)}`, {
    ...(signal !== undefined ? { signal } : {}),
  });
  return UnsubscribeStatusResult.parse(data);
}

/** `POST /api/unsubscribe/:token` — the explicit, user-clicked confirmation.
 * The same URL is also RFC 8058's one-click target for a compliant mail
 * client, which POSTs here directly without ever loading this page — this
 * call is what the page's own button does after showing the consequence. */
export async function confirmUnsubscribe(token: string, signal?: AbortSignal): Promise<UnsubscribeStatusResultT> {
  const data = await apiFetch<unknown>(`/api/unsubscribe/${encodeURIComponent(token)}`, {
    method: "POST",
    ...(signal !== undefined ? { signal } : {}),
  });
  return UnsubscribeStatusResult.parse(data);
}

/** `POST /api/resubscribe/:token` — the way back, for someone who
 * unsubscribed and then wondered why they never heard about their
 * keepsake. */
export async function confirmResubscribe(token: string, signal?: AbortSignal): Promise<UnsubscribeStatusResultT> {
  const data = await apiFetch<unknown>(`/api/resubscribe/${encodeURIComponent(token)}`, {
    method: "POST",
    ...(signal !== undefined ? { signal } : {}),
  });
  return UnsubscribeStatusResult.parse(data);
}
