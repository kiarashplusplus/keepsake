import {
  CreateListingInput as CreateListingInputSchema,
  type CreateListingInput,
  OwnerListing,
  type OwnerListing as OwnerListingT,
  PublicListing,
  type PublicListing as PublicListingT,
  SetListingCategoryInput,
  type Category,
  UpdateListingInput as UpdateListingInputSchema,
  type UpdateListingInput,
} from "@keepsake/contracts/listing";
import { apiFetch } from "@/api/client";
import { fixPhotoUrls } from "@/api/fixPhotoUrls";

/** `GET /api/listings/:id` — approved/given only; 404 otherwise (surfaced as
 * an `ApiError` with `code: "not_found"`, left for the caller to catch since
 * the item page's 404 state needs to distinguish it from other failures). */
export async function getListing(id: string, signal?: AbortSignal): Promise<PublicListingT> {
  const data = await apiFetch<unknown>(`/api/listings/${encodeURIComponent(id)}`, {
    ...(signal !== undefined ? { signal } : {}),
  });
  return PublicListing.parse(fixPhotoUrls(data));
}

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
  return OwnerListing.parse(fixPhotoUrls(data));
}

export async function updateListing(id: string, input: UpdateListingInput, signal?: AbortSignal): Promise<OwnerListingT> {
  const body = UpdateListingInputSchema.parse(input);
  const data = await apiFetch<unknown>(`/api/listings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  return OwnerListing.parse(fixPhotoUrls(data));
}

/**
 * Issue #155 — the giver's own correction of the category the model chose.
 *
 * Its own endpoint rather than `updateListing({ category })`: a PATCH bumps
 * the listing's version and sends it back through moderation, so correcting
 * one word would take a live listing out of the feed for a cycle. See the
 * route's comment in `apps/api/src/routes/listings.ts`.
 */
export async function setListingCategory(id: string, category: Category, signal?: AbortSignal): Promise<OwnerListingT> {
  const body = SetListingCategoryInput.parse({ category });
  const data = await apiFetch<unknown>(`/api/listings/${encodeURIComponent(id)}/category`, {
    method: "PUT",
    body,
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  return OwnerListing.parse(fixPhotoUrls(data));
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
  return OwnerListing.parse(fixPhotoUrls(data));
}

export const markGiven = (id: string, signal?: AbortSignal): Promise<OwnerListingT> => postAction(id, "given", signal);
export const withdrawListing = (id: string, signal?: AbortSignal): Promise<OwnerListingT> => postAction(id, "withdraw", signal);
export const relistListing = (id: string, signal?: AbortSignal): Promise<OwnerListingT> => postAction(id, "relist", signal);
