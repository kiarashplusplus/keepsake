-- Estate bulk upload: the admission code is gone.
--
-- A batch used to need an operator-minted `bulk_grants` row whose id the
-- giver pasted into the "Admission code" field on `/bulk/new` and every
-- write then carried as `X-Bulk-Grant`. Nobody but an operator could issue
-- one, so the first step of giving away a houseful of keepsakes was waiting
-- on a human — for a bound that a per-owner ceiling already provides.
--
-- What replaces it, so this is a removal and not a hole:
--
--   * Per batch — `BULK_MAX_ITEMS_PER_BATCH` / `BULK_MAX_PHOTOS_PER_BATCH`,
--     enforced by `routes/bulk.ts` as a predicate on the item and photo
--     inserts themselves, in the same transaction that would write the row,
--     so two concurrent creates at the boundary cannot both pass.
--   * Per owner per day — `bulk_owner_usage` below, which the grant always
--     sat under anyway and which (unlike a per-batch grant) survives a
--     giver starting a second batch.
--
-- `suggestions_used` is the one counter that had no home outside the grant:
-- cover suggestions were bounded only by `bulk_grants.suggestions_remaining`,
-- and a vision call costs real money, so the ceiling moves here rather than
-- disappearing. Existing rows get 0, which is the right reading — no
-- suggestion has ever been charged against this column.
ALTER TABLE bulk_owner_usage ADD COLUMN suggestions_used INTEGER NOT NULL DEFAULT 0;

-- Dropping the index explicitly, ahead of the table, so this reads the same
-- way whether or not SQLite would have cascaded it.
DROP INDEX IF EXISTS bulk_grants_owner;
DROP TABLE IF EXISTS bulk_grants;
