import { z } from "zod";
import {
  RecoverExchangeInput,
  RecoverInput as RecoverInputSchema,
  RecoverResult,
  type RecoverInput,
  type RecoverResult as RecoverResultT,
} from "@keepsake/contracts/owner";
import { apiFetch } from "@/api/client";

const RecoverSent = z.object({ sent: z.literal(true) });

export type RecoverOptions = {
  turnstileToken: string;
  signal?: AbortSignal;
};

/** `POST /api/recover` — always resolves `{ sent: true }`, whether or not the
 * address is on file, so this can never leak which emails exist. */
export async function recover(input: RecoverInput, options: RecoverOptions): Promise<void> {
  const body = RecoverInputSchema.parse(input);
  const data = await apiFetch<unknown>("/api/recover", {
    method: "POST",
    body,
    turnstileToken: options.turnstileToken,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  RecoverSent.parse(data);
}

/** `POST /api/recover/exchange` — one-time use; rotates the owner's token and
 * returns the new one exactly once. No Turnstile (the token itself, sent
 * only via email, is the proof of possession).
 *
 * Issue #182: the token used to be a path segment (`POST /api/recover/<token>`),
 * where the Worker's `onError` logged it verbatim while it was still live and
 * still worth full takeover of the dashboard. It goes in the body now, the
 * same shape `withdrawWithToken` already used (`src/api/withdraw.ts`). The
 * *link* people click is unchanged — `/recover/<token>` is this app's own
 * route (`app/recover/[token].tsx`), not the API's — so recovery mail sent
 * before this change still works. */
export async function recoverWithToken(token: string, signal?: AbortSignal): Promise<RecoverResultT> {
  const body = RecoverExchangeInput.parse({ token });
  const data = await apiFetch<unknown>("/api/recover/exchange", {
    method: "POST",
    body,
    ...(signal !== undefined ? { signal } : {}),
  });
  return RecoverResult.parse(data);
}
