-- Issue #159, step 1 ("persist"): where the Tail Worker writes the Worker's
-- own error and warning lines, so they outlive Workers Logs' 3-day Free-plan
-- retention — the loss the issue names as the sharpest one ("a Saturday
-- incident diagnosed on Monday has no logs left").
--
-- Two tables, and the second one is the interesting half.
--
-- `error_events` is the feed itself. Every row is written by
-- `apps/api/src/tail/errorEvents.ts` and **everything in it has been through
-- `@keepsake/observability/redact`** — not because the producer forgot, but
-- because a bare `console.error` in the Worker never goes near `capture.ts`
-- (docs/design/ops.md says so in as many words), and a table is a far
-- longer-lived place for a requester's address than a log line that expires
-- in 72 hours. The redaction is asserted from the outside by
-- `apps/api/test/tailErrorEvents.test.ts`, which scans every column of a
-- stored row for the raw values it fed in.
--
-- `tail_deliveries` holds exactly one row and exists for one reason: an empty
-- `error_events` must not be renderable as "nothing has gone wrong". Without
-- it, "the Tail Worker has never been attached to this Worker" and "the
-- Worker has not errored in 30 days" are the same query result — the
-- confident-empty answer `ObservatorySource` was invented to prevent
-- (AGENTS.md, "a dashboard that cannot tell 'I did not look' from 'I looked
-- and saw nothing'"). The tail consumer stamps this row on every delivery it
-- receives, whether or not that delivery contained anything worth keeping, so
-- its presence is the evidence the pipeline is real and
-- `observatory/errorEvents.ts` reports `unconfigured` until it exists.
--
-- Neither table is in `docs/runbooks/restore.md`'s documented export, on
-- purpose and written down in both places (that runbook's exclusion list and
-- `BACKUP_EXCLUDED_TABLES` in `tools/preflight/preflight.mjs`, which is what
-- the `backup-tables` check reads).

CREATE TABLE error_events (
  id TEXT PRIMARY KEY,
  -- When the Worker observed the failure: the log line's own timestamp,
  -- which is what the feed sorts and windows by. Distinct from `received_at`
  -- below, which is when this row was written — a tail delivery can lag its
  -- events, and the volume ceiling has to count writes rather than
  -- observations or a replayed burst of old lines could dodge it.
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  -- The producing Worker (`keepsake-production`, `keepsake-preview`), from
  -- the trace item, and the app-level `environment`/`release` the capture
  -- line carried. Nullable: a bare `console.error` has neither.
  script_name TEXT,
  environment TEXT,
  release TEXT,
  -- 'error' | 'warning'. Normalised from the runtime's 'error'/'warn' so the
  -- values match what the Observatory's log panel already renders and what
  -- Cloudflare's own `$metadata.level` filter used.
  level TEXT NOT NULL,
  -- 'exception'   — an uncaught exception on the trace item.
  -- 'capture'     — a `captureException`/`captureMessage` line from
  --                 `@keepsake/observability/capture`.
  -- 'console'     — any other error/warn-level console line.
  -- 'cap_notice'  — this table's own record that the per-minute ceiling
  --                 refused writes; see `dropped` below.
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  error_name TEXT,
  stack TEXT,
  -- `index.ts` mints a `crypto.randomUUID()` per request and tags every
  -- `captureException` with it, so an admin holding an `X-Request-Id` from a
  -- giver's failed request can find that request here.
  request_id TEXT,
  -- The trace item's own verdict ('ok', 'exception', 'exceededCpu', …).
  outcome TEXT,
  -- Redacted JSON of whatever else the line carried (`tags`, `extra`, the
  -- remaining console arguments). Text rather than columns because the shape
  -- is the call site's, not this schema's.
  detail TEXT,
  -- Only ever non-zero on a 'cap_notice' row: how many lines the per-minute
  -- ceiling refused in that minute. A cap that silently loses rows would make
  -- one stray error and a runaway loop render identically, which is the exact
  -- distinction the Observatory's `counts` exist to preserve — so the loss is
  -- written into the same feed the reader is already looking at.
  dropped INTEGER NOT NULL DEFAULT 0
);

-- The feed's own ordering (most recent first, over a window).
CREATE INDEX error_events_observed ON error_events(observed_at);
-- The volume ceiling counts this minute's writes on every insert, and the
-- retention sweep deletes by age; both read this column, not `observed_at`.
CREATE INDEX error_events_received ON error_events(received_at);

CREATE TABLE tail_deliveries (
  -- One row, forever. The CHECK is what makes that a schema fact rather than
  -- a convention: a second row would mean two different answers to "has the
  -- tail consumer ever run here".
  id INTEGER PRIMARY KEY CHECK (id = 1),
  first_delivery_at INTEGER NOT NULL,
  last_delivery_at INTEGER NOT NULL
);
