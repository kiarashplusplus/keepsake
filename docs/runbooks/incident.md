# Runbook: incident

Status: current for M0; expand as M4 observability (Sentry, admin queue) lands.

## First, check `/health`

```sh
curl -s https://keepsake.ing/health | jq
```

`{ok, commit, env, checks}` — asserts DB/BUCKET/KV/AI/EMAIL/ASSETS bindings. `EMAIL: degraded`
is expected-and-known if Cloudflare Email Service onboarding hasn't landed yet (see
`docs/runbooks/deploy.md`); any other binding degraded or `ok: false` is a real incident.

## Common failure modes and where to look

| Symptom | Likely cause | Where |
|---|---|---|
| `/health` commit doesn't match latest `main` | deploy workflow didn't run, or the health check step itself failed and the bad deploy shipped anyway | GitHub Actions run for `deploy.yml`; re-run the deploy |
| Postcode lookups all fail/404 | `postal_codes.sql` is an unfetched LFS pointer, or the seed was never loaded for this environment | `docs/runbooks/geodata.md` — check file size first, `git lfs pull` before assuming a code bug |
| Listings stuck in `pending` | moderation budget exhausted (`MOD_TEXT_DAILY_BUDGET`/`MOD_IMAGE_DAILY_BUDGET`), or Workers AI erroring | `moderation_events` table, `reason` column; cron `moderationRetry` should clear transient errors within ~15 min (3 attempts) |
| A listing that should be held is publicly visible | moderation decide logic regression — this should never happen (fail-closed by design) | `apps/api/src/moderation/decide.ts` + its test matrix; treat as a P0, not a queue item |
| Web bundle blank/broken in production | a barrel import slipped past lint (see `docs/design/README.md#barrel-ban`), or a version-skew client is running against a moved API contract | check the deployed commit's bundle for a bare `@keepsake/*` import; check `/version.json` |
| Sentry event has an unredacted secret in it | `@keepsake/observability/redact`'s `SENSITIVE_KEY_RE` doesn't cover a new field name | extend the regex, add a test that breaks without the fix, treat any live leak as urgent regardless of severity elsewhere |

## Reports / abuse

Three independent reports auto-hide a listing (`REPORT_AUTOHIDE_THRESHOLD`) pending review in the
admin queue (`docs/runbooks/admin.md`). This is not itself an incident — it's the system working
— but a spike in auto-hides from a small number of IPs is worth a look via the `reports` table's
`ip_digest` (never a raw IP; see `docs/design/README.md` data-model notes).

## Rate-limit / budget exhaustion

Per-IP daily budgets (`LISTING_IP_DAILY_BUDGET`, `REQUEST_IP_DAILY_BUDGET`,
`UPLOAD_IP_DAILY_BUDGET`) and the `[[ratelimits]]` per-minute bindings are burst protection, not
user-facing quotas — a real person should never hit them under normal use. If support reports a
legitimate user blocked, check which ceiling and whether it's a CGNAT/shared-IP false positive
before raising any limit.

## Escalation

There is no on-call rotation — Kiarash is the only admin (`ADMIN_TOKEN`, one secret). If the
admin token is compromised, rotate it immediately with `wrangler secret put ADMIN_TOKEN --env
production` and check `moderation_events` for any `admin`-kind events since the suspected
compromise window.
