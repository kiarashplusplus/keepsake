-- Estate bulk upload: durable batch drafts, their photos, the admission
-- grants that bound them, and the submission operations that turn ready
-- drafts into ordinary listings.
--
-- Everything in these tables is PRIVATE. Nothing here is ever serialized to a
-- stranger: `upload_batches.name` ("Mum's house"), `upload_batch_items.room_label`
-- ("front bedroom") and `upload_batches.shared_story` exist so one giver can
-- find their own objects in their own house. Shared story text becomes public
-- only where the giver has copied it into an item's own `story`, which then
-- goes through moderation like any other listing text.
--
-- Draft items deliberately live OUTSIDE `listings`. A draft is not a listing
-- that happens to be invisible: it has no place, no version and no moderation
-- history, and it must not be reachable by the feed, FTS, the sitemap, the
-- moderation retry cron, or any keyset cursor. Adding a sixth `status` to
-- `listings` would have put every one of those surfaces one forgotten `WHERE`
-- clause away from publishing a half-written draft. A listing is created at
-- submission and not one moment earlier.

-- ---------------------------------------------------------------------------
-- Sweep protection
-- ---------------------------------------------------------------------------
-- `cron/orphanSweep.ts` deletes any photo with `listing_id IS NULL` older than
-- 24 hours, together with its R2 objects. That is exactly right for an
-- abandoned give flow and exactly wrong for an estate: a batch is prepared
-- over days, and every photo in it is unattached until the day it is
-- submitted. Without this column, a giver's second evening of work would find
-- the first evening's photos gone.
--
-- A column on `photos` rather than a join against `upload_batch_photos`, on
-- purpose. The sweep's predicate stays single-table, so its correctness never
-- depends on a join across two tables written by two different code paths
-- where the default on disagreement is deletion. The row carries its own
-- promise. It also buys reclamation for free: cancelling or expiring a batch
-- sets `retain_until = NULL`, and the existing, already-backup-guarded,
-- already-tested sweep collects the bytes on its next nightly run — no second
-- implementation of R2 deletion, which is the code least worth writing twice.
--
-- `photos_orphans` (0001_init.sql, `ON photos(created_at) WHERE listing_id IS
-- NULL`) is deliberately left exactly as it is. It still narrows the sweep's
-- scan to unattached photos in date order, and `retain_until IS NULL` is a
-- cheap filter on what it returns. A composite index would save a nightly
-- batch job a little work at the cost of an extra index write on every photo
-- upload, which is the wrong trade.
ALTER TABLE photos ADD COLUMN retain_until INTEGER;

-- ---------------------------------------------------------------------------
-- The batch
-- ---------------------------------------------------------------------------
CREATE TABLE upload_batches (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  -- Caller-chosen and stable across retries: a flaky "start a batch" POST
  -- that is retried resolves to the same row instead of leaving an abandoned
  -- batch behind for every dropped response.
  client_batch_key TEXT NOT NULL,
  name TEXT NOT NULL,
  shared_story TEXT,
  -- Resolved ONCE, here, through the same `lookupPostalCode` that
  -- `POST /api/listings` uses — so submitting 100 items performs no geo
  -- lookups at all, and every listing in a batch lands in the same place the
  -- giver saw when they set it up.
  country TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  place_name TEXT NOT NULL,
  admin1 TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  -- draft | submitting | closed | cancelled
  state TEXT NOT NULL DEFAULT 'draft',
  -- Bumped on every deliberate write. A client sends the revision it last saw
  -- and gets a 409 if another tab, or another device holding the same owner
  -- token, moved first.
  revision INTEGER NOT NULL DEFAULT 1,
  -- Reads do not move this; only a deliberate edit, upload or renewal does.
  -- A tab left open polling progress must not keep an abandoned batch alive.
  last_activity_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  cancelled_at INTEGER
);

CREATE UNIQUE INDEX upload_batches_client_key ON upload_batches(owner_id, client_batch_key);
CREATE INDEX upload_batches_owner ON upload_batches(owner_id, updated_at DESC);
CREATE INDEX upload_batches_expiry ON upload_batches(expires_at) WHERE state IN ('draft', 'submitting');

-- ---------------------------------------------------------------------------
-- The draft item
-- ---------------------------------------------------------------------------
CREATE TABLE upload_batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  client_item_id TEXT NOT NULL,
  -- All nullable, all permissive. A person clearing a house types what they
  -- know when they know it, and a draft that refuses to save an incomplete
  -- thought loses the thought. The publishing rules (title length, a 20–2000
  -- character story, the category enum) are applied exactly once, at
  -- submission, by running the real `CreateListingInput` — see
  -- `src/bulk/submit.ts`. There is no second copy of them anywhere.
  title TEXT,
  story TEXT,
  category TEXT,
  -- The applied photo suggestion's aspects, verbatim, as a JSON array of
  -- {name, value}. Text rather than rows because a draft's aspects are a blob
  -- the client owns wholesale until submission, when they are validated and
  -- written to `listing_aspects` by the same `replaceListingAspects` every
  -- other path uses.
  aspects_json TEXT,
  -- Private, never published. Where the object physically is, so the giver
  -- can find it when a stranger comes to collect it.
  room_label TEXT,
  lot_label TEXT,
  -- editing | ready | queued | submitted | failed
  state TEXT NOT NULL DEFAULT 'editing',
  revision INTEGER NOT NULL DEFAULT 1,
  failure_code TEXT,
  failure_detail TEXT,
  -- Claimed by the submission runner in the same transaction that inserts the
  -- listing. This column is the duplicate-create guard: the claim only fires
  -- `WHERE listing_id IS NULL`, and the partial unique index below means the
  -- database refuses a second one even if the runner is later rewritten by
  -- someone who does not know that.
  --
  -- `ON DELETE CASCADE`, so a giver deleting the listing takes this draft with
  -- it. `SET NULL` would return the item to "never submitted" and the runner
  -- would republish it, resurrecting a listing its owner deleted — the one
  -- thing `DELETE /api/listings/:id` promises not to leave possible. And
  -- `test/cascadeDelete.test.ts` enumerates every foreign key pointing at
  -- `listings` from the live schema and requires a cascade on each, because
  -- the delete route deletes one row and trusts the database for the rest.
  -- That guard is what caught this column's first draft, which declared no
  -- `ON DELETE` clause at all.
  listing_id TEXT REFERENCES listings(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  submitted_at INTEGER
);

CREATE UNIQUE INDEX upload_batch_items_client_key ON upload_batch_items(batch_id, client_item_id);
-- Partial, because SQLite treats NULLs as distinct in a unique index — the
-- many not-yet-submitted rows must not collide with each other. Same shape as
-- `requests_confirm_token` in the request-confirmation migration.
CREATE UNIQUE INDEX upload_batch_items_listing ON upload_batch_items(listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX upload_batch_items_batch ON upload_batch_items(batch_id, state);

-- ---------------------------------------------------------------------------
-- The batch's photos
-- ---------------------------------------------------------------------------
-- Identity, grouping and ordering for a draft's photos. Deliberately NOT
-- columns on `photos`: these are draft-workspace facts that must vanish with
-- the batch, and `photos` is read by the feed, moderation, the image route and
-- the share card, none of which should ever learn that batches exist.
CREATE TABLE upload_batch_photos (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  client_photo_id TEXT NOT NULL,
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  -- Nullable: a photo can sit in the batch's tray before the giver decides
  -- which object it belongs to. `ON DELETE SET NULL` so splitting an item
  -- returns its photos to the tray rather than destroying them.
  item_id TEXT REFERENCES upload_batch_items(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX upload_batch_photos_client_key ON upload_batch_photos(batch_id, client_photo_id);
-- A photo belongs to at most one draft, anywhere — stronger and cheaper than
-- scoping it per batch. Two items cannot claim the same bytes, so no
-- submission race can attach one photo to two listings.
CREATE UNIQUE INDEX upload_batch_photos_photo ON upload_batch_photos(photo_id);
CREATE INDEX upload_batch_photos_item ON upload_batch_photos(item_id, position);

-- ---------------------------------------------------------------------------
-- Admission
-- ---------------------------------------------------------------------------
-- A grant is an allowance row, NOT a bearer secret. Requests name it in
-- `X-Bulk-Grant: <id>`, and it only ever says *how much*; who the caller is
-- remains the owner token in `Authorization`, checked first. So there is no
-- new secret material to leak into a log, a URL or an image request, and a
-- leaked grant id is worth nothing without the device token it is bound to.
--
-- It exists because a Turnstile token is single-use and expires in 300
-- seconds (`src/middleware/turnstile.ts`, and the #183 comment in
-- `routes/photos.ts`), so mounting `turnstile()` on the bulk routes would
-- mean one challenge per photo — 300 challenges for a 100-item estate. The
-- grant is the exchange: an operator mints one for the pilot, the giver
-- spends a bounded allowance, and a fresh challenge extends its clock.
--
-- Worth stating plainly, because it is the thing an audit would otherwise
-- find: `turnstile()` soft-passes when `TURNSTILE_SECRET` is unset, which is
-- every local run and every test. So the challenge is NOT what bounds a
-- batch. These counters are. They are exact D1 guarded updates, never KV,
-- because the KV budgets are eventually consistent by their own
-- documentation and cannot be a lock.
CREATE TABLE bulk_grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  -- NULL until first use, then bound to one batch for the rest of its life.
  batch_id TEXT REFERENCES upload_batches(id) ON DELETE CASCADE,
  items_remaining INTEGER NOT NULL,
  photos_remaining INTEGER NOT NULL,
  -- Cover suggestions. A third counter rather than a share of the other two,
  -- because a suggestion is optional work: a batch that never asks for one
  -- should not thereby be allowed more photos, and a batch that exhausts its
  -- suggestions must still be able to finish uploading and submit. The give
  -- flow's per-IP KV ceiling could not do this job — see
  -- `MAX_BATCH_SUGGESTIONS` in `packages/contracts/src/bulk.ts`.
  suggestions_remaining INTEGER NOT NULL DEFAULT 0,
  -- 'admin' (minted for the pilot) | 'renew' (never resets the two counters
  -- above, only `expires_at` — otherwise a renewal loop would be unlimited
  -- admission).
  issued_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX bulk_grants_owner ON bulk_grants(owner_id, expires_at);

-- The ceiling above the grant. A grant is per-batch and finite; this row is
-- per owner per day and survives both a new batch and a renewed grant, which
-- is what makes "creating additional batches must not reset the allowance"
-- actually true rather than merely intended.
CREATE TABLE bulk_owner_usage (
  owner_id TEXT NOT NULL REFERENCES owners(id),
  -- YYYY-MM-DD, from `lib/day.ts`'s `todayISO()` — the same definition of
  -- "the day" the KV budgets use, so two ceilings never roll over at
  -- different midnights.
  day TEXT NOT NULL,
  items_used INTEGER NOT NULL DEFAULT 0,
  photos_used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, day)
);

-- ---------------------------------------------------------------------------
-- The submission operation
-- ---------------------------------------------------------------------------
CREATE TABLE bulk_operations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  batch_id TEXT NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  -- 'submit' today. Named rather than assumed so a later operation kind (a
  -- bulk withdraw, say) cannot collide with a submission's client key.
  kind TEXT NOT NULL,
  op_key TEXT NOT NULL,
  -- sha256 of the canonical selection. The same key arriving with a different
  -- payload is a caller bug, not a retry, and is answered 409 rather than
  -- silently doing the new thing under the old key's identity.
  payload_hash TEXT NOT NULL,
  -- [{client_item_id, item_id, revision}], pinned when the operation was
  -- accepted. A fifth table would buy nothing: this is read whole by the
  -- runner, never queried by, and bounded by the 100-item cap. Per-item
  -- outcomes live on `upload_batch_items.state`/`failure_code`, which the UI
  -- needs anyway — one state machine, not two.
  selection_json TEXT NOT NULL,
  -- queued | running | done | cancelled
  status TEXT NOT NULL DEFAULT 'queued',
  cursor INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  next_attempt_at INTEGER NOT NULL,
  -- Issue #64's age attestation, performed once for the whole submission and
  -- stamped onto every listing it creates. The date of birth itself is never
  -- bound into any query here, exactly as in `POST /api/listings`.
  age_attested_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE UNIQUE INDEX bulk_operations_key ON bulk_operations(owner_id, batch_id, kind, op_key);
CREATE INDEX bulk_operations_due ON bulk_operations(next_attempt_at) WHERE status IN ('queued', 'running');
