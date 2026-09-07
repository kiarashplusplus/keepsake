# Runbook: UK geo-block

Status: `[DONE]` (2026-09-06) — `apps/api/src/middleware/ukBlock.ts` (visitors) +
`@keepsake/contracts/geo`'s `COUNTRIES` (listings/postcodes). Tests:
`apps/api/test/ukBlock.test.ts`, `packages/contracts/test/geo.test.ts`.

## Why this exists

`docs/legal-considerations.md`'s "UK Online Safety Act" section is the full research; this is the
one-paragraph version and the decision record.

The UK Online Safety Act treats Keepsake as an in-scope "regulated service" the moment it's
offered to UK users, which it was. There is **no small-service exemption** for the base duties:

- A written illegal-content risk assessment, covering all 17 priority-content categories.
- A children's access assessment — whose original deadline (16 April 2025) has already passed for
  any service already operating, so this is immediately due, not a future milestone.
- A documented complaints procedure with a response commitment, not just a report button.
- Record-keeping of the above and of any compliance measures taken.

None of these are technically hard, but they are real, ongoing paperwork and process obligations
for a product that is otherwise a spare-time project run by one person with zero revenue. Kiarash
decided on 2026-09-06 to geo-block the UK for launch rather than take them on. This is a
**deliberate legal decision**, not an oversight, a bug, or a temporary stub someone forgot to
finish — if you're reading this in six months wondering why the UK doesn't work, this is why.

## What's actually blocked

Two independent things, both required — removing only one would leave a real gap:

1. **A listing can no longer claim to be in the UK.** `GB` was removed from
   `@keepsake/contracts/geo`'s `COUNTRIES`. `CountrySchema` rejects `"GB"`, `normalizePostalCode`
   no longer has a GB branch, and `GET /api/geo/lookup?country=GB` 400s. The `postal_codes` table's
   ~stale GB rows (GeoNames outward codes, seeded before this decision) are left in place — they're
   inert without `"GB"` in `COUNTRIES`, and keeping them means re-adding GB later doesn't require
   re-running `tools/geodata/build-postal-seed.mjs` from scratch.
2. **A UK visitor can't use the product at all**, regardless of what they'd try to do. This is the
   part a `COUNTRIES` change alone doesn't cover — a UK visitor could otherwise still browse,
   request, and be given things located in the US or Canada, and none of that is about a listing's
   country. `apps/api/src/middleware/ukBlock.ts` is mounted first, before every route (`app.use("*",
   ukBlock())` in `src/index.ts`), and checks Cloudflare's own `request.cf.country` — populated by
   the edge from the connection's IP geolocation before the Worker ever runs, and not a header, so
   nothing a client sends can set or override it. A blocked visitor gets a plain HTML explanation
   page (not a bare 403) at status `451` (Unavailable For Legal Reasons — the code that exists
   specifically to say "this is a legal/regulatory choice, not a bug"). `/health` and
   `/version.json` are exempted so an uptime monitor or the post-deploy commit check never trips on
   wherever the checking machine happens to be.

Blocked countries: `GB`, plus the three Crown Dependencies (`JE` Jersey, `GG` Guernsey, `IM` Isle
of Man) — they share the UK's postal system and are the most likely to be swept up by a
UK-market-facing block like this, even though the Online Safety Act itself names Great Britain and
Northern Ireland, not the Dependencies directly.

## One place, one name

`UK_BLOCKED_COUNTRIES` in `apps/api/src/middleware/ukBlock.ts` is the single list. Lifting the
block later is meant to be a small, reviewable change, not an archaeology project:

1. Remove the code(s) from `UK_BLOCKED_COUNTRIES`.
2. Add `"GB"` back to `@keepsake/contracts/geo`'s `COUNTRIES` (and `COUNTRY_LABELS`,
   `COUNTRY_POSTCODE_HINTS`), and restore the GB branch in `normalizePostalCode` (see git history
   for the exact code removed on 2026-09-06, or `tools/geodata/build-postal-seed.mjs`, which still
   knows the GB normalization rule).
3. Re-run `tools/geodata/build-postal-seed.mjs --countries GB` if the existing seeded rows are
   considered stale (they were seeded before this decision and have not been refreshed since).
4. Update `apps/site/public/{privacy,terms}.html` and `docs/design/geo.md` if they've picked up any
   US/CA-only language in the meantime.

## What would have to be true to lift it

Not "traffic is worth it" or "a UK user complained" — those don't change the legal analysis. What
actually changes the calculus, per `docs/legal-considerations.md`:

- **A real lawyer confirms scope or exemption.** The research here is AI-assembled from public
  guidance, not legal advice — a lawyer might find a narrower reading of "regulated service," a
  transitional provision, or that the risk assessment is genuinely a few hours of honest paperwork
  for a service this size (small, human-reviewed, report button already live). If so, doing that
  paperwork and re-enabling is cheap.
- **The risk assessment, children's access assessment, and complaints procedure actually get
  written**, in good faith, and kept on file — not performative documents, but the real "suitable
  and sufficient" assessments Ofcom's guidance describes. This is inexpensive for a service this
  size (a few honest pages), which is exactly why the audit called the absence of a paper trail the
  real exposure, not the underlying risk level.
- **Kiarash decides the ongoing maintenance is worth it.** Once written, these aren't one-time:
  record-keeping and the complaints process are ongoing obligations, small but real, for as long as
  the UK is served.

None of "Keepsake gets more users," "someone in the UK asks nicely," or "it's only a few lines of
code to revert" are on this list on their own — they don't change whether the underlying
obligations have been met.

## Verification

- `apps/api/test/ukBlock.test.ts`: a `GB` request gets the HTML explanation at `451`; a `US`
  request (and a request with no `cf.country` at all, e.g. same-isolate test traffic) is
  unaffected; `JE`/`GG`/`IM` are blocked too; a write endpoint (`POST /api/listings`) is blocked,
  not just reads; a client-controlled header claiming a different country (`CF-IPCountry: US`)
  cannot bypass it, because the check never reads headers; `/health` stays reachable regardless of
  the checking machine's location.
- `packages/contracts/test/geo.test.ts`: `COUNTRIES` no longer contains `GB`; `CountrySchema`
  rejects it.
- Manually, once deployed: visit the preview URL through a UK VPN endpoint (or any tool that lets
  you set an origin IP) and confirm the explanation page renders, then confirm a US/Canada IP is
  unaffected.
