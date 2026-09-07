-- Admin-initiated request removal (#70): the minor-takedown rule in
-- docs/runbooks/admin.md is executable on the giver side today
-- (POST /api/admin/listings/:id/hide + POST /api/admin/owners/:id/ban) but
-- had no requester-side equivalent — no admin visibility into a request's
-- note, and no way to remove a single request without hiding/rejecting the
-- whole listing, which would punish the giver for a requester's status.
--
-- `removed_at`/`removed_reason` mirror `moderation_reason` on `listings`:
-- distinct from `withdrawn_at` (the requester's own self-service erasure via
-- POST /api/requests/withdraw) so the owner dashboard and any later audit
-- can tell "the requester pulled this back" from "Keepsake removed this."
-- Both are NULL on every pre-existing row for the same reason every other
-- migration in this file leaves new columns NULL rather than backfilling: a
-- removal that didn't happen isn't a fact to invent.
ALTER TABLE requests ADD COLUMN removed_at INTEGER;
ALTER TABLE requests ADD COLUMN removed_reason TEXT;

-- Mirrors `photo_id` on moderation_events: a listing-scoped audit event that
-- is actually about one sub-resource of the listing (a photo, or now a
-- request) rather than the listing as a whole. NULL for every event kind
-- that isn't about a specific request.
ALTER TABLE moderation_events ADD COLUMN request_id TEXT;
