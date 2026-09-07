-- Issue #169: the hashed IP stored on a request or a report had no expiry, no
-- sweep and no delete path, while apps/site/public/privacy.html promised
-- twice that every IP hash expires after 48 hours. That TTL was real but
-- existed only on the KV budget counters (`moderation/budget.ts`); the same
-- `dailyIpDigest` value written into `requests.ip_digest` and
-- `reports.ip_digest` stayed in D1 forever — including on a row whose owner
-- had already used the withdraw link to erase their note, email and phone.
--
-- The page's own concession makes the retention promise load-bearing: it
-- tells the reader an IPv4 preimage is brute-forceable by anyone who knows
-- the day, and `created_at` sits in the same row, so "it expires within 48
-- hours" is the sentence that makes the concession acceptable.
--
-- Both columns drop NOT NULL so a swept row can hold NULL rather than a
-- placeholder. NULL, not an empty string, for the reason 0005_compliance.sql
-- gives about `email`: `reports` carries `UNIQUE (listing_id, ip_digest)`,
-- and SQLite treats every NULL in a unique index as distinct from every
-- other, so any number of swept reports on one listing can hold NULL without
-- a constraint error. An empty-string placeholder would collide on the
-- second one.
--
-- The uniqueness checks these columns back are day-scoped by construction
-- (`lib/digest.ts` hashes `<day>:<ip>`), so a value older than today is never
-- compared against anything — nulling at 48 hours costs no enforcement.
--
-- SQLite has no `ALTER TABLE ... DROP NOT NULL`, so both are standard
-- rebuilds: rename, recreate with the new shape, copy, drop, recreate the
-- indexes. No other table has a foreign key into either, so no
-- `PRAGMA foreign_keys` juggling is needed around the renames. Every column
-- is carried over as-is, including the ones 0007/0008 added.

ALTER TABLE requests RENAME TO requests_old;

CREATE TABLE requests (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  note TEXT, email TEXT, phone TEXT, ip_digest TEXT,
  status TEXT NOT NULL DEFAULT 'open',                     -- open|chosen|not_chosen|withdrawn
  created_at INTEGER NOT NULL, chosen_at INTEGER, notified_at INTEGER,
  age_attested_at INTEGER,
  withdraw_token_hash TEXT UNIQUE, withdrawn_at INTEGER,
  removed_at INTEGER, removed_reason TEXT,
  notify_failed_reason TEXT,
  UNIQUE (listing_id, email));

INSERT INTO requests (id, listing_id, note, email, phone, ip_digest, status, created_at, chosen_at,
                      notified_at, age_attested_at, withdraw_token_hash, withdrawn_at, removed_at,
                      removed_reason, notify_failed_reason)
  SELECT id, listing_id, note, email, phone, ip_digest, status, created_at, chosen_at,
         notified_at, age_attested_at, withdraw_token_hash, withdrawn_at, removed_at,
         removed_reason, notify_failed_reason FROM requests_old;

DROP TABLE requests_old;

CREATE INDEX requests_listing ON requests(listing_id, created_at);

-- Same rebuild for `reports`, whose shape has not changed since 0001_init.
ALTER TABLE reports RENAME TO reports_old;

CREATE TABLE reports (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reason TEXT NOT NULL, details TEXT, ip_digest TEXT, created_at INTEGER NOT NULL,
  UNIQUE (listing_id, ip_digest));

INSERT INTO reports (id, listing_id, reason, details, ip_digest, created_at)
  SELECT id, listing_id, reason, details, ip_digest, created_at FROM reports_old;

DROP TABLE reports_old;

-- The rows already in D1 when this lands are older than 48 hours or will be
-- within two days, and `orphanSweep` (which now nulls anything past the
-- window every night) collects them on its next run. Nulling them here as
-- well would be a second, unreviewable copy of that rule; the sweep is the
-- one place the retention window is enforced, and it is the place the guard
-- test in apps/web/test/guards/privacyPolicy.test.ts asserts against.
