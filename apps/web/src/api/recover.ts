import { z } from "zod";
import { RecoverInput as RecoverInputSchema, RecoverResult, type RecoverInput, type RecoverResult as RecoverResultT } from "@keepsake/contracts/owner";
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

/** `POST /api/recover/:token` — one-time use; rotates the owner's token and
 * returns the new one exactly once. No Turnstile (the token itself, sent
 * only via email, is the proof of possession). */
export async function recoverWithToken(token: string, signal?: AbortSignal): Promise<RecoverResultT> {
  const data = await apiFetch<unknown>(`/api/recover/${encodeURIComponent(token)}`, {
    method: "POST",
    ...(signal !== undefined ? { signal } : {}),
  });
  return RecoverResult.parse(data);
}
