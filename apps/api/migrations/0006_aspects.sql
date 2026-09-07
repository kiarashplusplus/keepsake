-- eBay-style name/value aspects read off a listing's cover photo by the
-- suggestion endpoint (`POST /api/photos/:id/suggest`, already emitting
-- `{object: teapot, material: copper, era: 1970s}` before this migration
-- existed) — persisted per listing instead of as fixed columns, since the
-- vocabulary is open-ended and model-chosen (issue #36; the plan's
-- Labeling & search milestone explicitly rejects a fixed-column schema in
-- favor of this table, matching how eBay itself models item specifics).
--
-- One row per (listing, aspect), not a single JSON blob column: this is what
-- makes an aspect *indexable* (`listing_aspects_name_value` below), which is
-- the entire point per the issue ("persisted... and indexed so they can be
-- queried"). `position` preserves the model's own ordering (its most
-- confident aspect first) for a future shelves UI (#39) without needing a
-- second sort key.
--
-- Deliberately no UNIQUE constraint on (listing_id, name): the model can
-- emit the same name twice with different values in principle (not
-- expected, but nothing upstream forbids it), and enforcing uniqueness here
-- would silently drop data at insert time rather than at the point that
-- actually decides it (PhotoSuggestionSchema's `.max(6)` cap). Cascade
-- delete matches every other per-listing child table (`photos`, `requests`,
-- `reports`, `moderation_events`).
--
-- No column here is ever a listing's *only* route to visibility — the
-- default feed and search modes (`GET /api/feed`) never join this table,
-- and #40's zero-aspect-listing guarantee is a first-class API test
-- (apps/api/test/aspects.test.ts) rather than left implicit, precisely
-- because eBay's own aspect-filter UX shipped without that guarantee and it
-- was a real, documented failure mode this project is deliberately avoiding.
CREATE TABLE listing_aspects (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX listing_aspects_listing ON listing_aspects(listing_id, position);
CREATE INDEX listing_aspects_name_value ON listing_aspects(name, value);
