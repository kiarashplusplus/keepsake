CREATE TABLE owners (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  email TEXT, email_verified_at INTEGER, banned_at INTEGER, ban_reason TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
CREATE INDEX owners_email ON owners(email) WHERE email IS NOT NULL;

CREATE TABLE listings (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
  title TEXT NOT NULL, story TEXT NOT NULL, category TEXT NOT NULL,
  country TEXT NOT NULL, postal_code TEXT NOT NULL,        -- normalized (US 5-digit, CA FSA, GB outward)
  place_name TEXT NOT NULL, admin1 TEXT,                   -- "Somerville", "MA" (from postal_codes)
  lat REAL NOT NULL, lng REAL NOT NULL,
  status TEXT NOT NULL,   -- pending|approved|rejected|needs_review|hidden|given|withdrawn
  moderation_reason TEXT, version INTEGER NOT NULL DEFAULT 1,
  report_count INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0,
  chosen_request_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER, given_at INTEGER);
CREATE INDEX listings_feed     ON listings(status, published_at DESC, id DESC);
CREATE INDEX listings_feed_cat ON listings(category, status, published_at DESC, id DESC);
CREATE INDEX listings_geo      ON listings(status, lat, lng);
CREATE INDEX listings_owner    ON listings(owner_id, created_at DESC);
CREATE INDEX listings_queue    ON listings(status, updated_at) WHERE status IN ('pending','needs_review','hidden');

CREATE TABLE photos (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
  listing_id TEXT REFERENCES listings(id) ON DELETE CASCADE, position INTEGER,
  r2_key_full TEXT NOT NULL, r2_key_thumb TEXT NOT NULL,   -- photos/<id>/full.jpg (≤2048) / thumb.jpg (≤640)
  width INTEGER NOT NULL, height INTEGER NOT NULL, bytes_full INTEGER NOT NULL,
  blurhash TEXT NOT NULL, content_type TEXT NOT NULL,
  moderation_status TEXT NOT NULL DEFAULT 'unchecked',     -- unchecked|passed|flagged|error
  created_at INTEGER NOT NULL);
CREATE INDEX photos_listing ON photos(listing_id, position);
CREATE INDEX photos_orphans ON photos(created_at) WHERE listing_id IS NULL;

CREATE TABLE requests (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  note TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, ip_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',                     -- open|chosen|not_chosen|withdrawn
  created_at INTEGER NOT NULL, chosen_at INTEGER, notified_at INTEGER,
  UNIQUE (listing_id, email));
CREATE INDEX requests_listing ON requests(listing_id, created_at);

CREATE TABLE reports (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reason TEXT NOT NULL, details TEXT, ip_digest TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE (listing_id, ip_digest));
CREATE TABLE moderation_events (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  listing_version INTEGER NOT NULL, photo_id TEXT,
  kind TEXT NOT NULL,      -- text|image|decision|admin|report_autohide
  model TEXT, verdict TEXT NOT NULL,  -- pass|flag|review|error|approved|rejected|hidden|restored|banned
  flags_json TEXT, reason TEXT, attempt INTEGER NOT NULL DEFAULT 1, latency_ms INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX moderation_events_listing ON moderation_events(listing_id, created_at);
CREATE TABLE recovery_tokens (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,   -- recover (30 min) | verify_email (24 h)
  token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL);
