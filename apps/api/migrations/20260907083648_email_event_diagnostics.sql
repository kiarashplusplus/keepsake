-- Issue #6: `email_events` records that a send failed, but not enough to tell
-- *which kind* of failure it was. Two columns, for the two questions the
-- launch audit could not answer from the DB:
--
-- `error_detail` — the provider's own words, kept whole and kept apart from
-- the `error` code. Before this, `sendViaCloudflare` folded the provider's
-- message into the reason string itself (`send_failed: <160 chars>`), which
-- collapsed two very different failures into one shape ("this binding
-- refuses unverified destinations" vs "that address was a typo") *and* made
-- the reason vary per recipient, so a systematic refusal fragmented into one
-- single-count group per address instead of reading as one pattern. Admin
-- and log surfaces only — never returned to an ordinary end user.
--
-- `to_domain` — the domain half of the recipient, lowercased. `to_hash` stays
-- the only thing that identifies *who* was mailed; a bare domain identifies a
-- mail provider, not a person, and it is the difference between "one address
-- bounced" and "every send to this provider is refused" — the exact failure
-- mode this issue is about, and one that is invisible when every row is an
-- opaque hash. NULL on rows written before this migration.
ALTER TABLE email_events ADD COLUMN error_detail TEXT;
ALTER TABLE email_events ADD COLUMN to_domain TEXT;
CREATE INDEX email_events_domain ON email_events(to_domain, created_at);
