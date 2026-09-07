-- Issue #188: a request's email address was never verified.
--
-- `POST /api/listings/:id/requests` took any syntactically valid address,
-- wrote it into `requests` as the requester of record, mailed it a "we passed
-- your note along" confirmation, and showed the giver a genuine-looking ask.
-- Nothing in that path established that the submitter controlled the address,
-- so anyone could enrol a third party as a requester: the victim got mail they
-- never asked for, and if the giver chose that request the victim received the
-- giver's real address while the giver waited to meet a stranger who had never
-- asked for anything.
--
-- The fix is confirm-then-forward: a new request is held unconfirmed and only
-- a "was this you?" link goes to the address. Clicking it is what makes the
-- request real — what forwards it to the giver, what counts it toward
-- `request_count`, and what mints the withdraw token.
--
-- `confirm_token_hash` is sha256 of `randomTokenRaw()`, the same
-- mint-random/store-only-the-hash shape as `withdraw_token_hash` above it and
-- as `recovery_tokens`. It is added with a separate UNIQUE index rather than a
-- UNIQUE column because SQLite refuses `ALTER TABLE ... ADD COLUMN ... UNIQUE`;
-- the index is the same constraint, and SQLite treats NULLs as distinct, so any
-- number of rows can hold NULL (every pre-existing row, plus every row whose
-- token has been cleared by withdrawal or admin removal).
ALTER TABLE requests ADD COLUMN confirm_token_hash TEXT;
ALTER TABLE requests ADD COLUMN confirm_expires_at INTEGER;
ALTER TABLE requests ADD COLUMN confirmed_at INTEGER;

CREATE UNIQUE INDEX requests_confirm_token ON requests(confirm_token_hash);

-- The nightly sweep (`src/cron/orphanSweep.ts`) deletes unconfirmed rows once
-- their link has expired: an address nobody confirmed is third-party PII this
-- service was never authorised to hold, so it goes rather than lingering.
-- Partial, because confirmed rows — the overwhelming majority — never match.
CREATE INDEX requests_unconfirmed_expiry ON requests(confirm_expires_at) WHERE confirmed_at IS NULL;

-- Every request that already exists was forwarded to its giver under the old
-- rules and is, as far as the giver is concerned, live. Stamping them confirmed
-- records what is true of the system (they are past the gate), not a claim that
-- anyone proved anything: nothing can retroactively verify an address, and
-- dropping them would destroy real asks from real people to punish them for a
-- server-side gap. `created_at` rather than the migration time so the column
-- never reads as "confirmed the night we deployed this".
UPDATE requests SET confirmed_at = created_at WHERE confirmed_at IS NULL;
