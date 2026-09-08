/**
 * The listing the Worker put in the page, if it is the one being rendered.
 *
 * `GET /item/:id` (apps/api/src/routes/item.ts) already reads the row and its
 * photos to build the share card's OG tags, so it also writes the exact
 * `PublicListing` JSON that `GET /api/listings/:id` would return into a
 * `<script type="application/json" id="ks-listing">`. Reading it here takes a
 * whole round trip — browser to Worker to D1 and back — off the path between
 * the HTML arriving and the keepsake being on screen.
 *
 * Three things this is careful about:
 *
 * 1. **It is parsed by the same schema as the fetch.** `fixPhotoUrls` then
 *    `PublicListing.parse`, exactly as `api/listings.ts` does — a payload
 *    that has drifted from the contract fails here the same way a drifted
 *    API response would, rather than rendering something half-shaped.
 * 2. **It belongs to one id.** After a client-side navigation to another
 *    keepsake the tag is still in the document and describes the wrong one,
 *    so the `data-id` must match the route param.
 * 3. **It is consumed once.** The element is removed on the first read.
 *    Coming back to this listing later in the same session should ask the
 *    server again — the page it came with was served `no-store` precisely
 *    because a listing can be given away or hidden between visits, and a
 *    payload that stayed in the DOM would be the one stale copy nothing
 *    invalidates.
 *
 * Returns `null` for every failure — no tag, wrong id, malformed JSON — and
 * the caller falls back to the fetch it has always made.
 */
import { PublicListing, type PublicListing as PublicListingT } from "@keepsake/contracts/listing";
import { fixPhotoUrls } from "@/api/fixPhotoUrls";

const ELEMENT_ID = "ks-listing";

export function readInlineListing(id: string): PublicListingT | null {
  if (typeof document === "undefined") return null;
  const element = document.getElementById(ELEMENT_ID);
  if (element === null) return null;
  if (element.getAttribute("data-id") !== id) return null;

  element.remove();
  try {
    return PublicListing.parse(fixPhotoUrls(JSON.parse(element.textContent ?? "")));
  } catch {
    return null;
  }
}
