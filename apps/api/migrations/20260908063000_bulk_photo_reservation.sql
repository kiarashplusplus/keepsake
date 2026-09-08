-- `upload_batch_photos.photo_id` becomes nullable, so the row can be reserved
-- before the photo it will name exists.
--
-- Why: `PUT /api/bulk/batches/:id/photos/:clientPhotoId` used to decide whether
-- to charge admission by asking whether a `photos` row existed under the
-- deterministic id. That question cannot tell "never attempted" apart from
-- "debited, then the Worker was evicted before the bytes were stored" — both
-- answer "no row yet" — so a retry landing in that window spent the giver's
-- grant and their daily ceiling a second time, with nothing to refund it.
--
-- The reservation row is what tells those two apart. It is written in the same
-- D1 transaction as the debit, under `upload_batch_photos_client_key`, before
-- a single byte reaches R2. A retry that finds it (`photo_id IS NULL`) knows
-- admission was already spent and resumes at "store the bytes". See the header
-- on that handler in `routes/bulk.ts` for the full three-step sequence.
--
-- SQLite has no `ALTER TABLE ... DROP NOT NULL`, so this is the standard
-- rebuild — rename, recreate with the new shape, copy, drop, recreate the
-- indexes — exactly as 20260907190500_ip_digest_expiry.sql does for `requests`
-- and `reports`. Nothing has a foreign key *into* this table, so no
-- `PRAGMA foreign_keys` juggling is needed around the rename.
--
-- A separate migration rather than an edit to 20260908043946_bulk_upload.sql,
-- which created the table: that file landed on `main` with PR #257, and
-- `tools/preflight`'s `migration-drift` check compares every migration against
-- its landed state. A landed migration edited after the fact is a schema two
-- environments disagree about.

ALTER TABLE upload_batch_photos RENAME TO upload_batch_photos_old;

CREATE TABLE upload_batch_photos (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  client_photo_id TEXT NOT NULL,
  -- Nullable, per this file's header: NULL means "reserved and paid for, not
  -- yet stored".
  photo_id TEXT REFERENCES photos(id) ON DELETE CASCADE,
  -- Nullable: a photo can sit in the batch's tray before the giver decides
  -- which object it belongs to. `ON DELETE SET NULL` so splitting an item
  -- returns its photos to the tray rather than destroying them.
  item_id TEXT REFERENCES upload_batch_items(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO upload_batch_photos (id, batch_id, client_photo_id, photo_id, item_id, position, created_at, updated_at)
  SELECT id, batch_id, client_photo_id, photo_id, item_id, position, created_at, updated_at
  FROM upload_batch_photos_old;

DROP TABLE upload_batch_photos_old;

CREATE UNIQUE INDEX upload_batch_photos_client_key ON upload_batch_photos(batch_id, client_photo_id);
-- A photo belongs to at most one draft, anywhere — stronger and cheaper than
-- scoping it per batch. Two items cannot claim the same bytes, so no
-- submission race can attach one photo to two listings. SQLite treats NULLs as
-- distinct in a unique index, so the many unresolved reservations
-- (`photo_id IS NULL`) never collide with each other here — only two rows
-- naming the same real photo id would, which is exactly what this refuses.
CREATE UNIQUE INDEX upload_batch_photos_photo ON upload_batch_photos(photo_id);
CREATE INDEX upload_batch_photos_item ON upload_batch_photos(item_id, position);
