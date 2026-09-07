# Keepsake design — status of record

The single place that says what state Keepsake's build is actually in. Finderly's
`docs/design/DESIGN-UX-AUDIT.md` grew to 10,400 lines and stopped being read; the fix here is
one status-of-record file plus small per-topic files, kept current in the same session code
changes, not written up after the fact.

## Agent operating rules

Adapted from Finderly's "Agent operating rules for design work" (`DESIGN-UX-AUDIT.md:42-96`),
condensed to what actually earns its keep on a solo-agent-driven repo:

1. **Update this file (or the relevant topic file) in the same session you change the thing it
   describes.** A handoff can happen at any moment; a stale status is worse than no status.
2. **Keep scope tight.** Solve the milestone in front of you and directly related fallout. Do
   not fold in unrelated redesigns because they're nearby.
3. **Mark status honestly.** `[QA]` means "implemented, needs a human/device look" — do not mark
   `[DONE]` to make a milestone look further along than it is.
4. **Use the design system first** (`packages/tokens`, `apps/web/src/ui`). Custom one-off styling
   is a last resort, and if the pattern will recur, it belongs in the design system, not
   duplicated.
5. **Document rationale, not just outcome**, when a decision had a real tradeoff (sheet vs.
   dialog, why a token flips lightness across modes, why a check skips rather than fails).
6. **Every guard is validated by breaking it once.** A test — or a preflight check — that has
   never seen a red run has not proven anything (Finderly: the composer-keyboard formula test
   grepped source text and stayed green for the entire life of the bug it should have caught).
7. **Do not delete history.** Change a status tag or move an item to "done", but keep the record
   of what was tried and why it did or didn't work — especially for anything that took more than
   one attempt.

### Status language

- `[TODO]` — not started.
- `[IN PROGRESS]` — started, not ready for QA.
- `[QA]` — implemented, needs device/browser/human verification before it's truly done.
- `[DONE]` — implemented and verified.
- `[BLOCKED]` — cannot progress without a decision or external dependency.

## Milestones

| Milestone | Status | Summary |
|---|---|---|
| M0 Scaffold | `[DONE]` | Repo + pnpm workspaces, tokens (with contrast test), contracts `/common`, observability, api `/health` + assets serving, web `_layout`/`+html`/theme/fonts/PaperGrain/placeholder feed, preflight, `ci.yml`, `deploy.yml` to preview. |
| M1 Give + moderation | `[DONE]` | Migrations 0001–0003, geodata seed loaded on preview, owner token middleware, photo upload, create listing, moderation pipeline + cron retry + budgets, web give flow (5 steps), breathing seal, reviewing states, read-only dashboard. |
| M2 Browse + share | `[DONE]` | Feed (keyset/category/FTS/geo), item page, `/i/:id/:variant` edge cache, `/item/:id` OG injection, masonry feed, location bar, share, `+not-found`. |
| M3 Requests, email, recovery | `[DONE]` | Turnstile, requests, giver email add/verify, `sendMail()` (cf + resend fallback), choose flow + contact reveal, given/withdraw/relist/edit/delete, recovery. |
| M4 Trust and operations | `[DONE]` | Reports + auto-hide, admin API + page, orphan sweep, rate-limit bindings, Sentry both sides, Web Analytics, version skew guard, Playwright in CI, runbooks. |
| M5 Polish and launch | `[IN PROGRESS]` | About/Privacy/Terms, empty states, motion + reduce-motion pass, keyboard/focus audit, robots/sitemap, cache-header audit, production secrets, `keepsake.ing` cutover. |

Definition of done per milestone lives with the plan (`M0`–`M5` DoD bullets); the short version:

- **M0**: preview `/health` returns `{ok, commit}`; home renders in Fraunces; dark mode persists
  with no flash; CI green; a deliberate bare `@keepsake/contracts` import fails lint and the
  guard test.
- **M1**: a 3-photo listing posts and is approved within 30 s on preview; a phone number in the
  story is rejected with the right reason; an S12-class story lands in `needs_review` invisible;
  the vision path runs once against real Workers AI; `MOD_IMAGE_DAILY_BUDGET=0` yields
  `pending/budget`; `02144`/`M5V`/`SW1A` resolve to the right places.
- **M2**: OG preview of `/item/<id>` renders in iMessage/WhatsApp; 25 mi radius from `02144`
  includes Cambridge, excludes Worcester; feed paginates without duplicates; search finds
  stemmed matches; hidden/pending items 404.
- **M3**: a request emails the giver within a minute from `hello@keepsake.ing`; choosing emails
  the requester with reply-to; recovery restores the dashboard and revokes the old token;
  Turnstile failure returns 403 with a retry.
- **M4**: three reports hide a listing and queue it; approve restores it; banned owner gets 403
  everywhere; e2e green in CI; a thrown error appears in Sentry with `Authorization` redacted.
- **M5**: Lighthouse a11y ≥ 95 on feed/item/give; production deploy from `main` with `/health`
  commit check; first real listing posted from a phone.

## Barrel ban

`packages/tokens`, `packages/contracts`, and `packages/observability` export **subpaths only** —
no `"."` entry in `package.json#exports` — so `import { x } from "@keepsake/contracts"` fails to
resolve at all, and `import { x } from "@keepsake/contracts/listing"` is the only thing that
works. `eslint.config.mjs`'s `no-restricted-imports` rule bans the bare specifiers explicitly, so
the failure is a readable lint error instead of a bundler mystery, and
`tools/preflight/preflight.mjs`'s `exports` check fails the build if any package ever grows a
`"."` key or a subpath target that doesn't exist on disk.

This exists because of a real incident: Finderly's production web bundle imported a shared
package's barrel export, which re-exported server-only code, and the SPA went blank on
production with no error a bundler surfaced early. The fix there was the same shape as here —
subpath-only exports plus a lint rule CI actually runs — except it shipped after the outage
instead of before it.

## Topic docs

- [Moderation](./moderation.md)
- [Identity](./identity.md)
- [Email](./email.md)
- [Feed](./feed.md)
- [Geo](./geo.md)
- [Images](./images.md)
- [Design system](./design-system.md)
- [Ops](./ops.md)

Runbooks: [deploy](../runbooks/deploy.md) · [incident](../runbooks/incident.md) ·
[admin](../runbooks/admin.md) · [geodata](../runbooks/geodata.md).

Cross-platform notes: [platform-differences.md](../platform-differences.md).

## Status notes (2026-09-06, end of day)

M0–M4 are done and verified against the live stack, not just against tests, at
<https://preview.keepsake.ing>: give → real Workers AI moderation → feed with search and
postcode radius → item page with a working link unfurl → request → choose → admin queue, plus
bans and the nightly sweep. Email sending is proven end to end (delivered, clicked, verified,
token consumed once). Turnstile is enforcing. Deploys are continuous, and the browser suite
runs on a GitHub runner (38 passing, nothing skipped).

**M5 remaining**: a keyboard and focus pass, an LCP/font-weight look, and the production
cutover (migrate + seed the production database, set its secrets, deploy, attach the apex
domain — the last step needs Kiarash).

Five things looked green today while protecting nothing: the vision prompt was copying a
pre-filled example instead of classifying, Llama Guard's self-harm category fell through
unhandled, the Metro cache shipped an empty Turnstile site key, three axe exclusions made real
contrast bugs unfailable, and the e2e job had never once executed. Each is fixed and each now
has something that fails on regression. When adding a check here, confirm it can fail.

### 2026-09-07 — six launch-audit issues closed

Landed on `claude/keepsake-github-issues-xpp03b`, off `main`, one commit per concern:

- **#19 / #21** — a request note now goes through the same contact-info regex a listing's
  title and story do (extracted from `moderation/pipeline.ts` into `moderation/contactInfo.ts`
  as a pure move), applied *before* the D1 insert rather than before the send, so an
  unmoderated note reaches neither the `requests` table nor the giver's inbox. The AI gate was
  deliberately not used: it would spend `mod_text` budget on every request, and #18 already
  establishes that budget is exhaustible by ~50 addresses. Separately, a request against a
  `given` listing now returns `410 gone` instead of the generic 404; every other non-approved
  status keeps the deliberate "not found, not forbidden" treatment.
- **#20** — listing titles reached email subject headers unescaped. Fixed at both layers:
  `TitleSchema` rejects control characters (the front door) and `sanitizeSubject()` runs at
  every `subject:` site (the backstop that matters, since a title reaches a subject from a D1
  row, not from freshly validated input). `StorySchema` untouched — the story is only ever
  interpolated into bodies that already go through `escapeHtml`, so the header vector doesn't
  exist there.
- **#16** — `GET /api/admin/health` on `main` set `ok` from `postal_codes_count` alone and
  ignored `cron_last_run`, so a month-old heartbeat sat next to `ok: true`. The endpoint fix
  was ported **byte-for-byte** from `give-flow-fixes` so it merges cleanly when #41 lands
  rather than becoming a second implementation of the same thing. An existing test that
  asserted `ok: true` with `moderationRetry` still `null` was pinned to the bug and was
  rewritten. The stats strip now carries a Crons row, ink when fresh and danger when stale.

Every one of these was proved the way this file's rule 6 asks: the guard was written, then the
production code it guards was deliberately broken, the test was watched to go red, and the
break was reverted. The specific break and its red output are recorded in each commit message
and in the closing comment on each issue.

One process note worth keeping: an early test run here reported a failure that was purely an
artifact of running the suite while an agent was still writing — the test existed before the
code did. Re-running after the work settled was clean. A red run mid-edit is not evidence of
anything.

The identity is **v3 "Polaroids on a table"** (`design-system.md`); v1 and v2 were rejected as
generic. Do not drift back toward cream-and-serif cards.
