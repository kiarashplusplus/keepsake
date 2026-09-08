import { z } from "zod";
import { OwnerMe, SetEmailInput as SetEmailInputSchema, type OwnerMe as OwnerMeT, type SetEmailInput } from "@keepsake/contracts/owner";
import {
  ListingStatusSchema,
  ModerationReasonSchema,
  OwnerDashboardListing,
  type OwnerDashboardListing as OwnerDashboardListingT,
} from "@keepsake/contracts/listing";
import { ChooseRequestInput as ChooseRequestInputSchema, OwnerViewRequest, type ChooseRequestInput, type OwnerViewRequest as OwnerViewRequestT } from "@keepsake/contracts/request";
import { apiFetch } from "@/api/client";
import { fixPhotoUrls } from "@/api/fixPhotoUrls";

/** `GET /api/me/listings/:id` adds a `requests` list and a `moderation`
 * summary the dashboard detail page reads for the held/rejected copy. Its
 * base is `OwnerDashboardListing` — `OwnerListing` plus the required
 * `staleness` block — so a route that stopped computing staleness fails this
 * parse rather than quietly rendering a dashboard with nothing flagged.
 * Declared here rather than in `@keepsake/contracts` because it's a
 * client-facing composite, not a request/response body shape the API itself
 * validates against a single named schema. */
export const OwnerListingDetail = OwnerDashboardListing.extend({
  requests: z.array(OwnerViewRequest),
  moderation: z.object({
    status: ListingStatusSchema,
    reason: ModerationReasonSchema.nullable().optional(),
    held: z.boolean(),
  }),
});
export type OwnerListingDetail = z.infer<typeof OwnerListingDetail>;

export async function getMe(signal?: AbortSignal): Promise<OwnerMeT> {
  const data = await apiFetch<unknown>("/api/me", { owner: true, ...(signal !== undefined ? { signal } : {}) });
  return OwnerMe.parse(data);
}

export async function getMyListings(signal?: AbortSignal): Promise<OwnerDashboardListingT[]> {
  const data = await apiFetch<unknown>("/api/me/listings", { owner: true, ...(signal !== undefined ? { signal } : {}) });
  return z.array(OwnerDashboardListing).parse(fixPhotoUrls(data));
}

export async function getMyListing(id: string, signal?: AbortSignal): Promise<OwnerListingDetail> {
  const data = await apiFetch<unknown>(`/api/me/listings/${encodeURIComponent(id)}`, {
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  return OwnerListingDetail.parse(fixPhotoUrls(data));
}

export type SetEmailOptions = {
  turnstileToken: string;
  signal?: AbortSignal;
};

/** `POST /api/me/email` — stores an unverified address and sends a
 * verification link that redirects to `/mine?verified=1|0&reason=`. */
export async function setEmail(input: SetEmailInput, options: SetEmailOptions): Promise<OwnerMeT> {
  const body = SetEmailInputSchema.parse(input);
  const data = await apiFetch<unknown>("/api/me/email", {
    method: "POST",
    body,
    owner: true,
    turnstileToken: options.turnstileToken,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  return OwnerMe.parse(data);
}

export async function deleteEmail(signal?: AbortSignal): Promise<OwnerMeT> {
  const data = await apiFetch<unknown>("/api/me/email", {
    method: "DELETE",
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  return OwnerMe.parse(data);
}

/** `POST /api/me/listings/:id/choose` — marks one request `chosen` (the
 * rest `not_chosen`) and reveals its full contact in the response. */
export async function chooseRequest(listingId: string, input: ChooseRequestInput, signal?: AbortSignal): Promise<OwnerViewRequestT> {
  const body = ChooseRequestInputSchema.parse(input);
  const data = await apiFetch<unknown>(`/api/me/listings/${encodeURIComponent(listingId)}/choose`, {
    method: "POST",
    body,
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  return OwnerViewRequest.parse(data);
}
