# Runbook: verify production

Status: written 2026-09-07, the day `keepsake.ing` went live (#46). Every command below is
copy-pasteable and every PASS is stated as something you can see in the output, not as a feeling
about it.

**Run this after any production deploy**, and in particular right after a cutover or a manual
`wrangler deploy --env production`. It is the live half of [#47](https://github.com/kiarashplusplus/keepsake/issues/47)
("Re-check `/health` on the apex and post the first real listing") — that issue stays open until a
human has actually run it, because nothing in an agent session can.

> **Why this exists as a document rather than a script an agent runs.** *Some* agent containers
> reach the internet through an egress proxy that answers `403` to `CONNECT keepsake.ing:443`, and
> a session in one of those cannot curl the live site at all. That is a policy denial, not a broken
> tool: don't retry it and don't route around it — say plainly that you could not observe the thing.
>
> **But check before assuming it.** This paragraph used to say *no* session working in this repo
> could reach production, and a session on 2026-09-09 curled `/health`, walked every
> `/api/admin/*` route and fired `POST /api/admin/test-error` against the apex without trouble —
> having nearly skipped all of it on the strength of this sentence. Egress policy varies by
> environment; one `curl -s https://keepsake.ing/health` settles it in a second. A verification
> that cannot be performed must not be reported as performed (`AGENTS.md`, "A passing test is not
> evidence") — and one that *can* be performed should not be waved off as impossible either.
>
> §5 still needs a human regardless: it is a browser with a clean profile, not a shell.

Prerequisites: `curl` and `jq`, plus a checkout of this repo for the commit check in §4, and a
browser with a clean profile for §5 — that one cannot be done from a shell.

---

## 1. `/health` on the apex

```sh
curl -s https://keepsake.ing/health | jq
```

**PASS** looks like this — `ok: true`, and a `commit` that is a real 40-character SHA:

```json
{
  "ok": true,
  "degraded": false,
  "commit": "6412c7f3…40 hex chars…",
  "env": "production",
  "version": { "commit": "6412c7f3…", "environment": "production" },
  "checks": { "DB": "ok", "BUCKET": "ok", "KV": "ok", "AI": "ok", "ASSETS": "ok",
              "EMAIL": "ok", "d1": "ok", "r2": "ok", "kv": "ok", "secrets": "ok" }
}
```

Check all four of these, not just the first:

- **`ok` is `true`.** It is `false` (with HTTP 503) if D1, R2 or KV fails a real read — `d1`/`r2`/`kv`
  are genuine round trips, not presence checks (#15). A single named `"error"` in `checks` tells you
  which one.
- **`commit` is a 40-character hex SHA, never `"dev"`.** See §1a.
- **`env` is `"production"`.** Anything else means you are looking at the wrong Worker.
- **`degraded` is `false`.** `true` means `TURNSTILE_SECRET` or `ADMIN_TOKEN` is unset on the
  production Worker — the site serves, but the bot check and the admin page do not.

One-liner for a scripted check:

```sh
curl -s https://keepsake.ing/health |
  jq -e '.ok == true and .env == "production" and (.commit | test("^[0-9a-f]{40}$"))' >/dev/null &&
  echo PASS || echo FAIL
```

### 1a. If `commit` is `"dev"` — a hand-run deploy that forgot the flag (#24)

You will not actually see `"dev"` in a `/health` body on production, because the Worker refuses
first. `apps/api/src/index.ts`'s very first middleware answers **every** production request with
`503` and this body the instant it sees `ENVIRONMENT === "production"` and `COMMIT_SHA === "dev"`:

```json
{ "ok": false,
  "error": { "code": "unavailable",
             "message": "Production refuses to serve traffic: COMMIT_SHA is still \"dev\". …" } }
```

That is the whole site down, deliberately, rather than real traffic served under a false commit.
The cause is always the same: someone ran `wrangler deploy --env production` without
`--var COMMIT_SHA:$(git rev-parse HEAD)`. **Fix by redeploying with the flag** — see
[deploy.md](deploy.md#manual-deploys-and-commit_sha-issue-24). Do not work around the guard.

`.github/workflows/uptime.yml` also treats `commit: "dev"` on either tier as its own distinct
failure every 15-20 minutes, so this gets caught even if nobody is looking. Two layers on purpose.

---

## 2. `robots.txt` on the apex

```sh
curl -s https://keepsake.ing/robots.txt
```

**PASS**: the production file, which must contain both of these lines —

```
User-agent: *
Allow: /

Sitemap: https://keepsake.ing/sitemap.xml
```

```sh
curl -s https://keepsake.ing/robots.txt | grep -qx 'Allow: /' &&
  curl -s https://keepsake.ing/robots.txt | grep -q '^Sitemap: https://keepsake.ing/sitemap.xml' &&
  echo PASS || echo FAIL
```

- `Allow: /` is the whole point: production is the copy that *should* be indexed. `Disallow: /`
  here means the Worker thinks it is not production — check `env` in §1 before anything else.
- The `Sitemap:` line must name the apex, not a preview host. `/sitemap.xml` is built from
  `SITE_URL` (`apps/api/src/routes/sitemap.ts`), so a preview host here means the wrong
  `[env.*.vars]` block deployed.
- There is deliberately **no** `Disallow: /admin` (#84): the token gate is the real protection, and
  a public file naming the one endpoint worth attacking is free reconnaissance. `/admin` is kept
  out of search results by an unconditional `X-Robots-Tag: noindex` on that path instead —
  confirm with `curl -sI https://keepsake.ing/admin | grep -i x-robots-tag`.

Worth confirming the sitemap itself answers, while you are here:

```sh
curl -s https://keepsake.ing/sitemap.xml | head -5     # PASS: <urlset …> with https://keepsake.ing/ URLs
```

---

## 3. Preview must be the mirror image

Launch audit finding 2: preview is a fully functional, brand-named clone whose notification email
is silently dropped (`EMAIL_MODE=allowlist`). A stranger who finds it in search posts a real
keepsake into a database nobody is watching. So the two assertions below are as important as §2,
and they are the ones most likely to break silently — they depend on `ENVIRONMENT`, on
`run_worker_first` routing the request to the Worker at all, and on both surviving a redeploy.

```sh
curl -s https://preview.keepsake.ing/robots.txt
```

**PASS**: exactly a blanket disallow, generated by the Worker (not the static file) —

```
User-agent: *
Disallow: /
```

```sh
curl -si https://preview.keepsake.ing/sitemap.xml | head -1
```

**PASS**: `HTTP/2 404`. Not an empty `<urlset/>` — an empty sitemap is still a live sitemap that a
crawler keeps re-fetching and Search Console will accept.

And the header half, which is what removes a page a crawler already fetched (robots.txt only asks
it not to fetch one):

```sh
curl -sI https://preview.keepsake.ing/ | grep -i x-robots-tag
# PASS: x-robots-tag: noindex, nofollow
```

Check that on `/` specifically, not only on `/item/...`. `/` is the page a searcher lands on, it
matches a real static asset, and it reached the Worker at all only because `run_worker_first` is
`true` for preview — the exact gap the first pass at #84 missed.

Both in one:

```sh
curl -s https://preview.keepsake.ing/robots.txt | grep -qx 'Disallow: /' &&
  [ "$(curl -s -o /dev/null -w '%{http_code}' https://preview.keepsake.ing/sitemap.xml)" = 404 ] &&
  curl -sI https://preview.keepsake.ing/ | grep -qi 'x-robots-tag: noindex' &&
  echo PASS || echo FAIL
```

---

## 4. The deployed commit is the commit that was dispatched

`/health` reporting *a* real SHA (§1) only proves the deploy stamped itself. It does not prove it
stamped itself with **your** commit. Production deploys are `workflow_dispatch`-only, so the commit
that should be live is the SHA of the ref you chose in the Actions tab.

```sh
# The commit you dispatched (from a checkout at that ref):
git rev-parse HEAD

# Fails loud (exit 1) if the live site is not serving it:
node tools/ci/verify-preview-commit.mjs https://keepsake.ing "$(git rev-parse HEAD)"
```

Despite the name, that script is not preview-specific — it fetches `<url>/health` and compares
`.commit`, and accepts a full 40-char SHA or any prefix (`git rev-parse --short HEAD` works). Exit
`0` = verified, `1` = mismatch, `2` = usage or network error.

Use the wrapping form around anything that takes more than an instant, because it checks **before
and after** and fails if the site moved underneath you mid-check:

```sh
node tools/ci/verify-preview-commit.mjs https://keepsake.ing "$(git rev-parse HEAD)" -- \
  curl -s https://keepsake.ing/api/feed
```

That drift is a real, observed hazard on preview (#66 — every push to `main` redeploys it). It is
much less likely on production, which only a human dispatch can move; the wrapping form costs
nothing and removes the question entirely.

If the SHAs differ: the deploy either failed after the migration step or never ran. Check the
workflow run, and read [deploy.md](deploy.md#what-a-deploy-actually-does) — migrations apply
*before* the Worker deploys, so a failed deploy leaves a migrated database under the old code.

---

## 5. Analytics loads only after consent, and only then

Needs a real browser: `curl` cannot see this, and neither can the test suite. A first-time visitor
sees the explainer at `/` (in place since 2026-09-09 — the URL should NOT change to `/welcome`; if
it does, production is running the old redirect and `docs/runbooks/seo-audit.md`'s fourth pass has
not shipped).

1. **Load the apex with a clean profile and do not answer the banner.** There must be **zero**
   requests to `static.cloudflareinsights.com`. Any request here means Cloudflare's edge
   auto-installation is enabled again, which loads analytics regardless of consent and makes the
   banner's refusal inoperative — that is #231, and it was live on production once.
2. **Click "Reject all", reload.** Still zero.
3. **Click "Accept all".** Now expect `200` on `beacon.min.js` and `204 POST` on
   `cloudflareinsights.com/cdn-cgi/rum`, with no Content Security Policy error in the console. A
   CSP error here means `connect-src` lost the reporting origin (#233) — note it is
   `cloudflareinsights.com`, *not* the `static.` host that `script-src` names.
4. **Confirm the events actually landed**, which a `204` does not prove on its own. See
   deploy.md's "Web Analytics and the consent-gated tags" for the GraphQL query; a rising count for
   `siteTag d90ef13c…` is the end-to-end proof.

Step 4 matters because every failure in this area is silent. A missing token, the wrong dashboard
mode, and a blocked `connect-src` all present as "the banner works and nothing is recorded", and
the dashboard mode in particular **cannot be read back from the API** — "Enable with JS Snippet
installation" and "Disable" look identical there.

---

## 6. The first real listing (the rest of #47)

The checks above prove the hostname, the Worker, D1, R2 and KV. They do not prove the product
works end to end on the real domain — moderation, photo storage, and the email that tells a giver
someone asked. That needs a person to post a keepsake through `https://keepsake.ing/give` and
watch it become visible.

- The listing goes `pending` → `approved` through the moderation pipeline. If it stays `pending`
  past a few minutes, the 5-minute `moderationRetry` cron is the thing that should be rescuing it —
  check `GET /api/admin/health`'s `cron_last_run` (rendered on the admin page) before assuming the
  pipeline itself is broken.
- Production email is `live` for all recipients (#43), and delivery to any address other than
  Kiarash's has **never been observed arriving** (#6, still open). A listing that posts fine while
  no email arrives is exactly the failure #6 describes; report it there rather than filing it as
  new.

Record what you saw in #47, then close it. Do not close it on the strength of §1-§5 alone.

---

## What to do when one of these fails

| Symptom | Almost certainly |
|---|---|
| Every path returns `503 unavailable`, message names `COMMIT_SHA` | Hand-run deploy without `--var COMMIT_SHA:…` (#24). Redeploy with the flag. |
| `/health` `ok: false`, one named check `"error"` | That binding is real but unreachable — wrong id in `[env.production.*]`, or a Cloudflare incident. |
| `env` is not `"production"` | The apex is pointed at the wrong Worker, or `--env production` was omitted. |
| Apex `robots.txt` says `Disallow: /` | Same as above: the Worker believes it is not production. |
| Preview serves `Allow: /` or a live sitemap | `run_worker_first` or `ENVIRONMENT` regressed on `[env.preview]` — launch audit finding 2 / #84. |
| `/health` commit ≠ dispatched commit | Deploy failed after migrations, or never ran. See deploy.md. |
| Beacon loads before the banner is answered | Cloudflare edge auto-installation is on. Dashboard → Web Analytics → Manage site → "Enable with JS Snippet installation" (#231). |
| `Content Security Policy` error naming `cdn-cgi/rum` | `connect-src` lost `https://cloudflareinsights.com` in one of the two CSP copies (#233). |
| Banner works, `204`s go out, dashboard stays empty | The site is in **Disable** mode. It is indistinguishable from JS-snippet mode via the API — check the dashboard, not `rum/site_info`. |
| No beacon at all, no CSP error, no meta tag in the HTML | `EXPO_PUBLIC_CF_WEB_ANALYTICS_TOKEN` never reached this tier: it is inlined at build time, so the tier must be **deployed** after the variable is set (#228, #232). |

Anything that changes the deployed configuration should be fixed by redeploying, not by editing
Cloudflare state by hand — the dashboard and `wrangler.toml` disagreeing is how the next person
gets a surprise.
