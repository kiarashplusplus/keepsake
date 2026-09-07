import { z } from "zod";
import { PublicListing } from "./listing";

/**
 * `GET /api/feed/shelves` — issue #39. A shelf groups a handful of the
 * *current* default feed's listings under one aspect `name`/`value` pair
 * that's common enough to clear the server-configured floor
 * (`SHELF_MIN_ITEMS`, see `apps/api/src/routes/feed.ts`). `items` is a
 * preview slice (not the full matching set — there is no pagination here),
 * ordered the same way the default feed is (newest first).
 *
 * Deliberately its own endpoint rather than a field on `GET /api/feed`:
 * shelves are additive navigation over the same approved-listings universe,
 * never a filter on it (issue #40) — keeping them a separate response makes
 * that a structural fact instead of a convention a future change could
 * quietly break by threading a filter through the default feed query.
 */
export const AspectShelf = z.object({
  name: z.string(),
  value: z.string(),
  /** Total approved listings carrying this aspect value — may be larger
   * than `items.length`, which is capped for display. */
  count: z.number().int().nonnegative(),
  items: z.array(PublicListing),
});
export type AspectShelf = z.infer<typeof AspectShelf>;

export const ShelvesResponse = z.object({
  shelves: z.array(AspectShelf),
  /** The floor that decided which aspect values made the cut, echoed back
   * so a client can log/debug without hardcoding the server's config. */
  min_items: z.number().int().nonnegative(),
});
export type ShelvesResponse = z.infer<typeof ShelvesResponse>;
