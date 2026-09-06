import { z } from "zod";
import { CreateRequestInput as CreateRequestInputSchema, type CreateRequestInput } from "@keepsake/contracts/request";
import { TimestampMs, UlidSchema } from "@keepsake/contracts/common";
import { apiFetch } from "@/api/client";

const CreateRequestResult = z.object({ id: UlidSchema, created_at: TimestampMs });
export type CreateRequestResult = z.infer<typeof CreateRequestResult>;

export type CreateRequestOptions = {
  turnstileToken: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

/** `POST /api/listings/:id/requests` — anonymous (no owner token), Turnstile-
 * gated. The API 409s (`conflict`) when the same email already asked on this
 * listing; that's surfaced as an `ApiError` for `RequestSheet` to turn into
 * inline copy rather than a generic error toast. */
export async function createRequest(
  listingId: string,
  input: CreateRequestInput,
  options: CreateRequestOptions,
): Promise<CreateRequestResult> {
  const body = CreateRequestInputSchema.parse(input);
  const data = await apiFetch<unknown>(`/api/listings/${encodeURIComponent(listingId)}/requests`, {
    method: "POST",
    body,
    turnstileToken: options.turnstileToken,
    ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  return CreateRequestResult.parse(data);
}
