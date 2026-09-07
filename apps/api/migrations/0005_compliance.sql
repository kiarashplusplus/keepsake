-- Minimum-age attestation (docs/legal-considerations.md "Minimum age"): the
-- server now records, not just validates, a self-declared 18+ attestation at
-- create time for both a listing and a request — the honest floor given the
-- in-person meetup mechanic, not COPPA's 13. NULL on every pre-existing row:
-- attestation didn't exist before this migration, and backfilling a value
-- would be inventing a fact, not recording one.
ALTER TABLE listings ADD COLUMN age_attested_at INTEGER;

-- Requester self-service erasure (docs/legal-considerations.md "Deleting
-- your information" gap: a requester had no way to remove their note/email/
-- phone once submitted — see apps/api/src/routes/requestWithdraw.ts).
--
-- `note`/`email` drop NOT NULL so a withdrawn row can hold NULL instead of an
-- empty-string placeholder that would still collide with
-- `UNIQUE (listing_id, email)` on a second withdrawal for the same listing —
-- SQLite's UNIQUE index treats NULL as distinct from every other NULL, so
-- any number of withdrawn rows on one listing can hold `email = NULL`
-- without a constraint error.
--
-- `withdraw_token_hash` is sha256 of a random token minted at request-
-- creation time (apps/api/src/lib/tokens.ts's `randomTokenRaw()`, the same
-- shape every other bearer secret in this API uses), mailed to the requester
-- as a link, and single-use via `withdrawn_at` — the `recovery_tokens`
-- table's `used_at` pattern, inlined here rather than reusing that table
-- because a withdrawal token identifies one `requests` row directly, not an
-- `owners` row.
--
-- SQLite has no `ALTER TABLE ... DROP NOT NULL`, so this is a standard
-- rebuild: rename, recreate with the new shape, copy, drop, reindex. No
-- other table has a foreign key into `requests`, so no `PRAGMA
-- foreign_keys` juggling is needed around the rename.
ALTER TABLE requests RENAME TO requests_old;

CREATE TABLE requests (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  note TEXT, email TEXT, phone TEXT, ip_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',                     -- open|chosen|not_chosen|withdrawn
  created_at INTEGER NOT NULL, chosen_at INTEGER, notified_at INTEGER,
  age_attested_at INTEGER,
  withdraw_token_hash TEXT UNIQUE, withdrawn_at INTEGER,
  UNIQUE (listing_id, email));

INSERT INTO requests (id, listing_id, note, email, phone, ip_digest, status, created_at, chosen_at, notified_at)
  SELECT id, listing_id, note, email, phone, ip_digest, status, created_at, chosen_at, notified_at FROM requests_old;

DROP TABLE requests_old;

CREATE INDEX requests_listing ON requests(listing_id, created_at);
