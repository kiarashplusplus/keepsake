import {
  CreateListingInput as CreateListingInputSchema,
  type CreateListingInput,
  OwnerListing,
  type OwnerListing as OwnerListingT,
  UpdateListingInput as UpdateListingInputSchema,
  type UpdateListingInput,
} from "@keepsake/contracts/listing";
import { apiFetch } from "@/api/client";

export type CreateListingOptions = {
  turnstileToken: string;
  idempotencyKey: string;
  signal?: AbortSignal;
};

/** `POST /api/listings` — starts a listing at `pending`. Validates the input
 * client-side with the same zod schema the API uses, so a give-flow bug
 * surfaces as a local error instead of a round trip. */
export async function createListing(input: CreateListingInput, options: CreateListingOptions): Promise<OwnerListingT> {
  const body = CreateListingInputSchema.parse(input);
  const data = await apiFetch<unknown>("/api/listings", {
    method: "POST",
    body,
    owner: true,
    turnstileToken: options.turnstileToken,
    idempotencyKey: options.idempotencyKey,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  return OwnerListing.parse(data);
}

export async function updateListing(id: string, input: UpdateListingInput, signal?: AbortSignal): Promise<OwnerListingT> {
  const body = UpdateListingInputSchema.parse(input);
  const data = await apiFetch<unknown>(`/api/listings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  return OwnerListing.parse(data);
}

export async function deleteListing(id: string, signal?: AbortSignal): Promise<void> {
  await apiFetch<unknown>(`/api/listings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
}

async function postAction(id: string, action: "given" | "withdraw" | "relist", signal?: AbortSignal): Promise<OwnerListingT> {
  const data = await apiFetch<unknown>(`/api/listings/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  return OwnerListing.parse(data);
}

export const markGiven = (id: string, signal?: AbortSignal): Promise<OwnerListingT> => postAction(id, "given", signal);
export const withdrawListing = (id: string, signal?: AbortSignal): Promise<OwnerListingT> => postAction(id, "withdraw", signal);
export const relistListing = (id: string, signal?: AbortSignal): Promise<OwnerListingT> => postAction(id, "relist", signal);
