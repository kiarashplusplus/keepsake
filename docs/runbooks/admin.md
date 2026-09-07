# Runbook: admin

Status: `[DONE]` (API side, 2026-09-06) — `src/routes/admin.ts` + `src/middleware/adminAuth.ts`,
tests in `test/admin.test.ts`, `test/adminAuth.test.ts`, `test/ownerAuth.test.ts`,
`test/orphanSweep.test.ts`. The `/admin` web page itself is a separate,
not-yet-started piece of M4/M5 — everything below is the API a future admin page (or `curl`) talks to.

Kiarash is the only admin. Auth is a single secret (`ADMIN_TOKEN`), sent as
`Authorization: Bearer <ADMIN_TOKEN>` and compared constant-time — there is no admin user table
row, no session, no second admin.

## Access

Web: `/admin` prompts for the token, stores it in `sessionStorage` only (cleared on tab close —
deliberately not `localStorage`, since this is the one credential in the app that grants access
to everything). API: any `Authorization: Bearer <ADMIN_TOKEN>` request to `/api/admin/*`.

Rotate with:

```sh
wrangler secret put ADMIN_TOKEN --env production
```

Rotating invalidates every open admin session immediately (no server-side session to migrate) —
expected, not a bug, if rotation follows a suspected leak (see `docs/runbooks/incident.md`).

All `/api/admin/*` routes are behind the `RL_ADMIN` rate-limit binding (120/60s, `wrangler.toml`)
**before** `adminAuth()` runs — `adminRoutes.use("*", burst("RL_ADMIN"), adminAuth())`. The order
is the whole point and it is worth stating plainly, because this file used to assert the
protection while the code did the opposite: with `adminAuth()` first, a wrong token was answered
by `fail(...)` and never reached the limiter, so token guessing was unmetered (the 2026-09-06
launch audit measured 150 wrong tokens from one IP inside 60s returning 150x401 and 0x429). With
the limiter in front, the 401 path costs an attacker exactly what the 200 path costs. Both halves
— the count and the ordering — are pinned by tests in `apps/api/test/adminAuth.test.ts`.

Every 401 from `/api/admin/*` carries the same body (`"Invalid admin token."`) whether the token
is wrong or `ADMIN_TOKEN` is unset, so the response never reveals whether admin is configured.

## Queue

`GET /api/admin/queue?status=<needs_review|hidden|pending|rejected>&cursor=&limit=` — one status
per call (not tabs merged server-side; the web page is expected to make one call per tab).
Paginated with the same opaque keyset-cursor shape `GET /api/feed` uses, but ordered by
`updated_at DESC` rather than `published_at` — what an admin wants triaged first is whatever
last changed. Each item is every `OwnerListing` field (title, story, photos, status, …) plus:

- `owner: { id, email_masked, email_verified, banned }` — never the raw email.
- `report_count`.
- `events: [{ kind, model, verdict, flags, reason, attempt, latency_ms, created_at }, …]` — the
  full `moderation_events` log for that listing, `flags_json` parsed. The reasoning trail, not
  just the current status.
- `reports: [{ reason, details, created_at }, …]` — no `ip_digest`, no other reporter identity.

## Actions

| Action | Effect |
|---|---|
| `POST /api/admin/listings/:id/approve` | `needs_review`\|`pending`\|`hidden` → `approved`; sets `published_at` if not already set |
| `POST /api/admin/listings/:id/hide` | any status except already-`hidden` → `hidden`; optional `{ reason }` in the body |
| `POST /api/admin/listings/:id/restore` | `hidden` → `approved`; resets `report_count` to 0 so it isn't instantly re-hidden by the same reports |
| `POST /api/admin/listings/:id/reject` | any status except `given` → `rejected`; body `{ reason }` must be one of `ADMIN_REJECT_REASONS` (`@keepsake/contracts/admin`) — the giver-facing subset of `MODERATION_REASON_CODES`, excluding the internal-only `budget`/`held_for_review` |
| `POST /api/admin/owners/:id/ban` | sets `banned_at`/`ban_reason`; hides every one of the owner's listings that isn't already `given`; every owner-route request from that owner 403s from then on |
| `POST /api/admin/owners/:id/unban` | clears `banned_at`/`ban_reason` only — listings the ban hid stay hidden until individually restored |
| `GET /api/admin/stats` | listing counts by status, requests today, email failures today, today's `mod_text`/`mod_image` AI budget usage (KV `budget:<kind>:<day>`) |
| `GET /api/admin/health` | `postal_codes` row count (warns if 0) and `cron_last_run` timestamps (`cron:last:moderationRetry`, `cron:last:orphanSweep`, from KV) |
| `POST /api/admin/test-email` | sends a real message through the real `sendMail()` path to `{ to }` and reports back `{ sent, reason, provider }` — see below |
| `POST /api/admin/test-error` | **diagnostic only, not product API** — deliberately calls `captureException`/`captureMessage` (`{ kind: "exception" \| "message" }`, defaults to `"exception"`) so a real event can be confirmed in Workers Logs / `wrangler tail` — see below |

Every listing action writes a `moderation_events` row with `kind='admin'` — the admin queue's own
history is itself an audit log, not just a UI convenience.

## Proving email actually works

Launch-audit finding: production had never delivered mail to anyone but Kiarash, and every failure
was swallowed silently — `sendMail()` fails closed (see `docs/design/email.md`), which is correct
for a give/request/choose flow but means nobody would notice a broken sender domain until a real
giver complained. `POST /api/admin/test-email` closes that gap: it's a real send through the real
path (never a stub), to any address, reporting exactly what happened.

`leapkg@gmail.com` is on the preview allowlist (`EMAIL_ALLOWLIST` in `wrangler.toml`'s
`[env.preview.vars]`) specifically so this has a second real inbox to check delivery against — the
`kiarasha@alum.mit.edu` route alone couldn't distinguish "it always worked" from "it only ever
worked for the one address that's also the developer."

```sh
curl -s -X POST "$SITE_URL/api/admin/test-email" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"leapkg@gmail.com"}' | jq
```

`{ "sent": true, "reason": null, "provider": "cf" }` means it went out — check the inbox to confirm
it actually arrived, since "sent" here means "the provider accepted it," not "it was delivered."
`{ "sent": false, "reason": "..." }` (e.g. `blocked_not_allowlisted`, `blocked_email_mode_off`,
`send_failed: ...`) means it didn't, and the reason is `sendMail()`'s own, not a reinterpretation —
see `apps/api/src/email/sendMail.ts`'s `guardRecipient` for what each blocked reason means.

## Proving an error actually reaches Workers Logs

Issue #14 replaced `@sentry/cloudflare` with Workers Logs — no third-party account or secret
needed, but also nothing left to unit-test the delivery of: `test/admin.test.ts` only proves
`captureException`/`captureMessage` were called, the same limitation the old `test/sentry.test.ts`
had for Sentry. `POST /api/admin/test-error` exists to close that gap against a real deployment —
**diagnostic only, never call it from product code or wire a client button to it.**

```sh
curl -s -X POST "$SITE_URL/api/admin/test-error" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"exception"}' | jq
```

`{ "captured": true, "kind": "exception" }` means the call happened — confirm the event actually
landed with `wrangler tail --env preview` (or the Workers Logs tab in the Cloudflare dashboard)
running at the same time, filtering on `event: "capture"`. `{"kind":"message"}` exercises the
`captureMessage` path at `"warning"` level instead of throwing a synthetic exception.

## Curl recipes

Every call needs `Authorization: Bearer $ADMIN_TOKEN` (constant-time compared server-side;
401 whether the token is wrong or simply unset — the response never says which).

```sh
# Held-for-review queue, newest-changed first
curl -s "$SITE_URL/api/admin/queue?status=needs_review" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# Approve a held listing
curl -s -X POST "$SITE_URL/api/admin/listings/$LISTING_ID/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Hide a live listing, with a reason for the audit trail
curl -s -X POST "$SITE_URL/api/admin/listings/$LISTING_ID/hide" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"reported photo looked staged"}'

# Restore a hidden listing (resets report_count)
curl -s -X POST "$SITE_URL/api/admin/listings/$LISTING_ID/restore" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Reject a held listing with a giver-facing reason
curl -s -X POST "$SITE_URL/api/admin/listings/$LISTING_ID/reject" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"not_an_object"}'

# Ban an owner (hides their non-given listings) / unban
curl -s -X POST "$SITE_URL/api/admin/owners/$OWNER_ID/ban" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"repeated spam listings"}'
curl -s -X POST "$SITE_URL/api/admin/owners/$OWNER_ID/unban" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Dashboard counters / operational health
curl -s "$SITE_URL/api/admin/stats" -H "Authorization: Bearer $ADMIN_TOKEN" | jq
curl -s "$SITE_URL/api/admin/health" -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

## Verification before trusting a ban/approve action in production

Three reports from three distinct addresses should auto-hide a listing (and log a `captureMessage`
warning via Workers Logs, `src/routes/listings.ts`'s `report_autohide` handler) and surface it in
the queue under `status=hidden`; approving a held listing should move it into the public feed within
the next feed request (no cache to bust); a banned owner should get 403 on every owner-scoped
route, not just new listing creation — check `/api/me` too, not only `/api/listings`.
