# Runbook: admin

Status: `[TODO]` — admin API and `/admin` page ship in M4.

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

## Queue

`GET /api/admin/queue` — tabs for `needs_review` (borderline moderation, held for approval),
`hidden` (auto-hidden by report threshold), `pending` (still being moderated / retried). Each
card shows the photos, story, and full `moderation_events` log for that listing — the reasoning
trail, not just the current status.

## Actions

| Action | Effect |
|---|---|
| `POST /api/admin/listings/:id/approve` | `needs_review` → `approved`; publishes if not already |
| `POST /api/admin/listings/:id/hide` | any status → `hidden`, removed from public view |
| `POST /api/admin/listings/:id/restore` | `hidden` → back to its prior visible status |
| `POST /api/admin/owners/:id/ban` | hides every listing the owner has; all their owner-route requests 403 from then on |
| `POST /api/admin/owners/:id/unban` | reverses a ban |

Every action writes a `moderation_events` row with `kind='admin'` — the admin queue's own
history is itself an audit log, not just a UI convenience.

## Verification before trusting a ban/approve action in production

Three reports from three distinct addresses should auto-hide a listing and surface it in the
queue; approving a held listing should move it into the public feed within the next feed
request (no cache to bust); a banned owner should get 403 on every owner-scoped route, not just
new listing creation — check `/api/me` too, not only `/api/listings`.
