import { z } from "zod";
import { OwnerMe, type OwnerMe as OwnerMeT } from "@keepsake/contracts/owner";
import { ListingStatusSchema, ModerationReasonSchema, OwnerListing, type OwnerListing as OwnerListingT } from "@keepsake/contracts/listing";
import { apiFetch } from "@/api/client";

/** `GET /api/me/listings/:id` adds a `requests` list (empty until M3 wires
 * up requests) and a `moderation` summary the dashboard detail page reads
 * for the held/rejected copy. Declared here rather than in
 * `@keepsake/contracts` because it's a client-facing composite, not a
 * request/response body shape the API itself validates against a single
 * named schema. */
export const OwnerListingDetail = OwnerListing.extend({
  requests: z.array(z.unknown()),
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

export async function getMyListings(signal?: AbortSignal): Promise<OwnerListingT[]> {
  const data = await apiFetch<unknown>("/api/me/listings", { owner: true, ...(signal !== undefined ? { signal } : {}) });
  return z.array(OwnerListing).parse(data);
}

export async function getMyListing(id: string, signal?: AbortSignal): Promise<OwnerListingDetail> {
  const data = await apiFetch<unknown>(`/api/me/listings/${encodeURIComponent(id)}`, {
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  return OwnerListingDetail.parse(data);
}
