/** `GET /api/feed/shelves` — issue #39's browse-page shelves. Validated
 * against `ShelvesResponse` for the same reason `getFeed` validates
 * `PublicListing`: a drifted API response should fail loudly, not ship a
 * malformed shelf into the UI. */
import { ShelvesResponse } from "@keepsake/contracts/shelves";
import { apiFetch } from "@/api/client";
import { fixPhotoUrls } from "@/api/fixPhotoUrls";

export async function getShelves(signal?: AbortSignal): Promise<ShelvesResponse> {
  const data = await apiFetch<unknown>("/api/feed/shelves", {
    ...(signal !== undefined ? { signal } : {}),
  });
  return ShelvesResponse.parse(fixPhotoUrls(data));
}
