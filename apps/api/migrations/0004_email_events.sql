-- Every send attempt through src/email/sendMail.ts, success or failure, so
-- "did the request email actually go out" is answerable from the DB instead
-- of grepping Worker logs. `to_hash` is sha256(lowercased address) — never
-- the raw address — matching the no-raw-PII rule the rest of this schema
-- follows for IPs.
CREATE TABLE email_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,        -- verify_email|new_request|chosen|recover
  to_hash TEXT NOT NULL,
  provider TEXT NOT NULL,    -- cf|resend|none (stubbed: no binding/key configured)
  ok INTEGER NOT NULL,       -- 0|1
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX email_events_kind ON email_events(kind, created_at);
