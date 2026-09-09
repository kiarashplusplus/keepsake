-- Issue #310, part two: the real unsubscribe mechanism the CASL footer
-- promised but nothing yet honored. One row per address that has ever acted
-- on its own unsubscribe link, keyed by `token_hash` — the SHA-256 of the
-- HMAC-derived token that link carries (`src/email/unsubscribe.ts`), never
-- the address itself. Nothing here can be reversed into an address without
-- the server's `UNSUBSCRIBE_SECRET`, and nothing here is written until
-- someone actually clicks a link — the token is computed on demand from the
-- address at send time and at read time; it needs no row to exist.
--
-- `suppressed` is the live boolean `src/email/sendMail.ts` consults before
-- every send; `unsubscribed_at`/`resubscribed_at` are kept alongside it
-- (rather than inferred from `suppressed` alone) so the resubscribe page and
-- a future audit can both answer "when", not just "which way", without a
-- second table.
CREATE TABLE email_suppressions (
  token_hash TEXT PRIMARY KEY,
  suppressed INTEGER NOT NULL, -- 0|1, the value sendMail() actually checks
  unsubscribed_at INTEGER,
  resubscribed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
