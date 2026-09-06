import { Hono } from "hono";
import type { OwnerMe } from "@keepsake/contracts/owner";
import type { ModerationReasonCode } from "@keepsake/contracts/listing";
import type { Env } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { ownerAuth, type OwnerRow } from "../middleware/ownerAuth.js";
import { serializeOwnerListing } from "../lib/serialize.js";
import { fetchListingRow, fetchPhotoRows } from "../lib/listingsDb.js";
import type { ListingRow } from "../lib/serialize.js";
import { requireParam } from "../lib/params.js";

type Vars = { owner: OwnerRow };
export const meRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

meRoutes.get("/", ownerAuth(), (c) => {
  const owner = c.get("owner");
  const me: OwnerMe = {
    id: owner.id,
    ...(owner.email !== null ? { email: owner.email } : {}),
    email_verified: owner.email_verified_at !== null,
    banned: owner.banned_at !== null,
  };
  return ok(c, me);
});

meRoutes.get("/listings", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
            status, moderation_reason, version, report_count, request_count, chosen_request_id,
            created_at, updated_at, published_at, given_at
     FROM listings WHERE owner_id = ? ORDER BY created_at DESC`,
  )
    .bind(owner.id)
    .all<ListingRow>();

  const items = [];
  for (const row of rows) {
    const photos = await fetchPhotoRows(c.env, row.id);
    items.push(serializeOwnerListing(row, photos));
  }
  return ok(c, items);
});

meRoutes.get("/listings/:id", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");
  const row = await fetchListingRow(c.env, id);
  if (!row || row.owner_id !== owner.id) {
    return fail(c, "not_found", "Listing not found.", 404);
  }
  const photos = await fetchPhotoRows(c.env, id);
  const ownerListing = serializeOwnerListing(row, photos);

  return ok(c, {
    ...ownerListing,
    // Requests land in M3 — placeholder so the dashboard's response shape
    // is stable before that work starts.
    requests: [] as unknown[],
    moderation: {
      status: row.status,
      reason: (row.moderation_reason as ModerationReasonCode | null) ?? null,
      held: row.status === "needs_review",
    },
  });
});
