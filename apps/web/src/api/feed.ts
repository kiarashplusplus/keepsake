import { feedPageSchema, type FeedPage, type FeedQuery } from "@keepsake/contracts/feed";
import { PublicListing, type PublicListing as PublicListingT } from "@keepsake/contracts/listing";
import { apiFetch } from "@/api/client";
import { fixPhotoUrls } from "@/api/fixPhotoUrls";

const PublicListingFeedPage = feedPageSchema(PublicListing);

export type FeedQueryInput = Partial<Omit<FeedQuery, "limit">> & { limit?: number };

function buildFeedParams(query: FeedQueryInput): URLSearchParams {
  const params = new URLSearchParams();
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  if (query.category !== undefined) params.set("category", query.category);
  if (query.q !== undefined) params.set("q", query.q);
  if (query.country !== undefined) params.set("country", query.country);
  if (query.postal !== undefined) params.set("postal", query.postal);
  if (query.lat !== undefined) params.set("lat", String(query.lat));
  if (query.lng !== undefined) params.set("lng", String(query.lng));
  if (query.radius_mi !== undefined) params.set("radius_mi", String(query.radius_mi));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  return params;
}

/** `GET /api/feed` — keyset pagination, optional category/search/geo mode.
 * Validated against `PublicListing` so a drifted API response fails loudly
 * rather than shipping malformed cards into the masonry grid. */
export async function getFeed(query: FeedQueryInput, signal?: AbortSignal): Promise<FeedPage<PublicListingT>> {
  const params = buildFeedParams(query);
  const qs = params.toString();
  const data = await apiFetch<unknown>(`/api/feed${qs !== "" ? `?${qs}` : ""}`, {
    ...(signal !== undefined ? { signal } : {}),
  });
  return PublicListingFeedPage.parse(fixPhotoUrls(data));
}
